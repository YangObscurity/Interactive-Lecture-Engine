/**
 * Shared e2e fixtures (V2 P0).
 *
 * 1. Backend isolation (plan §2 item 7): EVERY test routes `**\/api/**` to local fixtures under
 *    site/tests/fixtures/api/. The real backend (/api/db, /api/ai, /api/progress …) is never reached.
 *    Lookup for a request to `/api/<p>` with method M (first hit wins):
 *        tests/fixtures/api/<p>.<M>.json
 *        tests/fixtures/api/<p>.json
 *        tests/fixtures/api/<p>/index.<M>.json
 *        tests/fixtures/api/<p>/index.json
 *    (`<p>` is the URL path after `/api/`, query string ignored.) No fixture → 503 JSON
 *    `{ error: 'e2e: backend disabled' }`. Every intercepted call is recorded in `apiCalls`.
 *    Exception: `GET /api/db/progress` answers `[]` (see the comment at the handler).
 * 2. `consoleErrors` / `pageErrors`: collected for the whole test, exposed as fixtures.
 * 3. `gotoAndSettle(page, path)`: goto + networkidle + (if the page has figure.chart)
 *    wait for `window.__CHARTS_DONE__ === true`, with a timeout fallback.
 */
import { test as base, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SITE_ROOT = path.resolve(HERE, '..', '..')
export const DOCS_ROOT = path.join(SITE_ROOT, 'docs')
export const API_FIXTURE_ROOT = path.join(SITE_ROOT, 'tests', 'fixtures', 'api')

export interface ApiCall {
  method: string
  url: string
  fixture: string | null
}

function resolveFixture(urlPath: string, method: string): string | null {
  const idx = urlPath.indexOf('/api/')
  if (idx < 0) return null
  const rel = urlPath.slice(idx + '/api/'.length).replace(/\/+$/, '')
  // never escape the fixture root
  const safe = rel
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => decodeURIComponent(seg).replace(/[<>:"|?*\\]/g, '_'))
    .join('/')
  const m = method.toUpperCase()
  const ml = method.toLowerCase()
  const candidates = safe
    ? [`${safe}.${m}.json`, `${safe}.${ml}.json`, `${safe}.json`, `${safe}/index.${m}.json`, `${safe}/index.${ml}.json`, `${safe}/index.json`]
    : [`index.${m}.json`, `index.${ml}.json`, 'index.json']
  for (const c of candidates) {
    const abs = path.join(API_FIXTURE_ROOT, c)
    if (abs.startsWith(API_FIXTURE_ROOT) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs
  }
  return null
}

export interface SettleOptions {
  /** max wait for networkidle (ms). Timeout is tolerated. */
  idleTimeout?: number
  /** max wait for __CHARTS_DONE__ (ms). Timeout is tolerated (returns false) — assert explicitly if needed. */
  chartsTimeout?: number
}

/**
 * Wait until the fonts are in AND the map label layer (if the page has one) has painted with them. `document.fonts.ready` alone is
 * not enough: the canvas labels are repainted by the layer after the font files it asked for have loaded, and a screenshot taken
 * between the two shows the fallback font. Pages without a label canvas return after the fonts.
 */
export async function waitForLabelPaint(page: Page, timeout = 20_000): Promise<void> {
  await page.evaluate(() => document.fonts?.ready.then(() => undefined)).catch(() => {})
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas.lec-map-labels') as (HTMLCanvasElement & { lecLabels?: { fontsReady: boolean } }) | null
      return !c || !c.lecLabels || c.lecLabels.fontsReady
    },
    null,
    { timeout },
  )
  // the home map is masked until it is ready (HomeBody.vue): a screenshot must be taken after the reveal
  await page
    .waitForFunction(() => {
      const r = document.querySelector('.hb-map-region')
      return !r || r.getAttribute('data-map-state') === 'ready'
    }, null, { timeout })
    .catch(() => {})
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
}

/**
 * Navigate and wait until the page is quiet. Returns whether `__CHARTS_DONE__` was observed
 * (always true for pages without figure.chart).
 */
export async function gotoAndSettle(page: Page, urlPath: string, opts: SettleOptions = {}): Promise<boolean> {
  const { idleTimeout = 20_000, chartsTimeout = 30_000 } = opts
  const resp = await page.goto(urlPath, { waitUntil: 'domcontentloaded' })
  if (resp && resp.status() >= 400) throw new Error(`gotoAndSettle: ${urlPath} → HTTP ${resp.status()}`)
  await page.waitForSelector('html[data-hydrated="1"]', { timeout: idleTimeout }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: idleTimeout }).catch(() => {})
  const hasCharts = (await page.locator('figure.chart').count()) > 0
  let chartsDone = true
  if (hasCharts) {
    chartsDone = await page
      .waitForFunction(() => (window as unknown as { __CHARTS_DONE__?: boolean }).__CHARTS_DONE__ === true, null, {
        timeout: chartsTimeout,
      })
      .then(() => true)
      .catch(() => false)
    await page.waitForLoadState('networkidle', { timeout: idleTimeout }).catch(() => {})
  }
  // fonts affect layout (mermaid measures text) — make sure they are in before anyone screenshots
  await waitForLabelPaint(page)
  return chartsDone
}

type Fixtures = {
  apiCalls: ApiCall[]
  consoleErrors: string[]
  pageErrors: Error[]
}

export const test = base.extend<Fixtures>({
  // auto: installed for every test even if the test does not request it
  apiCalls: [
    async ({ context }, use) => {
      const calls: ApiCall[] = []
      // only real API paths (`/api/...` at the root): the glob `**/api/**` also caught the dev server's source
      // modules (`/.vitepress/theme/api/progress.ts`), so under `--project dev` the store's own code was answered
      // with mock JSON and never loaded
      await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const req = route.request()
        const url = new URL(req.url())
        const fixture = resolveFixture(url.pathname, req.method())
        calls.push({ method: req.method(), url: url.pathname + url.search, fixture })
        if (req.method() === 'GET' && url.pathname.endsWith('/api/db/progress')) {
          // P3: the site reads progress from the backend (modules.progress = rest). db/progress.get.json is the
          // mock server's seed; served as-is it would turn four lectures into reader progress on every page and
          // move the pages that depend on progress (home map expansion, group counts). The e2e baseline backend
          // starts empty, so the graph seed alone decides; progress.spec.ts brings its own stateful backend.
          await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '[]' })
          return
        }
        if (fixture) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: fs.readFileSync(fixture),
          })
        } else {
          await route.fulfill({
            status: 503,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ error: 'e2e: backend disabled' }),
          })
        }
      })
      await use(calls)
    },
    { auto: true },
  ],

  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(msg.text())
      })
      await use(errors)
    },
    { auto: true },
  ],

  pageErrors: [
    async ({ page }, use) => {
      const errors: Error[] = []
      page.on('pageerror', (err) => errors.push(err))
      await use(errors)
    },
    { auto: true },
  ],
})

export { expect }
