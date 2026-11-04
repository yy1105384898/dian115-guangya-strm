import { request, refresh, findUrl } from './guangya.js'
import { itemId, itemName, isDirectory } from './guangya.js'
import { listDirectory } from './scanner.js'
import { loadSettings, handleAuth } from './auth.js'

const DOWNLOAD_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/get_res_download_url'
const VOD_DOWNLOAD_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/file/get_vod_download_url'

export async function handle(ctx, req) {
  if (req.path.startsWith('/auth/') && req.method === 'POST') {
    if (req.source !== 'hook') return { status: 403, json: { error: '请先登录 DIAN-115' } }
    try { return { json: await handleAuth(ctx, req.path.slice(6), req.json || {}), headers: { 'Cache-Control': 'no-store' } } }
    catch (e) { return { status: 400, json: { error: e.message || '登录操作失败' } } }
  }
  if (req.path === '/browse' && req.method === 'POST') {
    if (req.source !== 'hook') return { status: 403, body: '请登录 DIAN-115 后浏览目录' }
    try {
    const settings = await loadSettings(ctx)
    if (!settings.access_token) return { status: 400, json: { error: '请先在“光鸭账号”登录，或导入手动凭证' } }
    const stored = await ctx.storage.get('tokens')
    let token = stored?.access_token || settings.access_token
    const parentId = String(req.json?.parent_id || '')
    let entries
    try { entries = await listDirectory(ctx, settings, token, parentId) }
    catch (error) {
      if (!(stored?.refresh_token || settings.refresh_token) || !/401|unauthorized|token/i.test(error.message)) throw error
      const tokens = await refresh(ctx, settings, stored?.refresh_token || settings.refresh_token)
      await ctx.storage.set('tokens', tokens)
      token = tokens.access_token
      entries = await listDirectory(ctx, settings, token, parentId)
    }
    return { json: { items: entries.filter(isDirectory).map(item => ({ id: itemId(item), name: itemName(item) })) } }
    } catch (error) {
      // Return a business error so clients that discard non-2xx response bodies
      // can still show the actual directory failure instead of just HTTP 500.
      const detail = String(error?.message || '未知后端异常')
        .replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]')
        .replace(/https?:\/\/[^\s]+/gi, '[远程地址]')
        .slice(0, 1200)
      return { json: { error: '读取光鸭目录失败：' + detail }, headers: { 'Cache-Control': 'no-store' } }
    }
  }
  if (req.path !== '/play' || req.method !== 'GET') return { status: 404, body: 'not found' }
  const settings = await loadSettings(ctx)
  const supplied = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token
  const fileId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id
  const gcid = Array.isArray(req.query.gcid) ? req.query.gcid[0] : req.query.gcid
  if (!settings.play_token || supplied !== settings.play_token) return { status: 401, body: 'unauthorized' }
  if (!fileId || fileId.length > 256) return { status: 400, body: 'missing file id' }

  const stored = await ctx.storage.get('tokens')
  let token = stored?.access_token || settings.access_token
  let response
  try {
    response = await request(ctx, settings, token, DOWNLOAD_URL, { fileId }, [143, '143'])
  } catch (error) {
    if (!(stored?.refresh_token || settings.refresh_token) || !/401|unauthorized|token/i.test(error.message)) throw error
    const tokens = await refresh(ctx, settings, stored?.refresh_token || settings.refresh_token)
    await ctx.storage.set('tokens', tokens)
    token = tokens.access_token
    response = await request(ctx, settings, token, DOWNLOAD_URL, { fileId }, [143, '143'])
  }
  if (String(response?.code) === '143' && gcid) {
    response = await request(ctx, settings, token, VOD_DOWNLOAD_URL, { fileId, gcid })
  }
  const url = findUrl(response)
  if (!url) return { status: 502, body: '光鸭未返回可用下载地址' }
  return { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' }, body: '' }
}
