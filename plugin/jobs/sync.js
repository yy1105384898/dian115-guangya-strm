import { mountedRule } from './clouds.js'
import { loadSettings } from './auth.js'
import { getRules, validateRule, sourcePaths, cd2HostPath } from './rules.js'
import { scanRule } from './scanner.js'
import { assertLocalOutput, mediaFile, metadataFile, outputPath, ownedOutputs, localHash } from './output.js'
import { resolveDownload } from './downloads.js'
import { cleanup } from './cleanup.js'
import { requireIdle } from './activity.js'
import { enqueueLibrary } from './library-refresh.js'
import { monitorLog, traceChanges } from './monitor-log.js'
export { listDirectory, resolveSource } from './scanner.js'

async function syncRule(ctx, settings, rule, full, scopes = null, request = {}) {
  const started = Date.now()
  if (rule.link_mode === 'path' || rule.source_mode === 'cd2') rule = await mountedRule(ctx,rule)
  rule = validateRule(rule, getRules(settings))
  if (!settings.access_token) throw new Error('请先在“账号登录”中登录光鸭')
  const serviceURL = String(rule.service_url || settings.public_base_url || '').replace(/\/+$/, '')
  if (rule.link_mode === 'link' && (!serviceURL || !settings.play_token)) throw new Error('播放设置尚未初始化，请打开插件并保存服务地址')
  await assertLocalOutput(ctx, rule.output_path)
  scopes = full ? null : scopes
  await traceChanges(ctx, rule, request.changes)
  const source = sourcePaths(rule).cd2.replace(/\/+$/, '')
  const trigger = request.full ? '全量同步' : ({ organize: '整理后增量', 'metadata-settle': '整理元数据补扫', watch: '目录变化增量', timer: '定时增量' })[request.trigger] || '手动增量'
  await monitorLog(ctx, rule, '开始' + trigger + '；' + (scopes ? '按目标父目录扫描' : '扫描规则源目录'))
  if (scopes) for (const scope of scopes) await monitorLog(ctx, rule, '扫描范围：' + source + (scope ? '/' + scope : ''))
  else await monitorLog(ctx, rule, '扫描范围：' + source)
  if (request.changes?.some(change => change.kind === 'remove')) await monitorLog(ctx, rule, '收到删除变化；本次同步补齐新增/更新，不自动删除本地输出，孤立文件由清理孤立处理')
  const scanStarted = Date.now()
  const scan = await scanRule(ctx, settings, rule, scopes)
  const scanMs = Date.now() - scanStarted
  const media = scan.files.filter(file => mediaFile(file, rule))
  const metadata = scan.files.filter(file => metadataFile(file, rule))
  let cd2Source = ''
  if (rule.generate_strm && rule.link_mode === 'path' && media.length) {
    cd2Source = sourcePaths(rule).cd2.replace(/\/+$/, '')
    if (!cd2Source.startsWith('/') || /[\r\n\0]/.test(cd2Source) || cd2Source.split('/').some(part => part === '.' || part === '..')) throw new Error('CD2 源路径无效，请重新选择源目录')
    const entry = await ctx.cd2.call('stat', {path:cd2Source})
    if (!entry?.is_dir) throw new Error('CD2 源目录不可读，请检查云盘名称和源路径，或选择链接模式')
    const hostSource = cd2HostPath(cd2Source)
    const listing = await ctx.api.get('/api/local-files?path=' + encodeURIComponent(hostSource))
    if (listing?.backend !== 'cd2') throw new Error('宿主未识别 CD2 挂载目录：' + hostSource + '。请检查宿主 CD2 挂载配置，或使用链接模式')
    cd2Source = hostSource
  }
  const oldInventory = full ? {} : await ctx.storage.get('inventory:' + rule.id) || {}
  const oldMetadata = full ? {} : await ctx.storage.get('metadata_inventory:' + rule.id) || {}
  const inventory = scopes ? { ...oldInventory } : {}, metadataInventory = scopes ? { ...oldMetadata } : {}, owned = await ownedOutputs(ctx, rule), used = new Set(), parents = new Set(), libraryFiles = new Map()
  const libraryPending = await ctx.storage.get('library_pending:' + rule.id)
  let generated = 0, created = 0, rewritten = 0, unchanged = 0, metadataWritten = 0, metadataSkipped = 0, processed = 0
  const total = (rule.generate_strm ? media.length : 0) + metadata.length
  const checkPath = path => { if (used.has(path)) throw new Error('规范化后出现重复输出路径：' + path); used.add(path) }
  for (const file of rule.generate_strm ? media : []) checkPath(outputPath(rule.output_path, file, true))
  for (const file of metadata) checkPath(outputPath(rule.output_path, file))
  const copy = async (temp, destination) => {
    const parent = destination.slice(0, destination.lastIndexOf('/'))
    if (!parents.has(parent)) { await assertLocalOutput(ctx, parent); await ctx.files.call({operation:'mkdir',path:parent}); parents.add(parent) }
    await ctx.files.call({operation:'copy',path:temp,destination,overwrite:true,progress:false})
  }
  const progress = async () => { if (processed % 25 === 0 || processed === total) await ctx.task.update({stage:'write', message:rule.name + '：STRM 写入 ' + generated + '，未变化 ' + unchanged + '；元数据写入 ' + metadataWritten + '，跳过 ' + metadataSkipped, total, done:processed}) }
  await ctx.files.call({operation:'mkdir',path:'generated'})
  try {
    for (const file of rule.generate_strm ? media : []) {
      const destination = outputPath(rule.output_path, file, true)
      const url = serviceURL + '/plugin-hooks/' + ctx.plugin.id + '/play?token=' + encodeURIComponent(settings.play_token) + '&id=' + encodeURIComponent(file.id) + '&gcid=' + encodeURIComponent(file.gcid) + '&rule=' + encodeURIComponent(rule.id)
      if (rule.link_mode === 'path' && /[\r\n\0]/.test(file.rawPath)) throw new Error('源文件路径含换行等非法字符，无法生成 CD2 路径 STRM')
      const content = (rule.link_mode === 'path' ? cd2Source + '/' + file.rawPath : url) + '\n', hash = ctx.crypto.sha256(content)
      const exists = await ctx.files.call({operation:'exists',path:destination})
      if (oldInventory[destination] === hash && exists) unchanged++
      else {
        const temp = 'generated/' + ctx.crypto.sha256(destination).slice(0,32) + '.strm'
        await ctx.files.call({operation:'write',path:temp,content}); await copy(temp,destination); generated++
        if (exists) rewritten++; else created++
        if (generated <= 100) await monitorLog(ctx, rule, (exists ? '更新 STRM：' : '新建 STRM：') + destination)
        libraryFiles.set(destination, { destination, rawPath: file.rawPath, signature: ctx.crypto.sha256(hash + ':' + Date.now()) })
      }
      inventory[destination] = hash
      owned[destination] = {hash,kind:'strm',rawPath:file.rawPath}
      if ((libraryPending?.output_path !== rule.output_path || !libraryPending?.entries?.[destination]) && !libraryFiles.has(destination)) libraryFiles.set(destination, { destination, rawPath: file.rawPath, signature: ctx.crypto.sha256(destination + ':' + hash) })
      processed++; await progress()
    }
    for (const file of metadata) {
      const destination = outputPath(rule.output_path,file)
      const exists = await ctx.files.call({operation:'exists',path:destination})
      const signature = ctx.crypto.sha256(JSON.stringify([file.id,file.size,file.modified,file.gcid]))
      if (rule.metadata_mode === 'local' && exists) { metadataSkipped++; processed++; await progress(); continue }
      const previous = oldMetadata[destination]
      if (exists && previous?.signature === signature && previous.hash === await localHash(ctx,destination)) {
        metadataInventory[destination] = previous; metadataSkipped++; processed++; await progress(); continue
      }
      const maxBytes = 64 * 1024 * 1024
      if (file.size > maxBytes) throw new Error('元数据文件超过 64 MiB 限制：' + file.rawPath)
      const url = await resolveDownload(ctx,settings,file.id,file.gcid)
      const temp = 'generated/' + ctx.crypto.sha256(destination).slice(0,32) + '.metadata'
      const result = await ctx.http.request({url,method:'GET',save_to:temp,max_bytes:maxBytes,timeout_seconds:180})
      if (result.status < 200 || result.status >= 300 || !/^[a-f0-9]{64}$/i.test(result.sha256 || '')) throw new Error('元数据下载失败（HTTP ' + result.status + '）：' + file.rawPath)
      const hash = result.sha256.toLowerCase()
      await copy(temp,destination)
      owned[destination] = {hash,kind:'metadata',rawPath:file.rawPath}
      metadataInventory[destination] = {signature,hash}
      metadataWritten++; processed++; await progress()
    }
  } finally {
    // Retain positive ownership records even when a later write fails; never infer deletion from failure.
    await ctx.storage.set('owned:' + rule.id,owned)
    if (metadataWritten && rule.generate_strm) {
      for (const file of media) {
        const destination = outputPath(rule.output_path, file, true)
        if (owned[destination] && !libraryFiles.has(destination)) libraryFiles.set(destination, { destination, rawPath: file.rawPath, signature: ctx.crypto.sha256(owned[destination].hash + ':metadata:' + Date.now()) })
      }
    }
    await enqueueLibrary(ctx, rule, [...libraryFiles.values()])
  }
  if (rule.generate_strm) await ctx.storage.set('inventory:' + rule.id,inventory)
  if (rule.metadata_mode !== 'off') await ctx.storage.set('metadata_inventory:' + rule.id,metadataInventory)
  const summary = {at:new Date().toISOString(),rule_id:rule.id,rule_name:rule.name,source_parent_id:scan.root,directories:scan.directories,videos:media.length,files:scan.files.length,generated,created,rewritten,unchanged,scan_ms:scanMs,elapsed_ms:Date.now()-started,metadata_written:metadataWritten,metadata_skipped:metadataSkipped,full,scoped:!!scopes,scopes,generate_strm:rule.generate_strm,errors:[]}
  const previousSummary = await ctx.storage.get('last_sync:' + rule.id)
  summary.tree = scopes ? previousSummary?.tree || (previousSummary && !previousSummary.scoped ? { directories: previousSummary.directories, files: previousSummary.files ?? previousSummary.videos } : null) : { directories: scan.directories, files: scan.files.length }
  await ctx.storage.set('last_sync:' + rule.id,summary); await ctx.storage.set('last_sync',summary)
  if (generated > 100) await monitorLog(ctx, rule, 'STRM 写入明细仅展示前 100 项，总数以完成统计为准')
  await monitorLog(ctx, rule, (scopes ? '目标目录扫描完成：' : '源目录扫描完成：') + '扫描 ' + scan.directories + ' 个目录 / ' + scan.files.length + ' 个文件，生成 ' + generated + ' 个 STRM（新建 ' + created + '，更新 ' + rewritten + '），未变化 ' + unchanged + '，元数据写入 ' + metadataWritten + '；目录读取 ' + scanMs + ' 毫秒，总耗时 ' + summary.elapsed_ms + ' 毫秒')
  return summary
}

