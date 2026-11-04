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
  await ctx.task.log(rule.name + '：' + files.length + ' 项输出已登记媒体库刷新，入库状态等待 Emby 核实')
}

function identity(path) {
  const tmdb = /\{tmdbid[=\-](\d+)\}/i.exec(path)?.[1]
  const episode = /S(\d+)E(\d+)/i.exec(path)
  const part = path.split('/').find(part => /\{tmdbid[=\-]\d+\}/i.test(part)) || ''
  const name = part.replace(/\s*-?\{tmdbid[=\-]\d+\}.*$/i, '').replace(/\s*\(\d{4}\)\s*$/, '').trim()
  return { tmdb, episode, name }
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
  let budget = 5
  for (const { rule, mail, state } of pending) {
    state.entries ||= {}
    const ordered = Object.values(mail.entries).sort((a, b) => (state.entries[a.path]?.checked_at || 0) - (state.entries[b.path]?.checked_at || 0))
    for (const entry of ordered) {
      const old = state.entries[entry.path]
      if (old?.signature === entry.signature && ['confirmed', 'unverified'].includes(old.status)) continue
      if (refresh.versions[rule.id] !== mail.version) continue
      if (old?.signature === entry.signature && Date.now() - (old.checked_at || 0) < 60000) continue
      if (budget-- <= 0) break
      const receipt = { signature: entry.signature, checked_at: Date.now(), status: 'scanning', name: entry.rawPath }
      try {
        const target = identity(entry.rawPath)
        if (!target.tmdb || !target.name) {
          receipt.status = 'unverified'; receipt.message = '扫描已提交，缺少 TMDB 标识，无法精确核实入库'
        } else {
          let found = null
          if (target.episode) {
            const result = await ctx.api.get('/api/plugin-host/emby/episodes?tmdb_id=' + target.tmdb + '&season=' + Number(target.episode[1]) + '&total_episodes=0')
            if (String(result?.tmdb_id) !== target.tmdb || Number(result?.season) !== Number(target.episode[1]) || typeof result?.covered_episodes !== 'string') throw new Error('宿主未返回有效的季集覆盖信息')
            const wanted = Number(target.episode[2])
            if (result.covered_episodes.split(',').some(part => {
              const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part)
              return match && wanted >= Number(match[1]) && wanted <= Number(match[2] || match[1])
            })) found = { name: target.name + ' · ' + target.episode[0] }
          } else {
            const result = await ctx.api.get('/api/plugin-host/emby/items?type=Movie&q=' + encodeURIComponent(target.name) + '&limit=50')
            if (!Array.isArray(result?.items)) throw new Error('Emby 查询未返回有效媒体列表')
            for (const item of result.items) {
              const provider = item.provider_ids || {}
              if (String(provider.Tmdb || provider.tmdb || '') === target.tmdb) { found = item; break }
            }
          }
          if (found) {
            receipt.status = 'confirmed'; if (found.id) receipt.item_id = found.id
            receipt.name = found.name
            receipt.message = '媒体库中已确认同一 TMDB 条目' + (target.episode ? '及季集' : '')
            await ctx.task.log('入库核实：' + receipt.name + '（媒体身份匹配，不代表本次文件路径已核实）')
          } else receipt.message = '扫描已提交，尚未查询到匹配媒体；稍后重查'
        }
      } catch (error) { receipt.status = 'query_error'; receipt.message = error.message }
      state.entries[entry.path] = receipt
    }
    state.updated_at = new Date().toISOString()
    state.refresh_error = refresh.error || ''
    state.submitted = refresh.versions[rule.id] === mail.version
    await ctx.storage.set('library_state:' + rule.id, state)
  }
  return { checked: Math.min(5, 5 - budget) }
}
