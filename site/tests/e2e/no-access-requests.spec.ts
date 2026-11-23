/**
 * P3b: this site's config has no restricted tier, so the client must never ask for `/_access/...`: not on the home page,
 * not on a group page, not on a lecture page with charts, not when the search box builds its index.
 */
import { test, expect, gotoAndSettle } from './fixtures'

test('no request to /_access/ on a site without restricted tiers', async ({ page, pageErrors }) => {
  const seen: string[] = []
  page.on('request', (r) => seen.push(r.url()))

  await gotoAndSettle(page, '/')
  await gotoAndSettle(page, '/mea/')
  await gotoAndSettle(page, '/mea/L03')
  // open the search box and search: this loads the split title + shard index
  await page.locator('.VPNavBarSearch button, #local-search button').first().click()
  // on a group page the panel opens scoped to that group; "关键路径" lives elsewhere (demo group PLN)
  await page.locator('.sp-scope-btn').first().click()
  await page.locator('#lec-search-input').fill('关键路径')
  await expect(page.locator('.sp-hit').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForLoadState('networkidle').catch(() => {})

  expect(seen.some((u) => u.includes('/search/root/titles.json')), 'the split title search index was loaded').toBe(true)
  expect(seen.some((u) => u.includes('@localSearchIndex')), 'the legacy monolithic search chunk is gone').toBe(false)
  expect(seen.filter((u) => u.includes('/_access/'))).toEqual([])
  expect(pageErrors).toEqual([])
})
