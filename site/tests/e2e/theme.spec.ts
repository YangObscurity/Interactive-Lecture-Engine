/**
 * Theme packs, reader-preference plumbing and typography contract (P2b).
 *
 * - first frame: the inline <head> script sets data-lec-* from stored prefs (no flash, no hydration
 *   mismatch);
 * - line-height contract in both themes: prose 17px × 2.212 = 37.6px, inline maths .81em, self-tests on
 *   the contract (FE-038); tables follow the spec board (14.5px / 1.7, maths cells 2.0 or prose
 *   line-height for tall maths); reader font step scales the box;
 * - debug hook switches theme / tint at runtime;
 * - fonts: reader downloads no webfont; datasheet cold load of a G05 lecture is measured against the
 *   3 MB woff2 regression guard (user decision 2026-11-17, replaces the 600 KB budget of plan §4).
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { BG, expectThemeActive, lecVar, useTheme, type ThemeId } from './theme-helpers'

const MATH_LECTURE = '/g01/L01' // inline maths, tables, ::: details
const G05 = '/g05/L19'
const FONT_BUDGET = 3 * 1024 * 1024 // regression guard; see the datasheet budget test below

async function metrics(page: Page) {
  return page.evaluate(() => {
    const px = (el: Element | null, prop: 'fontSize' | 'lineHeight') => (el ? parseFloat(getComputedStyle(el)[prop]) : NaN)
    const p = document.querySelector('.vp-doc > div > p, .vp-doc p')
    const tds = [...document.querySelectorAll('.vp-doc table td')]
    const td = tds.find((c) => !c.querySelector('.math-inline')) ?? null
    const tdMath = tds.find((c) => c.querySelector('.math-inline') && !c.querySelector('.mfrac, .sqrt, .msupsub, .mop.op-limits, .op-symbol.large-op')) ?? null
    const det = document.querySelector('.vp-doc details.details > :not(summary)')
    const math = document.querySelector('.vp-doc p .math-inline, .vp-doc li .math-inline')
    return {
      pFont: px(p, 'fontSize'),
      pLine: px(p, 'lineHeight'),
      tdFont: px(td, 'fontSize'),
      tdLine: px(td, 'lineHeight'),
      tdMathLine: px(tdMath, 'lineHeight'),
      detFont: px(det, 'fontSize'),
      detLine: px(det, 'lineHeight'),
      mathFont: px(math, 'fontSize'),
      bodyFamily: p ? getComputedStyle(p).fontFamily : '',
    }
  })
}

test.describe('theme packs', () => {
  test('SSR html carries the first-paint script in <head>', async ({ request }) => {
    const html = await (await request.get(G05)).text()
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).toContain('id="lecture-theme-prefs"')
    expect(head).toContain('data-lec-theme')
  })

  test('stored prefs apply before hydration, without hydration warnings', async ({ page, consoleErrors, pageErrors }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/hydration/i.test(m.text())) warnings.push(m.text())
    })
    await useTheme(page, 'reader', 'light', { tint: 'sepia', fontSize: 18, bodyFont: 'serif' })
    // read the attributes at DOMContentLoaded, i.e. before the Vue app mounts
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        const d = document.documentElement
        ;(window as unknown as { __attrsAtDCL: unknown }).__attrsAtDCL = ['data-lec-theme', 'data-lec-tint', 'data-lec-size', 'data-lec-font'].map((a) => d.getAttribute(a))
      })
    })
    await gotoAndSettle(page, MATH_LECTURE)
    expect(await page.evaluate(() => (window as unknown as { __attrsAtDCL: unknown }).__attrsAtDCL)).toEqual(['reader', 'sepia', '18', 'serif'])
    expect((await lecVar(page, '--lec-bg')).toUpperCase()).toBe('#F5ECD9')
    const m = await metrics(page)
    expect(m.pFont).toBe(18)
    expect(m.bodyFamily).toContain('Songti SC')
    expect(warnings).toEqual([])
    expect(consoleErrors.filter((t) => /hydration/i.test(t))).toEqual([])
    expect(pageErrors).toEqual([])
  })

  test('custom tint, imported theme layer and group-desc default apply at DOMContentLoaded without flash', async ({ page, consoleErrors, pageErrors }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (/hydration/i.test(m.text())) warnings.push(m.text())
    })
    await page.addInitScript(() => {
      localStorage.setItem('lecture:reader-prefs', JSON.stringify({ theme: 'reader' }))
      localStorage.setItem('lecture:reader-custom-tint', JSON.stringify({ hue: 42, lightness: 95 }))
      localStorage.setItem('lecture:reader-theme-layer', JSON.stringify({ modes: { light: { danger: '#991B1B' } } }))
      localStorage.setItem('lecture:group-desc', '0')
      document.addEventListener('DOMContentLoaded', () => {
        const d = document.documentElement
        const cs = getComputedStyle(d)
        ;(window as unknown as { __firstPaintF2: unknown }).__firstPaintF2 = {
          bgStyle: d.style.getPropertyValue('--lec-bg'),
          bgComputed: cs.getPropertyValue('--lec-bg').trim(),
          dangerStyle: d.style.getPropertyValue('--lec-danger'),
          descAttr: d.getAttribute('data-lec-desc'),
        }
      })
    })
    await gotoAndSettle(page, '/g05/')
    const fp = await page.evaluate(
      () =>
        (window as unknown as {
          __firstPaintF2: { bgStyle: string; bgComputed: string; dangerStyle: string; descAttr: string }
        }).__firstPaintF2,
    )
    expect(fp.bgStyle).toMatch(/^#[0-9A-F]{6}$/)
    expect(fp.bgComputed).toBeTruthy()
    expect(fp.dangerStyle.toUpperCase()).toBe('#991B1B')
    expect(fp.descAttr).toBe('closed')
    expect((await lecVar(page, '--lec-bg')).toUpperCase()).toBe(fp.bgStyle.toUpperCase())
    await page.locator('.gp-lanes [data-lecture="g05-l19"]').dblclick()
    await expect(page.locator('.gp-p-desc details')).toHaveJSProperty('open', false)
    expect(warnings).toEqual([])
    expect(consoleErrors.filter((t) => /hydration/i.test(t))).toEqual([])
    expect(pageErrors).toEqual([])
  })

  for (const theme of ['reader', 'datasheet'] as ThemeId[]) {
    test(`${theme}: line-height contract (17px / 2.212 / .81em), spec-board tables, self-tests restored`, async ({ page }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, MATH_LECTURE)
      await expectThemeActive(page, theme, 'light')
      const m = await metrics(page)
      expect(m.pFont).toBe(17)
      expect(m.pLine).toBeCloseTo(37.6, 1)
      expect(m.mathFont).toBeCloseTo(17 * 0.81, 1)
      // tables follow the spec board (user decision 2026-11-17): 14.5px / 1.7, cells with inline maths open to 2.0
      expect(m.tdFont).toBeCloseTo(14.5, 0)
      expect(m.tdLine).toBeCloseTo(m.tdFont * 1.7, 0)
      expect(m.tdMathLine).toBeCloseTo(m.tdFont * 2, 0)
      expect(m.detFont).toBe(17)
      expect(m.detLine).toBeCloseTo(37.6, 1)
      expect(await lecVar(page, '--lec-prose-line-height')).toBe('2.212')
    })
  }

  test('reader font step 20px scales the line box proportionally', async ({ page }) => {
    await useTheme(page, 'reader', 'light', { fontSize: 20 })
    await gotoAndSettle(page, MATH_LECTURE)
    const m = await metrics(page)
    expect(m.pFont).toBe(20)
    expect(m.pLine).toBeCloseTo(20 * 2.212, 1)
    expect(m.mathFont).toBeCloseTo(20 * 0.81, 1)
  })

  test('debug hook switches theme and tint at runtime', async ({ page }) => {
    await useTheme(page, 'datasheet', 'light')
    await gotoAndSettle(page, `${G05}?debug=1`)
    await expectThemeActive(page, 'datasheet', 'light')
    const run = (...args: unknown[]) =>
      page.evaluate((a) => (window as unknown as { __LECTURE_DEBUG__: { run: (...x: unknown[]) => unknown } }).__LECTURE_DEBUG__.run(...a), args)
    await run('theme', 'theme', 'reader')
    await expectThemeActive(page, 'reader', 'light')
    await run('theme', 'tint', 'green')
    expect((await lecVar(page, '--lec-bg')).toUpperCase()).toBe('#CCE8CF')
    await run('theme', 'tint', 'dark')
    await expectThemeActive(page, 'reader', 'dark')
    // tint presets never apply in dark mode
    await run('theme', 'tint', 'sepia')
    expect((await lecVar(page, '--lec-bg')).toUpperCase()).toBe(BG['reader-dark'])
    await run('theme', 'reset')
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'datasheet')
    expect(await page.evaluate(() => localStorage.getItem('lecture:reader-prefs'))).toBeNull()
  })
})

test.describe('fonts', () => {
  async function woff2(page: Page) {
    return page.evaluate(() =>
      (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .filter((e) => /\.woff2(\?|$)/.test(e.name))
        .map((e) => ({ name: e.name.replace(/^.*\//, ''), body: e.encodedBodySize, transfer: e.transferSize })),
    )
  }

  test('reader downloads no webfont (KaTeX maths faces excepted)', async ({ page }) => {
    await useTheme(page, 'reader', 'light')
    await gotoAndSettle(page, G05)
    await page.evaluate(() => document.fonts.ready)
    const files = (await woff2(page)).filter((f) => !/^KaTeX_/.test(f.name))
    expect(files).toEqual([])
  })

  test('datasheet: cold load of a G05 lecture stays within the woff2 budget', async ({ page }, testInfo) => {
    // Budget decided by the user 2026-11-17: keep the variable Noto faces (measured ≈ 2673 KB cold:
    // Serif ≈ 1696 + Sans ≈ 957 + Mono 21) and guard against regressions at 3 MB. The original 600 KB
    // budget was dropped; per-page subsetting stays an optional later optimisation.
    await useTheme(page, 'datasheet', 'light')
    await gotoAndSettle(page, G05)
    await page.evaluate(() => document.fonts.ready)
    const files = await woff2(page)
    const sum = (xs: typeof files) => xs.reduce((a, f) => a + f.body, 0)
    const noto = files.filter((f) => /^noto-/.test(f.name))
    const report = {
      files: files.length,
      totalKB: +(sum(files) / 1024).toFixed(1),
      serifKB: +(sum(noto.filter((f) => f.name.startsWith('noto-serif'))) / 1024).toFixed(1),
      sansKB: +(sum(noto.filter((f) => f.name.startsWith('noto-sans'))) / 1024).toFixed(1),
      monoKB: +(sum(files.filter((f) => /jetbrains/.test(f.name))) / 1024).toFixed(1),
      katexKB: +(sum(files.filter((f) => /^KaTeX_/.test(f.name))) / 1024).toFixed(1),
    }
    await testInfo.attach('font-budget.json', { body: JSON.stringify({ report, files }, null, 2), contentType: 'application/json' })
    testInfo.annotations.push({ type: 'font-budget', description: JSON.stringify(report) })
    console.warn(`[font-budget] ${JSON.stringify(report)}`)
    expect(noto.length, 'datasheet must load its self-hosted faces').toBeGreaterThan(0)
    expect(sum(files), `woff2 total ${report.totalKB} KB > ${FONT_BUDGET / 1024} KB`).toBeLessThanOrEqual(FONT_BUDGET)
  })
})
