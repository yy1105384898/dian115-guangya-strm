import { getRules, sourcePaths, cd2HostPath } from './rules.js'
import { mountedRule } from './clouds.js'
import { loadSettings } from './auth.js'
import { cleanList, waitDeletion, accountFingerprint } from './cloud-cleanup.js'
import { request } from './guangya.js'
import { requireIdle } from './activity.js'

const STATE = 'duplicate_source_v1'
const within = (path, root) => path === root || path.startsWith(root.replace(/\/+$/, '') + '/')
const stamp = value => {
  const text = String(value || '').replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : text + '+08:00') || 0
}
// Only the exact organize skip reason supplied by the user authorizes deletion.
function duplicate(record) {
  return ['skipped', 'skip'].includes(record.status) &&
    [record.detail_msg, record.error_msg].some(value => /^目标文件已存在[（(]跳过[-－]已完成[）)]$/.test(String(value || '').trim()))
}
function safePath(path) {
  return typeof path === 'string' && path.startsWith('/') && !/[\\\r\n\0]/.test(path) &&
    !path.slice(1).split('/').some(part => part === '.' || part === '..' || !part)
}
async function records(ctx) {
  const result = []
  for (let page = 1; page <= 50; page++) {
    const data = await ctx.api.get(`/api/organize/history?page=${page}&page_size=100`)
    if (!Array.isArray(data?.list)) throw new Error('整理记录结构无效，停止重复文件处理')
    result.push(...data.list)
    if (data.list.length < 100 || Number.isFinite(Number(data.total)) && result.length >= Number(data.total)) return result
  }
  throw new Error('整理历史超过检查上限，停止重复文件处理')
}
async function matchRule(ctx, record) {
  if (!safePath(record.source_path) || !safePath(record.target_path) || record.source_path === record.target_path) return null
  const roots = []
  for (const rule of getRules(await ctx.settings.get())) {
    const resolved = await mountedRule(ctx, rule)
    roots.push({ rule, resolved, root: cd2HostPath(sourcePaths(resolved).cd2) })
  }
  if (roots.some(item => within(record.source_path, item.root))) return null
  for (const { rule, resolved, root } of roots.filter(item => item.rule.enabled && item.rule.organize_enabled !== false)) {
    const cloud = cd2HostPath(resolved.cloud_name)
    if (!within(record.target_path, root) || !within(record.source_path, cloud) || within(record.source_path, root)) continue
    if ((rule.excluded_paths || []).some(part => within(record.target_path, root + '/' + part))) continue
    return { rule, cloud, source: record.source_path.slice(cloud.length), target: record.target_path.slice(cloud.length) }
  }
  return null
}
async function resolveFile(ctx, settings, path) {
  let parent = '', current = '/'
  const parts = path.split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const matches = (await cleanList(ctx, settings, parent, current)).filter(item => item.name === parts[i])
    if (!matches.length) return null
    if (matches.length !== 1) throw new Error('无法唯一定位文件：' + path)
    const item = matches[0]
    if (i === parts.length - 1) {
      if (item.dir) throw new Error('来源或目标不是文件，停止删除')
      return item
    }
    if (!item.dir) throw new Error('父路径不是目录')
    parent = item.id; current = item.path
  }
  throw new Error('不能删除云盘根目录')
}
const same = (a, b) => !!a && !!b && ['id', 'parent', 'path', 'size', 'modified', 'hash'].every(key => a[key] === b[key])

export async function dispatchDuplicates(ctx) {
  const now = Date.now(), saved = await ctx.storage.get(STATE)
  // Never sweep old skipped history on installation/upgrade.
  if (!saved) { await ctx.storage.set(STATE, { since: now, checked: 0, receipts: {} }); return }
  if (now - saved.checked < 60000) return
  const list = await records(ctx)
  const ids = list.filter(record => duplicate(record) && stamp(record.completed_at || record.created_at) >= saved.since &&
    !saved.receipts[String(record.id)]).map(record => String(record.id))
  saved.checked = now
  await ctx.storage.set(STATE, saved)
  if (!ids.length) return
  // Source mount and target scope are checked again in the executing job.
  const eligible = []
  for (const id of ids) {
    if (await matchRule(ctx, list.find(record => String(record.id) === id))) eligible.push(id)
    if (eligible.length >= 20) break
  }
  if (eligible.length) await ctx.api.post(`/api/extensions/v3/${ctx.plugin.id}/jobs/duplicate-source`, {
    business_key: 'duplicate-source:' + ctx.crypto.sha256(JSON.stringify(eligible)).slice(0, 24), input: { ids: eligible }
  })
  return eligible.length > 0
}

