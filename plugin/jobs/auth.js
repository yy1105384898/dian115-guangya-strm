import { refresh } from './guangya.js'

const ACCOUNT = 'https://account.guangyapan.com'
const CLIENT_ID = 'aMe-8VSlkrbQXpUR'

export async function loadSettings(ctx) {
  const settings = await ctx.settings.get()
  const auth = await ctx.storage.get('auth')
  if (auth?.access_token) {
    settings.access_token = auth.access_token
    settings.refresh_token = auth.refresh_token || ''
    settings.device_id = auth.device_id
  }
  const stored = await ctx.storage.get('tokens')
  if (stored?.access_token) {
    settings.access_token = stored.access_token
    settings.refresh_token = stored.refresh_token || settings.refresh_token
  }
  if (stored?.expires_at && stored.expires_at < Date.now() + 60000 && settings.refresh_token) {
    const tokens = await refresh(ctx, settings, settings.refresh_token)
    await ctx.storage.set('tokens', tokens)
    settings.access_token = tokens.access_token
    settings.refresh_token = tokens.refresh_token
  }
  return settings
}

function accountHeaders(ctx, did) {
  return {
    accept: '*/*', 'content-type': 'application/json', origin: 'https://www.guangyapan.com',
    referer: 'https://www.guangyapan.com/',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36',
    'x-client-id': CLIENT_ID, 'x-client-version': '0.0.1', 'x-device-id': did,
    'x-device-model': 'chrome%2F147.0.0.0', 'x-device-name': 'PC-Chrome',
    'x-device-sign': `wdi10.${did}${ctx.crypto.sha256(did).slice(0, 32)}`,
    'x-net-work-type': 'NONE', 'x-os-version': 'MacIntel', 'x-platform-version': '1',
    'x-protocol-version': '301', 'x-provider-name': 'NONE', 'x-sdk-version': '9.0.2'
  }
}

async function account(ctx, path, body, did, extraHeaders = {}) {
  const response = await ctx.http.request({ url: ACCOUNT + path, method: 'POST',
    json: body, headers: { ...accountHeaders(ctx, did), ...extraHeaders }, response_type: 'json', timeout_seconds: 25 })
  const data = response.data
  if (response.status < 200 || response.status >= 300 || !data || data.error || data.success === false || (data.code !== undefined && ![0, '0', 200, '200'].includes(data.code))) {
    // Keep remote response bodies and credentials out of task logs and UI errors.
    const reason = String(data?.error || data?.code || response.status).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)
    throw new Error(`光鸭登录请求未通过（${reason}），请检查验证码、登录状态或稍后重试`)
  }
  return data
}

function maskPhone(phone) { return phone ? phone.replace(/(\d{3})\d+(\d{4})$/, '$1****$2') : '' }

export async function authStatus(ctx) {
  const auth = await ctx.storage.get('auth')
  const tokens = await ctx.storage.get('tokens')
  const settings = await ctx.settings.get()
  return {
    configured: !!(auth?.access_token || settings.access_token),
    phone: maskPhone(auth?.phone),
    refreshable: !!(tokens?.refresh_token || auth?.refresh_token || settings.refresh_token),
    expires_at: tokens?.expires_at || auth?.expires_at || null,
    method: auth?.access_token ? auth.method || 'sms' : 'manual'
  }
}

