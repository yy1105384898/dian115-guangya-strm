import { isVideo } from './guangya.js'
import { ruleExtensions } from './rules.js'

export async function assertLocalOutput(ctx, path) {
  let ancestor = path
  while (!(await ctx.files.call({ operation: 'exists', path: ancestor }))) {
    if (ancestor === '/') throw new Error('无法访问本地目录，请检查 DIAN-115 文件访问配置')
    ancestor = ancestor.slice(0, ancestor.lastIndexOf('/')) || '/'
  }
  const info = await ctx.files.call({ operation: 'stat', path: ancestor })
  const listing = await ctx.api.get(`/api/local-files?path=${encodeURIComponent(ancestor)}`)
  if (!info?.is_dir || listing?.backend !== 'local') throw new Error('输出路径必须位于本地磁盘，不能是 CD2 网盘目录')
}
export function mediaFile(file, rule) { return isVideo(file.name, ruleExtensions(rule)) }
export function metadataFile(file, rule) { return rule.metadata_mode !== 'off' && !!rule.metadata_extensions && isVideo(file.name, rule.metadata_extensions) }
export function outputPath(root, file, strm = false) { return root.replace(/\/+$/, '') + '/' + file.relative + (strm ? '.strm' : '') }
export async function localHash(ctx, path) {
  const response = await ctx.files.call({ operation: 'hash', path, algorithm: 'sha256' })
  const hash = typeof response === 'string' ? response : response?.sha256 || response?.hash || response?.result?.sha256
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) throw new Error('宿主未返回有效文件哈希，已停止处理')
  return hash.toLowerCase()
}
export async function ownedOutputs(ctx, rule) {
  const existing = await ctx.storage.get('owned:' + rule.id)
  if (existing) return existing
  const previous = await ctx.storage.get('inventory:' + rule.id) || {}
  return Object.fromEntries(Object.entries(previous).map(([path, hash]) => [path, { hash, kind: 'strm', legacy: true, rawPath: path.slice(rule.output_path.length + 1).replace(/\.strm$/i, '') }]))
}
