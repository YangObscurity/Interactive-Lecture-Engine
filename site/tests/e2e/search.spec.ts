/**
 * tests/e2e/search.spec.ts - End-to-end coverage for WP-F3 split search (both skins, keyboard,
 * scope, real shard-loading progress + instant title hits, highlighting, status marks, and mobile).
 */
import { test, expect, gotoAndSettle } from './fixtures'
import { useTheme, type ThemeId } from './theme-helpers'

const SKINS: ReadonlyArray<readonly [ThemeId, string]> = [
  ['reader', 'default'],
  ['datasheet', 'datasheet'],
]

for (const [theme, expectedImpl] of SKINS) {
  test.describe(`search (${theme} skin)`, () => {
    test('Ctrl+K opens themed slot panel, groups hits, toggles scope, moves with arrows, Enter opens, Esc closes', async ({ page, pageErrors }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, '/mea/L03')

      // Open via Ctrl/Cmd+K shortcut
      await page.keyboard.press('ControlOrMeta+k')
      const slot = page.locator('[data-slot="SearchPanel"]')
      await expect(slot).toBeVisible()
      await expect(slot).toHaveAttribute('data-slot-impl', expectedImpl)
      await expect(slot).toHaveAttribute('role', 'dialog')

      // No box-shadow elevation
      const shadow = await slot.evaluate((el) => getComputedStyle(el).boxShadow)
      expect(shadow).toBe('none')

      // Input autofocused with accessible listbox/activedescendant links
      const input = page.locator('#lec-search-input')
      await expect(input).toBeFocused()
      // spec 04.2: opened on a group page, the default scope is "this group"
      await expect(page.locator('.sp-scope-btn', { hasText: '本组 MEA' })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.sp-scope-btn', { hasText: '全部' })).toHaveAttribute('aria-pressed', 'false')
      await input.fill('误差')

      // Wait until hits and meta count appear cleanly within 100 ms engine latency
      const hits = page.locator('.sp-hit')
      await expect(hits.first()).toBeVisible({ timeout: 15_000 })
      const metaText = await page.locator('.sp-scope .meta').innerText()
      const metaMatch = /(\d+)\s*条.*?(\d+)\s*ms/.exec(metaText)
      expect(metaMatch, `unexpected metaText: ${metaText}`).not.toBeNull()
      expect(Number(metaMatch![2])).toBeLessThanOrEqual(100)

      // Grouped heading present
      await expect(page.locator('.sp-grp h4').first()).toBeVisible()

      // Row shows reading status mark, skin-appropriate lecture code/no, section path & highlights
      const firstHit = hits.first()
      await expect(firstHit.locator('.mk')).toHaveAttribute('data-status', /not_started|in_progress|completed/)
      const noText = (await firstHit.locator('.no').innerText()).trim()
      if (theme === 'reader') {
        expect(noText).toMatch(/^第\d+讲$|^[A-Z]+\d*/)
      } else {
        expect(noText).toMatch(/^[A-Z]+\d*-L\d+$|^[A-Z]+\d*$/)
      }

      // Highlight marks have underline in both skins and accent background in reader
      const mark = page.locator('.sp-hit mark').first()
      await expect(mark).toBeVisible()
      const markStyles = await mark.evaluate((el) => {
        const cs = getComputedStyle(el)
        return { deco: cs.textDecorationLine, bg: cs.backgroundColor }
      })
      expect(markStyles.deco).toContain('underline')
      if (theme === 'reader') {
        expect(markStyles.bg).not.toBe('rgba(0, 0, 0, 0)')
      }

      // Scope toggle "all" vs "本组 MEA"
      await input.fill('下一讲预告')
      await expect(hits.first()).toBeVisible()
      const groupCount = await hits.count()
      const scopeGroupBtn = page.locator('.sp-scope-btn', { hasText: '本组 MEA' })
      await expect(scopeGroupBtn).toHaveAttribute('aria-pressed', 'true')
      const groupHrefs = await hits.evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''))
      for (const href of groupHrefs) {
        expect(href).toMatch(/^\/mea\//)
      }
      await page.locator('.sp-scope-btn', { hasText: '全部' }).click()
      await expect(scopeGroupBtn).toHaveAttribute('aria-pressed', 'false')
      expect(await hits.count()).toBeGreaterThanOrEqual(groupCount)

      // Search specific lecture LOG-L01 (scope is "all" now), move selection with ArrowDown, Enter opens lecture
      await input.fill('LOG-L01')
      await expect(hits.first()).toBeVisible()
      await expect(hits.first()).toHaveAttribute('aria-selected', 'true')
      if ((await hits.count()) > 1) {
        await page.keyboard.press('ArrowDown')
        await expect(hits.nth(1)).toHaveAttribute('aria-selected', 'true')
        await page.keyboard.press('ArrowUp')
      }
      await expect(hits.first()).toHaveAttribute('aria-selected', 'true')
      const targetHref = await hits.first().getAttribute('href')
      expect(targetHref).toMatch(/^\/log\/L01/)

      await page.keyboard.press('Enter')
      await expect(slot).toBeHidden()
      await expect(page).toHaveURL(/\/log\/L01/)

      // Reopen and close with Esc
      await page.keyboard.press('ControlOrMeta+k')
      await expect(slot).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(slot).toBeHidden()

      expect(pageErrors).toEqual([])
    })

    test('shows real loading progress and title hits immediately while shards are delayed', async ({ page, pageErrors }) => {
      await useTheme(page, theme, 'light')

      let releaseShards!: () => void
      const shardGate = new Promise<void>((resolve) => {
        releaseShards = resolve
      })

      // Hold shard responses while keeping manifest.json & titles.json fast
      await page.route('**/search/**/shards/*.sz', async (route) => {
        await shardGate
        await route.continue()
      })

      await gotoAndSettle(page, '/')
      await page.locator('.VPNavBarSearch button, #local-search button').first().click()

      const input = page.locator('#lec-search-input')
      await expect(input).toBeFocused()
      const start = Date.now()
      await input.fill('误差')

      // Title/heading hit appears quickly while shards remain paused
      const hits = page.locator('.sp-hit')
      await expect(hits.first()).toBeVisible({ timeout: 2_000 })
      const firstHitMs = Date.now() - start
      expect(firstHitMs).toBeLessThan(2_000)

      // Progress status bar shows live MB progress while shards are delayed
      const loadBar = page.locator('.sp-load')
      await expect(loadBar).toBeVisible()
      await expect(loadBar).toContainText(/\d+\.\d+\s*\/\s*\d+\.\d+\s*MB/)

      // Check phone layout fits without horizontal overflow at 390 px when open
      await page.setViewportSize({ width: 390, height: 844 })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      expect(overflow).toBeLessThanOrEqual(0)
      const panelBox = await page.locator('[data-slot="SearchPanel"]').boundingBox()
      expect(panelBox).not.toBeNull()
      expect(panelBox!.x).toBeGreaterThanOrEqual(0)
      expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(390.5)
      await page.setViewportSize({ width: 1280, height: 800 })

      // Release shards -> progress bar clears and body snippets hydrate
      releaseShards()
      await expect(loadBar).toBeHidden({ timeout: 20_000 })
      await input.fill('标准差')
      await expect(page.locator('.sp-hit .snip').first()).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('.sp-hit mark').first()).toBeVisible()

      await page.unroute('**/search/**/shards/*.sz')
      expect(pageErrors).toEqual([])
    })

    test('focus trap: Tab and Shift+Tab stay inside search dialog; Esc closes and returns focus to opener button', async ({ page, pageErrors }) => {
      await useTheme(page, theme, 'light')
      await gotoAndSettle(page, '/mea/L03')

      const trigger = page.locator('.VPNavBarSearch button, #local-search button').first()
      await trigger.click()

      const slot = page.locator('[data-slot="SearchPanel"]')
      await expect(slot).toBeVisible()

      const input = page.locator('#lec-search-input')
      await expect(input).toBeFocused()

      // Shift+Tab from input wraps to the last focusable element in the dialog
      await page.keyboard.press('Shift+Tab')
      const focusedInsideOnShiftTab = await slot.evaluate((el) => el.contains(document.activeElement))
      expect(focusedInsideOnShiftTab).toBe(true)

      // Tab wraps back to the input
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()

      // Esc closes dialog and returns focus to the opener button
      await page.keyboard.press('Escape')
      await expect(slot).toBeHidden()
      await expect(trigger).toBeFocused()

      expect(pageErrors).toEqual([])
    })
  })
}

