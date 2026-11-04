import { mountedRule } from './clouds.js'
import { sourcePaths, cd2HostPath } from './rules.js'

const STATE = 'organize_trigger_v1'
function timestamp(value) {
  if (!value) return 0
  const text = String(value).trim().replace(' ', 'T')
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : text + '+08:00') || 0
}
const within = (path, root) => path === root || path.startsWith(root.replace(/\/+$/, '') + '/')

// Host events wake this dispatcher; successful history remains the authority for
// target paths so unrelated 115/local work cannot trigger a Guangya rule.
export async function organizeRequests(ctx, rules) {
  const now = Date.now(), old = await ctx.storage.get(STATE) || { since: now - 120000, seen: [], pending: {}, settle: {} }
  const state = {...old, pending:{...(old.pending || {})}, settle:{...(old.settle || {})}}, seen = new Set(old.seen || [])
  const wakeup = Number(await ctx.storage.get('organize_event_wakeup')) || 0
  const lastScan = Number(old.last_scan_at) || 0
  const scanDue = !lastScan || now - lastScan >= 60000 || wakeup > lastScan && now - lastScan >= 3000
  const eligible = []
  for (const rule of rules.filter(item => item.enabled && item.organize_enabled !== false)) {
    try {
      let resolved
      try { resolved = await mountedRule(ctx, rule) }
      catch (error) { if (!rule.cloud_name) throw error; resolved = rule }
      const root = sourcePaths(resolved).cd2
      eligible.push({rule,root,host:cd2HostPath(root)})
    } catch (error) {
      // Do not match relative paths to unrelated 115 or local organize history.
      await ctx.task.log(rule.name + '：整理触发暂不可用，' + error.message)
    }
  }
  if (eligible.length && scanDue) {
    // Re-read an overlap window to catch completion of an older record.
    // No checkpoint is advanced if pagination fails or exceeds the safety cap.
    const found = [], pageSize = 100
    for (let page = 1; ; page++) {
      if (page > 50) throw new Error('整理成功记录超过本次检查上限，未推进检测水位，请缩减宿主整理历史或关闭整理触发')
      const response = await ctx.api.get(`/api/organize/history?status=success&page=${page}&page_size=${pageSize}`)
      if (!Array.isArray(response?.list)) throw new Error('宿主整理历史结构无效，未推进检测水位')
      found.push(...response.list)
      const total = Number(response.total)
      if (!response.list.length || (Number.isFinite(total) && found.length >= total) || response.list.length < pageSize) break
    }
    for (const record of found) {
      if (record.status !== 'success' || !record.target_path || !record.id) continue
      const at = timestamp(record.completed_at || record.created_at)
      if (!at || at < old.since) continue
      const signature = ctx.crypto.sha256(JSON.stringify([record.id,record.completed_at,record.target_path]))
      if (seen.has(signature)) continue
      for (const {rule,root,host} of eligible) {
        if (!within(record.target_path,root) && !within(record.target_path,host)) continue
        const excluded = (rule.excluded_paths || []).some(path => within(record.target_path,root + '/' + path) || within(record.target_path,host + '/' + path))
        if (excluded) continue
        // STRM does not need to wait for the entire organize task or sidecars.
        state.pending[rule.id] = {version:ctx.crypto.randomUUID(),ready:now}
        // A quiet-period pass also picks up NFO/images written after the success receipt.
        if (rule.metadata_mode !== 'off') state.settle[rule.id] = {version:ctx.crypto.randomUUID(),ready:now + 60000}
      }
      seen.add(signature)
    }
    state.last_scan_at = now
  }
  state.seen = [...seen].slice(-10000)
  state.since = Math.max(old.since,now - 24*60*60*1000)
  const requests = []
  for (const slot of ['pending','settle']) {
    for (const [id,pending] of Object.entries(state[slot])) {
      const rule = rules.find(item => item.id === id)
      const done = await ctx.storage.get('organize_done:' + id)
      if (!rule || !rule.enabled || rule.organize_enabled === false || done === pending.version) { delete state[slot][id]; continue }
      if (pending.ready <= now && !requests.some(request => request.rule_id === id)) requests.push({rule_id:id,full:false,organize_version:pending.version})
    }
  }
  await ctx.storage.set(STATE,state)
  return {requests,state}
}
