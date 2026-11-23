/**
 * P4a WP-H2: the home overview map ("atlas") and the group cards, for both skins.
 *
 * Port of the 43 checks of the prototype (the home-canvas prototype, 21 per skin plus the persistence
 * check of the reader skin) to the real page, plus geometry under the four expansion presets (no rotated text, no
 * overlapping nodes, no link through a node, a link sampled every 3 px), performance (one branch / everything, dragging)
 * and hydration. The real backend is never reached: `/api/**` goes to the fixtures, the progress read to a local mock
 * with a known state (S6: the engine's demo content, templates/demo-content): MEA lectures 1-3 read and 4 reading, PLN 1 read
 * and 2 reading, LOG 1 read, nothing else. MEA has two frontmatter phases (L01-L03, L04-L06).
 *
 * Differences from the prototype tests (docs: the mapping table in the WP-H2 report):
 *   - the prototype's "back to the dependency canvas" step (a mode switch) does not exist in P4a (the dependency canvas is
 *     P4b); it is replaced by a check of the expansion toolbar;
 *   - the prototype hid its toast in the DOM; here a click is observed through the URL it leads to.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, waitForLabelPaint } from './fixtures'
import { useTheme, type Mode, type ThemeId } from './theme-helpers'
import { E2E_CONTENT_DIR } from '../../scripts/build_e2e.mjs'

const SKINS: ReadonlyArray<readonly [ThemeId, string, string]> = [
  ['reader', 'default', 'rect.tk, rect.pd'],
  ['datasheet', 'datasheet', 'rect.tk, rect.pd'],
]
const WIRE = { not_started: '未开始', in_progress: '学习中', completed: '已完成' } as const

/** `mea-l04` style ids of every lecture file of the demo content (the root language only). */
function lectureIds(): string[] {
  const out: string[] = []
  const root = path.join(E2E_CONTENT_DIR, 'lectures')
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'en') continue
    for (const f of fs.readdirSync(path.join(root, d.name))) {
      const m = /^L(\d+)\.md$/.exec(f)
      if (m) out.push(`${d.name.toLowerCase()}-l${String(Number(m[1])).padStart(2, '0')}`)
    }
  }
  return out
}

/** The demo progress: MEA 1-3 read and 4 reading, PLN 1 read and 2 reading, LOG 1 read, DAT nothing. */
function stateOf(id: string): keyof typeof WIRE {
  const m = /^([a-z]+)-l(\d+)$/.exec(id)
  if (!m) return 'not_started'
  const n = Number(m[2])
  if (m[1] === 'mea') return n <= 3 ? 'completed' : n === 4 ? 'in_progress' : 'not_started'
  if (m[1] === 'pln') return n <= 1 ? 'completed' : n === 2 ? 'in_progress' : 'not_started'
  if (m[1] === 'log') return n <= 1 ? 'completed' : 'not_started'
  return 'not_started'
}

async function mockProgress(page: Page): Promise<void> {
  const records = lectureIds().map((id) => ({
    lecture_id: id,
    group_id: id.split('-')[0],
    status: WIRE[stateOf(id)],
    completed_at: stateOf(id) === 'completed' ? '2026-11-01T00:00:00.000Z' : null,
    updated_at: '2026-11-01T00:00:00.000Z',
    notion_node_id: null,
    notion_page_id: null,
  }))
  await page.context().route(/\/api\/db\/progress(\/|\?|$)/, (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(records) })
  })
}

/** Open the home page in a theme and wait until the atlas shows that theme's components and the progress is in. */
async function openAtlas(page: Page, theme: ThemeId, impl: string, mode: Mode = 'light', size = { width: 1440, height: 900 }): Promise<void> {
  await page.setViewportSize(size)
  await mockProgress(page)
  await useTheme(page, theme, mode)
  await page.goto('/')
  await page.waitForSelector('html[data-hydrated="1"]')
  await page.waitForFunction((i) => document.querySelector('.am-layer [data-node="root"]')?.getAttribute('data-slot-impl') === i, impl)
  // the progress is in once MEA (lecture 4 being read) has been opened by the default "reading" expansion
  await page.waitForFunction(() => document.querySelectorAll('.am-lec').length > 0)
  await page.locator('.lec-map').first().scrollIntoViewIfNeeded()
  await waitForLabelPaint(page)
  await settle(page)
  await settle(page)
}

