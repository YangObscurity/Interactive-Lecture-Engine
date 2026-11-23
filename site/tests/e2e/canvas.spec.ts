/**
 * E2E verification of the global dependency canvas (`graph` mode, P4b — docs-dev/MAP.md).
 *
 * Covers the home map mode toggle, both `reader` (default) and `datasheet` skins, the 24 prototype interaction
 * checks ported from the home-canvas prototype, datasheet compact/zones layout switching,
 * bundle expand (`ann-tag` isolation), LOD zoom labels, search & Enter lock, trace-panel wheel isolation,
 * runtime skin swap, sharp canvas rendering during pan, zero `/_access/` requests, and `@visual-v2` baselines.
 *
 * S6: runs on the demo content (`npm run build:e2e`); its groups, lectures and cross-group bundles are read from the demo itself
 * (tests/e2e/demo.ts; S6X: 9 groups, 46 lectures, all on the canvas). The MEA chain L01→L02→L03→L04 (L03→L05, L04+L05→L06).
 */
import { test, expect, waitForLabelPaint } from './fixtures'
import { BG, CANVAS, expectThemeActive, hexRgb, useTheme, type Mode, type ThemeId } from './theme-helpers'
import type { Page } from '@playwright/test'
import { DEMO_CROSS_PAIRS, DEMO_GROUP_IDS, DEMO_LECTURE_COUNT, DEMO_SEED_STATUS, demoNeighbours } from './demo'

/**
 * The demo site shows its progress seed (templates/demo-content/graph/notion_knowledge_graph.json).
 * The progress read below is answered so that no request leaves the test, but it does not change
 * what the map shows: the demo only reads its seed (S6Y decision, 2026-11-23). Test 1 checks the statuses against the seed.
 */
const SEED_STATUS: Record<string, 'read' | 'reading'> = DEMO_SEED_STATUS
const row = (lecture_id: string, group_id: string, done: boolean) => ({
  lecture_id,
  group_id,
  status: done ? 'completed' : 'in_progress',
  completed_at: done ? '2026-11-01T00:00:00.000Z' : null,
  updated_at: '2026-11-01T00:00:00.000Z',
  notion_node_id: null,
  notion_page_id: null,
})
const SAMPLE_PROGRESS = [row('mea-l01', 'MEA', true), row('mea-l02', 'MEA', true), row('mea-l03', 'MEA', true), row('mea-l04', 'MEA', false), row('log-l02', 'LOG', false)]

/** The demo groups (all have prerequisite edges, so all are on the canvas), its lecture count and its cross-group bundles. */
const GROUPS = DEMO_GROUP_IDS
const LECTURES = DEMO_LECTURE_COUNT
const BUNDLES = DEMO_CROSS_PAIRS

async function mockProgress(page: Page): Promise<void> {
  await page.context().route(/\/api\/db\/progress(\/|\?|$)/, (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(SAMPLE_PROGRESS),
    })
  })
}

async function settle(page: Page, ms = 120): Promise<void> {
  await page.waitForTimeout(ms)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
}

async function openCanvas(
  page: Page,
  theme: ThemeId,
  impl: string,
  mode: Mode = 'light',
  size = { width: 1440, height: 900 },
): Promise<void> {
  await page.setViewportSize(size)
  await mockProgress(page)
  await useTheme(page, theme, mode)
  await page.goto('/')
  await page.waitForSelector('html[data-hydrated="1"]')
  await page.locator('[data-map-mode="graph"]').click()
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await page.waitForFunction(
    (expectedImpl) => {
      const g = document.querySelector('.cv-layer [data-slot="CanvasGroup"]')
      return g?.getAttribute('data-slot-impl') === expectedImpl
    },
    impl,
  )
  await page.waitForFunction(() => document.querySelectorAll('.cv-node').length > 0)
  await page.locator('.cv-stage').first().scrollIntoViewIfNeeded()
  await waitForLabelPaint(page)
  await settle(page, 200)
}

async function zoomGroupMEA(page: Page, theme: ThemeId): Promise<void> {
  const hit = page.locator('[data-g="MEA"] .lec-map-hit').first()
  if (theme === 'reader') await hit.dblclick({ position: { x: 80, y: 20 } })
  else await hit.dblclick()
  await settle(page, 460)
}

const DESKTOP = { width: 1280, height: 900 }
const PHONE = { width: 390, height: 844 }

/**
 * The trace panel in the home-canvas prototype (its `.trace` rules l.166-188, `body { font: 15px/1.6 }` l.81 and
 * `button { font: inherit }` l.82), measured with getComputedStyle in Chrome at 1280 and 390 px in both skins (same
 * values; S6Y): every line box is 1.6 x its own font size.
 */
const PROTO_TRACE = {
  fs: 13, // .trace font-size
  panelLh: 20.8, // 13 x 1.6
  smallLh: 19.2, // .k, h5, .hint: 12 x 1.6
  headerH: 26, // .x height
  mainH: 36.8, // .it.main: 20.8 + 2 x 7 padding + 2 x 1 border
  itH: 30.8, // .it: 20.8 + 2 x 5 padding (the li is as tall)
  liGap: 1, // ul gap 1px, li margin 0
  h5Mt: 6, // h5 margin 6px 0 0
  trH: 24.4, // .tr: 11.5 x 1.6 + 2 x 2 padding + 2 x 1 border
  trFs: 11.5,
}

/** Double-click a lecture (a real double click on its hit shape) and wait for the trace panel. */
async function enterTrace(page: Page, id: string): Promise<void> {
  await page.locator(`.cv-node[data-id="${id}"] .lec-map-hit`).first().dblclick()
  await settle(page, 500)
  await expect(page.locator('#focusbar .it.main')).toHaveAttribute('data-open', id)
}

