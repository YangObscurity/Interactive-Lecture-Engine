/**
 * The engine's enlarge icon (`figure.chart .chart-enlarge`, styles/base.css) and the ECharts tool icons (save image, data
 * view, restore; charts/renderers/echarts.ts) share the top right corner of a chart. On touch screens the enlarge icon is
 * always shown, so it once sat on the restore icon. Here, for every ECharts figure of the demo lectures, both skins, light
 * and dark, on a 390 px touch phone and a 1280 px desktop:
 *   - the tool icons are the small drawn shapes in the top right strip of the chart's SVG (their on-screen boxes, not a
 *     guess from the option);
 *   - the enlarge icon's box and every tool icon's box do not overlap;
 *   - each is the topmost element at its centre, and a click (a tap on the phone) works: the enlarge icon opens the viewer,
 *     the data view icon opens the ECharts data view, and neither opens the other.
 * Functional check on the built demo site (prod project).
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme, type ThemeId, type Mode } from './theme-helpers'

// S6 demo lectures with ECharts figures
const LECTURES = ['/mea/L03', '/mea/L04', '/mea/L05'] as const
const LOOKS: Array<[ThemeId, Mode]> = [
  ['reader', 'light'],
  ['reader', 'dark'],
  ['datasheet', 'light'],
  ['datasheet', 'dark'],
]
const FIG = 'figure.chart[data-type="echarts"]:not(.chart--modal)'

interface Box {
  x: number
  y: number
  width: number
  height: number
}
interface Probe {
  button: Box | null
  icons: Box[]
}

/**
 * The n-th ECharts figure: its enlarge icon and its tool icons. The tool icons are the SVG paths, at most 20 px, drawn in
 * the top 32 px and right 180 px of the chart (the title is text, the plot area and the legend lie lower), left to right.
 */
function probe(page: Page, n: number): Promise<Probe> {
  return page.evaluate(
    ({ sel, n }) => {
      const fig = document.querySelectorAll<HTMLElement>(sel)[n]
      const body = fig?.querySelector<HTMLElement>('.chart-body')
      const svg = body?.querySelector<SVGSVGElement>(':scope > div > svg')
      if (!fig || !body || !svg) return { button: null, icons: [] }
      const r = body.getBoundingClientRect()
      const icons: Box[] = []
      for (const p of Array.from(svg.querySelectorAll('path'))) {
        const b = p.getBoundingClientRect()
        if (b.width === 0 || b.width > 20 || b.height > 20) continue
        if (b.top < r.top || b.bottom > r.top + 32 || b.left < r.right - 180 || b.right > r.right) continue
        icons.push({ x: b.x, y: b.y, width: b.width, height: b.height })
      }
      icons.sort((a, b) => a.x - b.x)
      const bt = fig.querySelector<HTMLElement>('.chart-enlarge')?.getBoundingClientRect()
      return { button: bt ? { x: bt.x, y: bt.y, width: bt.width, height: bt.height } : null, icons }
    },
    { sel: FIG, n },
  )
}

const overlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
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

for (const vp of [
  { name: 'phone 390', width: 390, height: 844, touch: true },
  { name: 'desktop 1280', width: 1280, height: 900, touch: false },
]) {
  test.describe(`chart tool icons, ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.touch, hasTouch: vp.touch })
    for (const path of LECTURES) {
      test(`${path}: the enlarge icon and the ECharts tool icons do not overlap and all can be clicked`, async ({ page }) => {
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
            // the chart may still be drawing after the scroll: wait for its three tool icons
            await expect.poll(async () => (await probe(page, i)).icons.length, { message: `${where}: tool icons`, timeout: 15_000 }).toBe(3)
            const pr = await probe(page, i)
            expect(pr.button, `${where}: enlarge icon`).not.toBeNull()
            const button = pr.button as Box
            for (const ic of pr.icons) {
              expect(overlap(ic, button), `${where}: tool icon ${JSON.stringify(ic)} under the enlarge icon ${JSON.stringify(button)}`).toBe(false)
              expect(await topAt(page, i, centre(ic)), `${where}: on top at a tool icon`).toBe('chart')
            }
            expect(await topAt(page, i, centre(button)), `${where}: on top at the enlarge icon`).toBe('enlarge')

            // the enlarge icon opens the viewer
            const b = centre(button)
            if (vp.touch) await page.touchscreen.tap(b.x, b.y)
            else await page.mouse.click(b.x, b.y)
            await expect(page.locator('.chart-modal'), `${where}: viewer opened`).toHaveCount(1)
            await page.keyboard.press('Escape')
            await expect(page.locator('.chart-modal')).toHaveCount(0)

            // the data view icon (the middle one) opens the ECharts data view, not the viewer
            await fig.scrollIntoViewIfNeeded()
            const again = await probe(page, i)
            expect(again.icons.length, `${where}: tool icons after the viewer`).toBe(3)
            const dv = centre(again.icons[1] as Box)
            if (vp.touch) await page.touchscreen.tap(dv.x, dv.y)
            else await page.mouse.click(dv.x, dv.y)
            await expect(fig.locator('.chart-body textarea'), `${where}: data view opened`).toHaveCount(1)
            await expect(page.locator('.chart-modal')).toHaveCount(0)
          }
        }
      })
    }
  })
}
