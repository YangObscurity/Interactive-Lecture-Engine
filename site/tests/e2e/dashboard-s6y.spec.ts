/**
 * S6Y Dashboard fixes (audit-dashboard.md, packages A–C): each test pins one finding of the audit against the
 * prototype (`Dashboard 原型.html` v3.4) or the spec board §dashboard. Online tests mock the session and the admin
 * API with page.route (like dashboard.spec.ts); local tests run on the dev server (demo copy, writes land in the copy).
 */
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const ADMIN = {
  authenticated: true,
  user: { id: 'alice', name: 'Alice', email: 'alice@example.com' },
  roles: ['reader', 'admin'],
  groups: ['admins'],
  logoutUrl: null,
}
const SIGNED_OUT = { authenticated: false, user: null, roles: [], groups: [], logoutUrl: null }

async function session(page: Page, body: unknown, status = 200): Promise<void> {
  await page.context().route('**/api/auth/session', (route) =>
    route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) }),
  )
}
async function open(page: Page, hash = ''): Promise<void> {
  await page.goto(`/dashboard${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
}
const onlineOnly = () => test.skip(test.info().project.name === 'dev', 'online (session-gated) mode exists only on the built site')
const devOnly = () => test.skip(test.info().project.name !== 'dev', 'local author mode exists only on the dev server')

test.describe('S6Y Dashboard: online read-only', () => {
  test.beforeEach(onlineOnly)

  // audit #3 (high): prototype — "拿不到检测结果时，标出失败/未知并给原因"
  test('admin API 500: overview lists a failure item with retry, nav marks runtime, no "all healthy"', async ({ page, pageErrors }) => {
    await session(page, ADMIN)
    let adminCalls = 0
    await page.context().route('**/api/admin/*', (route) => {
      adminCalls++
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' })
    })
    await open(page)
    const todo = page.locator('[data-overview-todo]')
    await expect(todo.locator('[data-todo="admin-error"]')).toBeVisible()
    await expect(todo.locator('[data-todo="admin-error"]')).toContainText('HTTP 500')
    await expect(todo.locator('.db-empty')).toHaveCount(0)
    await expect(page.locator('[data-overview-figtodo] b')).not.toHaveText('0')
    await expect(page.locator('[data-dashboard-tab="runtime"] .db-navc .dm[data-k="bad"]')).toBeVisible()
    const before = adminCalls
    await todo.locator('[data-todo="admin-error"] [data-todo-retry]').click()
    await expect.poll(() => adminCalls).toBeGreaterThan(before)
    expect(pageErrors).toEqual([])
  })

  // audit #25 (medium): plan p65 §WP-D2 "展示权限说明 / 登录提示"
  for (const [name, body, status] of [
    ['signed out ({authenticated:false})', SIGNED_OUT, 200],
    ['expired sign-in (401)', { error: 'unauthorized' }, 401],
  ] as const) {
    test(`${name}: sign-in prompt with a sign-in entry, no admin requests`, async ({ page }) => {
      await session(page, body, status)
      const admin: string[] = []
      await page.context().route('**/api/admin/*', (route) => {
        admin.push(route.request().url())
        return route.fulfill({ status: 403, body: '{}' })
      })
      await open(page)
      const gate = page.locator('[data-dashboard-gate="signin"]')
      await expect(gate).toBeVisible()
      await expect(gate.locator('[data-dashboard-login]')).toBeVisible()
      await expect(gate.locator('[data-dashboard-login]')).not.toHaveText('')
      expect(admin).toEqual([])
    })
  }

  // audit #2 (high): prototype — tint options carry a name, apply at once and are remembered
  test('look › preview: every tint button has a name; clicking applies data-lec-tint and persists', async ({ page, pageErrors }) => {
    await session(page, ADMIN)
    await open(page, '#look:theme')
    await page.locator('[data-dashboard-theme-btn="reader"]').click()
    const tints = page.locator('[data-look-preview] [data-look-tint]')
    expect(await tints.count()).toBeGreaterThanOrEqual(2)
    for (const txt of await tints.allTextContents()) expect(txt.trim()).not.toBe('')
    const other = page.locator('[data-look-preview] [data-look-tint]:not([data-look-tint="light"])').first()
    const id = (await other.getAttribute('data-look-tint')) ?? ''
    expect(id).not.toBe('')
    await other.click()
    await expect(page.locator('html')).toHaveAttribute('data-lec-tint', id)
    await expect(other).toHaveAttribute('aria-pressed', 'true')
    const stored = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.endsWith('reader-prefs'))?.[1] ?? '')
    expect(JSON.parse(stored)).toMatchObject({ theme: 'reader', tint: id })
    await page.locator('[data-look-preview] [data-look-tint="light"]').click()
    await expect(page.locator('html')).not.toHaveAttribute('data-lec-tint', /.+/)
    expect(pageErrors).toEqual([])
  })

  // S6Y decision (21:47): limits stay read-only; without runtime numbers say where they come from and how to change them
  test('companion › usage online: limits show their source (server/.env) and how to change them', async ({ page }) => {
    await session(page, ADMIN)
    await open(page, '#companion:usage')
    const src = page.locator('[data-companion-limits] [data-companion-limits-source]')
    await expect(src).toBeVisible()
    await expect(src).toContainText('server/.env')
    for (const key of ['AI_DAILY_LIMIT', 'AI_RATE_PER_MINUTE', 'AI_MAX_CONCURRENT']) await expect(src).toContainText(key)
    await expect(page.locator('[data-companion-limits] input')).toHaveCount(0)
  })

  // audit #4 (medium): prototype — pages are `#page` links, the browser Back button returns to the previous page
  test('browser Back returns to the previous Dashboard page', async ({ page }) => {
    await session(page, ADMIN)
    await open(page)
    await page.locator('[data-dashboard-tab="checks"]').click()
    await expect(page).toHaveURL(/#checks$/)
    await page.locator('[data-dashboard-tab="texts"]').click()
    await expect(page).toHaveURL(/#texts$/)
    await page.goBack()
    await expect(page).toHaveURL(/#checks$/)
    await expect(page.locator('[data-dashboard-pane="checks"]')).toBeVisible()
    await page.goBack()
    await expect(page.locator('[data-dashboard-pane="overview"]')).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard$/)
  })
})

test.describe('S6Y Dashboard: local author mode', () => {
  test.beforeEach(devOnly)

  // audit #1 (high): prototype — saving stays in place with "已保存 …"; other drafts on the page are kept
  test('saving the system prompt and the quick actions does not reload; status keeps the version; tool drafts survive', async ({ page, pageErrors }) => {
    await open(page, '#companion:tools')
    await page.locator('[data-tool-switch="search_lectures"]').click()
    await expect(page.locator('[data-tools-save]')).toBeEnabled()
    await page.evaluate(() => ((window as unknown as { __s6yMark?: number }).__s6yMark = 1))

    await page.locator('[data-dashboard-subtab="prompt"]').click()
    const editor = page.locator('[data-companion-system] [data-pe] [contenteditable="true"]').first()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' s6y')
    await page.locator('[data-companion-save]').click()
    const status = page.locator('[data-companion-status]')
    await expect(status).toContainText(/v\d+/)
    await page.waitForTimeout(2500) // a reload (Vite full-reload after the file watcher) would come within this time
    await expect(status).toContainText(/v\d+/)
    expect(await page.evaluate(() => (window as unknown as { __s6yMark?: number }).__s6yMark)).toBe(1)

    await page.locator('[data-dashboard-subtab="actions"]').click()
    await page.locator('[data-qa-handle="0"]').focus()
    await page.keyboard.press('ArrowDown')
    await page.locator('[data-companion-save]').click()
    await expect(status).toContainText(/v\d+/)
    await page.waitForTimeout(2500)
    await expect(status).toContainText(/v\d+/)
    expect(await page.evaluate(() => (window as unknown as { __s6yMark?: number }).__s6yMark)).toBe(1)

    await page.locator('[data-dashboard-subtab="tools"]').click()
    await expect(page.locator('[data-tools-save]')).toBeEnabled()
    await page.locator('[data-tools-discard]').click()
    expect(pageErrors).toEqual([])
  })

  // audit #5 (medium): prototype keydown (line 1408): Backspace right after a block removes the block at once
  test('placeholder editor: one Backspace removes a typed block', async ({ page }) => {
    await open(page, '#companion:prompt')
    const editor = page.locator('[data-companion-system] [data-pe] [contenteditable="true"]').first()
    const chips = page.locator('[data-companion-system] [contenteditable="true"] .pe-chip[data-ph="lecture"]')
    const before = await chips.count()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' {lecture}')
    await expect(chips).toHaveCount(before + 1)
    await page.keyboard.press('Backspace')
    await expect(chips).toHaveCount(before)
    await page.locator('[data-companion-discard]').click()
  })

  // audit #6 (medium): spec board §dashboard 验收 8 — over the limit the field says 「超出上限」
  test('site texts: an over-long value says "over the limit"', async ({ page }) => {
    await open(page, '#texts')
    const meta = page.locator('[data-texts-rule="zh.name"]')
    const max = Number(/\/\s*(\d+)/.exec((await meta.textContent()) ?? '')?.[1] ?? '60')
    await page.locator('input[data-texts-input="zh.name"]').fill('x'.repeat(max + 20))
    await expect(meta).toContainText('超出上限')
    await expect(meta.locator('[data-texts-over]')).toBeVisible()
    await expect(page.locator('[data-texts-save-btn]')).toBeDisabled()
    await page.locator('[data-texts-discard]').click()
    await expect(meta.locator('[data-texts-over]')).toHaveCount(0)
  })

  // audit #7 (medium): prototype — times in the page language's short form (`11-21 15:58`)
  test('content checks: "last run" in the short local format', async ({ page }) => {
    await page.route(
      (u) => u.pathname === '/__lecture/api/check',
      (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                run: {
                  at: '2026-11-21T07:58:00.000Z',
                  ms: 1200,
                  exitCode: 0,
                  report: { mode: 'content', root: '', counts: { groups: 1, lectures: 1, translations: 0, charts: 0, concepts: 0, figures: 0 }, totals: { fail: 0, warn: 0, info: 0 }, issues: [], ok: true },
                },
              }),
            })
          : route.fallback(),
    )
    await open(page, '#checks')
    const head = page.locator('[data-page="checks"] .db-ph')
    await expect(head).toContainText('11-21 15:58')
    await expect(head).not.toContainText(/AM|PM|\d+\/\d+\/\d{4}/)
  })

  // audit #8 (medium): while the checks still run, the overview must not say "no failures"
  test('overview while checks run: a running state, not "no failures"', async ({ page }) => {
    await page.route(
      (u) => u.pathname === '/__lecture/api/check',
      async (route) => {
        if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"run":null}' })
        await new Promise((r) => setTimeout(r, 20_000))
        return route.abort().catch(() => undefined)
      },
    )
    await open(page)
    const todo = page.locator('[data-overview-todo]')
    await expect(todo.locator('[data-overview-todo-running]')).toBeVisible()
    await expect(todo).not.toContainText('没有失败项')
    await expect(todo).not.toContainText('没有待处理的事项')
  })

  // audit #9 (medium): no SITE_URL in the demo — a readable note instead of the raw English exception
  test('access › gateway rules without SITE_URL: a note on how to set it, no raw error', async ({ page }) => {
    await open(page, '#access')
    const rules = page.locator('[data-access-rules]')
    await expect(rules).toBeVisible()
    await expect(rules).not.toContainText('Unable to generate')
    await expect(rules).not.toContainText('requires --domain')
    await expect(rules.locator('[data-access-rules-note]')).toContainText('SITE_URL')
  })

  // audit #24 (medium): prototype — the tools table fits its panel (no column cut off by the panel edge)
  test('companion › tools: the engine tool table fits its panel', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await open(page, '#companion:tools')
    const panel = page.locator('[data-tools-engine]')
    const lastTh = panel.locator('thead th').last()
    await expect(lastTh).toBeVisible()
    const p = await panel.boundingBox()
    const th = await lastTh.boundingBox()
    expect(p && th).toBeTruthy()
    expect((th?.x ?? 0) + (th?.width ?? 0)).toBeLessThanOrEqual((p?.x ?? 0) + (p?.width ?? 0) + 1)
  })

  // audit #30 (low): prototype — a new quick action puts the focus into its name field
  test('companion › actions: "add" focuses the new action name', async ({ page }) => {
    await open(page, '#companion:actions')
    const n = await page.locator('[data-qa]').count()
    await page.locator('[data-qa-add]').click()
    await expect(page.locator(`[data-qa-label="${n}.zh"]`)).toBeFocused()
    await page.locator('[data-companion-discard]').click()
  })
})
