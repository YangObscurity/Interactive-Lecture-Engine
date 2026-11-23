/**
 * scripts/readme_screenshots.mjs - the pictures of the README, taken on the engine's demo content (templates/demo-content).
 *
 *   npm run screenshots:readme                       serve site/.e2e-demo/dist (built first when it is missing), write the PNGs
 *   npm run screenshots:readme -- --build            rebuild the demo (npm run build:e2e) first
 *   npm run screenshots:readme -- --only lecture,mobile    only these shots
 *   npm run screenshots:readme -- --out <dir>        another folder (default: <repo>/docs/screenshots)
 *
 * The demo build of `npm run build:e2e` is served by tests/e2e/access-server.mjs on a free local port and driven with
 * Playwright (installed Chrome; Playwright's own Chromium with CI set or --bundled). Every `/api/` request is answered
 * here, nothing leaves the machine: progress is empty so the demo's own progress seed decides (lectures read and in
 * progress), the AI companion gets one canned reply in the backend (api) mode of the e2e site config, the Dashboard sees
 * a signed-in admin and a small overview. The Dashboard is the online one of the built site (read-only overview), so no
 * dev server is started and site/docs is never touched.
 *
 * Every shot: 1280 px wide viewport (mobile: 390 x 844), deviceScaleFactor 1, the first screen (no full-page capture),
 * taken after charts, fonts and maps have settled. Each file should stay under about 400 KB (a warning says when not).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { E2E_DIST, buildDemo } from './build_e2e.mjs'
import { createServer } from '../tests/e2e/access-server.mjs'

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DIR = path.resolve(SITE_DIR, '..')
const API_FIXTURES = path.join(SITE_DIR, 'tests', 'fixtures', 'api')
const DESKTOP = { width: 1280, height: 800 }
const MOBILE = { width: 390, height: 844 }
const SIZE_BUDGET = 400 * 1024
const log = (msg) => console.log(`[screenshots] ${msg}`)

function parseArgs(argv) {
  const val = (name) => {
    const i = argv.indexOf(name)
    if (i >= 0) return argv[i + 1]
    const eq = argv.find((a) => a.startsWith(`${name}=`))
    return eq ? eq.slice(name.length + 1) : undefined
  }
  return {
    build: argv.includes('--build'),
    bundled: argv.includes('--bundled') || !!process.env.CI,
    only: (val('--only') || '').split(',').map((s) => s.trim()).filter(Boolean),
    out: path.resolve(val('--out') || path.join(REPO_DIR, 'docs', 'screenshots')),
  }
}

// ------------------------------------------------------------------------------------------------- local backend

const json = (body, status = 200) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) })

/**
 * One companion answer in the Dify SSE framing the site's proxy speaks (see tests/fixtures/api/ai/chat.sse), with an
 * inline formula, a display formula and a code block: the companion renders KaTeX and Shiki after sanitizing (markdownMath.ts).
 */
const COMPANION_ANSWER = [
  '两组的平均值都是 $\\bar{x} = 10$，差别在离散程度：',
  '',
  '$$s = \\sqrt{\\frac{\\sum_{i=1}^{n} (x_i - \\bar{x})^2}{n - 1}}$$',
  '',
  '- **A** 组五个读数都等于 10，偏差全为 0，所以 $s = 0$；',
  '- **B** 组偏差平方和为 40，$s = \\sqrt{40 / 4} \\approx 3.16$。',
  '',
  '```python',
  'b = [6, 8, 10, 12, 14]',
  'm = sum(b) / len(b)          # 10',
  's = (sum((x - m) ** 2 for x in b) / 4) ** 0.5',
  '```',
].join('\n')

function companionSse() {
  const id = 'msg-readme-1'
  const conv = 'conv-readme-1'
  const frames = [
    { event: 'agent_message', id, message_id: id, conversation_id: conv, answer: COMPANION_ANSWER },
    { event: 'message_end', id, message_id: id, conversation_id: conv, metadata: { usage: { prompt_tokens: 380, completion_tokens: 120, total_tokens: 500 } } },
  ]
  return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
}

const ADMIN_SESSION = {
  authenticated: true,
  user: { id: 'demo-admin', name: 'Demo Admin', email: 'admin@example.com' },
  roles: ['reader', 'admin'],
  groups: ['admins'],
  logoutUrl: 'https://auth.example.com/logout',
}

const ADMIN_OVERVIEW = {
  generatedAt: '2026-11-20T08:00:00.000Z',
  totals: { users: 8, progressRows: 64, completedLectures: 29, sessions: 11, messages: 46, checklistItems: 14, completedChecklistItems: 9 },
  byStatus: { 未开始: 23, 学习中: 12, 已完成: 29 },
  byGroup: [
    { group_id: 'mea', total_rows: 30, completed: 15, in_progress: 6, not_started: 9 },
    { group_id: 'log', total_rows: 16, completed: 8, in_progress: 3, not_started: 5 },
    { group_id: 'pln', total_rows: 12, completed: 4, in_progress: 2, not_started: 6 },
    { group_id: 'dat', total_rows: 6, completed: 2, in_progress: 1, not_started: 3 },
  ],
  recentActivity: { progressUpdatedLast24h: 7, sessionsCreatedLast24h: 2, messagesCreatedLast24h: 9 },
}

