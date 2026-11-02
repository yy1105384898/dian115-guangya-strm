import { dialog, element } from './dialog.js'
export function pickDirectory(app, ctx, options = {}) {
  const doc = app.ownerDocument, backend = options.backend || 'cloud'
  const node = (tag, cls, text) => element(doc, tag, cls, text)
  const modal = dialog(app, options.title || '选择目录')
  const crumbs = node('div', 'crumb'), search = node('input'), list = node('div', 'folder-list'), location = node('small'), choose = node('button', 'primary', '确认选择')
  search.placeholder = '搜索当前目录'; search.setAttribute('aria-label', '搜索当前目录'); list.setAttribute('aria-live', 'polite')
  modal.body.append(crumbs, search, list); modal.footer.append(location, choose)
  let trail = [{ id: options.root_id || '', name: options.root_label || '光鸭根目录' }], path = options.path || '/', entries = [], sequence = 0, valid = false, chosen = null
  const normalize = p => '/' + String(p).split('/').filter(Boolean).join('/')
  const boundary = options.boundary ? normalize(options.boundary) : '/'
  const render = () => {
    list.replaceChildren()
    const filtered = entries.filter(item => item.name.toLowerCase().includes(search.value.toLowerCase()))
    for (const item of filtered) {
      const button = node('button', 'folder'); button.append(node('span', '', '▱  ' + item.name), node('span', 'muted', '›'))
      button.onclick = () => { if (backend === 'cloud') trail.push(item); else path = normalize(path + '/' + item.name); load() }; list.append(button)
    }
    if (!filtered.length) list.append(node('p', 'empty', entries.length ? '没有匹配的目录' : '没有子目录，可选择当前目录'))
  }
  async function load() {
    const current = ++sequence; valid = false; choose.disabled = true; search.value = ''; list.replaceChildren(node('p', 'empty', '正在读取目录…')); crumbs.replaceChildren()
    const parts = backend === 'cloud' ? trail.map(item => item.name) : ['根目录', ...normalize(path).split('/').filter(Boolean)]
    parts.forEach((name, i) => {
      const button = node('button', '', name)
      const destination = '/' + parts.slice(1, i + 1).join('/')
      if (backend !== 'cloud' && boundary !== '/' && !(destination === boundary || destination.startsWith(boundary + '/'))) button.disabled = true
      button.onclick = () => { if (backend === 'cloud') trail = trail.slice(0, i + 1); else path = destination; load() }; crumbs.append(button)
    })
    location.textContent = backend === 'cloud' ? '/' + trail.slice(1).map(item => item.name).join('/') : path
    try {
      let response
      if (backend === 'cloud') {
        const result = await ctx.api.post(`/api/extensions/v3/${ctx.id}/hook/browse`, { parent_id: trail[trail.length - 1].id })
        if (result?.error) throw new Error(result.error)
        response = result?.items
      } else if (backend === 'cd2') response = await ctx.cd2.call('list', { path, force_refresh: true })
      else {
        const local = await ctx.api.get(`/api/local-files?path=${encodeURIComponent(path)}`)
        if (local?.backend !== 'local') throw new Error('此目录属于网盘挂载，请选择本地目录作为输出')
        response = local.entries
      }
      if (modal.closed || current !== sequence) return
      if (!Array.isArray(response)) throw new Error('目录接口返回格式不正确')
      entries = response.filter(item => item.name && !['.', '..'].includes(item.name) && (backend === 'cloud' || item.is_dir)).sort((a,b) => a.name.localeCompare(b.name, 'zh-CN'))
      valid = true; choose.disabled = backend === 'cloud' ? !!options.require_child && trail.length === 1 : path === '/' || !!options.require_child && path === boundary
      render()
    } catch (e) { if (modal.closed || current !== sequence) return; list.replaceChildren(node('p', 'errorbox', e.message || '读取目录失败')); const retry = node('button', '', '重试'); retry.onclick = load; list.append(retry); if (backend === 'cloud' && options.allow_cd2_fallback) { const fallback = node('button', '', '使用 CD2 备用选目录'); fallback.onclick = () => { chosen = { cd2_fallback:true }; modal.close() }; list.append(fallback) } }
  }
  search.oninput = () => { if (valid) render() }
  choose.onclick = () => { if (!valid) return; chosen = backend === 'cloud' ? { id: trail[trail.length - 1].id, path: location.textContent, trail } : { path: normalize(path) }; modal.close() }
  load()
  return new Promise(resolve => { modal.onClose = () => { sequence++; resolve(chosen) } })
}
