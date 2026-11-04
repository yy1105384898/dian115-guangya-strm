import { loadSettings } from './auth.js'
import { request, findArray, itemId, itemName, unwrap } from './guangya.js'
import { validateCleanRule, cleanRules, below, fileMatches } from './clean-rules.js'
import { requireIdle } from './activity.js'
import { withCleanupRecord, updateCleanupRecord } from './cleanup-records.js'

const LIST = 'https://api.guangyapan.com/userres/v1/file/get_file_list'
const DELETE = 'https://api.guangyapan.com/nd.bizuserres.s/v1/file/delete_file'
const TASK_STATUS = 'https://api.guangyapan.com/nd.bizuserres.s/v1/get_task_status'
const TTL = 10 * 60000
// Host JSON transport/storage can reorder object keys. Compare content in a
// stable order so an unchanged confirmation/plan survives that round trip.
// Preserve array order: rule execution order must remain part of the snapshot.
const digest = (ctx, value) => ctx.crypto.sha256(JSON.stringify(value ?? null, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item))
const identity = item => item?.dir ? { id: item.id, parent: item.parent, name: item.name, path: item.path, dir: true } : item

// Report only container names/types. Never include response values, tokens,
// URLs or file records in directory diagnostics.
function responseShape(value) {
  const fields = []
  function visit(item, path, depth) {
    if (fields.length >= 32) return
    const type = item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item
    fields.push(path + ':' + type)
    if (type !== 'object' || depth >= 3) return
    for (const key of Object.keys(item).slice(0, 16)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/.test(key)) continue
      if (/token|secret|authorization|cookie|password|url/i.test(key)) continue
      visit(item[key], path + '.' + key, depth + 1)
    }
  }
  visit(value, '$', 0)
  return fields.join(', ')
}

