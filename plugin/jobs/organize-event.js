import { getRules, sourcePaths, cd2HostPath } from './rules.js'
import { mountedRule } from './clouds.js'
import { queueRealtime } from './source-monitor.js'
// Official host business events can carry a per-file success receipt. Consume
// its exact target path immediately rather than waiting for the history query.
export async function run(ctx, event = {}) {
  if (!String(event.type || '').startsWith('library_organize_')) return { skipped: true }
  const now = Date.now()
  await ctx.storage.set('organize_event_wakeup', now)
  const data = event.data || {}, target = typeof data.target_path === 'string' ? data.target_path : ''
  const success = data.status === 'success' || /_success$/.test(String(event.type))
  if (success && target) {
    const within = (path, root) => path === root || path.startsWith(root.replace(/\/+$/, '') + '/')
    for (const rule of getRules(await ctx.settings.get()).filter(rule => rule.enabled && rule.organize_enabled !== false)) {
      try {
        let resolved
        try { resolved = await mountedRule(ctx, rule) }
        catch (error) { if (!rule.cloud_name) throw error; resolved = rule }
        const root = sourcePaths(resolved).cd2, host = cd2HostPath(root)
        const matched = within(target, root) ? root : within(target, host) ? host : null
        if (!matched || (rule.excluded_paths || []).some(part => within(target, matched + '/' + part))) continue
        await queueRealtime(ctx, rule.id)
      } catch (error) { await ctx.task.log(rule.name + '：整理事件暂不能匹配源目录，' + error.message) }
    }
  }
  try {
    await ctx.api.post(`/api/extensions/v3/${ctx.plugin.id}/jobs/scheduler`, {
      business_key: 'organize-event:' + Math.floor(now / 3000), input: { organize_event: true }
    })
  } catch (error) {
    // The wakeup persists. The running dispatcher or 15-second fallback picks it up.
    if (error.status !== 409) await ctx.task.log('整理事件已记录，等待定时派发：' + error.message)
  }
  return { received: true }
}
