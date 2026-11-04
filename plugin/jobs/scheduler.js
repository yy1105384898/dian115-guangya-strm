import { parseCron, matchesCron } from './schedule.js'
import { getRules, scheduleExpression } from './rules.js'
import { organizeRequests } from './organize-trigger.js'
import { reconcileMonitors, realtimeRequests } from './source-monitor.js'

export async function run(ctx, input = {}) {
  const rules = getRules(await ctx.settings.get()), minute = Math.floor(Date.now()/60000)
  try { await reconcileMonitors(ctx, rules, input.reconcile === true) }
  catch (error) { await ctx.task.log('源目录监听检查失败：' + error.message) }
  let incremental = []
  if (rules.some(rule => rule.enabled && rule.organize_enabled !== false)) {
    try { incremental = (await organizeRequests(ctx,rules)).requests }
    catch (error) { await ctx.task.log('整理检测失败，将在下一分钟重试：' + error.message) }
  }
  const fullPending = await ctx.storage.get('full_sync_pending') || {}
  const incPending = await ctx.storage.get('incremental_sync_pending') || {}
  if (await ctx.storage.get('scheduled_minute') !== minute) {
    for (const rule of rules) {
      if (!rule.enabled || !rule.schedule_enabled) continue
      const expression = scheduleExpression(rule,true)
      if (expression && matchesCron(parseCron(expression),minute*60000)) fullPending[rule.id] = minute
      if (matchesCron(parseCron(scheduleExpression(rule)),minute*60000)) incPending[rule.id] = minute
    }
    await ctx.storage.set('incremental_sync_pending',incPending)
    await ctx.storage.set('full_sync_pending',fullPending)
    await ctx.storage.set('scheduled_minute',minute)
  }
  const requests = [...incremental]
  for (const realtime of await realtimeRequests(ctx, rules)) {
    const existing = requests.find(request => request.rule_id === realtime.rule_id)
    if (existing) existing.realtime_version = realtime.realtime_version
    else requests.push(realtime)
  }
  for (const id of Object.keys(incPending)) {
    if (!rules.some(rule => rule.id === id && rule.enabled && rule.schedule_enabled)) { delete incPending[id]; continue }
    if (!requests.some(request => request.rule_id === id)) requests.push({rule_id:id,full:false,trigger:'timer'})
  }
  for (const id of Object.keys(fullPending)) {
    if (!rules.some(rule => rule.id === id && rule.enabled && rule.schedule_enabled && Number(rule.full_minutes)>0)) { delete fullPending[id]; continue }
    const existing = requests.find(request => request.rule_id === id)
    if (existing) existing.full = true
    else requests.push({rule_id:id,full:true})
  }
  if (!requests.length) return {skipped:true}
  const response = await ctx.api.get(`/api/extensions/v3/${ctx.plugin.id}/runs?limit=200`)
  const runs = Array.isArray(response) ? response : response?.items
  if (!Array.isArray(runs)) throw new Error('无法确认同步任务状态，本次保留待同步请求')
  if (runs.some(run => ['sync','cloud-cleanup'].includes(run.job_id) && ['queued','running','attention_required'].includes(run.status))) return {deferred:true}
  const lastSubmission = Number(await ctx.storage.get('automatic_sync_last_submission')) || 0
  const hasOrganize = requests.some(request => request.organize_version || request.realtime_version)
  if (Date.now()-lastSubmission < (hasOrganize ? 3000 : 300000)) return {deferred:true}
  const signature = ctx.crypto.sha256(JSON.stringify(requests)).slice(0,20)
  await ctx.api.post(`/api/extensions/v3/${ctx.plugin.id}/jobs/sync`,{
    business_key:`automatic:${minute}:${signature}`,input:{scheduled:true,requests}
  })
  await ctx.storage.set('automatic_sync_last_submission',Date.now())
  for (const request of requests) {
    if(request.full) delete fullPending[request.rule_id]
    delete incPending[request.rule_id]
  }
  await ctx.storage.set('incremental_sync_pending',incPending)
  await ctx.storage.set('full_sync_pending',fullPending)
  await ctx.task.log('已提交：' + requests.map(request => (rules.find(rule => rule.id===request.rule_id)?.name || request.rule_id) + (request.full ? '（定时全量）' : request.realtime_version ? '（源目录变化增量）' : request.organize_version ? '（整理后增量）' : '（定时增量）')).join('、'))
  return {submitted:requests.length}
}
