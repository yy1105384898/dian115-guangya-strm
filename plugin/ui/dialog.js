export function element(doc, tag, cls, text) {
  const node = doc.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
const stack = []
export function dialog(app, title, wide = false, options = {}) {
  const doc = app.ownerDocument, previous = doc.activeElement
  const anchor = options.anchor, win = doc.defaultView
  const overlay = element(doc, 'div', 'overlay'), panel = element(doc, 'div', 'dialog' + (wide ? ' rule-dialog' : ''))
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title)
  if (anchor) {
    overlay.classList.add('confirmation-layer'); panel.classList.add('confirmation-popover')
    panel.setAttribute('aria-modal', 'false')
  }
  const head = element(doc, 'div', 'card-head'), closeButton = element(doc, 'button', '', '✕')
  closeButton.setAttribute('aria-label', '关闭弹窗')
  head.append(element(doc, 'h3', '', title), closeButton)
  const body = element(doc, 'div', 'dialog-body'), footer = element(doc, 'div', 'dialog-foot')
  if (!anchor) panel.append(head)
  panel.append(body, footer); overlay.append(panel); app.append(overlay)
  let closed = false, locked = false
  function position() {
    if (!anchor || closed) return
    const rect = anchor.getBoundingClientRect(), width = panel.offsetWidth, height = panel.offsetHeight
    const left = Math.max(12, Math.min(rect.right - width, win.innerWidth - width - 12))
    const below = rect.top < height + 22
    panel.style.left = left + 'px'
    panel.style.top = Math.max(12, Math.min(below ? rect.bottom + 10 : rect.top - height - 10, win.innerHeight - height - 12)) + 'px'
    panel.style.setProperty('--arrow-left', Math.max(18, Math.min(rect.left + rect.width / 2 - left, width - 18)) + 'px')
    panel.classList.toggle('below', below)
  }
  const outside = e => { if (!panel.contains(e.target) && !anchor?.contains(e.target)) close() }
  const onKey = e => {
    if (stack[stack.length - 1] !== modal) return
    if (e.key === 'Escape') { e.preventDefault(); close() }
    if (e.key === 'Tab' && !anchor) {
      const controls = [...panel.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href]')].filter(n => n.getClientRects().length)
      const first = controls[0], last = controls[controls.length - 1]
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first?.focus() }
    }
  }
  function close(force = false) {
    if (closed || locked && !force) return
    closed = true; overlay.remove(); doc.removeEventListener('keydown', onKey)
    doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('scroll', position, true); win.removeEventListener('resize', position)
    const index = stack.indexOf(modal); if (index >= 0) stack.splice(index, 1)
    if (previous?.isConnected) previous.focus()
    modal.onClose?.()
  }
  const modal = { body, footer, panel, close, position, get closed() { return closed }, lock(value) { locked = value; closeButton.disabled = value }, onClose: null }
  stack.push(modal); closeButton.onclick = () => close(); overlay.onclick = e => { if (e.target === overlay) close() }; doc.addEventListener('keydown', onKey); closeButton.focus()
  if (anchor) {
    doc.addEventListener('pointerdown', outside, true); doc.addEventListener('scroll', position, true); win.addEventListener('resize', position)
    position()
  }
  return modal
}
export function closeDialogs(app) { for (const modal of [...stack].reverse()) if (app.contains(modal.panel)) modal.close(true) }
