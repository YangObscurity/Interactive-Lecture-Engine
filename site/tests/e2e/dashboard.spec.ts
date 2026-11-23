/**
 * P6.5 Dashboard E2E: `/dashboard` and `/en/dashboard` in online read-only mode.
 *
 * Verifies:
 *   1. Unauthorized / non-admin sessions see the access-denied gate and never trigger `/api/admin/*`.
 *   2. Admin sessions (`roles: ['reader', 'admin']`) get the v3.4 Dashboard read only: nine pages (no language page),
 *      `/api/admin/overview` and `/api/admin/health`, page and tab in the URL hash, local-only features explained
 *      instead of shown, no editor or save bar, live theme switching, and no console errors, page errors or hydration
 *      warnings.
 */
import { expect, test } from './fixtures'
import { useTheme } from './theme-helpers'

test.describe('P6.5 Lecture Dashboard (/dashboard)', () => {
  test('blocks non-admin readers without requesting /api/admin/*', async ({ page, consoleErrors, pageErrors }) => {
    test.skip(test.info().project.name === 'dev', 'Tests the online (Authelia/session) gate; the dev server runs the local author mode, which has no such gate')
    const adminRequests: string[] = []
    await page.context().route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          authenticated: true,
          user: { id: 'bob', name: 'Bob', email: 'bob@example.com' },
          roles: ['reader'],
          groups: ['students-2026'],
          logoutUrl: null,
        }),
      }),
    )
    await page.context().route('**/api/admin/*', (route) => {
      adminRequests.push(new URL(route.request().url()).pathname)
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' })
    })

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('html[data-hydrated="1"]')
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('[data-dashboard-gate="denied"]')).toBeVisible()
    await expect(page.locator('[data-admin-overview]')).toHaveCount(0)
    expect(adminRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((m) => /hydrat/i.test(m))).toEqual([])
  })

  test('renders online admin overview, health, modules, i18n, system, and live theme switching', async ({
    page,
    consoleErrors,
    pageErrors,
  }) => {
    test.skip(test.info().project.name === 'dev', 'Tests the online (Authelia/session) gate; the dev server runs the local author mode, which has no such gate')
    const hydrationWarnings: string[] = []
    page.on('console', (m) => {
      if (/hydrat/i.test(m.text())) hydrationWarnings.push(m.text())
    })

    await page.context().route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          authenticated: true,
          user: { id: 'alice', name: 'Alice', email: 'alice@example.com' },
          roles: ['reader', 'admin'],
          groups: ['admins'],
          logoutUrl: 'https://auth.example.com/logout',
        }),
      }),
    )

    await useTheme(page, 'datasheet', 'light')
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('html[data-hydrated="1"]')
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')

    // 1. Overview: static totals + /api/admin/overview metrics; online is read only
    await expect(page.locator('.lec-dashboard')).toHaveAttribute('data-dashboard-readonly', '1')
    await expect(page.locator('[data-admin-overview] [data-admin-metric="users"]')).toHaveText('12')
    await expect(page.locator('[data-dashboard-tab]')).toHaveCount(9)
    await expect(page.locator('[data-dashboard-tab="languages"], [data-dashboard-tab="i18n"]')).toHaveCount(0)

    // 2. Runtime > health: /api/admin/health checks; the URL hash names page and tab
    await page.locator('[data-dashboard-tab="runtime"]').click()
    await page.locator('[data-dashboard-subtab="health"]').click()
    await expect(page).toHaveURL(/#runtime:health$/)
    const healthPane = page.locator('[data-dashboard-pane="runtime"] [data-runtime-health]')
    await expect(healthPane).toContainText('004_admin_views')
    await expect(healthPane).toContainText('dify')
    // the terminal log is local only: online it says why instead of showing lines
    await page.locator('[data-dashboard-subtab="logs"]').click()
    await expect(page.locator('[data-runtime-logs] [data-dashboard-unavailable="logs"]')).toBeVisible()
    await expect(page.locator('[data-log-term]')).toHaveCount(0)

    // 3. Look > theme: switch to reader live and back to datasheet (a reader preference, not a site write)
    await page.goto('/dashboard#look:theme', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await page.locator('[data-dashboard-theme-btn="reader"]').click()
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'reader')
    await page.locator('[data-dashboard-theme-btn="datasheet"]').click()
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'datasheet')

    // the overview follows the skin (prototype v3.4): datasheet lists the groups as a table (group, lectures, checks,
    // access, reader progress, expand); build and deployment has three rows (last build, content commit, deployment)
    await page.locator('[data-dashboard-tab="overview"]').click()
    await expect(page.locator('[data-overview-groups]')).toHaveAttribute('data-overview-layout', 'table')
    await expect(page.locator('[data-overview-gtable] thead th')).toHaveCount(6)
    await expect(page.locator('[data-overview-build-row]')).toHaveCount(3)
    await expect(page.locator('[data-overview-build] [data-dashboard-unavailable="deploy"]')).toBeVisible()
    await page.locator('[data-dashboard-tab="look"]').click()

    // 4. Look > modules shows the configured adapters; companion pages are read only (no editor, no save bar)
    await page.locator('[data-dashboard-subtab="modules"]').click()
    await expect(page.locator('[data-dashboard-pane="look"]')).toContainText('trusted-header')
    await page.locator('[data-dashboard-tab="companion"]').click()
    await expect(page.locator('[data-dashboard-pane="companion"] [contenteditable="true"]')).toHaveCount(0)
    await expect(page.locator('[data-savebar]')).toHaveCount(0)
    await page.locator('[data-dashboard-tab="texts"]').click()
    await expect(page.locator('[data-dashboard-pane="texts"] input:not([disabled]):not([readonly]), [data-dashboard-pane="texts"] [contenteditable="true"]')).toHaveCount(0)

    // 5. English route /en/dashboard loads cleanly too
    await page.goto('/en/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('html[data-hydrated="1"]')
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('.db-title')).toContainText('Dashboard')

    expect(hydrationWarnings).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((m) => !m.includes('503'))).toEqual([])
  })
})
