/**
 * tests/e2e/course-menu.spec.ts - E2E coverage for WP-F4 Course Menu (spec board §04.1 Rev E).
 *
 * Covers:
 *   - Both skins (reader, datasheet)
 *   - Open via single click on .cm-trigger (no hover open)
 *   - Hover preview (hovering a group row previews its lectures without navigating)
 *   - Click group row / link opens group page
 *   - Click lecture row opens lecture
 *   - Status marks from §05 live-updated via progress store
 *   - Keyboard navigation (arrows between/within columns, Enter, Esc, focus trap)
 *   - Phone collapsible list in drawer (< 768px)
 *   - No horizontal overflow at 320px, 360px, 390px
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme, type ThemeId } from './theme-helpers'

const SKINS: ReadonlyArray<readonly [ThemeId, string]> = [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
]

const WIRE = { not_started: '未开始', in_progress: '学习中', completed: '已完成' } as const

/** Server records for group g05. */
async function mockProgress(page: Page): Promise<void> {
  const records = Array.from({ length: 60 }, (_, i) => {
    const n = i + 1
    const status = n === 1 ? 'completed' : n === 19 ? 'in_progress' : 'not_started'
    return {
      lecture_id: `g05-l${String(n).padStart(2, '0')}`,
      group_id: 'g05',
      status: WIRE[status],
      completed_at: status === 'completed' ? '2026-11-01T00:00:00.000Z' : null,
      updated_at: '2026-11-01T00:00:00.000Z',
      notion_node_id: null,
      notion_page_id: null,
    }
  })

  await page.context().route(/\/api\/db\/progress(\/|\?|$)/, (route) => {
    const req = route.request()
    if (req.method() !== 'GET') {
      const body = (req.postDataJSON() ?? {}) as { status?: string }
      const id = new URL(req.url()).pathname.split('/').pop() ?? ''
      return route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          lecture_id: id,
          group_id: 'g05',
          status: body.status ?? WIRE.not_started,
          completed_at: null,
          updated_at: new Date().toISOString(),
          notion_node_id: null,
          notion_page_id: null,
        }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(records),
    })
  })
}

async function storeReady(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = window as unknown as { __LECTURE_DEBUG__?: { panel(id: string): unknown } }
          const p = w.__LECTURE_DEBUG__?.panel('progress') as { ready?: boolean; unfilteredGet?: boolean | null } | undefined
          return Boolean(p?.ready && p.unfilteredGet !== null)
        }),
      { message: 'progress store ready' },
    )
    .toBe(true)
}

