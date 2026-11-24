/**
 * S6Y F1 (audit-spec #2 #3 #19 #20 #21 #24): engine controls set their own line height instead of inheriting VitePress'
 * 24px. Every expected number is taken from the spec board (V2 设计规格板.html), section in the comment.
 * Runs on the demo content (MEA L02 has the title block, a quiz and the lecture sidebar).
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

const LECTURE = '/mea/L02'

interface Box {
  h: number
  w: number
  lh: string
  pad: string
  fs: string
}

/** All matches of `sel` (at least one: a missing element fails here, not as an undefined later). */
async function boxes(page: Page, sel: string): Promise<[Box, ...Box[]]> {
  const out = await page.locator(sel).evaluateAll((els) =>
    els.map((e) => {
      const r = e.getBoundingClientRect()
      const c = getComputedStyle(e)
      return { h: r.height, w: r.width, lh: c.lineHeight, pad: c.padding, fs: c.fontSize }
    }),
  )
  expect(out.length, `${sel} is on the page`).toBeGreaterThan(0)
  return out as [Box, ...Box[]]
}

function near(actual: number, expected: number, tol: number, what: string): void {
  expect(Math.abs(actual - expected), `${what}: ${actual.toFixed(2)} vs spec ${expected} (±${tol})`).toBeLessThanOrEqual(tol)
}

