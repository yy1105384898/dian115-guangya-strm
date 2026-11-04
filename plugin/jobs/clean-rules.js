import { parseCron } from './schedule.js'

export const CLEAN_TYPES = {
  video: 'mp4,mkv,avi,mov,wmv,flv,rmvb,iso,m4v,mpg,mpeg,3gp,ts,m2ts,webm,rm,vob,asf',
  subtitle: 'srt,ass,ssa,sub,idx,sup,vtt',
  audio: 'mp3,flac,wav,aac,m4a,ape,ogg,opus,wma'
}
export const CLEAN_MODES = { remove: '删除选中文件', keep: '保留选中文件，删除其余文件', directories: '仅清理不含保留文件的目录' }
export function cleanPath(value) {
  const path = String(value || '')
  if (!path.startsWith('/') || /[\\\r\n\0]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) throw new Error('目录路径无效，请重新选择')
  return '/' + path.split('/').filter(Boolean).join('/')
}
export const below = (path, root) => path === root || path.startsWith(root === '/' ? '/' : root + '/')
export function newCleanRule(id) {
  return { id, name: '', source_id: '', source_path: '', mode: 'remove', types: [], suffixes: '',
    size_enabled: false, size_mb: 100, condition: 'and', empty_dirs: true, exclusions: [], enabled: true,
    scheduled: false, notify_start: false, notify_end: false }
}
export function validateCleanRule(value) {
  const rule = { ...newCleanRule(value.id), ...value }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id || '')) throw new Error('规则标识无效')
  rule.name = String(rule.name || '').trim().slice(0, 80)
  if (!rule.name) throw new Error('请输入规则名称')
  rule.source_path = cleanPath(rule.source_path)
  if (!rule.source_id || typeof rule.source_id !== 'string' || rule.source_path === '/') throw new Error('请选择光鸭根目录下的具体目录，不能清理整个网盘')
  if (!(rule.mode in CLEAN_MODES)) throw new Error('清理方式无效')
  if (!Array.isArray(rule.types) || rule.types.some(type => !['all', 'video', 'subtitle', 'audio', 'custom'].includes(type))) throw new Error('文件类型无效')
  rule.suffixes = String(rule.suffixes || '').toLowerCase().split(/[,，\s]+/).map(s => s.replace(/^\./, '')).filter(Boolean).join(',')
  if (rule.suffixes && !/^[a-z0-9]+(?:,[a-z0-9]+)*$/.test(rule.suffixes)) throw new Error('后缀请填写 mkv,nfo 等，用逗号分隔')
  if (rule.types.includes('custom') && !rule.suffixes) throw new Error('请输入指定后缀')
  rule.size_mb = Number(rule.size_mb)
  if (rule.size_enabled && (!Number.isFinite(rule.size_mb) || rule.size_mb <= 0)) throw new Error('文件大小必须大于 0 MB')
  if (!['and', 'or'].includes(rule.condition)) throw new Error('条件组合无效')
  if (!rule.types.length && !rule.size_enabled && (rule.mode !== 'remove' || !rule.empty_dirs)) throw new Error('请选择文件条件，或启用仅清理空目录')
  delete rule.max_deletions
  if (!Array.isArray(rule.exclusions)) throw new Error('排除目录格式无效')
  rule.exclusions = [...new Set(rule.exclusions.map(cleanPath))]
  if (rule.exclusions.some(path => !below(path, rule.source_path) || path === rule.source_path)) throw new Error('排除目录必须是清理目录的子目录')
  for (const key of ['enabled', 'scheduled', 'empty_dirs', 'size_enabled', 'notify_start', 'notify_end']) rule[key] = rule[key] === true
  return rule
}
export function cleanRules(settings) {
  if (settings.cloud_cleanup_rules === undefined) return []
  if (!Array.isArray(settings.cloud_cleanup_rules)) throw new Error('清理规则读取失败，已停止')
  return settings.cloud_cleanup_rules.map(validateCleanRule)
}
export function fileMatches(file, rule) {
  const extension = file.name.toLowerCase().split('.').slice(1).pop() || ''
  const typeMatch = rule.types.some(type => type === 'all' || (type === 'custom' ? rule.suffixes : CLEAN_TYPES[type] || '').split(',').includes(extension))
  const sizeMatch = rule.size_enabled && file.size < rule.size_mb * 1024 * 1024
  if (rule.types.length && rule.size_enabled) return rule.condition === 'or' ? typeMatch || sizeMatch : typeMatch && sizeMatch
  return rule.types.length ? typeMatch : !!sizeMatch
}
export function cleanSummary(rule) {
  if (!rule.types.length && !rule.size_enabled) return '只清理空目录，所有文件保留。'
  const names = { all: '全部文件', video: '视频', subtitle: '字幕', audio: '音频', custom: rule.suffixes }
  let condition = rule.types.map(type => names[type]).join(' / ')
  if (rule.size_enabled) condition += (condition ? rule.condition === 'or' ? ' 或 ' : ' 且 ' : '') + `小于 ${rule.size_mb} MB`
  return (rule.mode === 'remove' ? '删除：' : '保留条件：') + condition + (rule.empty_dirs ? '；同时清理空目录。' : '；保留空目录。')
}
export function cleanupCron(value) {
  let expression = String(value || '').trim()
  const fields = expression.split(/\s+/)
  if (fields.length === 6) {
    if (fields[0] !== '0') throw new Error('定时最小精度为分钟，六段 Cron 的秒字段只能为 0')
    expression = fields.slice(1).join(' ')
  }
  parseCron(expression)
  return expression
}
