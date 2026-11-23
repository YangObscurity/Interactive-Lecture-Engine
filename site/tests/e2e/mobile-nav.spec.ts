/**
 * Phone navigation: on lecture pages the nav bar must not overflow at 390 px, and the VitePress
 * hamburger must stay inside the viewport and open the nav screen.
 */
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

const PAGES = [
  ['zh', '/g05/L19'],
  ['en', '/en/examples/g01/L01'],
] as const

test.use({ viewport: { width: 390, height: 844 } })

for (const [label, path] of PAGES) {
  test(`@mobile-nav ${label} ${path}: no horizontal overflow, hamburger reachable`, async ({ page }) => {
    await gotoAndSettle(page, path)

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    const hamburger = page.locator('.VPNavBarHamburger')
    await expect(hamburger).toBeVisible()
    const box = await hamburger.boundingBox()
    expect(box).not.toBeNull()
    if (!box) return
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)

    for (const sel of ['.lecture-export-btn', '.reading-mode-nav-btn']) {
      const btn = page.locator(sel)
      if ((await btn.count()) === 0) continue
      const b = await btn.boundingBox()
      expect(b, sel).not.toBeNull()
      if (!b) continue
      expect(b.width, `${sel} width`).toBeGreaterThanOrEqual(40)
      expect(b.height, `${sel} height`).toBeGreaterThanOrEqual(40)
    }

    await hamburger.click()
    await expect(page.locator('.VPNavScreen')).toBeVisible()
  })
}

// ---- phone widths x both skins: nothing may scroll the page sideways (P5 audit D-01 / WP-F1) ----------------------------------
//
// The overflow of /g05/L19 at 390 px was NOT the lecture title block (the audit's guess) but the top bar: site title + search +
// export + reading mode + reader settings + hamburger need about 396 px next to the zh site title.

const WIDTHS = [320, 360, 390] as const
const PHONE_PAGES = ['/g05/L19', '/g05/', '/'] as const

for (const theme of ['reader', 'datasheet'] as const) {
  for (const width of WIDTHS) {
    test(`@mobile-nav ${theme} ${width} px: no sideways scroll on lecture, group and home pages; title block, figures and quiz header fit`, async ({ page }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height: 844 })
      await useTheme(page, theme, 'light')
      for (const path of PHONE_PAGES) {
        await gotoAndSettle(page, path)
        const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: window.innerWidth }))
        expect(o.sw, `${path}: scrollWidth ${o.sw} > innerWidth ${o.vw}`).toBeLessThanOrEqual(o.vw)
        const hb = await page.locator('.VPNavBarHamburger').boundingBox()
        expect(hb, `${path} hamburger`).not.toBeNull()
        if (hb) expect(hb.x + hb.width, `${path} hamburger right edge`).toBeLessThanOrEqual(width)
      }
      // the lecture blocks of P5: each must sit inside the viewport on its own, not only because an ancestor clips it
      await gotoAndSettle(page, '/g05/L19')
      for (const sel of ['.lec-tb', '[data-slot="FigureFrame"]', '[data-slot="QuizHeader"]']) {
        const boxes = await page.locator(sel).evaluateAll((els) => els.map((e) => ({ l: e.getBoundingClientRect().left, r: e.getBoundingClientRect().right })))
        for (const b of boxes) {
          expect(b.l, `${sel} left`).toBeGreaterThanOrEqual(-0.5)
          expect(b.r, `${sel} right`).toBeLessThanOrEqual(width + 0.5)
        }
      }
    })
  }
}