const settle = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
const count = (page: Page, sel: string): Promise<number> => page.locator(sel).count()
const synthetic = (page: Page, sel: string, type: 'click' | 'dblclick'): Promise<void> =>
  page.evaluate(([s, t]) => {
    document.querySelector(s as string)?.dispatchEvent(new MouseEvent(t as string, { bubbles: true }))
  }, [sel, type])

async function preset(page: Page, x: string): Promise<void> {
  await page.locator(`.am-expand button[data-x="${x}"]`).click()
  await settle(page)
}

/** Scale of the view (the svg's CSS transform). */
const scaleOf = (page: Page): Promise<number> => page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.lec-map-svg') as Element).transform).a)

const rectOf = (page: Page, sel: string): Promise<{ x: number; y: number; r: number; b: number }> =>
  page.evaluate((s) => {
    const r = (document.querySelector(s) as Element).getBoundingClientRect()
    return { x: r.x, y: r.y, r: r.right, b: r.bottom }
  }, sel)

const STAGE = '.lec-map'
const groupBox = (g: string): string => `.am-group[data-g="${g}"] > rect.lec-map-hit, .am-group[data-g="${g}"] > rect.am-chip`

/** Node boxes (hit areas, chips, centre) and links sampled every 3 px, all in svg user units. */
function geometry(): { nodes: number; overlap: number; ovs: string[]; cross: number; crs: string[]; rotated: number } {
  const svg = document.querySelector('.lec-map-svg') as SVGSVGElement
  const all: Array<[string, DOMRect]> = []
  svg.querySelectorAll('[data-node]').forEach((g) => {
    const id = g.getAttribute('data-node') as string
    g.querySelectorAll(':scope > rect.lec-map-hit, :scope > rect.am-chip, :scope > rect.am-root-box').forEach((r) => {
      const b = (r as SVGGraphicsElement).getBBox()
      if (b.width && b.height) all.push([id, b])
    })
  })
  let overlap = 0
  const ovs: string[] = []
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const [ia, a] = all[i] as [string, DOMRect]
      const [ib, b] = all[j] as [string, DOMRect]
      if (ia === ib) continue
      if (a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1) {
        overlap++
        if (ovs.length < 3) ovs.push(`${ia}x${ib}`)
      }
    }
  let cross = 0
  const crs: string[] = []
  svg.querySelectorAll('path[data-link]').forEach((p) => {
    const path = p as SVGPathElement
    const [from, to] = (path.getAttribute('data-link') as string).split('>')
    const len = path.getTotalLength()
    for (let t = 0; t <= len; t += 3) {
      const q = path.getPointAtLength(t)
      for (const [id, b] of all) {
        if (id === from || id === to) continue
        if (q.x > b.x + 1.5 && q.x < b.x + b.width - 1.5 && q.y > b.y + 1.5 && q.y < b.y + b.height - 1.5) {
          cross++
          if (crs.length < 3) crs.push(`${from}>${to} through ${id}`)
          break
        }
      }
    }
  })
  const rotated = [...svg.querySelectorAll('text')].filter((t) => /rotate/.test(t.getAttribute('transform') ?? '')).length
  return { nodes: new Set(all.map((a) => a[0])).size, overlap, ovs, cross, crs, rotated }
}

