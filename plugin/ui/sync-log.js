import { element, dialog } from './dialog.js'
import { beijingTime } from './shared/schedule.js'

export function mountSyncLog(panel, app, ctx, feedback) {
  const doc = panel.ownerDocument, node = (tag, cls, text) => element(doc, tag, cls, text)
  panel.innerHTML = '<div class="card-head"><h3>同步日志</h3><div class="actions"><span class="badge" data-count></span><button data-clear class="danger compact">清空记录</button></div></div><div class="table-wrap" style="max-height:360px;overflow:auto"><table class="rules-table"><thead><tr><th>时间</th><th>类型</th><th>状态</th><th>内容</th><th>进度</th><th>操作</th></tr></thead><tbody></tbody></table></div><p class="help" style="padding:0 18px 12px">仅显示北京时间当天的日志，自动刷新。删除仅移除本页记录，系统任务历史保留。</p>'
  let visible = [], hidden = new Set(), busy = false, disposed = false
  const ongoing = run => !run.library && ['queued', 'running', 'attention_required'].includes(run.status)
  const labels = { queued: '排队中', running: '同步中', succeeded: '完成', failed: '失败', cancelled: '已取消', canceled: '已取消', interrupted: '已中断', attention_required: '需要核对' }
  const guard = fn => async () => { try { await fn() } catch (error) { feedback(error.message || '读取同步日志失败', 'error') } }
  function removeRecords(ids) {
    if (!ids.length || busy) return
    const modal = dialog(app, '删除日志记录'), cancel = node('button', '', '取消'), confirm = node('button', 'danger', '确认删除')
    modal.body.append(node('p', '', '从本页移除这 ' + ids.length + ' 条日志记录？后台同步和入库检查保留。'))
    modal.footer.append(cancel, confirm); cancel.onclick = () => modal.close()
    confirm.onclick = guard(async () => {
      if (busy) return
      busy = true; confirm.disabled = true
      try {
        const selected = visible.filter(run => ids.includes(String(run.id)))
        for (const [key, entries] of [['sync_hidden_records', selected.filter(run => !run.library)], ['library_hidden_records', selected.filter(run => run.library)]]) {
          if (!entries.length) continue
          const saved = await ctx.storage.get(key) || []
          await ctx.storage.set(key, [...new Set([...saved, ...entries.map(run => run.storageId)])])
        }
        visible = visible.filter(run => !ids.includes(String(run.id)))
        modal.close(); render(); feedback('日志记录已移除', 'ok')
      } finally { busy = false; confirm.disabled = false }
    })
  }
  function render() {
    if (disposed) return
    const body = panel.querySelector('tbody'); body.replaceChildren()
    panel.querySelector('[data-count]').textContent = visible.length + ' 条'
    panel.querySelector('[data-clear]').disabled = !visible.some(run => !ongoing(run))
    for (const run of visible) {
      const row = node('tr'), state = node('td'), actions = node('td')
      state.append(node('span', 'badge ' + (run.status === 'succeeded' ? 'ok' : ''), run.label || labels[run.status] || run.status))
      const detail = node('button', 'compact', '查看日志')
      detail.onclick = guard(async () => {
        const data = run.library ? run : await ctx.api.get(`/api/extensions/v3/${ctx.id}/runs/${encodeURIComponent(run.storageId)}`)
        if (disposed) return
        const modal = dialog(app, '光鸭同步日志', true), close = node('button', '', '关闭')
        modal.body.append(node('p', '', data.label || labels[data.status] || data.status), node('p', 'help', data.error || data.message || ''))
        const logs = node('pre'); logs.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto;font:12px/1.8 monospace'
        logs.textContent = Array.isArray(data.logs) && data.logs.length ? data.logs.join('\n') : '暂无日志输出'
        modal.body.append(logs); modal.footer.append(close); close.onclick = () => modal.close()
      })
      actions.append(detail)
      if (!ongoing(run)) {
        const remove = node('button', 'compact danger', '删除'); remove.style.marginLeft = '8px'
        remove.onclick = () => removeRecords([String(run.id)]); actions.append(remove)
      }
      const date = new Date(run.created_at).getTime()
      row.append(node('td', '', Number.isFinite(date) ? beijingTime(date) : '—'), node('td', '', run.job_id === 'duplicate-source' ? '重复来源清理' : '同步'), state,
        node('td', '', run.error || run.message || '光鸭 STRM 同步'),
        node('td', '', !run.library && Number.isFinite(Number(run.progress)) ? Math.max(0, Math.min(100, Number(run.progress))) + '%' : '—'), actions)
      body.append(row)
    }
    if (!visible.length) { const row = node('tr'), cell = node('td', 'empty', '今天暂无同步日志'); cell.colSpan = 6; row.append(cell); body.append(row) }
  }
  panel.querySelector('[data-clear]').onclick = () => removeRecords(visible.filter(run => !ongoing(run)).map(run => String(run.id)))
  return {
    async update(runs) {
      const saved = await ctx.storage.get('sync_hidden_records') || []
      if (disposed) return
      hidden = new Set(saved)
      const sync = runs.filter(run => ['sync', 'duplicate-source'].includes(run.job_id) && !hidden.has(String(run.id))).map(run => ({ ...run, storageId: String(run.id), id: 'sync:' + run.id }))
      const day = value => { const time = new Date(value).getTime(); return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : '' }
      const today = day(Date.now())
      visible = sync.filter(run => day(run.created_at) === today).sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0))
      render()
    },
    dispose() { disposed = true }
  }
}
