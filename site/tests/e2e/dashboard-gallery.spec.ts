import { test, expect, gotoAndSettle } from './fixtures'

test.describe('WP-F8: Dashboard Gallery (图库) read-only view, filters & lightbox', () => {
  test('displays metrics, filters by group/paper/state/search, and opens view-only metadata lightbox', async ({
    page,
    pageErrors,
  }, testInfo) => {
    // Wait: /dashboard is excluded from prod when auth.adapter === 'none' unless LECTURE_DASHBOARD_BUILD=1;
    // detect gracefully whether /dashboard built or test directly on dev + mock online fallback in route!
    const targetUrl = testInfo.project.name === 'prod' ? '/dashboard' : '/dashboard'
    if (testInfo.project.name === 'prod') {
      // Check if /dashboard exists in current prod build (e.g. skip only if dist excluded dashboard.html by config)
      const res = await page.request.get('/dashboard.html').catch(() => null)
      const resClean = await page.request.get('/dashboard').catch(() => null)
      if ((res?.status() ?? 404) === 404 && (resClean?.status() ?? 404) === 404) {
        test.skip(true, 'dashboard.html excluded in auth.adapter=none prod build')
        return
      }
    }

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

    await page.setViewportSize({ width: 1280, height: 860 })
    await gotoAndSettle(page, targetUrl)
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')

    // v3.4: the gallery is the first tab of the page "figures and concepts"
    const figuresPage = page.locator('[data-dashboard-tab="figures"]')
    await expect(figuresPage).toBeVisible()
    await figuresPage.click()
    await page.locator('[data-dashboard-subtab="gallery"]').click()
    await expect(page).toHaveURL(/#figures(:gallery)?$/)

    const panel = page.locator('[data-gallery-panel]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-gallery-card]').first()).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(() =>
        panel.locator('[data-gallery-card="pareto-fronts"] img').evaluate((el: HTMLImageElement) => el.naturalWidth),
      )
      .toBeGreaterThan(0)

    // Verify the 3 key stats show real counts (10 total: 9 LR + 1 example); no licence card or filter
    const total = Number(await panel.locator('[data-gallery-stat="total"] .db-stat-value').innerText())
    const uncited = Number(await panel.locator('[data-gallery-stat="uncited"] .db-stat-value').innerText())
    expect(total).toBeGreaterThanOrEqual(10)
    expect(uncited).toBeGreaterThanOrEqual(1)
    await expect(panel.locator('[data-gallery-stat]')).toHaveCount(3)
    await expect(panel.locator('[data-gallery-filter="state"] option')).toHaveCount(3)

    // Filter by state = uncited -> shows uncited figure(s) including esampling-signal
    await panel.locator('[data-gallery-filter="state"]').selectOption('uncited')
    await expect(panel.locator('[data-gallery-card="esampling-signal"]')).toBeVisible()
    await expect(panel.locator('[data-gallery-card="pareto-fronts"]')).toHaveCount(0)

    // Filter by state = all + text search -> finds pareto-fronts
    await panel.locator('[data-gallery-filter="state"]').selectOption('all')
    await panel.locator('[data-gallery-filter="search"]').fill('pareto')
    const paretoCard = panel.locator('[data-gallery-card="pareto-fronts"]')
    await expect(paretoCard).toBeVisible()
    await expect(panel.locator('[data-gallery-card]')).toHaveCount(1)

    // Click card -> opens read-only <dialog> lightbox with source, DOI, lectures, file/size (no licence row)
    await paretoCard.click()
    const lb = panel.locator('[data-gallery-lightbox]')
    await expect(lb).toBeVisible()
    await expect(lb).toContainText('Modran et al.')
    await expect(lb).toContainText('10.1109/CSCN67557.2025.11230707')
    await expect(lb).toContainText('/lr/L04')
    await expect(lb).toContainText('lr/L04/pareto-fronts.webp')
    await expect(lb.locator('dt')).toHaveCount(4)
    // No edit inputs inside view-only lightbox
    await expect(lb.locator('input, textarea')).toHaveCount(0)

    await lb.locator('[data-gallery-lb-close]').click()
    await expect(lb).toBeHidden()
    expect(pageErrors).toEqual([])
  })
})
