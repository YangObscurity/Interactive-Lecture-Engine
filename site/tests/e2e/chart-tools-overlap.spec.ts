/**
 * ECharts figures in the text and in the viewer (spec board 07: "图框不显示常驻按钮；悬停时右上角出一个放大图标，点图或图标打开全站
 * 共用的查看器（可缩放、平移、关闭；导出放在查看器里）"; S6Y audit-spec #8 #9 #10).
 *
 * The engine used to add the ECharts toolbox (save image, data view, restore) in the top right corner, next to the enlarge icon
 * (an earlier version of this spec checked that the two did not overlap). Now, for every ECharts figure of the demo lectures, in
 * both skins, light and dark, on a 390 px touch phone and a 1280 px desktop:
 *   - the chart draws no tool icons (no small shapes in the top right strip of its SVG);
 *   - the enlarge icon is on top at its centre and opens the viewer; a click (a tap) on the chart itself opens it too;
 *   - in the viewer the title is the figure number and caption (no type tag, no internal id), the tool bar has an export
 *     button, the "loading" placeholder is gone and the whole chart (x axis included) fits inside the stage.
 * Functional check on the built demo site (prod project).
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme, type ThemeId, type Mode } from './theme-helpers'

// S6 demo lectures with ECharts figures
const LECTURES = ['/mea/L03', '/mea/L04', '/mea/L05'] as const
const LOOKS: Array<[ThemeId, Mode]> = [
  ['reader', 'light'],
  ['datasheet', 'dark'],
]
const FIG = 'figure.chart[data-type="echarts"]:not(.chart--modal)'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The n-th ECharts figure: its enlarge icon and the small drawn shapes in the top right strip (where the toolbox was). */
function probe(page: Page, n: number): Promise<{ button: Box | null; icons: number; svg: boolean }> {
  return page.evaluate(
    ({ sel, n }) => {
      const fig = document.querySelectorAll<HTMLElement>(sel)[n]
      const body = fig?.querySelector<HTMLElement>('.chart-body')
      const svg = body?.querySelector<SVGSVGElement>(':scope > div > svg')
      if (!fig || !body || !svg) return { button: null, icons: 0, svg: false }
      const r = body.getBoundingClientRect()
      let icons = 0
      for (const p of Array.from(svg.querySelectorAll('path'))) {
        const b = p.getBoundingClientRect()
        if (b.width === 0 || b.width > 20 || b.height > 20) continue
        if (b.top < r.top || b.bottom > r.top + 32 || b.left < r.right - 180 || b.right > r.right) continue
        icons++
      }
      const bt = fig.querySelector<HTMLElement>('.chart-enlarge')?.getBoundingClientRect()
      return { button: bt ? { x: bt.x, y: bt.y, width: bt.width, height: bt.height } : null, icons, svg: true }
    },
    { sel: FIG, n },
  )
}

const centre = (b: Box): { x: number; y: number } => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

/** What is on top at a point: 'enlarge', 'chart' (inside the chart body) or the tag name of something else. */
function topAt(page: Page, n: number, p: { x: number; y: number }): Promise<string> {
  return page.evaluate(
    ({ sel, n, p }) => {
      const fig = document.querySelectorAll<HTMLElement>(sel)[n]
      const el = document.elementFromPoint(p.x, p.y)
      if (!fig || !el) return 'none'
      if (el.closest('.chart-enlarge') && fig.contains(el)) return 'enlarge'
      if (fig.querySelector('.chart-body')?.contains(el)) return 'chart'
      return el.tagName
    },
    { sel: FIG, n, p },
  )
}

/** The open viewer: title, export button, placeholder, chart box vs stage box. */
function viewerState(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.chart-modal')
    const stage = root?.querySelector<HTMLElement>('.chart-modal__stage')
    const svg = stage?.querySelector<SVGSVGElement>('.chart-body svg')
    const s = stage?.getBoundingClientRect()
    const g = svg?.getBoundingClientRect()
    // the lowest drawn text (the x axis labels) must be inside the stage
    const texts = svg ? Array.from(svg.querySelectorAll('text')).map((t) => t.getBoundingClientRect().bottom) : []
    return {
      title: root?.querySelector('.chart-modal__title')?.textContent?.trim() ?? '',
      exportBtn: Boolean(root?.querySelector('button[data-m="export"]')),
      pending: root ? Array.from(root.querySelectorAll<HTMLElement>('.chart-pending')).filter((p) => p.getClientRects().length > 0).length : -1,
      stageBottom: s ? s.bottom : 0,
      svgBottom: g ? g.bottom : 0,
      lowestText: texts.length ? Math.max(...texts) : 0,
    }
  })
}

