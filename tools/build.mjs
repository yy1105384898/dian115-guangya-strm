import { mkdirSync, readFileSync } from 'node:fs'
import { packPlugin } from './pack.mjs'
if (readFileSync('plugin/jobs/clean-rules.js','utf8') !== readFileSync('plugin/ui/shared/clean-rules.js','utf8')) throw new Error('前后台清理规则模块不一致')
const manifest = JSON.parse(readFileSync('plugin/plugin.json','utf8'))
mkdirSync('dist',{recursive:true})
console.log(JSON.stringify(packPlugin('plugin',`dist/guangya-strm-${manifest.version}.dian115p`),null,2))
