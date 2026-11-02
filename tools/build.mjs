import { mkdirSync, readFileSync } from 'node:fs'
import { packPlugin } from './pack.mjs'
const manifest = JSON.parse(readFileSync('plugin/plugin.json','utf8'))
mkdirSync('dist',{recursive:true})
console.log(JSON.stringify(packPlugin('plugin',`dist/guangya-strm-${manifest.version}.dian115p`),null,2))
