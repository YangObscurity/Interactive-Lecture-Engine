import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'
import fs from 'node:fs'
import path from 'node:path'
import { DEMO_DIR } from './demo'

// S6: the demo lecture with every kind of figure in one viewer gallery, in page order: Mermaid c1, a figure pack
// figure that has an original, ECharts c2 and WaveDrom c3 (templates/demo-content/lectures/mea/L05.md)
const LECTURE = '/mea/L05'
const LECTURE_ID = 'MEA-L05'
/** the gallery holds every chart placeholder and every figure of the lecture, read from its source */
const SLIDES = (fs.readFileSync(path.join(DEMO_DIR, 'lectures', 'mea', 'L05.md'), 'utf8').match(/<figure class="chart"|<LectureFigure\b/g) ?? []).length

test.describe('WP-F8: unified PhotoSwipe viewer for figures, ECharts & Mermaid', () => {
  test('opens figures and Mermaid diagrams in one gallery with zoom, gallery navigation, focus trap & Esc across skins', async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, 'reader', 'light')
    await page.setViewportSize({ width: 1280, height: 860 })
    await gotoAndSettle(page, LECTURE)

    // 1. Click the vector SVG figure thumbnail -> opens true vector SVG viewer (slide 2 of SLIDES: after Mermaid c1)
    const thumbMedia = page.locator('figure.lec-fig .lec-fig-media').first()
    await thumbMedia.scrollIntoViewIfNeeded()
    await thumbMedia.click()
    const viewer = page.locator('.pswp.chart-modal')
    await expect(viewer).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/chart-modal-open/)
    await expect(viewer.locator('.chart-modal__counter')).toHaveText(`2 / ${SLIDES}`)

    // Vector SVG figure renders inline crisp <svg> inside full-viewport free-pan stage (no overflow scrollbars)
    await expect(viewer.locator('[data-m="original"]')).toBeVisible()
    const vecSvg = viewer.locator('.chart-modal__vec-host svg').first()
    await expect(vecSvg).toBeVisible()
    const stageOverflow = await viewer.locator('.chart-modal__stage').evaluate((el) => {
      const st = getComputedStyle(el)
      return { ovX: st.overflowX, ovY: st.overflowY, w: el.clientWidth, h: el.clientHeight }
    })
    expect(stageOverflow.ovX).toBe('hidden')
    expect(stageOverflow.ovY).toBe('hidden')
    expect(stageOverflow.w).toBeGreaterThanOrEqual(1200)

    const fit = await vecSvg.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, width: r.width, left: r.left, vh: window.innerHeight }
    })
    expect(fit.top).toBeGreaterThanOrEqual(44)
    expect(fit.bottom).toBeLessThanOrEqual(fit.vh)

    // Vector zoom changes the rendered <svg> pixel box cleanly, and dragging pans freely in 2D
    await viewer.locator('button[data-m="in"]').click()
    const zoomedBox = await vecSvg.boundingBox()
    expect(zoomedBox!.width).toBeGreaterThan(fit.width * 1.15)
    await page.mouse.move(640, 450)
    await page.mouse.down()
    await page.mouse.move(760, 540, { steps: 8 })
    await page.mouse.up()
    const pannedBox = await vecSvg.boundingBox()
    expect(pannedBox!.x - zoomedBox!.x).toBeGreaterThan(60)
    expect(pannedBox!.y - zoomedBox!.y).toBeGreaterThan(40)
    await viewer.locator('button[data-m="reset"]').click()

    // 2. Focus trap keeps focus inside dialog when pressing Tab repeatedly
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(() => !!document.activeElement?.closest('.pswp.chart-modal'))
      expect(inside, `focus escaped viewer on Tab #${i + 1}`).toBe(true)
    }

    // 3. Navigate left to Mermaid diagram slide inside the same full-viewport stage and pan freely even at initial fit
    await viewer.locator('button[data-m="prev"]').click()
    await expect(viewer.locator('.chart-modal__counter')).toHaveText(`1 / ${SLIDES}`)
    await expect(viewer.locator('[data-m="original"]')).toBeHidden()
    const mermaidSvg = viewer.locator('.chart-modal__stage figure.chart--modal[data-type="mermaid"] svg')
    await expect(mermaidSvg).toBeVisible()
    const mBefore = await mermaidSvg.boundingBox()
    await page.mouse.move(640, 450)
    await page.mouse.down()
    await page.mouse.move(540, 360, { steps: 8 })
    await page.mouse.up()
    const mAfter = await mermaidSvg.boundingBox()
    expect(Math.abs(mAfter!.x - mBefore!.x)).toBeGreaterThan(50)
    expect(Math.abs(mAfter!.y - mBefore!.y)).toBeGreaterThan(40)

    // 4. Zoom buttons + Esc close cleanly and restore inline Mermaid chart
    await viewer.locator('button[data-m="in"]').click()
    await viewer.locator('button[data-m="reset"]').click()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(page.locator('html')).not.toHaveClass(/chart-modal-open/)
    await expect(page.locator('figure.chart[data-id="c1"] .chart-body svg')).toBeVisible()

    // 5. Raster figures (.webp) still open via PhotoSwipe img fallback
    await gotoAndSettle(page, '/mea/L03')
    await page.locator('figure.lec-fig .lec-fig-media').first().click()
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('.pswp__img').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test('handles ECharts interactive resize zoom & WaveDrom inside unified viewer under datasheet skin', async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, 'datasheet', 'light')
    await page.setViewportSize({ width: 1280, height: 860 })
    await gotoAndSettle(page, LECTURE)

    // Open ECharts c2 enlarge button (V2 ECharts renders SVG in .chart-body)
    const echartsFig = page.locator(`figure.chart[data-lecture="${LECTURE_ID}"][data-id="c2"]`)
    await echartsFig.scrollIntoViewIfNeeded()
    await echartsFig.hover()
    await echartsFig.locator('.chart-enlarge').click()

    const viewer = page.locator('.pswp.chart-modal')
    await expect(viewer).toBeVisible()
    const modalBody = viewer.locator('.chart-modal__stage figure.chart--modal[data-type="echarts"] .chart-body')
    await expect(modalBody.locator('svg')).toBeVisible()

    const initialW = await modalBody.evaluate((el) => el.clientWidth)
    await viewer.locator('button[data-m="in"]').click()
    const zoomedW = await modalBody.evaluate((el) => el.clientWidth)
    expect(zoomedW).toBeGreaterThan(initialW)

    // Navigate next to WaveDrom timing diagram c3 inside the same viewer
    await viewer.locator('button[data-m="next"]').click()
    await expect(viewer.locator('.chart-modal__stage figure.chart--modal[data-type="wavedrom"] svg')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(echartsFig.locator('.chart-body svg')).toBeVisible()
    await expect(page.locator(`figure.chart[data-lecture="${LECTURE_ID}"][data-id="c3"] .chart-body svg`)).toBeVisible()
    expect(pageErrors).toEqual([])
  })

  test('keeps modal open when clicking/dblclicking SVG, supports keyboard arrows & horizontal wheel pan', async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, 'reader', 'light')
    await page.setViewportSize({ width: 1280, height: 860 })
    await gotoAndSettle(page, LECTURE)

    const thumbMedia = page.locator('figure.lec-fig .lec-fig-media').first()
    await thumbMedia.scrollIntoViewIfNeeded()
    await thumbMedia.click()

    const viewer = page.locator('.pswp.chart-modal')
    await expect(viewer).toBeVisible()
    const vecSvg = viewer.locator('.chart-modal__vec-host svg').first()
    await expect(vecSvg).toBeVisible()

    const fitBox = await vecSvg.boundingBox()
    const cx = fitBox!.x + fitBox!.width / 2
    const cy = fitBox!.y + fitBox!.height / 2

    // Single click directly on SVG does NOT close the modal
    await page.mouse.click(cx, cy)
    await expect(viewer).toBeVisible()

    // Double click directly on SVG zooms in cleanly without closing
    await page.mouse.dblclick(cx, cy)
    const zoomedBox = await vecSvg.boundingBox()
    expect(zoomedBox!.width).toBeGreaterThan(fitBox!.width * 1.4)

    // Horizontal wheel event pans horizontally without changing SVG width
    await page.mouse.move(cx, cy)
    await page.mouse.wheel(120, 0)
    const afterWheelBox = await vecSvg.boundingBox()
    expect(Math.abs(afterWheelBox!.width - zoomedBox!.width)).toBeLessThanOrEqual(2)
    expect(afterWheelBox!.x).toBeLessThan(zoomedBox!.x - 20)

    // Keyboard ArrowDown & ArrowRight pan the zoomed canvas instead of navigating away from slide 2
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await expect(viewer.locator('.chart-modal__counter')).toHaveText(`2 / ${SLIDES}`)
    const afterKeyBox = await vecSvg.boundingBox()
    expect(afterKeyBox!.y).toBeLessThan(afterWheelBox!.y - 30)
    expect(afterKeyBox!.x).toBeLessThan(afterWheelBox!.x - 30)

    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test('closes viewer and unlocks page scroll + scrollbar when navigating via browser back', async ({ page, pageErrors }) => {
    await useTheme(page, 'reader', 'light')
    await page.setViewportSize({ width: 1280, height: 860 })
    await gotoAndSettle(page, '/mea/')
    await gotoAndSettle(page, LECTURE)

    const thumbMedia = page.locator('figure.lec-fig .lec-fig-media').first()
    await thumbMedia.scrollIntoViewIfNeeded()
    await thumbMedia.click()
    const viewer = page.locator('.pswp.chart-modal')
    await expect(viewer).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/chart-modal-open/)

    await page.goBack()
    await expect(page).toHaveURL(/\/mea\/?$/)
    await expect(viewer).toHaveCount(0)
    await expect(page.locator('html')).not.toHaveClass(/chart-modal-open/)

    const docOverflow = await page.evaluate(() => ({
      htmlOverflow: getComputedStyle(document.documentElement).overflowY,
      bodyOverflow: getComputedStyle(document.body).overflowY,
    }))
    expect(docOverflow.htmlOverflow).not.toBe('hidden')
    expect(docOverflow.bodyOverflow).not.toBe('hidden')
    expect(pageErrors).toEqual([])
  })
})
