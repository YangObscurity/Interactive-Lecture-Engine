import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

/**
 * Code syntax colours in lectures and in the AI companion (markdownMath.ts codeSlot). The companion used to show
 * code blocks in one colour: Shiki's token colours are inline styles and the model sanitizer (FE-002) drops them.
 * Checks the computed colours in both skins, light and dark. CODE_HL_BASE / CODE_HL_PAGE let the same checks run
 * against another served build (e.g. the site's own lectures); by default the demo build's /mea/L04.
 */
const BASE = process.env.CODE_HL_BASE ?? ''
const LECTURE = process.env.CODE_HL_PAGE ?? '/mea/L04'

const CODE_ANSWER = [
  '两段代码：',
  '',
  '```python',
  'def mean(xs: list[float]) -> float:',
  '    # average of the samples',
  '    return sum(xs) / len(xs)',
  '```',
  '',
  '```c',
  '#include <stdio.h>',
  'int main(void) { printf("%d\\n", 42); return 0; }',
  '```',
].join('\n')

async function mockCompanion(page: Page): Promise<void> {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  await page.route((u) => u.pathname === '/api/health', (r) => r.fulfill(json({ ok: true, checks: { db: 'ok', ai: 'ok', notion: 'off' } })))
  await page.route(
    (u) => u.pathname === '/api/ai/chat',
    (r) =>
      r.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body:
          `data: ${JSON.stringify({ event: 'agent_message', conversation_id: 'conv-code-1', answer: CODE_ANSWER })}\n\n` +
          'data: {"event":"message_end","conversation_id":"conv-code-1","metadata":{}}\n\n',
      }),
  )
  await page.route(
    (u) => u.pathname.startsWith('/api/db/sessions') || u.pathname.startsWith('/api/db/messages'),
    (r) =>
      r.request().method() === 'GET'
        ? r.fulfill(json([]))
        : r.fulfill({ status: 201, contentType: 'application/json', body: r.request().postData() || '{}' }),
  )
}

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
  await page.waitForTimeout(150)
}

/** Distinct computed colours of the non-blank code tokens under `selector`, and the code text colour. */
async function tokenColours(page: Page, selector: string): Promise<{ tokens: number; distinct: string[]; styleless: number }> {
  return page.evaluate((sel) => {
    const spans = Array.from(document.querySelectorAll(sel)).filter((s) => (s.textContent ?? '').trim())
    return {
      tokens: spans.length,
      distinct: Array.from(new Set(spans.map((s) => getComputedStyle(s).color))),
      styleless: spans.filter((s) => !s.getAttribute('style')).length,
    }
  }, selector)
}

const LECTURE_TOKENS = '.vp-doc div[class*="language-"] pre.shiki code span.line > span'
const COMPANION_TOKENS = '.assistant-body .ai-code-body pre.shiki code span.line > span'

test.describe('code syntax colours', () => {
  test('lecture code blocks have several token colours in both skins, light and dark', async ({ page }) => {
    await gotoAndSettle(page, BASE + LECTURE)
    await expect(page.locator('.vp-doc div[class*="language-"] pre.shiki').first()).toBeVisible()
    const seen: Record<string, string[]> = {}
    for (const look of LOOKS) {
      await setLook(page, look)
      const c = await tokenColours(page, LECTURE_TOKENS)
      expect(c.tokens, `${look.skin} ${look.dark ? 'dark' : 'light'}`).toBeGreaterThan(5)
      expect(c.distinct.length, `${look.skin} ${look.dark ? 'dark' : 'light'}: ${c.distinct.join(' ')}`).toBeGreaterThanOrEqual(3)
      seen[`${look.skin}-${look.dark}`] = c.distinct
    }
    expect(seen['reader-true']).not.toEqual(seen['reader-false'])
  })

  test('companion code blocks have several token colours in both skins, light and dark', async ({ page }) => {
    await mockCompanion(page)
    await gotoAndSettle(page, BASE + LECTURE)
    await page.keyboard.press('Alt+a')
    await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()
    await page.locator('.chat-textarea').fill('给我两段代码')
    await page.locator('.send-btn').click()
    const blocks = page.locator('.assistant-body .ai-code-block')
    await expect(blocks).toHaveCount(2)
    // Shiki loads asynchronously; the message re-renders once the highlighter is ready
    await expect(page.locator('.assistant-body .ai-code-body pre.shiki')).toHaveCount(2, { timeout: 20_000 })
    await expect(page.locator('.assistant-body .shiki-fallback')).toHaveCount(0)
    const seen: Record<string, string[]> = {}
    for (const look of LOOKS) {
      await setLook(page, look)
      const c = await tokenColours(page, COMPANION_TOKENS)
      const label = `${look.skin} ${look.dark ? 'dark' : 'light'}`
      expect(c.tokens, label).toBeGreaterThan(10)
      expect(c.styleless, label).toBe(0)
      expect(c.distinct.length, `${label}: ${c.distinct.join(' ')}`).toBeGreaterThanOrEqual(3)
      seen[`${look.skin}-${look.dark}`] = c.distinct
    }
    expect(seen['reader-true']).not.toEqual(seen['reader-false'])
    // only Shiki's own declarations are left on code tokens
    const styles = await page.evaluate((sel) =>
      Array.from(document.querySelectorAll(sel), (s) => s.getAttribute('style') ?? ''), COMPANION_TOKENS)
    for (const s of styles) expect(s).toMatch(/^(--shiki-(light|dark)(-font-(style|weight))?:[^;]+;?)+$/)
    // the copy button still carries the plain code
    await expect(blocks.first().locator('.ai-code-copy-btn')).toHaveAttribute('data-code', /def mean/)
  })
})
