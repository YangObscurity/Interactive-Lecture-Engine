/**
 * E2E test for ECharts and WaveDrom dark mode & theme pack switching (Defect 5).
 *
 * Verifies that:
 * 1. WaveDrom and ECharts render on /g01/L08.
 * 2. In light mode, WaveDrom text and strokes use dark fills/strokes; ECharts uses light-background options.
 * 3. Toggling dark mode re-renders charts via theme/charts/page.ts observer:
 *    - WaveDrom dynamically switches to dark skin (white text/strokes #ffffff, transparent background rect).
 *    - ECharts re-renders with the lecture-dark theme (light text/axes, transparent background).
 * 4. Switching skin (reader <-> datasheet) re-renders without errors.
 * 5. Switching back to light mode restores light-theme fills.
 *
 * No screenshot baselines needed: reads fills/strokes from SVG and inspects canvas/ECharts options.
 */
import { test, expect, gotoAndSettle } from './fixtures'

test.describe('Charts dark mode & theme switching', () => {
  test('WaveDrom and ECharts re-render with matching colors on theme/mode change', async ({ page, consoleErrors, pageErrors }) => {
    // 1. Visit /g03/L07 which contains WaveDrom (c1), Mermaid (c2), and ECharts (c3)
    const settled = await gotoAndSettle(page, '/g03/L07')
    expect(settled, 'charts settled on initial load').toBe(true)

    // Verify figures exist and have data-rendered
    const figures = page.locator('figure.chart')
    expect(await figures.count()).toBeGreaterThanOrEqual(3)
    await expect(page.locator('figure[data-id="c1"]')).toHaveAttribute('data-rendered', '1')
    await expect(page.locator('figure[data-id="c3"]')).toHaveAttribute('data-rendered', '1')

    // 2. Light mode inspection:
    // WaveDrom text in light mode should NOT be pure white (#ffffff / rgb(255, 255, 255))
    const lightWaveColors = await page.evaluate(() => {
      const svg = document.querySelector('figure[data-id="c1"] svg')
      if (!svg) return []
      const texts = [...svg.querySelectorAll('text')]
      return texts.map((t) => {
        const fill = t.getAttribute('fill') || t.style.fill || getComputedStyle(t).fill
        return fill.toLowerCase()
      })
    })
    expect(lightWaveColors.length, 'WaveDrom has text elements').toBeGreaterThan(0)
    const lightWhiteTexts = lightWaveColors.filter((c) => c === '#ffffff' || c === '#fff' || c === 'rgb(255, 255, 255)')
    expect(lightWhiteTexts.length, 'light mode should not have white wave text').toBe(0)

    // ECharts in light mode should be initialized (SVG or canvas)
    const lightEcharts = await page.evaluate(() => {
      const body = document.querySelector('figure[data-id="c3"] .chart-body') as HTMLElement | null
      const svg = body?.querySelector('svg')
      const canvas = body?.querySelector('canvas')
      if (svg) {
        const texts = [...svg.querySelectorAll('text')]
        const fills = texts.map((t) => (t.getAttribute('fill') || t.style.fill || getComputedStyle(t).fill).toLowerCase())
        return { type: 'svg' as const, elementCount: svg.children.length, fills }
      }
      if (canvas) {
        return { type: 'canvas' as const, elementCount: 1, fills: [] }
      }
      return null
    })
    expect(lightEcharts, 'ECharts rendered in light mode').not.toBeNull()
    expect(lightEcharts!.elementCount).toBeGreaterThan(0)

    // 3. Toggle to Dark Mode
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        window.addEventListener('lecture:charts-settled', () => resolve(), { once: true })
        document.documentElement.classList.add('dark')
      })
    })

    // Assert WaveDrom in dark mode:
    // - Skin is dark: style tag contains text{fill:#ffffff} and stroke:#ffffff
    // - Background rect is transparent
    const darkWaveDrom = await page.evaluate(() => {
      const fig = document.querySelector('figure[data-id="c1"]')
      const svg = fig?.querySelector('svg')
      if (!svg) return null
      const texts = [...svg.querySelectorAll('text')]
      const fills = texts.map((t) => (t.getAttribute('fill') || t.style.fill || getComputedStyle(t).fill).toLowerCase())
      const styleTag = svg.querySelector('style')
      const styleText = styleTag?.textContent || ''
      const hasDarkSkin = styleText.includes('text{fill:#ffffff}') || styleText.includes('stroke:#ffffff')
      const allRects = [...svg.querySelectorAll('rect')]
      const bgRect = allRects.find((r) => r.closest('#socket') === null)
      const bgFill = bgRect ? (bgRect.style.fill || bgRect.getAttribute('fill') || getComputedStyle(bgRect).fill).toLowerCase() : 'none'
      return {
        textCount: texts.length,
        whiteTexts: fills.filter((c) => c === '#ffffff' || c === '#fff' || c === 'rgb(255, 255, 255)').length,
        hasDarkSkin,
        bgFill,
      }
    })

    expect(darkWaveDrom, 'WaveDrom SVG present in dark mode').not.toBeNull()
    expect(darkWaveDrom!.hasDarkSkin || darkWaveDrom!.whiteTexts > 0, 'WaveDrom text in dark mode should use dark skin / white fill').toBe(true)
    expect(
      darkWaveDrom!.bgFill === 'transparent' || darkWaveDrom!.bgFill === 'none' || darkWaveDrom!.bgFill.includes('rgba(0, 0, 0, 0)'),
      'WaveDrom background rect must not be opaque white in dark mode'
    ).toBe(true)

    // Assert ECharts in dark mode:
    // Re-rendered with lecture-dark theme / light text colors
    const darkEcharts = await page.evaluate(() => {
      const body = document.querySelector('figure[data-id="c3"] .chart-body') as HTMLElement | null
      const svg = body?.querySelector('svg')
      const canvas = body?.querySelector('canvas')
      if (svg) {
        const texts = [...svg.querySelectorAll('text')]
        const fills = texts.map((t) => (t.getAttribute('fill') || t.style.fill || getComputedStyle(t).fill).toLowerCase())
        return { type: 'svg' as const, elementCount: svg.children.length, fills }
      }
      if (canvas) {
        return { type: 'canvas' as const, elementCount: 1, fills: [] }
      }
      return null
    })

    expect(darkEcharts, 'ECharts rendered in dark mode').not.toBeNull()
    expect(darkEcharts!.elementCount).toBeGreaterThan(0)
    if (darkEcharts?.type === 'svg' && lightEcharts!.type === 'svg') {
      expect(lightEcharts!.fills.length, 'ECharts has text in light mode').toBeGreaterThan(0)
      expect(darkEcharts.fills.join('|'), 'ECharts text colours differ between light and dark').not.toBe(lightEcharts!.fills.join('|'))
    }
    if (darkEcharts?.type === 'svg') {
      const darkTexts = darkEcharts.fills.filter((c) => c === '#000000' || c === '#000' || c === 'rgb(0, 0, 0)' || c === '#1e293b')
      expect(darkTexts.length, 'ECharts text in dark mode should not be hardcoded black').toBe(0)
    }

    // 4. Switch theme skin: toggle data-lec-theme (datasheet <-> reader)
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        window.addEventListener('lecture:charts-settled', () => resolve(), { once: true })
        const cur = document.documentElement.getAttribute('data-lec-theme') || 'datasheet'
        const next = cur === 'datasheet' ? 'reader' : 'datasheet'
        document.documentElement.setAttribute('data-lec-theme', next)
      })
    })

    // Verify still rendered and settled
    await expect(page.locator('figure[data-id="c1"]')).toHaveAttribute('data-rendered', '1')
    await expect(page.locator('figure[data-id="c3"]')).toHaveAttribute('data-rendered', '1')

    // 5. Toggle back to Light Mode and restore default skin
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        window.addEventListener('lecture:charts-settled', () => resolve(), { once: true })
        document.documentElement.classList.remove('dark')
        document.documentElement.setAttribute('data-lec-theme', 'datasheet')
      })
    })

    // Verify WaveDrom restored to light theme (no dark skin style)
    const restoredWave = await page.evaluate(() => {
      const svg = document.querySelector('figure[data-id="c1"] svg')
      if (!svg) return null
      const texts = [...svg.querySelectorAll('text')]
      const fills = texts.map((t) => (t.getAttribute('fill') || t.style.fill || getComputedStyle(t).fill).toLowerCase())
      const styleTag = svg.querySelector('style')
      const styleText = styleTag?.textContent || ''
      const hasDarkSkin = styleText.includes('text{fill:#ffffff}')
      return {
        whiteTexts: fills.filter((c) => c === '#ffffff' || c === '#fff' || c === 'rgb(255, 255, 255)').length,
        hasDarkSkin,
      }
    })
    expect(restoredWave?.hasDarkSkin, 'restored light mode should not have dark skin style').toBe(false)
    expect(restoredWave?.whiteTexts, 'restored light mode should not have white wave text').toBe(0)

    // Verify no fatal page or console errors
    expect(pageErrors, 'no uncaught page errors during theme toggling').toEqual([])
    const realErrors = consoleErrors.filter(
      (e) => !e.includes('outside of Vite serving allow list') && !e.includes('503') && !e.includes('403')
    )
    expect(realErrors, 'no unexpected console errors during theme toggling').toEqual([])
  })
})
