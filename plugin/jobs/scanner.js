import { request, refresh, findArray, itemId, itemName, isDirectory, escapePathPart } from './guangya.js'
const LIST_URL = 'https://api.guangyapan.com/userres/v1/file/get_file_list'

export async function listDirectory(ctx, settings, token, parentId) {
  const pageSize = Math.max(10, Math.min(200, Number(settings.page_size) || 100))
  const all = []
  const pages = new Set()
  for (let page = 0; page < 10000; page++) {
    const response = await request(ctx, settings, token, LIST_URL, {
      parentId: parentId || '', page, pageSize, orderBy: 0, sortType: 0
    })
    const items = findArray(response)
    if (!items.length) return all
    const signature = JSON.stringify(items.map(itemId))
    if (pages.has(signature)) throw new Error('光鸭分页返回重复内容，同步已停止，请检查任务日志')
    pages.add(signature)
    all.push(...items)
    const total = Number(response?.data?.total)
    if (Number.isFinite(total) && total > 0 && all.length >= total) return all
    if (!(total > 0) && items.length < pageSize) return all
  }
  throw new Error('光鸭单目录分页超过上限，同步已停止')
}

export async function resolveSource(ctx, settings, list) {
  if (settings.source_mode !== 'cd2' || !settings.source_cd2_path) return String(settings.source_parent_id || '')
  const source = String(settings.source_cd2_path).replace(/\/+$/, '')
  const root = String(settings.source_cd2_root || '/' + source.split('/').filter(Boolean)[0]).replace(/\/+$/, '')
  if (!root || root === '/' || !(source === root || source.startsWith(root + '/'))) {
    throw new Error('源目录必须位于配置的 CD2 光鸭根目录内')
  }
  const info = await ctx.cd2.call('stat', { path: source })
  if (!info || !info.is_dir) throw new Error('CD2 源目录不存在或不是目录')
  let id = ''
  for (const part of source.slice(root.length).split('/').filter(Boolean)) {
    const entries = await list(id)
    const matches = entries.filter(item => isDirectory(item) && itemName(item) === part)
    if (matches.length !== 1 || !itemId(matches[0])) throw new Error(`光鸭中无法唯一定位目录：${part}。请检查 CD2 光鸭根目录和所填账号是否一致`)
    id = itemId(matches[0])
  }
  return id
}

export async function scanRule(ctx, settings, rule) {
  const stored = await ctx.storage.get('tokens')
  let token = stored?.access_token || settings.access_token, refreshed = false
  async function list(parentId) {
    try { return await listDirectory(ctx, settings, token, parentId) }
    catch (error) {
      if (refreshed || !(stored?.refresh_token || settings.refresh_token) || !/401|unauthorized|token/i.test(error.message)) throw error
      const tokens = await refresh(ctx, settings, stored?.refresh_token || settings.refresh_token)
      token = tokens.access_token; refreshed = true; await ctx.storage.set('tokens', tokens)
      return listDirectory(ctx, settings, token, parentId)
    }
  }
  const root = await resolveSource(ctx, { ...settings, ...rule }, list)
  const stack = [{id: root, path: '', rawPath: ''}], seen = new Set(), files = []
  while (stack.length) {
    const dir = stack.pop()
    if (seen.has(dir.id)) continue
    seen.add(dir.id)
    for (const item of await list(dir.id)) {
      const id = itemId(item), name = itemName(item)
      if (!id || !name) throw new Error('光鸭列表中有条目缺少 ID 或名称，已停止以避免漏同步或误判孤立文件')
      const rawPath = dir.rawPath ? dir.rawPath + '/' + name : name
      if ((rule.excluded_paths || []).some(p => rawPath === p || rawPath.startsWith(p + '/'))) continue
      const path = dir.path ? dir.path + '/' + escapePathPart(name) : escapePathPart(name)
      if (isDirectory(item)) stack.push({id, path, rawPath})
      else files.push({ id, name, relative: path, rawPath,
        gcid: String(item.gcid ?? item.GCID ?? item.md5 ?? item.contentHash ?? ''),
        size: Number(item.size ?? item.fileSize ?? item.file_size ?? item.resSize ?? 0),
        modified: String(item.modified ?? item.updateTime ?? item.modifyTime ?? item.mtime ?? '') })
    }
    await ctx.task.update({stage:'scan', message: rule.name + '：扫描 ' + seen.size + ' 个目录，发现 ' + files.length + ' 个文件'})
  }
  return { root, directories: seen.size, files }
}
