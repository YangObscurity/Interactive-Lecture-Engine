/**
 * E2E test for ECharts and WaveDrom dark mode & theme pack switching (Defect 5).
 *
 * Runs on the demo content: WaveDrom on /log/L01 (c1), ECharts + Mermaid on /mea/L05 (c1 Mermaid, c2 ECharts; c3 there is WaveDrom).
 * No demo lecture carries both kinds, so each kind is checked on its own page with the same sequence:
 * 1. The charts render.
 * 2. In light mode, WaveDrom text uses dark fills; ECharts is initialised with light-background options.
 * 3. Toggling dark mode re-renders charts via theme/charts/page.ts observer:
 *    - WaveDrom dynamically switches to dark skin (white text/strokes #ffffff, transparent background rect).
 *    - ECharts re-renders with the lecture-dark theme (light text/axes, transparent background).
 * 4. Switching skin (reader <-> datasheet) re-renders without errors.
 * 5. Switching back to light mode restores light-theme fills.
 *
 * No screenshot baselines needed: reads fills/strokes from SVG and inspects canvas/ECharts options.
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

const WAVEDROM_LECTURE = '/log/L01'
const WAVEDROM_FIG = 'figure[data-id="c1"]'
const ECHARTS_LECTURE = '/mea/L05'
const ECHARTS_FIG = 'figure[data-id="c2"]'

const WHITE = ['#ffffff', '#fff', 'rgb(255, 255, 255)']

/** Run `change` on <html> and wait for the next `lecture:charts-settled`. */
async function changeAndSettle(page: Page, change: 'dark' | 'skin' | 'light'): Promise<void> {
  await page.evaluate((c) => {
    return new Promise<void>((resolve) => {
      window.addEventListener('lecture:charts-settled', () => resolve(), { once: true })
      const html = document.documentElement
      if (c === 'dark') html.classList.add('dark')
      else if (c === 'skin') {
        const cur = html.getAttribute('data-lec-theme') || 'datasheet'
        html.setAttribute('data-lec-theme', cur === 'datasheet' ? 'reader' : 'datasheet')
      } else {
        html.classList.remove('dark')
        html.setAttribute('data-lec-theme', 'datasheet')
      }
    })
  }, change)
}

async function waveColors(page: Page) {
  return page.evaluate((sel) => {
    const svg = document.querySelector(`${sel} svg`)
    if (!svg) return null
    const texts = [...svg.querySelectorAll('text')]
    const fills = texts.map((t) => (t.getAttribute('fill') || t.style.fill || getComputedStyle(t).fill).toLowerCase())
    const styleText = svg.querySelector('style')?.textContent || ''
    const allRects = [...svg.querySelectorAll('rect')]
    const bgRect = allRects.find((r) => r.closest('#socket') === null)
    const bgFill = bgRect ? (bgRect.style.fill || bgRect.getAttribute('fill') || getComputedStyle(bgRect).fill).toLowerCase() : 'none'
    return {
      fills,
      darkStyle: styleText.includes('text{fill:#ffffff}') || styleText.includes('stroke:#ffffff'),
      darkTextStyle: styleText.includes('text{fill:#ffffff}'),
      bgFill,
    }
  }, WAVEDROM_FIG)
}

async function echartsState(page: Page) {
  return page.evaluate((sel) => {
    const body = document.querySelector(`${sel} .chart-body`) as HTMLElement | null
    const svg = body?.querySelector('svg')
    const canvas = body?.querySelector('canvas')
    if (svg) {
      const texts = [...svg.querySelectorAll('text')]
      const fills = texts.map((t) => (t.getAttribute('fill') || t.style.fill || getComputedStyle(t).fill).toLowerCase())
      return { type: 'svg' as const, elementCount: svg.children.length, fills }
    }
    if (canvas) return { type: 'canvas' as const, elementCount: 1, fills: [] as string[] }
    return null
  }, ECHARTS_FIG)
}

function realErrors(consoleErrors: string[]): string[] {
  return consoleErrors.filter((e) => !e.includes('outside of Vite serving allow list') && !e.includes('503') && !e.includes('403'))
}

