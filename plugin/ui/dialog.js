export function element(doc, tag, cls, text) {
  const node = doc.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
const stack = []
export function dialog(app, title, wide = false) {
  const doc = app.ownerDocument, previous = doc.activeElement
  const overlay = element(doc, 'div', 'overlay'), panel = element(doc, 'div', 'dialog' + (wide ? ' rule-dialog' : ''))
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title)
  const head = element(doc, 'div', 'card-head'), closeButton = element(doc, 'button', '', '✕')
  closeButton.setAttribute('aria-label', '关闭弹窗')
  head.append(element(doc, 'h3', '', title), closeButton)
  const body = element(doc, 'div', 'dialog-body'), footer = element(doc, 'div', 'dialog-foot')
  panel.append(head, body, footer); overlay.append(panel); app.append(overlay)
  let closed = false, locked = false
  const onKey = e => {
    if (stack[stack.length - 1] !== modal) return
    if (e.key === 'Escape') { e.preventDefault(); close() }
    if (e.key === 'Tab') {
      const controls = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href]')].filter(n => n.getClientRects().length)
      const first = controls[0], last = controls[controls.length - 1]
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first?.focus() }
    }
  }
  function close(force = false) {
    if (closed || locked && !force) return
    closed = true; overlay.remove(); doc.removeEventListener('keydown', onKey)
    const index = stack.indexOf(modal); if (index >= 0) stack.splice(index, 1)
    previous?.focus(); modal.onClose?.()
  }
  const modal = { body, footer, panel, close, get closed() { return closed }, lock(value) { locked = value; closeButton.disabled = value }, onClose: null }
  stack.push(modal); closeButton.onclick = () => close(); overlay.onclick = e => { if (e.target === overlay) close() }; doc.addEventListener('keydown', onKey); closeButton.focus()
  return modal
}
export function closeDialogs(app) { for (const modal of [...stack].reverse()) if (app.contains(modal.panel)) modal.close(true) }
