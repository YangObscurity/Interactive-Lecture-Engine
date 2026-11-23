/**
 * Component slots (P2e): the cross-theme contract of the first slot, `SidebarStatus`.
 *
 * One set of behaviour assertions runs once per enabled theme (the theme is chosen through `lecture:reader-prefs`,
 * like a reader would): add a row to THEMES when a theme ships its own implementation.
 *
 *   - every lecture link in the sidebar has exactly one status marker, and nothing else has one;
 *   - `data-status` matches the progress store (three states, made with a mocked backend);
 *   - the marker has an accessible name (the i18n label) and the link keeps its text;
 *   - `data-slot-impl` is the theme's implementation (engine default, or the theme's own component);
 *   - switching the theme after load replaces the component, and no hydration warning appears (cold load or switch).
 *
 * Also: two sidebar screenshots (new baselines, spec board section 05) and a measurement of the time between the
 * slot runtime starting on mount and the swapped component being in the DOM (reader preference on a datasheet site).
 * The real backend is never reached: every `/api/**` request goes to the fixtures, the progress read to a local mock.
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme, type Mode, type ThemeId } from './theme-helpers'

/** theme -> `data-slot-impl` its SidebarStatus must report. reader has no component of its own: the engine default. */
const THEMES: ReadonlyArray<readonly [ThemeId, string]> = [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
]
const LECTURE = '/g05/L19'
const LABEL = { not_started: '未读', in_progress: '在读', completed: '已读' } as const
type Status = keyof typeof LABEL
const WIRE: Record<Status, string> = { not_started: '未开始', in_progress: '学习中', completed: '已完成' }

/** Deterministic states for g05-l01 .. g05-l60: l % 3 = 0 completed, 1 in progress, 2 not started. */
function stateOf(n: number): Status {
  return n % 3 === 0 ? 'completed' : n % 3 === 1 ? 'in_progress' : 'not_started'
}

/** Server records for the sidebar's group. A server record beats the graph seed, so every lecture has a known state. */
async function mockProgress(page: Page): Promise<void> {
  const records = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1
    const status = stateOf(n)
    return {
      lecture_id: `g05-l${String(n).padStart(2, '0')}`,
      group_id: 'g05',
      status: WIRE[status],
      completed_at: status === 'completed' ? '2026-11-01T00:00:00.000Z' : null,
      updated_at: '2026-11-01T00:00:00.000Z',
      notion_node_id: null,
      notion_page_id: null,
    }
  })
  await page.context().route(/\/api\/db\/progress(\/|\?|$)/, (route) => {
    const req = route.request()
    if (req.method() !== 'GET') {
      // writes (the progress card test): accept and echo, nothing is stored
      const body = (req.postDataJSON() ?? {}) as { status?: string }
      const id = new URL(req.url()).pathname.split('/').pop() ?? ''
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ lecture_id: id, group_id: 'g05', status: body.status ?? WIRE.not_started, completed_at: null, updated_at: new Date().toISOString(), notion_node_id: null, notion_page_id: null }),
      })
    }
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(records) })
  })
}

/** Hydration complaints of Vue or the browser, from either console channel. */
function watchHydration(page: Page): string[] {
  const out: string[] = []
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && /hydrat/i.test(m.text())) out.push(m.text())
  })
  return out
}

async function storeReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __LECTURE_DEBUG__?: { panel(id: string): unknown } }
          const p = w.__LECTURE_DEBUG__?.panel('progress') as { ready?: boolean; unfilteredGet?: boolean | null } | undefined
          return Boolean(p?.ready && p.unfilteredGet !== null)
        }),
      { message: 'progress store ready' },
    )
    .toBe(true)
}

/** Open the lecture page with the theme preference, the progress mock and the debug console (for the store panel). */
async function open(page: Page, theme: ThemeId, mode: Mode = 'light'): Promise<void> {
  await useTheme(page, theme, mode)
  await mockProgress(page)
  await page.context().addInitScript(() => localStorage.setItem('lecture:debug', '1'))
  await gotoAndSettle(page, LECTURE)
  await storeReady(page)
}

const links = (page: Page) => page.locator('.VPSidebar a.link')
const markers = (page: Page) => page.locator('.VPSidebar [data-slot="SidebarStatus"]')

interface LinkInfo {
  href: string
  markers: number
  status: string | null
  impl: string | null
  label: string | null
  role: string | null
  text: string
}

