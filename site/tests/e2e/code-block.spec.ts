/**
 * tests/e2e/code-block.spec.ts — Spec Board §09 persistent code block header bar.
 *
 * Requirements:
 * - Persistent top bar (.code-head) on .vp-doc div[class*='language-'] (not hover-only, not overlapping first line of code);
 * - Left side shows language name, right side shows visible copy button;
 * - Works on click: copies text to clipboard and toggles feedback ("已复制" / "Copied");
 * - Works in both reader/datasheet skins & light/dark modes;
 * - Mobile 390px viewport fits without horizontal overflow;
 * - Survives SPA navigation without duplicate headers or lost click delegation;
 * - Copy button is hidden under print media.
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

const LECTURE = '/mea/L04'
const OTHER_LECTURE = '/dat/L03'

type Look = { skin: 'reader' | 'datasheet'; dark: boolean }
const LOOKS: Look[] = [
  { skin: 'reader', dark: false },
  { skin: 'reader', dark: true },
  { skin: 'datasheet', dark: false },
  { skin: 'datasheet', dark: true },
]

async function setLook(page: Page, look: Look): Promise<void> {
  await page.evaluate(({ skin, dark }) => {
    const html = document.documentElement
    html.setAttribute('data-lec-theme', skin)
    html.classList.toggle('dark', dark)
  }, look)
  await page.waitForTimeout(100)
}

async function spaGo(page: Page, path: string): Promise<void> {
  await page.evaluate((href) => {
    const a = document.createElement('a')
    a.href = href
    document.body.appendChild(a)
    a.click()
    a.remove()
  }, path)
  await page.waitForURL((u) => u.pathname.replace(/\.html$/, '') === path)
  await expect(page.locator('.vp-doc')).toBeVisible()
}

test.describe('code block persistent header (Spec Board §09)', () => {
  test('persistent code header renders with language name + visible copy button without hover', async ({ page }) => {
    await gotoAndSettle(page, LECTURE)

    const block = page.locator('.vp-doc div[class*="language-"]').first()
    await expect(block).toBeVisible()

    const head = block.locator(':scope > .code-head')
    await expect(head).toBeVisible()

    const lang = head.locator('.code-lang')
    await expect(lang).toBeVisible()
    await expect(lang).toHaveText(/python/i)

    const btn = head.locator('button[data-copy]')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveText('复制')

    // VitePress default floating hover elements must be hidden
    await expect(block.locator(':scope > button.copy')).toBeHidden()
    await expect(block.locator(':scope > span.lang')).toBeHidden()
  })

  test('code header does not overlap the first line of code', async ({ page }) => {
    await gotoAndSettle(page, LECTURE)

    const block = page.locator('.vp-doc div[class*="language-"]').first()
    const head = block.locator(':scope > .code-head')
    const pre = block.locator('pre')
    const firstLine = block.locator('pre code span.line').first()

    const headBox = await head.boundingBox()
    const preBox = await pre.boundingBox()
    const firstLineBox = await firstLine.boundingBox()

    expect(headBox).not.toBeNull()
    expect(preBox).not.toBeNull()
    expect(firstLineBox).not.toBeNull()

    if (headBox && preBox && firstLineBox) {
      // Header bottom must be at or above pre top and the first code line top
      expect(headBox.y + headBox.height).toBeLessThanOrEqual(preBox.y + 1)
      expect(headBox.y + headBox.height).toBeLessThanOrEqual(firstLineBox.y)
    }
  })

  test('clicking copy button copies code text and displays feedback', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await gotoAndSettle(page, LECTURE)

    const block = page.locator('.vp-doc div[class*="language-"]').first()
    const btn = block.locator('.code-head button[data-copy]')

    await expect(btn).toHaveText('复制')
    await btn.click()

    await expect(btn).toHaveClass(/copied/)
    await expect(btn).toHaveText('已复制')

    const clipText = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipText).toContain('xs = [9.8, 10.1, 10.0, 9.9, 10.2]')

    // Reverts after FEEDBACK_MS (~1500 ms)
    await expect(btn).toHaveText('复制', { timeout: 3500 })
    await expect(btn).not.toHaveClass(/copied/)
  })

  test('persistent header works in reader and datasheet skins in both light and dark modes', async ({ page }) => {
    await gotoAndSettle(page, LECTURE)
    const block = page.locator('.vp-doc div[class*="language-"]').first()
    const head = block.locator(':scope > .code-head')
    const btn = head.locator('button[data-copy]')
    const lang = head.locator('.code-lang')

    for (const look of LOOKS) {
      await setLook(page, look)
      await expect(head, `${look.skin} ${look.dark ? 'dark' : 'light'}`).toBeVisible()
      await expect(btn, `${look.skin} ${look.dark ? 'dark' : 'light'}`).toBeVisible()
      await expect(lang, `${look.skin} ${look.dark ? 'dark' : 'light'}`).toBeVisible()
      await expect(lang).toHaveText(/python/i)
    }
  })

  test('mobile 390px: code block and header fit without horizontal page overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAndSettle(page, LECTURE)

    const block = page.locator('.vp-doc div[class*="language-"]').first()
    await expect(block).toBeVisible()

    const head = block.locator(':scope > .code-head')
    await expect(head).toBeVisible()

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow).toBeLessThanOrEqual(0)

    const headBox = await head.boundingBox()
    expect(headBox).not.toBeNull()
    if (headBox) {
      expect(headBox.x).toBeGreaterThanOrEqual(0)
      expect(headBox.x + headBox.width).toBeLessThanOrEqual(390.5)
    }
  })

  test('survives SPA navigation without duplicate headers and keeps copy functionality', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await gotoAndSettle(page, LECTURE)

    // Step 1: initial page has exactly 1 header per code block
    const block1 = page.locator('.vp-doc div[class*="language-"]').first()
    await expect(block1.locator(':scope > .code-head')).toHaveCount(1)

    // Step 2: SPA navigate to second lecture
    await spaGo(page, OTHER_LECTURE)
    const block2 = page.locator('.vp-doc div[class*="language-"]').first()
    await expect(block2.locator(':scope > .code-head')).toHaveCount(1)

    // Test copy on second lecture
    const btn2 = block2.locator('.code-head button[data-copy]')
    await btn2.click()
    await expect(btn2).toHaveClass(/copied/)
    await expect(btn2).toHaveText('已复制')

    // Step 3: SPA navigate back to initial lecture
    await spaGo(page, LECTURE)
    const blockReturned = page.locator('.vp-doc div[class*="language-"]').first()
    // Verify no duplicate headers were mounted
    await expect(blockReturned.locator(':scope > .code-head')).toHaveCount(1)

    // Verify copy still works after route change round-trip
    const btnReturned = blockReturned.locator('.code-head button[data-copy]')
    await btnReturned.click()
    await expect(btnReturned).toHaveClass(/copied/)
    await expect(btnReturned).toHaveText('已复制')
  })

  test('copy button is hidden under print media', async ({ page }) => {
    await gotoAndSettle(page, LECTURE)

    const btn = page.locator('.vp-doc div[class*="language-"] .code-head button[data-copy]').first()
    await expect(btn).toBeVisible()

    await page.emulateMedia({ media: 'print' })
    await expect(btn).toBeHidden()

    await page.emulateMedia({ media: 'screen' })
    await expect(btn).toBeVisible()
  })
})