for (const [theme, expectedImpl] of SKINS) {
  test.describe(`course menu (${theme} skin)`, () => {
    test('desktop: open, hover preview, click group, click lecture, no card shadow', async ({ page, pageErrors }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await useTheme(page, theme, 'light')
      await mockProgress(page)
      await page.context().addInitScript(() => localStorage.setItem('lecture:debug', '1'))
      await gotoAndSettle(page, '/g05/L19')
      await storeReady(page)

      const menuSlot = page.locator('.VPNavBar [data-slot="NavCourseMenu"]')
      await expect(menuSlot).toBeVisible()
      await expect(menuSlot).toHaveAttribute('data-slot-impl', expectedImpl)

      const trigger = page.locator('.cm-trigger')
      await expect(trigger).toBeVisible()
      await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')

      // 1. Single click opens the menu; no hover open
      await trigger.click()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      const dialog = page.locator('.cm[role="dialog"]')
      await expect(dialog).toBeVisible()

      // §17: No card shadows
      const shadow = await dialog.evaluate((el) => getComputedStyle(el).boxShadow)
      expect(shadow).toBe('none')

      // Two columns present: groups on left, lectures on right
      const groupLinks = page.locator('.cm-groups li a')
      const groupCount = await groupLinks.count()
      expect(groupCount).toBe(17)

      // Initial active group on /g05/L19 is G05
      const activeGroupLink = page.locator('.cm-groups li a.is-active')
      await expect(activeGroupLink).toContainText('G05')

      // 2. Hover preview: hovering another group previews its lectures in the right column without navigating
      const g01Link = groupLinks.first()
      await g01Link.hover()
      await expect(page.locator('.cm-groups li a.is-active')).toContainText('G01')
      await expect(page.locator('.cm-lec header b')).toContainText('G01')
      // the current lecture mark belongs to the current group only (G01 also has a lecture 19)
      await expect(page.locator('.cm-lec ol li a[aria-current="page"]')).toHaveCount(0)
      // URL has NOT navigated
      expect(page.url()).toContain('/g05/L19')

      // 3. Click group row opens group page
      await page.locator('.cm-lec header a').click()
      await expect(page).toHaveURL(/\/g01\/?$/)
      await expect(dialog).toBeHidden()
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')

      // 4. Click lecture row opens lecture
      await gotoAndSettle(page, '/g05/L19')
      await storeReady(page)
      await trigger.click()
      await expect(dialog).toBeVisible()

      const firstLec = page.locator('.cm-lec ol li a').first()
      await firstLec.click()
      await expect(page).toHaveURL(/\/g05\/L0?1\/?$/)
      await expect(dialog).toBeHidden()

      expect(pageErrors.map(String)).toEqual([])
    })

    test('desktop: status marks live update via progress store', async ({ page, pageErrors }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await useTheme(page, theme, 'light')
      await mockProgress(page)
      await page.context().addInitScript(() => localStorage.setItem('lecture:debug', '1'))
      await gotoAndSettle(page, '/g05/L19')
      await storeReady(page)

      const trigger = page.locator('.cm-trigger')
      await trigger.click()
      const dialog = page.locator('.cm[role="dialog"]')
      await expect(dialog).toBeVisible()

      // G05-L01 is completed ('read'), G05-L19 is in_progress ('reading'), G05-L02 is not_started ('unread')
      const lecL01 = page.locator('.cm-lec ol li a', { hasText: '01' }).first()
      await expect(lecL01.locator('.mk')).toHaveAttribute('data-status', 'read')

      const lecL19 = page.locator('.cm-lec ol li a', { hasText: '19' }).first()
      await expect(lecL19.locator('.mk')).toHaveAttribute('data-status', 'reading')

      // Close menu by clicking trigger again
      await trigger.click()
      await expect(dialog).toBeHidden()

      // Mark G05-L19 as completed via the lecture progress card
      await page.locator('.lpc-seg-btn', { hasText: '已完成' }).click()

      // Re-open course menu: status of L19 is live updated to 'read'
      await trigger.click()
      await expect(dialog).toBeVisible()
      await expect(page.locator('.cm-lec ol li a', { hasText: '19' }).first().locator('.mk')).toHaveAttribute('data-status', 'read')

      expect(pageErrors.map(String)).toEqual([])
    })

    test('desktop: keyboard navigation, column switching, focus trap, and Esc close', async ({ page, pageErrors }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await useTheme(page, theme, 'light')
      await mockProgress(page)
      await page.context().addInitScript(() => localStorage.setItem('lecture:debug', '1'))
      await gotoAndSettle(page, '/g05/L19')
      await storeReady(page)

      const trigger = page.locator('.cm-trigger')
      await trigger.focus()
      await page.keyboard.press('Enter')

      const dialog = page.locator('.cm[role="dialog"]')
      await expect(dialog).toBeVisible()

      // ArrowDown moves down in groups
      await page.keyboard.press('ArrowDown')
      const nextActive = page.locator('.cm-groups li a.is-active')
      await expect(nextActive).toBeVisible()

      // ArrowRight switches active column to lectures
      await page.keyboard.press('ArrowRight')
      const activeLecture = page.locator('.cm-lec ol li a.is-active')
      await expect(activeLecture).toBeVisible()

      // ArrowDown moves to next lecture in column
      await page.keyboard.press('ArrowDown')

      // ArrowLeft returns to groups column
      await page.keyboard.press('ArrowLeft')
      await expect(page.locator('.cm-lec ol li a.is-active')).toHaveCount(0)

      // Focus trap: Tab and Shift+Tab wrap inside dialog
      await page.keyboard.press('Shift+Tab')
      const insideOnShiftTab = await dialog.evaluate((el) => el.contains(document.activeElement))
      expect(insideOnShiftTab).toBe(true)

      await page.keyboard.press('Tab')
      const insideOnTab = await dialog.evaluate((el) => el.contains(document.activeElement))
      expect(insideOnTab).toBe(true)

      // Esc closes dialog and returns focus to opener trigger
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(trigger).toBeFocused()

      expect(pageErrors.map(String)).toEqual([])
    })

    test('phone: collapsible drawer accordion and no horizontal overflow at 320/360/390 px', async ({ page, pageErrors }) => {
      await page.setViewportSize({ width: 375, height: 667 })
      await useTheme(page, theme, 'light')
      await mockProgress(page)
      await page.context().addInitScript(() => localStorage.setItem('lecture:debug', '1'))
      await gotoAndSettle(page, '/g05/L19')
      await storeReady(page)

      // Desktop trigger is hidden on phone
      await expect(page.locator('.cm-trigger')).toBeHidden()

      // Open mobile drawer
      const hamburger = page.locator('.VPNavBarHamburger')
      await hamburger.click()
      const mobileList = page.locator('.cm-mobile-list')
      await expect(mobileList).toBeVisible()

      // On /g05/L19, current group G05 is pre-expanded
      const g05Row = page.locator('.cm-mob-group', { hasText: 'G05' })
      const g05Btn = g05Row.locator('.cm-mob-btn')
      await expect(g05Btn).toHaveAttribute('aria-expanded', 'true')
      const g05Lecs = g05Row.locator('.cm-mob-lectures')
      await expect(g05Lecs).toBeVisible()

      // Toggling G05 collapses it
      await g05Btn.click()
      await expect(g05Btn).toHaveAttribute('aria-expanded', 'false')

      // Other groups (e.g. G01) start collapsed; clicking expands them
      const g01Row = page.locator('.cm-mob-group', { hasText: 'G01' })
      const g01Btn = g01Row.locator('.cm-mob-btn')
      await expect(g01Btn).toHaveAttribute('aria-expanded', 'false')
      await g01Btn.click()
      await expect(g01Btn).toHaveAttribute('aria-expanded', 'true')
      const g01Lecs = g01Row.locator('.cm-mob-lectures')
      await expect(g01Lecs).toBeVisible()

      // Test horizontal overflow at 320, 360, 390 px while drawer and group are open
      for (const w of [320, 360, 390]) {
        await page.setViewportSize({ width: w, height: 667 })
        await expect(mobileList).toBeVisible()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(overflow, `horizontal overflow at ${w}px`).toBeLessThanOrEqual(0)
      }

      // Clicking lecture link navigates and closes drawer
      const targetLec = g01Lecs.locator('li a').first()
      await targetLec.click()
      await expect(page).toHaveURL(/\/g01\/L0?1\/?$/)

      expect(pageErrors.map(String)).toEqual([])
    })
  })
}
