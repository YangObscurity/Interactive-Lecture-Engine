/**
 * theme/core/focusTrap.ts - Tab / Shift+Tab focus trap for accessible dialogs and panels (WP-F4).
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  )
}

export function trapFocus(container: HTMLElement | null, ev: KeyboardEvent): boolean {
  if (!container || ev.key !== 'Tab') return false

  const focusables = getFocusableElements(container)
  if (focusables.length === 0) {
    ev.preventDefault()
    return true
  }

  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement

  if (ev.shiftKey) {
    if (active === first || !container.contains(active)) {
      ev.preventDefault()
      last?.focus()
      return true
    }
  } else {
    if (active === last || !container.contains(active)) {
      ev.preventDefault()
      first?.focus()
      return true
    }
  }

  return false
}
