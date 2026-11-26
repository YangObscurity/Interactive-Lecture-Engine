/**
 * core/scrollbar.ts - the auto-hiding page scrollbar (WP-F1, owner request). The look is in styles/base.css (a thin, always
 * reserved 8 px track, so nothing shifts when it appears); this module only sets `data-lec-scrollbar="on"` on <html> while the
 * page scrolls (wheel, touch, keyboard: all of them fire `scroll`), while navigation keys/wheel engage, or while the pointer
 * is within `EDGE_PX` of the right edge / over the scrollbar track, and removes it `HIDE_DELAY_MS` after idle.
 */
export const SCROLLBAR_ATTR = 'data-lec-scrollbar'
export const EDGE_PX = 16
export const HIDE_DELAY_MS = 1000

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', ' ', 'ArrowUp', 'ArrowDown'])

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function installAutoScrollbar(win: Window = window): () => void {
  const doc = win.document
  const root = doc.documentElement
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

  const isInRightEdge = (clientX: number, clientY: number): boolean => {
    const innerW = win.innerWidth || root.clientWidth
    const innerH = win.innerHeight || root.clientHeight
    const edgeStart = Math.max(0, root.clientWidth - EDGE_PX)
    return clientX >= edgeStart && clientX < innerW && clientY >= 0 && clientY < innerH
  }

  const onMove = (e: PointerEvent): void => {
    const nowNear = e.pointerType !== 'touch' && isInRightEdge(e.clientX, e.clientY)
    if (nowNear === near) return
    near = nowNear
    if (near) {
      win.clearTimeout(timer)
      show()
    } else {
      later()
    }
  }

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch' && isInRightEdge(e.clientX, e.clientY)) {
      near = true
      win.clearTimeout(timer)
      show()
    }
  }

  const onLeave = (e?: PointerEvent): void => {
    // Moving onto the native right-side scrollbar gutter fires `document.pointerleave` in Chromium
    // while the pointer is still on the scrollbar track; keep `near` intact for mouse/pen unless it exits the viewport.
    if (e && e.pointerType !== 'touch' && isInRightEdge(e.clientX, e.clientY)) {
      near = true
      win.clearTimeout(timer)
      show()
      return
    }
    if (!near) return
    near = false
    later()
  }

  const onBlur = (): void => {
    if (!near) return
    near = false
    later()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target)) return
    if (SCROLL_KEYS.has(e.key)) onScroll()
  }

  const releaseOrphanBodyLock = (): void => {
    if (doc.body && doc.body.style.overflow === 'hidden') {
      const hasOverlay = Boolean(
        root.classList.contains('chart-modal-open') ||
          doc.querySelector('.VPNavScreen, .VPLocalSearchBox, .VPSidebar.open, .pswp.chart-modal'),
      )
      if (!hasOverlay) doc.body.style.overflow = ''
    }
  }

  const onResize = (): void => {
    releaseOrphanBodyLock()
  }

  let wasModalLocked = root.classList.contains('chart-modal-open')
  let observer: MutationObserver | null = null
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      const isModalLocked = root.classList.contains('chart-modal-open')
      if (wasModalLocked && !isModalLocked) {
        releaseOrphanBodyLock()
        // Nudge Blink root scrollbar repaint cleanly when exiting modal overflow:hidden.
        root.removeAttribute(SCROLLBAR_ATTR)
        void root.clientHeight
        if (root.scrollHeight > root.clientHeight) {
          show()
          later()
        }
      }
      wasModalLocked = isModalLocked
    })
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
  }

  win.addEventListener('scroll', onScroll, { passive: true })
  win.addEventListener('wheel', onScroll, { passive: true })
  win.addEventListener('pointermove', onMove, { passive: true })
  win.addEventListener('pointerdown', onDown, { passive: true })
  win.addEventListener('keydown', onKeyDown, { passive: true })
  win.addEventListener('resize', onResize, { passive: true })
  win.addEventListener('blur', onBlur, { passive: true })
  doc.addEventListener('pointerleave', onLeave as EventListener, { passive: true })

  return () => {
    win.removeEventListener('scroll', onScroll)
    win.removeEventListener('wheel', onScroll)
    win.removeEventListener('pointermove', onMove)
    win.removeEventListener('pointerdown', onDown)
    win.removeEventListener('keydown', onKeyDown)
    win.removeEventListener('resize', onResize)
    win.removeEventListener('blur', onBlur)
    doc.removeEventListener('pointerleave', onLeave as EventListener)
    observer?.disconnect()
    win.clearTimeout(timer)
    root.removeAttribute(SCROLLBAR_ATTR)
  }
}
