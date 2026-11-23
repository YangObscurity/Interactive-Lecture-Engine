/**
 * map/clickRule.ts - the click / double-click arbitration of the map (P4a WP-H1; prototype v17 `later`).
 *
 * One rule for lectures and groups: a SINGLE click opens (the lecture, the group page) but only after the double-click
 * window has passed without a second click; a DOUBLE click looks closer and cancels the pending single click. Pure
 * (timers are injectable), no DOM, no Vue: tests/unit/map-click-rule.test.ts.
 */

/** The wait before a single click acts: long enough for a second click, in ms (prototype: 260). */
export const CLICK_DELAY_MS = 260

export interface ClickRuleOptions {
  /** Default `CLICK_DELAY_MS`. */
  delay?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface ClickRule {
  /** Run `single` after the delay unless another click or a double click comes first (a newer click replaces the pending one). */
  click(single: () => void): void
  /** Cancel the pending single click and run `double` at once. */
  dblclick(double: () => void): void
  /** Cancel the pending single click. */
  cancel(): void
  /** True while a single click is waiting. */
  pending(): boolean
}

export function createClickRule(options: ClickRuleOptions = {}): ClickRule {
  const delay = options.delay ?? CLICK_DELAY_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let handle: unknown = null
  let waiting = false
  const cancel = (): void => {
    if (waiting) clearTimer(handle)
    handle = null
    waiting = false
  }
  return {
    click(single) {
      cancel()
      waiting = true
      handle = setTimer(() => {
        handle = null
        waiting = false
        single()
      }, delay)
    },
    dblclick(double) {
      cancel()
      double()
    },
    cancel,
    pending: () => waiting,
  }
}
