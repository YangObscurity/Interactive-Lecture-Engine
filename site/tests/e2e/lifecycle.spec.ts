/**
 * Page lifecycle (V2 P1, plan §6 / §7): one entry point for first load + SPA navigation.
 *
 *   - 10 rounds of SPA navigation over 5 lectures: no pageerror, one lifecycle visit per
 *     navigation, and window listeners do not accumulate (signal-aware listener counter
 *     installed before any page script runs).
 *   - Reading progress: scroll lecture A, leave, come back with a full reload → restored.
 *   - First load of g01/L01: no "Hydration completed but contains mismatches".
 *
 * The debug console is enabled via localStorage `lecture:debug=1` so `__LECTURE_DEBUG__` exposes
 * the `lifecycle` and `reading-progress` panels in the prod build too.
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

const LECTURES = ['/g05/L19', '/g05/L20', '/g01/L01', '/g03/L05', '/lr/L01'] as const
const ROUNDS = 10

interface LifecycleState {
  path: string | null
  generation: number
  mounted: string[]
  pendingDisposers: number
}

declare global {
  interface Window {
    __LISTENER_COUNT__?: Record<string, number>
  }
}

/** Count live window listeners per event type, honouring removeEventListener and AbortSignal. */
async function installListenerCounter(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('lecture:debug', '1')
    } catch {
      /* ignore */
    }
    const counts: Record<string, number> = {}
    const live = new Map<string, Set<unknown>>()
    window.__LISTENER_COUNT__ = counts
    const add = window.addEventListener.bind(window)
    const rm = window.removeEventListener.bind(window)
    const keyOf = (type: string, opts: unknown) =>
      type + '|' + (typeof opts === 'boolean' ? opts : !!(opts as AddEventListenerOptions | undefined)?.capture)
    const drop = (k: string, fn: unknown) => {
      const set = live.get(k)
      if (set?.delete(fn)) counts[k.split('|')[0] as string] = (counts[k.split('|')[0] as string] || 1) - 1
    }
    window.addEventListener = function (type: string, fn: unknown, opts?: unknown) {
      const k = keyOf(type, opts)
      const set = live.get(k) ?? new Set()
      live.set(k, set)
      if (fn && !set.has(fn)) {
        const signal = (opts as AddEventListenerOptions | undefined)?.signal
        if (!signal?.aborted) {
          set.add(fn)
          counts[type] = (counts[type] || 0) + 1
          signal?.addEventListener('abort', () => drop(k, fn), { once: true })
        }
      }
      return add(type, fn as EventListener, opts as AddEventListenerOptions)
    } as typeof window.addEventListener
    window.removeEventListener = function (type: string, fn: unknown, opts?: unknown) {
      drop(keyOf(type, opts), fn)
      return rm(type, fn as EventListener, opts as EventListenerOptions)
    } as typeof window.removeEventListener
  })
}

async function lifecycle(page: Page): Promise<LifecycleState> {
  return page.evaluate(() => window.__LECTURE_DEBUG__?.panel('lifecycle') as LifecycleState)
}

