// Host exposes task.log, not an API for inserting native 115 operation logs.
// Keep one bounded, readable trace in the actual sync task (no separate log UI).
const text = value => String(value || '').replace(/[\r\n\0]/g, ' ').slice(0, 1200)
export async function monitorLog(ctx, rule, message) {
  await ctx.task.log('[光鸭文件监控] ' + text(message) + ' | 规则：' + text(rule.name))
}
export function mergeChanges(...groups) {
  const entries = new Map()
  for (const change of groups.flat()) {
    if (!change || typeof change.path !== 'string') continue
    const item = { path: text(change.path), kind: text(change.kind), source: text(change.source), at: Number(change.at) || Date.now() }
    entries.set(item.source + ':' + item.kind + ':' + item.path, item)
  }
  return [...entries.values()].slice(-100)
}
export async function traceChanges(ctx, rule, changes) {
  for (const change of mergeChanges(changes || [])) {
    await monitorLog(ctx, rule, '文件变动 ' + change.kind + '：' + change.path + ' | 来源：' + change.source)
  }
  if (changes?.length >= 100) await monitorLog(ctx, rule, '本批仅保留最近 100 条文件变化明细；同步范围单独保存，不按明细条数截断')
}
