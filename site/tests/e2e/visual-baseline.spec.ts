/**
 * Visual baseline (plan §7 P0 / §8 "视觉"): home, LR group page, one G05 lecture, and the AI
 * companion sidebar opened on that lecture — desktop 1440x900 / mobile 390x844 × light / dark.
 *
 * Baselines were recorded on V1 (main b5e6c2e6) with
 *   npx playwright test --project prod --update-snapshots tests/e2e/visual-baseline.spec.ts
 * Tolerance: VISUAL_TOLERANCE env (maxDiffPixelRatio, default 0 — see playwright.config.ts).
 * Home / group pages are full-page; lecture + sidebar are viewport-only.
 */
import type { Page, Locator } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

const LECTURE = '/g05/L19' // G05 databases, 4 charts (2 mermaid + 2 echarts)

// P2b (theme packs, fonts, typography) intentionally changes every page, so these V1 screenshots are
// kept as a frozen reference only — they no longer describe the expected V2 look. V2 baselines live in
// visual-v2.spec.ts. Run this file explicitly with VISUAL_V1=1 to diff V2 against V1.
test.skip(!process.env.VISUAL_V1, 'V1 reference baselines (P0); set VISUAL_V1=1 to compare')

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const
const THEMES = ['light', 'dark'] as const

/** Dynamic content (git dates, counters derived from content/progress, session times). */
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

async function prepare(page: Page, theme: (typeof THEMES)[number]) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('vitepress-theme-appearance', t)
    } catch {
      /* ignore */
    }
  }, theme)
}

for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  for (const theme of THEMES) {
    test.describe(`@visual ${vpName} ${theme}`, () => {
      test.use({ viewport, isMobile: vpName === 'mobile', hasTouch: vpName === 'mobile' })

      test.beforeEach(async ({ page }) => {
        await prepare(page, theme)
      })

      test(`home @visual`, async ({ page }) => {
        await gotoAndSettle(page, '/')
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/)
        await expect(page).toHaveScreenshot(`home-${vpName}-${theme}.png`, {
          fullPage: true,
          mask: dynamicMasks(page),
        })
      })

      test(`lr group @visual`, async ({ page }) => {
        await gotoAndSettle(page, '/lr/')
        await expect(page).toHaveScreenshot(`lr-group-${vpName}-${theme}.png`, {
          fullPage: true,
          mask: dynamicMasks(page),
        })
      })

      test(`g05 lecture @visual`, async ({ page }) => {
        const done = await gotoAndSettle(page, LECTURE)
        expect(done, '__CHARTS_DONE__').toBe(true)
        await expect(page).toHaveScreenshot(`g05-L19-${vpName}-${theme}.png`, {
          mask: dynamicMasks(page),
        })
      })

      test(`g05 lecture + AI sidebar @visual`, async ({ page }) => {
        await gotoAndSettle(page, LECTURE)
        const trigger = page.locator('.ai-trigger-tab')
        await expect(trigger).toBeVisible()
        if (vpName === 'mobile') {
          // KNOWN V1 DEFECT (P0, main b5e6c2e6): at 390px the trigger tab is visible but
          // `.VPDoc` (inside #VPContent) sits above it and intercepts pointer events, so a real
          // tap cannot open the sidebar. Open via the Ctrl+J shortcut so the baseline still
          // captures the opened panel. V2 should make `trigger.click()` work here too.
          await page.keyboard.press('Control+j')
        } else {
          await trigger.click()
        }
        await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
        await expect(page).toHaveScreenshot(`g05-L19-ai-sidebar-${vpName}-${theme}.png`, {
          mask: dynamicMasks(page),
        })
      })
    })
  }
}