export async function run(ctx, input = {}) {
  await requireIdle(ctx, 'sync'); await requireIdle(ctx, 'cloud-cleanup')
  if (!Array.isArray(input.ids) || input.ids.length > 20) throw new Error('重复来源记录参数无效')
  const state = await ctx.storage.get(STATE)
  if (!state) throw new Error('未初始化重复来源检测')
  const settings = await loadSettings(ctx), fingerprint = await accountFingerprint(ctx)
  let removed = 0
  for (const id of input.ids) {
    if (state.receipts[String(id)]) continue
    const record = (await records(ctx)).find(item => String(item.id) === String(id))
    if (!record || !duplicate(record) || stamp(record.completed_at || record.created_at) < state.since) continue
    const scope = await matchRule(ctx, record)
    if (!scope) continue
    const source = await resolveFile(ctx, settings, scope.source), target = await resolveFile(ctx, settings, scope.target)
    if (!source) { state.receipts[String(id)] = { status: 'source_absent', at: Date.now() }; await ctx.storage.set(STATE, state); continue }
    if (!target || target.id === source.id || target.size <= 0 || source.size <= 0) throw new Error('目标不存在、为空或源目标相同，保留来源文件：' + record.source_path)
    await ctx.task.log('重复来源核对：' + record.source_path + '；宿主原因：目标文件已存在（跳过-已完成）；目标保留：' + record.target_path)
    const latest = (await records(ctx)).find(item => String(item.id) === String(id))
    if (!latest || !duplicate(latest) || latest.source_path !== record.source_path || latest.target_path !== record.target_path || !await matchRule(ctx, latest)) throw new Error('整理记录或规则已变化，停止删除')
    if (await accountFingerprint(ctx) !== fingerprint || !same(source, await resolveFile(ctx, settings, scope.source)) || !same(target, await resolveFile(ctx, settings, scope.target))) throw new Error('账号或文件状态已变化，停止删除')
    // Persist before the request. Unknown outcomes must never be replayed.
    state.receipts[String(id)] = { status: 'submitting', source_id: source.id, at: Date.now() }
    await ctx.storage.set(STATE, state)
    await ctx.task.checkpoint({ stage: 'before_delete', history_id: id, source_id: source.id })
    const token = (await ctx.storage.get('tokens'))?.access_token || settings.access_token
    const result = await request(ctx, settings, token, 'https://api.guangyapan.com/nd.bizuserres.s/v1/file/delete_file', { fileIds: [source.id] })
    if (String(result?.msg || '').toLowerCase() !== 'success') throw new Error('删除响应未确认成功，请核查光鸭来源文件；不自动重复提交')
    await waitDeletion(ctx, settings, result)
    if (await resolveFile(ctx, settings, scope.source)) throw new Error('删除后来源仍存在，请核查；不自动重复提交')
    state.receipts[String(id)] = { status: 'removed', source_id: source.id, at: Date.now() }
    await ctx.storage.set(STATE, state); removed++
    await ctx.task.log('已删除重复来源：' + record.source_path + '；目标文件保留')
  }
  const result = { removed }
  await ctx.task.update({ stage: 'completed', progress: 100, message: '重复来源处理完成：删除 ' + removed + ' 个光鸭来源文件，目标保留' })
  await ctx.task.checkpoint({ stage: 'completed', result })
  return result
}
export async function recover(ctx, checkpoint) {
  return checkpoint?.stage === 'completed' ? { action: 'complete', result: checkpoint.result } : { action: 'attention' }
}
