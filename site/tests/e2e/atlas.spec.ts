/**
 * P4a WP-H2: the home overview map ("atlas") and the group cards, for both skins.
 *
 * Port of the 43 checks of the prototype (the home-canvas prototype, 21 per skin plus the persistence
 * check of the reader skin) to the real page, plus geometry under the four expansion presets (no rotated text, no
 * overlapping nodes, no link through a node, a link sampled every 3 px), performance (one branch / everything, dragging)
 * and hydration. The real backend is never reached: `/api/**` goes to the fixtures, the progress read to a local mock
 * with a known state: G03 lectures 1-6 read and 7 reading, G05 1-18 read and 19 reading, G01 1-3 read, nothing else.
 *
 * Differences from the prototype tests (docs: the mapping table in the WP-H2 report):
 *   - the prototype's "back to the dependency canvas" step (a mode switch) does not exist in P4a (the dependency canvas is
 *     P4b); it is replaced by a check of the expansion toolbar;
 *   - the prototype hid its toast in the DOM; here a click is observed through the URL it leads to.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, DOCS_ROOT, waitForLabelPaint } from './fixtures'
import { useTheme, type Mode, type ThemeId } from './theme-helpers'

const SKINS: ReadonlyArray<readonly [ThemeId, string, string]> = [
  ['reader', 'default', 'rect.tk, rect.pd'],
  ['datasheet', 'datasheet', 'rect.tk, rect.pd'],
]
const WIRE = { not_started: '未开始', in_progress: '学习中', completed: '已完成' } as const

/** `g05-l19` style ids of every lecture file (the root language only). */
function lectureIds(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'en' || e.name === 'public' || e.name === 'examples') continue
      walk(path.join(dir, e.name))
    }
    for (const f of fs.readdirSync(dir)) {
      const m = /^L(\d+)\.md$/.exec(f)
      if (m) out.push(`${path.basename(dir).toLowerCase()}-l${String(Number(m[1])).padStart(2, '0')}`)
    }
  }
  walk(DOCS_ROOT)
  const ex = path.join(DOCS_ROOT, 'examples')
  if (fs.existsSync(ex)) for (const d of fs.readdirSync(ex)) for (const f of fs.statSync(path.join(ex, d)).isDirectory() ? fs.readdirSync(path.join(ex, d)) : []) {
    const m = /^L(\d+)\.md$/.exec(f)
    if (m) out.push(`${d.toLowerCase()}-l${String(Number(m[1])).padStart(2, '0')}`)
  }
  return out
}

