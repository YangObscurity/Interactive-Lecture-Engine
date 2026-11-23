import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

test.describe('WP-F8: unified PhotoSwipe viewer for figures, ECharts & Mermaid', () => {
  test('opens figures and Mermaid diagrams in one gallery with zoom, gallery navigation, focus trap & Esc across skins', async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, 'reader', 'light')
    await page.setViewportSize({ width: 1280, height: 860 })
    await gotoAndSettle(page, '/lr/L01')

    // 1. Click the group figure thumbnail -> opens unified PhotoSwipe viewer (slide 2 of 3: after inline Mermaid c1)
    const thumbMedia = page.locator('#fig-hearthnet-arch .lec-fig-media')
    await thumbMedia.scrollIntoViewIfNeeded()
    await thumbMedia.click()
    const viewer = page.locator('.pswp.chart-modal')
    await expect(viewer).toBeVisible()
    await expect(page.locator('html')).toHaveClass(/chart-modal-open/)
    await expect(viewer.locator('.chart-modal__counter')).toHaveText(/^\d+ \/ 3$/)

    // the figure starts fitted inside the viewport below the bar, and only a figure with an original offers the link
    await expect(viewer.locator('[data-m="original"]')).toBeVisible()
    const fit = await viewer.locator('.pswp__img').first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight }
    })
    expect(fit.top).toBeGreaterThanOrEqual(44)
    expect(fit.bottom).toBeLessThanOrEqual(fit.vh)

    // 2. Focus trap keeps focus inside dialog when pressing Tab repeatedly
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      const inside = await page.evaluate(() => !!document.activeElement?.closest('.pswp.chart-modal'))
      expect(inside, `focus escaped viewer on Tab #${i + 1}`).toBe(true)
    }

    // 3. Navigate left to Mermaid diagram slide inside the same viewer
    await viewer.locator('button[data-m="prev"]').click()
    await expect(viewer.locator('.chart-modal__counter')).toHaveText(/^1 \/ 3$/)
    await expect(viewer.locator('[data-m="original"]')).toBeHidden()
    await expect(viewer.locator('.chart-modal__stage figure.chart--modal[data-type="mermaid"] svg')).toBeVisible()

    // 4. Zoom buttons + Esc close cleanly and restore inline Mermaid chart
    await viewer.locator('button[data-m="in"]').click()
    await viewer.locator('button[data-m="reset"]').click()
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    await expect(page.locator('html')).not.toHaveClass(/chart-modal-open/)
    await expect(page.locator('figure.chart[data-id="c1"] .chart-body svg')).toBeVisible()
    expect(pageErrors).toEqual([])
  })

  test('handles ECharts interactive resize zoom & WaveDrom inside unified viewer under datasheet skin', async ({
    page,
    pageErrors,
  }) => {
    await useTheme(page, 'datasheet', 'light')
    await page.setViewportSize({ width: 1280, height: 860 })
    await gotoAndSettle(page, '/examples/g01/L01')

    // Open ECharts c2 enlarge button (V2 ECharts renders SVG in .chart-body)
    const echartsFig = page.locator('figure.chart[data-lecture="EX-L01"][data-id="c2"]')
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
    await expect(page.locator('figure.chart[data-lecture="EX-L01"][data-id="c3"] .chart-body svg')).toBeVisible()
    expect(pageErrors).toEqual([])
  })
})
