/**
 * core/scrollbar.ts - the auto-hiding page scrollbar (WP-F1, owner request). The look is in styles/base.css (a thin, always
 * reserved 8 px track, so nothing shifts when it appears); this module only sets `data-lec-scrollbar="on"` on <html> while the
 * page scrolls (wheel, touch, keyboard: all of them fire `scroll`) and while the pointer is within `EDGE_PX` of the right edge,
 * and removes it `HIDE_DELAY_MS` after the last such moment. Scrolling itself is never touched (passive listeners only).
 */
export const SCROLLBAR_ATTR = 'data-lec-scrollbar'
export const EDGE_PX = 16
export const HIDE_DELAY_MS = 1000

export function installAutoScrollbar(win: Window = window): () => void {
  const root = win.document.documentElement
  let timer = 0
  let near = false
  const show = (): void => {
    if (root.getAttribute(SCROLLBAR_ATTR) !== 'on') root.setAttribute(SCROLLBAR_ATTR, 'on')
  }
  const later = (): void => {
    win.clearTimeout(timer)
    timer = win.setTimeout(() => {
      if (!near) root.removeAttribute(SCROLLBAR_ATTR)
    }, HIDE_DELAY_MS)
  }
  const onScroll = (): void => {
    show()
    later()
  }
  const onMove = (e: PointerEvent): void => {
    const nowNear = e.pointerType !== 'touch' && e.clientX >= root.clientWidth - EDGE_PX
    if (nowNear === near) return
    near = nowNear
    if (near) {
      win.clearTimeout(timer)
      show()
    } else later()
  }
  const onLeave = (): void => {
    if (!near) return
    near = false
    later()
  }
  win.addEventListener('scroll', onScroll, { passive: true })
  win.addEventListener('pointermove', onMove, { passive: true })
  win.document.addEventListener('pointerleave', onLeave, { passive: true })
  return () => {
    win.removeEventListener('scroll', onScroll)
    win.removeEventListener('pointermove', onMove)
    win.document.removeEventListener('pointerleave', onLeave)
    win.clearTimeout(timer)
    root.removeAttribute(SCROLLBAR_ATTR)
  }
}
