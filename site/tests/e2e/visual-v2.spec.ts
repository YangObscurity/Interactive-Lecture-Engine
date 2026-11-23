/**
 * V2 visual baselines (P2b): theme packs × modes on the three reference pages.
 *
 *   desktop 1440×900: home (full page), /g05/L19 (viewport), /lr/ (full page)
 *                     × reader-light, reader-dark, datasheet-light, datasheet-dark
 *   mobile  390×844 : /g05/L19 × the same four theme-modes
 *
 * Snapshot names start with `v2-`; the P0 V1 references in visual-baseline.spec.ts are kept as they
 * were (that spec only runs with VISUAL_V1=1). Record with
 *   npx playwright test --project prod --update-snapshots tests/e2e/visual-v2.spec.ts
 */
import type { Locator, Page } from '@playwright/test'
import { test, expect, gotoAndSettle, waitForLabelPaint } from './fixtures'
import { THEME_MODES, expectThemeActive, useTheme } from './theme-helpers'

const LECTURE = '/g05/L19'

function dynamicMasks(page: Page): Locator[] {
  return [
    page.locator('.VPLastUpdated'),
    page.locator('.hub-stats-strip .stat-num'),
    page.locator('.hb-count'),
    page.locator('.hb-recent'),
    page.locator('[data-gp-spec="read"]'),
    page.locator('.lpc-time-tag'),
    page.locator('.session-time'),
  ]
}

async function expectThemeSettled(page: Page, theme: (typeof THEME_MODES)[number][0], mode: (typeof THEME_MODES)[number][1], slots: string[] = []): Promise<void> {
  await expectThemeActive(page, theme, mode)
  await page.waitForSelector('html[data-hydrated="1"]')
  const impl = theme === 'reader' ? 'default' : theme
  for (const slot of slots) {
    await page.waitForFunction(
      ([s, i]) => {
        const els = document.querySelectorAll(`[data-slot="${s}"]`)
        return els.length > 0 && Array.from(els).every((el) => el.getAttribute('data-slot-impl') === i)
      },
      [slot, impl] as const,
    )
  }
  if ((await page.locator('.home-body').count()) > 0) {
    await page.waitForSelector('.home-body[data-home-settled="1"]', { timeout: 10_000 }).catch(() => {})
  }
  await page.evaluate(async () => {
    await document.fonts?.ready
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  })
  // the canvas labels are repainted after the font files arrive: not before the layer says so is the page ready for a screenshot
  await waitForLabelPaint(page)
}

for (const [theme, mode] of THEME_MODES) {
  test.describe(`@visual-v2 desktop ${theme}-${mode}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })
    test.beforeEach(async ({ page }) => useTheme(page, theme, mode))

    test('home', async ({ page }) => {
      await gotoAndSettle(page, '/')
      await expectThemeSettled(page, theme, mode, ['AtlasCenter', 'AtlasCategory', 'AtlasGroup', 'AtlasPhase', 'AtlasLecture', 'AtlasLink', 'GroupCard'])
      await expect(page).toHaveScreenshot(`v2-home-${theme}-${mode}-desktop.png`, { fullPage: true, mask: dynamicMasks(page) })
    })

    test('g05 lecture', async ({ page }) => {
      expect(await gotoAndSettle(page, LECTURE), '__CHARTS_DONE__').toBe(true)
      await expectThemeSettled(page, theme, mode, ['SidebarStatus', 'LectureTitleBlock', 'FigureFrame', 'QuizHeader'])
      await expect(page).toHaveScreenshot(`v2-g05-L19-${theme}-${mode}-desktop.png`, { mask: dynamicMasks(page) })
    })

    test('lr group', async ({ page }) => {
      await gotoAndSettle(page, '/lr/')
      await expectThemeSettled(page, theme, mode, ['GroupMap'])
      await expect(page).toHaveScreenshot(`v2-lr-group-${theme}-${mode}-desktop.png`, { fullPage: true, mask: dynamicMasks(page) })
    })
  })

  test.describe(`@visual-v2 mobile ${theme}-${mode}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    test.beforeEach(async ({ page }) => useTheme(page, theme, mode))

    test('g05 lecture', async ({ page }) => {
      expect(await gotoAndSettle(page, LECTURE), '__CHARTS_DONE__').toBe(true)
      await expectThemeSettled(page, theme, mode, ['SidebarStatus', 'LectureTitleBlock', 'FigureFrame', 'QuizHeader'])
      await expect(page).toHaveScreenshot(`v2-g05-L19-${theme}-${mode}-mobile.png`, { mask: dynamicMasks(page) })
    })
  })
}
