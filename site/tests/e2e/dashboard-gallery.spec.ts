import fs from 'node:fs'
import path from 'node:path'
import { test, expect, gotoAndSettle, SITE_ROOT } from './fixtures'

/**
 * S6: runs on the engine's demo content. The expected counts come from the gallery data the page shows (prod: the
 * file the build wrote, site/.e2e-demo/dist/figures-gallery.json; dev: the dev server's /__lecture/api/figures), the
 * card under test is the demo figure `mea-ruler` (figure pack figures/mea, used in /mea/L02).
 */
interface GalleryItem {
  group: string
  id: string
  file: string
  caption: { zh: string; en: string }
  source: { paper: string; number?: string }
  doi?: string
  usedIn: Array<{ route: string; title: string }>
}
const GALLERY_JSON = path.join(SITE_ROOT, '.e2e-demo', 'dist', 'figures-gallery.json')
const FIG_ID = 'mea-ruler'
const SEARCH = 'ruler'

/** The expectations from the gallery data the page under test shows: the prod build's file, or the dev server's API. */
function expected(items: GalleryItem[]) {
  return {
    ITEMS: items,
    FIG: items.find((it) => it.group === 'mea' && it.id === FIG_ID),
    UNCITED: items.filter((it) => it.usedIn.length === 0),
    SEARCH_HITS: items.filter((it) =>
      [it.id, it.file, it.caption.zh, it.caption.en, it.source.paper, it.source.number ?? '', it.doi ?? '']
        .join(' ')
        .toLowerCase()
        .includes(SEARCH),
    ),
  }
}

test.describe('WP-F8: Dashboard Gallery (图库) read-only view, filters & lightbox', () => {
  test('displays metrics, filters by group/paper/state/search, and opens view-only metadata lightbox', async ({
    page,
    pageErrors,
  }, testInfo) => {
    // Wait: /dashboard is excluded from prod when auth.adapter === 'none' unless LECTURE_DASHBOARD_BUILD=1;
    // detect gracefully whether /dashboard built or test directly on dev + mock online fallback in route!
    const targetUrl = '/dashboard'
    if (testInfo.project.name === 'prod') {
      // Check if /dashboard exists in current prod build (e.g. skip only if dist excluded dashboard.html by config)
      const res = await page.request.get('/dashboard.html').catch(() => null)
      const resClean = await page.request.get('/dashboard').catch(() => null)
      if ((res?.status() ?? 404) === 404 && (resClean?.status() ?? 404) === 404) {
        test.skip(true, 'dashboard.html excluded in auth.adapter=none prod build')
        return
      }
    }
    // preconditions (no vacuous pass): the gallery data holds the demo figure. prod shows the file the build wrote,
    // the dev server's Dashboard reads /__lecture/api/figures (built from the demo copy it runs on)
    let source = GALLERY_JSON
    let items: GalleryItem[] = []
    if (testInfo.project.name === 'dev') {
      source = '/__lecture/api/figures'
      const res = await page.request.get(source)
      expect(res.ok(), `${source} answers`).toBe(true)
      items = ((await res.json()) as { items?: GalleryItem[] }).items ?? []
    } else if (fs.existsSync(GALLERY_JSON)) {
      items = (JSON.parse(fs.readFileSync(GALLERY_JSON, 'utf8')) as { items?: GalleryItem[] }).items ?? []
    }
    const { ITEMS, FIG, UNCITED, SEARCH_HITS } = expected(items)
    expect(ITEMS.length, `${source} has items (prod: run npm run build:e2e)`).toBeGreaterThan(0)
    expect(FIG, `gallery data has the demo figure mea/${FIG_ID}`).toBeDefined()
    expect(FIG!.usedIn.length, `${FIG_ID} is cited by a lecture`).toBeGreaterThan(0)
    expect(SEARCH_HITS.map((it) => it.id)).toEqual([FIG_ID])

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
      .poll(() => panel.locator(`[data-gallery-card="${FIG_ID}"] img`).evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0)

    // The 3 key stats show the counts of the built gallery data; no licence card or filter
    await expect(panel.locator('[data-gallery-stat="total"] .db-stat-value')).toHaveText(String(ITEMS.length))
    await expect(panel.locator('[data-gallery-stat="cited"] .db-stat-value')).toHaveText(String(ITEMS.length - UNCITED.length))
    await expect(panel.locator('[data-gallery-stat="uncited"] .db-stat-value')).toHaveText(String(UNCITED.length))
    await expect(panel.locator('[data-gallery-stat]')).toHaveCount(3)
    await expect(panel.locator('[data-gallery-filter="state"] option')).toHaveCount(3)
    await expect(panel.locator('[data-gallery-card]')).toHaveCount(ITEMS.length)

    // Filter by state = uncited -> only the uncited figures; the cited demo figure is gone
    await panel.locator('[data-gallery-filter="state"]').selectOption('uncited')
    await expect(panel.locator('[data-gallery-card]')).toHaveCount(UNCITED.length)
    for (const it of UNCITED) await expect(panel.locator(`[data-gallery-card="${it.id}"]`)).toBeVisible()
    await expect(panel.locator(`[data-gallery-card="${FIG_ID}"]`)).toHaveCount(0)

    // Filter by state = cited -> the demo figure is back
    await panel.locator('[data-gallery-filter="state"]').selectOption('cited')
    await expect(panel.locator(`[data-gallery-card="${FIG_ID}"]`)).toBeVisible()
    await expect(panel.locator('[data-gallery-card]')).toHaveCount(ITEMS.length - UNCITED.length)

    // Filter by state = all + text search -> finds only the demo figure
    await panel.locator('[data-gallery-filter="state"]').selectOption('all')
    await panel.locator('[data-gallery-filter="search"]').fill(SEARCH)
    const card = panel.locator(`[data-gallery-card="${FIG_ID}"]`)
    await expect(card).toBeVisible()
    await expect(panel.locator('[data-gallery-card]')).toHaveCount(1)

    // Click card -> opens read-only <dialog> lightbox with source, DOI, lectures, file/size (no licence row)
    await card.click()
    const lb = panel.locator('[data-gallery-lightbox]')
    await expect(lb).toBeVisible()
    await expect(lb).toContainText(FIG!.caption.zh)
    await expect(lb).toContainText(FIG!.source.paper)
    if (FIG!.doi) await expect(lb).toContainText(FIG!.doi)
    for (const use of FIG!.usedIn) await expect(lb).toContainText(use.route)
    await expect(lb).toContainText(`mea/${FIG!.file}`)
    await expect(lb.locator('dt')).toHaveCount(4)
    // No edit inputs inside view-only lightbox
    await expect(lb.locator('input, textarea')).toHaveCount(0)

    await lb.locator('[data-gallery-lb-close]').click()
    await expect(lb).toBeHidden()
    expect(pageErrors).toEqual([])
  })
})
