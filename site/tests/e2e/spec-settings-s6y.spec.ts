/**
 * S6Y F6 (audit-spec #12 #14 #15 #16 #22 #27 #28, decisions in s6y/DECISIONS.md 2026-11-23 21:47):
 * reader settings defaults and wording, the localized 404 page, the companion header, VitePress' appearance switch,
 * and the phone top bar. Expected texts and sizes come from the spec board (V2 设计规格板.html).
 */
import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

const LECTURE = '/mea/L02'

/** Seed the reader prefs once (useTheme re-seeds on every navigation, which would undo a saved setting on reload). */
async function seedOnce(page: Page, theme: 'reader' | 'datasheet'): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
  await page.addInitScript((t) => {
    try {
      if (sessionStorage.getItem('s6y-seeded')) return
      sessionStorage.setItem('s6y-seeded', '1')
      localStorage.setItem('vitepress-theme-appearance', 'light')
      localStorage.setItem('lecture:reader-prefs', JSON.stringify({ theme: t }))
    } catch {
      /* ignore */
    }
  }, theme)
}

async function health(page: Page, ok: boolean): Promise<void> {
  await page.route(
    (u) => u.pathname === '/api/health',
    (route) =>
      ok
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, checks: { db: 'ok', ai: 'ok' } }) })
        : route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"down"}' }),
  )
}