/** A screen point on the lit trace link that ends (or starts) at `id`, where that link is the top element; null if none. */
async function linkPoint(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((nid) => {
    const lk = [...document.querySelectorAll('.lk')].find((el) => (el.getAttribute('data-trace-key') ?? '').split(/[:>]/).includes(nid))
    const path = lk?.querySelector<SVGPathElement>('.hitline') ?? lk?.querySelector<SVGPathElement>('path')
    const ctm = path?.getScreenCTM()
    if (!lk || !path || !ctm) return null
    const len = path.getTotalLength()
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const p = path.getPointAtLength(len * f)
      const x = ctm.a * p.x + ctm.c * p.y + ctm.e
      const y = ctm.b * p.x + ctm.d * p.y + ctm.f
      if (document.elementFromPoint(x, y)?.closest('.lk') === lk) return { x, y }
    }
    return null
  }, id)
}

/** The trace panel's boxes, in px. */
async function tracePanelMetrics(page: Page) {
  return page.evaluate(() => {
    const fb = document.querySelector('#focusbar')!
    const box = (sel: string, i = 0): DOMRect => fb.querySelectorAll(sel)[i]!.getBoundingClientRect()
    const cs = (sel: string): CSSStyleDeclaration => getComputedStyle(fb.querySelector(sel)!)
    const lis = fb.querySelectorAll('h5.post + ul li')
    return {
      stageW: document.querySelector('.cv-stage')!.clientWidth,
      panelW: fb.getBoundingClientRect().width,
      panelLh: parseFloat(getComputedStyle(fb).lineHeight),
      headerH: box('header').height,
      kLh: parseFloat(cs('.k').lineHeight),
      mainH: box('.it.main').height,
      h5H: box('h5').height,
      h5Mt: parseFloat(cs('h5').marginTop),
      itH: box('ul li .it').height,
      liH: box('ul li').height,
      liGap: lis.length > 1 ? lis[1]!.getBoundingClientRect().top - lis[0]!.getBoundingClientRect().bottom : NaN,
      trH: box('.tr').height,
      trFs: parseFloat(cs('.tr').fontSize),
      itFs: parseFloat(cs('ul li .it').fontSize),
      hintLh: parseFloat(cs('.hint').lineHeight),
    }
  })
}

/**
 * S6Y AH #5 / #13: the map chrome in the home-canvas prototype inherits `body { font: 15px/1.6 var(--lec-font) }`
 * (l.81) and `button { font: inherit }` (l.82); the prompt `.activate` is 13px with 8px 14px padding and a 1px border
 * (l.112), one line at 1280 px: 13 x 1.6 + 2 x 8 + 2 = 38.8 px. The engine's UI sans-serif token is `--lec-font-heading`
 * (datasheet: Noto Sans SC; reader: the system UI stack, the prototype's reader `--lec-font`).
 */
const PROTO_CHROME = { fs: 15, lh: 24, btnFs: 15, hintH: 38.8, hintLh: 20.8 }

/** Chrome selectors whose font must be the UI sans-serif (the ones a map shows; missing ones are skipped). */
const CHROME_SELECTORS = [
  '.lec-map-hud-tl',
  '.cv-search',
  '.cv-legend .lg',
  '#edgeinfo',
  '#dslayout button',
  '#zoomlabel',
  '.lec-map-controls button',
  '.lec-map-hint',
  '#focusbar',
  '#focusbar .it',
  '#focusbar .tr',
  '#focusbar h5',
  '#focusbar .hint',
]

