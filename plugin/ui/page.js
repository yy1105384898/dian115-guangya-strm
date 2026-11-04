import { mountedRule } from './shared/clouds.js'
import { randomUUID } from './shared/uuid.js'
import { styles } from './styles.js'
import { element, dialog, closeDialogs } from './dialog.js'
import { editRule } from './rule-editor.js'
import { getRules, validateRule, sourcePaths } from './shared/rules.js'
import { beijingTime } from './shared/schedule.js'
import { mountCleaner } from './cleaner.js'
import { mountSyncLog } from './sync-log.js'

export async function mount(root, ctx) {
  const doc = root.ownerDocument, win = doc.defaultView, node = (tag, cls, text) => element(doc, tag, cls, text)
  const app = node('section', 'gy'), style = node('style'); style.textContent = styles; app.append(style)
  const shell = node('div')
  shell.innerHTML = `
    <header class="top"><div class="brand"><div class="logo" aria-hidden="true">▱</div><div><h2>光鸭 STRM <span class="version">v1.0.1</span></h2><small>网盘目录同步 · 文件清理</small></div></div><span class="badge" data-id="loginBadge">读取登录状态…</span></header>
    <div class="tabs" role="tablist" aria-label="光鸭插件"><button data-tab="settings" role="tab" class="active" aria-selected="true"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10M2 4l1 1 2-2M2 9l1 1 2-2M2 14l1 1 2-2"/></svg>STRM 同步</button><button data-tab="cleaner" role="tab" aria-selected="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8 8v6M12 8v6"/></svg>文件清理</button><button data-tab="login" role="tab" aria-selected="false"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6" r="3"/><path d="M4 17v-2a6 6 0 0 1 12 0v2"/></svg>账号登录</button></div>
    <section data-page="settings" role="tabpanel"><div class="toolbar"><span class="badge">源路径 · 输出目录 · 同步规则</span><div class="actions"><button class="primary" data-id="addRule">＋ 新增规则</button><button data-id="refresh">↻ 刷新</button></div></div>
    <div class="rule-stats"><div><small>全部</small><strong data-id="total">0</strong></div><div><small>启用</small><strong data-id="enabled">0</strong></div><div><small>已扫描</small><strong data-id="indexed">0</strong></div><div><small>生成 STRM</small><strong data-id="generated">0</strong></div></div>
    <div class="searchbar"><input data-id="search" aria-label="搜索同步规则" placeholder="搜索规则名称 / 源路径 / 输出目录"><select data-id="filter" aria-label="规则状态"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已禁用</option></select><small data-id="count"></small></div>
    <div class="card"><div class="table-wrap"><table class="rules-table"><thead><tr><th>规则名称</th><th>源路径</th><th>输出路径</th><th>模式</th><th>状态</th><th>生成 STRM</th><th>同步方式</th><th>元数据</th><th>目录树</th><th>最后成功同步</th><th>操作</th></tr></thead><tbody data-id="rules"></tbody></table></div><div data-id="empty" class="empty" hidden>还没有同步规则。点击右上角“新增规则”开始。</div></div>
    <div class="card" data-id="syncLog" style="margin-top:20px"></div></section>
    <section data-page="cleaner" role="tabpanel" hidden></section>
    <section data-page="login" role="tabpanel" hidden><div class="page-head"><h2>光鸭账号登录</h2><p class="muted">登录信息加密保存。同步与文件清理共用此账号。</p></div><div class="card"><div class="card-head"><h3>登录凭证</h3><span class="badge" data-id="accountState">未登录</span></div><div class="card-body"><div class="account-line"><strong data-id="accountTitle">尚未登录</strong><p class="help" data-id="accountDetail">使用手机号接收验证码后登录。</p></div>
    <div class="field"><label class="label" for="gy-phone">手机号</label><input id="gy-phone" data-id="phone" type="tel" autocomplete="tel" placeholder="手机号，默认 +86"></div>
    <div class="field"><label class="label" for="gy-code">短信验证码</label><div class="inline"><input id="gy-code" data-id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="输入短信验证码"><button data-id="send">发送验证码</button><button class="primary" data-id="login">验证并登录</button></div></div>
    <div class="field"><span class="label">登录状态</span><div class="inline"><button data-id="tokenRefresh">刷新登录</button><button data-id="check">检查连接</button><small data-id="connection"></small></div></div>
    <div class="notice" data-id="captchaArea" hidden><p>光鸭要求人机验证。<a data-id="captchaLink" target="_blank" rel="noopener noreferrer">打开验证页面</a></p><input data-id="captchaToken" type="password" aria-label="人机验证令牌" placeholder="填写完成验证后取得的 captcha_token，再发送验证码" style="margin-top:8px"></div>
    <details style="margin-top:18px"><summary>手动导入凭证</summary><p class="help">短信登录不可用时使用；保存后替换当前账号凭证。</p><div class="field"><label class="label">Access Token</label><input data-id="access" type="password" autocomplete="off" aria-label="Access Token"></div><div class="field"><label class="label">Refresh Token</label><input data-id="refreshToken" type="password" autocomplete="off" aria-label="Refresh Token"></div><div class="field"><label class="label">设备 ID</label><input data-id="device" aria-label="设备 ID" placeholder="可留空"></div><button data-id="importToken">保存登录凭证</button></details>
    </div></div></section>
    <div class="feedback-line" data-id="feedback" role="status" aria-live="polite">正在载入配置…</div>`
  app.append(shell); root.append(app)
  const $ = id => shell.querySelector(`[data-id="${id}"]`)
  const syncLog = mountSyncLog($('syncLog'), app, ctx, (...args) => feedback(...args))
  let settings = {}, rules = [], summaries = {}, monitorStatus = {}, libraryInfo = {}, disposed = false, pollTimer, cooldownTimer, cooldownUntil = 0, mutationBusy = false, activeTask = false, initialAccountChecked = false, pendingCleanupSince = 0
  const feedback = (message, kind = '') => { $('feedback').textContent = message; $('feedback').className = 'feedback-line status ' + kind }
  const random = () => Array.from(win.crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')
  const hook = async (path, body = {}) => { const response = await ctx.api.post(`/api/extensions/v3/${ctx.id}/hook/${path}`, body); if (response?.error) throw new Error(response.error); return response }
  async function action(button, operation) { if (button.disabled) return; button.disabled = true; try { await operation() } catch (error) { if (!disposed) feedback(error.message || '操作失败，请重试', 'error') } finally { if (!disposed) button.disabled = false } }
  const tabs = [...shell.querySelectorAll('[data-tab]')], tabPrefix = 'gy-' + randomUUID(win.crypto)
  for (const button of tabs) {
    const page = shell.querySelector(`[data-page="${button.dataset.tab}"]`)
    button.id = tabPrefix + '-' + button.dataset.tab; page.id = button.id + '-panel'
    button.setAttribute('aria-controls', page.id); page.setAttribute('aria-labelledby', button.id)
    button.tabIndex = button.classList.contains('active') ? 0 : -1
    button.onclick = () => { shell.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.dataset.page !== button.dataset.tab }); tabs.forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1 }) }
    button.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = tabs.indexOf(button), next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
      next.click(); next.focus()
    }
  }
  const disposeCleaner = mountCleaner(app, shell.querySelector('[data-page=cleaner]'), ctx, feedback)
  async function persist(nextRules) {
    if (mutationBusy) throw new Error('正在保存，请稍后再试')
    mutationBusy = true
    try {
      const current = await ctx.settings.get()
      const updated = { ...current, rules: nextRules, public_base_url: current.public_base_url || win.location.origin, play_token: current.play_token || random() }
      const url = new URL(updated.public_base_url)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('请通过 NAS 的 DIAN-115 地址打开插件后保存')
      await ctx.settings.set(updated); settings = updated; rules = getRules(updated); renderRules()
      try { await ctx.tasks.run('scheduler', 'monitor-config:' + random(), { reconcile: true }) }
      catch { /* Periodic scheduler reconciles the persisted settings on its next tick. */ }
    } finally { mutationBusy = false }
  }
  const badge = (text, kind = '') => node('span', 'badge ' + kind, text)
  function renderRules() {
    $('total').textContent = rules.length
    $('enabled').textContent = rules.filter(rule => rule.enabled).length
    $('indexed').textContent = rules.filter(rule => summaries[rule.id]).length
    $('generated').textContent = rules.filter(rule => summaries[rule.id]?.generate_strm !== false && (summaries[rule.id]?.generated > 0 || summaries[rule.id]?.unchanged > 0)).length
    const term = $('search').value.toLowerCase(), filter = $('filter').value
    const visible = rules.filter(rule => (filter === 'all' || !!rule.enabled === (filter === 'enabled')) && [rule.name, rule.output_path, rule.source_display_path, rule.source_cd2_path].join(' ').toLowerCase().includes(term))
    $('count').textContent = `${visible.length} / ${rules.length}`
    $('rules').replaceChildren(); $('empty').hidden = visible.length > 0
    $('empty').textContent = rules.length ? '没有匹配的规则。' : '还没有同步规则。点击右上角“新增规则”开始。'
    for (const rule of visible) {
      const row = node('tr'), summary = summaries[rule.id]
      const monitor = monitorStatus[rule.id], mode = badge([rule.schedule_enabled ? '定时' : '', rule.organize_enabled !== false ? '实时' : ''].filter(Boolean).join('＋') || '手动', rule.schedule_enabled || rule.organize_enabled !== false ? 'ok' : '')
      mode.title = '实时：监听宿主整理完成事件，并补查整理成功记录，按目标目录触发增量；不监听网盘变化。'
      const source = rule.cloud_name ? sourcePaths(rule).cd2 : rule.source_display_path || '/'
      const values = [rule.name, source, rule.output_path, rule.link_mode === 'path' ? 'CD2 路径' : '链接', badge(rule.enabled ? '启用' : '禁用', rule.enabled ? 'ok' : ''), badge(rule.generate_strm ? '开启' : '关闭', rule.generate_strm ? 'ok' : ''), mode, badge(rule.metadata_mode === 'cloud' ? '云端覆盖' : rule.metadata_mode === 'local' ? '旧版保留本地' : '关闭', rule.metadata_mode !== 'off' ? 'ok' : ''), badge(summary?.tree ? `${summary.tree.directories}目录 / ${summary.tree.files}文件` : summary && !summary.scoped ? `${summary.directories}目录 / ${summary.files ?? summary.videos}文件` : '待全量统计'), summary?.at ? beijingTime(new Date(summary.at).getTime()).replace(/^\d{4}-/, '') : '—']
      for (const value of values) { const cell = node('td'); if (typeof value === 'string') { cell.textContent = value; cell.title = value } else cell.append(value); row.append(cell) }
      const actions = node('td'), buttons = node('div', 'inline'), edit = node('button', 'compact', '编辑'), sync = node('button', 'compact', '同步'), more = node('details', 'more'), menu = node('div', 'more-menu')
      const summaryButton = node('summary', '', '更多 ▾'); more.append(summaryButton, menu)
      edit.onclick = () => openEditor(rule)
      sync.disabled = activeTask; sync.onclick = () => action(sync, () => submit(rule.id, false))
      const full = node('button', '', '全量同步'), cleanup = node('button', '', '清理孤立'), toggle = node('button', '', rule.enabled ? '禁用规则' : '启用规则'), remove = node('button', 'danger', '删除规则')
      full.disabled = activeTask; full.onclick = () => action(full, async () => { more.open = false; await submit(rule.id, true) })
      toggle.onclick = () => action(toggle, async () => { const current = getRules(await ctx.settings.get()); await persist(current.map(item => item.id === rule.id ? { ...item, enabled: !item.enabled } : item)); feedback('规则状态已保存', 'ok') })
      remove.onclick = () => { more.open = false; confirmRemove(rule) }
      cleanup.disabled = activeTask; cleanup.onclick = () => action(cleanup, async () => { more.open = false; await submitCleanup(rule.id) })
      menu.append(full, cleanup, toggle, remove); buttons.append(edit, sync, more); actions.append(buttons); row.append(actions); $('rules').append(row)
    }
  }
  function openEditor(rule) {
    editRule(app, ctx, rule, async value => {
      const current = getRules(await ctx.settings.get()), normalized = validateRule(value, current)
      const next = current.some(item => item.id === value.id) ? current.map(item => item.id === value.id ? normalized : item) : [...current, normalized]
      await persist(next); feedback('规则已保存', 'ok')
    }, settings.public_base_url || win.location.origin)
  }
  function confirmRemove(rule) {
    const modal = dialog(app, '删除规则'), cancel = node('button', '', '取消'), remove = node('button', 'danger', '确认删除规则'), error = node('span', 'status error')
    modal.body.append(node('p', '', `删除规则“${rule.name}”？本地已生成的 STRM 和网盘文件会保留。`))
    modal.footer.append(error, cancel, remove); cancel.onclick = () => modal.close()
    remove.onclick = async () => { remove.disabled = true; modal.lock(true); try { await persist(getRules(await ctx.settings.get()).filter(item => item.id !== rule.id)); modal.close(true); feedback('规则已删除，本地文件已保留', 'ok') } catch (failure) { error.textContent = failure.message; remove.disabled = false; modal.lock(false) } }
  }
  async function submit(id, full) {
    if (activeTask) throw new Error('已有同步任务在执行，请稍后再试')
    await ctx.tasks.run('sync', `manual:${Date.now()}`, { rule_id: id, full })
    activeTask = true; renderRules(); feedback('同步任务已提交，请在系统任务队列查看进度', 'ok'); await loadRuns()
  }
  async function submitCleanup(ruleId) {
    if (activeTask) throw new Error('已有任务在执行，请稍后再试')
    pendingCleanupSince = Date.now() - 1000
    await ctx.tasks.run('sync', 'cleanup-preview:' + Date.now(), {action:'cleanup_preview',rule_id:ruleId})
    activeTask = true; pendingCleanupSince = Date.now() - 1000; renderRules()
    feedback('正在扫描并生成清理清单，暂不删除文件', 'ok'); await loadRuns()
  }
  async function reviewCleanup(id) {
    const plan = await ctx.storage.get('cleanup_plan:' + id)
    if (!plan) throw new Error('清理清单不存在，请重新预览')
    const modal = dialog(app, '清理孤立文件'), message = node('div', 'notice'), list = node('div', 'cleanup-list')
    const expired = plan.used || Date.now() - plan.created_at > 600000
    message.textContent = '规则：' + plan.rule_name + '；范围：' + plan.root + '；候选 ' + plan.candidates.length + ' 个文件。仅删除下列已确认属于本插件的文件，不删除目录。' + (expired ? ' 清单已过期或已执行，请重新预览。' : ' 确认前会再次扫描网盘和校验本地文件。')
    for (const candidate of plan.candidates) list.append(node('p', '', candidate.path))
    if (!plan.candidates.length) list.append(node('p', '', '没有可清理的孤立文件。'))
    modal.body.append(message, list)
    const status = node('span', 'status error'), actions = node('div', 'actions'), cancel = node('button', '', '取消'), confirm = node('button', 'danger', '确认删除 ' + plan.candidates.length + ' 个文件')
    confirm.disabled = expired || !plan.candidates.length; actions.append(cancel, confirm); modal.footer.append(status, actions)
    cancel.onclick = () => modal.close()
    confirm.onclick = async () => {
      confirm.disabled = true; modal.lock(true)
      try {
        if (activeTask) throw new Error('已有同步任务在执行，请稍后再试')
        await ctx.tasks.run('sync', 'cleanup-confirm:' + Date.now(), {action:'cleanup_commit',plan_id:id,confirmed:true})
        activeTask = true; renderRules(); modal.close(true); feedback('已提交你确认的清理任务，请在系统任务队列查看', 'ok'); await loadRuns()
      } catch (error) { status.textContent = error.message; confirm.disabled = false; modal.lock(false) }
    }
  }
  $('addRule').onclick = () => openEditor(null)
  $('search').oninput = renderRules; $('filter').onchange = renderRules
  async function accountStatus() {
    const status = await hook('auth/status')
    if (disposed) return
    if (!initialAccountChecked) { initialAccountChecked = true; if (!status.configured) shell.querySelector('[data-tab=login]').click() }
    const state = status.configured ? '凭证已保存' : '未登录光鸭'
    $('loginBadge').textContent = state; $('accountState').textContent = state
    $('accountTitle').textContent = status.phone || (status.configured ? '光鸭账号' : '尚未登录')
    $('accountDetail').textContent = status.configured ? (status.refreshable ? '已保存刷新凭证；失效时会尝试自动刷新。' : '未保存刷新凭证，失效后需重新登录。') + ' 点击“检查连接”确认可用。' : '登录后即可在设置中选择网盘源目录。'
  }
  $('send').onclick = () => action($('send'), async () => {
    const result = await hook('auth/send', { phone: $('phone').value, captcha_token: $('captchaToken').value })
    if (result.needs_verification) { $('captchaArea').hidden = false; $('captchaLink').hidden = !result.url; if (result.url) $('captchaLink').href = result.url; feedback(result.message, 'error'); return }
    cooldownUntil = Date.now() + 60000; $('send').textContent = '60 秒后重发'; feedback(result.message, 'ok')
  })
  cooldownTimer = win.setInterval(() => { if (Date.now() < cooldownUntil) { $('send').disabled = true; $('send').textContent = Math.ceil((cooldownUntil - Date.now()) / 1000) + ' 秒后重发' } else if (cooldownUntil) { cooldownUntil = 0; $('send').disabled = false; $('send').textContent = '发送验证码' } }, 1000)
  $('login').onclick = () => action($('login'), async () => { const result = await hook('auth/login', { code: $('code').value }); $('code').value = ''; $('captchaToken').value = ''; $('captchaArea').hidden = true; feedback(result.message, 'ok'); await accountStatus() })
  $('tokenRefresh').onclick = () => action($('tokenRefresh'), async () => { const result = await hook('auth/refresh'); feedback(result.message, 'ok'); await accountStatus() })
  $('check').onclick = () => action($('check'), async () => { await hook('browse', { parent_id: '' }); $('connection').textContent = '连接正常'; feedback('光鸭连接正常', 'ok') })
  $('importToken').onclick = () => action($('importToken'), async () => { await hook('auth/import', { access_token: $('access').value, refresh_token: $('refreshToken').value, device_id: $('device').value }); for (const id of ['access', 'refreshToken', 'device']) $(id).value = ''; await accountStatus(); feedback('登录凭证已保存', 'ok') })
  // Read task state only to prevent overlap and open the requested cleanup preview.
  // Task history and progress are displayed by the host task queue.
  async function loadRuns() {
    const response = await ctx.api.get(`/api/extensions/v3/${ctx.id}/runs?limit=200`)
    if (disposed) return
    const items = (Array.isArray(response) ? response : response?.items || []).filter(run => ['sync', 'cloud-cleanup'].includes(run.job_id))
    monitorStatus = await ctx.storage.get('source_monitor_status') || {}
    for (const rule of rules) libraryInfo[rule.id] = { mail: await ctx.storage.get('library_pending:' + rule.id), state: await ctx.storage.get('library_state:' + rule.id) }
    activeTask = items.some(run => ['queued','running','attention_required'].includes(run.status))
    for (const rule of rules) summaries[rule.id] = await ctx.storage.get('last_sync:' + rule.id) || (rule.id === 'legacy' ? await ctx.storage.get('last_sync') : null)
    if (disposed) return
    renderRules()
    await syncLog.update(items, rules, libraryInfo)
    if (pendingCleanupSince) {
      const preview = items.find(run => run.job_id === 'sync' && run.result?.cleanup_plan && run.status === 'succeeded' && new Date(run.created_at).getTime() >= pendingCleanupSince)
      if (preview) { pendingCleanupSince = 0; await reviewCleanup(preview.result.cleanup_plan) }
      else if (!activeTask) { pendingCleanupSince = 0; feedback('清理预览未完成，请在系统任务队列查看结果','error') }
    }
  }
  async function refresh() {
    settings = await ctx.settings.get() || {}; rules = getRules(settings)
    for (let i=0;i<rules.length;i++) {
      try { rules[i] = await mountedRule(ctx,rules[i]) } catch { /* The editor reports mount lookup failures. */ }
    }
    for (const rule of rules) summaries[rule.id] = await ctx.storage.get('last_sync:' + rule.id) || (rule.id === 'legacy' ? await ctx.storage.get('last_sync') : null)
    if (disposed) return
    renderRules(); await accountStatus(); await loadRuns()
  }
  $('refresh').onclick = () => action($('refresh'), async () => { await refresh(); feedback('状态已刷新', 'ok') })
  try { await refresh(); feedback('配置已载入') } catch (error) { feedback(error.message || '读取配置失败', 'error') }
  async function poll() { try { if (!doc.hidden) await loadRuns() } catch { /* Explicit refresh reports errors without interrupting edits. */ } finally { if (!disposed) pollTimer = win.setTimeout(poll, activeTask ? 2500 : 15000) } }
  pollTimer = win.setTimeout(poll, 3000)
  return () => { disposed = true; syncLog.dispose(); disposeCleaner(); win.clearTimeout(pollTimer); win.clearInterval(cooldownTimer); closeDialogs(app); app.remove() }
}
