export const virtualPath = path => '/' + String(path || '').split('/').filter(Boolean).join('/')

export async function mountedCloud(ctx, rule = {}) {
  const response = await ctx.api.get('/api/cd2/clouds')
  if (!Array.isArray(response?.clouds)) throw new Error('宿主未返回有效 CD2 网盘列表')
  const clouds = response.clouds.filter(item => /光鸭|guangya/i.test([item.name,item.path].join(' ')) && /^\/[^/]+\/?$/.test(item.path || ''))
  const existing = virtualPath(rule.cloud_name)
  const selected = clouds.find(item => virtualPath(item.path) === existing)
  if (selected) return virtualPath(selected.path)
  if (clouds.length === 1) return virtualPath(clouds[0].path)
  if (!clouds.length) throw new Error('CD2 未找到已挂载的光鸭网盘；可使用链接模式')
  throw new Error('CD2 存在多个光鸭挂载，无法自动确定与登录账号对应的网盘')
}

export async function mountedRule(ctx, rule) {
  const cloud = await mountedCloud(ctx, rule)
  if (rule.source_mode === 'cd2' && rule.source_cd2_path && !String(rule.source_cd2_path).startsWith(cloud + '/') && rule.source_cd2_path !== cloud) {
    throw new Error('已选 CD2 源目录与自动读取的光鸭网盘不一致，请重新选择源目录')
  }
  return {...rule, cloud_name:cloud, source_cd2_root:cloud}
}