function stateOf(id: string): keyof typeof WIRE {
  const m = /^(g\d+|lr|spi)-l(\d+)$/.exec(id)
  if (!m) return 'not_started'
  const n = Number(m[2])
  if (m[1] === 'g03') return n <= 6 ? 'completed' : n === 7 ? 'in_progress' : 'not_started'
  if (m[1] === 'g05') return n <= 18 ? 'completed' : n === 19 ? 'in_progress' : 'not_started'
  if (m[1] === 'g01') return n <= 3 ? 'completed' : 'not_started'
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
  // the progress is in once G03 (lecture 7 being read) has been opened by the default "reading" expansion
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
    test('1. default "reading": G03 and G05 open, G01 collapsed to a strip of one mark per lecture, 15 groups, toolbar', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const d = await page.evaluate(() => ({
        g03: document.querySelectorAll('.am-lec[data-node^="g03-"]').length,
        g05: document.querySelectorAll('.am-lec[data-node^="g05-"]').length,
        g01: document.querySelectorAll('.am-lec[data-node^="g01-"]').length,
        g01marks: document.querySelectorAll('.am-group[data-g="G01"] [data-atlas-part="strip"] rect.tk, .am-group[data-g="G01"] [data-atlas-part="strip"] rect.pd').length,
        groups: document.querySelectorAll('.am-group').length,
        presets: document.querySelectorAll('.am-expand button').length,
        pressed: document.querySelector('.am-expand button[aria-pressed="true"]')?.getAttribute('data-x'),
      }))
      expect(d.g03).toBeGreaterThan(0)
      expect(d.g05).toBeGreaterThan(0)
      expect(d.g01).toBe(0)
      expect(d.g01marks).toBe(20)
      expect(d.groups).toBe(17)
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
        expect(g.nodes).toBeGreaterThan(15)
        if (p === 'all') {
          const n = await page.evaluate(() => ({ all: document.querySelectorAll('.am-lec').length, lr: !!document.querySelector('.am-lec[data-node^="lr-"]'), spi: !!document.querySelector('.am-lec[data-node^="spi-"]') }))
          expect(n.all, '404 lectures, LR and SPI among them').toBe(404)
          expect(n.lr && n.spi).toBe(true)
        }
        if (p === 'none') expect(await count(page, '.am-lec'), 'only the 17 group rows remain').toBe(0)
      })
    }

    // 9, 10, 11
    test('4. +/- opens G01 and the node stays where it was; the status strip opens G10; a phase label toggles its lectures', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const before = await rectOf(page, groupBox('G01'))
      await synthetic(page, '.am-group[data-g="G01"] [data-atlas-part="toggle"]', 'click')
      await settle(page)
      const after = await rectOf(page, groupBox('G01'))
      expect(await count(page, '.am-lec[data-node^="g01-"], [data-st^="G01/s"]')).toBeGreaterThan(0)
      expect(Math.abs(after.x - before.x), 'x moved').toBeLessThan(1.5)
      expect(Math.abs(after.y - before.y), 'y moved').toBeLessThan(1.5)
      await synthetic(page, '.am-group[data-g="G01"] [data-atlas-part="toggle"]', 'click')
      await settle(page)
      await synthetic(page, '.am-group[data-g="G10"] [data-atlas-part="strip"]', 'click')
      await settle(page)
      expect(await count(page, '[data-st^="G10/s"]'), 'phases of G10').toBeGreaterThan(0)
      const st0 = await count(page, '.am-lec[data-node^="g10-"]')
      await synthetic(page, '.am-stage[data-st="G10/s0"]', 'click')
      await settle(page)
      expect(await count(page, '.am-lec[data-node^="g10-"]')).toBe(st0 + 4)
    })

    // 12, 13
    test('5. a single click opens a lecture, a group opens its page (after the double-click window)', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await synthetic(page, '.am-lec[data-node="g05-l19"]', 'click')
      await page.waitForURL(/\/g05\/L19/)
      await page.goBack()
      await openAtlas(page, theme, impl)
      await synthetic(page, '.am-group[data-g="G02"]', 'click')
      await page.waitForURL(/\/g02\/$/)
    })

    // 14, 15
    test('6. a double click on a group opens all of it and zooms so that names read; G03 (63 lectures) shows from lecture 1', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const s = await rectOf(page, STAGE)
      await synthetic(page, '.am-group[data-g="G05"]', 'dblclick')
      await settle(page)
      const z = await page.evaluate(
        ([sr]) => {
          const ns = [...document.querySelectorAll('.am-lec[data-node^="g05-"]')]
          let out = 0
          for (const n of ns) {
            const r = (n.querySelector('.lec-map-hit') as Element).getBoundingClientRect()
            if (r.x < (sr as number[])[0]! || r.y < (sr as number[])[1]! + 50 || r.right > (sr as number[])[2]! || r.bottom > (sr as number[])[3]!) out++
          }
          return { n: ns.length, out }
        },
        [[s.x, s.y, s.r, s.b]],
      )
      expect(z.n).toBe(31)
      expect(z.out, 'lectures of G05 outside the stage').toBe(0)
      await page.locator('.lec-map-controls button', { hasText: /.+/ }).last().click()
      await settle(page)
      await synthetic(page, '.am-group[data-g="G03"]', 'dblclick')
      await settle(page)
      const g3 = await page.evaluate(() => {
        const first = (document.querySelector('.am-lec[data-node="g03-l01"] .lec-map-hit') as Element).getBoundingClientRect()
        const st = (document.querySelector('.lec-map') as Element).getBoundingClientRect()
        return { n: document.querySelectorAll('.am-lec[data-node^="g03-"]').length, firstIn: first.y > st.y + 50 && first.bottom < st.bottom }
      })
      expect(g3.n).toBe(63)
      expect(await scaleOf(page), 'names read from 70%').toBeGreaterThanOrEqual(0.7 - 1e-6)
      expect(g3.firstIn).toBe(true)
    })

    // 16
    test('7. search: a hit in a collapsed group lights the group row; Enter opens it and brings the hit into view; Enter again steps on', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await page.locator('.am-search').fill('直流与交流')
      expect(await page.locator('.am-group[data-g="G01"]').evaluate((e) => e.classList.contains('match'))).toBe(true)
      await page.locator('.am-search').press('Enter')
      await settle(page)
      const s = await rectOf(page, STAGE)
      const hit = await page.evaluate(([sr]) => {
        const n = document.querySelector('.am-lec[data-node="g01-l02"]')
        if (!n) return { found: false }
        const r = (n.querySelector('.lec-map-hit') as Element).getBoundingClientRect()
        const b = sr as number[]
        return { found: true, match: n.classList.contains('match'), inView: r.x > b[0]! && r.right < b[2]! && r.y > b[1]! + 50 && r.bottom < b[3]! }
      }, [[s.x, s.y, s.r, s.b]])
      expect(hit).toEqual({ found: true, match: true, inView: true })
      // a query with several hits: Enter again goes to the next one
      await page.locator('.am-search').fill('查询')
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
    test('8. hovering a lecture name lights its branch, 6 prerequisites and 3 follow-ups of G05 L19, and the info panel lists them; moving away restores', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await synthetic(page, '.am-group[data-g="G05"]', 'dblclick')
      await settle(page)
      const pt = await page.evaluate(() => {
        const r = (document.querySelector('.am-lec[data-node="g05-l19"] .lec-map-hit') as Element).getBoundingClientRect()
        return { x: r.x + r.width * 0.75, y: r.y + r.height / 2 }
      })
      await page.mouse.move(pt.x, pt.y)
      await settle(page)
      const f = await page.evaluate(() => ({
        hover: document.querySelector('.am-lec[data-node="g05-l19"]')?.classList.contains('hover'),
        dim: document.querySelector('.am-layer')?.classList.contains('am-dim'),
        pre: document.querySelectorAll('.am-node.pre').length,
        post: document.querySelectorAll('.am-node.post').length,
        links: document.querySelectorAll('.am-link.on').length,
        tip: document.querySelector('.lec-map-info')?.textContent ?? '',
      }))
      expect(f.hover).toBe(true)
      expect(f.dim).toBe(true)
      expect(f.pre).toBe(6)
      expect(f.post).toBe(3)
      expect(f.links).toBeGreaterThanOrEqual(9)
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
      await page.waitForFunction(() => document.querySelectorAll('.am-lec').length === 404)
      const mem = await page.evaluate(() => ({ pressed: document.querySelector('.am-expand button[aria-pressed="true"]')?.getAttribute('data-x'), stored: localStorage.getItem('lecture:atlas-expand') }))
      expect(mem).toEqual({ pressed: 'all', stored: 'all' })
    })

    test('14. screenshot baseline: the fitted overview (light, desktop) @visual', async ({ page }) => {
      await openAtlas(page, theme, impl)
      await expect(page.locator('.lec-map').first()).toHaveScreenshot(`v2-atlas-${theme}-light-desktop.png`)
    })

    test('13. group cards: one per group, with the three-height status strip (reader) or the package pins (datasheet), the read count and the next line as text', async ({ page }) => {
      await openAtlas(page, theme, impl)
      const cards = page.locator('#groups [data-slot="GroupCard"]')
      await expect(cards).toHaveCount(17)
      const g05 = page.locator('#groups [data-group="G05"]')
      await expect(g05).toHaveAttribute('data-slot-impl', impl)
      await expect(g05).toContainText('18 / 31')
      await expect(g05).toContainText('第19讲')
      expect(await g05.getAttribute('href')).toBe('/g05/')
      // never an empty "next": G03 is being read at lecture 7, G02 not started
      await expect(page.locator('#groups [data-group="G03"]')).toContainText('第7讲')
      await expect(page.locator('#groups [data-group="G02"]')).toContainText('第1讲')
      if (theme === 'reader') {
        const heights = await g05.locator('.ticks i').evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).height)))
        expect(heights).toHaveLength(31)
        expect(new Set(heights).size, 'three heights').toBe(3)
        expect(heights[0]).toBeGreaterThan(heights[18] as number)
        expect(heights[18]).toBeGreaterThan(heights[30] as number)
      } else {
        expect(await g05.locator('svg.pkg').getAttribute('aria-hidden')).toBe('true')
        expect(await g05.locator('svg.pkg rect.p').count(), 'DIP-32: 32 pins').toBe(32)
        expect(await g05.locator('svg.pkg rect.p.nc').count(), 'one NC pin').toBe(1)
        expect(await g05.locator('svg.pkg .chip-pkg').innerHTML()).toContain('DIP-32')
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
      result['open G01'] = await timed('.am-group[data-g="G01"] [data-atlas-part="toggle"]')
      await settle(page)
      result['close G01'] = await timed('.am-group[data-g="G01"] [data-atlas-part="toggle"]')
      await settle(page)
      result['open G08'] = await timed('.am-group[data-g="G08"] [data-atlas-part="strip"]')
      await settle(page)
      result['everything'] = await timed('.am-expand button[data-x="all"]')
      await settle(page)
      result['collapse everything'] = await timed('.am-expand button[data-x="none"]')
      info.annotations.push({ type: 'timings', description: JSON.stringify(result, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)) })
      console.warn(`[atlas perf ${theme}] ${JSON.stringify(result, (_k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v))}`)
      // contract: one branch <= 50 ms to the next frame, everything <= 80 ms.
      for (const k of ['open G01', 'close G01', 'open G08']) expect(result[k]!.frame, k).toBeLessThanOrEqual(50)
      expect(result['everything']!.frame, 'everything (contract 80 ms)').toBeLessThanOrEqual(80)
    })

    // The mouse is driven through CDP, not `page.mouse`: with the config's `trace: 'retain-on-failure'` Playwright snapshots the whole DOM
    // on every `mouse.move`, and on the 3300-element svg of the atlas that is 5-8 ms of main-thread work per move, which showed up as
    // 40-50 ms frames that the page itself never has (WP-F1: with the trace off the worst frame is ~18 ms, and `getComputedStyle` is not
    // called once during the drag).
    test('dragging the map has no frame longer than 30 ms', async ({ page }) => {
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
      const html = await (await request.get(url)).text()
      expect(html).toContain('class="lec-map')
      expect((html.match(/data-slot="GroupCard"/g) ?? []).length).toBe(17)
      expect((html.match(/data-slot="AtlasGroup"/g) ?? []).length).toBe(17)
      const problems: string[] = []
      page.on('console', (m) => {
        if ((m.type() === 'error' || m.type() === 'warning') && /hydrat/i.test(m.text())) problems.push(m.text())
      })
      await mockProgress(page)
      await page.goto(url)
      await page.waitForFunction(() => document.querySelectorAll('.am-group').length === 17)
      await settle(page)
      expect(problems).toEqual([])
      if (url === '/en/') {
        await expect(page.locator('.am-search')).toHaveAttribute('placeholder', /Search lectures/)
        await expect(page.locator('#atlas .hb-h2')).toHaveText('Course overview')
      }
    })
  }
})
