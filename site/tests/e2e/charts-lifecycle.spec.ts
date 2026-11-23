/**
 * Chart lifecycle under SPA navigation (V2 P1 exit criterion, plan §7 / §8):
 *   - 10 round trips across 5 charted lectures: every figure renders on every visit, the live
 *     ECharts instance count (debug panel `charts`) always equals the page's ECharts figures
 *     (i.e. it does not grow), `__CHARTS_DONE__` is true per visit, no pageerror;
 *   - navigating away mid-render (second click immediately after the first) still renders the
 *     destination page completely.
 *
 * Requires theme/index.ts to mount `chartsFeature` from theme/charts (the debug panel `charts`
 * is registered by that module). Debug console is enabled via localStorage `lecture:debug=1`.
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

const LECTURES = ['/mea/L01', '/mea/L05', '/log/L01', '/pln/L02', '/dat/L01'] as const
const ROUNDS = 10

interface ChartsPanel {
  generation: number
  live: Record<string, number>
  lastSettle: { path: string; count: number } | null
}

interface Snapshot {
  path: string
  done: boolean | undefined
  total: number
  unrendered: number
  notOk: string[]
  echartsFigs: number
  liveEcharts: number
  generation: number
}

const isBackendNoise = (t: string) => /Failed to load resource.*\b503\b/.test(t)

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __CHARTS_DONE__?: boolean
      __LECTURE_DEBUG__?: { panel(id: string): unknown }
    }
    const panel = w.__LECTURE_DEBUG__?.panel('charts') as ChartsPanel | undefined
    const figs = [...document.querySelectorAll<HTMLElement>('figure.chart:not(.chart--modal)')]
    return {
      path: location.pathname,
      done: w.__CHARTS_DONE__,
      total: figs.length,
      unrendered: figs.filter((f) => !f.hasAttribute('data-rendered')).length,
      notOk: figs
        .filter((f) => f.dataset.chartStatus !== 'ok')
        .map((f) => `${f.id || f.dataset.id}=${f.dataset.chartStatus ?? 'none'}`),
      echartsFigs: figs.filter((f) => f.dataset.type === 'echarts').length,
      // the panel lists only renderer kinds that have lived on this site: no `echarts` key = none alive
      liveEcharts: panel ? (panel.live.echarts ?? 0) : -1,
      generation: panel?.generation ?? -1,
    }
  })
}

/** Arm a one-shot listener for `lecture:charts-settled` of `target`, then SPA-click to it. */
async function armAndClick(page: Page, target: string): Promise<void> {
  await page.evaluate((u) => {
    const w = window as unknown as { __e2eSettled?: Record<string, Promise<unknown>> }
    w.__e2eSettled = w.__e2eSettled ?? {}
    w.__e2eSettled[u] = new Promise((resolve) => {
      const on = (e: Event) => {
        const d = (e as CustomEvent<{ path?: string }>).detail
        if (d?.path === u) {
          window.removeEventListener('lecture:charts-settled', on)
          resolve(d)
        }
      }
      window.addEventListener('lecture:charts-settled', on)
    })
    const a = document.createElement('a')
    a.href = u
    a.textContent = 'e2e-nav'
    const host = document.querySelector('.vp-doc') ?? document.body
    host.appendChild(a)
    a.click()
  }, target)
}

async function waitSettled(page: Page, target: string): Promise<void> {
  await page.evaluate(
    (u) =>
      Promise.race([
        (window as unknown as { __e2eSettled: Record<string, Promise<unknown>> }).__e2eSettled[u],
        new Promise((_, reject) => setTimeout(() => reject(new Error('charts-settled timeout: ' + u)), 30_000)),
      ]),
    target,
  )
}

async function assertFullyRendered(page: Page, target: string): Promise<Snapshot> {
  const s = await snapshot(page)
  expect(s.path.replace(/\.html$/, ''), 'url').toBe(target)
  expect(s.total, `${target}: has charts`).toBeGreaterThan(0)
  expect(s.unrendered, `${target}: unrendered figures`).toBe(0)
  expect(s.notOk, `${target}: figures not ok`).toEqual([])
  expect(s.done, `${target}: __CHARTS_DONE__`).toBe(true)
  expect(s.liveEcharts, `${target}: live ECharts instances = ECharts figures`).toBe(s.echartsFigs)
  return s
}

test.describe('charts lifecycle (SPA)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('lecture:debug', '1')
      } catch {
        /* ignore */
      }
    })
  })

  test(`${ROUNDS} round trips over ${LECTURES.length} charted lectures keep instance count flat`, async ({
    page,
    pageErrors,
    consoleErrors,
  }) => {
    test.setTimeout(6 * 60_000)
    const first = LECTURES[0]
    expect(await gotoAndSettle(page, first), '__CHARTS_DONE__ on first load').toBe(true)
    const panelOk = await page.evaluate(() => {
      const w = window as unknown as { __LECTURE_DEBUG__?: { panels(): string[] } }
      return !!w.__LECTURE_DEBUG__?.panels().includes('charts')
    })
    expect(panelOk, 'debug panel "charts" registered (theme must mount theme/charts chartsFeature)').toBe(true)
    await assertFullyRendered(page, first)

    const perPage = new Map<string, number>()
    const route = [...LECTURES.slice(1), ...LECTURES.slice(0, -1).reverse()] // forth and back
    for (let round = 0; round < ROUNDS; round++) {
      for (const target of route) {
        await armAndClick(page, target)
        await waitSettled(page, target)
        const s = await assertFullyRendered(page, target)
        const prev = perPage.get(target)
        if (prev !== undefined) expect(s.liveEcharts, `${target}: same instance count every visit`).toBe(prev)
        perPage.set(target, s.liveEcharts)
      }
    }

    expect(pageErrors.map((e) => e.message)).toEqual([])
    expect(consoleErrors.filter((t) => !isBackendNoise(t))).toEqual([])
  })

  test('navigating away mid-render still renders the destination fully', async ({ page, pageErrors }) => {
    test.setTimeout(3 * 60_000)
    await gotoAndSettle(page, '/mea/L05')
    for (let i = 0; i < 3; i++) {
      const [mid, dest] = i % 2 === 0 ? (['/log/L01', '/dat/L01'] as const) : (['/dat/L01', '/log/L01'] as const)
      await armAndClick(page, mid)
      // do not wait: leave `mid` while its charts are still loading
      await page.waitForFunction((u) => location.pathname.replace(/\.html$/, '') === u, mid)
      await armAndClick(page, dest)
      await waitSettled(page, dest)
      await assertFullyRendered(page, dest)
    }
    expect(pageErrors.map((e) => e.message)).toEqual([])
  })
})
