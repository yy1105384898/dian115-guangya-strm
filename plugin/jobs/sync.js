import { mountedRule } from './clouds.js'
import { loadSettings } from './auth.js'
import { getRules, validateRule, sourcePaths, cd2HostPath } from './rules.js'
import { scanRule } from './scanner.js'
import { assertLocalOutput, mediaFile, metadataFile, outputPath, ownedOutputs, localHash } from './output.js'
import { resolveDownload } from './downloads.js'
import { cleanup } from './cleanup.js'
export { listDirectory, resolveSource } from './scanner.js'

async function syncRule(ctx, settings, rule, full) {
  if (rule.link_mode === 'path' || rule.source_mode === 'cd2') rule = await mountedRule(ctx,rule)
  rule = validateRule(rule, getRules(settings))
  if (!settings.access_token) throw new Error('请先在“账号登录”中登录光鸭')
  if (!settings.public_base_url || !settings.play_token) throw new Error('播放设置尚未初始化，请打开插件并保存规则')
  await assertLocalOutput(ctx, rule.output_path)
  const scan = await scanRule(ctx, settings, rule)
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
  const inventory = {}, metadataInventory = {}, owned = await ownedOutputs(ctx, rule), used = new Set(), parents = new Set()
  let generated = 0, unchanged = 0, metadataWritten = 0, metadataSkipped = 0, processed = 0
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
      const url = settings.public_base_url.replace(/\/+$/, '') + '/plugin-hooks/' + ctx.plugin.id + '/play?token=' + encodeURIComponent(settings.play_token) + '&id=' + encodeURIComponent(file.id) + '&gcid=' + encodeURIComponent(file.gcid) + '&rule=' + encodeURIComponent(rule.id)
      if (rule.link_mode === 'path' && /[\r\n\0]/.test(file.rawPath)) throw new Error('源文件路径含换行等非法字符，无法生成 CD2 路径 STRM')
      const content = (rule.link_mode === 'path' ? cd2Source + '/' + file.rawPath : url) + '\n', hash = ctx.crypto.sha256(content)
      if (oldInventory[destination] === hash && await ctx.files.call({operation:'exists',path:destination})) unchanged++
      else {
        const temp = 'generated/' + ctx.crypto.sha256(destination).slice(0,32) + '.strm'
        await ctx.files.call({operation:'write',path:temp,content}); await copy(temp,destination); generated++
      }
      inventory[destination] = hash
      owned[destination] = {hash,kind:'strm',rawPath:file.rawPath}
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
  }
  if (rule.generate_strm) await ctx.storage.set('inventory:' + rule.id,inventory)
  if (rule.metadata_mode !== 'off') await ctx.storage.set('metadata_inventory:' + rule.id,metadataInventory)
  const summary = {at:new Date().toISOString(),rule_id:rule.id,rule_name:rule.name,source_parent_id:scan.root,directories:scan.directories,videos:media.length,files:scan.files.length,generated,unchanged,metadata_written:metadataWritten,metadata_skipped:metadataSkipped,full,generate_strm:rule.generate_strm,errors:[]}
  await ctx.storage.set('last_sync:' + rule.id,summary); await ctx.storage.set('last_sync',summary)
  await ctx.task.log(rule.name + '：目录 ' + scan.directories + '，媒体 ' + media.length + '，STRM 写入 ' + generated + '，元数据写入 ' + metadataWritten)
  return summary
}

export async function run(ctx,input={}) {
  if (input.action === 'cleanup_preview' || input.action === 'cleanup_commit') return cleanup(ctx,input)
  const base = await ctx.settings.get(), rules = getRules(base)
  const requests = input.requests || (input.rule_id ? [{rule_id:input.rule_id,full:!!input.full}] : rules.filter(rule=>rule.enabled).map(rule=>({rule_id:rule.id,full:!!input.full})))
  if (!Array.isArray(requests) || !requests.length) throw new Error('没有可执行的同步规则')
  const results=[], failures=[]
  for (const request of requests) {
    const rule = rules.find(item=>item.id===request.rule_id)
    if (!rule) throw new Error('同步规则不存在，请刷新规则列表')
    try {
      results.push(await syncRule(ctx,await loadSettings(ctx),rule,!!request.full))
      if (request.organize_version) await ctx.storage.set('organize_done:' + rule.id,request.organize_version)
    }
    catch(error) { failures.push(rule.name + '：' + error.message); await ctx.storage.set('last_error:' + rule.id,{at:new Date().toISOString(),message:error.message}); await ctx.task.log(rule.name + '：同步失败，' + error.message) }
  }
  if(failures.length) throw new Error(failures.join('；'))
  return {rules:results,generated:results.reduce((sum,item)=>sum+item.generated,0),unchanged:results.reduce((sum,item)=>sum+item.unchanged,0),metadata_written:results.reduce((sum,item)=>sum+item.metadata_written,0)}
}
