/**
 * S4b Dashboard (prototype v3.4) in local author mode (`vitepress dev`): navigation and URL hash, unsaved marks and
 * the leave prompt, placeholder chips, quick-action reordering by keyboard, the terminal log, companion > tools,
 * and the write boundary (no token, no write). Nothing is saved: every edit is discarded again.
 */
import { expect, test } from './fixtures'

test.describe('S4b Dashboard v3.4 (local author mode)', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'dev', 'Local author mode exists only on the dev server')
  })

  test('nine pages, page and tab in the hash, unsaved mark and leave prompt', async ({ page, pageErrors }) => {
    await page.goto('/dashboard#companion:actions', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('.lec-dashboard')).toHaveAttribute('data-dashboard-mode', 'dev')
    await expect(page.locator('[data-dashboard-tab]')).toHaveCount(9)
    await expect(page.locator('[data-dashboard-subtab="actions"]')).toHaveAttribute('aria-selected', 'true')

    await page.locator('[data-dashboard-tab="texts"]').click()
    await expect(page).toHaveURL(/#texts$/)
    const name = page.locator('input[data-texts-input="zh.name"]')
    await expect(name).toBeVisible()
    const before = await name.inputValue()
    await name.fill(`${before} e2e`)
    await expect(page.locator('[data-dashboard-tab="texts"] [data-nav-unsaved]')).toBeVisible()

    // leaving asks: stay keeps the page and the edit
    await page.locator('[data-dashboard-tab="overview"]').click()
    await expect(page.locator('dialog.db-dlg [data-dlg-btn="stay"]')).toBeVisible()
    await page.locator('dialog.db-dlg [data-dlg-btn="stay"]').click()
    await expect(page.locator('[data-dashboard-pane="texts"]')).toBeVisible()
    await expect(name).toHaveValue(`${before} e2e`)

    // discard: the mark goes away and the value is back
    await page.locator('[data-texts-discard]').click()
    await expect(name).toHaveValue(before)
    await expect(page.locator('[data-nav-unsaved]')).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test('placeholder chips: typed {lecture} becomes a chip, unknown tokens are flagged; quick actions reorder by keyboard', async ({ page, pageErrors }) => {
    await page.goto('/dashboard#companion:prompt', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    const editor = page.locator('[data-companion-system] [data-pe] [contenteditable="true"]').first()
    await expect(editor).toBeVisible()
    const chips = page.locator('[data-companion-system] [contenteditable="true"] .pe-chip[data-ph="lecture"]')
    const chipsBefore = await chips.count()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' {lecture} {nope}')
    await expect(page.locator('[data-companion-system] [data-pe-unknown]')).toContainText('{nope}')
    await expect(chips).toHaveCount(chipsBefore + 1)
    await page.locator('[data-companion-discard]').click()
    await expect(page.locator('[data-companion-system] [data-pe-unknown]')).toHaveCount(0)

    await page.locator('[data-dashboard-subtab="actions"]').click()
    const firstName = async () => (await page.locator('.db-qa-name b').first().textContent())?.trim() ?? ''
    const secondName = (await page.locator('.db-qa-name b').nth(1).textContent())?.trim() ?? ''
    await page.locator('[data-qa-handle="0"]').focus()
    await page.keyboard.press('ArrowDown')
    await expect.poll(firstName).toBe(secondName)
    await expect(page.locator('[data-dashboard-tab="companion"] [data-nav-unsaved]')).toBeVisible()
    await page.locator('[data-companion-discard]').click()
    await expect(page.locator('[data-nav-unsaved]')).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })

  test('terminal log, sync tab and companion tools; writes need the dev token', async ({ page, pageErrors }) => {
    await page.goto('/dashboard#runtime:logs', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('[data-log-term]')).toBeVisible()
    await expect(page.locator('[data-log-src]')).toHaveCount(5)
    await page.locator('[data-log-pause]').click()
    await expect(page.locator('[data-log-pause]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[data-dashboard-subtab="sync"]').click()
    await expect(page.locator('[data-runtime-sync]')).toBeVisible()

    await page.goto('/dashboard#companion:tools', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('[data-tool-switch]')).toHaveCount(5)
    await page.locator('[data-tool-switch="search_lectures"]').click()
    await expect(page.locator('[data-tools-save]')).toBeEnabled()
    await page.locator('[data-tools-discard]').click()
    await expect(page.locator('[data-tools-save]')).toBeDisabled()
    await expect(page.locator('[data-dashboard-unavailable="tools-log"]')).toBeVisible()

    // the browser cannot write or read file contents without the per-process token
    const statuses = await page.evaluate(async () => {
      const api = ['/__lecture', '/api'].join('')
      const r1 = await fetch(`${api}/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"engine":{"search_lectures":false}}' })
      const r2 = await fetch(`${api}/file?path=groups.ts`)
      const r3 = await fetch(`${api}/logs?after=0`)
      return [r1.status, r2.status, r3.status]
    })
    expect(statuses).toEqual([403, 403, 403])
    expect(pageErrors).toEqual([])
  })

  test('overview: build and deployment in three rows; content checks: rerun one category posts only that category', async ({ page, pageErrors }) => {
    test.setTimeout(240_000)
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('[data-overview-build-row]')).toHaveCount(3)
    await expect(page.locator('[data-overview-build-row="deploy"]')).not.toBeEmpty()
    await expect(page.locator('[data-overview-buildlog]')).toBeVisible()

    await page.locator('[data-dashboard-tab="checks"]').click()
    const rerun = page.locator('[data-checks-rerun-cat="graph"]')
    await expect(rerun).toBeEnabled({ timeout: 180_000 }) // after the first full run
    const [req] = await Promise.all([
      page.waitForRequest((r) => r.url().endsWith('/__lecture/api/check') && r.method() === 'POST'),
      rerun.click(),
    ])
    expect(req.postDataJSON()).toEqual({ only: ['graph'] })
    await expect(rerun).toBeEnabled({ timeout: 60_000 })
    // every listed problem has its own "rerun this check" (inside the code groups)
    expect(await page.locator('[data-checks-rerun-one]').count()).toBeGreaterThan(0)
    expect(pageErrors).toEqual([])
  })
})
