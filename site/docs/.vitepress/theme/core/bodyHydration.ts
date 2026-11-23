/**
 * core/bodyHydration.ts — coordinate async page-body components (HomeBody, GroupIndex)
 * with root Layout hydration so post-hydration stores (access/progress) never mutate
 * `siteData` before an async SSR boundary has finished hydrating.
 */
import { nextTick } from 'vue'

export const BODY_HYDRATION_TIMEOUT_MS = 5000

let pending = 0
const waiters: Array<() => void> = []

export function beginBodyHydration(): void {
  if (typeof window === 'undefined') return
  pending++
}

export function endBodyHydration(): void {
  if (typeof window === 'undefined') return
  if (pending > 0) pending--
  if (pending === 0 && waiters.length > 0) {
    const list = waiters.splice(0)
    void nextTick(() => {
      for (const r of list) r()
    })
  }
}

export function waitForBodyHydration(timeoutMs = BODY_HYDRATION_TIMEOUT_MS): Promise<void> {
  if (typeof window === 'undefined' || pending === 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve()
    }
    waiters.push(finish)
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        if (settled) return
        const stuck = pending
        pending = 0
        console.warn(
          `[lecture-theme] body hydration timed out after ${timeoutMs}ms with ${stuck} pending component(s); continuing site init.`,
        )
        const list = waiters.splice(0)
        for (const r of list) r()
      }, timeoutMs)
    }
  })
}

/** Test helper: reset pending hydration counter and waiters between tests. */
export function __resetBodyHydrationForTests(): void {
  pending = 0
  waiters.length = 0
}