export async function handleAuth(ctx, action, body = {}) {
  if (action === 'status') return authStatus(ctx)
  if (action === 'import') {
    const access_token = String(body.access_token || '').trim()
    if (!access_token) throw new Error('请输入 Access Token')
    const auth = { access_token, refresh_token: String(body.refresh_token || '').trim(),
      device_id: String(body.device_id || '').trim() || ctx.crypto.sha256(access_token).slice(0, 32), phone: '', expires_at: null, method: 'manual' }
    await ctx.storage.set('auth', auth)
    await ctx.storage.set('tokens', { access_token, refresh_token: auth.refresh_token, expires_at: null })
    return { ...await authStatus(ctx), message: '登录凭证已保存' }
  }
  if (action === 'refresh') {
    const settings = await loadSettings(ctx)
    const old = await ctx.storage.get('tokens')
    const rt = old?.refresh_token || settings.refresh_token
    if (!rt) throw new Error('未保存 Refresh Token，请先登录')
    const tokens = await refresh(ctx, settings, rt)
    await ctx.storage.set('tokens', tokens)
    return { ...await authStatus(ctx), message: 'Token 已刷新' }
  }
  if (action === 'send') {
    let phone = String(body.phone || '').replace(/[\s-]/g, '')
    if (/^1\d{10}$/.test(phone)) phone = '+86' + phone
    if (!/^\+\d{8,16}$/.test(phone)) throw new Error('请输入 11 位手机号，其他地区需包含国际区号')
    const previous = await ctx.storage.get('auth_pending')
    if (previous?.sent_at && Date.now() - previous.sent_at < 60000) throw new Error('验证码已发送，请等待 60 秒后重试')
    const settings = await ctx.settings.get()
    const did = previous?.device_id || settings.device_id || ctx.crypto.randomUUID().replace(/-/g, '')
    const formatted = phone.startsWith('+86') ? '+86 ' + phone.slice(3) : phone
    const initBody = { client_id: CLIENT_ID, action: 'POST:/v1/auth/verification', device_id: did, meta: { phone_number: formatted } }
    if (body.captcha_token) initBody.captcha_token = String(body.captcha_token)
    const init = await account(ctx, '/v1/shield/captcha/init', initBody, did)
    const captcha = init.captcha_token
    if (init.url || !captcha) {
      const url = init.url && /^https:\/\//.test(init.url) ? init.url : ''
      return { needs_verification: true, url, message: '光鸭要求人机验证。请打开验证链接，完成后填入验证码令牌重试，或在高级设置中导入已有 Token。' }
    }
    const sent = await account(ctx, '/v1/auth/verification', { phone_number: formatted, target: 'ANY', client_id: CLIENT_ID }, did, { 'x-captcha-token': captcha })
    if (!sent.verification_id) throw new Error('光鸭未返回短信验证 ID，请稍后重试')
    await ctx.storage.set('auth_pending', { device_id: did, phone: formatted, verification_id: sent.verification_id, captcha_token: captcha, sent_at: Date.now() })
    return { sent: true, phone: maskPhone(formatted), retry_after: 60, message: '验证码已发送，请在下方输入并登录' }
  }
  if (action === 'login') {
    const pending = await ctx.storage.get('auth_pending')
    if (!pending?.verification_id || Date.now() - pending.sent_at > 600000) throw new Error('请先发送验证码，验证码有效窗口为 10 分钟')
    const code = String(body.code || '').trim()
    if (!/^\d{4,8}$/.test(code)) throw new Error('请输入收到的短信验证码')
    const verified = await account(ctx, '/v1/auth/verification/verify', {
      verification_id: pending.verification_id, verification_code: code, client_id: CLIENT_ID
    }, pending.device_id)
    if (!verified.verification_token) throw new Error('短信验证未通过，请重新输入验证码')
    const result = await account(ctx, '/v1/auth/signin', {
      verification_code: code, verification_token: verified.verification_token,
      username: pending.phone, client_id: CLIENT_ID
    }, pending.device_id, { 'x-captcha-token': pending.captcha_token })
    if (!result.access_token) throw new Error('光鸭未返回登录 Token，请稍后重试')
    const auth = { access_token: result.access_token, refresh_token: result.refresh_token || '',
      device_id: pending.device_id, phone: pending.phone,
      expires_at: result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : null }
    await ctx.storage.set('auth', auth)
    await ctx.storage.set('tokens', { access_token: auth.access_token, refresh_token: auth.refresh_token, expires_at: auth.expires_at })
    await ctx.storage.set('auth_pending', null)
    return { ...await authStatus(ctx), message: '登录成功，登录信息已加密保存' }
  }
  throw new Error('不支持的登录操作')
}
