/**
 * WP-F1 owner additions (spec board 07 and the page chrome), both skins:
 *   1. a chart figure has the picture and the caption only: no type tag, no tool bar, no source button / "chart source" fold, no
 *      literal "&#" text; one enlarge icon that shows on hover only (the dev server adds the author's "chart source" fold, the build none);
 *   2. text inside charts cannot be selected, inline or in the viewer (computed `user-select: none`, and a drag selects nothing);
 *   3. the home group cards never show a horizontal scrollbar;
 *   4. the page scrollbar is thin, themed, and its thumb is hidden at idle (shown while scrolling or near the right edge).
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme, type ThemeId } from './theme-helpers'

const SKINS: ThemeId[] = ['reader', 'datasheet']
// S6: demo lectures with charts: MEA L05 (Mermaid, a figure pack figure, ECharts, WaveDrom), MEA L03 (ECharts next to
// an SVG and a WebP figure of the figure pack)
const LECTURES = ['/mea/L05', '/mea/L03'] as const

interface Box {
  x: number
  y: number
  width: number
  height: number
}

for (const theme of SKINS) {
  test.describe(`figures and chrome: ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await useTheme(page, theme, 'light')
    })

    for (const path of LECTURES) {
      test(`${path}: no bar under the charts, no literal "&#", enlarge icon on hover only`, async ({ page }) => {
        test.setTimeout(120_000)
        expect(await gotoAndSettle(page, path), 'charts rendered').toBe(true)
        const figs = page.locator('figure.chart')
        const n = await figs.count()
        expect(n, `${path} has charts`).toBeGreaterThan(0)
        await expect(page.locator('figure.chart .chart-tag, figure.chart .chart-tools')).toHaveCount(0)
        // the "chart source" fold is the local author's tool: the dev server adds it (charts/dom.ts injectSource, DEV only),
        // readers of the built site never get it
        const folds = page.locator('figure.chart details.chart-code')
        if (test.info().project.name === 'dev') {
          const k = await folds.count()
          expect(k, `${path}: dev shows the author's source fold`).toBeGreaterThan(0)
          expect(k).toBeLessThanOrEqual(n)
        } else {
          await expect(folds).toHaveCount(0)
        }
        await expect(page.locator('figure.chart button:not(.chart-enlarge)')).toHaveCount(0)
        // the rendered text and the text nodes (an entity written as text shows up in either, e.g. `&#38;` or `&amp;#38;`)
        const text = await page.locator('figure.chart').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText + ' ' + (e.textContent ?? '')).join('\n'))
        expect(text, 'literal HTML entity text on a figure').not.toMatch(/&#\d+;?|&amp;#/)
        await expect(page.locator('figure.chart .chart-enlarge')).toHaveCount(n)
        const first = figs.first()
        await first.scrollIntoViewIfNeeded()
        const icon = first.locator('.chart-enlarge')
        await page.mouse.move(0, 0)
        await expect.poll(() => icon.evaluate((e) => getComputedStyle(e).opacity)).toBe('0')
        await first.locator('.chart-body').hover()
        await expect.poll(() => icon.evaluate((e) => getComputedStyle(e).opacity)).toBe('1')
        // the icon opens the same viewer as the image
        await icon.click()
        await expect(page.locator('.chart-modal')).toHaveCount(1)
        await expect(page.locator('.chart-modal figure .chart-enlarge')).toBeHidden()
        await page.keyboard.press('Escape')
        await expect(page.locator('.chart-modal')).toHaveCount(0)
      })

      test(`${path}: chart text is not selectable, inline and in the viewer`, async ({ page }) => {
        test.setTimeout(120_000)
        await gotoAndSettle(page, path)
        const sel = (p: Page, scope: string): Promise<{ checked: number; selectable: string[] }> =>
          p.evaluate((s) => {
            const out: string[] = []
            let checked = 0
            for (const el of Array.from(document.querySelectorAll(`${s} svg text, ${s} svg tspan, ${s} svg foreignObject, ${s} svg foreignObject *, ${s} .chart-body`))) {
              checked++
              const u = getComputedStyle(el).userSelect
              if (u !== 'none') out.push(`${el.tagName}:${u}`)
            }
            return { checked, selectable: out.slice(0, 5) }
          }, scope)
        const inline = await sel(page, 'figure.chart')
        expect(inline.checked).toBeGreaterThan(0)
        expect(inline.selectable, 'inline chart text with a user-select other than none').toEqual([])
        // a drag across the first chart selects nothing
        const body = page.locator('figure.chart .chart-body').first()
        await body.scrollIntoViewIfNeeded()
        const b = (await body.boundingBox()) as Box
        await page.mouse.move(b.x + 4, b.y + 4)
        await page.mouse.down()
        await page.mouse.move(b.x + b.width - 4, b.y + b.height - 4, { steps: 8 })
        await page.mouse.up()
        expect(await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim()), 'text selected by dragging over a chart').toBe('')
        // a press and release on the image of a figure (ECharts included since S6Y audit-spec #9) is a click and opens the viewer: close it, the icon opens it below
        if ((await page.locator('.chart-modal').count()) > 0) {
          await page.keyboard.press('Escape')
          await expect(page.locator('.chart-modal')).toHaveCount(0)
        }
        // the viewer: same, and a drag only pans (the selection stays empty)
        // (opened from the icon here)
        await body.hover()
        await page.locator('figure.chart').first().locator('.chart-enlarge').click()
        await expect(page.locator('.chart-modal')).toHaveCount(1)
        const inModal = await sel(page, '.chart-modal__stage')
        expect(inModal.checked).toBeGreaterThan(0)
        expect(inModal.selectable, 'viewer chart text with a user-select other than none').toEqual([])
        const stage = (await page.locator('.chart-modal__stage').boundingBox()) as Box
        await page.mouse.move(stage.x + 10, stage.y + 10)
        await page.mouse.down()
        await page.mouse.move(stage.x + stage.width - 10, stage.y + stage.height - 10, { steps: 8 })
        await page.mouse.up()
        expect(await page.evaluate(() => (window.getSelection()?.toString() ?? '').trim()), 'text selected by dragging in the viewer').toBe('')
      })
    }

    for (const width of [1440, 390]) {
      test(`home group cards at ${width} px never show a horizontal scrollbar`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await gotoAndSettle(page, '/')
        await page.waitForSelector('[data-slot="GroupCard"]')
        const bad = await page.evaluate(() => {
          const out: string[] = []
          for (const card of Array.from(document.querySelectorAll('[data-slot="GroupCard"]'))) {
            for (const el of [card, ...Array.from(card.querySelectorAll('*'))]) {
              if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue
              const cs = getComputedStyle(el)
              const scrolls = cs.overflowX === 'auto' || cs.overflowX === 'scroll'
              if (scrolls && el.scrollWidth > el.clientWidth + 1) out.push(`${el.tagName}.${el.getAttribute('class') ?? ''} scrollWidth ${el.scrollWidth} > ${el.clientWidth}`)
              // a clipped cell must carry its full text in a title and end in an ellipsis
              if (el.matches('.dcard-spec th, .dcard-spec td') && el.scrollWidth > el.clientWidth + 1 && !(el.getAttribute('title') && cs.textOverflow === 'ellipsis')) out.push(`cell ${el.textContent} clipped without title / ellipsis`)
              if (el.matches('.dcard-spec') && cs.tableLayout !== 'fixed') out.push('spec table is not table-layout: fixed')
            }
          }
          return out
        })
        expect(bad).toEqual([])
      })
    }

    test('page scrollbar: thin and themed, thumb hidden at idle, shown while scrolling and near the right edge, no layout shift', async ({ page }) => {
      test.setTimeout(120_000)
      await gotoAndSettle(page, '/mea/L04')
      const state = (): Promise<{ on: boolean; thumb: string; radius: string; width: string; clientWidth: number }> =>
        page.evaluate(() => {
          const t = getComputedStyle(document.documentElement, '::-webkit-scrollbar-thumb')
          return {
            on: document.documentElement.getAttribute('data-lec-scrollbar') === 'on',
            thumb: t.backgroundColor,
            radius: t.borderTopLeftRadius,
            width: getComputedStyle(document.documentElement, '::-webkit-scrollbar').width,
            clientWidth: document.documentElement.clientWidth,
          }
        })
      await page.mouse.move(700, 300)
      await expect.poll(async () => (await state()).on, { timeout: 5000 }).toBe(false)
      const idle = await state()
      expect(idle.thumb, 'thumb invisible at idle').toBe('rgba(0, 0, 0, 0)')
      expect(idle.width).toBe('8px')
      expect(idle.radius).toBe(theme === 'datasheet' ? '1px' : '4px')
      // scrolling shows it, then it fades out about 1 s after the last scroll
      await page.mouse.wheel(0, 600)
      await expect.poll(async () => (await state()).on).toBe(true)
      await expect.poll(async () => (await state()).thumb).not.toBe('rgba(0, 0, 0, 0)')
      const shown = await state()
      expect(shown.clientWidth, 'no layout shift when the scrollbar appears').toBe(idle.clientWidth)
      await expect.poll(async () => (await state()).on, { timeout: 6000 }).toBe(false)
      await expect.poll(async () => (await state()).thumb, { timeout: 3000 }).toBe('rgba(0, 0, 0, 0)')
      // near the right edge and on the scrollbar gutter it shows without scrolling, and goes away when the pointer leaves
      const vw = page.viewportSize()?.width ?? 1280
      await page.mouse.move(vw - 6, 300)
      await expect.poll(async () => (await state()).on).toBe(true)
      await page.mouse.move(vw - 2, 300)
      await expect.poll(async () => (await state()).on).toBe(true)
      await page.mouse.move(700, 300)
      await expect.poll(async () => (await state()).on, { timeout: 6000 }).toBe(false)
    })
  })
}