for (const [theme, impl] of SKINS) {
  test.describe(`atlas: ${theme}`, () => {
    let consoleProblems: string[] = []
    let pageErrors: string[] = []

    test.beforeEach(({ page }) => {
      consoleProblems = []
      pageErrors = []
      page.on('pageerror', (e) => pageErrors.push(String(e)))
      page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && !/Failed to load resource/.test(m.text())) consoleProblems.push(m.text())
      })
    })

    // prototype check 1
    test('1. default "reading": MEA and PLN open, LOG collapsed to a strip of one mark per lecture, 4 groups, toolbar', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const d = await page.evaluate(() => ({
        mea: document.querySelectorAll('.am-lec[data-node^="mea-"]').length,
        pln: document.querySelectorAll('.am-lec[data-node^="pln-"]').length,
        log: document.querySelectorAll('.am-lec[data-node^="log-"]').length,
        logMarks: document.querySelectorAll('.am-group[data-g="LOG"] [data-atlas-part="strip"] rect.tk, .am-group[data-g="LOG"] [data-atlas-part="strip"] rect.pd').length,
        groups: document.querySelectorAll('.am-group').length,
        presets: document.querySelectorAll('.am-expand button').length,
        pressed: document.querySelector('.am-expand button[aria-pressed="true"]')?.getAttribute('data-x'),
      }))
      expect(d.mea).toBeGreaterThan(0)
      expect(d.pln).toBeGreaterThan(0)
      expect(d.log).toBe(0)
      expect(d.logMarks).toBe(3)
      expect(d.groups).toBe(4)
      expect(d.presets).toBe(4)
      expect(d.pressed).toBe('reading')
    })

    // 2
    test('2. fitted: the whole map is inside the stage', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const s = await rectOf(page, STAGE)
      const m = await rectOf(page, '.am-layer')
      expect(m.x).toBeGreaterThanOrEqual(s.x - 2)
      expect(m.y).toBeGreaterThanOrEqual(s.y - 2)
      expect(m.r).toBeLessThanOrEqual(s.r + 2)
      expect(m.b).toBeLessThanOrEqual(s.b + 2)
    })

    // 3-8 and the geometry gate of the plan: four presets
    for (const p of ['reading', 'all', 'none', 'progress'] as const) {
      test(`3. "${p}": all text horizontal, no node overlaps another, no link runs through a node`, async ({ page }) => {
        await openAtlas(page, theme, impl)
        await preset(page, p)
        const g = await page.evaluate(geometry)
        expect(g.rotated, 'rotated text').toBe(0)
        expect(g.overlap, `overlaps ${g.ovs.join(' ')}`).toBe(0)
        expect(g.cross, `crossings ${g.crs.join(' ')}`).toBe(0)
        expect(g.nodes).toBeGreaterThan(6) // centre, 2 categories, 4 groups at the least
        if (p === 'all') {
          const n = await page.evaluate(() => ({ all: document.querySelectorAll('.am-lec').length, log: !!document.querySelector('.am-lec[data-node^="log-"]'), dat: !!document.querySelector('.am-lec[data-node^="dat-"]') }))
          expect(n.all, '14 lectures, LOG and DAT among them').toBe(14)
          expect(n.log && n.dat).toBe(true)
        }
        if (p === 'none') expect(await count(page, '.am-lec'), 'only the 4 group rows remain').toBe(0)
      })
    }

    // 9, 10, 11
    test('4. +/- opens LOG and the node stays where it was; the status strip opens DAT; a phase label toggles its lectures', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const before = await rectOf(page, groupBox('LOG'))
      await synthetic(page, '.am-group[data-g="LOG"] [data-atlas-part="toggle"]', 'click')
      await settle(page)
      const after = await rectOf(page, groupBox('LOG'))
      expect(await count(page, '.am-lec[data-node^="log-"]')).toBeGreaterThan(0)
      expect(Math.abs(after.x - before.x), 'x moved').toBeLessThan(1.5)
      expect(Math.abs(after.y - before.y), 'y moved').toBeLessThan(1.5)
      await synthetic(page, '.am-group[data-g="LOG"] [data-atlas-part="toggle"]', 'click')
      await settle(page)
      await synthetic(page, '.am-group[data-g="DAT"] [data-atlas-part="strip"]', 'click')
      await settle(page)
      expect(await count(page, '.am-lec[data-node^="dat-"]'), 'lectures of DAT').toBe(2)
      // MEA has two phases (frontmatter `phase`): with everything collapsed its strip opens the phase rows only
      await preset(page, 'none')
      await synthetic(page, '.am-group[data-g="MEA"] [data-atlas-part="strip"]', 'click')
      await settle(page)
      expect(await count(page, '[data-st^="MEA/s"]'), 'phases of MEA').toBe(2)
      const st0 = await count(page, '.am-lec[data-node^="mea-"]')
      await synthetic(page, '.am-stage[data-st="MEA/s0"]', 'click')
      await settle(page)
      expect(await count(page, '.am-lec[data-node^="mea-"]')).toBe(st0 + 3)
    })

    // 12, 13
    test('5. a single click opens a lecture, a group opens its page (after the double-click window)', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await synthetic(page, '.am-lec[data-node="mea-l04"]', 'click')
      await page.waitForURL(/\/mea\/L04/)
      await page.goBack()
      await openAtlas(page, theme, impl)
      await synthetic(page, '.am-group[data-g="DAT"]', 'click')
      await page.waitForURL(/\/dat\/$/)
    })

    // 14, 15
    test('6. a double click on a group opens all of it and zooms so that names read; PLN shows from lecture 1', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const s = await rectOf(page, STAGE)
      await synthetic(page, '.am-group[data-g="MEA"]', 'dblclick')
      await settle(page)
      const z = await page.evaluate(
        ([sr]) => {
          const ns = [...document.querySelectorAll('.am-lec[data-node^="mea-"]')]
          let out = 0
          for (const n of ns) {
            const r = (n.querySelector('.lec-map-hit') as Element).getBoundingClientRect()
            if (r.x < (sr as number[])[0]! || r.y < (sr as number[])[1]! + 50 || r.right > (sr as number[])[2]! || r.bottom > (sr as number[])[3]!) out++
          }
          return { n: ns.length, out }
        },
        [[s.x, s.y, s.r, s.b]],
      )
      expect(z.n).toBe(6)
      expect(z.out, 'lectures of MEA outside the stage').toBe(0)
      await page.locator('.lec-map-controls button', { hasText: /.+/ }).last().click()
      await settle(page)
      await synthetic(page, '.am-group[data-g="PLN"]', 'dblclick')
      await settle(page)
      const g3 = await page.evaluate(() => {
        const first = (document.querySelector('.am-lec[data-node="pln-l01"] .lec-map-hit') as Element).getBoundingClientRect()
        const st = (document.querySelector('.lec-map') as Element).getBoundingClientRect()
        return { n: document.querySelectorAll('.am-lec[data-node^="pln-"]').length, firstIn: first.y > st.y + 50 && first.bottom < st.bottom }
      })
      expect(g3.n).toBe(3)
      expect(await scaleOf(page), 'names read from 70%').toBeGreaterThanOrEqual(0.7 - 1e-6)
      expect(g3.firstIn).toBe(true)
    })

    // 16
    test('7. search: a hit in a collapsed group lights the group row; Enter opens it and brings the hit into view; Enter again steps on', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await page.locator('.am-search').fill('条件语句')
      expect(await page.locator('.am-group[data-g="LOG"]').evaluate((e) => e.classList.contains('match'))).toBe(true)
      await page.locator('.am-search').press('Enter')
      await settle(page)
      const s = await rectOf(page, STAGE)
      const hit = await page.evaluate(([sr]) => {
        const n = document.querySelector('.am-lec[data-node="log-l02"]')
        if (!n) return { found: false }
        const r = (n.querySelector('.lec-map-hit') as Element).getBoundingClientRect()
        const b = sr as number[]
        return { found: true, match: n.classList.contains('match'), inView: r.x > b[0]! && r.right < b[2]! && r.y > b[1]! + 50 && r.bottom < b[3]! }
      }, [[s.x, s.y, s.r, s.b]])
      expect(hit).toEqual({ found: true, match: true, inView: true })
      // a query with several hits: Enter again goes to the next one
      await page.locator('.am-search').fill('与')
      await page.locator('.am-search').press('Enter')
      await settle(page)
      const first = await page.locator('.am-status').innerText()
      await page.locator('.am-search').press('Enter')
      await settle(page)
      const second = await page.locator('.am-status').innerText()
      expect(first).toMatch(/1 \/ \d+|Result 1 of/)
      expect(second).toMatch(/2 \/ \d+|Result 2 of/)
      await page.locator('.am-search').fill('')
    })

    // 17, 18
    test('8. hovering a lecture name lights its branch, 1 prerequisite and 3 follow-ups of MEA L04, and the info panel lists them; moving away restores', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await synthetic(page, '.am-group[data-g="MEA"]', 'dblclick')
      await settle(page)
      const pt = await page.evaluate(() => {
        const r = (document.querySelector('.am-lec[data-node="mea-l04"] .lec-map-hit') as Element).getBoundingClientRect()
        return { x: r.x + r.width * 0.75, y: r.y + r.height / 2 }
      })
      await page.mouse.move(pt.x, pt.y)
      await settle(page)
      const f = await page.evaluate(() => ({
        hover: document.querySelector('.am-lec[data-node="mea-l04"]')?.classList.contains('hover'),
        dim: document.querySelector('.am-layer')?.classList.contains('am-dim'),
        pre: document.querySelectorAll('.am-node.pre').length,
        post: document.querySelectorAll('.am-node.post').length,
        links: document.querySelectorAll('.am-link.on').length,
        tip: document.querySelector('.lec-map-info')?.textContent ?? '',
      }))
      expect(f.hover).toBe(true)
      expect(f.dim).toBe(true)
      expect(f.pre).toBe(1)
      expect(f.post).toBe(3)
      expect(f.links).toBeGreaterThanOrEqual(4)
      expect(f.tip).toMatch(/先修|Prerequisite/)
      await page.mouse.move(5, 5)
      await settle(page)
      const cl = await page.evaluate(() => ({ dim: document.querySelector('.am-layer')?.classList.contains('am-dim'), on: document.querySelectorAll('.am-node.on, .am-link.on').length }))
      expect(cl).toEqual({ dim: false, on: 0 })
    })

    // 19
    test('9. a click on a category zooms to it', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const k0 = await scaleOf(page)
      await synthetic(page, '.cat-hit', 'click')
      await settle(page)
      expect(await scaleOf(page)).not.toBe(k0)
    })

    // 20 (replaces the prototype's "back to the dependency canvas": no mode switch in P4a)
    test('10. the expansion toolbar: four choices, one pressed, the pressed one follows the click', async ({ page }) => {
      await openAtlas(page, theme, impl)
      for (const p of ['progress', 'all', 'none', 'reading']) {
        await preset(page, p)
        expect(await page.locator('.am-expand button[aria-pressed="true"]').getAttribute('data-x')).toBe(p)
      }
    })

    // 21
    test('11. no script errors, no console warnings, no hydration complaints', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await preset(page, 'all')
      await preset(page, 'reading')
      expect(pageErrors).toEqual([])
      expect(consoleProblems).toEqual([])
    })

    // 22 (reader skin in the prototype; here both)
    test('12. the expansion choice is kept in this browser: "all" survives a reload', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await preset(page, 'all')
      await page.reload()
      await page.waitForFunction(() => document.querySelectorAll('.am-lec').length === 14)
      const mem = await page.evaluate(() => ({ pressed: document.querySelector('.am-expand button[aria-pressed="true"]')?.getAttribute('data-x'), stored: localStorage.getItem('lecture:atlas-expand') }))
      expect(mem).toEqual({ pressed: 'all', stored: 'all' })
    })

    test('14. screenshot baseline: the fitted overview (light, desktop) @visual', async ({ page }) => {
      test.skip(test.info().project.name !== 'prod', 'baselines are recorded for the prod project only')
      await openAtlas(page, theme, impl)
      await expect(page.locator('.lec-map').first()).toHaveScreenshot(`v2-atlas-${theme}-light-desktop.png`)
    })

    test('13. group cards: one per group, with the three-height status strip (reader) or the package pins (datasheet), the read count and the next line as text', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const cards = page.locator('#groups [data-slot="GroupCard"]')
      await expect(cards).toHaveCount(4)
      const mea = page.locator('#groups [data-group="MEA"]')
      await expect(mea).toHaveAttribute('data-slot-impl', impl)
      await expect(mea).toContainText('3 / 6')
      await expect(mea).toContainText('第4讲')
      expect(await mea.getAttribute('href')).toBe('/mea/')
      // never an empty "next": PLN is being read at lecture 2, DAT not started
      await expect(page.locator('#groups [data-group="PLN"]')).toContainText('第2讲')
      await expect(page.locator('#groups [data-group="DAT"]')).toContainText('第1讲')
      if (theme === 'reader') {
        const heights = await mea.locator('.ticks i').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).height)))
        expect(heights).toHaveLength(6)
        expect(new Set(heights).size, 'three heights').toBe(3)
        expect(heights[0]).toBeGreaterThan(heights[3] as number)
        expect(heights[3]).toBeGreaterThan(heights[5] as number)
      } else {
        expect(await mea.locator('svg.pkg').getAttribute('aria-hidden')).toBe('true')
        expect(await mea.locator('svg.pkg rect.p').count(), 'SOIC-6: 6 pins').toBe(6)
        expect(await mea.locator('svg.pkg rect.p.nc').count(), 'no NC pin').toBe(0)
        expect(await mea.locator('svg.pkg .chip-pkg').innerHTML()).toContain('SOIC-6')
        // an odd lecture count gets one NC pin: LOG (3 lectures) is a SOIC-4
        const log = page.locator('#groups [data-group="LOG"]')
        expect(await log.locator('svg.pkg rect.p').count(), 'SOIC-4: 4 pins').toBe(4)
        expect(await log.locator('svg.pkg rect.p.nc').count(), 'one NC pin').toBe(1)
      }
    })
  })
}

