// Per-rule rows complement the host run (which may execute several rules).
// Progress writes are throttled so directory traversal does not write on every
// file. No file lists, account credentials or playback links are stored here.
const lastWrites = new Map()
export async function updateCleanupRecord(ctx, ruleId, patch, force = false) {
  const id = String(ctx.task.id) + ':' + ruleId
  if (!force && Date.now() - (lastWrites.get(id) || 0) < 1000) return
  const records = await ctx.storage.get('cleanup_queue') || []
  const record = records.find(item => item.id === id)
  if (!record) return
  Object.assign(record, patch, { updated_at: new Date().toISOString() })
  await ctx.storage.set('cleanup_queue', records)
  lastWrites.set(id, Date.now())
}
export async function withCleanupRecord(ctx, rule, kind, operation) {
  const id = String(ctx.task.id) + ':' + rule.id
  const records = await ctx.storage.get('cleanup_queue') || []
  records.push({ id, run_id: String(ctx.task.id), rule_id: rule.id, rule_name: rule.name,
    source_path: rule.source_path, kind, status: 'running', stage: 'scan',
    created_at: new Date().toISOString(), scanned_files: 0, scanned_dirs: 0,
    planned_files: 0, planned_dirs: 0, removed_files: 0, removed_dirs: 0, message: '开始扫描', error: '' })
  await ctx.storage.set('cleanup_queue', records)
  try {
    const result = await operation()
    await updateCleanupRecord(ctx, rule.id, { ...result, status: 'succeeded', stage: 'completed',
      message: kind === 'preview' ? '预览完成，未执行删除' : '清理完成', finished_at: new Date().toISOString() }, true)
    return result
  } catch (error) {
    try { await updateCleanupRecord(ctx, rule.id, { status: 'failed', stage: 'stopped',
      error: error.message, message: '任务停止', finished_at: new Date().toISOString() }, true) } catch { /* Host status remains authoritative if cancellation prevents writes. */ }
    throw error
  } finally { lastWrites.delete(id) }
}