// S6Y audit-spec #13 #17 #18 (spec board 04.2): snippets are readable text (a figure reference shows its label, never the
// `[](fig:id)` markup), group headings are "MEA 测量" / "概念" (no all-caps eyebrow, no internal CONCEPTS id), and the count
// next to the timing is the number of rows listed
for (const [theme] of SKINS) {
  test(`search (${theme} skin): figure labels in snippets, plain group headings, count = rows`, async ({ page, pageErrors }) => {
    await useTheme(page, theme, 'light')
    await gotoAndSettle(page, '/mea/L02')
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.locator('#lec-search-input')
    await expect(input).toBeFocused()
    await page.locator('.sp-scope-btn', { hasText: '全部' }).click()
    const metaCount = async () => Number(/(\d+)\s*条/.exec(await page.locator('.sp-scope .meta').innerText())?.[1] ?? -1)

    // MEA L02: "如 [](fig:mea-ruler) 所示，图中的数字都是为本示例编写的"
    await input.fill('为本示例编写')
    await expect(page.locator('.sp-hit').first()).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => (await page.locator('.sp-hit .snip').allInnerTexts()).some((s) => /图 2-1 所示/.test(s)), { timeout: 15_000 }).toBe(true)
    const snips = await page.locator('.sp-hit').allInnerTexts()
    for (const s of snips) expect(s, 'raw figure-reference markup in a search row').not.toMatch(/\[\]\(|\(fig:|\(tab:/)
    await expect.poll(async () => (await metaCount()) === (await page.locator('.sp-hit').count()), { timeout: 15_000 }).toBe(true)

    // a lecture group and the concept group
    await input.fill('有效数字')
    await expect(page.locator('.sp-grp h4').nth(1)).toBeVisible({ timeout: 15_000 })
    const heads = await page.locator('.sp-grp h4 > span').allInnerTexts()
    expect(heads).toContain('概念')
    expect(heads.some((h) => /^MEA /.test(h))).toBe(true)
    for (const h of heads) expect(h).not.toMatch(/CONCEPTS|SITE/)
    const transform = await page.locator('.sp-grp h4').first().evaluate((el) => getComputedStyle(el).textTransform)
    expect(transform).toBe('none')
    await expect.poll(async () => (await metaCount()) === (await page.locator('.sp-hit').count()), { timeout: 15_000 }).toBe(true)
    expect(pageErrors).toEqual([])
  })
}
