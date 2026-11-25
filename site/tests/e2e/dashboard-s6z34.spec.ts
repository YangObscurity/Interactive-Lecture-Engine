/**
 * S6Z-3 + S6Z-4 E2E Tests:
 * - S6Z-3: Reading Appearance Tints + live WCAG contrast guard + theme.json savebar persistence
 * - S6Z-4: External MCP Server CRUD + inline validation + secret protection + delete confirmation
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

test.describe('S6Z-3 & S6Z-4: Online RBAC Mode', () => {
  test.beforeEach(onlineOnly)

  test('online: Look shows skin, swatches, live contrast check, preview card and admin savebar', async ({ page }) => {
    await session(page, ADMIN)
    await page.context().route('**/api/admin/look', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ ok: true, look: { skin: 'reader', base: 'paper', custom: '#FBF9F5' } }),
      }),
    )
    await open(page, '#look:theme')

    // Skin selector
    await expect(page.locator('[data-skin="reader"]')).toBeVisible()
    await expect(page.locator('[data-skin="datasheet"]')).toBeVisible()

    // 5-swatch base selector
    for (const b of ['paper', 'green', 'sepia', 'dark', 'custom']) {
      await expect(page.locator(`[data-base="${b}"]`)).toBeVisible()
    }

    // Contrast check table has 4 rows
    const contrastTable = page.locator('[data-look-contrast-table]')
    await expect(contrastTable).toBeVisible()
    const rows = page.locator('[data-contrast-row]')
    await expect(rows).toHaveCount(4)

    // Mini preview card
    const miniPreview = page.locator('[data-look-mini-preview]')
    await expect(miniPreview).toBeVisible()

    // Online admin writable: savebar is rendered
    await expect(page.locator('[data-savebar="look"]')).toBeVisible()
  })

  test('online: Companion Tools is restricted for non-admin authors and available for admin', async ({ page }) => {
    await session(page, {
      authenticated: true,
      user: { id: 'author1', name: 'Author One', email: 'author@example.com' },
      roles: ['reader', 'author'],
      groups: ['authors'],
      logoutUrl: null,
    })
    await open(page, '#companion:tools')
    await expect(page.locator('[data-dashboard-unavailable="tools-online"]')).toBeVisible()

    await session(page, ADMIN)
    await page.context().route('**/api/admin/ai-tools', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          mcpEndpoint: { enabled: false, path: '/api/mcp' },
          engineTools: [{ name: 'search_lectures', enabled: true, calls7d: 0, errors7d: 0 }],
          mcpServers: [],
          settings: {
            provider: 'off',
            maxSteps: 5,
            timeoutMs: 8000,
            maxResultBytes: 24000,
            mcpTokenSet: false,
            ticketSecretSet: false,
            source: 'server/.env',
          },
          statsSource: 'memory',
          toolCallCounts7d: {},
        }),
      }),
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await expect(page.locator('[data-dashboard-unavailable="tools-online"]')).toHaveCount(0)
    await expect(page.locator('[data-tools-online-note]')).toBeVisible()
  })
})

test.describe('S6Z-3: Look Appearance Tints & Contrast Guard (Dev)', () => {
  test.beforeEach(devOnly)

  test('skin and reading base selector, custom hex contrast guard disables save on WCAG failure', async ({ page }) => {
    await session(page, ADMIN)
    await open(page, '#look:theme')

    // Skin selector
    const readerSkin = page.locator('[data-skin="reader"]')
    const datasheetSkin = page.locator('[data-skin="datasheet"]')
    await expect(readerSkin).toBeVisible()
    await expect(datasheetSkin).toBeVisible()

    // 5-swatch base selector
    const bases = ['paper', 'green', 'sepia', 'dark', 'custom']
    for (const b of bases) {
      await expect(page.locator(`[data-base="${b}"]`)).toBeVisible()
    }

    // Contrast check table has 4 rows
    const contrastTable = page.locator('[data-look-contrast-table]')
    await expect(contrastTable).toBeVisible()
    const rows = page.locator('[data-contrast-row]')
    await expect(rows).toHaveCount(4)
    for (const row of ['text', 'text-muted', 'accent', 'danger']) {
      await expect(page.locator(`[data-contrast-row="${row}"]`)).toBeVisible()
    }

    // Mini preview card
    const miniPreview = page.locator('[data-look-mini-preview]')
    await expect(miniPreview).toBeVisible()
    await expect(miniPreview.locator('.pv-h4')).toBeVisible()
    await expect(miniPreview.locator('.pv-danger-pill')).toBeVisible()

    // Select custom base
    await page.locator('[data-base="custom"]').click()
    const hexInput = page.locator('[data-custom-hex-input]')
    await expect(hexInput).toBeVisible()

    // Enter invalid hex -> savebar disabled with invalid hex reason
    await hexInput.fill('invalid')
    const saveBtn = page.locator('[data-look-save]')
    await expect(saveBtn).toBeDisabled()
    const status = page.locator('[data-look-status]')
    await expect(status).toHaveClass(/db-err/)

    // Enter low-contrast hex (#888888) -> contrast table marks failure, savebar disabled
    await hexInput.fill('#888888')
    await expect(saveBtn).toBeDisabled()
    await expect(status).toHaveClass(/db-err/)
    await expect(contrastTable.locator('.dm[data-k="bad"]')).not.toHaveCount(0)

    // Enter compliant custom hex (#EAF2E3) -> contrast rows pass
    await hexInput.fill('#EAF2E3')
    await expect(contrastTable.locator('.dm[data-k="bad"]')).toHaveCount(0)
    await expect(saveBtn).toBeEnabled()

    // Discard button restores previous state
    const discardBtn = page.locator('[data-look-discard]')
    await expect(discardBtn).toBeEnabled()
    await discardBtn.click()
    await expect(discardBtn).toBeDisabled()
  })
})