export async function run(ctx,input={}) {
  await requireIdle(ctx, 'cloud-cleanup')
  if (input.action === 'cleanup_preview' || input.action === 'cleanup_commit') return cleanup(ctx,input)
  const base = await ctx.settings.get(), rules = getRules(base)
  const requests = input.requests || (input.rule_id ? [{rule_id:input.rule_id,full:!!input.full}] : rules.filter(rule=>rule.enabled).map(rule=>({rule_id:rule.id,full:!!input.full})))
  if (!Array.isArray(requests) || !requests.length) throw new Error('没有可执行的同步规则')
  const results=[], failures=[]
  for (const request of requests) {
    const rule = rules.find(item=>item.id===request.rule_id)
    if (!rule) throw new Error('同步规则不存在，请刷新规则列表')
    if (input.scheduled && !rule.enabled) continue
    try {
      results.push(await syncRule(ctx,await loadSettings(ctx),rule,!!request.full,request.scopes || null,request))
      if (request.organize_version) await ctx.storage.set('organize_done:' + rule.id,request.organize_version)
      if (request.realtime_version) await ctx.storage.set('source_change_done:' + rule.id,request.realtime_version)
    }
    catch(error) { failures.push(rule.name + '：' + error.message); await ctx.storage.set('last_error:' + rule.id,{at:new Date().toISOString(),message:error.message}); await monitorLog(ctx,rule,'同步失败：' + error.message + '；本批监控请求不确认完成，自动触发请求保留待重试') }
  }
  if(failures.length) throw new Error(failures.join('；'))
  const processed = results.reduce((sum, item) => sum + item.generated + item.unchanged + item.metadata_written + item.metadata_skipped, 0)
  await ctx.task.update({ stage: 'completed', progress: 100, total: processed, done: processed, failed: 0,
    message: '光鸭同步完成：生成 ' + results.reduce((sum, item) => sum + item.generated, 0) + ' 个 STRM；监控来源、目录和耗时见任务日志' })
  return {rules:results,generated:results.reduce((sum,item)=>sum+item.generated,0),unchanged:results.reduce((sum,item)=>sum+item.unchanged,0),metadata_written:results.reduce((sum,item)=>sum+item.metadata_written,0)}
}