/** tests/fixtures/api/<p>.<method>.json, <p>.json, <p>/index.<method>.json, <p>/index.json (as tests/e2e/fixtures.ts). */
function fixtureFile(rel, method) {
  const safe = rel.split('/').filter((s) => s && s !== '.' && s !== '..').join('/')
  const m = method.toLowerCase()
  for (const c of [`${safe}.${m}.json`, `${safe}.json`, `${safe}/index.${m}.json`, `${safe}/index.json`]) {
    const abs = path.join(API_FIXTURES, c)
    if (abs.startsWith(API_FIXTURES) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs
  }
  return null
}

/** Answer every /api/ request of the context locally. `admin`: the Dashboard's signed-in admin. */
async function routeApi(context, { admin = false } = {}) {
  await context.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const req = route.request()
    const method = req.method()
    const rel = new URL(req.url()).pathname.slice('/api/'.length).replace(/\/+$/, '')
    if (rel === 'db/progress') return route.fulfill(method === 'GET' ? json([]) : json({}))
    if (rel === 'db/sessions' || rel.startsWith('db/sessions/') || rel === 'db/messages' || rel.startsWith('db/messages/')) {
      return route.fulfill(method === 'GET' ? json([]) : { status: 201, contentType: 'application/json', body: req.postData() || '{}' })
    }
    if (rel === 'ai/chat') return route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: companionSse() })
    if (rel === 'auth/session' && admin) return route.fulfill(json(ADMIN_SESSION))
    if (rel === 'admin/overview') return route.fulfill(json(ADMIN_OVERVIEW))
    const file = fixtureFile(rel, method)
    if (file) return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: fs.readFileSync(file) })
    return route.fulfill(json({ error: 'screenshots: backend disabled' }, 503))
  })
}

// ------------------------------------------------------------------------------------------------- page helpers