/** SPA navigation: VitePress' router intercepts clicks on same-origin anchors. */
async function spaGo(page: Page, path: string) {
  const before = (await lifecycle(page)).generation
  await page.evaluate((href) => {
    const a = document.createElement('a')
    a.href = href
    a.textContent = 'e2e'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, path)
  await page.waitForURL((u) => u.pathname.replace(/\.html$/, '') === path)
  await expect
    .poll(async () => {
      const s = await lifecycle(page)
      return s.generation > before && s.path === path && s.mounted.includes('charts')
    }, { timeout: 30_000 })
    .toBe(true)
}

const COUNTED = ['scroll', 'wheel', 'mousedown', 'keydown', 'touchstart', 'beforeunload', 'lecture:charts-settled']

test.describe('page lifecycle', () => {
  test('SPA navigation x10 over 5 lectures: no errors, no listener growth', async ({ page, pageErrors }) => {
    test.setTimeout(240_000)
    await installListenerCounter(page)
    await gotoAndSettle(page, LECTURES[0])
    await expect.poll(async () => (await lifecycle(page))?.mounted?.includes('charts')).toBe(true)
    const first = await lifecycle(page)
    expect(first.generation).toBe(1)

    // one full lap so every lazily-imported module has registered its own (app-scope) listeners
    for (const p of [...LECTURES.slice(1), LECTURES[0]]) await spaGo(page, p)
    const baseline = await page.evaluate((types) => types.map((t) => window.__LISTENER_COUNT__?.[t] ?? 0), COUNTED)
    const genAfterLap = (await lifecycle(page)).generation

    for (let round = 0; round < ROUNDS; round++) {
      const p = LECTURES[(round % (LECTURES.length - 1)) + 1] as string
      await spaGo(page, p)
      await spaGo(page, LECTURES[0])
    }

    const end = await lifecycle(page)
    expect(end.generation).toBe(genAfterLap + ROUNDS * 2)
    expect(end.path).toBe(LECTURES[0])
    const after = await page.evaluate((types) => types.map((t) => window.__LISTENER_COUNT__?.[t] ?? 0), COUNTED)
    expect(Object.fromEntries(COUNTED.map((t, i) => [t, after[i]]))).toEqual(
      Object.fromEntries(COUNTED.map((t, i) => [t, baseline[i]]))
    )
    const rp = (await page.evaluate(() => window.__LECTURE_DEBUG__?.panel('reading-progress'))) as {
      activeBindings: number
    }
    expect(rp.activeBindings).toBe(1)
    // charts of the final page rendered (FE-027: no figure left behind by a stale run)
    await expect(page.locator('figure.chart:not([data-rendered])')).toHaveCount(0)
    expect(pageErrors.map((e) => e.message)).toEqual([])
  })

  test('reading progress: scroll, leave, full reload → restored', async ({ page, pageErrors }) => {
    test.setTimeout(120_000)
    await installListenerCounter(page)
    const A = LECTURES[0]
    await page.setViewportSize({ width: 1280, height: 800 })
    await gotoAndSettle(page, A)
    await page.mouse.move(640, 400)
    const target = await page.evaluate(() => Math.round((document.documentElement.scrollHeight - innerHeight) * 0.5))
    // real wheel gestures (programmatic scrolls do not count as "user took over")
    for (let i = 0; i < 200; i++) {
      const y = await page.evaluate(() => scrollY)
      if (y >= target) break
      await page.mouse.wheel(0, Math.min(1200, target - y))
    }
    await expect
      .poll(() =>
        page.evaluate((a) => {
          const s = JSON.parse(localStorage.getItem('lecture-read-pos') || '{}')
          return s[a]?.pct ?? 0
        }, A)
      )
      .toBeGreaterThan(0.3)
    const saved = await page.evaluate((a) => JSON.parse(localStorage.getItem('lecture-read-pos') || '{}')[a], A)
    expect(saved).toMatchObject({ group: 'g05' })
    expect(saved.title.length).toBeGreaterThan(0)

    // leave via SPA navigation: the old path's record must survive the navigation's scroll-to-top
    await spaGo(page, LECTURES[1])
    const kept = await page.evaluate((a) => JSON.parse(localStorage.getItem('lecture-read-pos') || '{}')[a], A)
    expect(kept.pct).toBeCloseTo(saved.pct, 2)

    // come back with a full reload
    await page.goto(A, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('#lecture-resume-hint')).toBeAttached({ timeout: 10_000 })
    await expect
      .poll(
        () =>
          page.evaluate(() => scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)),
        { timeout: 15_000 }
      )
      .toBeGreaterThan(saved.pct - 0.05)
    const frac = await page.evaluate(() => scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight))
    expect(Math.abs(frac - saved.pct)).toBeLessThan(0.05)
    expect(pageErrors.map((e) => e.message)).toEqual([])
  })

  test('first load of g01/L01: no hydration mismatch', async ({ page, consoleErrors, pageErrors }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/hydration/i.test(m.text())) warnings.push(m.text())
    })
    await gotoAndSettle(page, '/g01/L01')
    expect(warnings).toEqual([])
    expect(consoleErrors.filter((t) => /hydration/i.test(t))).toEqual([])
    expect(pageErrors.map((e) => e.message)).toEqual([])
  })
})
