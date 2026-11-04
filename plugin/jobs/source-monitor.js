import { mountedRule } from './clouds.js'
import { sourcePaths, cd2HostPath } from './rules.js'
import { mergeChanges, monitorLog } from './monitor-log.js'
const PREFIX = 'guangya-source:'
const enabled = rule => rule.enabled && rule.organize_enabled !== false

// Retire legacy directory watches. Only organize-success receipts trigger increments.
export async function reconcileMonitors(ctx) {
  if (await ctx.storage.get('directory_watch_retired_v1')) return
  const watches = await ctx.api.get(`/api/extensions/v3/${ctx.plugin.id}/watches`)
  if (!Array.isArray(watches)) throw new Error('无法读取旧目录监听列表')
  for (const watch of watches) if (String(watch.id).startsWith(PREFIX)) await ctx.watch.remove(watch.id)
  await ctx.storage.set('source_monitor_status', {})
  await ctx.storage.set('directory_watch_retired_v1', true)
}

export async function realtimeRequests(ctx, rules) {
  const requests = []
  for (const rule of rules.filter(enabled)) {
    const pending = await ctx.storage.get('source_change_pending:' + rule.id)
    if (!pending || pending.ready > Date.now()) continue
    if (!(pending.changes || []).some(change => change.source === '宿主整理成功事件')) continue
    if (await ctx.storage.get('source_change_done:' + rule.id) === pending.version) continue
    requests.push({ rule_id: rule.id, full: false, realtime_version: pending.version, scopes: pending.scopes || null, changes: pending.changes || [], trigger: 'organize' })
  }
  return requests
}

export async function queueRealtime(ctx, ruleId, delay = 0, scopes = null, changes = []) {
  const key = 'source_change_pending:' + ruleId, old = await ctx.storage.get(key)
  const consumed = old && await ctx.storage.get('source_change_done:' + ruleId) === old.version
  let merged = scopes && old && !consumed ? old.scopes ? [...new Set([...old.scopes, ...scopes])] : null : scopes
  if (merged?.length > 200) merged = null
  await ctx.storage.set(key, { version: ctx.crypto.randomUUID(), scopes: merged, changes: mergeChanges(old && !consumed ? old.changes || [] : [], changes), ready: old && !consumed ? Math.min(old.ready, Date.now() + delay) : Date.now() + delay, at: Date.now() })
}

export async function receiveSourceChange(ctx, input, rules) {
  if (typeof input.watch !== 'string' || !input.watch.startsWith(PREFIX)) return { skipped: true }
  const rule = rules.find(rule => PREFIX + rule.id === input.watch && enabled(rule))
  if (!rule || !Array.isArray(input.changes) || !input.changes.length) return { skipped: true }
  // Resolve the CURRENT source; stale events from a replaced watch cannot cause
  // a sync of another cloud/path. Never execute cloud deletes from this signal.
  const resolved = await mountedRule(ctx, rule), virtual = sourcePaths(resolved).cd2.replace(/\/+$/, ''), host = cd2HostPath(virtual)
  const within = (path, root) => path === root || path.startsWith(root + '/')
  const scopes = []
  const changed = input.changes.filter(change => {
    if (!['created', 'changed', 'removed'].includes(change.kind)) return false
    const path = String(change.cd2_path || change.path || '')
    const root = within(path, virtual) ? virtual : within(path, host) ? host : null
    if (!root) return false
    if ((rule.excluded_paths || []).some(part => within(path, root + '/' + part))) return false
    const relative = path.slice(root.length).replace(/^\//, '')
    scopes.push(relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '')
    return true
  })
  if (!changed.length) return { skipped: true }
  await queueRealtime(ctx, rule.id, 3000, [...new Set(scopes)], changed.map(change => ({ path: change.cd2_path || change.path, kind: ({ created: 'add', changed: 'change', removed: 'remove' })[change.kind], source: 'CD2 目录快照', at: Date.now() })))
  await monitorLog(ctx, rule, '检测到 ' + changed.length + ' 项变化，已合并为 ' + new Set(scopes).size + ' 个待扫描目录；变化请求已保存')
  try {
    await ctx.api.post(`/api/extensions/v3/${ctx.plugin.id}/jobs/scheduler`, {
      business_key: 'source-change:' + Math.floor(Date.now() / 3000), input: { source_change: true }
    })
  } catch (error) { if (error.status !== 409) await ctx.task.log('目录变化已保留，等待自动派发：' + error.message) }
  return { received: true, rule_id: rule.id }
}
