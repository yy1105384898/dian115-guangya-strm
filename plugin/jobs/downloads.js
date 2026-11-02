import { request, refresh, findUrl } from './guangya.js'
const DOWNLOAD_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/get_res_download_url'
const VOD_DOWNLOAD_URL = 'https://api.guangyapan.com/nd.bizuserres.s/v1/file/get_vod_download_url'

export async function resolveDownload(ctx, settings, fileId, gcid = '') {
  const stored = await ctx.storage.get('tokens')
  let token = stored?.access_token || settings.access_token, response
  try { response = await request(ctx, settings, token, DOWNLOAD_URL, { fileId }, [143, '143']) }
  catch (error) {
    if (!(stored?.refresh_token || settings.refresh_token) || !/401|unauthorized|token/i.test(error.message)) throw error
    const tokens = await refresh(ctx, settings, stored?.refresh_token || settings.refresh_token)
    await ctx.storage.set('tokens', tokens); token = tokens.access_token
    response = await request(ctx, settings, token, DOWNLOAD_URL, { fileId }, [143, '143'])
  }
  if (String(response?.code) === '143' && gcid) response = await request(ctx, settings, token, VOD_DOWNLOAD_URL, { fileId, gcid })
  const url = findUrl(response)
  if (!url) throw new Error('光鸭未返回可用下载地址')
  return url
}
