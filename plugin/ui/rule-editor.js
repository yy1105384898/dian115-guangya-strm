import { mountedCloud } from './shared/clouds.js'
import { dialog, element } from './dialog.js'
import { pickDirectory } from './picker.js'
import { newRule, validateRule, INCREMENTAL_OPTIONS, FULL_OPTIONS, scheduleExpression } from './shared/rules.js'
import { extensionTags } from './extension-tags.js'
import { ruleExtensions, sourcePaths, VIDEO_EXTENSIONS, MUSIC_EXTENSIONS } from './shared/rules.js'
import { nextTimes, beijingTime } from './shared/schedule.js'

export function editRule(app, ctx, initial, onSave, defaultServiceURL = '') {
  const doc = app.ownerDocument, modal = dialog(app, initial ? '编辑规则' : '新增规则', true)
  const node = (tag, cls, text) => element(doc, tag, cls, text)
  const uuid = () => Array.from(doc.defaultView.crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join('')
  const draft = { ...newRule(uuid()), ...initial, excluded_paths: [...(initial?.excluded_paths || [])] }
  draft.service_url = draft.service_url || defaultServiceURL || doc.defaultView.location.origin
  if (draft.metadata_mode === 'local') draft.metadata_mode = 'off'
  modal.body.innerHTML = `
    <div class="form-section"><span>基本设置</span></div>
    <div class="field"><label class="label" for="gy-rule-name">规则名称 *</label><input id="gy-rule-name" data-field="name" placeholder="例如 光鸭电影同步"></div>
    <div class="field"><label class="label" for="gy-rule-cloud">云盘名称</label><input id="gy-rule-cloud" data-field="cloud_name" readonly placeholder="自动读取 CD2 网盘名称"></div>
    <div class="field"><label class="label">源路径 *</label><div><div class="pathbox"><input data-id="source" readonly aria-label="源路径"><button data-id="sourcePick" aria-label="选择源路径"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></button></div><div class="source-detail" data-id="sourceDetail"></div></div></div>
    <div class="field"><label class="label">输出路径 *</label><div><div class="pathbox"><input data-field="output_path" aria-label="输出路径" placeholder="例如 /media/strm/光鸭电影"><button data-id="outputPick" aria-label="选择本地输出路径"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg></button></div><p class="help">本地输出目录，不同规则使用独立子目录。</p></div></div>
    <div class="field"><label class="label">生成模式</label><div><select data-field="link_mode" aria-label="生成模式"><option value="path">CD2路径模式（默认）</option><option value="link">链接模式（无需CD2）</option></select><p class="help" data-id="generationHelp"></p></div></div>
    <div class="field" data-id="serviceAddress"><label class="label" for="gy-service-url">服务地址</label><div><input id="gy-service-url" data-field="service_url" type="url" aria-label="服务地址" placeholder="请填写 dian115 的内网地址"><p class="help">填写 Emby 可访问的 DIAN-115 地址，例如 http://192.168.10.5:8095。</p></div></div>
    <div class="form-section"><span>同步策略</span></div>
    <div class="field"><span class="label">启用</span><label class="switch"><input type="checkbox" data-field="enabled"><span>启用此规则</span></label></div>
    <div class="field"><span class="label">生成 STRM</span><div><label class="switch"><input type="checkbox" data-field="generate_strm"><span>生成本地 STRM 文件</span></label><p class="help">关闭后仅扫描并更新目录统计。</p></div></div>
    <div class="field"><span class="label">同步模式</span><div><div class="sync-options"><label class="sync-option"><input type="checkbox" data-field="schedule_enabled"><span>定时同步</span></label><label class="sync-option"><input type="checkbox" data-field="organize_enabled"><span>实时监控</span></label></div><p class="help">不勾选任何选项为手动模式</p><div class="monitor-hint" data-id="monitorNotice"><span class="hint-icon" aria-hidden="true">i</span><span>监听 DIAN115 整理完成事件，读取成功记录的目标路径，触发对应目录增量同步。<br><small>每分钟补查整理成功记录；不监听网盘变化。</small></span></div></div></div>
    <div class="field"><label class="label">增量同步频率</label><div><select data-field="incremental_minutes" aria-label="增量同步频率"></select><p class="help" data-id="legacyNotice" hidden>沿用旧版增量 cron，修改频率后使用当前预设。</p></div></div>
    <div class="field"><label class="label">全量同步频率</label><select data-field="full_minutes" aria-label="全量同步频率"></select></div>
    <div class="form-section"><span>文件与元数据</span></div>
    <div class="field"><span class="label">文件后缀</span><div data-id="mediaTags"></div></div>
    <details class="advanced-options"><summary>高级选项<span class="advanced-caption">排除目录 · 元数据</span></summary><div class="field"><span class="label">排除目录</span><div><div data-id="exclusions" class="exclusion-list"></div><button data-id="excludePick">＋ 选择排除目录</button><p class="help">仅选择源目录下的子目录，连同其子树一起跳过。</p></div></div><div class="field"><span class="label">元数据后缀</span><div data-id="metadataTags"></div></div><div class="field"><label class="label">元数据同步</label><div><select data-field="metadata_mode" aria-label="元数据同步"><option value="off">不启用</option><option value="cloud">云端覆盖（直接覆盖本地）</option></select><p class="help">下载源目录中的 NFO、图片和字幕，单文件最大 64 MiB。</p></div></div></details>
    <div class="schedule-summary" data-id="next" role="status"></div>`
  const $ = id => modal.body.querySelector(`[data-id="${id}"]`)
  const fields = Object.fromEntries([...modal.body.querySelectorAll('[data-field]')].map(n => [n.dataset.field, n]))
  for (const [field, options] of [['incremental_minutes', INCREMENTAL_OPTIONS], ['full_minutes', FULL_OPTIONS]]) for (const [value, label] of options) { const option = node('option', '', label); option.value = value; fields[field].append(option) }
  for (const [key, input] of Object.entries(fields)) { if (input.type === 'checkbox') input.checked = !!draft[key]; else input.value = draft[key] ?? '' }
  const mediaTags = extensionTags($('mediaTags'), ruleExtensions(draft), [{label:'🎬 视频',extensions:VIDEO_EXTENSIONS},{label:'♫ 音乐',extensions:MUSIC_EXTENSIONS}])
  const metadataTags = extensionTags($('metadataTags'), draft.metadata_extensions)
  const getDraft = () => ({ ...draft, file_extensions: mediaTags.getValue(), metadata_extensions: metadataTags.getValue(), ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : ['incremental_minutes', 'full_minutes'].includes(key) ? Number(input.value) : input.value.trim()])) })
  const updateSource = () => {
    const paths = sourcePaths({ ...draft, source_mode: draft.source_mode, source_cd2_root: draft.source_cd2_root, cloud_name: fields.cloud_name.value })
    $('source').value = paths.relative
    $('sourceDetail').textContent = fields.cloud_name.value ? 'CD2路径：' + paths.cd2 : 'CD2路径：未找到已挂载的光鸭网盘'
    $('sourceDetail').title = 'CD2 虚拟路径；生成 STRM 时自动添加宿主挂载前缀'
  }
  const exclusions = () => {
    $('exclusions').replaceChildren()
    for (const path of draft.excluded_paths) {
      const item = node('span', 'chip'), remove = node('button', '', '×'); remove.setAttribute('aria-label', '取消排除 ' + path)
      remove.onclick = () => { draft.excluded_paths = draft.excluded_paths.filter(value => value !== path); exclusions() }
      item.append(node('span', '', path), remove); $('exclusions').append(item)
    }
  }
  function preview() {
    const value = getDraft()
    $('monitorNotice').hidden = !value.organize_enabled
    $('legacyNotice').hidden = !value.legacy_cron
    fields.incremental_minutes.disabled = !value.schedule_enabled
    fields.full_minutes.disabled = !value.schedule_enabled
    $('serviceAddress').hidden = value.link_mode !== 'link'
    $('generationHelp').textContent = value.link_mode === 'path' ? '使用完整 CD2 挂载路径生成 STRM。' : '通过插件获取播放直链，无需 CD2。'
    if (!value.enabled) { $('next').textContent = '规则已禁用，不会自动同步。'; return }
    try {
      const expression = value.schedule_enabled ? scheduleExpression(value,true) : ''
      const full = expression ? nextTimes(expression,Date.now(),1)[0] : null
      const inc = value.schedule_enabled ? nextTimes(scheduleExpression(value),Date.now(),1)[0] : null
      $('next').textContent = !value.schedule_enabled && !value.organize_enabled ? '手动模式：保存后可从规则列表执行同步。' : '北京时间 · 下次定时同步\n增量：' + (inc ? beijingTime(inc) : '不启用') + '   ·   全量：' + (full ? beijingTime(full) : '不启用')
    } catch(error) { $('next').textContent = error.message }
  }
  fields.incremental_minutes.onchange = () => { draft.legacy_cron = ''; preview() }
  for (const input of Object.values(fields)) input.addEventListener('change', preview)
  async function pick(button, options, accept) { button.disabled = true; try { const result = await pickDirectory(app, ctx, options); if (result && !modal.closed) accept(result) } finally { if (!modal.closed) button.disabled = false } }
  function selectBackup() {
    return pick($('sourcePick'), { backend:'cd2', path:draft.source_cd2_path || '/', title:'CD2 备用选择源目录' }, result => {
      draft.source_mode = 'cd2'; draft.source_cd2_path = result.path; draft.source_parent_id = ''
      draft.source_cd2_root = '/' + result.path.split('/').filter(Boolean)[0]
      draft.cloud_name = draft.source_cd2_root; fields.cloud_name.value = draft.cloud_name
      draft.excluded_paths = []; exclusions(); updateSource()
    })
  }
  $('sourcePick').onclick = async () => {
    $('sourcePick').disabled = true
    try {
      const result = await pickDirectory(app, ctx, { backend:'cloud', title:'选择光鸭源目录', allow_cd2_fallback:true })
      if (modal.closed || !result) return
      if (result.cd2_fallback) { await selectBackup(); return }
      draft.source_mode = 'direct'; draft.source_parent_id = result.id; draft.source_display_path = result.path
      draft.source_cd2_path = ''; draft.excluded_paths = []; exclusions(); updateSource()
    } catch (failure) { error.textContent = failure.message || '读取目录失败' }
    finally { if (!modal.closed) $('sourcePick').disabled = false }
  }
  $('outputPick').onclick = () => pick($('outputPick'), { backend: 'local', path: fields.output_path.value || '/', title: '选择本地输出目录' }, result => { fields.output_path.value = result.path })
  $('excludePick').onclick = () => {
    const cd2 = draft.source_mode === 'cd2'
    if (cd2 && !draft.source_cd2_path) { error.textContent = '请先选择源目录'; return }
    pick($('excludePick'), { backend: cd2 ? 'cd2' : 'cloud', root_id: draft.source_parent_id, root_label: '源目录', path: draft.source_cd2_path, boundary: draft.source_cd2_path, require_child: true, title: '选择要排除的子目录' }, result => {
      const path = cd2 ? result.path.slice(draft.source_cd2_path.replace(/\/+$/, '').length + 1) : result.path.slice(1)
      if (path && !draft.excluded_paths.includes(path)) draft.excluded_paths.push(path)
      exclusions()
    })
  }
  const error = node('span', 'status error'), actions = node('div', 'actions'), cancel = node('button', '', '取消'), save = node('button', 'primary', '保存')
  error.setAttribute('role', 'status'); actions.append(cancel, save); modal.footer.append(error, actions)
  cancel.onclick = () => modal.close()
  save.onclick = async () => {
    save.disabled = true; cancel.disabled = true; modal.lock(true); error.textContent = ''
    try {
      if (fields.link_mode.value === 'path' && !fields.cloud_name.value) throw new Error('未读取到 CD2 光鸭挂载名称，请稍后重开窗口或选择链接模式')
      if (fields.link_mode.value === 'link') {
        let url
        try { url = new URL(fields.service_url.value.trim()) } catch { throw new Error('请输入有效的 DIAN-115 服务地址') }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址须为 HTTP 或 HTTPS 地址，不能包含账号、密码、查询参数或锚点')
        fields.service_url.value = url.href.replace(/\/+$/, '')
      }
      const value = validateRule(getDraft()); await onSave(value); modal.close(true)
    }
    catch (failure) { error.textContent = failure.message || '保存失败'; save.disabled = false; cancel.disabled = false; modal.lock(false) }
  }
  async function loadCloudName() {
    save.disabled = true
    try {
      const cloud = await mountedCloud(ctx,draft)
      if (modal.closed) return
      draft.cloud_name = cloud; draft.source_cd2_root = cloud; fields.cloud_name.value = cloud
      updateSource()
    } catch(failure) {
      if (modal.closed) return
      fields.cloud_name.value = ''; draft.cloud_name = ''; draft.source_cd2_root = ''
      error.textContent = failure.message; updateSource()
    } finally { if (!modal.closed) save.disabled = false }
  }
  fields.cloud_name.value = ''; updateSource(); exclusions(); preview(); fields.name.focus()
  loadCloudName()
  return modal
}
