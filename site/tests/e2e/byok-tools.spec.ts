/**
 * tests/e2e/byok-tools.spec.ts - Reader own-key tool loop E2E in `prod` (WP-K3 Item 5).
 *
 * Mocks `/api/tools`, `/api/tools/search_concepts`, and OpenAI Chat Completions so
 * the browser displays the shared tool progress mark (without args/results) and the final answer
 * across both skins (`reader` and `datasheet`).
 */
import { test, expect, gotoAndSettle } from './fixtures'

const LECTURE = '/g01/L01'

test.describe('WP-K3 Item 5: reader own-key tool loop (prod)', () => {
  test('executes OpenAI tool_calls against /api/tools, shows progress mark without args/results, and renders final answer', async ({
    page,
    pageErrors,
  }) => {
    test.skip(test.info().project.name !== 'prod', 'Tests the built production reader own-key tool loop')

    let modelStep = 0
    const apiToolsRequests: Array<{ url: string; method: string; auth?: string; body?: string }> = []

    await page.route('**/api/health', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, checks: { db: 'ok', ai: 'ok', notion: 'off' } }),
      }),
    )
    await page.route('**/api/db/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    )

    await page.route('**/api/tools', (route) => {
      const req = route.request()
      apiToolsRequests.push({
        url: req.url(),
        method: req.method(),
        auth: req.headers()['authorization'],
      })
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          maxSteps: 5,
          tools: [
            {
              name: 'search_concepts',
              description: 'Search published concepts by name or alias',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false,
              },
            },
          ],
        }),
      })
    })

    await page.route('**/api/tools/search_concepts', async (route) => {
      const req = route.request()
      const postData = req.postData() || ''
      apiToolsRequests.push({
        url: req.url(),
        method: req.method(),
        auth: req.headers()['authorization'],
        body: postData,
      })
      // Keep running state observable briefly before fulfilling
      await new Promise((r) => setTimeout(r, 250))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { slug: 'actuation-lease', term: '执行租约', summary: 'TOOL_SECRET_RESULT_NOT_SHOWN_IN_PILL' },
        ]),
      })
    })

    await page.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
      const raw = route.request().postData() || ''
      if (raw.includes('"max_tokens":1')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"probe"}' })
      }
      const reqJson = JSON.parse(raw) as {
        tools?: Array<{ type: string; function: { name: string } }>
        messages: Array<{ role: string; content?: string | null; tool_call_id?: string }>
      }
      modelStep++
      expect(reqJson.tools?.some((t) => t.function.name === 'search_concepts')).toBe(true)

      if (modelStep === 1) {
        const sse = [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_e2e_1","type":"function","function":{"name":"search_concepts","arguments":""}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"TOOL_ARG_SECRET\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ].join('')
        return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: sse })
      }

      expect(
        reqJson.messages.some(
          (m) => m.role === 'tool' && m.tool_call_id === 'call_e2e_1' && m.content?.includes('actuation-lease'),
        ),
      ).toBe(true)
      const finalSse = [
        'data: {"choices":[{"delta":{"content":"已查到相关概念：执行租约用于限定执行权限。"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: finalSse })
    })

    await gotoAndSettle(page, LECTURE)

    // Enable reader own-key mode in Settings
    await page.locator('[data-lec-settings-btn]').click()
    await page.locator('[data-lec-setting="byok"] details summary').click()
    await page.locator('[data-lec-byok-enable]').check()
    await page.locator('[data-lec-byok-url]').fill('https://openrouter.ai/api/v1')
    await page.locator('[data-lec-byok-key]').fill('sk-e2e-reader-secret')
    await page.locator('[data-lec-byok-model]').fill('gpt-4o-mini')
    await page.locator('[data-lec-settings-save]').click()

    // Open AI sidebar & ask question that triggers tool_calls
    await page.keyboard.press('Alt+a')
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'byok-unverified')
    await page.locator('.chat-textarea').fill('帮我查一下执行租约')
    await page.locator('.send-btn').click()

    const toolPill = page.locator('[data-ai-tool-call="search_concepts"]')
    await expect(toolPill).toBeVisible()
    // Tool progress ends cleanly and final answer appears
    await expect(toolPill).toHaveAttribute('data-ai-tool-state', 'done')
    await expect(page.locator('.assistant-body')).toContainText('已查到相关概念：执行租约用于限定执行权限。')

    // Progress pill shows ONLY tool name/status, NEVER arguments or tool JSON results
    const pillContainerText = await page.locator('[data-ai-tool-calls]').innerText()
    expect(pillContainerText).toContain('search_concepts')
    expect(pillContainerText).not.toContain('TOOL_ARG_SECRET')
    expect(pillContainerText).not.toContain('TOOL_SECRET_RESULT_NOT_SHOWN_IN_PILL')

    // Ensure reader BYOK key never touched /api/tools*
    expect(apiToolsRequests.some((r) => r.method === 'GET' && r.url.endsWith('/api/tools'))).toBe(true)
    expect(apiToolsRequests.some((r) => r.method === 'POST' && r.url.endsWith('/api/tools/search_concepts'))).toBe(true)
    for (const r of apiToolsRequests) {
      expect(r.auth ?? '').toBe('')
      expect(r.body ?? '').not.toContain('sk-e2e-reader-secret')
    }
    expect(modelStep).toBe(2)

    // Verify tool pill still renders cleanly when toggled to reader skin too
    await page.locator('[data-lec-settings-btn]').click()
    await page.locator('[data-lec-theme-opt="reader"]').click()
    await page.locator('[data-lec-settings-save]').click()
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'reader')
    await expect(toolPill).toBeVisible()

    expect(pageErrors).toEqual([])
  })
})
