/**
 * P6.5 + WP-5 Dashboard E2E: `/dashboard` and `/en/dashboard` in online RBAC mode.
 *
 * Verifies:
 *   1. Reader sessions (`roles: ['reader']`) get strictly `my-learning` + `account`, never trigger `/api/admin/*`,
 *      and direct hashes to admin pages are redirected.
 *   2. Admin sessions (`roles: ['reader', 'admin']`) get all 13 Dashboard pages with online editing enabled
 *      (`data-dashboard-readonly="0"`), `/api/admin/overview`, `/api/admin/health`, online runtime logs, live theme
 *      switching, editable companion/texts, and no console/page errors or hydration warnings.
 */
import { expect, test } from './fixtures'
import { useTheme } from './theme-helpers'

test.describe('P6.5 Lecture Dashboard (/dashboard)', () => {
  test('isolates reader role to personal tabs without requesting /api/admin/*', async ({ page, consoleErrors, pageErrors }) => {
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
    await page.context().route('**/api/me/**', (route) => {
      const p = new URL(route.request().url()).pathname
      if (p.endsWith('/overview')) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            user: { id: 'bob', username: 'bob', displayName: 'Bob', email: 'bob@example.com' },
            authMethod: 'gateway',
            rememberMe: false,
            passkeyCount: 0,
            progress: { total: 0, completed: 0, in_progress: 0, not_started: 0 },
            checklists: { total: 0, completed: 0 },
            recentSessions: [],
          }),
        })
      }
      if (p.endsWith('/credentials')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, credentials: [] }) })
      }
      if (p.endsWith('/sessions')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sessions: [] }) })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })
    await page.context().route('**/api/admin/*', (route) => {
      adminRequests.push(new URL(route.request().url()).pathname)
      return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' })
    })

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('html[data-hydrated="1"]')
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('.lec-dashboard')).toHaveAttribute('data-dashboard-readonly', '0')
    await expect(page.locator('[data-dashboard-tab]')).toHaveCount(2)
    await expect(page.locator('[data-dashboard-tab="my-learning"]')).toBeVisible()
    await expect(page.locator('[data-dashboard-tab="account"]')).toBeVisible()
    await expect(page.locator('[data-admin-overview]')).toHaveCount(0)

    await page.goto('/dashboard#database', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('[data-dashboard-pane="my-learning"]')).toBeVisible()

    expect(adminRequests).toEqual([])
    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((m) => /hydrat/i.test(m))).toEqual([])
  })

  test('renders online admin overview, health, logs, editable authoring, and live theme switching', async ({
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
    await page.context().route('**/api/admin/logs*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          ok: true,
          logs: [
            {
              id: 'log-1',
              timestamp: '2026-11-25T00:00:00.000Z',
              level: 'info',
              category: 'admin',
              message: 'E2E admin log entry',
            },
          ],
        }),
      }),
    )

    await useTheme(page, 'datasheet', 'light')
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('html[data-hydrated="1"]')
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')

    // 1. Overview: static totals + /api/admin/overview metrics; online admins can write (WP-5)
    await expect(page.locator('.lec-dashboard')).toHaveAttribute('data-dashboard-readonly', '0')
    await expect(page.locator('[data-admin-overview] [data-admin-metric="users"]')).toHaveText('12')
    await expect(page.locator('[data-dashboard-tab]')).toHaveCount(13)
    await expect(page.locator('[data-dashboard-tab="languages"], [data-dashboard-tab="i18n"]')).toHaveCount(0)

    // 2. Runtime > health & online logs viewer
    await page.locator('[data-dashboard-tab="runtime"]').click()
    await page.locator('[data-dashboard-subtab="health"]').click()
    await expect(page).toHaveURL(/#runtime:health$/)
    const healthPane = page.locator('[data-dashboard-pane="runtime"] [data-runtime-health]')
    await expect(healthPane).toContainText('004_admin_views')
    await expect(healthPane).toContainText('dify')
    await page.locator('[data-dashboard-subtab="logs"]').click()
    await expect(page.locator('[data-runtime-online-logs]')).toBeVisible()
    await expect(page.locator('[data-online-log-category]')).toBeVisible()

    // 3. Look > theme: switch to reader live and back to datasheet
    await page.goto('/dashboard#look:theme', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await page.locator('[data-dashboard-theme-btn="reader"]').click()
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'reader')
    await page.locator('[data-dashboard-theme-btn="datasheet"]').click()
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'datasheet')

    // Overview datasheet layout
    await page.locator('[data-dashboard-tab="overview"]').click()
    await expect(page.locator('[data-overview-groups]')).toHaveAttribute('data-overview-layout', 'table')
    await expect(page.locator('[data-overview-gtable] thead th')).toHaveCount(6)
    await expect(page.locator('[data-overview-build-row]')).toHaveCount(3)
    await expect(page.locator('[data-overview-build] [data-dashboard-unavailable="deploy"]')).toBeVisible()
    await page.locator('[data-dashboard-tab="look"]').click()

    // 4. Look > modules shows the configured adapters; companion and texts are online-editable for admin
    await page.locator('[data-dashboard-subtab="modules"]').click()
    await expect(page.locator('[data-dashboard-pane="look"]')).toContainText('trusted-header')
    await page.locator('[data-dashboard-tab="companion"]').click()
    expect(await page.locator('[data-dashboard-pane="companion"] [contenteditable="true"]').count()).toBeGreaterThan(0)
    await page.locator('[data-dashboard-tab="texts"]').click()
    expect(await page.locator('[data-dashboard-pane="texts"] input:not([disabled]):not([readonly])').count()).toBeGreaterThan(0)

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
