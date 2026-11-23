/**
 * P2d i18n (plan_v2_p2d_i18n.md 3.4 / 3.6 / 5): the reader's experience of the English side.
 *
 *   1. /en/: <html lang="en">, English hero and nav, no reading mode (even when the flag is stored);
 *   2. /en/g01/: group page, "Translated 0 / M", every row links to the Chinese original and carries the badge
 *      (translated rows are covered by tests/unit/lang-links.test.ts: the only translated lecture is the example
 *      group, which is not in this site's course groups, so it has no group page);
 *   3. /en/examples/g01/L01: English lecture; hreflang only exists when the build had SITE_URL;
 *   4. language switcher: target per page kind, real href, click stores the reader-language preference;
 *   5. hint on root-language lectures: untranslated / available variants, "Continue in Chinese";
 *   6. reading progress is shared between a lecture and its translation (prefix-free key);
 *   7. English search index: English words hit under /en/, Chinese words do not;
 *   8. no hydration warnings and no console errors on the three English pages.
 *
 * Needs the prod build (`npm run build`) of a site with English enabled and the example translation in place.
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

const PREF_KEY = 'lecture-reader-lang'
const CJK = /[㐀-鿿]/

/** Store the reader-language preference without leaving a page that would overwrite it. */
async function setPref(page: Page, value: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [PREF_KEY, value])
}

const pref = (page: Page) => page.evaluate((k) => localStorage.getItem(k), PREF_KEY)

/** The language switcher link in the top bar (the mobile-screen copy only exists while the menu is open). */
const switchLink = (page: Page) => page.locator('.VPNavBar a.lang-switch-link')

test.describe('i18n: English home', () => {
  test('/en/ is English: lang attribute, hero, nav (the switcher shows the other language by its own name)', async ({ page }) => {
    await gotoAndSettle(page, '/en/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    // hero title / tagline come from the site data: they are English only when SITE_META carries `i18n.en`
    // (the private groups.mts of this site may not), so only check they are there; headings are dictionary text
    expect((await page.locator('h1.hub-title').innerText()).trim().length).toBeGreaterThan(0)
    await expect(page.locator('#groups .hb-h2')).toHaveText('Course overview')
    await expect(page.locator('.hub-stats-strip .stat-label').first()).not.toHaveText(CJK)
    // the course-group count is a number, not text baked into the sentence
    await expect(page.locator('#groups .hb-section-subtitle')).toContainText(/^\d+ course groups/)
    // nav chrome is dictionary text: top-level menu labels and the search button have no Chinese
    // (the site name and the group titles inside the dropdown are data and stay Chinese without `i18n.en`)
    const menu = await page.locator('.VPNavBarMenu > a, .VPNavBarMenuGroup > button, .VPNavBarSearch button').allInnerTexts()
    expect(menu.join(' ').trim().length).toBeGreaterThan(0)
    expect(menu.join(' ')).not.toMatch(CJK)
    await expect(page.locator('.VPNavBarMenu')).toContainText('Overview')
    await expect(page.locator('.VPNavBarMenu')).toContainText('Courses')
    // course cards link to the English group pages
    const hrefs = await page.locator('#groups a[data-slot="GroupCard"]').evaluateAll((els) => els.map((e) => e.getAttribute('href')))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const h of hrefs) expect(h).toMatch(/^\/en\/.+\/$/)
  })

  test('/en/ never enters reading mode, even with the flag stored', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('lecture-reading-mode', '1'))
    await gotoAndSettle(page, '/en/')
    await expect(page.locator('html')).not.toHaveClass(/reading-mode/)
    await expect(page.locator('.reading-mode-nav-btn')).toHaveCount(0)
  })
})

