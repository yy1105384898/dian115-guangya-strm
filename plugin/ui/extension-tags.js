import { element } from './dialog.js'
import { normalizeExtensions } from './shared/rules.js'

export function extensionTags(container, value, presets = []) {
  const doc=container.ownerDocument, node=(tag,cls,text)=>element(doc,tag,cls,text)
  const selected=new Set(normalizeExtensions(value).split(',').filter(Boolean)), presetRow=node('div','inline'), list=node('div','suffix-tags'), entry=node('div','suffix-entry'), input=node('input'), add=node('button','','添加'), toggle=node('button','suffix-add','＋')
  const error=node('small','errorbox'); error.setAttribute('role','status')
  input.placeholder='例如 .mkv，多个用逗号分隔'; input.setAttribute('aria-label','添加后缀'); entry.hidden=true; entry.append(input,add)
  function commit() {
    const values=normalizeExtensions(input.value).split(',').filter(Boolean)
    if(values.some(ext=>!/^[a-z0-9]{1,16}$/.test(ext))) {error.textContent='后缀只能包含 1–16 位字母和数字';return}
    for(const ext of values) selected.add(ext)
    input.value='';entry.hidden=true;error.textContent='';render();toggle.focus()
  }
  const buttons=presets.map(preset=>{
    const button=node('button','suffix-preset',preset.label)
    button.setAttribute('role','checkbox')
    button.onclick=()=>{const values=normalizeExtensions(preset.extensions).split(',').filter(Boolean),all=values.every(ext=>selected.has(ext));for(const ext of values)all?selected.delete(ext):selected.add(ext);render()}
    presetRow.append(button);return{button,values:normalizeExtensions(preset.extensions).split(',').filter(Boolean)}
  })
  function render(){
    list.replaceChildren()
    for(const ext of selected){const chip=node('span','suffix-tag'),remove=node('button','','×');remove.setAttribute('aria-label','移除 .'+ext);remove.onclick=()=>{selected.delete(ext);render()};chip.append(node('span','','.'+ext),remove);list.append(chip)}
    list.append(toggle)
    for(const {button,values}of buttons){const all=values.every(ext=>selected.has(ext));button.classList.toggle('selected',all);button.setAttribute('aria-checked',String(all))}
  }
  toggle.onclick=()=>{entry.hidden=!entry.hidden;if(!entry.hidden)input.focus()}
  add.onclick=commit;input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commit()}}
  if(presets.length)container.append(presetRow)
  container.append(list,entry,error);render()
  return{getValue:()=>normalizeExtensions([...selected,input.value].join(','))}
}
