import { expect, test, gotoAndSettle } from './fixtures'
import { useTheme } from './theme-helpers'

const LECTURE = '/mea/L03'

for (const skin of ['reader', 'datasheet'] as const) {
  test.describe(`WP-F7 quick actions (${skin})`, () => {
    test('panel and selection-toolbar quick actions send action id + selection in both modes and stay keyboard reachable', async ({
      page,
      consoleErrors,
      pageErrors,
    }) => {
      const chatRequests: Array<{ action?: string; query?: string; lang?: string; inputs?: Record<string, string> }> = []

      await page.route(
        (u) => u.pathname === '/api/health',
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, checks: { db: 'ok', ai: 'ok', notion: 'off' } }),
          })
        },
      )

      await page.route(
        (u) => u.pathname === '/api/ai/chat',
        async (route) => {
          const payload = JSON.parse(route.request().postData() || '{}') as {
            action?: string
            query?: string
            lang?: string
            inputs?: Record<string, string>
          }
          chatRequests.push(payload)
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream; charset=utf-8',
            body: `data: {"event":"agent_message","conversation_id":"conv-qa-1","answer":"Action=${payload.action || 'none'} Sel=${payload.inputs?.selection || ''}"}\n\ndata: {"event":"message_end","conversation_id":"conv-qa-1","metadata":{"usage":{"prompt_tokens":4,"completion_tokens":4,"total_tokens":8}}}\n\n`,
          })
        },
      )

      await page.route(
        (u) => u.pathname.startsWith('/api/db/sessions') || u.pathname.startsWith('/api/db/messages'),
        async (route) => {
          if (route.request().method() === 'GET') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
          } else {
            await route.fulfill({ status: 201, contentType: 'application/json', body: route.request().postData() || '{}' })
          }
        },
      )

      await useTheme(page, skin, 'light')
      await gotoAndSettle(page, LECTURE)

      // 1. Open companion panel via trigger button
      await page.locator('.ai-trigger-tab').click()
      await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()

      // Selection-requiring quick actions are disabled without selection; section action is enabled
      const explainPanelBtn = page.locator('[data-ai-quick-action="explain"]')
      const examplePanelBtn = page.locator('[data-ai-quick-action="example"]')
      const quizPanelBtn = page.locator('[data-ai-quick-action="quiz"]')

      await expect(explainPanelBtn).toBeDisabled()
      await expect(examplePanelBtn).toBeDisabled()
      await expect(quizPanelBtn).toBeEnabled()

      // Keyboard-reachable quick action in panel (focus + Enter)
      await quizPanelBtn.focus()
      await expect(quizPanelBtn).toBeFocused()
      await page.keyboard.press('Enter')

      await expect.poll(() => chatRequests.length).toBe(1)
      expect(chatRequests[0]).toMatchObject({
        action: 'quiz',
        lang: 'zh',
        query: '',
      })
      expect(chatRequests[0]?.inputs?.current_lecture).toContain('L03')
      await expect(page.locator('.assistant-body')).toContainText('Action=quiz')

      // Close sidebar before selecting text from lecture prose
      await page.keyboard.press('Escape')
      await expect(page.locator('.ai-sidebar-shell.is-open')).toHaveCount(0)

      // 2. Select text inside visible .vp-doc paragraph and trigger quick action from floating SelectionToolbar
      const selectVisibleProse = async (length: number): Promise<string> => {
        return page.evaluate((len) => {
          const paragraphs = Array.from(document.querySelectorAll('.vp-doc > div > p, .vp-doc p'))
          for (const p of paragraphs) {
            if (p.closest('.lec-tb, figure, table, details')) continue
            const style = getComputedStyle(p)
            if (style.display === 'none' || style.visibility === 'hidden') continue
            const rect = p.getBoundingClientRect()
            if (rect.width <= 0 || rect.height <= 0) continue
            const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
            let node: Node | null
            while ((node = walker.nextNode())) {
              const txt = node.textContent || ''
              const trimmedLen = txt.trim().length
              if (trimmedLen >= len) {
                p.scrollIntoView({ block: 'center' })
                const startOffset = txt.search(/\S/)
                const range = document.createRange()
                range.setStart(node, Math.max(0, startOffset))
                range.setEnd(node, Math.min(txt.length, Math.max(0, startOffset) + len))
                const rRect = range.getBoundingClientRect()
                if (rRect.width <= 0 || rRect.height <= 0) continue
                const sel = window.getSelection()
                sel?.removeAllRanges()
                sel?.addRange(range)
                document.dispatchEvent(new Event('selectionchange'))
                return sel?.toString().trim() || ''
              }
            }
          }
          return ''
        }, length)
      }

      const selectedSnippet = await selectVisibleProse(12)
      expect(selectedSnippet.length).toBeGreaterThan(0)

      const toolbar = page.locator('.ai-selection-toolbar')
      await expect(toolbar).toBeVisible()
      const explainToolbarBtn = toolbar.locator('[data-ai-toolbar-action="explain"]')
      await expect(explainToolbarBtn).toBeVisible()
      await explainToolbarBtn.click()

      await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()
      await expect.poll(() => chatRequests.length).toBe(2)
      expect(chatRequests[1]?.action).toBe('explain')
      expect(chatRequests[1]?.inputs?.selection).toBe(selectedSnippet)
      await expect(page.locator('.assistant-body').last()).toContainText(`Action=explain Sel=${selectedSnippet}`)

      // 3. Re-select text, use [Ask AI] to quote into panel without auto-send -> verify panel explain button unlocks
      await page.keyboard.press('Escape')
      const quotedSnippet = await selectVisibleProse(10)
      expect(quotedSnippet.length).toBeGreaterThan(0)
      await expect(toolbar).toBeVisible()
      await toolbar.locator('[data-ai-toolbar-ask]').click()
      await expect(explainPanelBtn).toBeEnabled()
      await explainPanelBtn.click()
      await expect.poll(() => chatRequests.length).toBe(3)
      expect(chatRequests[2]?.action).toBe('explain')
      expect(chatRequests[2]?.inputs?.selection).toBe(quotedSnippet)

      expect(pageErrors).toEqual([])
      expect(consoleErrors.filter((m) => !m.includes('503'))).toEqual([])
    })
  })
}
