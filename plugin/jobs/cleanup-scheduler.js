import { cleanRules, cleanupCron } from './clean-rules.js'
import { parseCron, matchesCron } from './schedule.js'

export async function run(ctx) {
  const settings = await ctx.settings.get(), minute = Math.floor(Date.now() / 60000)
  if (settings.cleanup_schedule_enabled !== true) { await ctx.storage.set('cloud_cleanup_pending', {}); return { skipped: true } }
  const rules = cleanRules(settings).filter(rule => rule.enabled && rule.scheduled)
  const pending = await ctx.storage.get('cloud_cleanup_pending') || {}
  const cron = cleanupCron(settings.cleanup_cron || '0 3 * * *')
  if (await ctx.storage.get('cloud_cleanup_scheduled_minute') !== minute) {
    if (matchesCron(parseCron(cron), minute * 60000)) for (const rule of rules) pending[rule.id] = minute
    await ctx.storage.set('cloud_cleanup_pending', pending)
    await ctx.storage.set('cloud_cleanup_scheduled_minute', minute)
  }
  for (const id of Object.keys(pending)) if (!rules.some(rule => rule.id === id)) delete pending[id]
  if (!Object.keys(pending).length) { await ctx.storage.set('cloud_cleanup_pending', pending); return { skipped: true } }
  const response = await ctx.api.get(`/api/extensions/v3/${ctx.plugin.id}/runs?limit=200`)
  const runs = Array.isArray(response) ? response : response?.items
  if (!Array.isArray(runs)) throw new Error('无法核对任务状态，暂不提交清理')
  if (runs.some(run => ['sync', 'cloud-cleanup'].includes(run.job_id) && ['queued', 'running', 'attention_required'].includes(run.status))) return { deferred: true }
  const ids = Object.keys(pending), key = ctx.crypto.sha256(JSON.stringify(pending)).slice(0, 24)
  await ctx.api.post(`/api/extensions/v3/${ctx.plugin.id}/jobs/cloud-cleanup`, { business_key: 'scheduled-cleanup:' + key, input: { action: 'scheduled', rule_ids: ids } })
  await ctx.storage.set('cloud_cleanup_pending', {})
  await ctx.task.log('已提交定时清理：' + rules.filter(rule => ids.includes(rule.id)).map(rule => rule.name).join('、'))
  return { submitted: ids.length }
}