test.describe('@s6y-f6 desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  for (const [theme, font] of [
    ['reader', 'sans'],
    ['datasheet', 'serif'],
  ] as const) {
    test(`#12 ${theme}: with no font saved, the highlighted body font is the one the text is set in (${font})`, async ({ page }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, LECTURE)
      await page.locator('[data-lec-settings-btn]').click()
      await expect(page.locator(`[data-lec-font-opt="${font}"]`)).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('[data-lec-font-opt][aria-pressed="true"]')).toHaveCount(1)
    })
  }

  test('#14 + settings wording: theme names per language, tints in spec board order, import button (spec board 02)', async ({ page }) => {
    await useTheme(page, 'reader', 'light')
    await gotoAndSettle(page, LECTURE)
    await page.locator('[data-lec-settings-btn]').click()
    await expect(page.locator('[data-lec-theme-opt="reader"]')).toHaveText('阅读')
    await expect(page.locator('[data-lec-theme-opt="datasheet"]')).toHaveText('器件手册')
    // spec board 02 底色: 纸白 / 米黄 / 豆沙绿 / 深色 / 自定义, in this order
    const ids = await page.locator('[data-lec-tint-opt]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lec-tint-opt')))
    expect(ids).toEqual(['light', 'sepia', 'green', 'dark', 'custom'])
    expect((await page.locator('[data-lec-tint-opt]').allInnerTexts()).map((s) => s.trim())).toEqual(['纸白', '米黄', '豆沙绿', '深色', '自定义'])
    await expect(page.locator('.rs-file-btn')).toHaveText('导入主题…')
    await page.keyboard.press('Escape')

    await gotoAndSettle(page, '/en/log/L01')
    await page.locator('[data-lec-settings-btn]').click()
    await expect(page.locator('[data-lec-theme-opt="reader"]')).toHaveText('Reader')
    await expect(page.locator('[data-lec-theme-opt="datasheet"]')).toHaveText('Datasheet')
    await expect(page.locator('.rs-file-btn')).toHaveText('Import theme…')
    // language buttons name each language in itself (中文 / English); everything else must be English
    const enText = await page.locator('.rs-panel').evaluate((el) => {
      const c = el.cloneNode(true) as HTMLElement
      for (const b of c.querySelectorAll('[data-lec-lang-opt]')) b.remove()
      return c.textContent ?? ''
    })
    expect(enText, 'no Chinese left in the English settings panel').not.toMatch(/[\u4e00-\u9fff]/)
  })

  for (const [path, title, home] of [
    ['/no/such/page', '页面不存在', '/'],
    ['/en/no/such/page', 'Page not found', '/en/'],
  ] as const) {
    test(`#15 404 ${path}: localized page with a way home and to search`, async ({ page }) => {
      const resp = await page.goto(path)
      expect(resp?.status()).toBe(404)
      const nf = page.locator('[data-lec-not-found]')
      await expect(nf).toBeVisible()
      await expect(nf.locator('h1')).toHaveText(title)
      await expect(nf.locator(`a[href="${home}"]`)).toBeVisible()
      await expect(nf.locator('[data-lec-not-found-search]')).toBeVisible()
      // spec board 17: no all-caps eyebrow, nothing of VitePress' English default page
      await expect(page.getByText('PAGE NOT FOUND', { exact: true })).toHaveCount(0)
      await expect(page.getByText('Take me home', { exact: true })).toHaveCount(0)
      const caps = await nf.evaluate((el) => [...el.querySelectorAll('*')].filter((e) => getComputedStyle(e).textTransform === 'uppercase').length)
      expect(caps).toBe(0)
    })
  }

  test('#16 #28 companion, backend unreachable: title, lecture, route, one status line, quick actions disabled with the reason (spec board 14)', async ({ page }) => {
    await health(page, false)
    await useTheme(page, 'reader', 'light')
    await gotoAndSettle(page, LECTURE)
    await page.keyboard.press('Alt+a')
    await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()
    const head = page.locator('.chat-header')
    await expect(head.locator('.chat-title')).toHaveText('伴读')
    await expect(head.locator('.lecture-badge')).toHaveText('MEA-L02')
    await expect(head.locator('[data-ai-route]')).toHaveText('服务端代理')
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'unavailable')
    await expect(page.locator('[data-ai-state]')).toHaveText('后端不可达，本轮对话不会保存')
    const text = await page.locator('.chat-container').innerText()
    expect(text.split('不可用').length - 1, '"不可用" at most once').toBeLessThanOrEqual(1)
    const quick = page.locator('[data-ai-quick-action]')
    expect(await quick.count()).toBeGreaterThan(0)
    for (const d of await quick.evaluateAll((els) => els.map((e) => (e as HTMLButtonElement).disabled))) expect(d).toBe(true)
    await expect(page.locator('[data-ai-quick-reason]')).toBeVisible()
    await expect(quick.first()).toHaveAttribute('title', /后端不可达/)
  })

  test('#16 companion, backend reachable: connected state line, quick actions follow the selection rule again', async ({ page }) => {
    await health(page, true)
    await useTheme(page, 'datasheet', 'light')
    await gotoAndSettle(page, LECTURE)
    await page.keyboard.press('Alt+a')
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'ok')
    await expect(page.locator('.chat-header [data-ai-route]')).toHaveText('服务端代理')
    await expect(page.locator('[data-ai-state]')).toHaveText('已连接')
    await expect(page.locator('[data-ai-quick-reason]')).toHaveCount(0)
    await expect(page.locator('[data-ai-quick-action="quiz"]')).toBeEnabled()
  })

  test('#22 dark chosen in the settings survives a reload and VitePress\' switch says so (aria-checked)', async ({ page }) => {
    await seedOnce(page, 'reader')
    await gotoAndSettle(page, LECTURE)
    await page.locator('[data-lec-settings-btn]').click()
    await page.locator('[data-lec-tint-opt="dark"]').click()
    await page.locator('[data-lec-settings-save]').click()
    await expect(page.locator('.VPSwitchAppearance').first()).toHaveAttribute('aria-checked', 'true')
    await page.reload()
    await page.waitForSelector('html[data-hydrated="1"]')
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect(page.locator('.VPSwitchAppearance').first()).toHaveAttribute('aria-checked', 'true')
    // and back: light from the settings, reload, switch off
    await page.locator('[data-lec-settings-btn]').click()
    await page.locator('[data-lec-tint-opt="light"]').click()
    await page.locator('[data-lec-settings-save]').click()
    await page.reload()
    await page.waitForSelector('html[data-hydrated="1"]')
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
    await expect(page.locator('.VPSwitchAppearance').first()).toHaveAttribute('aria-checked', 'false')
  })
})

// #27 + decision (1): phones (<= 768px) hide the wide-reading toggle; export and settings are the same 36x36 icon buttons
for (const width of [390, 768] as const) {
  test(`@s6y-f6 #27 phone top bar ${width}px: no wide-reading toggle, export and settings 36x36 icon buttons`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await useTheme(page, 'reader', 'light')
    await gotoAndSettle(page, LECTURE)
    await expect(page.locator('.reading-mode-nav-btn')).toBeHidden()
    if (width < 768) {
      for (const sel of ['.lecture-export-btn', '[data-lec-settings-btn]']) {
        const b = await page.locator(sel).boundingBox()
        expect(b, sel).not.toBeNull()
        if (!b) continue
        expect(Math.round(b.width), `${sel} width`).toBe(36)
        expect(Math.round(b.height), `${sel} height`).toBe(36)
      }
      await expect(page.locator('.lecture-export-btn .export-text')).toBeHidden()
      await expect(page.locator('[data-lec-settings-btn] .rs-btn-text')).toBeHidden()
    }
  })
}

test('@s6y-f6 #27 desktop 1280 keeps the wide-reading toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoAndSettle(page, LECTURE)
  await expect(page.locator('.reading-mode-nav-btn')).toBeVisible()
})