// ---- performance (both skins; the production build) --------------------------------------------------------------

for (const [theme, impl] of SKINS) {
  test.describe(`atlas performance: ${theme}`, () => {
    test('expanding or collapsing one branch takes at most 50 ms to the next frame, everything at most 80 ms', async ({ page }, info) => {
      await openAtlas(page, theme, impl)
      const timed = (act: string): Promise<{ sync: number; frame: number; next: number }> =>
        page.evaluate(async (code) => {
          const el = document.querySelector(code) as Element
          const t0 = performance.now()
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          await new Promise<void>((r) => setTimeout(r, 0))
          const sync = performance.now() - t0
          const frame = await new Promise<number>((r) => requestAnimationFrame(() => r(performance.now() - t0)))
          const next = await new Promise<number>((r) => requestAnimationFrame(() => r(performance.now() - t0)))
          return { sync, frame, next }
        }, act)
      const result: Record<string, { sync: number; frame: number; next: number }> = {}
      result['open LOG'] = await timed('.am-group[data-g="LOG"] [data-atlas-part="toggle"]')
      await settle(page)
      result['close LOG'] = await timed('.am-group[data-g="LOG"] [data-atlas-part="toggle"]')
      await settle(page)
      result['open DAT'] = await timed('.am-group[data-g="DAT"] [data-atlas-part="strip"]')
      await settle(page)
      result['everything'] = await timed('.am-expand button[data-x="all"]')
      await settle(page)
      result['collapse everything'] = await timed('.am-expand button[data-x="none"]')
      info.annotations.push({ type: 'timings', description: JSON.stringify(result, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)) })
      console.warn(`[atlas perf ${theme}] ${JSON.stringify(result, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v))}`)
      // contract: one branch <= 50 ms to the next frame, everything <= 80 ms.
      for (const k of ['open LOG', 'close LOG', 'open DAT']) expect(result[k]!.frame, k).toBeLessThanOrEqual(50)
      expect(result['everything']!.frame, 'everything (contract 80 ms)').toBeLessThanOrEqual(80)
    })

    // The mouse is driven through CDP, not `page.mouse`: with the config's `trace: 'retain-on-failure'` Playwright snapshots the whole DOM
    // on every `mouse.move`, and on the 3300-element svg of the atlas that is 5-8 ms of main-thread work per move, which showed up as
    // 40-50 ms frames that the page itself never has (WP-F1: with the trace off the worst frame is ~18 ms, and `getComputedStyle` is not
    // called once during the drag).
    test('dragging the map has no frame longer than 30 ms', async ({ page }) => {
      test.skip(test.info().project.name === 'dev', 'frame budget of the built site: on the dev server the code is not minified and runs with Vue dev checks (frames of ~33 ms), so 30 ms is not a dev budget')
      await page.addInitScript(() => {
        const w = window as unknown as { __gcs: number }
        w.__gcs = 0
        const orig = window.getComputedStyle.bind(window)
        window.getComputedStyle = ((...a: Parameters<typeof orig>) => {
          w.__gcs++
          return orig(...a)
        }) as typeof window.getComputedStyle
      })
      await openAtlas(page, theme, impl)
      // let the label layer finish reading the styles of the labels that were off screen (idle time), as a reader's first second does
      await page.waitForTimeout(500)
      const s = await rectOf(page, STAGE)
      const cx = (s.x + s.r) / 2
      const cy = s.y + 120
      const cdp = await page.context().newCDPSession(page)
      const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number): Promise<unknown> =>
        cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: type === 'mouseMoved' ? 0 : 1 })
      const drag = async (n: number): Promise<void> => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
        await mouse('mousePressed', cx, cy)
        for (let i = 1; i <= n; i++) await mouse('mouseMoved', cx + (i % 40) * 6, cy + Math.sin(i / 6) * 60)
        await mouse('mouseReleased', cx + 240, cy)
      }
      // one short drag first: the first pointer move of a page runs code for the first time (JIT, lazy chunks) and the measure is of
      // dragging, not of that
      await drag(20)
      await page.waitForLoadState('networkidle')
      await page.evaluate(() => {
        const w = window as unknown as { __frames: number[]; __gcs: number }
        w.__gcs = 0
        w.__frames = []
        let last = performance.now()
        const loop = (now: number): void => {
          w.__frames.push(now - last)
          last = now
          if (w.__frames.length < 600) requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
      })
      await drag(80)
      await cdp.detach()
      const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames.slice(2))
      const max = Math.max(...frames)
      console.warn(`[atlas drag ${theme}] frames=${frames.length} max=${max.toFixed(1)}ms`)
      expect(frames.length).toBeGreaterThan(20)
      expect(max).toBeLessThanOrEqual(30)
      // styles are read once per collect / class change, never in a drag frame
      expect(await page.evaluate(() => (window as unknown as { __gcs: number }).__gcs), 'getComputedStyle calls while dragging').toBe(0)
    })
  })
}