test.describe('i18n: English group page', () => {
  test('/en/g01/ counts translated lectures and links untranslated ones to the original', async ({ page }) => {
    await gotoAndSettle(page, '/en/g01/')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const rows = page.locator('.gp-lanes a[data-lecture]')
    const m = await rows.count()
    expect(m).toBeGreaterThan(0)
    await expect(page.locator('.gp-translated')).toHaveText(`Translated 0 / ${m} lectures`)
    const hrefs = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('href')))
    for (const h of hrefs) expect(h).toMatch(/^\/g01\/L\d+$/)
    await expect(page.locator('.gp-lanes .gp-lang')).toHaveCount(m)
    await expect(page.locator('.gp-lanes .gp-lang').first()).toHaveText('中文')
    await expect(page.locator('.gp-lanes .gp-lang').first()).toHaveAttribute('title', /original/i)
    // the start button follows the same rule
    await expect(page.locator('a[data-gp-cta="start"]')).toHaveAttribute('href', /^\/g01\/L\d+$/)
  })

  test('the Chinese group page has no translated-count line and no badge', async ({ page }) => {
    await gotoAndSettle(page, '/g01/')
    await expect(page.locator('.gp-translated')).toHaveCount(0)
    await expect(page.locator('.gp-lang')).toHaveCount(0)
  })
})

test.describe('i18n: English lecture', () => {
  test('/en/examples/g01/L01 is English; hreflang exists only when the build had SITE_URL', async ({ page, request }) => {
    await gotoAndSettle(page, '/en/examples/g01/L01')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    expect((await page.locator('.vp-doc h1').first().innerText()).trim()).not.toMatch(CJK)
    // the export button needs root-language asset paths: not offered on translated pages
    await expect(page.locator('.lecture-export-wrapper')).toHaveCount(0)
    const sitemap = await request.get('/sitemap.xml')
    const hreflang = await page.locator('head link[rel="alternate"][hreflang]').count()
    if (sitemap.status() === 404) expect(hreflang).toBe(0)
    else expect(hreflang).toBeGreaterThan(0)
  })
})

test.describe('i18n: language switcher', () => {
  test('target depends on the page kind and is a real link', async ({ page }) => {
    // lecture with a translation -> the translation
    await gotoAndSettle(page, '/examples/g01/L01')
    await expect(switchLink(page)).toHaveCount(1)
    await expect(switchLink(page)).toHaveText('English')
    await expect(switchLink(page)).toHaveAttribute('href', '/en/examples/g01/L01')
    // lecture without one -> the group page of that language
    await gotoAndSettle(page, '/g01/L01')
    await expect(switchLink(page)).toHaveAttribute('href', '/en/g01/')
    // group page -> same group; home -> home
    await gotoAndSettle(page, '/g01/')
    await expect(switchLink(page)).toHaveAttribute('href', '/en/g01/')
    await gotoAndSettle(page, '/')
    await expect(switchLink(page)).toHaveAttribute('href', '/en/')
    // back from English: translation -> original lecture, home -> home
    await gotoAndSettle(page, '/en/examples/g01/L01')
    await expect(switchLink(page)).toHaveText('中文')
    await expect(switchLink(page)).toHaveAttribute('href', '/examples/g01/L01')
    await gotoAndSettle(page, '/en/')
    await expect(switchLink(page)).toHaveAttribute('href', '/')
  })

  test('the link is in the server-rendered HTML (works without JS)', async ({ request }) => {
    const html = await (await request.get('/g01/L01')).text()
    expect(html).toMatch(/class="lang-switch-link"[^>]*href="\/en\/g01\/"|href="\/en\/g01\/"[^>]*class="lang-switch-link"/)
  })

  test('clicking stores the reader-language preference', async ({ page }) => {
    await gotoAndSettle(page, '/g01/L01')
    expect(await pref(page)).toBeNull()
    await switchLink(page).click()
    await expect(page).toHaveURL(/\/en\/g01\/$/)
    expect(await pref(page)).toBe('en')
    await switchLink(page).click()
    await expect(page).toHaveURL(/\/g01\/$/)
    await expect(page).not.toHaveURL(/\/en\//)
    expect(await pref(page)).toBe('zh-CN')
  })

  test('any English page stores the preference when it is shown', async ({ page }) => {
    await gotoAndSettle(page, '/en/g01/')
    await expect.poll(() => pref(page)).toBe('en')
  })
})

test.describe('i18n: hint on Chinese lectures', () => {
  test('untranslated lecture: note, link back to the English course page, "Continue in Chinese" is remembered', async ({ page }) => {
    await setPref(page, 'en')
    await gotoAndSettle(page, '/g01/L01')
    const hint = page.locator('aside.lang-hint')
    await expect(hint).toHaveAttribute('data-lang-hint', 'untranslated')
    await expect(hint).toHaveAttribute('lang', 'en')
    await expect(hint).toContainText('has not been translated into English yet')
    await expect(hint.locator('a')).toHaveAttribute('href', '/en/g01/')
    await expect(hint.locator('a')).toHaveText('Back to the English course page')
    await hint.getByRole('button', { name: 'Continue in Chinese' }).click()
    await expect(hint).toHaveCount(0)
    expect(await pref(page)).toBe('zh-CN')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle').catch(() => {})
    await expect(page.locator('aside.lang-hint')).toHaveCount(0)
  })

  test('translated lecture: "available in English" with a link to it', async ({ page }) => {
    await setPref(page, 'en')
    await gotoAndSettle(page, '/examples/g01/L01')
    const hint = page.locator('aside.lang-hint')
    await expect(hint).toHaveAttribute('data-lang-hint', 'available')
    await expect(hint).toContainText('This lecture is available in English.')
    await expect(hint.locator('a')).toHaveText('Read in English')
    await expect(hint.locator('a')).toHaveAttribute('href', '/en/examples/g01/L01')
  })

  test('no note without a stored preference, on the group page or on English pages', async ({ page }) => {
    await gotoAndSettle(page, '/g01/L01')
    await expect(page.locator('aside.lang-hint')).toHaveCount(0)
    await setPref(page, 'en')
    await gotoAndSettle(page, '/g01/')
    await expect(page.locator('aside.lang-hint')).toHaveCount(0)
    await gotoAndSettle(page, '/en/examples/g01/L01')
    await expect(page.locator('aside.lang-hint')).toHaveCount(0)
  })
})

test.describe('i18n: shared reading progress', () => {
  test('scrolling /en/examples/g01/L01 records progress under the prefix-free path', async ({ page }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 1280, height: 800 })
    await gotoAndSettle(page, '/en/examples/g01/L01')
    await page.mouse.move(640, 400)
    const target = await page.evaluate(() => Math.round((document.documentElement.scrollHeight - innerHeight) * 0.5))
    for (let i = 0; i < 200; i++) {
      const y = await page.evaluate(() => scrollY)
      if (y >= target) break
      await page.mouse.wheel(0, Math.min(1200, target - y))
    }
    await expect
      .poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('lecture-read-pos') || '{}'))))
      .toContain('/examples/g01/L01')
    const keys = await page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('lecture-read-pos') || '{}')))
    expect(keys.filter((k) => k.startsWith('/en'))).toEqual([])
  })
})

