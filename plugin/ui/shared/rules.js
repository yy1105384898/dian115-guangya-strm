import { DEFAULT_CLOUD_NAME } from './accounts.js'
import { parseCron } from './schedule.js'

// Matches the existing host mount shown by this installation's native 115 STRM.
export const CD2_MOUNT_PREFIX = '/CloudNAS/CloudDrive'
export function cd2HostPath(path) { return CD2_MOUNT_PREFIX + '/' + String(path || '').split('/').filter(Boolean).join('/') }

export const VIDEO_EXTENSIONS = 'mkv,mp4,m4v,avi,mov,wmv,ts,m2ts,mpg,mpeg,flv,webm,rmvb,iso,3gp,rm'
export const MUSIC_EXTENSIONS = 'flac,mp3,m4a,aac,wav,ape,ogg,opus,dsf,dff'
export const METADATA_EXTENSIONS = 'nfo,jpg,jpeg,png,bmp,gif,webp,thumb,srt,ass,ssa,sub,idx,sup,vtt'
export const INCREMENTAL_OPTIONS = [[60, '每1小时'], [120, '每2小时'], [360, '每6小时'], [720, '每12小时'], [1440, '每天']]
export const FULL_OPTIONS = [[0, '不启用'], [720, '每12小时'], [1440, '每天凌晨3点']]

export function newRule(id) {
  return { id, name: '', cloud_name: DEFAULT_CLOUD_NAME, source_mode: 'direct', link_mode: 'path', service_url: '', source_parent_id: '', source_display_path: '/', source_cd2_path: '', source_cd2_root: '', output_path: '', enabled: true, generate_strm: true, schedule_enabled: false, organize_enabled: true, incremental_minutes: 60, full_minutes: 720, media_video: true, media_music: false, custom_extensions: '', metadata_extensions: METADATA_EXTENSIONS, metadata_mode: 'off', excluded_paths: [] }
}

export function getRules(settings) {
  if (Array.isArray(settings.rules)) return settings.rules.map(rule => ({ ...newRule(rule.id), ...rule, link_mode: rule.link_mode || 'link' }))
  if (!settings.output_path) return []
  return [{ ...newRule('legacy'), name: '光鸭同步', link_mode: 'link', source_mode: settings.source_cd2_path ? 'cd2' : 'direct',
    source_parent_id: settings.source_parent_id || '', source_display_path: settings.source_display_path || '/',
    source_cd2_path: settings.source_cd2_path || '', source_cd2_root: settings.source_cd2_root || '',
    output_path: settings.output_path, schedule_enabled: !!settings.schedule_enabled,
    legacy_cron: settings.schedule_cron || '',
    media_video: !settings.video_extensions || settings.video_extensions === VIDEO_EXTENSIONS,
    custom_extensions: settings.video_extensions && settings.video_extensions !== VIDEO_EXTENSIONS ? settings.video_extensions : '', full_minutes: 0 }]
}

export function ruleExtensions(rule) {
  if (typeof rule.file_extensions === 'string') return normalizeExtensions(rule.file_extensions)
  return [...new Set([rule.media_video ? VIDEO_EXTENSIONS : '', rule.media_music ? MUSIC_EXTENSIONS : '', rule.custom_extensions || ''].join(',').split(',').map(x => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))].join(',')
}

export function normalizeExtensions(value) {
  return [...new Set(String(value || '').split(',').map(x => x.trim().toLowerCase().replace(/^\./, '')).filter(Boolean))].join(',')
}

export function sourcePaths(rule) {
  const normalize = path => '/' + String(path || '').split('/').filter(Boolean).join('/')
  const root = normalize(rule.source_cd2_root || rule.cloud_name || '光鸭')
  if (rule.source_mode === 'cd2') {
    const cd2 = normalize(rule.source_cd2_path)
    return { relative: cd2 === root ? '/' : cd2.startsWith(root + '/') ? cd2.slice(root.length) : cd2, cd2, estimated: false }
  }
  const relative = normalize(rule.source_display_path)
  return { relative, cd2: root.replace(/\/+$/, '') + (relative === '/' ? '' : relative), estimated: true }
}

export function scheduleExpression(rule, full = false) {
  if (full) return Number(rule.full_minutes) === 1440 ? '0 3 * * *' : Number(rule.full_minutes) === 720 ? '0 */12 * * *' : ''
  if (rule.legacy_cron) return rule.legacy_cron
  const minutes = Number(rule.incremental_minutes) || 60
  return minutes === 1440 ? '0 0 * * *' : minutes === 60 ? '0 * * * *' : `0 */${minutes / 60} * * *`
}

export function validateRule(rule, otherRules = []) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id || '')) throw new Error('规则标识无效')
  if (!String(rule.name || '').trim()) throw new Error('请输入规则名称')
  const path = String(rule.output_path || '').replace(/\/+$/, '')
  if (!path || !path.startsWith('/') || path.split('/').some(p => p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p))) throw new Error('输出目录必须是容器内本地绝对路径，不能使用根目录或相对路径')
  if (!['path', 'link'].includes(rule.link_mode)) throw new Error('生成模式无效，请选择 CD2 路径模式或链接模式')
  if (rule.link_mode === 'link' && rule.service_url && !/^https?:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/i.test(rule.service_url)) throw new Error('服务地址必须是有效的 HTTP 或 HTTPS 地址，不能包含账号密码、查询参数或锚点')
  if (!['direct', 'cd2'].includes(rule.source_mode)) throw new Error('请选择有效的来源方式')
  if (rule.source_mode === 'cd2' && (!rule.source_cd2_path || !rule.source_cd2_path.startsWith('/'))) throw new Error('请选择 CD2 源目录')
  if (!INCREMENTAL_OPTIONS.some(([value]) => value === Number(rule.incremental_minutes))) throw new Error('增量同步频率无效')
  if (!FULL_OPTIONS.some(([value]) => value === Number(rule.full_minutes))) throw new Error('全量同步频率无效')
  if (rule.legacy_cron) parseCron(rule.legacy_cron)
  if (!ruleExtensions(rule)) throw new Error('请至少选择视频、音乐或填写文件后缀')
  if (ruleExtensions(rule).split(',').some(ext => !/^[a-z0-9]{1,16}$/.test(ext))) throw new Error('文件后缀只能包含 1–16 位字母和数字')
  if (!['off', 'cloud', 'local'].includes(rule.metadata_mode || 'off')) throw new Error('元数据同步方式无效')
  const metadata = normalizeExtensions(rule.metadata_extensions)
  if (metadata && metadata.split(',').some(ext => !/^[a-z0-9]{1,16}$/.test(ext))) throw new Error('元数据后缀格式无效')
  if (rule.metadata_mode !== 'off' && metadata.split(',').some(ext => ruleExtensions(rule).split(',').includes(ext))) throw new Error('文件后缀和元数据后缀不能重复')
  if (!Array.isArray(rule.excluded_paths) || rule.excluded_paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('排除目录必须是源目录下的相对目录')
  for (const other of otherRules) {
    if (other.id === rule.id || !other.output_path) continue
    const target = other.output_path.replace(/\/+$/, '')
    if (target === path || target.startsWith(path + '/') || path.startsWith(target + '/')) throw new Error(`输出目录与规则“${other.name}”重叠，请使用独立子目录`)
  }
  return { ...rule, name: String(rule.name).trim(), output_path: path, source_cd2_path: rule.source_mode === 'direct' ? '' : rule.source_cd2_path }
}