for (const vp of [
  { name: 'phone 390', width: 390, height: 844, touch: true },
  { name: 'desktop 1280', width: 1280, height: 900, touch: false },
]) {
  test.describe(`ECharts figure chrome and viewer, ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.touch, hasTouch: vp.touch })
    for (const path of LECTURES) {
      test(`${path}: no ECharts tool icons; the icon and the chart open the viewer with number title, export, whole chart`, async ({
        page,
      }) => {
        test.skip(test.info().project.name !== 'prod', 'checked on the built demo site')
        test.setTimeout(180_000)
        for (const [theme, mode] of LOOKS) {
          const look = `${theme}-${mode}`
          await useTheme(page, theme, mode)
          expect(await gotoAndSettle(page, path), `${look}: charts rendered`).toBe(true)
          const n = await page.locator(FIG).count()
          expect(n, `${path} has ECharts figures`).toBeGreaterThan(0)
          for (let i = 0; i < n; i++) {
            const fig = page.locator(FIG).nth(i)
            await fig.scrollIntoViewIfNeeded()
            if (!vp.touch) await fig.locator('.chart-body').hover({ position: { x: 20, y: 200 } })
            const where = `${look} figure ${i}`
            await expect.poll(async () => (await probe(page, i)).svg, { message: `${where}: drawn`, timeout: 15_000 }).toBe(true)
            const pr = await probe(page, i)
            expect(pr.icons, `${where}: ECharts tool icons in the figure`).toBe(0)
            expect(pr.button, `${where}: enlarge icon`).not.toBeNull()
            const button = pr.button as Box
            expect(await topAt(page, i, centre(button)), `${where}: on top at the enlarge icon`).toBe('enlarge')
            const label = (await fig.getAttribute('data-fig-label')) ?? ''
            expect(label, `${where}: build-time number`).toMatch(/^图 \d+-\d+$/)

            // the enlarge icon opens the viewer
            const b = centre(button)
            if (vp.touch) await page.touchscreen.tap(b.x, b.y)
            else await page.mouse.click(b.x, b.y)
            await expect(page.locator('.chart-modal'), `${where}: viewer opened from the icon`).toHaveCount(1)
            await expect.poll(async () => (await viewerState(page)).svgBottom, { message: `${where}: chart in the viewer` }).toBeGreaterThan(0)
            const v = await viewerState(page)
            expect(v.title, `${where}: viewer title`).toMatch(new RegExp(`^${label}( |$)`))
            expect(v.title, `${where}: no internal id`).not.toMatch(/#c\d|MEA-L\d/)
            expect(v.exportBtn, `${where}: export in the viewer`).toBe(true)
            expect(v.pending, `${where}: no loading placeholder`).toBe(0)
            expect(v.lowestText, `${where}: x axis inside the stage`).toBeLessThanOrEqual(v.stageBottom + 1)
            await page.keyboard.press('Escape')
            await expect(page.locator('.chart-modal')).toHaveCount(0)

            // a click (tap) on the chart itself opens the viewer too (audit-spec #9)
            await fig.scrollIntoViewIfNeeded()
            const body = await fig.locator('.chart-body').boundingBox()
            expect(body, `${where}: chart body`).not.toBeNull()
            const p = { x: body!.x + body!.width / 2, y: body!.y + body!.height / 2 }
            if (vp.touch) await page.touchscreen.tap(p.x, p.y)
            else await page.mouse.click(p.x, p.y)
            await expect(page.locator('.chart-modal'), `${where}: viewer opened from the chart`).toHaveCount(1)
            await page.keyboard.press('Escape')
            await expect(page.locator('.chart-modal')).toHaveCount(0)
          }
        }
      })
    }
  })
}