test.describe('i18n: English search', () => {
  test('English words hit /en/ pages; Chinese words from Chinese lectures do not', async ({ page }) => {
    await gotoAndSettle(page, '/en/')
    await page.locator('.VPNavBarSearch button').first().click()
    const input = page.locator('#lec-search-input')
    await input.fill('resistor')
    const hits = page.locator('.sp-res a.sp-hit')
    await expect(hits.first()).toBeVisible({ timeout: 20_000 })
    const hrefs = await hits.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))
    expect(hrefs.length).toBeGreaterThan(0)
    for (const h of hrefs) expect(h).toMatch(/^\/en\//)
    await input.fill('电阻')
    await expect(page.locator('.sp-res .sp-empty')).toBeVisible({ timeout: 20_000 })
    await expect(hits).toHaveCount(0)
  })
})

test.describe('i18n: clean loads', () => {
  for (const url of ['/en/', '/en/g01/', '/en/examples/g01/L01']) {
    test(`${url}: no hydration warnings, no console errors`, async ({ page, consoleErrors, pageErrors }) => {
      const warnings: string[] = []
      page.on('console', (m) => {
        if (/hydration/i.test(m.text())) warnings.push(m.text())
      })
      await gotoAndSettle(page, url)
      expect(warnings).toEqual([])
      // the e2e fixtures answer unknown /api calls with 503; the browser logs those as resource errors
      const real = consoleErrors.filter((t) => !/Failed to load resource/i.test(t))
      expect(real).toEqual([])
      expect(pageErrors.map((e) => e.message)).toEqual([])
    })
  }
})