test.describe('Charts dark mode & theme switching', () => {
  test('WaveDrom re-renders with matching colors on theme/mode change', async ({ page, consoleErrors, pageErrors }) => {
    expect(await gotoAndSettle(page, WAVEDROM_LECTURE), 'charts settled on initial load').toBe(true)
    await expect(page.locator(WAVEDROM_FIG)).toHaveAttribute('data-type', 'wavedrom')
    await expect(page.locator(WAVEDROM_FIG)).toHaveAttribute('data-rendered', '1')

    // Light mode: WaveDrom text is not pure white
    const light = await waveColors(page)
    expect(light, 'WaveDrom SVG present').not.toBeNull()
    expect(light!.fills.length, 'WaveDrom has text elements').toBeGreaterThan(0)
    expect(light!.fills.filter((c) => WHITE.includes(c)).length, 'light mode should not have white wave text').toBe(0)

    // Dark mode: dark skin / white text, background rect not opaque white
    await changeAndSettle(page, 'dark')
    const dark = await waveColors(page)
    expect(dark, 'WaveDrom SVG present in dark mode').not.toBeNull()
    expect(
      dark!.darkStyle || dark!.fills.some((c) => WHITE.includes(c)),
      'WaveDrom text in dark mode should use dark skin / white fill',
    ).toBe(true)
    expect(
      dark!.bgFill === 'transparent' || dark!.bgFill === 'none' || dark!.bgFill.includes('rgba(0, 0, 0, 0)'),
      'WaveDrom background rect must not be opaque white in dark mode',
    ).toBe(true)

    // Skin switch keeps it rendered
    await changeAndSettle(page, 'skin')
    await expect(page.locator(WAVEDROM_FIG)).toHaveAttribute('data-rendered', '1')

    // Back to light: no dark skin, no white text
    await changeAndSettle(page, 'light')
    const restored = await waveColors(page)
    expect(restored?.darkTextStyle, 'restored light mode should not have dark skin style').toBe(false)
    expect(restored?.fills.filter((c) => WHITE.includes(c)).length, 'restored light mode should not have white wave text').toBe(0)

    expect(pageErrors, 'no uncaught page errors during theme toggling').toEqual([])
    expect(realErrors(consoleErrors), 'no unexpected console errors during theme toggling').toEqual([])
  })

  test('ECharts re-renders with matching colors on theme/mode change', async ({ page, consoleErrors, pageErrors }) => {
    expect(await gotoAndSettle(page, ECHARTS_LECTURE), 'charts settled on initial load').toBe(true)
    expect(await page.locator('figure.chart').count()).toBeGreaterThanOrEqual(2)
    await expect(page.locator(ECHARTS_FIG)).toHaveAttribute('data-type', 'echarts')
    await expect(page.locator(ECHARTS_FIG)).toHaveAttribute('data-rendered', '1')

    const light = await echartsState(page)
    expect(light, 'ECharts rendered in light mode').not.toBeNull()
    expect(light!.elementCount).toBeGreaterThan(0)

    await changeAndSettle(page, 'dark')
    const dark = await echartsState(page)
    expect(dark, 'ECharts rendered in dark mode').not.toBeNull()
    expect(dark!.elementCount).toBeGreaterThan(0)
    if (dark?.type === 'svg' && light!.type === 'svg') {
      expect(light!.fills.length, 'ECharts has text in light mode').toBeGreaterThan(0)
      expect(dark.fills.join('|'), 'ECharts text colours differ between light and dark').not.toBe(light!.fills.join('|'))
    }
    if (dark?.type === 'svg') {
      const black = dark.fills.filter((c) => c === '#000000' || c === '#000' || c === 'rgb(0, 0, 0)' || c === '#1e293b')
      expect(black.length, 'ECharts text in dark mode should not be hardcoded black').toBe(0)
    }

    await changeAndSettle(page, 'skin')
    await expect(page.locator(ECHARTS_FIG)).toHaveAttribute('data-rendered', '1')
    await expect(page.locator('figure[data-id="c1"]')).toHaveAttribute('data-rendered', '1')

    await changeAndSettle(page, 'light')
    await expect(page.locator(ECHARTS_FIG)).toHaveAttribute('data-rendered', '1')

    expect(pageErrors, 'no uncaught page errors during theme toggling').toEqual([])
    expect(realErrors(consoleErrors), 'no unexpected console errors during theme toggling').toEqual([])
  })
})
