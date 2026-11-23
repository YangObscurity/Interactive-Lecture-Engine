import type { Page } from '@playwright/test'
import { test, expect, gotoAndSettle } from './fixtures'

/**
 * AI companion maths (markdownMath.ts): the model's Markdown/HTML is sanitized first (FE-002 unchanged, no style),
 * KaTeX output goes in afterwards with its inline layout styles. Checks the layout of fractions, radicals and
 * scripts in real Chromium and that HTML / TeX injected by the model still has no effect.
 */
const LECTURE = '/mea/L03'

const MATH_ANSWER = [
  '分式 $\\frac{a+b}{2}$，根号 $\\sqrt{x^2+1}$，上下标 $x_i^2$，符号 $\\alpha \\le \\beta$。',
  '',
  '$$\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i,\\qquad s = \\sqrt{\\frac{\\sum_{i=1}^{n} (x_i-\\bar{x})^2}{n-1}}$$',
  '',
  '<span class="model-styled" style="color:red;position:fixed;inset:0;z-index:9999" onmouseover="window.__xss=1">styled</span> <img src=x onerror="window.__xss=2">',
  '',
  '注入 $\\href{javascript:window.__xss=3}{link}$ $\\htmlStyle{position:fixed;inset:0}{big}$ $\\text{<b onclick=1>t</b>}$',
].join('\n')

async function mockMathCompanion(page: Page, answer = MATH_ANSWER): Promise<void> {
  await page.route(
    (u) => u.pathname === '/api/health',
    (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, checks: { db: 'ok', ai: 'ok', notion: 'off' } }) }),
  )
  await page.route(
    (u) => u.pathname === '/api/ai/chat',
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body:
          `data: ${JSON.stringify({ event: 'agent_message', conversation_id: 'conv-math-1', answer })}\n\n` +
          'data: {"event":"message_end","conversation_id":"conv-math-1","metadata":{"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}}\n\n',
      }),
  )
  await page.route(
    (u) => u.pathname.startsWith('/api/db/sessions') || u.pathname.startsWith('/api/db/messages'),
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        : route.fulfill({ status: 201, contentType: 'application/json', body: route.request().postData() || '{}' }),
  )
}

async function askMath(page: Page, path = LECTURE): Promise<void> {
  await gotoAndSettle(page, path)
  await page.keyboard.press('Alt+a')
  await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()
  await page.locator('.chat-textarea').fill('均值和标准差的公式？')
  await page.locator('.send-btn').click()
  await expect(page.locator('.assistant-body .katex').first()).toBeVisible()
}

test.describe('AI companion maths: KaTeX after sanitizing', () => {
  test('fractions, radicals and scripts keep their KaTeX layout; model HTML/TeX injection has no effect', async ({ page }) => {
    await mockMathCompanion(page)
    await askMath(page)
    const body = page.locator('.assistant-body').last()
    await expect(body.locator('.math-inline .katex')).toHaveCount(7)
    await expect(body.locator('.math-block .katex-display')).toHaveCount(1)

    const geo = await body.evaluate((root) => {
      const r = (el: Element | null | undefined) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height, cy: b.top + b.height / 2 }
      }
      const leaf = (scope: Element | null, text: string) =>
        Array.from(scope?.querySelectorAll('.katex-html span') ?? []).find((s) => s.children.length === 0 && s.textContent === text) ?? null
      const inl = Array.from(root.querySelectorAll('.math-inline'))
      const frac = inl[0] ?? null
      const sqrt = inl[1] ?? null
      const sup = inl[2] ?? null
      const sym = inl[3] ?? null
      const p = root.querySelector('p')
      return {
        fracLine: r(frac?.querySelector('.frac-line')),
        fracNum: r(leaf(frac, 'a')),
        fracDen: r(leaf(frac, '2')),
        sqrtSvg: r(sqrt?.querySelector('.sqrt svg')),
        sqrtX: r(leaf(sqrt, 'x')),
        supBase: r(leaf(sup, 'x')),
        supSub: r(leaf(sup, 'i')),
        supSup: r(leaf(sup, '2')),
        blockFracs: root.querySelectorAll('.math-block .mfrac').length,
        blockSqrtSvg: r(root.querySelector('.math-block .sqrt svg')),
        katexFontPx: parseFloat(getComputedStyle(sym?.querySelector('.katex') ?? root).fontSize),
        bodyFontPx: parseFloat(getComputedStyle(p ?? root).fontSize),
        styledInKatex: root.querySelectorAll('.katex-html [style]').length,
        mathml: root.querySelectorAll('.katex-mathml math annotation').length,
        slots: root.querySelectorAll('[data-ai-math-slot]').length,
      }
    })
    // fraction: numerator above the bar, denominator below, bar drawn (glyph boxes include side bearings: compare centres)
    expect(geo.fracLine && geo.fracNum && geo.fracDen).toBeTruthy()
    expect(geo.fracLine!.h).toBeGreaterThan(0)
    expect(geo.fracNum!.cy).toBeLessThan(geo.fracLine!.top)
    expect(geo.fracDen!.cy).toBeGreaterThan(geo.fracLine!.bottom)
    // radical: the sign is drawn and spans the radicand
    expect(geo.sqrtSvg!.w).toBeGreaterThan(10)
    expect(geo.sqrtSvg!.h).toBeGreaterThan(geo.sqrtX!.h * 0.8)
    expect(geo.sqrtX!.left).toBeGreaterThan(geo.sqrtSvg!.left)
    // scripts: superscript up, subscript down
    expect(geo.supSup!.cy).toBeLessThan(geo.supBase!.cy - 2)
    expect(geo.supSub!.cy).toBeGreaterThan(geo.supBase!.cy + 2)
    // display formula: both fractions and the radical
    expect(geo.blockFracs).toBe(2)
    expect(geo.blockSqrtSvg!.w).toBeGreaterThan(10)
    // simple symbols are not shrunk below the message text
    expect(geo.katexFontPx).toBeGreaterThanOrEqual(geo.bodyFontPx * 0.95)
    expect(geo.styledInKatex).toBeGreaterThan(20)
    expect(geo.mathml).toBe(8)
    expect(geo.slots).toBe(0)

    // the model's own HTML is still sanitized: no style, no handlers, no img
    const styled = body.locator('.model-styled')
    await expect(styled).toHaveText('styled')
    expect(await styled.getAttribute('style')).toBeNull()
    expect(await styled.getAttribute('onmouseover')).toBeNull()
    await expect(body.locator('img')).toHaveCount(0)
    await styled.hover()
    // TeX injection: untrusted commands render as inert text
    await expect(body.locator('a')).toHaveCount(0)
    await expect(body.locator('b')).toHaveCount(0)
    const injected = await body.evaluate((root) => ({
      xss: (window as unknown as { __xss?: unknown }).__xss ?? null,
      fixed: Array.from(root.querySelectorAll('*')).filter((el) => getComputedStyle(el).position === 'fixed').length,
      handlers: Array.from(root.querySelectorAll('*')).filter((el) => Array.from(el.attributes).some((a) => /^on/i.test(a.name))).length,
    }))
    expect(injected).toEqual({ xss: null, fixed: 0, handlers: 0 })
    await expect(body.locator('.katex-html').filter({ hasText: '\\href' })).toHaveCount(1)
    await expect(body.locator('.katex-html').filter({ hasText: '\\htmlStyle' })).toHaveCount(1)
  })
})
