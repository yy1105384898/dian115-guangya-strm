import { mountedRule } from './clouds.js'
import { sourcePaths, cd2HostPath } from './rules.js'
const PREFIX = 'guangya-source:'
const enabled = rule => rule.enabled && rule.organize_enabled !== false

// Reconcile persistent host watches, including rule disable/removal/path changes.
// Guangya has no documented 115-style life-event feed. CD2 watches use host
// snapshots; account API remains the authority for the actual synchronization.
export async function reconcileMonitors(ctx, rules, force = false) {
  const signature = ctx.crypto.sha256(JSON.stringify(rules.map(rule => [rule.id, rule.enabled, rule.organize_enabled,
    rule.cloud_name, rule.source_mode, rule.source_cd2_path, rule.source_display_path])))
  const previous = await ctx.storage.get('source_monitor_config')
  if (!force && previous?.signature === signature && Date.now() - previous.at < 60000) return
  const watches = await ctx.api.get(`/api/extensions/v3/${ctx.plugin.id}/watches`)
  if (!Array.isArray(watches)) throw new Error('宿主未返回有效目录监听列表')
  const statuses = {}, wanted = new Set(rules.filter(enabled).map(rule => PREFIX + rule.id))
  for (const watch of watches) if (String(watch.id).startsWith(PREFIX) && !wanted.has(watch.id)) await ctx.watch.remove(watch.id)
  for (const rule of rules.filter(enabled)) {
    const id = PREFIX + rule.id
    try {
      const resolved = await mountedRule(ctx, rule), path = cd2HostPath(sourcePaths(resolved).cd2)
      const current = watches.find(watch => watch.id === id)
      const matches = current && current.path === path && current.job === 'source-change' &&
        current.kind === 'cd2' && current.recursive === true && current.interval_seconds === 60
      if (!matches) {
        if (current) await ctx.watch.remove(id)
        await ctx.watch.add({ id, kind: 'cd2', path, job: 'source-change', interval_seconds: 60,
          realtime: true, recursive: true, debounce_ms: 3000, patterns: [] })
        // The host's first snapshot establishes a baseline without emitting a
        // change. Scan once on installation/path change to close that gap.
        await queueRealtime(ctx, rule.id)
      }
      statuses[rule.id] = { registered: true, initialized: !!(matches && current.initialized), path,
        error: matches ? current.error || '' : '', at: Date.now() }
    } catch (error) {
      // An old path must not keep triggering a rule whose source has changed.
      if (watches.some(watch => watch.id === id)) {
        try { await ctx.watch.remove(id) } catch { /* Handler independently checks the current rule. */ }
      }
      statuses[rule.id] = { registered: false, error: error.message, at: Date.now() }
      await ctx.task.log(rule.name + '：目录监听未注册，' + error.message)
    }
  }
  await ctx.storage.set('source_monitor_status', statuses)
  await ctx.storage.set('source_monitor_config', { signature, at: Date.now() })
}

export async function realtimeRequests(ctx, rules) {
  const requests = []
  for (const rule of rules.filter(enabled)) {
    const pending = await ctx.storage.get('source_change_pending:' + rule.id)
    if (!pending || pending.ready > Date.now()) continue
    if (await ctx.storage.get('source_change_done:' + rule.id) === pending.version) continue
    requests.push({ rule_id: rule.id, full: false, realtime_version: pending.version })
  }
  return requests
}

export async function queueRealtime(ctx, ruleId, delay = 0) {
  const key = 'source_change_pending:' + ruleId, old = await ctx.storage.get(key)
  const consumed = old && await ctx.storage.get('source_change_done:' + ruleId) === old.version
  await ctx.storage.set(key, { version: ctx.crypto.randomUUID(), ready: old && !consumed ? Math.min(old.ready, Date.now() + delay) : Date.now() + delay, at: Date.now() })
}

export async function receiveSourceChange(ctx, input, rules) {
  if (typeof input.watch !== 'string' || !input.watch.startsWith(PREFIX)) return { skipped: true }
  const rule = rules.find(rule => PREFIX + rule.id === input.watch && enabled(rule))
  if (!rule || !Array.isArray(input.changes) || !input.changes.length) return { skipped: true }
  // Resolve the CURRENT source; stale events from a replaced watch cannot cause
  // a sync of another cloud/path. Never execute cloud deletes from this signal.
  const resolved = await mountedRule(ctx, rule), virtual = sourcePaths(resolved).cd2.replace(/\/+$/, ''), host = cd2HostPath(virtual)
  const within = (path, root) => path === root || path.startsWith(root + '/')
  const changed = input.changes.some(change => {
    if (!['created', 'changed', 'removed'].includes(change.kind)) return false
    const path = String(change.cd2_path || change.path || '')
    const root = within(path, virtual) ? virtual : within(path, host) ? host : null
    if (!root) return false
    return !(rule.excluded_paths || []).some(part => within(path, root + '/' + part))
  })
  if (!changed) return { skipped: true }
  await queueRealtime(ctx, rule.id, 3000)
  try {
    await ctx.api.post(`/api/extensions/v3/${ctx.plugin.id}/jobs/scheduler`, {
      business_key: 'source-change:' + Math.floor(Date.now() / 3000), input: { source_change: true }
    })
  } catch (error) { if (error.status !== 409) await ctx.task.log('目录变化已保留，等待自动派发：' + error.message) }
  return { received: true, rule_id: rule.id }
}
