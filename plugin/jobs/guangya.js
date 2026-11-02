const API = 'https://api.guangyapan.com'
const ACCOUNT = 'https://account.guangyapan.com'
const CLIENT_ID = 'aMe-8VSlkrbQXpUR'
const VIDEO_DEFAULT = 'mkv,mp4,m4v,avi,mov,wmv,ts,m2ts,mpg,mpeg,flv,webm'

export function deviceId(ctx, settings) {
  if (settings.device_id) return settings.device_id
  return ctx.crypto.sha256(settings.access_token || 'guangya-device').slice(0, 32)
}

export function deviceHeaders(ctx, settings, token) {
  const did = deviceId(ctx, settings)
  return {
    accept: 'application/json, text/plain, */*',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    did,
    dt: '4',
    origin: 'https://www.guangyapan.com',
    referer: 'https://www.guangyapan.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    traceparent: `00-${ctx.crypto.randomBytes(16).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}-${ctx.crypto.randomBytes(8).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '')}-01`,
    'x-client-id': CLIENT_ID,
    'x-client-version': '0.0.1',
    'x-device-id': did,
    'x-device-model': 'chrome%2F125.0.0.0',
    'x-device-name': 'PC-Chrome',
    'x-device-sign': `wdi10.${did}${ctx.crypto.sha256(did).slice(0, 32)}`,
    accessToken: token,
    'x-net-work-type': 'NONE',
    'x-os-version': 'Windows',
    'x-platform-version': '1',
    'x-protocol-version': '301',
    'x-provider-name': 'NONE',
    'x-sdk-version': '9.0.2'
  }
}

async function post(ctx, url, body, headers, timeout = 60, allowedCodes = []) {
  const result = await ctx.http.request({
    url, method: 'POST', headers, json: body, response_type: 'json', timeout_seconds: timeout
  })
  if (result.status < 200 || result.status >= 300) throw new Error(`光鸭请求失败 HTTP ${result.status}`)
  const data = result.data
  if (data && typeof data === 'object' && data.code !== undefined && ![0, 200, '0', '200', ...allowedCodes].includes(data.code)) {
    throw new Error(`光鸭 API 错误 ${String(data.code).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30)}`)
  }
  return data
}

export async function request(ctx, settings, token, url, body, allowedCodes = []) {
  return post(ctx, url, body, deviceHeaders(ctx, settings, token), 60, allowedCodes)
}

export async function refresh(ctx, settings, refreshToken) {
  const did = deviceId(ctx, settings)
  const headers = {
    accept: '*/*', 'content-type': 'application/json', origin: 'https://www.guangyapan.com',
    referer: 'https://www.guangyapan.com/', 'x-client-id': CLIENT_ID,
    'x-client-version': '0.0.1', 'x-device-id': did, 'x-device-model': 'chrome%2F125.0.0.0',
    'x-device-name': 'PC-Chrome', 'x-device-sign': `wdi10.${did}${ctx.crypto.sha256(did).slice(0, 32)}`,
    'x-net-work-type': 'NONE', 'x-os-version': 'Windows', 'x-platform-version': '1',
    'x-protocol-version': '301', 'x-provider-name': 'NONE', 'x-sdk-version': '9.0.2', 'x-action': '401'
  }
  const data = await post(ctx, `${ACCOUNT}/v1/auth/token`, {
    client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken
  }, headers)
  const token = data?.access_token || data?.data?.access_token
  if (!token) throw new Error('光鸭刷新 Token 响应缺少 access_token')
  const expiry = data?.expires_in || data?.data?.expires_in
  return { access_token: token, refresh_token: data?.refresh_token || data?.data?.refresh_token || refreshToken,
    expires_at: expiry ? Date.now() + Number(expiry) * 1000 : null }
}

export function unwrap(value) {
  let v = value
  for (let i = 0; i < 4 && v && typeof v === 'object' && !Array.isArray(v); i++) {
    if (v.data !== undefined) v = v.data
    else if (v.result !== undefined) v = v.result
    else break
  }
  return v
}

export function findArray(value) {
  const root = unwrap(value)
  if (Array.isArray(root)) return root
  if (!root || typeof root !== 'object') throw new Error('光鸭目录列表响应格式不正确')
  for (const key of ['list', 'files', 'items', 'records', 'content', 'fileList', 'file_list', 'infoList', 'InfoList']) {
    if (Array.isArray(root[key])) return root[key]
  }
  throw new Error('光鸭目录响应缺少已知列表字段，不能当作空目录处理')
}

export function itemId(item) {
  return String(item.fileId ?? item.file_id ?? item.resId ?? item.res_id ?? item.resourceId ?? item.id ?? '')
}

export function itemName(item) {
  return String(item.fileName ?? item.file_name ?? item.name ?? item.filename ?? item.dirName ?? item.title ?? '')
}

export function isDirectory(item) {
  const type = String(item.type ?? item.fileType ?? item.category ?? '').toLowerCase()
  const resType = String(item.resType ?? item.res_type ?? '')
  const name = itemName(item)
  if (item.isDir || item.isdir || item.dir || item.isFolder || item.folder || item.dirName || ['dir', 'directory', 'folder'].includes(type)) return true
  if (resType === '1') return false
  if (resType === '2') return true
  if (/\.[a-z0-9]{1,16}$/i.test(name)) return false
  return String(item.dirType ?? item.dir_type ?? '') === '1'
}

export function escapePathPart(part) {
  return String(part).replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').trim() || '_'
}

export function isVideo(name, configured) {
  const exts = String(configured || VIDEO_DEFAULT).split(',').map(x => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
  const m = String(name).toLowerCase().match(/\.([^.]+)$/)
  return !!m && exts.includes(m[1])
}

export function findUrl(value, depth = 0) {
  if (depth > 5 || value == null) return ''
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : ''
  if (Array.isArray(value)) {
    for (const v of value) { const found = findUrl(v, depth + 1); if (found) return found }
    return ''
  }
  if (typeof value !== 'object') return ''
  for (const key of ['signedURL', 'signedUrl', 'url', 'downloadUrl', 'download_url', 'playUrl', 'play_url', 'resUrl', 'res_url', 'httpsUrl', 'cdnUrl', 'cdn_url']) {
    if (typeof value[key] === 'string' && /^https?:\/\//i.test(value[key])) return value[key]
  }
  for (const v of Object.values(value)) { const found = findUrl(v, depth + 1); if (found) return found }
  return ''
}
