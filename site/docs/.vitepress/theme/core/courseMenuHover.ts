/**
 * theme/core/courseMenuHover.ts - Desktop hover-open / delayed-close state helper for NavCourseMenu.
 *
 * Opens the course menu immediately when a desktop mouse/pen pointer hovers the trigger/wrapper,
 * suppresses synthetic hover events triggered by touch taps, promotes a hover-opened menu to
 * explicit/pinned when the trigger is clicked, and applies a short leave grace delay so diagonal
 * pointer movement into the flyout panel does not flicker closed.
 */

export type CourseMenuOpenMode = 'hover' | 'explicit'

export const COURSE_MENU_HOVER_CLOSE_DELAY_MS = 160
export const COURSE_MENU_TOUCH_GUARD_MS = 800

export interface CourseMenuHoverOptions {
  hoverCloseDelayMs?: number
  touchGuardMs?: number
  now?: () => number
  isMobile?: () => boolean
  isOpen: () => boolean
  getMode: () => CourseMenuOpenMode | null
  hasFocusWithin?: () => boolean
  openHover: () => void
  closeHover: () => void
}

export interface CourseMenuHoverController {
  clearTimer: () => void
  reset: () => void
  isTouchBlocked: (ev?: Event) => boolean
  onHoverEnter: (ev?: Event) => void
  onHoverLeave: (ev?: Event) => void
  onFocusIn: () => void
  onFocusOut: (focusRemaining?: boolean) => void
}

export function createCourseMenuHoverController(
  opts: CourseMenuHoverOptions,
): CourseMenuHoverController {
  const hoverCloseDelayMs = opts.hoverCloseDelayMs ?? COURSE_MENU_HOVER_CLOSE_DELAY_MS
  const touchGuardMs = opts.touchGuardMs ?? COURSE_MENU_TOUCH_GUARD_MS
  const now = opts.now ?? (() => Date.now())

  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let lastTouchAt = Number.NEGATIVE_INFINITY
  let pointerInside = false

  function clearTimer(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  function reset(): void {
    pointerInside = false
    clearTimer()
  }

  function isTouchBlocked(ev?: Event): boolean {
    if (ev && 'pointerType' in ev) {
      const pointerType = (ev as PointerEvent).pointerType
      if (pointerType === 'touch') {
        lastTouchAt = now()
        return true
      }
      if (pointerType === 'mouse' || pointerType === 'pen') {
        lastTouchAt = Number.NEGATIVE_INFINITY
        return false
      }
    }
    return now() - lastTouchAt < touchGuardMs
  }

  function scheduleClose(ignoreCurrentFocus = false): void {
    if (!opts.isOpen() || opts.getMode() !== 'hover') return
    if (!ignoreCurrentFocus && opts.hasFocusWithin?.()) {
      clearTimer()
      return
    }
    clearTimer()
    closeTimer = setTimeout(() => {
      closeTimer = null
      if (opts.isOpen() && opts.getMode() === 'hover' && !opts.hasFocusWithin?.()) {
        opts.closeHover()
      }
    }, hoverCloseDelayMs)
  }

  function onHoverEnter(ev?: Event): void {
    if (opts.isMobile?.()) return
    if (isTouchBlocked(ev)) return
    pointerInside = true
    clearTimer()
    if (!opts.isOpen()) {
      opts.openHover()
    }
  }

  function onHoverLeave(ev?: Event): void {
    if (opts.isMobile?.()) return
    if (isTouchBlocked(ev)) return
    pointerInside = false
    scheduleClose(false)
  }

  function onFocusIn(): void {
    clearTimer()
  }

  function onFocusOut(focusRemaining = opts.hasFocusWithin?.() ?? false): void {
    if (opts.isMobile?.()) return
    if (!opts.isOpen() || opts.getMode() !== 'hover') return
    if (pointerInside || focusRemaining) return
    scheduleClose(true)
  }

  return {
    clearTimer,
    reset,
    isTouchBlocked,
    onHoverEnter,
    onHoverLeave,
    onFocusIn,
    onFocusOut,
  }
}
