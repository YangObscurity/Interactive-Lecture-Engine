/**
 * site/tests/e2e/site-texts.spec.ts
 *
 * E2E tests for WP-F10:
 *   1. Home page title, tagline, and meta description in both zh and en locales.
 *   2. Phone short title (.site-title-short) visible on < 768 px and .site-title-full hidden;
 *      desktop shows .site-title-full and hides .site-title-short.
 *   3. Dashboard "站点文案 / Site texts" tab: hints as placeholders, empty-field rules, a required name,
 *      a round-trip change in the dev project; dev-only note in the prod project.
 */
import path from 'node:path'
import { test, expect, gotoAndSettle, SITE_ROOT } from './fixtures'
import { SITE_TEXT_HINTS } from '../../docs/.vitepress/site-texts-schema.ts'
import { loadSiteTexts } from '../../docs/.vitepress/site-texts.mts'

// the texts of the site under test: the engine's demo content (templates/demo-content/site-texts.json, what build:e2e
// builds), read at test time so the test carries no site's wording
const T = loadSiteTexts({ siteDir: path.join(SITE_ROOT, '..', 'templates', 'demo-content') })
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

test.describe('WP-F10: Site texts and branding', () => {
  test('home page and meta description show approved texts in zh-CN', async ({ page }) => {
    await gotoAndSettle(page, '/')

    // Document title
    await expect(page).toHaveTitle(re(T.zh.name))

    // Meta description
    const metaDesc = page.locator('meta[name="description"]')
    await expect(metaDesc).toHaveAttribute('content', T.zh.description)

    // Hub hero title & tagline
    const heroTitle = page.locator('.hub-title')
    await expect(heroTitle).toHaveText(T.zh.navText)
    const heroTagline = page.locator('.hub-tagline')
    await expect(heroTagline).toHaveText(T.zh.tagline)

    // Verify AI marketing slogans are absent
    const bodyText = await page.innerText('body')
    expect(bodyText).not.toContain('全景演进架构')
    expect(bodyText).not.toContain('沉浸式')
    expect(bodyText).not.toContain('全景超清长图')
    await expect(page.locator('.hub-pill')).toHaveCount(0)
  })

  test('home page and meta description show approved texts in en', async ({ page }) => {
    await gotoAndSettle(page, '/en/')

    // Document title
    await expect(page).toHaveTitle(re(T.en.name))

    // Meta description
    const metaDesc = page.locator('meta[name="description"]')
    await expect(metaDesc).toHaveAttribute(
      'content',
      T.en.description,
    )

    // Hub hero title & tagline
    const heroTitle = page.locator('.hub-title')
    await expect(heroTitle).toHaveText(T.en.navText)
    const heroTagline = page.locator('.hub-tagline')
    await expect(heroTagline).toHaveText(T.en.tagline)
  })

  test('phone short title shows on viewport < 768 px (390 px) and desktop on 1280 px', async ({ page }) => {
    // 1. Mobile viewport (390 px)
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAndSettle(page, '/')

    const shortTitleZh = page.locator('.site-title-short')
    const fullTitleZh = page.locator('.site-title-full')
    await expect(shortTitleZh).toBeVisible()
    await expect(shortTitleZh).toHaveText(T.zh.shortName)
    await expect(fullTitleZh).toBeHidden()

    // Switch to English on mobile
    await gotoAndSettle(page, '/en/')
    const shortTitleEn = page.locator('.site-title-short')
    const fullTitleEn = page.locator('.site-title-full')
    await expect(shortTitleEn).toBeVisible()
    await expect(shortTitleEn).toHaveText(T.en.shortName)
    await expect(fullTitleEn).toBeHidden()

    // 2. Desktop viewport (1280 px)
    await page.setViewportSize({ width: 1280, height: 800 })
    await gotoAndSettle(page, '/')
    await expect(page.locator('.site-title-full')).toBeVisible()
    await expect(page.locator('.site-title-short')).toBeHidden()
  })

  test('Dashboard texts tab shows dev-only note on prod', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod', 'prod-only check')

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

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')

    await page.locator('[data-dashboard-tab="texts"]').click()
    const pane = page.locator('[data-dashboard-pane="texts"]')
    await expect(pane).toBeVisible()
    // v3.4 lock line: online is read only, edits happen on the local dev server
    await expect(pane).toContainText('开发服务器')
  })

  test('Dashboard texts page: hints, empty-field rules and the required name (dev project)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'dev', 'dev-only check')

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await page.locator('[data-dashboard-tab="texts"]').click()

    // the hint is the input's placeholder, per field and locale; it is never a value
    for (const [locale, field] of [['zh', 'tagline'], ['en', 'tagline'], ['zh', 'name']] as const) {
      if (locale === 'en') await page.locator('[data-texts-locale="en"]').click()
      else await page.locator('[data-texts-locale="zh"]').click()
      const input = page.locator(`[data-texts-input="${locale}.${field}"]`)
      await expect(input).toHaveAttribute('placeholder', SITE_TEXT_HINTS[locale][field])
      await expect(input).not.toHaveValue(SITE_TEXT_HINTS[locale][field])
    }

    // an emptied optional field says "未填写" and its rule; it can be saved
    await page.locator('[data-texts-locale="zh"]').click()
    await page.locator('[data-texts-input="zh.tagline"]').fill('')
    const rule = page.locator('[data-texts-rule="zh.tagline"]')
    await expect(rule).toContainText('未填写')
    await expect(rule).toContainText('留空：首页不显示标语')
    await expect(page.locator('[data-texts-errors]')).toHaveCount(0)
    await expect(page.locator('[data-texts-save-btn]')).toBeEnabled()

    // an emptied name is required: the error says so and saving is blocked
    await page.locator('[data-texts-input="zh.name"]').fill('')
    await expect(page.locator('[data-texts-errors]')).toContainText('必填')
    await expect(page.locator('[data-texts-save-btn]')).toBeDisabled()
    // nothing was saved: leave the page without touching the file
  })

  test('Dashboard texts page round-trips a change in dev project', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'dev', 'dev-only check')

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')

    await page.locator('[data-dashboard-tab="texts"]').click()
    await expect(page.locator('[data-dashboard-pane="texts"]')).toBeVisible()

    await page.locator('[data-texts-locale="en"]').click()
    const enShortInput = page.locator('[data-texts-input="en.shortName"]')
    const original = await enShortInput.inputValue()
    expect(original).not.toBe('')
    const changed = `${original} Test`
    const saveBtn = page.locator('[data-texts-save-btn]')
    const feedback = page.locator('[data-texts-feedback]')

    try {
      await enShortInput.fill(changed)
      // v3.4: the diff shows on "preview changes" in the save bar, not by itself
      await page.locator('[data-texts-preview]').click()
      const diffTable = page.locator('[data-texts-diff-table]')
      await expect(diffTable).toBeVisible()
      await expect(diffTable).toContainText('en.shortName')
      await expect(diffTable).toContainText(changed)

      await expect(saveBtn).toBeEnabled()
      await saveBtn.click()
      await expect(feedback).toContainText('站点文案已保存')
      await expect(page.locator('[data-texts-diff-none]')).toBeVisible()
    } finally {
      // restore the original text through the same page, whatever happened above
      await enShortInput.fill(original)
      if (await saveBtn.isEnabled()) await saveBtn.click()
    }
    await expect(page.locator('[data-texts-diff-none]')).toBeVisible()
  })
})