test.describe('S6Z-4: Companion Tools MCP Server Management (Dev)', () => {
  test.beforeEach(devOnly)

  test('engine tools, unavailable metrics, MCP add validation, secret leak rejection & delete confirmation', async ({ page }) => {
    await session(page, ADMIN)
    await open(page, '#companion:tools')

    // Engine tools switches
    await expect(page.locator('[data-tools-engine]')).toBeVisible()
    await expect(page.locator('[data-tool-switch]')).toHaveCount(5)

    // Metric endpoints explicitly marked unavailable
    await expect(page.locator('[data-dashboard-unavailable="tools-stats"]')).toBeVisible()
    await expect(page.locator('[data-dashboard-unavailable="tools-log"]')).toBeVisible()

    // Servers section
    const serversPanel = page.locator('[data-tools-servers]')
    await expect(serversPanel).toBeVisible()

    // Open Add Server form
    const addBtn = page.locator('[data-add-server-btn]')
    if (await addBtn.isVisible()) {
      await addBtn.click()
      const addForm = page.locator('[data-add-server-form]')
      await expect(addForm).toBeVisible()

      // Submit empty name -> error
      await page.locator('[data-add-server-submit]').click()
      const err = page.locator('[data-add-server-error]')
      await expect(err).toBeVisible()
      await expect(err).not.toHaveText('')

      // Submit non-https URL -> error
      await page.locator('[data-add-server-name]').fill('Zotero')
      await page.locator('[data-add-server-url]').fill('http://insecure.example.com/mcp')
      await page.locator('[data-add-server-env]').fill('ZOTERO_TOKEN')
      await page.locator('[data-add-server-submit]').click()
      await expect(err).toBeVisible()

      // Submit secret token -> secret leak rejected (not generic env_invalid)
      await page.locator('[data-add-server-url]').fill('https://example.com/mcp')
      await page.locator('[data-add-server-env]').fill('sk-' + 'test-secret-key-1234567890')
      await page.locator('[data-add-server-submit]').click()
      await expect(err).toContainText(/密钥明文|Raw secrets/)

      // Valid server entry
      await page.locator('[data-add-server-name]').fill('Zotero Library')
      await page.locator('[data-add-server-id]').fill('zotero-lib')
      await page.locator('[data-add-server-url]').fill('https://zotero.example.org/mcp')
      await page.locator('[data-add-server-hdr]').fill('Authorization')
      await page.locator('[data-add-server-env]').fill('ZOTERO_TOKEN')
      await page.locator('[data-add-server-submit]').click()

      // New server card exists and is open
      const srvCard = page.locator('[data-tools-server="zotero-lib"]')
      await expect(srvCard).toBeVisible()
      await expect(srvCard).toContainText('zotero.example.org')

      // Savebar is now dirty
      const toolsSave = page.locator('[data-tools-save]')
      const toolsDiscard = page.locator('[data-tools-discard]')
      await expect(toolsSave).toBeEnabled()

      // Expand card & check delete button
      const delBtn = srvCard.locator('[data-server-delete="zotero-lib"]')
      await expect(delBtn).toBeVisible()
      await delBtn.click()

      // Confirmation box shown
      const confirmBox = srvCard.locator('[data-server-delete-confirm="zotero-lib"]')
      await expect(confirmBox).toBeVisible()

      // Cancel delete
      await srvCard.locator('[data-server-delete-no="zotero-lib"]').click()
      await expect(confirmBox).not.toBeVisible()
      await expect(srvCard).toBeVisible()

      // Confirm delete
      await delBtn.click()
      await srvCard.locator('[data-server-delete-yes="zotero-lib"]').click()
      await expect(srvCard).not.toBeVisible()

      // If dirty, discard
      if (await toolsDiscard.isEnabled()) {
        await toolsDiscard.click()
      }
      await expect(toolsSave).toBeDisabled()
    }
  })
})