/** Computed font of the stage and of every chrome element (normalised: no quotes, no spaces). */
async function mapChromeMetrics(page: Page, selectors: readonly string[] = CHROME_SELECTORS) {
  return page.evaluate((sels) => {
    const norm = (s: string): string => s.replace(/["'\s]/g, '')
    const stage = document.querySelector<HTMLElement>('.lec-map')!
    const st = getComputedStyle(stage)
    const fonts: Array<{ sel: string; ff: string }> = [{ sel: '.lec-map', ff: norm(st.fontFamily) }]
    for (const sel of sels) for (const el of stage.querySelectorAll(sel)) fonts.push({ sel, ff: norm(getComputedStyle(el).fontFamily) })
    const hint = stage.querySelector('.lec-map-hint')
    const btn = stage.querySelector('.lec-map-controls button')
    return {
      heading: norm(getComputedStyle(document.documentElement).getPropertyValue('--lec-font-heading')),
      fonts,
      fs: parseFloat(st.fontSize),
      lh: parseFloat(st.lineHeight),
      btnFs: btn ? parseFloat(getComputedStyle(btn).fontSize) : NaN,
      hintH: hint ? hint.getBoundingClientRect().height : NaN,
      hintLh: hint ? parseFloat(getComputedStyle(hint).lineHeight) : NaN,
      sansLoaded: [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Noto Sans SC Variable' && f.status === 'loaded'),
    }
  }, selectors)
}

/** Scale of the map view (the svg's CSS transform). */
const scaleOf = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.lec-map-svg') as Element).transform).a)

/** The viewport's scale ladder (map/geometry.ts `ladder`, prototype l.1338): 2^(round(log2 k x 4) / 4). */
const ladder = (k: number): number => 2 ** (Math.round(Math.log2(k) * 4) / 4)

/** A screen point on the box of group `g` that hits the group itself (no lecture, link, HUD or panel); null if none. */
async function groupPoint(page: Page, g: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((gid) => {
    const hit = document.querySelector(`.cv-layer [data-g="${gid}"] .lec-map-hit`)
    const stage = document.querySelector('.cv-stage')
    if (!hit || !stage) return null
    const r = hit.getBoundingClientRect()
    const s = stage.getBoundingClientRect()
    const x0 = Math.max(r.left, s.left) + 4
    const x1 = Math.min(r.right, s.right) - 4
    const y0 = Math.max(r.top, s.top) + 4
    const y1 = Math.min(r.bottom, s.bottom) - 4
    for (let i = 0; i <= 16; i++) {
      for (let j = 0; j <= 16; j++) {
        const x = x0 + ((x1 - x0) * i) / 16
        const y = y0 + ((y1 - y0) * j) / 16
        const el = document.elementFromPoint(x, y)
        if (!el || el.closest('.cv-node, .lk, .bundle-g, .lec-map-hud, .lec-map-panel')) continue
        if (el.closest('.g-hit')?.getAttribute('data-g') === gid) return { x, y }
      }
    }
    return null
  }, g)
}

/** The node's centre is on the stage and not under the trace panel. */
async function nodeOnStage(page: Page, id: string): Promise<boolean> {
  return page.evaluate((nid) => {
    const n = document.querySelector(`.cv-node[data-id="${nid}"]`)?.getBoundingClientRect()
    const s = document.querySelector('.cv-stage')!.getBoundingClientRect()
    const p = document.querySelector('#focusbar')?.getBoundingClientRect()
    if (!n) return false
    const x = n.left + n.width / 2
    const y = n.top + n.height / 2
    const underPanel = !!p && x >= p.left && x <= p.right && y >= p.top && y <= p.bottom
    return x >= s.left && x <= s.right && y >= s.top && y <= s.bottom && !underPanel
  }, id)
}

for (const [theme, impl] of [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
] as const) {
  test.describe(`canvas (${theme})`, () => {
    test('1. default overview renders every demo group and every lecture; nothing is left off the map', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      await expect(page.locator('#atlas [data-slot="CanvasGroup"]')).toHaveCount(GROUPS.length)
      for (const g of GROUPS) await expect(page.locator(`#atlas [data-slot="CanvasGroup"][data-g="${g}"]`)).toHaveCount(1)
      await expect(page.locator('#atlas .cv-node')).toHaveCount(LECTURES)
      // statuses: the demo's progress seed (see SEED_STATUS)
      const shown = await page.locator('#atlas .cv-node').evaluateAll((els) =>
        Object.fromEntries(els.map((e) => [e.getAttribute('data-id') ?? '', ['read', 'reading', 'unread'].find((s) => e.classList.contains(s)) ?? ''])),
      )
      for (const [id, s] of Object.entries(shown)) expect(s, id).toBe(SEED_STATUS[id] ?? 'unread')
      // the notice names the groups without prerequisite edges (left off the map); the demo has none, so it is the plain line
      // the plain line counts the drawn links (the transitive reduction of the prerequisite edges)
      await expect(page.locator('#edgeinfo')).toHaveText(/^默认只画 [1-9]\d* 条必要连线/)
      for (const g of GROUPS) await expect(page.locator('#edgeinfo')).not.toContainText(g)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('2. dblclick group LOG zooms all nodes inside stage without trace panel or text selection', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const hit = page.locator('[data-g="LOG"] .lec-map-hit').first()
      if (theme === 'reader') await hit.dblclick({ position: { x: 80, y: 20 } })
      else await hit.dblclick()
      await settle(page, 460)

      await expect(page.locator('#focusbar')).toHaveCount(0)
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
      expect(await page.locator('body').innerText()).not.toContain('进入这一组')

      const out = await page.evaluate(() => {
        const sr = document.querySelector('.cv-stage')!.getBoundingClientRect()
        const nodes = [...document.querySelectorAll('.cv-node[data-id^="log-"]')]
        if (nodes.length === 0) return -1
        let outside = 0
        for (const n of nodes) {
          const r = n.getBoundingClientRect()
          if (r.right < sr.left || r.left > sr.right || r.bottom < sr.top || r.top > sr.bottom) outside++
        }
        return outside
      })
      expect(out, 'no LOG lecture missing outside stage').toBe(0)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('3. single click group LOG navigates to /log/', async ({ page, consoleErrors, pageErrors }) => {
      await openCanvas(page, theme, impl)
      const hit = page.locator('[data-g="LOG"] .lec-map-hit').first()
      await Promise.all([
        page.waitForURL(/\/log\/$/),
        theme === 'reader' ? hit.click({ position: { x: 80, y: 20 } }) : hit.click(),
      ])
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('4. single click lecture mea-l04 opens /mea/L04 after click window without entering lock', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      await zoomGroupMEA(page, theme)
      const nodeHit = page.locator('.cv-node[data-id="mea-l04"] .lec-map-hit').first()
      await Promise.all([page.waitForURL(/\/mea\/L04(?:\.html)?$/), nodeHit.click()])
      await expect(page.locator('#focusbar')).toHaveCount(0)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('5. dblclick lecture mea-l04 enters trace mode and keeps endpoints right of 380px trace panel', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      await zoomGroupMEA(page, theme)

      const nodeHit = page.locator('.cv-node[data-id="mea-l04"] .lec-map-hit').first()
      await nodeHit.dblclick()
      await settle(page, 500)

      await expect(page.locator('#focusbar')).toBeVisible()
      await expect(page.locator('#focusbar [data-open="mea-l04"]')).toBeVisible()
      await expect(page.locator('.cv-layer')).toHaveClass(/cv-dim/)
      await expect(page.locator('.cv-node[data-id="mea-l04"]')).toHaveClass(/\blocked\b/)

      const bounds = await page.evaluate(() => {
        const sr = document.querySelector('.cv-stage')!.getBoundingClientRect()
        const pr = document.querySelector('#focusbar')!.getBoundingClientRect()
        const actives = [...document.querySelectorAll('.cv-node.on')]
        let minLeft = Infinity
        let maxRight = -Infinity
        for (const el of actives) {
          const r = el.getBoundingClientRect()
          if (r.width === 0) continue
          minLeft = Math.min(minLeft, r.left)
          maxRight = Math.max(maxRight, r.right)
        }
        return { srLeft: sr.left, srRight: sr.right, prRight: pr.right, minLeft, maxRight, count: actives.length }
      })
      expect(bounds.count).toBeGreaterThanOrEqual(2)
      expect(bounds.prRight).toBeLessThanOrEqual(bounds.srLeft + 396)
      expect(bounds.minLeft).toBeGreaterThanOrEqual(bounds.srLeft + 380)
      expect(bounds.maxRight).toBeLessThanOrEqual(bounds.srRight + 4)

      // 6. wheel inside #focusbar scrolls panel without moving viewport transform or #zoomlabel
      const before = await page.evaluate(() => ({
        tf: (document.querySelector('.lec-map-svg') as HTMLElement).style.transform,
        zl: document.querySelector('#zoomlabel')?.textContent ?? '',
      }))
      const panelBox = await page.locator('#focusbar').boundingBox()
      expect(panelBox).not.toBeNull()
      await page.mouse.move(panelBox!.x + panelBox!.width / 2, panelBox!.y + panelBox!.height / 2)
      await page.mouse.wheel(0, 260)
      await settle(page, 220)
      const after = await page.evaluate(() => ({
        tf: (document.querySelector('.lec-map-svg') as HTMLElement).style.transform,
        zl: document.querySelector('#zoomlabel')?.textContent ?? '',
      }))
      expect(after.tf).toBe(before.tf)
      expect(after.zl).toBe(before.zl)

      // 7. clicking a trace link moves trace lock along the chain; Escape exits trace mode cleanly
      const traceCountBefore = await page.locator('.lk').count()
      expect(traceCountBefore).toBeGreaterThan(0)
      await page.locator('.lk .hitline').first().dispatchEvent('click', { bubbles: true })
      await settle(page, 460)
      const newMainId = await page.locator('#focusbar .it.main').getAttribute('data-open')
      expect(newMainId).toBeTruthy()
      expect(newMainId).not.toBe('mea-l04')

      await page.keyboard.press('Escape')
      await settle(page, 180)
      await expect(page.locator('#focusbar')).toHaveCount(0)
      await expect(page.locator('.cv-layer')).not.toHaveClass(/cv-dim/)

      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    for (const size of [DESKTOP, PHONE]) {
      test(`5b. ${size.width}px: the panel's "trace" button (real click) moves the lock; then a real click on a lit link; Esc exits`, async ({
        page,
        consoleErrors,
        pageErrors,
      }) => {
        await openCanvas(page, theme, impl, 'light', size)
        await enterTrace(page, 'log-l01')
        await expect(page.locator('#focusbar .it.main')).toHaveAttribute('data-open', 'log-l01')

        // S6Y (user report 21:13): LOG L01 -> follow-up LOG L02 "trace" left the trace mode instead of moving the lock
        await page.locator('#focusbar li[data-id="log-l02"] .tr').click()
        await settle(page, 460)
        await expect(page.locator('#focusbar')).toBeVisible()
        await expect(page.locator('#focusbar .it.main')).toHaveAttribute('data-open', 'log-l02')
        const log02 = demoNeighbours('log-l02')
        await expect(page.locator('#focusbar h5.pre + ul li')).toHaveCount(log02.pre.length)
        await expect(page.locator('#focusbar h5.pre + ul li[data-id="log-l01"]')).toHaveCount(1)
        await expect(page.locator('#focusbar h5.post + ul li')).toHaveCount(log02.post.length)
        await expect(page.locator('.cv-node.locked')).toHaveCount(1)
        await expect(page.locator('.cv-node[data-id="log-l02"]')).toHaveClass(/\blocked\b/)
        for (const id of [...log02.pre, ...log02.post]) await expect(page.locator(`.cv-node[data-id="${id}"]`)).toHaveClass(/\bon\b/)
        await expect(page.locator('.lk')).toHaveCount(log02.pre.length + log02.post.length)

        // a real click on the lit link to LOG L03 (a point on the curve itself, not the centre of its box)
        const pt = await linkPoint(page, 'log-l03')
        expect(pt, 'the link to log-l03 is on screen').not.toBeNull()
        await page.mouse.click(pt!.x, pt!.y)
        await settle(page, 460)
        await expect(page.locator('#focusbar .it.main')).toHaveAttribute('data-open', 'log-l03')
        await expect(page.locator('.cv-node[data-id="log-l03"]')).toHaveClass(/\blocked\b/)

        await page.keyboard.press('Escape')
        await settle(page, 180)
        await expect(page.locator('#focusbar')).toHaveCount(0)
        await expect(page.locator('.cv-node.locked')).toHaveCount(0)
        expect(consoleErrors).toEqual([])
        expect(pageErrors).toEqual([])
      })

      test(`5c. ${size.width}px: trace panel rows, buttons, headings and hint have the prototype's sizes (±1px)`, async ({
        page,
        consoleErrors,
        pageErrors,
      }) => {
        await openCanvas(page, theme, impl, 'light', size)
        await enterTrace(page, 'log-l02')
        const m = await tracePanelMetrics(page)
        const near = (actual: number, expected: number, what: string): void =>
          expect(Math.abs(actual - expected), `${what}: ${actual} vs prototype ${expected}`).toBeLessThanOrEqual(1)
        near(m.panelW, Math.min(380, m.stageW - 24), 'panel width = min(380px, 100% - 24px)')
        near(m.panelLh, PROTO_TRACE.panelLh, 'panel line-height')
        near(m.headerH, PROTO_TRACE.headerH, 'header height')
        near(m.kLh, PROTO_TRACE.smallLh, '"tracing" label line-height')
        near(m.mainH, PROTO_TRACE.mainH, 'main row height')
        near(m.h5H, PROTO_TRACE.smallLh, 'h5 height')
        near(m.h5Mt, PROTO_TRACE.h5Mt, 'h5 margin-top')
        near(m.itH, PROTO_TRACE.itH, 'list row (.it) height')
        near(m.liH, PROTO_TRACE.itH, 'list item height')
        near(m.liGap, PROTO_TRACE.liGap, 'gap between two list items')
        near(m.trH, PROTO_TRACE.trH, '"trace" button height')
        near(m.trFs, PROTO_TRACE.trFs, '"trace" button font size')
        near(m.itFs, PROTO_TRACE.fs, 'row font size')
        near(m.hintLh, PROTO_TRACE.smallLh, 'hint line-height')
        expect(consoleErrors).toEqual([])
        expect(pageErrors).toEqual([])
      })
    }

    test('5d. the map chrome is isolated from .vp-doc: UI sans-serif everywhere, 15px / 1.6 root, 15px +/- buttons, a one-line hint at 1280 px (AH #5 #13)', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl, 'light', DESKTOP)
      await enterTrace(page, 'log-l02')
      const m = await mapChromeMetrics(page)
      const near = (actual: number, expected: number, what: string): void =>
        expect(Math.abs(actual - expected), `${what}: ${actual} vs prototype ${expected}`).toBeLessThanOrEqual(1)
      expect(m.fonts.length, 'chrome elements found').toBeGreaterThanOrEqual(CHROME_SELECTORS.length - 2)
      for (const f of m.fonts) expect(f.ff, `${f.sel} font-family`).toBe(m.heading)
      if (theme === 'datasheet') {
        // datasheet: the prototype's `--lec-font` is Noto Sans SC (not the serif of the lecture text)
        expect(m.heading).toMatch(/^NotoSansSC/)
        expect(m.sansLoaded, 'Noto Sans SC Variable is loaded').toBe(true)
      }
      near(m.fs, PROTO_CHROME.fs, 'stage font-size')
      near(m.lh, PROTO_CHROME.lh, 'stage line-height')
      near(m.btnFs, PROTO_CHROME.btnFs, '+/- button font-size')
      near(m.hintLh, PROTO_CHROME.hintLh, 'hint line-height')
      near(m.hintH, PROTO_CHROME.hintH, 'hint height (one line)')
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('5e. while tracing, a click on a group only leaves trace mode; the next click opens the group (AH #3, prototype l.734-739)', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl, 'light', DESKTOP)
      await enterTrace(page, 'log-l02')
      const pt = await groupPoint(page, 'LOG')
      expect(pt, 'a blank point of the LOG group is on screen').not.toBeNull()
      await page.mouse.click(pt!.x, pt!.y)
      await settle(page, 600)
      expect(page.url()).not.toMatch(/\/log\/$/)
      await expect(page.locator('#focusbar')).toHaveCount(0)
      await expect(page.locator('.cv-node.locked')).toHaveCount(0)
      await Promise.all([page.waitForURL(/\/log\/$/), page.mouse.click(pt!.x, pt!.y)])
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('5f. the trace button, a lit link and search Enter pan to the lecture at scale >= 0.7 (titles view), not zoom to its box (AH #4, prototype lockNode(id, true) -> panTo)', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl, 'light', DESKTOP)
      await enterTrace(page, 'log-l01')
      const k0 = await scaleOf(page)
      const panK = ladder(Math.max(k0, 0.7))

      await page.locator('#focusbar li[data-id="log-l02"] .tr').click()
      await settle(page, 460)
      await expect(page.locator('#focusbar .it.main')).toHaveAttribute('data-open', 'log-l02')
      const k1 = await scaleOf(page)
      expect(k1, `scale after the trace button (was ${k0})`).toBeCloseTo(panK, 3)
      expect(k1).toBeGreaterThanOrEqual(0.7)
      await expect(page.locator('#zoomlabel')).toContainText('讲名视图')
      expect(await nodeOnStage(page, 'log-l02'), 'the new lock is on screen').toBe(true)

      const pt = await linkPoint(page, 'log-l03')
      expect(pt, 'the link to log-l03 is on screen').not.toBeNull()
      await page.mouse.click(pt!.x, pt!.y)
      await settle(page, 460)
      await expect(page.locator('#focusbar .it.main')).toHaveAttribute('data-open', 'log-l03')
      expect(await scaleOf(page), 'scale after a click on a lit link').toBeCloseTo(panK, 3)
      expect(await nodeOnStage(page, 'log-l03')).toBe(true)

      await page.keyboard.press('Escape')
      await page.locator('.lec-map-controls button').last().click()
      await settle(page, 300)
      const kFit = await scaleOf(page)
      const search = page.locator('.cv-search')
      await search.fill('插值')
      await settle(page, 120)
      await search.press('Enter')
      await settle(page, 480)
      await expect(page.locator('.cv-node.locked')).toHaveCount(1)
      const k3 = await scaleOf(page)
      expect(k3, `scale after search Enter (fitted ${kFit})`).toBeCloseTo(ladder(Math.max(kFit, 0.7)), 3)
      await expect(page.locator('#zoomlabel')).toContainText('讲名视图')
      const lockedId = await page.locator('.cv-node.locked').getAttribute('data-id')
      expect(await nodeOnStage(page, lockedId!)).toBe(true)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    for (const mode of ['light', 'dark'] as const) {
      test(`5g. ${mode}: the stage is painted with --lec-canvas, not the page background (AH #6, prototype --canvas)`, async ({
        page,
        consoleErrors,
        pageErrors,
      }) => {
        await openCanvas(page, theme, impl, mode, DESKTOP)
        await expectThemeActive(page, theme, mode)
        const bg = await page.locator('.cv-stage').evaluate((el) => getComputedStyle(el).backgroundColor)
        expect(bg).toBe(hexRgb(CANVAS[`${theme}-${mode}`]))
        expect(bg).not.toBe(hexRgb(BG[`${theme}-${mode}`]))
        expect(consoleErrors).toEqual([])
        expect(pageErrors).toEqual([])
      })
    }

    test('5h. the legend and the edge info are chips, the zoom label reads "NN%，view" (AH #10 #12, prototype .chip l.108 / .hud.bl l.104)', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl, 'light', DESKTOP)
      const chips = await page.evaluate(() =>
        [...document.querySelectorAll('.cv-legend .lg, #edgeinfo')].map((el) => {
          const cs = getComputedStyle(el)
          return {
            id: el.id || el.textContent?.trim() || '',
            h: el.getBoundingClientRect().height,
            bw: parseFloat(cs.borderTopWidth),
            pt: parseFloat(cs.paddingTop),
            pl: parseFloat(cs.paddingLeft),
            fs: parseFloat(cs.fontSize),
            bg: cs.backgroundColor,
          }
        }),
      )
      expect(chips.length).toBe(6)
      for (const c of chips) {
        expect(c.bw, `${c.id} border`).toBe(1)
        expect(c.pt, `${c.id} padding-top`).toBe(3)
        expect(c.pl, `${c.id} padding-left`).toBe(8)
        expect(c.fs, `${c.id} font-size`).toBe(12)
        expect(c.bg, `${c.id} background`).toBe(hexRgb(BG[`${theme}-light`]))
        // 12 x 1.6 + 2 x 3 + 2 x 1 = 27.2 (the edge info may wrap to more lines)
        if (c.id !== 'edgeinfo') expect(Math.abs(c.h - 27.2), `${c.id} height ${c.h}`).toBeLessThanOrEqual(1)
      }
      const zl = await page.locator('#zoomlabel').evaluate((el) => {
        const cs = getComputedStyle(el)
        return { text: el.textContent ?? '', h: el.getBoundingClientRect().height, pt: parseFloat(cs.paddingTop), pl: parseFloat(cs.paddingLeft) }
      })
      const k = await scaleOf(page)
      const view = k < 0.22 ? '组视图' : k < 0.45 ? '编号视图' : '讲名视图'
      expect(zl.text).toBe(`${Math.round(k * 100)}%，${view}`)
      expect([zl.pt, zl.pl]).toEqual([4, 8])
      expect(Math.abs(zl.h - 29.2), `zoom label height ${zl.h} (12 x 1.6 + 2 x 4 + 2)`).toBeLessThanOrEqual(1)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('5i. phone (390 px): the canvas runs edge to edge; desktop (1280 px): it stays in the content column (DECISIONS: map width)', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      const box = async () =>
        page.locator('.cv-stage').evaluate((el) => {
          const r = el.getBoundingClientRect()
          return { left: r.left, right: r.right, vw: document.documentElement.clientWidth, bl: parseFloat(getComputedStyle(el).borderLeftWidth), sw: document.documentElement.scrollWidth }
        })
      await openCanvas(page, theme, impl, 'light', PHONE)
      const p = await box()
      expect(Math.abs(p.left), `phone left ${p.left}`).toBeLessThanOrEqual(0.5)
      expect(Math.abs(p.right - p.vw), `phone right ${p.right} vs ${p.vw}`).toBeLessThanOrEqual(0.5)
      expect(p.bl).toBe(0)
      expect(p.sw, 'no horizontal scroll').toBeLessThanOrEqual(p.vw)
      await enterTrace(page, 'log-l02')
      // the trace panel is min(380px, 100% - 24px) of the full-width stage, as in the prototype (366 px at 390)
      expect(Math.abs((await page.locator('#focusbar').boundingBox())!.width - 366)).toBeLessThanOrEqual(1)

      await page.setViewportSize(DESKTOP)
      await settle(page, 200)
      const d = await box()
      expect(d.left).toBeGreaterThan(8)
      expect(d.right).toBeLessThan(d.vw - 8)
      expect(d.bl).toBe(1)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('8. search highlights matches and Enter enters trace mode on first hit', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const search = page.locator('.cv-search')
      await search.fill('插值')
      await settle(page, 120)
      await expect(page.locator('.cv-layer')).toHaveClass(/cv-searching/)
      const matchCount = await page.locator('.cv-node.match').count()
      expect(matchCount).toBeGreaterThanOrEqual(1)

      await search.press('Enter')
      await settle(page, 480)
      await expect(page.locator('#focusbar')).toBeVisible()
      await expect(page.locator('.cv-node.locked')).toHaveCount(1)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    test('9. drag pans smoothly, keeps SVG text hidden and sharp canvas sizing consistent', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const hiddenTextCheck = await page.evaluate(() => {
        const texts = [...document.querySelectorAll('.lec-map-svg text')]
        return texts.length > 0 && texts.every((t) => getComputedStyle(t).display === 'none')
      })
      expect(hiddenTextCheck).toBe(true)

      const stage = page.locator('.cv-stage')
      const box = (await stage.boundingBox())!
      const startX = box.x + box.width * 0.65
      const startY = box.y + box.height * 0.6

      // Record frame gaps during pan drag
      await page.evaluate(() => {
        const w = window as unknown as { __panGaps?: number[]; __panRun?: boolean }
        w.__panGaps = []
        w.__panRun = true
        let last = performance.now()
        function tick(now: number): void {
          w.__panGaps!.push(now - last)
          last = now
          if (w.__panRun) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      await page.mouse.move(startX, startY)
      await page.mouse.down()
      for (let i = 1; i <= 8; i++) {
        await page.mouse.move(startX - i * 16, startY - i * 8)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      await settle(page, 180)
      const stats = await page.evaluate(() => {
        const w = window as unknown as { __panGaps?: number[]; __panRun?: boolean }
        w.__panRun = false
        const gaps = (w.__panGaps ?? []).slice(1)
        const maxGap = gaps.length ? Math.max(...gaps) : 0
        const cv = document.querySelector('.lec-map-labels') as HTMLCanvasElement
        const sr = document.querySelector('.cv-stage')!.getBoundingClientRect()
        return {
          maxGap,
          cw: cv.width,
          ch: cv.height,
          minW: Math.floor(sr.width),
          minH: Math.floor(sr.height),
          fontsLoaded: document.fonts.status,
        }
      })
      expect(stats.cw).toBeGreaterThanOrEqual(stats.minW)
      expect(stats.ch).toBeGreaterThanOrEqual(stats.minH)
      expect(stats.fontsLoaded).toBe('loaded')
      expect(stats.maxGap).toBeLessThan(80)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    if (theme === 'datasheet') {
      test('10. datasheet bundle MEA|PLN click shows .ann-tag only inside .bundle-g.on; compact <-> zones switches zones', async ({
        page,
        consoleErrors,
        pageErrors,
      }) => {
        await openCanvas(page, theme, impl)
        await expect(page.locator('#dslayout')).toBeVisible()
        await expect(page.locator('#dslayout button[data-l="compact"]')).toHaveAttribute('aria-pressed', 'true')
        await expect(page.locator('.zone-box')).toHaveCount(0)

        // Zero active bundles before click
        await expect(page.locator('.bundle-g.on')).toHaveCount(0)

        const targetBundle = page.locator('.bundle-g[data-pair="MEA|PLN"]')
        await expect(targetBundle).toHaveCount(1)
      // one bundle per pair of groups with cross-group edges (requires: and graph.json)
      expect((await page.locator('.bundle-g').evaluateAll((els) => els.map((e) => e.getAttribute('data-pair')))).sort()).toEqual([...BUNDLES].sort())
        await targetBundle.locator('.hitline').first().dispatchEvent('click', { bubbles: true })
        await settle(page, 480)

        await expect(page.locator('.bundle-g.on')).toHaveCount(1)
        await expect(targetBundle).toHaveClass(/\bon\b/)
        await expect(page.locator('#focusbar')).toBeVisible()
        const annState = await page.evaluate(() => {
          const all = [...document.querySelectorAll('.ann-tag')]
          const onAnns = all.filter((el) => el.closest('.bundle-g.on'))
          const offAnns = all.filter((el) => !el.closest('.bundle-g.on'))
          return {
            onVisible: onAnns.length > 0 && onAnns.every((el) => Number(getComputedStyle(el).opacity) >= 0.99),
            offDimmed: offAnns.length > 0 && offAnns.every((el) => Number(getComputedStyle(el).opacity) < 0.2),
          }
        })
        expect(annState.onVisible).toBe(true)
        expect(annState.offDimmed).toBe(true)

        await page.keyboard.press('Escape')
        await settle(page, 180)
        await expect(page.locator('.bundle-g.on')).toHaveCount(0)

        // Switch compact -> zones -> compact
        await page.locator('#dslayout button[data-l="zones"]').click()
        await settle(page, 240)
        await expect(page.locator('#dslayout button[data-l="zones"]')).toHaveAttribute('aria-pressed', 'true')
        expect(await page.locator('.zone-box').count()).toBeGreaterThan(0)

        await page.locator('#dslayout button[data-l="compact"]').click()
        await settle(page, 240)
        await expect(page.locator('.zone-box')).toHaveCount(0)

        expect(consoleErrors).toEqual([])
        expect(pageErrors).toEqual([])
      })
    }

    test('11. LOD zoom label tracks zoom level (group -> numbers -> titles)', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      await openCanvas(page, theme, impl)
      const zl = page.locator('#zoomlabel')
      // the label is "NN%，<view>" (prototype l.1345); this test follows the view part
      const viewOf = async (): Promise<string> => ((await zl.textContent()) ?? '').replace(/^\d+%，/, '')
      await page.locator('.cv-stage').focus()
      // zoom out from the opening view through 编号视图 to 组视图
      const seen: string[] = []
      for (let i = 0; i < 12; i++) {
        const now = await viewOf()
        if (seen[seen.length - 1] !== now) seen.push(now)
        if (now === '组视图') break
        await page.keyboard.press('-')
        await settle(page, 180)
      }
      await expect(zl).toHaveText(/^(\d+%，)?组视图$/)
      expect(seen, 'the label passed through the numbers view on the way out').toContain('编号视图')

      await zoomGroupMEA(page, theme)
      for (let i = 0; i < 3; i++) {
        if ((await viewOf()) === '讲名视图') break
        await page.keyboard.press('=')
        await settle(page, 180)
      }
      await expect(zl).toHaveText(/^(\d+%，)?讲名视图$/)
      expect(consoleErrors).toEqual([])
      expect(pageErrors).toEqual([])
    })

    for (const mode of ['light', 'dark'] as const) {
      test(`12. @visual-v2 canvas ${theme}-${mode} desktop`, async ({ page, consoleErrors, pageErrors }, testInfo) => {
        test.skip(testInfo.project.name !== 'prod', 'baselines are recorded for the prod project only')
        await openCanvas(page, theme, impl, mode, { width: 1440, height: 900 })
        await expectThemeActive(page, theme, mode)
        await expect(page.locator('.cv-stage').first()).toHaveScreenshot(`v2-canvas-${theme}-${mode}-desktop.png`)
        expect(consoleErrors).toEqual([])
        expect(pageErrors).toEqual([])
      })
    }
  })
}

test('runtime skin swap reader <-> datasheet updates canvas slots and zero /_access/ requests', async ({
  page,
  consoleErrors,
  pageErrors,
}) => {
  const accessRequests: string[] = []
  page.on('request', (req) => {
    if (req.url().includes('/_access/')) accessRequests.push(req.url())
  })

  await openCanvas(page, 'reader', 'default')
  await page.evaluate(() => document.documentElement.setAttribute('data-lec-theme', 'datasheet'))
  await page.waitForFunction(
    () => document.querySelector('.cv-layer [data-slot="CanvasGroup"]')?.getAttribute('data-slot-impl') === 'datasheet',
  )
  await settle(page, 220)
  await expect(page.locator('#dslayout')).toBeVisible()

  await page.evaluate(() => document.documentElement.setAttribute('data-lec-theme', 'reader'))
  await page.waitForFunction(
    () => document.querySelector('.cv-layer [data-slot="CanvasGroup"]')?.getAttribute('data-slot-impl') === 'default',
  )
  await settle(page, 220)
  await expect(page.locator('#dslayout')).toHaveCount(0)
  expect(accessRequests).toEqual([])
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('mode switcher toggles between atlas and graph cleanly', async ({ page, consoleErrors, pageErrors }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mockProgress(page)
  await useTheme(page, 'reader', 'light')
  await page.goto('/')
  await page.waitForSelector('html[data-hydrated="1"]')

  await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toBeVisible()

  await page.locator('[data-map-mode="graph"]').click()
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await expect(page.locator('[data-map-mode="graph"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toHaveCount(0)

  // Reload persists dependency canvas choice
  await page.reload()
  await page.waitForSelector('html[data-hydrated="1"]')
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await expect(page.locator('[data-map-mode="graph"]')).toHaveAttribute('aria-pressed', 'true')

  await page.locator('[data-map-mode="atlas"]').click()
  await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toBeVisible()

  // Reload persists overview atlas choice
  await page.reload()
  await page.waitForSelector('html[data-hydrated="1"]')
  await expect(page.locator('[data-map-mode="atlas"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.am-layer')).toBeVisible()

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

test('datasheet compact <-> zones layout choice persists across reload', async ({ page, consoleErrors, pageErrors }) => {
  await openCanvas(page, 'datasheet', 'datasheet')
  await page.locator('#dslayout button[data-l="zones"]').click()
  await expect(page.locator('#dslayout button[data-l="zones"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.locator('.zone-box').count()).toBeGreaterThan(0)

  await page.reload()
  await page.waitForSelector('html[data-hydrated="1"]')
  await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
  await expect(page.locator('#dslayout button[data-l="zones"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => page.locator('.zone-box').count()).toBeGreaterThan(0)

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

for (const [theme, impl] of [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
] as const) {
  test(`canvas keyboard navigation (${theme}): Tab reaches node with role/aria-label/focus ring, Arrows move, Enter opens`, async ({
    page,
    consoleErrors,
    pageErrors,
  }) => {
    await openCanvas(page, theme, impl)
    const nodes = page.locator('.cv-node')
    await expect.poll(() => nodes.count()).toBe(LECTURES)

    const activeFirst = page.locator('.cv-node[tabindex="0"]')
    await expect(activeFirst).toHaveCount(1)
    await expect(activeFirst).toHaveAttribute('role', 'button')
    const aria = await activeFirst.getAttribute('aria-label')
    expect(aria && aria.length > 5).toBe(true)

    // Focus the canvas stage, then Tab into the active node
    await page.locator('.cv-stage').focus()
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      const onNode = await page.evaluate(() => Boolean(document.activeElement?.classList.contains('cv-node')))
      if (onNode) break
    }
    const startId = await page.evaluate(() => {
      const el = document.activeElement
      return el?.classList.contains('cv-node') ? el.getAttribute('data-id') : null
    })
    expect(startId).toBeTruthy()

    const focusStyle = await page.evaluate(() => {
      const el = document.activeElement as Element
      const cs = getComputedStyle(el)
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }
    })
    expect(focusStyle.style).not.toBe('none')
    expect(focusStyle.width).toBeGreaterThan(0)

    // Move right / down with arrow keys to reach another lecture node without panning off focus
    let movedId: string | null = null
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await page.keyboard.press(key)
      const id = await page.evaluate(() => {
        const el = document.activeElement
        return el?.classList.contains('cv-node') ? el.getAttribute('data-id') : null
      })
      if (id && id !== startId) {
        movedId = id
        break
      }
    }
    expect(movedId, 'arrow key moves focus to another node').toBeTruthy()
    expect(movedId).not.toBe(startId)

    // Enter opens the currently focused lecture (same as single click)
    const expectedSlug = movedId!.replace('-l', '/L')
    await Promise.all([
      page.waitForURL(new RegExp(`${expectedSlug}(?:\\.html)?$`, 'i')),
      page.keyboard.press('Enter'),
    ])

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
}

// S6Y audit-home #2: in the reader skin each group-to-group line has its own ports and its own way through the gaps.
// Before, two bundles out of the bottom of one group were the same vertical line (the one drawn later took every click)
// and a bundle to a group two rows down ran through the group between. The prototype (home-canvas prototype: every
// purple bundle can be hovered and clicked, then opens its cross-group prerequisites) is the reference for the behaviour.
test('reader bundles: each group-to-group line is hit and clicked on its own and keeps out of the other groups', async ({ page, consoleErrors, pageErrors }) => {
  await openCanvas(page, 'reader', 'default', 'light', { width: 1280, height: 900 })
  const fitButton = page.locator('.cv-stage .lec-map-controls button').nth(2)
  const pairs = await page.locator('#atlas .bundle-g').evaluateAll((els) => els.map((e) => e.getAttribute('data-pair') ?? ''))
  expect(pairs.length).toBeGreaterThan(0)

  /** Points along the line (every 5%), in canvas units and on screen, with what `elementFromPoint` finds there. */
  const probe = (pair: string) =>
    page.evaluate((key) => {
      const boxes = [...document.querySelectorAll('#atlas [data-slot="CanvasGroup"]')].map((g) => {
        const r = g.querySelector('rect')!
        return { id: g.getAttribute('data-g') ?? '', x: Number(r.getAttribute('x')), y: Number(r.getAttribute('y')), w: Number(r.getAttribute('width')), h: Number(r.getAttribute('height')) }
      })
      const bg = document.querySelector(`#atlas .bundle-g[data-pair="${key}"]`)!
      const path = bg.querySelector('path.bundle') as SVGPathElement
      const ends = key.split('|')
      const len = path.getTotalLength()
      const ctm = path.getScreenCTM()!
      const stage = document.querySelector('.cv-stage')!.getBoundingClientRect()
      const inside: string[] = []
      const own: Array<{ x: number; y: number }> = []
      const other: string[] = []
      let samples = 0
      for (let i = 1; i < 20; i++) {
        const p = path.getPointAtLength((len * i) / 20)
        for (const b of boxes) if (!ends.includes(b.id) && p.x > b.x + 0.5 && p.x < b.x + b.w - 0.5 && p.y > b.y + 0.5 && p.y < b.y + b.h - 0.5) inside.push(b.id)
        const s = new DOMPoint(p.x, p.y).matrixTransform(ctm)
        if (s.x < stage.left + 4 || s.x > stage.right - 4 || s.y < stage.top + 4 || s.y > stage.bottom - 4) continue
        const el = document.elementFromPoint(s.x, s.y)
        if (!el?.closest('svg')) continue // under a HUD chip or panel
        samples++
        const hitPair = el.closest('.bundle-g')?.getAttribute('data-pair')
        if (hitPair === key) own.push({ x: s.x, y: s.y })
        else other.push(hitPair ?? el.getAttribute('class') ?? el.tagName)
      }
      return { inside, own, other, samples }
    }, pair)

  for (const pair of pairs) {
    const r = await probe(pair)
    expect(r.inside, `${pair} runs through another group`).toEqual([])
    expect(r.samples, `${pair}: points on screen`).toBeGreaterThanOrEqual(3)
    // most of the line is its own (a crossing with another bundle may take a point or two)
    expect(r.own.length, `${pair}: points that hit the line itself (others hit: ${r.other.join(', ')})`).toBeGreaterThanOrEqual(Math.ceil(r.samples * 0.6))
    // and a click on it locks this pair, not another one
    const at = r.own[Math.floor(r.own.length / 2)]!
    await page.mouse.click(at.x, at.y)
    await expect(page.locator('#atlas .bundle-g.on')).toHaveCount(1)
    await expect(page.locator('#atlas .bundle-g.on')).toHaveAttribute('data-pair', pair)
    await fitButton.click()
    await expect(page.locator('#atlas .bundle-g.on')).toHaveCount(0)
    await settle(page, 420)
  }
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