for (const theme of ['reader', 'datasheet'] as const) {
  test.describe(`@s6y-f1 ${theme} desktop 1280`, () => {
    test.use({ viewport: { width: 1280, height: 900 } })

    test('title block: h1 40/48, top line, spec table rows (spec board 06 / 03)', async ({ page }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, LECTURE)
      const [h1] = await boxes(page, '.lec-tb-h1')
      // 06 `.tb h1 { font-size: 40px; line-height: 1.2 }`, same in both skins
      expect(h1.fs).toBe('40px')
      near(parseFloat(h1.lh), 48, 0.5, 'h1 line-height')
      // 06 `.tb-top` 12.5px x 1.6 = 20; datasheet adds the heavy rule (2) and padding-top 8 -> 30
      const [top] = await boxes(page, '.lec-tb-top')
      near(top.h, theme === 'reader' ? 20 : 30, 1, 'tb-top height')
      // 06 `.tb-spec th, td { padding: 6px 12px }`, 13px x 1.6 = 20.8; row 33.8 (reader) / 34.8 (datasheet, hairline between rows)
      const th = await boxes(page, '.lec-tb-spec th')
      expect(th[0].pad).toBe('6px 12px')
      expect(th[0].lh).toBe('20.8px')
      const rows = await boxes(page, '.lec-tb-spec tr')
      const rowSpec = theme === 'reader' ? 33.8 : 34.8
      // reader only draws a 1px divider on `tr + tr`, so row 0 has no top hairline (32.8px vs 33.8px)
      near(rows[0].h, theme === 'reader' ? 32.8 : rowSpec, 1, 'first spec row')
      for (const [i, r] of rows.entries()) expect(r.h, `spec row ${i}`).toBeLessThanOrEqual(rowSpec + 1)
    })

    test('quiz head, lecture sidebar rows, back-to-text button (spec board 08 / 05 / 07.1)', async ({ page }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, LECTURE)
      // 08 `.quiz-head { padding: 8px 16px; font-size: 13px }` -> line 20.8; reader head 38 with its top hairline
      const [qh] = await boxes(page, '.lec-quiz-head')
      expect(qh.pad).toBe('8px 16px')
      expect(qh.lh).toBe('20.8px')
      if (theme === 'reader') near(qh.h, 37.8, 1, 'quiz head height')
      // 05 `.side a.link { padding: 5px 8px; line-height: 1.45 }` at 14px -> 30.3
      const rows = await boxes(page, '.VPSidebarItem .link:has(> .lec-status-box)')
      expect(rows.length).toBeGreaterThan(1)
      for (const [i, r] of rows.entries()) near(r.h, 30.3, 1, `sidebar lecture row ${i}`)
      // 07.1 `.backbtn { padding: 3px 10px; font: 500 12.5px }`, line normal: board measures 24 (reader font) / 27 (datasheet font)
      await page.evaluate(() => {
        const b = document.createElement('button')
        b.className = 'lec-xref-backbtn'
        b.textContent = '\u21a9 回到正文'
        document.body.appendChild(b)
      })
      const [back] = await boxes(page, '.lec-xref-backbtn')
      expect(back.lh).toBe('normal')
      near(back.h, theme === 'reader' ? 24 : 27, 1, 'back-to-text button')
    })

    test('course menu, reader settings, search panel (spec board 04.1 / 02 / 04.2)', async ({ page }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, LECTURE)
      await page.locator('.cm-trigger').first().click()
      // 04.1 `.cm-groups a { padding: 5px 12px 5px 8px }` 13.5px x 1.6 -> 31.6; `.cm-hint` 12px x 1.6 + 16 + 1 -> 36.2
      const groups = await boxes(page, '.cm-groups a')
      expect(groups.length).toBeGreaterThan(1)
      for (const [i, g] of groups.entries()) near(g.h, 31.6, 1, `course menu group row ${i}`)
      near((await boxes(page, '.cm-hint'))[0].h, 36.2, 1, 'course menu hint')
      await page.keyboard.press('Escape')

      await page.locator('[data-lec-settings-btn]').click()
      // 02 `.set-wrap { grid-template-columns: 360px ... }`; `.seg button { 13px; padding: 5px 12px }` line normal:
      // board measures 27 (reader font) / 29 (datasheet font)
      near((await boxes(page, '.rs-panel'))[0].w, 360, 0.5, 'settings panel width')
      const pills = await boxes(page, '.rs-panel .rs-pill')
      for (const [i, p] of pills.entries()) near(p.h, theme === 'reader' ? 27 : 29, 1, `settings option ${i}`)
      await page.keyboard.press('Escape')

      await page.keyboard.press('Control+k')
      await expect(page.locator('.sp-in')).toBeVisible()
      // 04.2 `.sp-in { padding: 8px 12px }` with the framed 15px input: board 51 (reader) / 52 (datasheet)
      const [inp] = await boxes(page, '.sp-in')
      expect(inp.pad).toBe('8px 12px')
      near(inp.h, theme === 'reader' ? 51 : 52, 1, 'search input row')
      await page.keyboard.type('有效数字')
      await expect(page.locator('.sp-hit').first()).toBeVisible()
      // 04.2 `.sp-hit { padding: 6px 12px }`
      expect((await boxes(page, '.sp-hit'))[0].pad).toBe('6px 12px')
    })
  })

  test.describe(`@s6y-f1 ${theme} phone 390`, () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('title block on a phone: h1 28, th 5px 8px, node id on one line (spec board 16)', async ({ page }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, LECTURE)
      expect((await boxes(page, '.lec-tb-h1'))[0].fs).toBe('28px')
      // 16 `.phone .tb-spec th, .phone .tb-spec td { padding: 5px 8px }`, row 31.8 (+1 hairline in datasheet)
      const th = await boxes(page, '.lec-tb-spec th')
      expect(th[0].pad).toBe('5px 8px')
      const rows = await boxes(page, '.lec-tb-spec tr')
      // reader only draws a 1px divider on `tr + tr`, so row 0 on phone has no top hairline (30.8px vs 32.8px)
      near(rows[0].h, theme === 'reader' ? 30.8 : 32.8, 1, 'first spec row on a phone')
      // the node id keeps one line (it was squeezed to two, row 62px)
      const [code] = await boxes(page, '.lec-tb-spec code')
      expect(code.h, 'node id height').toBeLessThanOrEqual(21)
    })
  })
}
