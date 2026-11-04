export async function requireIdle(ctx, job) {
  const response = await ctx.api.get(`/api/extensions/v3/${ctx.plugin.id}/runs?limit=200`)
  const runs = Array.isArray(response) ? response : response?.items
  if (!Array.isArray(runs)) throw new Error('无法确认关联任务状态，暂不执行')
  if (runs.some(run => String(run.id) !== String(ctx.task.id) && (run.job_id === job || job !== 'duplicate-source' && run.job_id === 'duplicate-source') && ['queued', 'running', 'attention_required'].includes(run.status))) {
    throw new Error(job === 'sync' ? '请先完成或停止 STRM 同步任务，再执行云端清理' : '请先完成或核对光鸭清理任务，再执行 STRM 同步')
  }
}
