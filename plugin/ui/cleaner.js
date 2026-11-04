import { element, dialog } from './dialog.js'
import { randomUUID } from './shared/uuid.js'
import { pickDirectory } from './picker.js'
import { newCleanRule, validateCleanRule, cleanRules, cleanSummary, CLEAN_MODES, cleanupCron } from './shared/clean-rules.js'
import { nextTimes, beijingTime } from './shared/schedule.js'

export function mountCleaner(app, panel, ctx, feedback) {
  const doc = panel.ownerDocument, win = doc.defaultView
  const node = (tag, cls, text) => element(doc, tag, cls, text)
  panel.innerHTML = `<div class="toolbar"><div><h3>文件清理</h3><small>清理光鸭网盘文件和空目录</small></div><div class="actions"><button data-clean="refresh">刷新</button><button class="danger" data-clean="once">▷ 一次性清理</button><button class="primary" data-clean="add">＋ 新建规则</button></div></div>
    <div class="clean-notice">先预览，再确认清理。所选根目录和排除目录始终保留；无法确认删除结果时任务停止，不自动重试。</div>
    <div class="clean-layout"><div class="card"><div class="card-head"><h3>清理规则</h3><span class="badge" data-clean="count">0 条</span></div><div data-clean="rules"></div></div>
    <aside class="card"><div class="card-head"><h3>目录保护</h3></div><div class="card-body"><p class="help">只处理选定的光鸭子目录，不允许清理整个网盘。</p><p class="help">排除目录及其全部内容保留。每次删除前重新读取规则，规则或账号变化时立即停止。</p><p class="help">此功能直接清理光鸭云端；STRM 输出目录与 115 网盘不会作为清理目标。</p><p class="help">宿主整理、转存等目录不会自动加入排除列表。需要保留整个目录时，请在规则中手动排除。</p><p class="help">任务进度、删除明细和错误在系统任务队列查看。</p></div></aside></div>
    <div class="card"><div class="card-head"><h3>统一定时执行</h3><small>北京时间</small></div><div class="card-body"><div class="inline"><label class="sync-option"><input type="checkbox" data-clean="scheduleOn">启用</label><input data-clean="cron" aria-label="清理 Cron" placeholder="0 3 * * *"><button data-clean="saveSchedule" class="primary">保存时间</button></div><p class="help">仅执行已勾选“加入统一定时”的规则。支持五段 Cron，或秒字段为 0 的六段 Cron；默认每天凌晨 3 点。</p><p class="help" data-clean="next"></p></div></div>
    <div class="card"><div class="card-head"><h3>任务队列</h3><div class="actions"><span class="badge" data-clean="taskCount">0 条</span><button class="compact danger" data-clean="clearAll">清空全部记录</button></div></div><div class="table-wrap"><table class="rules-table cleanup-task-table"><thead><tr><th>任务</th><th>状态</th><th>扫描文件</th><th>预计清理 文件 / 文件夹</th><th>已清理 文件 / 文件夹</th><th>当前阶段</th><th>结果说明</th><th>操作</th></tr></thead><tbody data-clean="tasks"></tbody></table></div></div>`
  const $ = key => panel.querySelector(`[data-clean="${key}"]`)
  let rules = [], disposed = false, timer, busy = false, active = false, waiting = null, loading = false, inlineConfirm = null
  function guard(button, operation) {
    return async () => { if (button.disabled) return; button.disabled = true; try { await operation() } catch (error) { feedback(error.message, 'error') } finally { if (!disposed) button.disabled = false } }
  }
  async function persist(next) {
    if (busy) throw new Error('正在保存，请稍后再试')
    busy = true
    try {
      const settings = await ctx.settings.get()
      await ctx.settings.set({ ...settings, cloud_cleanup_rules: next.map(validateCleanRule) })
      rules = next; render()
    } finally { busy = false }
  }
  function render() {
    if (inlineConfirm && !inlineConfirm.closed) return
    $('count').textContent = rules.length + ' 条'
    $('rules').replaceChildren()
    if (!rules.length) $('rules').append(node('div', 'empty', '还没有清理规则，点击“新建规则”开始。'))
    for (const rule of rules) {
      const row = node('article', 'clean-rule'), content = node('div', 'clean-rule-content'), title = node('div', 'inline')
      title.append(node('strong', '', rule.name), node('span', 'badge', '已保存'))
      if (!rule.enabled) title.append(node('span', 'badge', '已停用'))
      if (rule.scheduled) title.append(node('span', 'badge', '定时'))
      const modes = node('div', 'inline')
      modes.append(node('span', 'clean-mode', CLEAN_MODES[rule.mode]))
      if (rule.empty_dirs) modes.append(node('span', 'badge ok', '清理空目录'))
      const saved = rule.updated_at ? beijingTime(new Date(rule.updated_at).getTime()) + ' · ' : ''
      content.append(title, node('p', 'clean-source', saved + rule.source_path), modes, node('p', 'help', cleanSummary(rule)))
      const actions = node('div', 'actions'), preview = node('button', 'compact', '预览'), clean = node('button', 'compact danger', '▷ 清理'), edit = node('button', 'compact', '编辑'), remove = node('button', 'compact danger', '删除规则')
      preview.disabled = active; clean.disabled = active || !rule.enabled
      preview.onclick = guard(preview, () => submitPreview(rule))
      clean.onclick = guard(clean, () => cleanOnce(rule.id, clean))
      edit.onclick = () => editRule(rule)
      remove.onclick = () => {
        const modal = dialog(app, '删除清理规则'), cancel = node('button', '', '取消'), confirm = node('button', 'danger', '确认删除规则')
        modal.body.append(node('p', '', `删除规则“${rule.name}”？此操作只移除配置。`)); modal.footer.append(cancel, confirm)
        cancel.onclick = () => modal.close()
        confirm.onclick = guard(confirm, async () => { const current = cleanRules(await ctx.settings.get()); await persist(current.filter(item => item.id !== rule.id)); modal.close(); feedback('清理规则已删除', 'ok') })
      }
      actions.append(preview, clean, edit, remove); row.append(content, actions); $('rules').append(row)
    }
  }
  function updateNext() {
    try {
      const cron = cleanupCron($('cron').value)
      $('next').textContent = $('scheduleOn').checked ? '下次执行：' + nextTimes(cron, Date.now(), 2).map(beijingTime).join(' · ') : '定时已关闭，保存规则后可手动预览。'
    } catch (error) { $('next').textContent = error.message }
  }
  let queueItems = []
  async function renderTasks(runs, records, hidden) {
    const omitted = new Set(hidden), host = new Map(runs.map(run => [String(run.id), run]))
    const ownRuns = new Set(records.map(record => record.run_id))
    const entries = records.map(record => {
      const run = host.get(record.run_id)
      const status = ['running', 'queued', 'failed'].includes(record.status) && run &&
        ['failed', 'cancelled', 'canceled', 'interrupted', 'attention_required'].includes(run.status) ? run.status : record.status
      return { ...record, status, result: record, run }
    })
    for (const run of runs.filter(run => run.job_id === 'cloud-cleanup' && !ownRuns.has(String(run.id)))) {
      const result = run.result || {}
      const kind = /^(cloud-preview:|once-preview:)/.test(String(run.business_key || '')) ? 'preview' : String(run.business_key || '').startsWith('scheduled-cleanup:') ? 'scheduled' : 'manual'
      const results = Array.isArray(result.results) && result.results.length ? result.results : [result]
      results.forEach((item, index) => entries.push({ id: String(run.id) + (results.length > 1 ? ':' + index : ''),
        run_id: String(run.id), run, result: item, rule_name: item.rule_name || '光鸭文件清理', kind,
        created_at: run.created_at, status: run.status, stage: run.stage, message: run.message, error: run.error }))
    }
    const numbering = await ctx.storage.get('cleanup_display_numbers') || { next: 1, ids: {} }
    let changed = false
    for (const item of [...entries].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
      if (!Object.hasOwn(numbering.ids, item.id)) { numbering.ids[item.id] = numbering.next++; changed = true }
      item.number = numbering.ids[item.id]
    }
    if (changed) await ctx.storage.set('cleanup_display_numbers', numbering)
    if (disposed) return
    queueItems = entries.filter(item => !omitted.has(item.id)).sort((a, b) => b.number - a.number)
    $('taskCount').textContent = queueItems.length + ' 条'
    $('clearAll').disabled = !queueItems.some(item => !['queued', 'running', 'attention_required'].includes(item.status))
    $('tasks').replaceChildren()
    const labels = { queued: '排队中', running: '运行中', succeeded: '完成', failed: '失败', cancelled: '已取消', canceled: '已取消', interrupted: '已中断', attention_required: '需要核对' }
    const stages = { scan: '扫描目录', delete: '清理', before_delete: '核对删除范围', stopped: '停止', completed: '完成' }
    const kinds = { preview: '手动运行规则 · 仅预览', scheduled: '定时', manual: '手动运行规则' }
    const count = value => Number.isFinite(value) ? String(value) : '—'
    for (const item of queueItems) {
      const result = item.result, row = node('tr'), task = node('td', '', item.rule_name)
      task.append(node('p', 'help', '#' + item.number + ' · ' + (kinds[item.kind] || item.kind)))
      task.title = item.created_at ? beijingTime(new Date(item.created_at).getTime()) : ''
      const status = node('td'); status.append(node('span', 'badge ' + (item.status === 'succeeded' ? 'ok' : ''), labels[item.status] || item.status))
      const message = item.error || (item.status === 'succeeded' ? '—' : item.message || '—')
      row.append(task, status, node('td', '', count(result.scanned_files)),
        node('td', '', count(result.planned_files) + ' / ' + count(result.planned_dirs)),
        node('td', '', count(result.removed_files) + ' / ' + count(result.removed_dirs)),
        node('td', '', item.status === 'succeeded' ? '完成' : stages[item.stage] || labels[item.status] || '—'), node('td', '', String(message)))
      const actions = node('td'), detail = node('button', 'compact', '详情')
      detail.onclick = guard(detail, async () => {
        const modal = dialog(app, '清理任务详情', true), close = node('button', '', '关闭')
        modal.body.append(node('p', '', item.rule_name + ' · ' + (labels[item.status] || item.status)), node('p', 'help', String(message)))
        if (item.source_path) modal.body.append(node('p', 'help', item.source_path))
        modal.body.append(node('p', '', '扫描文件：' + count(result.scanned_files) + '；扫描文件夹：' + count(result.scanned_dirs)),
          node('p', '', '预计清理：' + count(result.planned_files) + ' 文件 / ' + count(result.planned_dirs) + ' 文件夹'),
          node('p', '', '已清理：' + count(result.removed_files) + ' 文件 / ' + count(result.removed_dirs) + ' 文件夹'))
        modal.footer.append(close); close.onclick = () => modal.close()
      })
      task.classList.add('cleanup-task-name'); detail.classList.add('cleanup-task-detail')
      detail.textContent = item.rule_name
      task.firstChild.remove(); task.prepend(detail)
      if (['queued', 'running'].includes(item.status)) {
        const cancel = node('button', 'compact danger', '取消')
        cancel.onclick = guard(cancel, async () => {
          await ctx.api.post(`/api/extensions/v3/${ctx.id}/runs/${encodeURIComponent(item.run_id)}/cancel`, {})
          await poll()
        }); actions.append(cancel)
      } else {
        const remove = node('button', 'cleanup-remove danger'); remove.setAttribute('aria-label', '删除任务记录 ' + item.rule_name); remove.title = '删除记录'
        remove.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6"/></svg>'
        remove.onclick = () => confirmRemoveRecords([item.id]); actions.append(remove)
      }
      row.append(actions); $('tasks').append(row)
    }
    if (!queueItems.length) { const row = node('tr'), cell = node('td', 'empty', '暂无清理任务'); cell.colSpan = 8; row.append(cell); $('tasks').append(row) }
  }
  function confirmRemoveRecords(ids) {
    if (!ids.length) return
    const modal = dialog(app, '删除任务记录'), cancel = node('button', '', '取消'), confirm = node('button', 'danger', '确认删除')
    modal.body.append(node('p', '', '从插件任务列表移除这 ' + ids.length + ' 条已结束记录？网盘文件和系统任务历史不受影响。'))
    modal.footer.append(cancel, confirm); cancel.onclick = () => modal.close()
    confirm.onclick = guard(confirm, async () => {
      const hidden = await ctx.storage.get('cleanup_hidden_records') || []
      await ctx.storage.set('cleanup_hidden_records', [...new Set([...hidden, ...ids])])
      modal.close(); await poll(); feedback('任务记录已移除', 'ok')
    })
  }
  async function cleanOnce(ruleId, anchor) {
    if (active) throw new Error('已有同步或清理任务在执行，请稍后再试')
    const selected = cleanRules(await ctx.settings.get()).filter(rule => rule.enabled && (!ruleId || rule.id === ruleId))
    if (!selected.length) throw new Error('请先添加并启用清理规则')
    if (disposed) return
    inlineConfirm?.close(true)
    const modal = dialog(app, ruleId ? '确认清理' : '一次性清理', !anchor, { anchor }), cancel = node('button', '', '取消'), confirm = node('button', anchor ? 'primary' : 'danger', '确认'), error = node('span', 'status error')
    if (anchor) {
      inlineConfirm = modal
      modal.onClose = () => { inlineConfirm = null; if (!disposed) render() }
      const message = node('div', 'confirmation-message'), icon = node('span', 'confirmation-icon', '!')
      icon.setAttribute('aria-hidden', 'true')
      message.append(icon, node('span', '', cleanSummary(selected[0]) + ' 按本次扫描结果执行。确认创建清理任务？'))
      modal.body.append(message)
    } else {
      modal.body.append(node('p', 'notice', '立即依次执行以下已启用规则，按保存的条件直接删除光鸭文件及空目录。此操作不受定时开关限制。'))
      for (const rule of selected) modal.body.append(node('p', '', rule.name + ' · ' + rule.source_path), node('p', 'help', cleanSummary(rule)))
    }
    cancel.onclick = () => modal.close(); modal.footer.append(error, cancel, confirm)
    modal.position(); if (anchor) cancel.focus()
    confirm.onclick = async () => {
      confirm.disabled = true; modal.lock(true)
      try {
        if (active) throw new Error('已有同步或清理任务在执行，请稍后再试')
        await ctx.tasks.run('cloud-cleanup', 'manual-cleanup:' + randomUUID(win.crypto), {
          action: 'manual', confirmed: true, rule_ids: selected.map(rule => rule.id), rules_snapshot: selected
        })
        active = true; modal.close(true); render(); await poll(); feedback('一次性清理已提交', 'ok')
      } catch (failure) { error.textContent = failure.message; modal.lock(false); confirm.disabled = false; modal.position() }
    }
  }
  function editRule(original, once = false) {
    const rule = { ...(original || { ...newCleanRule((once ? 'once_' : '') + randomUUID(win.crypto).replace(/-/g, '')), size_mb: '', ...(once ? { empty_dirs: false } : {}) }) }
    rule.exclusions = [...rule.exclusions]; rule.types = [...rule.types]
    const modal = dialog(app, once ? '新建一次性清理任务' : original ? '编辑清理规则' : '新建清理规则', true)
    modal.panel.classList.add('clean-editor')
    modal.body.innerHTML = `<section class="clean-section"><h3>任务范围</h3>
      <label class="clean-field"><span>规则名称</span><input data-field="name" maxlength="80" placeholder="输入规则名称"></label>
      <div class="clean-field"><span>要清理的目录</span><div class="pathbox"><input data-field="source" readonly aria-label="要清理的光鸭目录" placeholder="选择光鸭网盘中的目录"><button data-action="source" aria-label="选择光鸭目录"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2 6V4h6l2 2h7v3M2 6v11h14l2-8H6l-2 8"/></svg></button></div><div class="clean-path-meta"><span class="clean-cloud-badge">光鸭云盘</span><span data-field="sourceBadge">从已登录的光鸭账号选择</span></div><p class="help">会扫描此目录及全部子目录；所选目录本身保留。</p></div></section>
      <section class="clean-section"><h3>清理内容</h3><span class="clean-caption">清理方式</span><div class="clean-modes" data-field="modes" aria-label="清理方式"></div>
      <div class="clean-field"><span data-field="typeLabel">要删除的文件（其余文件保留）</span><div class="inline clean-checks">${[['all','全部文件'],['video','视频文件'],['subtitle','字幕文件'],['audio','音频文件'],['custom','指定文件名后缀']].map(([type, label]) => `<label class="sync-option"><input type="checkbox" data-type="${type}">${label}</label>`).join('')}</div><input data-field="suffixes" placeholder="填写后缀，用逗号分隔，如 nfo,jpg,txt" aria-label="指定后缀"><p class="help">可同时选择多种类型，文件符合其中一种就算匹配。视频包含 ISO 和 M2TS；STRM 请填入指定后缀。</p></div>
      <div class="clean-condition-row"><div><strong>删除条件：文件小于指定大小</strong><p class="help">大于或等于此值不满足大小条件。</p></div><div class="clean-size-controls"><input class="clean-toggle" type="checkbox" data-field="size_enabled" aria-label="启用大小条件"><input type="number" min="0.001" step="any" data-field="size_mb" aria-label="文件大小 MB"><small>MB</small></div></div>
      <select class="clean-combine" data-field="condition" aria-label="条件组合"><option value="and">同时满足文件类型和大小</option><option value="or">满足文件类型或大小任一条件</option></select>
      <label class="clean-condition-row clean-empty-row"><div><strong>清理空目录</strong><p class="help">删除扫描时已经为空，以及本次文件清理后变空的文件夹；保留所选清理源目录。</p></div><input class="clean-toggle" type="checkbox" data-field="empty_dirs" aria-label="清理空目录"></label>
      <div class="clean-result"><span class="clean-info-icon">i</span><div><strong>这条规则实际会做什么</strong><p data-field="summary"></p></div></div></section>
      <section class="clean-section"><h3>排除与保护</h3><div class="clean-field"><span>整目录排除（目录及全部内容都不清理）</span><div class="exclusion-list" data-field="exclusions"></div><button data-action="exclude">＋ 添加排除目录</button><p class="help">优先于所有文件条件。排除目录中的视频、字幕、图片等全部保留，上级目录也不会被整目录删除。</p></div>
      <div class="clean-protection"><strong>♧ 目录保护（始终开启）</strong><p>每次删除前重新读取规则。所选源目录本身及排除目录受到保护；账号、目录或规则变化时立即停止。需要保留的整理、转存目录请加入排除列表。</p></div>
      </section>
      <section class="clean-section"><h3>通知与执行</h3><div class="clean-execution"><div><span class="clean-caption">Telegram 通知</span><label class="sync-option"><input type="checkbox" data-field="notify_start">任务开始时通知</label><label class="sync-option"><input type="checkbox" data-field="notify_end">任务结束时通知（含失败）</label><p class="help">使用宿主已配置的 Telegram 渠道。</p></div><div><label class="clean-execute-toggle"><span>启用此规则</span><input class="clean-toggle" type="checkbox" data-field="enabled"></label><label class="clean-execute-toggle"><span>加入统一定时执行</span><input class="clean-toggle" type="checkbox" data-field="scheduled"></label><p class="help">开启后允许按统一计划直接删除；手动清理确认规则后立即执行，也可先预览具体清单。</p></div></div></section>`
    const field = key => modal.body.querySelector(`[data-field="${key}"]`)
    if (once) {
      modal.body.prepend(node('p', 'notice', '这项任务只执行一次，不保存为规则。预览仅统计预计清理数量；预览后可继续使用当前配置开始清理。'))
      field('name').previousElementSibling.textContent = '任务名称（可选）'
      field('name').placeholder = '例如：清理本次下载目录'
      field('enabled').closest('.clean-execution').lastElementChild.hidden = true
    }
    const source = modal.body.querySelector('[data-action=source]'), exclude = modal.body.querySelector('[data-action=exclude]')
    for (const key of ['name', 'suffixes', 'size_mb', 'condition']) field(key).value = rule[key]
    for (const key of ['size_enabled', 'empty_dirs', 'enabled', 'scheduled', 'notify_start', 'notify_end']) field(key).checked = rule[key]
    field('source').value = rule.source_path
    field('sourceBadge').textContent = rule.source_path || '从已登录的光鸭账号选择'
    for (const input of modal.body.querySelectorAll('[data-type]')) input.checked = rule.types.includes(input.dataset.type)
    const read = () => {
      for (const key of ['name', 'suffixes', 'size_mb', 'condition']) rule[key] = field(key).value
      for (const key of ['size_enabled', 'empty_dirs', 'enabled', 'scheduled', 'notify_start', 'notify_end']) rule[key] = field(key).checked
      rule.types = [...modal.body.querySelectorAll('[data-type]:checked')].map(input => input.dataset.type)
      return rule
    }
    const refresh = () => {
      read()
      field('suffixes').hidden = !rule.types.includes('custom')
      field('size_mb').disabled = !rule.size_enabled
      field('condition').hidden = !rule.size_enabled || !rule.types.length
      field('typeLabel').textContent = rule.mode === 'remove' ? '要删除的文件（其余文件保留）' : '要保留的文件（其余文件清理）'
      field('summary').textContent = !rule.types.length && !rule.size_enabled && !rule.empty_dirs ? '请先选择文件类型、文件名后缀或大小条件，或开启清理空目录。' : cleanSummary(rule)
      exclude.disabled = !rule.source_id
    }
    for (const [value, title] of Object.entries(CLEAN_MODES)) {
      const button = node('button', 'clean-mode-card' + (rule.mode === value ? ' selected' : ''))
      const radio = node('span', 'clean-radio'), content = node('span', 'clean-mode-copy')
      const descriptions = { remove: '符合下方条件的文件删除，其余文件保留', keep: '符合下方条件的文件保留，同目录及子目录里的其余文件删除', directories: '逐级判断目录及下级内容；不含保留文件时清理该子目录' }
      content.append(node('strong', '', title), node('small', '', descriptions[value])); button.append(radio, content)
      button.setAttribute('aria-pressed', String(rule.mode === value))
      button.onclick = () => { rule.mode = value; for (const control of field('modes').children) { const selected = control === button; control.classList.toggle('selected', selected); control.setAttribute('aria-pressed', String(selected)) }; refresh() }
      field('modes').append(button)
    }
    function renderExclusions() {
      field('exclusions').replaceChildren()
      for (const path of rule.exclusions) {
        const chip = node('span', 'chip', path), remove = node('button', '', '×'); remove.setAttribute('aria-label', '取消排除 ' + path)
        remove.onclick = () => { rule.exclusions = rule.exclusions.filter(item => item !== path); renderExclusions() }; chip.append(remove); field('exclusions').append(chip)
      }
    }
    source.onclick = guard(source, async () => {
      const selected = await pickDirectory(app, ctx, { title: '选择光鸭清理目录', require_child: true })
      if (!selected || modal.closed) return
      rule.source_id = selected.id; rule.source_path = selected.path; rule.exclusions = []
      field('source').value = selected.path; field('sourceBadge').textContent = selected.path; renderExclusions(); refresh()
    })
    exclude.onclick = guard(exclude, async () => {
      if (!rule.source_id) throw new Error('请先选择清理目录')
      const selected = await pickDirectory(app, ctx, { title: '排除此目录及全部内容', root_id: rule.source_id, root_label: rule.source_path, require_child: true })
      if (!selected || modal.closed) return
      const path = rule.source_path + selected.path
      if (!rule.exclusions.includes(path)) rule.exclusions.push(path)
      renderExclusions()
    })
    modal.body.oninput = refresh; modal.body.onchange = refresh
    const error = node('span', 'status error'), actions = node('div', 'actions'), cancel = node('button', '', '取消'), save = node('button', once ? 'danger' : 'primary', once ? '▷ 开始清理' : '保存规则')
    let formBusy = false
    actions.append(cancel)
    if (once) {
      const preview = node('button', '', '预览结果')
      preview.onclick = async () => {
        if (formBusy) return
        formBusy = true; preview.disabled = true; save.disabled = true; modal.lock(true)
        try {
          if (active) throw new Error('已有同步或清理任务在执行，请稍后再试')
          const draft = read(), normalized = validateCleanRule({ ...draft, name: draft.name.trim() || '一次性清理', enabled: true, scheduled: false })
          await ctx.tasks.run('cloud-cleanup', 'once-preview:' + randomUUID(win.crypto), { action: 'once-preview', one_time_rule: normalized })
          active = true; render(); await poll()
          error.textContent = ''; feedback('一次性预览已提交，请在任务队列查看结果；当前配置可继续用于清理', 'ok')
        } catch (failure) { error.textContent = failure.message }
        finally { formBusy = false; preview.disabled = false; save.disabled = false; modal.lock(false) }
      }
      actions.append(preview)
    }
    actions.append(save); modal.footer.append(error, actions); cancel.onclick = () => modal.close()
    save.onclick = async () => {
      if (formBusy) return
      formBusy = true; save.disabled = true; modal.lock(true)
      try {
        if (once) {
          if (active) throw new Error('已有同步或清理任务在执行，请稍后再试')
          const draft = read(), normalized = validateCleanRule({ ...draft, name: draft.name.trim() || '一次性清理', enabled: true, scheduled: false })
          const confirmation = dialog(app, '确认一次性清理', false, { anchor: save })
          const back = node('button', '', '取消'), confirm = node('button', 'primary', '确认清理'), failureText = node('span', 'status error')
          confirmation.body.append(node('p', '', normalized.source_path + '：' + cleanSummary(normalized) + ' 确认创建清理任务？'))
          confirmation.footer.append(failureText, back, confirm); confirmation.position(); back.focus()
          back.onclick = () => confirmation.close()
          confirmation.onClose = () => { formBusy = false; modal.lock(false); save.disabled = false }
          confirm.onclick = async () => {
            confirm.disabled = true; confirmation.lock(true)
            try {
              if (active) throw new Error('已有同步或清理任务在执行，请稍后再试')
              await ctx.tasks.run('cloud-cleanup', 'once-clean:' + randomUUID(win.crypto), { action: 'once-clean', confirmed: true, one_time_rule: normalized })
              active = true; confirmation.close(true); modal.close(true); render(); await poll(); feedback('一次性清理已提交', 'ok')
            } catch (failure) { failureText.textContent = failure.message; confirmation.lock(false); confirm.disabled = false; confirmation.position() }
          }
          return
        }
        const normalized = validateCleanRule(read()), current = cleanRules(await ctx.settings.get())
        normalized.updated_at = new Date().toISOString()
        await persist(current.some(item => item.id === normalized.id) ? current.map(item => item.id === normalized.id ? normalized : item) : [...current, normalized])
        modal.close(true); feedback('清理规则已保存', 'ok')
      } catch (failure) { error.textContent = failure.message; formBusy = false; modal.lock(false); save.disabled = false }
    }
    renderExclusions(); refresh(); field('name').focus()
  }
  async function submitPreview(rule) {
    if (active) throw new Error('已有同步或清理任务在执行，请稍后再试')
    const key = randomUUID(win.crypto)
    const response = await ctx.tasks.run('cloud-cleanup', 'cloud-preview:' + key, { action: 'preview', rule_id: rule.id })
    waiting = { rule_id: rule.id, business_key: 'cloud-preview:' + key, run_id: response?.run_id || response?.id, since: Date.now() - 5000 }
    active = true; render(); feedback('正在生成清理预览，请在系统任务队列查看扫描进度', 'ok')
  }
  async function review(plan) {
    if (disposed) return
    const modal = dialog(app, '确认光鸭清理范围', true), summary = node('div', 'notice'), list = node('div', 'cleanup-list')
    summary.textContent = `${plan.rule_name} · ${plan.root}；扫描 ${plan.scanned} 项，待删除 ${plan.candidates.length} 项。清单 10 分钟内有效，执行前重新核对目录。`
    for (const item of plan.candidates) list.append(node('p', '', (item.dir ? '空目录 · ' : '文件 · ') + item.path))
    if (!plan.candidates.length) list.append(node('p', '', '没有符合条件的清理项目。'))
    const label = node('label', 'sync-option'), checkbox = node('input'); checkbox.type = 'checkbox'
    label.append(checkbox, node('span', '', '我已核对清单，确认删除以上光鸭云端内容'))
    modal.body.append(summary, list, label)
    const error = node('span', 'status error'), cancel = node('button', '', '取消'), confirm = node('button', 'danger', '确认清理 ' + plan.candidates.length + ' 项')
    confirm.disabled = true; checkbox.onchange = () => { confirm.disabled = !checkbox.checked || !plan.candidates.length }
    modal.footer.append(error, cancel, confirm); cancel.onclick = () => modal.close()
    confirm.onclick = async () => {
      confirm.disabled = true; modal.lock(true)
      try {
        if (Date.now() - plan.created_at > 600000 || plan.used) throw new Error('清单已过期或已执行，请重新预览')
        await ctx.tasks.run('cloud-cleanup', 'cloud-commit:' + plan.id, { action: 'commit', rule_id: plan.rule_id, plan_id: plan.id, confirmed: true })
        active = true; render(); modal.close(true); feedback('清理已提交，请在系统任务队列查看结果', 'ok')
      } catch (failure) { error.textContent = failure.message; modal.lock(false); confirm.disabled = !checkbox.checked }
    }
  }
  async function poll() {
    if (loading || disposed) return
    loading = true
    try {
      const response = await ctx.api.get(`/api/extensions/v3/${ctx.id}/runs?limit=200`)
      const runs = Array.isArray(response) ? response : response?.items
      if (!Array.isArray(runs)) throw new Error('无法读取任务状态，请刷新重试')
      if (disposed) return
      active = runs.some(run => ['sync', 'cloud-cleanup'].includes(run.job_id) && ['queued', 'running', 'attention_required'].includes(run.status))
      const records = await ctx.storage.get('cleanup_queue') || [], hidden = await ctx.storage.get('cleanup_hidden_records') || []
      if (disposed) return
      render(); await renderTasks(runs, records, hidden)
      if (waiting) {
        const run = runs.find(run => run.job_id === 'cloud-cleanup' && (waiting.run_id && String(run.id) === String(waiting.run_id) || run.business_key === waiting.business_key))
        if (run?.status === 'succeeded') {
          const pending = waiting; waiting = null
          const plan = await ctx.storage.get('cloud_cleanup_plan:' + pending.rule_id)
          if (!plan || plan.id !== run.result?.cleanup_plan) throw new Error('清理预览已替换，请重新预览')
          await review(plan)
        } else if (run && ['failed', 'cancelled', 'canceled', 'interrupted', 'attention_required'].includes(run.status) || Date.now() - waiting.since > 15 * 60000) { waiting = null; feedback('预览未完成，请在系统任务队列查看原因', 'error') }
      }
    } finally { loading = false }
  }
  async function refresh() {
    const settings = await ctx.settings.get()
    if (disposed) return
    rules = cleanRules(settings); $('scheduleOn').checked = settings.cleanup_schedule_enabled === true
    $('cron').value = settings.cleanup_cron || '0 3 * * *'; updateNext(); render(); await poll()
  }
  $('clearAll').onclick = () => confirmRemoveRecords(queueItems.filter(item => !['queued', 'running', 'attention_required'].includes(item.status)).map(item => item.id))
  $('once').onclick = () => editRule(null, true)
  $('add').onclick = () => editRule(null)
  $('refresh').onclick = guard($('refresh'), refresh)
  $('cron').oninput = updateNext; $('scheduleOn').onchange = updateNext
  $('saveSchedule').onclick = guard($('saveSchedule'), async () => {
    const cron = cleanupCron($('cron').value), settings = await ctx.settings.get()
    await ctx.settings.set({ ...settings, cleanup_cron: cron, cleanup_schedule_enabled: $('scheduleOn').checked })
    updateNext(); feedback('统一清理时间已保存', 'ok')
  })
  async function tick() { try { if (!doc.hidden && (waiting || !panel.hidden)) await poll() } catch (error) { if (!disposed) feedback(error.message, 'error') } finally { if (!disposed) timer = win.setTimeout(tick, active || waiting ? 2500 : 15000) } }
  refresh().catch(error => { if (!disposed) feedback(error.message, 'error') })
  timer = win.setTimeout(tick, 3000)
  return () => { disposed = true; win.clearTimeout(timer); inlineConfirm?.close(true) }
}
