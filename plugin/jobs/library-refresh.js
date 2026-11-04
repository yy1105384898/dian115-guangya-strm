import { getRules } from './rules.js'
// Queue only actual STRM writes. Keep the producer mailbox separate from the
// consumer receipt, so an event arriving during a refresh is not acknowledged.
export async function enqueueLibrary(ctx, rule, files) {
  if (!files.length) return
  const key = 'library_pending:' + rule.id, old = await ctx.storage.get(key)
  const entries = old?.output_path === rule.output_path ? { ...(old?.entries || {}) } : {}
  for (const file of files) {
    entries[file.destination] = { path: file.destination, rawPath: file.rawPath,
      signature: file.signature, at: new Date().toISOString() }
  }
  await ctx.storage.set(key, { version: ctx.crypto.randomUUID(), at: Date.now(), rule_name: rule.name, output_path: rule.output_path, entries })
  await ctx.task.log(rule.name + '：' + files.length + ' 项输出已登记媒体库刷新，等待 Emby 扫描')
}

export async function run(ctx) {
  const rules = getRules(await ctx.settings.get())
  // Avoid concurrent writes to outputs while requesting or verifying a scan.
  const response = await ctx.api.get(`/api/extensions/v3/${ctx.plugin.id}/runs?limit=200`)
  const runs = Array.isArray(response) ? response : response?.items
  if (!Array.isArray(runs)) throw new Error('无法确认同步任务状态')
  if (runs.some(run => run.job_id === 'sync' && ['queued', 'running'].includes(run.status))) return { deferred: true }
  const pending = []
  for (const rule of rules) {
    const mail = await ctx.storage.get('library_pending:' + rule.id)
    if (!mail || mail.output_path !== rule.output_path) continue
    const state = await ctx.storage.get('library_state:' + rule.id) || { entries: {} }
    pending.push({ rule, mail, state })
  }
  if (!pending.length) return { skipped: true }
  const refresh = await ctx.storage.get('library_refresh_receipt') || { versions: {}, at: 0 }
  refresh.versions ||= {}
  const needRefresh = pending.filter(item => refresh.versions[item.rule.id] !== item.mail.version)
  if (needRefresh.length && Date.now() - refresh.at >= 60000) {
    try {
      const status = await ctx.api.get('/api/emby-control/status')
      if (status?.ready !== true) throw new Error('宿主默认 Emby 未配置就绪，请检查实例和连接设置')
      // The published host API exposes a library-wide scan, not path-scoped
      // refresh. Merge all pending rules into one request per minute at most.
      await ctx.api.post('/api/emby-control/library/refresh', {})
      for (const item of needRefresh) refresh.versions[item.rule.id] = item.mail.version
      refresh.at = Date.now(); refresh.error = ''
      await ctx.storage.set('library_refresh_receipt', refresh)
      await ctx.task.log('已请求默认 Emby 扫描媒体库；请求成功不代表文件已经入库')
    } catch (error) {
      refresh.error = error.message; refresh.at = Date.now()
      await ctx.storage.set('library_refresh_receipt', refresh)
      await ctx.task.log('STRM 已生成，媒体库刷新待重试：' + error.message)
    }
  }
  return { refreshed: needRefresh.length > 0 && !refresh.error, error: refresh.error || '' }
}
