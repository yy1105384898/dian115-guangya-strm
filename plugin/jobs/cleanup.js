import { loadSettings } from './auth.js'
import { getRules, validateRule } from './rules.js'
import { scanRule } from './scanner.js'
import { assertLocalOutput, localHash, outputPath, ownedOutputs } from './output.js'

function inScope(path, rule, record) {
  const root = rule.output_path.replace(/\/+$/, '')
  if (!path.startsWith(root + '/') || path.split('/').some(part=>part==='.'||part==='..')) return false
  if (!['strm','metadata'].includes(record?.kind) || !/^[a-f0-9]{64}$/i.test(record.hash || '')) return false
  if (record.legacy && rule.excluded_paths?.length) return false
  if (record.kind==='strm' && (!rule.generate_strm || !path.endsWith('.strm'))) return false
  if (record.kind==='metadata' && rule.metadata_mode==='off') return false
  return !(rule.excluded_paths || []).some(excluded=>record.rawPath===excluded || record.rawPath?.startsWith(excluded+'/'))
}
async function liveOutputs(ctx,settings,rule) {
  const scan = await scanRule(ctx,settings,rule), live = new Set()
  // Preserve existing source files even if their extension is no longer selected.
  for (const file of scan.files) { live.add(outputPath(rule.output_path,file,true)); live.add(outputPath(rule.output_path,file)) }
  return live
}
export async function cleanup(ctx,input) {
  let plan
  if (input.action==='cleanup_commit') {
    if (input.confirmed !== true) throw new Error('请先查看清理清单并明确确认删除')
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.plan_id || '')) throw new Error('清理预览标识无效')
    plan = await ctx.storage.get('cleanup_plan:'+input.plan_id)
    if (!plan || plan.used || Date.now()-plan.created_at>600000) throw new Error('清理清单已过期或已执行，请重新预览')
  }
  const settings=await loadSettings(ctx), rules=getRules(settings)
  const found=rules.find(rule=>rule.id===(plan?.rule_id || input.rule_id))
  if (!found) throw new Error('规则不存在')
  const rule=validateRule(found,rules), config=ctx.crypto.sha256(JSON.stringify(rule))
  if (plan && plan.config!==config) throw new Error('规则已更改，请重新生成清理清单')
  await assertLocalOutput(ctx,rule.output_path)
  const live=await liveOutputs(ctx,settings,rule), owned=await ownedOutputs(ctx,rule)
  if (!plan) {
    const candidates=[]
    let skipped=0
    for (const [path,record] of Object.entries(owned)) {
      if (!inScope(path,rule,record) || live.has(path)) continue
      if (!await ctx.files.call({operation:'exists',path})) continue
      const stat=await ctx.files.call({operation:'stat',path})
      if (!stat || stat.is_dir) { skipped++; continue }
      await assertLocalOutput(ctx,path.slice(0,path.lastIndexOf('/')))
      if (await localHash(ctx,path)!==record.hash.toLowerCase()) { skipped++; continue }
      candidates.push({path,hash:record.hash.toLowerCase(),kind:record.kind})
    }
    const id=ctx.crypto.randomUUID().replace(/-/g,'')
    plan={id,rule_id:rule.id,rule_name:rule.name,root:rule.output_path,config,created_at:Date.now(),candidates,skipped,used:false}
    await ctx.storage.set('cleanup_plan:'+id,plan)
    await ctx.task.update({stage:'preview',message:'清理预览完成：'+candidates.length+' 个候选文件，未删除任何文件'})
    return {cleanup_plan:id,count:candidates.length,skipped,rule_name:rule.name}
  }
  plan.used=true; await ctx.storage.set('cleanup_plan:'+plan.id,plan)
  let removed=0,skipped=0
  try {
    for (const candidate of plan.candidates) {
      const record=owned[candidate.path]
      if (!record || record.hash.toLowerCase()!==candidate.hash || !inScope(candidate.path,rule,record) || live.has(candidate.path)) { skipped++; continue }
      if (!await ctx.files.call({operation:'exists',path:candidate.path})) { skipped++; continue }
      const stat=await ctx.files.call({operation:'stat',path:candidate.path})
      if (!stat || stat.is_dir) { skipped++; continue }
      await assertLocalOutput(ctx,candidate.path.slice(0,candidate.path.lastIndexOf('/')))
      if (await localHash(ctx,candidate.path)!==candidate.hash) { skipped++; continue }
      await ctx.files.call({operation:'remove',path:candidate.path,progress:false})
      delete owned[candidate.path]; removed++
      await ctx.task.update({stage:'cleanup',message:rule.name+'：清理 '+removed+' 个孤立文件，跳过 '+skipped,total:plan.candidates.length,done:removed+skipped})
    }
  } finally { await ctx.storage.set('owned:'+rule.id,owned) }
  await ctx.task.log(rule.name+'：清理完成，删除 '+removed+' 个插件输出文件，跳过 '+skipped+' 个；未删除目录')
  return {cleanup_removed:removed,cleanup_skipped:skipped,rule_name:rule.name}
}