// ---- hydration (the server render equals the first client render) ---------------------------------------------------

test.describe('atlas: server render', () => {
  for (const url of ['/', '/en/']) {
    test(`${url}: the overview and the cards are in the server HTML; no hydration warning; English home uses English chrome`, async ({ page, request }) => {
      test.skip(test.info().project.name === 'dev', 'built site only: the dev server does not server-render pages (its HTML is an empty #app shell), so there is no server HTML to check or to hydrate against')
      const html = await (await request.get(url)).text()
      expect(html).toContain('class="lec-map')
      expect((html.match(/data-slot="GroupCard"/g) ?? []).length).toBe(4)
      expect((html.match(/data-slot="AtlasGroup"/g) ?? []).length).toBe(4)
      const problems: string[] = []
      page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && /hydrat/i.test(m.text())) problems.push(m.text())
      })
      await mockProgress(page)
      await page.goto(url)
      await page.waitForFunction(() => document.querySelectorAll('.am-group').length === 4)
      await settle(page)
      expect(problems).toEqual([])
      if (url === '/en/') {
        await expect(page.locator('.am-search')).toHaveAttribute('placeholder', /Search lectures/)
        await expect(page.locator('#atlas .hb-h2')).toHaveText('Course overview')
      }
    })
  }
})