async function newPage(browser, baseURL, { theme = 'reader', mode = 'light', viewport = DESKTOP, mobile = false, admin = false } = {}) {
  const context = await browser.newContext({
    baseURL,
    viewport,
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: mode,
    reducedMotion: 'reduce',
  })
  await routeApi(context, { admin })
  await context.addInitScript(
    ([prefs, m]) => {
      try {
        localStorage.setItem('vitepress-theme-appearance', m)
        localStorage.setItem('lecture:reader-prefs', prefs)
      } catch {
        /* storage off */
      }
    },
    [JSON.stringify({ theme }), mode],
  )
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`)
  })
  return { context, page, problems }
}

/** Fonts in, the map label layer repainted with them, the home map revealed, two frames. */
async function settle(page) {
  await page.evaluate(() => document.fonts?.ready.then(() => undefined)).catch(() => {})
  await page.waitForFunction(() => {
    const c = document.querySelector('canvas.lec-map-labels')
    return !c || !c.lecLabels || c.lecLabels.fontsReady
  }, null, { timeout: 20_000 })
  await page.waitForFunction(() => {
    const r = document.querySelector('.hb-map-region')
    return !r || r.getAttribute('data-map-state') === 'ready'
  }, null, { timeout: 20_000 }).catch(() => {})
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
  await page.waitForTimeout(250)
}

/** goto + hydration + network quiet + charts done + settle. */
async function open(page, urlPath) {
  const resp = await page.goto(urlPath, { waitUntil: 'domcontentloaded' })
  if (resp && resp.status() >= 400) throw new Error(`${urlPath}: HTTP ${resp.status()}`)
  await page.waitForSelector('html[data-hydrated="1"]', { timeout: 20_000 })
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  if ((await page.locator('figure.chart').count()) > 0) {
    await page.waitForFunction(() => window.__CHARTS_DONE__ === true, null, { timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  }
  if ((await page.locator('.home-body').count()) > 0) {
    await page.waitForSelector('.home-body[data-home-settled="1"]', { timeout: 10_000 }).catch(() => {})
  }
  await settle(page)
}

/** Scroll so `selector` starts `offset` px below the top of the viewport (under the sticky nav bar). */
async function scrollTo(page, selector, offset = 76) {
  await page.locator(selector).first().evaluate((el, off) => {
    window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - off))
  }, offset)
  await settle(page)
}

// ------------------------------------------------------------------------------------------------- the shots

/** The home page scrolled to the course atlas (the whole map box under the nav bar), every lecture shown with its state. */
async function homeAtlas(page) {
  await open(page, '/')
  await page.waitForSelector('[data-slot="AtlasCenter"]')
  await page.locator('.am-expand button[data-x="all"]').click()
  await page.waitForSelector('.am-expand button[data-x="all"][aria-pressed="true"]')
  await page.waitForTimeout(600)
  await scrollTo(page, '.lec-map', 84)
}

const SHOTS = {
  'home-atlas': { theme: 'reader', mode: 'light', run: homeAtlas },
  'home-atlas-dark': { theme: 'datasheet', mode: 'dark', run: homeAtlas },
  // title, progress, the group map and the first rows of the lecture map in one screen
  'group-page': { theme: 'reader', mode: 'light', async run(page) {
    await open(page, '/mea/')
    await page.waitForSelector('[data-gp-map] [data-slot="GroupMap"]')
    await page.evaluate(() => window.scrollTo(0, 100))
    await settle(page)
  } },
  lecture: { theme: 'reader', mode: 'light', async run(page) {
    await open(page, '/mea/L04')
    // the chart and the formula of "例子" below it in one screen
    await scrollTo(page, '.vp-doc figure.chart', 88)
    const inView = await page.locator('.vp-doc .katex').first().evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight)
    if (!inView) throw new Error('lecture: the formula is not in view')
  } },
  canvas: { theme: 'reader', mode: 'light', async run(page) {
    await open(page, '/')
    await page.locator('[data-map-mode="graph"]').click()
    await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
    await page.waitForFunction(() => document.querySelectorAll('.cv-node').length > 0)
    await scrollTo(page, '.cv-stage', 72)
  } },
  concept: { theme: 'reader', mode: 'light', async run(page) {
    await open(page, '/mea/L02')
    const term = page.locator('.vp-doc a.lec-term[data-concept="significant-figures"]').first()
    await term.evaluate((el) => window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 260)))
    await settle(page)
    await term.hover()
    await page.locator('.lec-tcard').waitFor({ state: 'visible' })
    await page.waitForTimeout(300)
  } },
  companion: { theme: 'reader', mode: 'light', async run(page, problems) {
    await open(page, '/mea/L04')
    await page.locator('.ai-trigger-tab').click()
    await page.locator('.ai-sidebar-shell.is-open').waitFor({ state: 'visible' })
    await page.locator('.chat-textarea').fill('A、B 两组平均值一样，为什么说 B 组更“散”？')
    await page.locator('.send-btn').click()
    await page.locator('.assistant-body').last().filter({ hasText: '3.16' }).waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('.assistant-body .math-block .katex-display').last().waitFor({ state: 'visible', timeout: 15_000 })
    await page.locator('.assistant-body .ai-code-body pre.shiki').last().waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    await settle(page)
    if (await page.locator('[data-ai-error-bubble], .ai-toast-item').count()) problems.push('companion: an error bubble or toast is showing')
  } },
  dashboard: { theme: 'reader', mode: 'light', admin: true, async run(page) {
    await open(page, '/dashboard')
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await page.waitForSelector('[data-admin-overview] [data-admin-metric="users"]')
    await settle(page)
  } },
  mobile: { theme: 'reader', mode: 'light', viewport: MOBILE, mobile: true, async run(page) {
    await open(page, '/mea/L04')
  } },
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const names = args.only.length ? args.only : Object.keys(SHOTS)
  const unknown = names.filter((n) => !SHOTS[n])
  if (unknown.length) throw new Error(`unknown shot(s): ${unknown.join(', ')}; known: ${Object.keys(SHOTS).join(', ')}`)

  if (args.build || !fs.existsSync(path.join(E2E_DIST, 'index.html'))) {
    log(args.build ? 'building the demo (npm run build:e2e) ...' : `no demo build in ${path.relative(SITE_DIR, E2E_DIST)}: building it first (npm run build:e2e) ...`)
    const code = await buildDemo()
    if (code !== 0) throw new Error(`npm run build:e2e failed (exit ${code})`)
  }

  const server = createServer(E2E_DIST)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  log(`serving ${path.relative(SITE_DIR, E2E_DIST)} on ${base}`)
  const browser = await chromium.launch(args.bundled ? {} : { channel: 'chrome' })
  fs.mkdirSync(args.out, { recursive: true })
  let failed = 0
  try {
    for (const name of names) {
      const shot = SHOTS[name]
      const { context, page, problems } = await newPage(browser, base, shot)
      try {
        await shot.run(page, problems)
        const file = path.join(args.out, `${name}.png`)
        await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' })
        const size = fs.statSync(file).size
        log(`${name}.png ${(size / 1024).toFixed(0)} KB${size > SIZE_BUDGET ? '  (over the ~400 KB budget)' : ''}`)
        for (const p of problems) log(`  ${name}: ${p}`)
      } catch (e) {
        failed++
        console.error(`[screenshots] ${name} failed: ${e.message}`)
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    server.close()
  }
  log(`${names.length - failed} of ${names.length} written to ${path.relative(REPO_DIR, args.out) || args.out}`)
  if (failed) process.exit(1)
}

main().catch((e) => {
  console.error(`[screenshots] ${e.message}`)
  process.exit(1)
})