async function readLinks(page: Page): Promise<LinkInfo[]> {
  return links(page).evaluateAll((as) =>
    as.map((a) => {
      const ms = a.querySelectorAll('[data-slot="SidebarStatus"]')
      const m = ms[0]
      return {
        href: a.getAttribute('href') ?? '',
        markers: ms.length,
        status: m?.getAttribute('data-status') ?? null,
        impl: m?.getAttribute('data-slot-impl') ?? null,
        label: m?.getAttribute('aria-label') ?? null,
        role: m?.getAttribute('role') ?? null,
        text: (a.querySelector('.text')?.textContent ?? '').trim(),
      }
    }),
  )
}

const lectureNo = (href: string): number => Number(/\/L(\d+)/i.exec(href)?.[1] ?? NaN)

for (const [theme, impl] of THEMES) {
  test.describe(`SidebarStatus contract: ${theme}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })
    // runs under dev as well: the dev failure was the fixtures' `**/api/**` glob answering the dev server's
    // source modules (`/.vitepress/theme/api/*.ts`) with mock JSON; fixtures.ts now matches only `/api/...` paths

    test('one marker per lecture link, state from the store, accessible name, theme implementation', async ({ page, pageErrors }) => {
      const hydration = watchHydration(page)
      await open(page, theme)
      await expect(page.locator('html')).toHaveAttribute('data-lec-theme', theme)

      // the implementation can swap after mount: wait for it, then everything must agree
      await expect.poll(async () => (await readLinks(page)).every((l) => l.impl === impl), { message: `every marker is the ${impl} implementation` }).toBe(true)
      await expect.poll(async () => (await readLinks(page)).every((l) => l.status === stateOf(lectureNo(l.href))), { message: 'markers follow the store' }).toBe(true)

      const infos = await readLinks(page)
      expect(infos.length).toBeGreaterThan(10)
      for (const l of infos) {
        expect(l.markers, `${l.href}: markers inside the link`).toBe(1)
        expect(l.text, `${l.href}: the link keeps its text`).not.toBe('')
        expect(l.role, `${l.href}: role`).toBe('img')
        expect(l.label, `${l.href}: accessible name`).toBe(LABEL[stateOf(lectureNo(l.href))])
      }
      // all three states occur, and the markers are exactly the lecture links (group titles / other links have none)
      expect(new Set(infos.map((l) => l.status))).toEqual(new Set(['not_started', 'in_progress', 'completed']))
      await expect(markers(page)).toHaveCount(infos.length)
      await expect(page.locator('.VPSidebar [data-slot="SidebarStatus"]:not(a *)')).toHaveCount(0)

      // reachable by role + name, the way a screen reader lists it
      for (const status of Object.keys(LABEL) as Status[]) {
        const expected = infos.filter((l) => l.status === status).length
        await expect(page.locator('.VPSidebar').getByRole('img', { name: LABEL[status], exact: true })).toHaveCount(expected)
      }
      // the current page's link is the active one and carries the current marker state
      const active = page.locator('.VPSidebar .VPSidebarItem.is-active a.link')
      await expect(active).toHaveCount(1)
      await expect(active.locator('[data-slot="SidebarStatus"]')).toHaveAttribute('data-status', stateOf(19))

      expect(hydration, 'hydration warnings').toEqual([])
      expect(pageErrors.map((e) => e.message)).toEqual([])
    })

    test('switching the theme after load replaces the component; no hydration warning', async ({ page }) => {
      const hydration = watchHydration(page)
      await open(page, theme)
      await expect.poll(async () => (await readLinks(page)).every((l) => l.impl === impl)).toBe(true)

      for (const [other, otherImpl] of THEMES) {
        if (other === theme) continue
        // what the settings panel does: write the preference and apply the attribute
        await page.evaluate((t) => {
          localStorage.setItem('lecture:reader-prefs', JSON.stringify({ theme: t }))
          document.documentElement.setAttribute('data-lec-theme', t)
        }, other)
        await expect.poll(async () => (await readLinks(page)).every((l) => l.impl === otherImpl), { message: `replaced by ${otherImpl}` }).toBe(true)
        // the state survived the swap
        expect((await readLinks(page)).every((l) => l.status === stateOf(lectureNo(l.href)))).toBe(true)
        // and back
        await page.evaluate((t) => document.documentElement.setAttribute('data-lec-theme', t), theme)
        await expect.poll(async () => (await readLinks(page)).every((l) => l.impl === impl), { message: `back to ${impl}` }).toBe(true)
      }
      expect(hydration, 'hydration warnings').toEqual([])
    })

    test('a status change in the store reaches the marker of the current lecture', async ({ page }) => {
      await open(page, theme)
      await expect.poll(async () => (await readLinks(page)).every((l) => l.impl === impl)).toBe(true)
      const marker = page.locator('.VPSidebar .VPSidebarItem.is-active a.link [data-slot="SidebarStatus"]')
      await expect(marker).toHaveAttribute('data-status', 'in_progress')
      // the progress card on the lecture page writes through the store (optimistic: the marker follows at once)
      await page.locator('.lpc-seg-btn', { hasText: '已完成' }).click()
      await expect(marker).toHaveAttribute('data-status', 'completed')
      await expect(marker).toHaveAttribute('aria-label', LABEL.completed)
      await page.locator('.lpc-seg-btn', { hasText: '未开始' }).click()
      await expect(marker).toHaveAttribute('data-status', 'not_started')
      await expect(marker).toHaveAttribute('aria-label', LABEL.not_started)
      await expect(marker).toHaveAttribute('data-slot-impl', impl)
    })

    test('P5 reading slots (LectureTitleBlock, FigureFrame, QuizHeader) render and survive skin swap without re-mounting charts', async ({ page, pageErrors }) => {
      const hydration = watchHydration(page)
      await open(page, theme)

      // 1. LectureTitleBlock in #doc-before, matching active skin
      const tb = page.locator('.VPDoc [data-slot="LectureTitleBlock"]')
      await expect(tb).toHaveCount(1)
      await expect(tb).toHaveAttribute('data-slot-impl', impl)
      await expect(tb.locator('.lec-tb-code')).toContainText('G05-L19')
      await expect(tb.locator('.lec-tb-spec code')).toHaveText('db_joins')
      await expect(tb.locator('.lec-tb-status')).toHaveAttribute('data-status', 'in_progress')

      // 2. FigureFrame on every figure.chart; record existing chart-body elements before switching theme
      const figures = page.locator('figure.chart')
      const figCount = await figures.count()
      expect(figCount).toBeGreaterThan(0)
      await expect(page.locator('figure.chart [data-slot="FigureFrame"]')).toHaveCount(figCount)
      await expect(page.locator(`figure.chart [data-slot="FigureFrame"][data-slot-impl="${impl}"]`)).toHaveCount(figCount)
      await page.evaluate(() => {
        document.querySelectorAll('figure.chart .chart-body').forEach((b, i) => ((b as HTMLElement).dataset.keepId = String(i)))
      })

      // 3. QuizHeader above every details.details.custom-block, never inside > :not(summary)
      const quizDetails = page.locator('.vp-doc details.details.custom-block')
      const quizCount = await quizDetails.count()
      expect(quizCount).toBeGreaterThan(0)
      await expect(page.locator(`.vp-doc [data-slot="QuizHeader"][data-slot-impl="${impl}"]`)).toHaveCount(quizCount)
      expect(await page.locator('.vp-doc details.details [data-slot="QuizHeader"]').count()).toBe(0)

      // 4. Runtime skin swap updates all 3 reading slots while leaving chart-body DOM nodes untouched
      const [other, otherImpl] = THEMES.find(([t]) => t !== theme)!
      await page.evaluate((t) => document.documentElement.setAttribute('data-lec-theme', t), other)
      await expect(tb).toHaveAttribute('data-slot-impl', otherImpl)
      await expect(page.locator(`figure.chart [data-slot="FigureFrame"][data-slot-impl="${otherImpl}"]`)).toHaveCount(figCount)
      await expect(page.locator(`.vp-doc [data-slot="QuizHeader"][data-slot-impl="${otherImpl}"]`)).toHaveCount(quizCount)
      const preserved = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('figure.chart .chart-body')).map((b, i) => b.dataset.keepId === String(i)),
      )
      expect(preserved.every(Boolean)).toBe(true)

      expect(hydration, 'hydration warnings').toEqual([])
      expect(pageErrors.map((e) => e.message)).toEqual([])
    })

    test('NavCourseMenu slot renders in topbar and reflects active skin implementation', async ({ page, pageErrors }) => {
      const hydration = watchHydration(page)
      await open(page, theme)

      const menuSlot = page.locator('.VPNavBar [data-slot="NavCourseMenu"]')
      await expect(menuSlot).toHaveCount(1)
      await expect(menuSlot).toHaveAttribute('data-slot-impl', impl)

      // Runtime skin swap updates NavCourseMenu slot implementation
      const [other, otherImpl] = THEMES.find(([t]) => t !== theme)!
      await page.evaluate((t) => document.documentElement.setAttribute('data-lec-theme', t), other)
      await expect(menuSlot).toHaveAttribute('data-slot-impl', otherImpl)

      expect(hydration, 'hydration warnings').toEqual([])
      expect(pageErrors.map((e) => e.message)).toEqual([])
    })
  })
}

// ---------------------------------------------------------------------------------------------------
// visual: the sidebar of the lecture page, both themes (new baselines; compare with the spec board section 05)
// ---------------------------------------------------------------------------------------------------

for (const [theme, impl] of THEMES) {
  test(`@visual-v2 sidebar status ${theme}-light`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod', 'baselines are recorded for the prod project only')
    await page.setViewportSize({ width: 1440, height: 900 })
    await open(page, theme)
    await expect.poll(async () => (await readLinks(page)).every((l) => l.impl === impl)).toBe(true)
    await expect(page.locator('.VPSidebar')).toHaveScreenshot(`v2-sidebar-status-${theme}-light-desktop.png`)
  })
}

// ---------------------------------------------------------------------------------------------------
// measurement: reader preference on a datasheet-default site. SSR and the first client frame use datasheet's
// implementation; after mount the runtime loads the engine default and swaps it in.
// ---------------------------------------------------------------------------------------------------

test.describe('swap timing', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('mount -> swapped component in the DOM (reader preference, datasheet site default)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod', 'measured against the production build')
    const runs: Array<{ mountToSwapMs: number; swapMarkMs: number; navToSwapMs: number }> = []
    for (let i = 0; i < 5; i++) {
      const p = await page.context().newPage()
      await useTheme(p, 'reader', 'light')
      await mockProgress(p)
      await p.addInitScript(() => {
        const w = window as unknown as { __SWAP_AT__?: number }
        const check = (): boolean => {
          if (w.__SWAP_AT__ !== undefined) return true
          if (document.querySelector('.VPSidebar [data-slot-impl="default"]')) {
            w.__SWAP_AT__ = performance.now()
            return true
          }
          return false
        }
        const obs = new MutationObserver(() => {
          if (check()) obs.disconnect()
        })
        obs.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-slot-impl'] })
      })
      await p.goto(LECTURE, { waitUntil: 'domcontentloaded' })
      await p.waitForFunction(() => (window as unknown as { __SWAP_AT__?: number }).__SWAP_AT__ !== undefined, null, { timeout: 15_000 })
      const m = await p.evaluate(() => {
        const at = (window as unknown as { __SWAP_AT__: number }).__SWAP_AT__
        const start = performance.getEntriesByName('lec-slot:start')[0]?.startTime ?? NaN
        const done = performance.getEntriesByName('lec-slot:swapped')[0]?.startTime ?? NaN
        return { at, start, done }
      })
      runs.push({ mountToSwapMs: m.at - m.start, swapMarkMs: m.done - m.start, navToSwapMs: m.at })
      await p.close()
    }
    const sorted = [...runs].sort((a, b) => a.mountToSwapMs - b.mountToSwapMs)
    const median = sorted[Math.floor(sorted.length / 2)]
    const max = sorted[sorted.length - 1]
    const summary = `swap timing (5 runs): mount->DOM median ${median?.mountToSwapMs.toFixed(1)} ms, max ${max?.mountToSwapMs.toFixed(1)} ms; load->DOM median ${median?.navToSwapMs.toFixed(0)} ms; runs ${JSON.stringify(runs.map((r) => Number(r.mountToSwapMs.toFixed(1))))}`
    testInfo.annotations.push({ type: 'swap-timing', description: summary })
    process.stdout.write(`[slots-contract] ${summary}
`)
    for (const r of runs) {
      expect(r.mountToSwapMs).toBeGreaterThanOrEqual(0)
      expect(r.mountToSwapMs, 'the swap must not take a second').toBeLessThan(1000)
    }
  })
})