function normalize(item, parent, path) {
  for (const key of ['fileId', 'file_id', 'resId', 'res_id', 'resourceId', 'id']) {
    if (typeof item[key] === 'number' && !Number.isSafeInteger(item[key])) throw new Error('光鸭文件 ID 精度不可靠，已停止')
  }
  const id = itemId(item), name = itemName(item)
  if (!id || !name || /[\/\\\r\n\0]/.test(name) || ['.', '..'].includes(name)) throw new Error('光鸭文件标识或名称异常，已停止')
  const type = String(item.resType ?? item.res_type ?? '')
  const kind = String(item.type ?? item.fileType ?? '').toLowerCase()
  let dir
  if (type === '2' || item.isDir === true || item.isDir === 1 || item.isFolder === true || item.isdir === true || item.dir === true || item.folder === true || String(item.dirType ?? item.dir_type ?? '') === '1' || ['dir', 'directory', 'folder'].includes(kind) || item.dirName) dir = true
  else if (type === '1' || item.isDir === false || item.isDir === 0 || item.isFolder === false || ['file', 'video', 'audio'].includes(kind)) dir = false
  else throw new Error('光鸭条目缺少明确文件/目录类型，停止清理：' + name)
  const size = Number(item.size ?? item.fileSize ?? item.file_size ?? item.resSize)
  if (!dir && (!Number.isFinite(size) || size < 0)) throw new Error('文件大小读取不完整，停止清理：' + name)
  return { id, name, parent, path: (path === '/' ? '' : path) + '/' + name, dir, size: dir ? 0 : size,
    modified: String(item.modified ?? item.updateTime ?? item.modifyTime ?? item.mtime ?? ''),
    hash: String(item.gcid ?? item.GCID ?? item.md5 ?? item.contentHash ?? '') }
}
export async function accountFingerprint(ctx) {
  const auth = await ctx.storage.get('auth')
  if (!auth?.access_token) throw new Error('请先登录光鸭账号')
  return digest(ctx, [auth.access_token, auth.device_id || '', auth.phone || ''])
}
export async function cleanList(ctx, settings, parent, path) {
  const result = [], seen = new Set(), signatures = new Set()
  const token = (await ctx.storage.get('tokens'))?.access_token || settings.access_token
  for (let page = 0; page < 10000; page++) {
    const response = await request(ctx, settings, token, LIST, { parentId: parent || '', page, pageSize: 100, orderBy: 0, sortType: 0 })
    if (!response || response.error || response.success === false) throw new Error('光鸭目录读取失败')
    let batch
    try { batch = findArray(response) }
    catch (error) {
      const data = unwrap(response)
      const total = data?.total
      const count = /^(0|[1-9]\d{0,12})$/.test(String(total)) ? String(total) : '未知'
      throw new Error('清理目录读取失败：' + path + '，请求页=' + page + '，total=' + count + '；响应结构：' + responseShape(response) + '；' + error.message)
    }
    if (!batch.length) return result
    const signature = digest(ctx, batch.map(itemId))
    if (signatures.has(signature)) throw new Error('分页返回重复内容，已停止清理')
    signatures.add(signature)
    for (const raw of batch) {
      const item = normalize(raw, parent, path)
      if (seen.has(item.id)) throw new Error('目录列表存在重复文件 ID，已停止')
      seen.add(item.id); result.push(item)
    }
    if (result.length > 50000) throw new Error('单目录超过 50000 项，请缩小清理范围')
    const total = Number(response?.data?.total)
    if (Number.isFinite(total) && total > 0 && result.length >= total) return result
    if (!(total > 0) && batch.length < 100) return result
  }
  throw new Error('目录分页超过上限')
}
export async function waitDeletion(ctx, settings, response) {
  const taskId = response?.data?.taskId
  if (taskId === undefined || taskId === '') return
  if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('删除任务标识异常，请到光鸭核查；不会重复提交删除')
  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt) await ctx.sleep(500)
    const token = (await ctx.storage.get('tokens'))?.access_token || settings.access_token
    const state = await request(ctx, settings, token, TASK_STATUS, { taskId })
    const status = state?.data?.status
    if (status === 2) return
    if (status === -1 || status === 3) throw new Error('光鸭云端删除任务失败，已停止；不会重复提交删除')
    if (status !== 0 && status !== 1) throw new Error('删除任务状态缺失或未知，请到光鸭核查；不会重复提交删除')
  }
  throw new Error('等待光鸭删除任务超时，请到光鸭核查；不会重复提交删除')
}
async function verifyRoot(ctx, settings, rule) {
  let parent = '', path = '/'
  for (const part of rule.source_path.split('/').filter(Boolean)) {
    const matches = (await cleanList(ctx, settings, parent, path)).filter(item => item.dir && item.name === part)
    if (matches.length !== 1) throw new Error('无法唯一确认清理目录：' + rule.source_path + '，请重新选择')
    parent = matches[0].id; path = matches[0].path
  }
  if (parent !== rule.source_id) throw new Error('清理目录 ID 已变化或账号不一致，请重新选择目录')
}
export async function scanCleanup(ctx, settings, rule) {
  await verifyRoot(ctx, settings, rule)
  const root = { id: rule.source_id, path: rule.source_path, dir: true }, nodes = [], seen = new Set([root.id]), stack = [root]
  let scannedFiles = 0, scannedDirs = 0
  while (stack.length) {
    const current = stack.pop()
    const entries = await cleanList(ctx, settings, current.id, current.path)
    for (const item of entries) {
      if (seen.has(item.id)) throw new Error('目录树存在重复 ID 或循环，已停止')
      seen.add(item.id)
      item.excluded = rule.exclusions.some(path => below(item.path, path))
      nodes.push(item)
      if (item.dir) scannedDirs++; else scannedFiles++
      if (item.dir && !item.excluded) stack.push(item)
    }
    if (nodes.length > 50000) throw new Error('扫描超过 50000 项，请拆分清理规则')
    await ctx.task.update({ stage: 'scan', message: `${rule.name}：扫描 ${nodes.length} 项 · ${current.path}` })
    await updateCleanupRecord(ctx, rule.id, { stage: 'scan', scanned_files: scannedFiles, scanned_dirs: scannedDirs, message: current.path })
  }
  await updateCleanupRecord(ctx, rule.id, { scanned_files: scannedFiles, scanned_dirs: scannedDirs }, true)
  return nodes
}
export function selectCandidates(nodes, rule) {
  const files = nodes.filter(item => !item.dir && !item.excluded)
  let selected
  if (rule.mode === 'directories') {
    const keepers = files.filter(file => fileMatches(file, rule))
    const eligible = nodes.filter(dir => dir.dir && !dir.excluded &&
      !nodes.some(item => item.excluded && below(item.path, dir.path)) &&
      !keepers.some(file => below(file.path, dir.path)))
    selected = files.filter(file => eligible.some(dir => below(file.path, dir.path)))
  } else selected = files.filter(file => rule.mode === 'keep' ? !fileMatches(file, rule) : fileMatches(file, rule))
  const selectedIds = new Set(selected.map(file => file.id))
  if (rule.empty_dirs || rule.mode === 'directories') {
    const dirs = nodes.filter(dir => dir.dir && !dir.excluded).sort((a, b) => b.path.split('/').length - a.path.split('/').length)
    for (const dir of dirs) {
      if (nodes.every(child => !below(child.path, dir.path) || child.id === dir.id || selectedIds.has(child.id))) {
        selected.push(dir); selectedIds.add(dir.id)
      }
    }
  }
  return selected
}
async function currentRule(ctx, id, transient) {
  const settings = await ctx.settings.get()
  if (transient && transient.id === id) return { settings, rule: validateCleanRule(transient) }
  const rule = cleanRules(settings).find(rule => rule.id === id)
  if (!rule) throw new Error('清理规则已删除，任务已停止')
  return { settings, rule: validateCleanRule(rule) }
}
async function makePlan(ctx, id, transient) {
  const { rule } = await currentRule(ctx, id, transient), settings = await loadSettings(ctx)
  const fingerprint = await accountFingerprint(ctx)
  const nodes = await scanCleanup(ctx, settings, rule), candidates = selectCandidates(nodes, rule)
  const plan = { id: ctx.crypto.randomUUID().replace(/-/g, ''), rule_id: id, rule_name: rule.name,
    config: digest(ctx, rule), fingerprint, created_at: Date.now(), root: rule.source_path, scanned: nodes.length, candidates, used: false }
  await ctx.storage.set('cloud_cleanup_plan:' + id, plan)
  await updateCleanupRecord(ctx, id, { scanned_files: nodes.filter(item => !item.dir).length, scanned_dirs: nodes.filter(item => item.dir).length,
    planned_files: candidates.filter(item => !item.dir).length, planned_dirs: candidates.filter(item => item.dir).length }, true)
  return plan
}
async function execute(ctx, plan, scheduled, transient) {
  const { rule } = await currentRule(ctx, plan.rule_id, transient)
  if (plan.used || Date.now() - plan.created_at > TTL) throw new Error('清理预览已过期或已执行，请重新预览')
  if (digest(ctx, rule) !== plan.config || await accountFingerprint(ctx) !== plan.fingerprint) throw new Error('规则或账号已变化，请重新预览')
  if (scheduled && (!rule.enabled || !rule.scheduled)) throw new Error('规则定时执行已关闭')
  const settings = await loadSettings(ctx)
  const live = selectCandidates(await scanCleanup(ctx, settings, rule), rule), index = new Map(live.map(item => [item.id, item]))
  // A changed tree invalidates the whole plan before any deletion starts.
  for (const candidate of plan.candidates) {
    if (digest(ctx, identity(candidate)) !== digest(ctx, identity(index.get(candidate.id)))) throw new Error('预览后的目录内容已变化，请重新预览')
  }
  plan.used = true; await ctx.storage.set('cloud_cleanup_plan:' + plan.rule_id, plan)
  let removed = 0
  let removedFiles = 0, removedDirs = 0
  await updateCleanupRecord(ctx, rule.id, { stage: 'delete', message: '开始清理' }, true)
  await ctx.task.update({ stage: 'delete', total: plan.candidates.length, done: 0, failed: 0, message: rule.name + '：开始清理' })
  for (const candidate of plan.candidates) {
    const latest = await currentRule(ctx, rule.id, transient)
    if (digest(ctx, latest.rule) !== plan.config || await accountFingerprint(ctx) !== plan.fingerprint) throw new Error('规则、排除目录或登录账号已变化，已停止后续删除')
    if (scheduled && latest.settings.cleanup_schedule_enabled !== true) throw new Error('统一定时已关闭，停止后续删除')
    // Resolve every ancestor again: a move of a folder must never expand scope.
    const parentPath = candidate.path.slice(0, candidate.path.lastIndexOf('/')) || '/'
    await verifyRoot(ctx, settings, { source_path: parentPath, source_id: candidate.parent })
    const current = (await cleanList(ctx, settings, candidate.parent, parentPath)).find(item => item.id === candidate.id)
    if (!current || digest(ctx, identity({ ...current, excluded: false })) !== digest(ctx, identity(candidate))) throw new Error('文件状态已变化，停止删除：' + candidate.path)
    if (candidate.id === rule.source_id || !below(candidate.path, rule.source_path) || rule.exclusions.some(path => below(candidate.path, path))) throw new Error('命中保护目录，已停止')
    if (candidate.dir && (await cleanList(ctx, settings, candidate.id, candidate.path)).length) throw new Error('目录不为空，已停止：' + candidate.path)
    await ctx.task.checkpoint({ stage: 'before_delete', rule_id: rule.id, candidate: candidate.id, path: candidate.path, removed })
    const token = (await ctx.storage.get('tokens'))?.access_token || settings.access_token
    const response = await request(ctx, settings, token, DELETE, { fileIds: [candidate.id] })
    if (!response || String(response.msg || '').trim().toLowerCase() !== 'success') throw new Error('删除响应未明确成功；请到光鸭核查，不会自动重试：' + candidate.path)
    await waitDeletion(ctx, settings, response)
    // Never assume submission means success; verify the parent list after deletion.
    let remains = true
    for (let attempt = 0; attempt < 5 && remains; attempt++) {
      if (attempt) await ctx.sleep(1000)
      remains = (await cleanList(ctx, settings, candidate.parent, parentPath)).some(item => item.id === candidate.id)
    }
    if (remains) throw new Error('删除结果尚未确认，已停止且不自动重试，请到光鸭核查：' + candidate.path)
    removed++
    if (candidate.dir) removedDirs++; else removedFiles++
    await updateCleanupRecord(ctx, rule.id, { stage: 'delete', removed_files: removedFiles, removed_dirs: removedDirs, message: candidate.path }, true)
    await ctx.task.log('已清理 ' + (candidate.dir ? '空目录：' : '文件：') + candidate.path)
    await ctx.task.update({ stage: 'delete', total: plan.candidates.length, done: removed, message: `${rule.name}：已清理 ${removed}/${plan.candidates.length} · ${candidate.path}` })
  }
  await ctx.task.log(`清理完成：${rule.name}，删除 ${removed} 项，保留所选根目录和排除目录`)
  return { removed, rule_id: rule.id, rule_name: rule.name, scanned: plan.scanned,
    planned_files: plan.candidates.filter(item => !item.dir).length,
    planned_dirs: plan.candidates.filter(item => item.dir).length,
    removed_files: plan.candidates.filter(item => !item.dir).length,
    removed_dirs: plan.candidates.filter(item => item.dir).length }
}
async function perform(ctx, input) {
  await requireIdle(ctx, 'sync')
  if (input.action === 'once-preview' || input.action === 'once-clean') {
    const rule = transientRule(input)
    const preview = input.action === 'once-preview'
    if (!preview && input.confirmed !== true) throw new Error('请先确认一次性清理范围')
    return withCleanupRecord(ctx, rule, preview ? 'preview' : 'manual', async () => {
      const plan = await makePlan(ctx, rule.id, rule)
      if (!preview) return execute(ctx, plan, false, rule)
      await ctx.task.log(`一次性预览完成：${rule.name}，扫描 ${plan.scanned} 项，候选 ${plan.candidates.length} 项；未执行删除`)
      await ctx.task.update({ stage: 'completed', progress: 100, total: plan.scanned, done: plan.scanned, message: '预览完成，未执行删除' })
      return { rule_name: rule.name, scanned: plan.scanned, removed_files: 0, removed_dirs: 0,
        planned_files: plan.candidates.filter(item => !item.dir).length, planned_dirs: plan.candidates.filter(item => item.dir).length }
    })
  }
  if (input.action === 'preview') {
    const { rule } = await currentRule(ctx, input.rule_id)
    return withCleanupRecord(ctx, rule, 'preview', async () => {
      const plan = await makePlan(ctx, input.rule_id)
      await ctx.task.log(`预览完成：${plan.rule_name}，扫描 ${plan.scanned} 项，候选 ${plan.candidates.length} 项；未执行删除`)
      await ctx.task.update({ stage: 'completed', progress: 100, total: plan.scanned, done: plan.scanned, failed: 0, message: '预览完成，未执行删除' })
      return { cleanup_rule: plan.rule_id, cleanup_plan: plan.id, count: plan.candidates.length,
        rule_name: plan.rule_name, scanned: plan.scanned, removed_files: 0, removed_dirs: 0,
        planned_files: plan.candidates.filter(item => !item.dir).length, planned_dirs: plan.candidates.filter(item => item.dir).length }
    })
  }
  if (input.action === 'scheduled' || input.action === 'manual') {
    const settings = await ctx.settings.get()
    const scheduled = input.action === 'scheduled'
    if (scheduled && settings.cleanup_schedule_enabled !== true) return { skipped: true }
    if (!scheduled && input.confirmed !== true) throw new Error('请先确认一次性清理范围')
    const ids = input.rule_ids || [input.rule_id], results = []
    if (!scheduled && digest(ctx, input.rules_snapshot) !== digest(ctx, cleanRules(settings).filter(rule => ids.includes(rule.id)))) throw new Error('清理规则已变化，请重新确认一次性清理')
    for (const id of ids) {
      if (!scheduled && digest(ctx, input.rules_snapshot) !== digest(ctx, cleanRules(await ctx.settings.get()).filter(rule => ids.includes(rule.id)))) throw new Error('清理规则已变化，停止一次性清理，请重新确认')
      const { rule } = await currentRule(ctx, id)
      if (!rule.enabled || (scheduled && !rule.scheduled)) continue
      results.push(await withCleanupRecord(ctx, rule, input.action, async () => execute(ctx, await makePlan(ctx, rule.id), scheduled)))
    }
    return { results, rule_name: results.map(item => item.rule_name).join('、'),
      ...Object.fromEntries(['scanned', 'planned_files', 'planned_dirs', 'removed_files', 'removed_dirs'].map(key => [key, results.reduce((sum, item) => sum + item[key], 0)])) }
  }
  if (input.action !== 'commit' || input.confirmed !== true) throw new Error('请先预览并确认清理清单')
  const plan = await ctx.storage.get('cloud_cleanup_plan:' + input.rule_id)
  if (!plan || plan.id !== input.plan_id) throw new Error('清理清单不存在或已被新预览替换')
  const { rule } = await currentRule(ctx, input.rule_id)
  return withCleanupRecord(ctx, rule, 'manual', async () => {
    await updateCleanupRecord(ctx, rule.id, { scanned_files: null, scanned_dirs: null,
      planned_files: plan.candidates.filter(item => !item.dir).length, planned_dirs: plan.candidates.filter(item => item.dir).length }, true)
    return execute(ctx, plan, false)
  })
}
function transientRule(input) {
  const raw = input.one_time_rule
  if (!raw || !/^once_[a-zA-Z0-9_-]+$/.test(raw.id || '')) throw new Error('一次性清理配置无效，请重新打开任务窗口')
  return validateCleanRule({ ...raw, name: String(raw.name || '').trim() || '一次性清理', enabled: true, scheduled: false })
}
export async function run(ctx, input = {}) {
  if (input.action === 'preview' || input.action === 'once-preview') return perform(ctx, input)
  const ids = input.rule_ids || [input.rule_id]
  const rules = input.action === 'once-clean' ? [transientRule(input)] : cleanRules(await ctx.settings.get()).filter(rule => ids.includes(rule.id))
  const notify = async (end, body, level) => {
    const selected = rules.filter(rule => end ? rule.notify_end : rule.notify_start)
    if (!selected.length) return
    try { await ctx.notify({ title: '光鸭文件清理', body: selected.map(rule => rule.name).join('、') + '\n' + body,
      channels: ['telegram'], level, dedupe_key: ctx.task.id + (end ? ':end' : ':start') }) }
    catch { await ctx.task.log('Telegram 通知未送达，请检查宿主通知配置；清理结果以系统任务队列为准') }
  }
  await notify(false, input.action === 'scheduled' ? '定时清理任务开始' : '手动清理任务开始', 'info')
  try {
    const result = await perform(ctx, input)
    await ctx.task.checkpoint({ stage: 'completed', result })
    await notify(true, '清理完成，详情请查看系统任务队列', 'success')
    return result
  } catch (error) {
    await notify(true, '清理停止：' + error.message, 'error')
    throw error
  }
}
export async function recover(ctx, checkpoint) {
  if (checkpoint?.stage === 'completed') return { action: 'complete', result: checkpoint.result }
  // No interrupted delete can be replayed merely because the previous call timed out.
  return { action: 'attention' }
}
