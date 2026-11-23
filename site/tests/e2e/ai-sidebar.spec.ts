import { test, expect, gotoAndSettle } from './fixtures'

const LECTURE = '/mea/L03'
/** not in the demo progress seed (MEA 1-3 read, 4 reading): the progress card shows its primary button */
const NOT_STARTED_LECTURE = '/mea/L05'

test.describe('P6 / WP-F2: reader settings panel & AI companion', () => {
  test('settings panel §02: language, datasheet tint disable, stepper, custom tint contrast gate & Save/Restore', async ({ page }) => {
    await gotoAndSettle(page, `${LECTURE}?debug=1`)

    const btn = page.locator('[data-lec-settings-btn]')
    await expect(btn).toBeVisible()
    await btn.click()
    const panel = page.locator('[data-lec-settings-panel]')
    await expect(panel).toBeVisible()

    // Language section present (Spec §02)
    await expect(page.locator('[data-lec-setting="language"]')).toBeVisible()
    await expect(page.locator('[data-lec-lang-opt="zh-CN"]')).toBeVisible()
    await expect(page.locator('[data-lec-lang-opt="en"]')).toBeVisible()

    // Datasheet disables eye-care & custom tints with explicit note
    await expect(page.locator('[data-lec-tint-disabled-note]')).toBeVisible()
    await expect(page.locator('[data-lec-tint-opt="sepia"]')).toBeDisabled()
    await expect(page.locator('[data-lec-tint-opt="custom"]')).toBeDisabled()

    // Switch to reader, pick sepia, step font size 17 -> 20 via +, choose sans, uncheck groupDesc, click Save
    await page.locator('[data-lec-theme-opt="reader"]').click()
    await page.locator('[data-lec-tint-opt="sepia"]').click()
    await page.locator('[data-lec-size-inc]').click()
    await page.locator('[data-lec-size-inc]').click()
    await expect(page.locator('[data-lec-size-value]')).toHaveText('20px')
    await page.locator('[data-lec-font-opt="sans"]').click()
    await page.locator('[data-lec-group-desc]').uncheck()
    await page.locator('[data-lec-settings-save]').click()

    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'reader')
    await expect(page.locator('html')).toHaveAttribute('data-lec-tint', 'sepia')
    await expect(page.locator('html')).toHaveAttribute('data-lec-size', '20')
    await expect(page.locator('html')).toHaveAttribute('data-lec-font', 'sans')
    await expect(page.locator('html')).toHaveAttribute('data-lec-desc', 'closed')

    // Persistence across reload
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'reader')
    await expect(page.locator('html')).toHaveAttribute('data-lec-tint', 'sepia')
    await expect(page.locator('html')).toHaveAttribute('data-lec-desc', 'closed')

    await page.locator('[data-lec-settings-btn]').click()

    // Custom tint contrast gate: high lightness passes, low lightness disables Save with reason
    await page.locator('[data-lec-tint-opt="custom"]').click()
    const lightSlider = page.locator('[data-lec-tint-lightness]')
    await lightSlider.fill('95')
    await lightSlider.dispatchEvent('input')
    await expect(page.locator('[data-lec-contrast-pass]')).toHaveAttribute('data-lec-contrast-pass', 'true')
    await expect(page.locator('[data-lec-settings-save]')).toBeEnabled()
    const validBg = await page.evaluate(() => document.documentElement.style.getPropertyValue('--lec-bg'))
    expect(validBg).toMatch(/^#[0-9A-F]{6}$/)

    await lightSlider.fill('42')
    await lightSlider.dispatchEvent('input')
    await expect(page.locator('[data-lec-contrast-pass]')).toHaveAttribute('data-lec-contrast-pass', 'false')
    await expect(page.locator('[data-lec-contrast-reason]')).toBeVisible()
    await expect(page.locator('[data-lec-settings-save]')).toBeDisabled()
    const afterFailBg = await page.evaluate(() => document.documentElement.style.getPropertyValue('--lec-bg'))
    expect(afterFailBg).toBe(validBg)

    // Closing without saving reverts uncommitted custom tint preview back to committed sepia
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(page.locator('[data-lec-settings-btn]')).toBeFocused()
    await expect(page.locator('html')).toHaveAttribute('data-lec-tint', 'sepia')

    // Reopen -> Theme JSON validation & Restore defaults
    await page.locator('[data-lec-settings-btn]').click()
    await page.locator('[data-lec-theme-file]').setInputFiles({
      name: 'bad-theme.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ modes: { light: { bg: '#111111', text: '#222222' } } })),
    })
    await expect(page.locator('[data-lec-theme-msg]')).toHaveClass(/is-error/)

    await page.locator('[data-lec-theme-file]').setInputFiles({
      name: 'good-theme.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ modes: { light: { bg: '#FCFBF7', text: '#1F2328', accent: '#2155C4' } } })),
    })
    await expect(page.locator('[data-lec-theme-msg]')).not.toHaveClass(/is-error/)
    await expect(page.locator('[data-lec-theme-reset]')).toBeVisible()
    await page.locator('[data-lec-theme-reset]').click()

    // Restore defaults resets everything cleanly
    await page.locator('[data-lec-settings-restore]').click()
    await expect(page.locator('html')).toHaveAttribute('data-lec-theme', 'datasheet')
    const storedDesc = await page.evaluate(() => localStorage.getItem('lecture:group-desc'))
    expect(storedDesc).toBe('1')
  })

  test('Plan B proxy health states, 429/413/403, truncated/error SSE, zero fake DB writes, Chromium XSS sanitizing, retry & flags', async ({ page }) => {
    const dbWrites: Array<{ url: string; method: string }> = []
    let healthMode: 'off' | 'down' | 'ok' = 'off'
    let chatMode: '429' | '413' | '403' | 'sse_err' | 'eof_cut' | 'ok' = '429'
    let dbFail = false

    await page.route(
      (u) => u.pathname === '/api/health',
      async (route) => {
        if (healthMode === 'off') {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, checks: { db: 'ok', ai: 'off', notion: 'off' } }) })
        } else if (healthMode === 'down') {
          await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, checks: { db: 'ok', ai: 'degraded', notion: 'off' } }) })
        } else {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, checks: { db: 'ok', ai: 'ok', notion: 'off' } }) })
        }
      },
    )

    await page.route(
      (u) => u.pathname === '/api/ai/chat',
      async (route) => {
        if (chatMode === '429') {
          await route.fulfill({ status: 429, headers: { 'retry-after': '9' }, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', retry_after: 9 }) })
          return
        }
        if (chatMode === '413') {
          await route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'payload_too_large' }) })
          return
        }
        if (chatMode === '403') {
          await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'anonymous_disabled' }) })
          return
        }
        if (chatMode === 'sse_err') {
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream; charset=utf-8',
            body: 'data: {"event":"agent_message","conversation_id":"conv-1","answer":"Partial "}\n\nevent: error\ndata: {"event":"error","code":"upstream_error","message":"upstream reset"}\n\n',
          })
          return
        }
        if (chatMode === 'eof_cut') {
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream; charset=utf-8',
            body: 'data: {"event":"agent_message","conversation_id":"conv-1","answer":"Cut off without end"}\n\n',
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream; charset=utf-8',
          body: 'data: {"event":"agent_message","conversation_id":"conv-real-1","answer":"Proxy answer <img src=x onerror=alert(1)> [ext](https://example.com) [bad](javascript:alert(1))"}\n\ndata: {"event":"message_end","conversation_id":"conv-real-1","metadata":{"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}}\n\n',
        })
      },
    )

    await page.route(
      (u) => u.pathname.startsWith('/api/db/sessions') || u.pathname.startsWith('/api/db/messages'),
      async (route) => {
        const method = route.request().method()
        if (method !== 'GET') {
          if (dbFail) {
            await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'db_error' }) })
            return
          }
          dbWrites.push({ url: route.request().url(), method })
          await route.fulfill({ status: 201, contentType: 'application/json', body: route.request().postData() || '{}' })
          return
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      },
    )

    await gotoAndSettle(page, `${LECTURE}?debug=1`)

    // Closed shell must be inert (FE-022)
    await expect(page.locator('.ai-sidebar-shell')).toHaveAttribute('inert', '')

    // Open with Alt+A (FE-021) and focus textarea (FE-018)
    await page.keyboard.press('Alt+a')
    await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()
    await expect(page.locator('.chat-textarea')).toBeFocused()

    // Distinct "unconfigured" status when /api/health reports checks.ai === 'off'
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'unconfigured')
    await expect(page.locator('[data-ai-source] svg')).toHaveCount(1)

    // Switch health to down -> "unavailable"
    healthMode = 'down'
    await page.keyboard.press('Escape')
    await page.keyboard.press('Alt+a')
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'unavailable')

    // Feature flags default off (FE-010 / FE-011)
    await expect(page.locator('.scope-chips-bar')).toHaveCount(0)
    await expect(page.locator('input[type="file"][accept=".pptx"]')).toHaveCount(0)

    await page.evaluate(() => {
      const dbg = (window as unknown as { __LECTURE_DEBUG__?: { flags: { set: (k: string, v: boolean) => void } } }).__LECTURE_DEBUG__
      dbg?.flags.set('aiScope', true)
      dbg?.flags.set('aiUpload', true)
    })
    await expect(page.locator('.scope-chips-bar')).toBeVisible()
    await expect(page.locator('input[type="file"][accept=".pptx"]')).toBeAttached()

    // 429 rate-limit -> badge shows rate-limited countdown + error bubble + zero DB writes
    healthMode = 'ok'
    await page.locator('.chat-textarea').fill('Hello companion')
    await page.locator('.send-btn').click()
    await expect(page.locator('[data-ai-error-bubble]')).toBeVisible()
    await expect(page.locator('[data-ai-error-bubble]')).toContainText('9')
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'rate-limited')
    expect(dbWrites).toHaveLength(0)

    // 413 payload too large
    chatMode = '413'
    await page.locator('[data-ai-retry]').click()
    await expect(page.locator('[data-ai-error-bubble]')).toBeVisible()
    expect(dbWrites).toHaveLength(0)

    // 403 anonymous disabled
    chatMode = '403'
    await page.locator('[data-ai-retry]').click()
    await expect(page.locator('[data-ai-error-bubble]')).toBeVisible()
    expect(dbWrites).toHaveLength(0)

    // SSE event: error mid-stream -> marked incomplete, Retry visible, zero DB writes
    chatMode = 'sse_err'
    await page.locator('[data-ai-retry]').click()
    await expect(page.locator('[data-ai-incomplete="1"]')).toBeVisible()
    expect(dbWrites).toHaveLength(0)

    // SSE clean EOF without terminal message_end -> marked incomplete, zero DB writes
    chatMode = 'eof_cut'
    await page.locator('[data-ai-retry]').click()
    await expect(page.locator('[data-ai-incomplete="1"]')).toBeVisible()
    expect(dbWrites).toHaveLength(0)

    // DB non-2xx failure does not fake local session storage
    chatMode = 'ok'
    dbFail = true
    await page.locator('[data-ai-retry]').click()
    await expect(page.locator('.assistant-body')).toContainText('Proxy answer')
    await expect(page.locator('.ai-toast-item')).toBeVisible()
    // a session-list key may exist as the cache of the (empty) GET answer; nothing the failed write carried may be in it
    const storedAfterFail = await page.evaluate(() =>
      Object.entries(localStorage)
        .filter(([k, v]) => k.startsWith('tut_neon_') && !(k.startsWith('tut_neon_sessions_') && v === '[]'))
        .map(([k]) => k),
    )
    expect(storedAfterFail).toEqual([])

    // Retry with DB healthy -> complete answer sanitized in real Chromium + persisted
    dbFail = false
    await page.locator('.chat-textarea').fill('Fresh question')
    await page.locator('.send-btn').click()
    await expect.poll(() => dbWrites.length).toBe(3)
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'ok')

    // Real Chromium DOMPurify verification: zero <img>, rel="noopener noreferrer" on link, javascript: stripped
    await expect(page.locator('.assistant-body img')).toHaveCount(0)
    const extLink = page.locator('.assistant-body a[href="https://example.com"]').last()
    await expect(extLink).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(extLink).toHaveAttribute('target', '_blank')
    await expect(page.locator('.assistant-body a[href^="javascript:"]')).toHaveCount(0)

    // History drawer: Esc closes + draft does not pre-write to DB (FE-009 / FE-019)
    const writesBeforeDraft = dbWrites.length
    await page.locator('.header-action-btn[aria-label]').first().click()
    const drawer = page.locator('.session-history-drawer[role="dialog"]')
    await expect(drawer).toBeVisible()
    await drawer.locator('.action-create').click()
    expect(dbWrites.length).toBe(writesBeforeDraft)
    await page.locator('.header-action-btn[aria-label]').first().click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)

    // Close sidebar restores focus to trigger tab
    await page.keyboard.press('Escape')
    await expect(page.locator('.ai-trigger-tab')).toBeFocused()
  })

  test('BYOK security: unchecked remember stays memory-only, HTTPS enforced, verify status, uncheck wipes storage, and /api/* never sees key', async ({ page }) => {
    const apiRequestsSeen: Array<{ path: string; body: string; auth: string }> = []
    let verifyStatus = 401

    await page.route('**/api/**', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      apiRequestsSeen.push({
        path: url.pathname,
        body: req.postData() || '',
        auth: req.headers()['authorization'] || '',
      })
      if (url.pathname === '/api/health') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, checks: { db: 'ok', ai: 'ok', notion: 'off' } }) })
        return
      }
      if (url.pathname.startsWith('/api/db/')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        return
      }
      // everything else goes to the fixtures' /api mock (never the network: the e2e server has no backend)
      await route.fallback()
    })

    await page.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
      const post = route.request().postData() || ''
      if (post.includes('"max_tokens":1')) {
        if (verifyStatus !== 200) {
          await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"invalid_key"}' })
          return
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"id":"probe"}' })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: 'data: {"choices":[{"delta":{"content":"BYOK reply ok"}}]}\n\ndata: [DONE]\n\n',
      })
    })

    await gotoAndSettle(page, `${LECTURE}?debug=1`)

    await page.locator('[data-lec-settings-btn]').click()
    const byokDetails = page.locator('[data-lec-setting="byok"] details')
    await byokDetails.locator('summary').click()

    // Remember toggle defaults to UNCHECKED
    const rememberBox = page.locator('[data-lec-byok-remember]')
    await expect(rememberBox).not.toBeChecked()

    // Reject http:// endpoints
    await page.locator('[data-lec-byok-enable]').check()
    await page.locator('[data-lec-byok-url]').fill('http://openrouter.ai/api/v1')
    await expect(page.locator('[data-lec-byok-https-err]')).toBeVisible()
    await expect(page.locator('[data-lec-settings-save]')).toBeDisabled()

    // Valid https:// shows full endpoint preview
    await page.locator('[data-lec-byok-url]').fill('https://openrouter.ai/api/v1')
    await expect(page.locator('[data-lec-byok-endpoint]')).toContainText('https://openrouter.ai/api/v1/chat/completions')
    await page.locator('[data-lec-byok-key]').fill('sk-byok-secret')
    await page.locator('[data-lec-byok-model]').fill('gpt-4o-mini')

    // Real verify probe: failed -> ok
    await expect(page.locator('[data-lec-byok-status]')).toHaveAttribute('data-lec-byok-verify', 'unverified')
    await page.locator('[data-lec-byok-test]').click()
    await expect(page.locator('[data-lec-byok-status]')).toHaveAttribute('data-lec-byok-verify', 'failed')
    verifyStatus = 200
    await page.locator('[data-lec-byok-test]').click()
    await expect(page.locator('[data-lec-byok-status]')).toHaveAttribute('data-lec-byok-verify', 'ok')

    // Save with remember UNCHECKED -> neither localStorage nor sessionStorage stores key
    await page.locator('[data-lec-settings-save]').click()
    const storageCheckMem = await page.evaluate(() => ({
      ls: localStorage.getItem('lecture:companion-byok'),
      ss: sessionStorage.getItem('lecture:companion-byok'),
    }))
    expect(storageCheckMem.ls).toBeNull()
    expect(storageCheckMem.ss).toBeNull()

    // Send direct BYOK chat using memory key
    await page.keyboard.press('Alt+a')
    await expect(page.locator('[data-ai-source]')).toHaveAttribute('data-ai-status', 'byok-ok')
    await page.locator('.chat-textarea').fill('Explain ON vs WHERE')
    await page.locator('.send-btn').click()
    await expect(page.locator('.assistant-body')).toContainText('BYOK reply ok')
    await expect(page.locator('input[type="file"][accept=".pptx"]')).toHaveCount(0)

    // Check remember -> persists in localStorage; uncheck remember -> deleted
    await page.keyboard.press('Escape')
    await page.locator('[data-lec-settings-btn]').click()
    await page.locator('[data-lec-byok-remember]').check()
    await page.locator('[data-lec-settings-save]').click()
    expect(await page.evaluate(() => localStorage.getItem('lecture:companion-byok'))).toContain('sk-byok-secret')

    await page.locator('[data-lec-settings-btn]').click()
    await page.locator('[data-lec-byok-remember]').uncheck()
    await page.locator('[data-lec-settings-save]').click()
    expect(await page.evaluate(() => localStorage.getItem('lecture:companion-byok'))).toBeNull()
    expect(await page.evaluate(() => sessionStorage.getItem('lecture:companion-byok'))).toBeNull()

    // Verify ZERO /api/* requests ever carried the BYOK key or Bearer header
    for (const r of apiRequestsSeen) {
      expect(r.body).not.toContain('sk-byok-secret')
      expect(r.auth).not.toContain('sk-byok-secret')
    }
  })

  test('Notion sync control hidden from non-admins and reports failures for admins (D-11)', async ({ page }) => {
    const notionRequests: string[] = []
    await page.route('**/api/db/progress**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    })
    await page.route(/\/api\/(progress\/notion-sync|notion\/sync-status)$/, async (route) => {
      notionRequests.push(route.request().url())
      await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"notion_down"}' })
    })

    // Non-admin reader (default session fixture)
    await gotoAndSettle(page, NOT_STARTED_LECTURE)
    await expect(page.locator('[data-lpc-notion-control]')).toHaveCount(0)
    await page.locator('.lpc-primary-btn').click()
    expect(notionRequests).toHaveLength(0)

    // Admin sees Notion sync control and receives explicit failure status + Retry on 502
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authenticated: true,
          user: { id: 'admin-1', name: 'Admin', email: 'admin@example.com' },
          roles: ['admin'],
          groups: ['admin'],
          logoutUrl: null,
        }),
      }),
    )
    await gotoAndSettle(page, NOT_STARTED_LECTURE)
    await expect(page.locator('[data-lpc-notion-control]')).toBeVisible()
    await page.locator('.lpc-primary-btn').click()
    await expect.poll(() => notionRequests.length).toBeGreaterThanOrEqual(1)
    await expect(page.locator('[data-lpc-notion-error]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-lpc-notion-retry]')).toBeVisible()
  })

  test('mobile 390px trigger button is clickable without pointer interception (FE-020)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await gotoAndSettle(page, `${LECTURE}?debug=1`)
    const trigger = page.locator('.ai-trigger-tab')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.locator('.ai-sidebar-shell.is-open')).toBeVisible()
  })
})
