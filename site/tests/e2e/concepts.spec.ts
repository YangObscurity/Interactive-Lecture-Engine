/**
 * tests/e2e/concepts.spec.ts - End-to-end coverage for Stand-alone Concept Pages (WP-F9).
 *
 * Covers:
 *   1. Production isolation: concepts & _drafts hidden from home, group pages, nav menu, maps,
 *      continue-reading, search index, and hover JSON in `prod`; author toolbar absent outside local dev.
 *   2. Author mode & live dev flows (serial with strict file rollback):
 *      - Draft preview layout (banner, single H1, 1 meta line, back breadcrumb, related lectures)
 *      - Contract validation failure ("格式不符，未写入") writes nothing
 *      - 待核实 blocks confirm until resolved
 *      - Create (table cell) -> preview -> confirm rewrites exact occurrence matching diff
 *      - On-demand hover JSON fetch (zero fetch before hover; tooltip appears on hover)
 *      - Search alias hit with "概念" badge and strictly 1 hit per concept page
 *      - Round-trip navigation restores scrollY within <= 2 px without polluting lecture-read-pos
 *      - Multiple hits require choosing an occurrence before confirm write unlocks
 *      - Edit flow -> draft -> preview -> confirm updates published concept
 *      - Dashboard "概念草稿" tab: status marks, selectionSource, occurrences, delete with impact preview -> plain text
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, gotoAndSettle } from './fixtures'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import { E2E_CONTENT_COPY } from '../../scripts/build_e2e.mjs'
import type { Locator, Page } from '@playwright/test'

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// S2: in content mode the sources live in content/ and the dev server serves the copies in site/docs/;
// in-place mode makes both the same folder. The concept workflow reads the sources, the pages render the copies.
// S6: the e2e suites run on the demo content: the throw-away copy site/.e2e-demo/content that `npm run build:e2e`
// (and the dev project) build from (templates/demo-content itself is never written).
const CONTENT = resolveContent({ env: { ...process.env, LECTURE_CONTENT_DIR: E2E_CONTENT_COPY } })
const DOCS_DIR = path.join(SITE_DIR, 'docs')
const CONCEPTS_DIR = CONTENT.conceptsDir
const DRAFTS_DIR = path.join(CONCEPTS_DIR, '_drafts')
const TARGET_LECTURE_REL = '/mea/L02'
const TARGET_LECTURE_FILE = path.join(CONTENT.lecturesDir, 'mea', 'L02.md')

/** The site/docs copy of a source file (itself in in-place mode). */
function copyOf(file: string): string {
  const abs = path.resolve(file)
  for (const [src, dest] of [
    [CONTENT.conceptsDir, path.join(DOCS_DIR, 'concepts')],
    [CONTENT.lecturesDir, DOCS_DIR],
  ] as const) {
    const rel = path.relative(src, abs)
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(dest, rel)
  }
  return abs
}

function writeBoth(file: string, data: string, _encoding?: BufferEncoding): void {
  for (const f of new Set([path.resolve(file), copyOf(file)])) {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, data, 'utf8')
  }
}

function rmBoth(file: string, opts?: fs.RmOptions): void {
  for (const f of new Set([path.resolve(file), copyOf(file)])) fs.rmSync(f, opts ?? { force: true })
}
const AUTHOR_LOCK_DIR = path.join(os.tmpdir(), 'lec-f9-e2e-author.lock')

let baselineCaptured = false
let origTarget = ''
let snapshotDrafts = new Set<string>()
let snapshotPub = new Set<string>()
let holdingAuthorLock = false

function captureBaselineOnce(): void {
  if (baselineCaptured) return
  baselineCaptured = true
  origTarget = fs.readFileSync(TARGET_LECTURE_FILE, 'utf8')
  snapshotDrafts = new Set(fs.existsSync(DRAFTS_DIR) ? fs.readdirSync(DRAFTS_DIR) : [])
  snapshotPub = new Set(fs.existsSync(CONCEPTS_DIR) ? fs.readdirSync(CONCEPTS_DIR).filter((n) => n !== '_drafts') : [])
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireAuthorLock(workerIndex: number): Promise<void> {
  if (holdingAuthorLock) return
  const ownerFile = path.join(AUTHOR_LOCK_DIR, 'owner.json')
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(AUTHOR_LOCK_DIR)
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, workerIndex, ts: Date.now() }), 'utf8')
      holdingAuthorLock = true
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'EEXIST') throw err
      try {
        const meta = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid?: number; ts?: number }
        const stale =
          (typeof meta.ts === 'number' && Date.now() - meta.ts > 240_000) ||
          (typeof meta.pid === 'number' && !isPidAlive(meta.pid))
        if (stale) {
          fs.rmSync(AUTHOR_LOCK_DIR, { recursive: true, force: true })
          continue
        }
      } catch {
        // Owner file may still be initializing or removing; retry shortly.
      }
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  throw new Error('Timed out waiting for F9 dev author-mode E2E lock')
}

function releaseAuthorLock(): void {
  if (!holdingAuthorLock) return
  holdingAuthorLock = false
  fs.rmSync(AUTHOR_LOCK_DIR, { recursive: true, force: true })
}

async function selectExactTextInLocator(page: Page, locator: Locator, targetText: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded()
  const ok = await locator.evaluate((el, word) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const val = node.textContent ?? ''
      const idx = val.indexOf(word)
      if (idx >= 0) {
        const range = document.createRange()
        range.setStart(node, idx)
        range.setEnd(node, idx + word.length)
        const sel = window.getSelection()
        if (!sel) return false
        sel.removeAllRanges()
        sel.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
    }
    return false
  }, targetText)
  expect(ok, `Could not select "${targetText}" inside locator`).toBe(true)
  await expect(page.locator('.ai-selection-toolbar')).toBeVisible()
}

async function enableMockByokInSettings(page: Page, baseUrl = 'https://openrouter.ai/api/v1'): Promise<void> {
  await page.locator('[data-lec-settings-btn]').click()
  const byokDetails = page.locator('[data-lec-setting="byok"] details')
  await byokDetails.locator('summary').click()
  await page.locator('[data-lec-byok-enable]').check()
  await page.locator('[data-lec-byok-url]').fill(baseUrl)
  await page.locator('[data-lec-byok-key]').fill('sk-f9-mock-key')
  await page.locator('[data-lec-byok-model]').fill('gpt-4o-mini')
  await page.locator('[data-lec-byok-remember]').check()
  await page.locator('[data-lec-settings-save]').click()
  await expect(page.locator('[data-lec-settings-panel]')).toHaveCount(0)
}

function restoreRepoFixtures(): void {
  if (!baselineCaptured) return
  if (!fs.existsSync(TARGET_LECTURE_FILE) || fs.readFileSync(TARGET_LECTURE_FILE, 'utf8') !== origTarget) {
    writeBoth(TARGET_LECTURE_FILE, origTarget, 'utf8')
  }
  if (fs.existsSync(DRAFTS_DIR)) {
    for (const f of fs.readdirSync(DRAFTS_DIR)) {
      if (!snapshotDrafts.has(f)) {
        rmBoth(path.join(DRAFTS_DIR, f), { recursive: true, force: true })
      }
    }
  }
  if (fs.existsSync(CONCEPTS_DIR)) {
    for (const f of fs.readdirSync(CONCEPTS_DIR)) {
      if (f === '_drafts') continue
      if (!snapshotPub.has(f)) {
        rmBoth(path.join(CONCEPTS_DIR, f), { recursive: true, force: true })
      }
    }
  }
}

test.describe('concepts isolation, drafts exclusion, and read-only Dashboard (@concepts)', () => {
  test('hides concepts and drafts from home, group, nav, maps, and continue-reading', async ({ page, pageErrors }) => {
    await gotoAndSettle(page, '/', { idleTimeout: 3_000, chartsTimeout: 8_000 })
    await page.waitForSelector('.home-body[data-home-ready="1"]')

    // Home cards & overview atlas / canvas never include a CONCEPTS group
    const groupCards = await page.locator('#groups [data-slot="GroupCard"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-group') ?? ''),
    )
    expect(groupCards).not.toContain('CONCEPTS')

    // Continue reading never lists /concepts/
    await gotoAndSettle(page, '/mea/L03', { idleTimeout: 3_000, chartsTimeout: 8_000 })
    await page.evaluate(() => window.scrollTo(0, 300))
    await page.waitForTimeout(600)
    const readPosBefore = await page.evaluate(() => localStorage.getItem('lecture-read-pos') ?? '{}')
    expect(readPosBefore).not.toContain('/concepts/')

    // Course menu never lists concepts
    const cmenu = page.locator('.cm-trigger')
    if (await cmenu.count()) {
      await cmenu.click()
      const hrefs = await page.locator('.cm-groups li a').evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
      )
      for (const h of hrefs) expect(h).not.toContain('/concepts/')
      await cmenu.click()
    }

    // Group page never lists concepts
    await gotoAndSettle(page, '/mea/', { idleTimeout: 3_000, chartsTimeout: 8_000 })
    const groupLinks = await page.locator('a[href*="/concepts/"]').count()
    expect(groupLinks).toBe(0)

    // SelectionToolbar outside local author mode (prod) has zero concept authoring buttons
    if (test.info().project.name === 'prod') {
      await gotoAndSettle(page, '/mea/L02', { idleTimeout: 3_000, chartsTimeout: 8_000 })
      await selectExactTextInLocator(page, page.locator('.vp-doc p', { hasText: '刻度尺' }).first(), '刻度尺')
      await expect(page.locator('[data-ai-toolbar-concept]')).toHaveCount(0)
    }

    expect(pageErrors).toEqual([])
  })

  test('prod excludes _drafts from routes, hover JSON, and search; Dashboard online mode is read-only', async ({
    page,
    request,
    pageErrors,
  }) => {
    test.skip(test.info().project.name !== 'prod', 'Production build exclusion check runs on prod project only')

    // Not tied to any particular concept: the published pages are the .md files directly in docs/concepts/,
    // every draft would live in docs/concepts/_drafts/ (owner content, absent or not).
    const publishedSlugs = fs.readdirSync(CONCEPTS_DIR).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3))
    const draftSlugs = fs.existsSync(DRAFTS_DIR) ? fs.readdirSync(DRAFTS_DIR).filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3)) : []

    // 1. No draft preview route exists in dist/ (a made-up draft slug stands in when there is no real draft)
    for (const slug of [...draftSlugs, 'no-such-draft-for-e2e']) {
      expect((await request.get(`/concepts/_drafts/${slug}`)).status()).toBe(404)
    }

    // 2. Public hover JSON: every item is a published concept page and none points into _drafts/
    const hoverRes = await request.get('/concepts-hover.json')
    expect(hoverRes.status()).toBe(200)
    const hoverJson = (await hoverRes.json()) as { items?: Record<string, { url?: string; status?: string }> }
    for (const [slug, item] of Object.entries(hoverJson.items ?? {})) {
      expect(publishedSlugs, `hover item ${slug}`).toContain(slug)
      expect(item.url ?? '').not.toContain('/_drafts/')
      expect(item.status).toBe('published')
    }
    for (const d of draftSlugs.filter((d) => !publishedSlugs.includes(d))) expect(Object.keys(hoverJson.items ?? {})).not.toContain(d)

    // 3. Search does not return drafts in prod
    await gotoAndSettle(page, '/')
    await page.keyboard.press('ControlOrMeta+k')
    await page.locator('#lec-search-input').fill('有效数字')
    await page.waitForTimeout(300)
    const hitHrefs = await page.locator('.sp-hit').evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
    )
    expect(hitHrefs.some((h) => h.includes('/concepts/_drafts/'))).toBe(false)
    await page.keyboard.press('Escape')

    // 4. Online Dashboard 概念草稿 tab is strictly read-only
    await page.context().route('**/api/auth/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({
          authenticated: true,
          user: { id: 'alice', name: 'Alice' },
          roles: ['reader', 'admin'],
          groups: ['admins'],
        }),
      }),
    )
    await gotoAndSettle(page, '/dashboard')
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await page.locator('[data-dashboard-tab="figures"]').click() // v3.4: concept drafts are a tab of "figures and concepts"
    await page.locator('[data-dashboard-subtab="drafts"]').click()
    await expect(page.locator('[data-concepts-readonly-notice]')).toBeVisible()
    await expect(page.locator('[data-dc-confirm]')).toHaveCount(0)
    await expect(page.locator('[data-dc-delete]')).toHaveCount(0)
    expect(pageErrors).toEqual([])
  })
})

test.describe('concepts dev & local author mode flows (@concepts-author)', () => {
  test.describe.configure({ mode: 'serial' })

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring in fixture hooks
  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'dev', 'Local author mode workflows run on Vite dev server')
    testInfo.setTimeout(240_000)
    await acquireAuthorLock(testInfo.workerIndex)
    captureBaselineOnce()
    restoreRepoFixtures()
  })

  // eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring in fixture hooks
  test.afterEach(({}, testInfo) => {
    if (testInfo.project.name === 'dev') {
      restoreRepoFixtures()
      releaseAuthorLock()
    }
  })

  test('renders a _drafts concept page layout and keeps lecture-read-pos clean', async ({ page, pageErrors }) => {
    // a draft of its own (removed again by restoreRepoFixtures), so the test does not depend on which concepts are drafts
    fs.mkdirSync(DRAFTS_DIR, { recursive: true })
    writeBoth(
      path.join(DRAFTS_DIR, 'e2e-draft-layout.md'),
      [
        '---',
        'title: "E2E 草稿样例"',
        'term: "E2E 草稿样例"',
        'english: "E2E Draft Sample"',
        'aliases: []',
        'field: "测试"',
        'groups: ["MEA"]',
        'summary: "只给布局测试用的草稿。"',
        'status: draft',
        'related:',
        '  - { slug: significant-figures, rel: applied-in }',
        '---',
        '',
        '# E2E 草稿样例',
        '',
        '这段正文提到[有效数字](concept:significant-figures)，字段有 RawReading 与 UnitSymbol。',
        '',
      ].join('\n'),
      'utf8',
    )
    await gotoAndSettle(page, '/concepts/_drafts/e2e-draft-layout', { idleTimeout: 3_000, chartsTimeout: 8_000 })
    await expect(page.locator('[data-concept-draft-banner]')).toContainText('草稿')
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toHaveText('E2E 草稿样例')
    await expect(page.locator('[data-concept-meta-line]')).toContainText('E2E Draft Sample')
    await expect(page.locator('[data-concept-back]')).toBeVisible()
    await expect(page.locator('[data-concept-related] [data-concept-link="significant-figures"]').first()).toBeVisible()
    await expect(page.locator('.vp-doc')).toContainText('RawReading')
    await expect(page.locator('.vp-doc')).toContainText('UnitSymbol')

    const readPos = await page.evaluate(() => localStorage.getItem('lecture-read-pos') ?? '{}')
    expect(readPos).not.toContain('/concepts/')
    expect(pageErrors).toEqual([])
  })

  test('schema-invalid AI contract response fails with "格式不符，未写入" after retry and writes nothing', async ({
    page,
    pageErrors,
  }) => {
    let calls = 0
    await page.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
      calls++
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: '{"slug":"INVALID SLUG","term":""}' } }],
        }),
      })
    })

    await gotoAndSettle(page, TARGET_LECTURE_REL, { idleTimeout: 5_000, chartsTimeout: 15_000 })
    await enableMockByokInSettings(page)

    await expect(async () => {
      await selectExactTextInLocator(page, page.locator('.vp-doc p', { hasText: '刻度尺' }).first(), '刻度尺')
      await page.locator('[data-ai-toolbar-concept="create"]').click({ timeout: 4_000 })
      await expect(page.locator('[data-concept-author-panel]')).toBeVisible({ timeout: 4_000 })
    }).toPass({ intervals: [500], timeout: 30_000 })
    calls = 0
    await page.locator('[data-concept-generate-btn]').click()

    await expect(page.locator('[data-concept-author-error]')).toContainText('格式不符，未写入')
    expect(calls).toBe(2) // Initial attempt + 1 retry
    expect(fs.readdirSync(DRAFTS_DIR).sort()).toEqual([...snapshotDrafts].sort())
    expect(pageErrors).toEqual([])
  })

  test('create (in table) -> preview -> confirm (diff == write), on-demand hover, search alias (1 hit), round-trip <= 2px, edit & delete impact', async ({
    page,
    pageErrors,
  }) => {
    test.setTimeout(240_000)
    const slug = 'temp-concept-f9'
    const testSection = [
      '',
      '## F9 E2E 测例节',
      '',
      '| 序号 | 概念测试语句 |',
      '| --- | --- |',
      '| 1 | 本表包含 临时概念测试词 以及 **强调测试** 与 *重复锚点词*。 |',
      '',
      '第二段再次提到 *重复锚点词*，而代码 `不要转换(concept:none)` 应保持原样。',
      '',
    ].join('\n')
    writeBoth(TARGET_LECTURE_FILE, origTarget + testSection, 'utf8')

    let aiMode: 'create' | 'edit' = 'create'
    await page.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
      const payload =
        aiMode === 'create'
          ? {
              slug,
              term: '临时概念测试词',
              english: 'Temporary F9 Concept',
              aliases: ['F9-UNIQUE-ALIAS', '测试别名二'],
              field: 'F9 自动化测试域',
              groups: ['MEA'],
              summary: '用于端到端验证的独立概念摘要。',
              related: [],
              paragraphs: [
                {
                  heading: '核心定义',
                  body: '验证表格内链接与 **粗体** 契约以及 `inline` 保护，暂含 待核实 细节。',
                  sources: ['MEA-L02 · F9 E2E 测例节'],
                  verified: false,
                  unverifiedReason: '模拟待核实条目验证阻塞发布',
                },
              ],
            }
          : {
              slug,
              term: '临时概念测试词',
              english: 'Temporary F9 Concept Revised',
              aliases: ['F9-UNIQUE-ALIAS', '修订别名'],
              field: 'F9 自动化测试域',
              groups: ['MEA'],
              summary: '已完成修订的独立概念摘要。',
              related: [],
              paragraphs: [
                {
                  heading: '核心定义',
                  body: '修订后的定义正文，全部来源已核实。',
                  sources: ['MEA-L02 · F9 E2E 测例节'],
                  verified: true,
                },
              ],
            }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          choices: [{ message: { content: '```json\n' + JSON.stringify(payload) + '\n```' } }],
        }),
      })
    })

    // Wait for Vite dev file watcher to pick up injected section written directly to disk
    await expect(async () => {
      await gotoAndSettle(page, TARGET_LECTURE_REL, { idleTimeout: 1_200, chartsTimeout: 2_000 })
      await expect(page.locator('.vp-doc td', { hasText: '临时概念测试词' })).toBeVisible({ timeout: 2_000 })
    }).toPass({ intervals: [500], timeout: 30_000 })
    await enableMockByokInSettings(page)

    // 1. Select term inside table cell -> Create concept draft
    await selectExactTextInLocator(page, page.locator('.vp-doc td', { hasText: '临时概念测试词' }), '临时概念测试词')
    await page.locator('[data-ai-toolbar-concept="create"]').click()
    await page.locator('[data-concept-generate-btn]').click()

    const draftCard = page.locator('[data-concept-draft-card]')
    await expect(draftCard).toBeVisible()
    // 待核实 blocks publish button in sidebar!
    await expect(page.locator('[data-concept-sidebar-confirm]')).toBeDisabled()

    // 2. Open Preview Page (/concepts/_drafts/temp-concept-f9) & verify 待核实 blocks confirm until resolved
    await page.locator('[data-concept-open-preview]').click()
    await expect(page).toHaveURL(new RegExp(`/concepts/_drafts/${slug}$`))
    await expect(page.locator('[data-concept-unverified-warn]')).toBeVisible()
    await expect(page.locator('[data-concept-draft-confirm]')).toBeDisabled()

    // Edit draft inline to resolve 待核实 & save
    await page.locator('[data-concept-draft-edit]').click()
    const cleanText = await page.locator('[data-concept-draft-editor] textarea').inputValue()
    const resolvedText = cleanText.replace(/暂含\s*待核实\s*细节。?/g, '已完成核实。').replace(/> \*\*待核实\*\*：.*\n?/g, '')
    await page.locator('[data-concept-draft-editor] textarea').fill(resolvedText)
    await page.locator('[data-concept-draft-save]').click()
    await expect(page.locator('[data-concept-draft-confirm]')).toBeEnabled({ timeout: 10_000 })

    // 3. Preview confirm diff -> confirms and writes exact diff
    await page.locator('[data-concept-draft-confirm]').click()
    const diffText = await page.locator('[data-concept-lecture-diff]').innerText()
    expect(diffText).toContain('-| 1 | 本表包含 临时概念测试词')
    expect(diffText).toContain('+| 1 | 本表包含 [临时概念测试词](concept:temp-concept-f9)')

    await page.locator('[data-concept-confirm-write]').click()
    await expect(page).toHaveURL(new RegExp(`/concepts/${slug}$`))

    // Confirm written lecture markdown matches diff accurately & draft removed
    expect(fs.existsSync(path.join(DRAFTS_DIR, `${slug}.md`))).toBe(false)
    expect(fs.existsSync(path.join(CONCEPTS_DIR, `${slug}.md`))).toBe(true)
    const updatedL01 = fs.readFileSync(TARGET_LECTURE_FILE, 'utf8')
    expect(updatedL01).toContain('| 1 | 本表包含 [临时概念测试词](concept:temp-concept-f9)')
    expect(updatedL01).toContain('`不要转换(concept:none)`')

    // 4. Reload lecture -> verify table <a.lec-term>, on-demand hover JSON loading, & round-trip <= 2 px!
    const hoverRequests: string[] = []
    page.on('request', (req) => {
      const p = new URL(req.url()).pathname
      if (p.includes('concepts-hover.json') || p.includes('/concepts/hover')) hoverRequests.push(p)
    })

    const termLink = page.locator(`.vp-doc td a.lec-term[data-concept="${slug}"]`)
    await expect(async () => {
      await gotoAndSettle(page, TARGET_LECTURE_REL, { idleTimeout: 3_000, chartsTimeout: 8_000 })
      await expect(termLink).toBeVisible({ timeout: 2_000 })
    }).toPass({ intervals: [400], timeout: 15_000 })
    hoverRequests.length = 0
    // Zero hover JSON request before first hover
    expect(hoverRequests).toEqual([])

    // Hover triggers on-demand fetch and displays non-interactive .lec-tcard tooltip
    await termLink.hover()
    await expect(page.locator('.lec-tcard')).toBeVisible()
    await expect(page.locator('.lec-tcard')).toContainText('用于端到端验证的独立概念摘要')
    expect(hoverRequests.length).toBeGreaterThanOrEqual(1)

    // Scroll to exact Y, click concept link -> verify layout & back-to-lecture restores within <= 2px
    await termLink.scrollIntoViewIfNeeded()
    const beforeScrollY = await page.evaluate(() => Math.round(window.scrollY))
    await termLink.click()
    await expect(page).toHaveURL(new RegExp(`/concepts/${slug}$`))
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toHaveText('临时概念测试词')
    await expect(page.locator('[data-concept-related]')).toContainText('MEA-L02')

    await page.locator('[data-concept-back]').click()
    await expect(page).toHaveURL(/\/mea\/L02/)
    await expect.poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - beforeScrollY), { timeout: 5000 }).toBeLessThanOrEqual(2)

    // 5. Search alias hit -> "概念" badge & strictly 1 hit per concept page
    await page.keyboard.press('ControlOrMeta+k')
    await page.locator('.sp-scope-btn', { hasText: '全部' }).click()
    await page.locator('#lec-search-input').fill('F9-UNIQUE-ALIAS')
    const hits = page.locator('.sp-hit')
    await expect(hits).toHaveCount(1)
    await expect(hits.first().locator('.no')).toHaveText('概念')
    await expect(hits.first()).toHaveAttribute('href', `/concepts/${slug}`)
    await page.keyboard.press('Escape')

    // 6. Edit flow from existing link selection -> creates draft -> confirms updated text
    aiMode = 'edit'
    await selectExactTextInLocator(page, termLink, '临时概念测试词')
    await page.locator('[data-ai-toolbar-concept="edit"]').click()
    await page.locator('[data-concept-generate-btn]').click()
    await expect(page.locator('[data-concept-draft-card]')).toContainText('Temporary F9 Concept Revised')
    await page.locator('[data-concept-sidebar-confirm]').click()
    await page.locator('[data-concept-confirm-write]').click()
    await expect(page.locator('[data-concept-author-status]')).toBeVisible()
    await page.locator('[data-concept-author-back]').click()
    await page.keyboard.press('Escape')

    // 7. Multiple hits require explicit user choice before write
    const repeatSlug = 'repeat-hit-f9'
    writeBoth(
      path.join(DRAFTS_DIR, `${repeatSlug}.md`),
      [
        '---',
        'title: "重复锚点词"',
        'term: "重复锚点词"',
        'english: "Repeated Term"',
        'aliases: []',
        'field: "测试"',
        'groups: ["MEA"]',
        'summary: "用于测试多处命中需选择。"',
        'status: draft',
        'selectionSource: "MEA-L02"',
        'outline: deep',
        '---',
        '',
        '# 重复锚点词',
        '',
        '## 说明',
        '',
        '重复词条测试正文。',
        '',
        '（出处：MEA-L02）',
        '',
      ].join('\n'),
      'utf8',
    )
    writeBoth(
      path.join(DRAFTS_DIR, `${repeatSlug}.ctx.json`),
      JSON.stringify({ lecturePath: '/mea/L02', selectedText: '重复锚点词' }),
      'utf8',
    )

    // 8. Dashboard "概念草稿" page: test multi-hit confirm choice + delete with impact preview!
    await gotoAndSettle(page, '/dashboard', { idleTimeout: 3_000, chartsTimeout: 8_000 })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await page.locator('[data-dashboard-tab="figures"]').click() // v3.4: concept drafts are a tab of "figures and concepts"
    await page.locator('[data-dashboard-subtab="drafts"]').click()
    await expect(page.locator(`[data-concept-row="${repeatSlug}"]`)).toBeVisible()
    await page.locator(`[data-concept-row="${repeatSlug}"]`).click()
    await page.locator('[data-dc-confirm]').click()

    // Confirm write stays disabled until user selects at least one candidate occurrence
    await expect(page.locator('[data-dc-confirm-write]')).toBeDisabled()
    await page.locator('[data-concept-hit-choice="0"]').check()
    await expect(page.locator('[data-dc-confirm-write]')).toBeEnabled()
    await page.locator('[data-dc-confirm-write]').click()
    await expect(page.locator(`[data-concept-row="${repeatSlug}"][data-concept-row-status="published"]`)).toBeVisible({ timeout: 15_000 })

    // Delete `temp-concept-f9` via Dashboard with impact preview -> removes file & reverts lecture link to plain text!
    await expect(page.locator(`[data-concept-row="${slug}"]`)).toBeVisible()
    await page.locator(`[data-concept-row="${slug}"]`).click()
    await expect(page.locator('[data-dc-delete]')).toBeEnabled()
    await page.locator('[data-dc-delete]').click()
    await expect(page.locator('[data-dc-delete-impact]')).toContainText('MEA-L02')
    await page.locator('[data-dc-confirm-delete]').click()
    await expect(page.locator(`[data-concept-row="${slug}"]`)).toHaveCount(0)

    const afterDeleteL01 = fs.readFileSync(TARGET_LECTURE_FILE, 'utf8')
    expect(afterDeleteL01).not.toContain(`(concept:${slug})`)
    expect(afterDeleteL01).toContain('| 1 | 本表包含 临时概念测试词')

    expect(pageErrors).toEqual([])
  })

  test('attach an existing concept (several hits ask first, zero hits explain), then delete it from the selection with impact preview', async ({
    page,
    pageErrors,
  }) => {
    test.setTimeout(240_000)
    const slug = 'attach-f9'
    writeBoth(
      path.join(CONCEPTS_DIR, `${slug}.md`),
      [
        '---',
        'title: "附着测试词"',
        'term: "附着测试词"',
        'english: "Attach Test"',
        'aliases: []',
        'field: "F9 测试"',
        'groups: ["MEA"]',
        'summary: "用于验证挂载已有概念页的摘要。"',
        'status: published',
        'reviewedAt: "2026-11-22"',
        'generatedBy: "e2e"',
        '---',
        '',
        '# 附着测试词',
        '',
        '## 说明',
        '',
        '这是一个用于端到端测试的已发布概念页。',
        '',
        '（出处：MEA-L02）',
        '',
      ].join('\n'),
      'utf8',
    )
    writeBoth(
      TARGET_LECTURE_FILE,
      origTarget + ['', '## F9 附着测例节', '', '第一段提到 附着测试词 一次。', '', '第二段再提到 附着测试词 一次。', ''].join('\n'),
      'utf8',
    )

    await expect(async () => {
      await gotoAndSettle(page, TARGET_LECTURE_REL, { idleTimeout: 1_200, chartsTimeout: 2_000 })
      await expect(page.locator('.vp-doc p', { hasText: '第一段提到' })).toBeVisible({ timeout: 2_000 })
    }).toPass({ intervals: [500], timeout: 30_000 })

    // 1. several hits: attach asks which one, nothing is written until a choice is made
    await selectExactTextInLocator(page, page.locator('.vp-doc p', { hasText: '第一段提到' }), '附着测试词')
    await page.locator('[data-ai-toolbar-concept="attach"]').click()
    await expect(page.locator('[data-concept-author-diff]')).toBeVisible()
    await expect(page.locator('[data-concept-hit-choice]')).toHaveCount(2)
    await expect(page.locator('[data-concept-confirm-write]')).toBeDisabled()
    expect(fs.readFileSync(TARGET_LECTURE_FILE, 'utf8')).not.toContain(`(concept:${slug})`)
    await page.locator('[data-concept-hit-choice="0"]').check()
    await expect(page.locator('[data-concept-confirm-write]')).toBeEnabled()
    const diffText = await page.locator('[data-concept-lecture-diff]').innerText()
    expect(diffText).toContain(`+第一段提到 [附着测试词](concept:${slug}) 一次。`)
    expect(diffText).not.toContain('+第二段')
    await page.locator('[data-concept-confirm-write]').click()
    await expect(page.locator('[data-concept-author-status]')).toBeVisible()
    const afterAttach = fs.readFileSync(TARGET_LECTURE_FILE, 'utf8')
    expect(afterAttach).toContain(`第一段提到 [附着测试词](concept:${slug}) 一次。`)
    expect(afterAttach).toContain('第二段再提到 附着测试词 一次。')
    await page.locator('[data-concept-author-back]').click()

    // 2. zero hits: the answer explains what to do and offers the manual syntax; nothing is written
    const session = (await (await page.request.get('/__lecture/api/concepts/author')).json()) as { csrfToken: string }
    const zero = await page.request.post('/__lecture/api/concepts/preview-confirm', {
      headers: { 'x-lecture-dev-token': session.csrfToken },
      data: { slug, lecturePath: TARGET_LECTURE_REL, selectedText: '源码里根本不存在的词' },
    })
    const zeroJson = (await zero.json()) as { mountStatus: string; manualSyntax: string; lecturePatch: string }
    expect(zeroJson.mountStatus).toBe('not_found')
    expect(zeroJson.manualSyntax).toBe(`[源码里根本不存在的词](concept:${slug})`)
    expect(zeroJson.lecturePatch).toBe('')

    // 3. delete from the selection: impact preview first, then the page goes and the link turns back into text
    const termLink = page.locator(`.vp-doc p a.lec-term[data-concept="${slug}"]`)
    await expect(async () => {
      await gotoAndSettle(page, TARGET_LECTURE_REL, { idleTimeout: 1_200, chartsTimeout: 2_000 })
      await expect(termLink).toBeVisible({ timeout: 2_000 })
    }).toPass({ intervals: [500], timeout: 30_000 })
    await selectExactTextInLocator(page, termLink, '附着测试词')
    await page.locator('[data-ai-toolbar-concept="delete"]').click()
    await expect(page.locator('[data-concept-delete-impact]')).toContainText('MEA-L02')
    expect(fs.existsSync(path.join(CONCEPTS_DIR, `${slug}.md`))).toBe(true)
    await page.locator('[data-concept-confirm-delete]').click()
    await expect(page.locator('[data-concept-author-status]')).toBeVisible()
    expect(fs.existsSync(path.join(CONCEPTS_DIR, `${slug}.md`))).toBe(false)
    const afterDelete = fs.readFileSync(TARGET_LECTURE_FILE, 'utf8')
    expect(afterDelete).not.toContain(`(concept:${slug})`)
    expect(afterDelete).toContain('第一段提到 附着测试词 一次。')
    expect(pageErrors).toEqual([])
  })

  test('WP-K3: duplicate stop (single & multi-match), supplement flow with page diff + unlinked warning, and Dashboard pending revision', async ({
    page,
    pageErrors,
  }) => {
    test.setTimeout(240_000)

    const pubSeed = (slug: string, term: string, aliases: string[], summary: string) =>
      [
        '---',
        `title: ${JSON.stringify(term)}`,
        `term: ${JSON.stringify(term)}`,
        `english: ${JSON.stringify(slug)}`,
        `aliases: [${aliases.map((a) => JSON.stringify(a)).join(', ')}]`,
        'field: "K3 E2E 测试"',
        'groups: ["MEA"]',
        `summary: ${JSON.stringify(summary)}`,
        'status: published',
        'reviewedAt: "2025-01-01"',
        'generatedBy: "seed"',
        'related: []',
        '---',
        '',
        `# ${term}`,
        '',
        '## 原始章节',
        '',
        '原有已发布内容。',
        '',
        '（出处：[MEA-L02](/mea/L02)）',
        '',
      ].join('\n')

    writeBoth(
      path.join(CONCEPTS_DIR, 'k3-supp.md'),
      pubSeed('k3-supp', 'K3已有主概念', ['K3待补充术语'], '旧版待补充摘要。'),
      'utf8',
    )
    writeBoth(
      path.join(CONCEPTS_DIR, 'dup-a-f9.md'),
      pubSeed('dup-a-f9', '重复源甲', ['K3共享别名'], '重名概念甲摘要。'),
      'utf8',
    )
    writeBoth(
      path.join(CONCEPTS_DIR, 'dup-b-f9.md'),
      pubSeed('dup-b-f9', '重复源乙', ['K3共享别名'], '重名概念乙摘要。'),
      'utf8',
    )
    writeBoth(
      TARGET_LECTURE_FILE,
      origTarget + ['', '## K3 E2E 补充与查重测例', '', '本段测试 K3待补充术语 与多命中别名 K3共享别名 的表现。', ''].join('\n'),
      'utf8',
    )

    let llmCalls = 0
    await page.route('https://openrouter.ai/api/v1/chat/completions', async (route) => {
      llmCalls++
      const rawBody = route.request().postData() || ''
      expect(rawBody).toContain('currentConcept')
      expect(rawBody).toContain('k3-supp')
      const payload = {
        slug: 'k3-supp',
        term: 'K3已有主概念',
        english: 'k3-supp',
        aliases: ['K3待补充术语'],
        field: 'K3 E2E 测试',
        groups: ['MEA'],
        summary: '补充全貌后的新版摘要。',
        related: [],
        paragraphs: [
          {
            heading: '原始章节',
            body: '原有已发布内容，顺带提及 有效数字 但暂未加链接。',
            sources: ['[MEA-L02](/mea/L02)'],
            verified: true,
          },
          {
            heading: '补充机制细节',
            body: '新增补充说明：补充已有概念写入草稿修订。',
            sources: ['[MEA-L02](/mea/L02#k3-e2e-补充与查重测例)'],
            verified: true,
          },
        ],
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
      })
    })

    await expect(async () => {
      await gotoAndSettle(page, TARGET_LECTURE_REL, { idleTimeout: 1_200, chartsTimeout: 2_000 })
      await expect(page.locator('.vp-doc p', { hasText: '本段测试' })).toBeVisible({ timeout: 2_000 })
    }).toPass({ intervals: [500], timeout: 30_000 })
    await enableMockByokInSettings(page)

    // 1. Single-match duplicate stop -> no model call, shows Open + Supplement buttons
    await selectExactTextInLocator(page, page.locator('.vp-doc p', { hasText: '本段测试' }), 'K3待补充术语')
    await page.locator('[data-ai-toolbar-concept="create"]').click()
    await page.locator('[data-concept-generate-btn]').click()

    const dupCard = page.locator('[data-concept-duplicate]')
    await expect(dupCard).toBeVisible()
    expect(llmCalls).toBe(0)
    await expect(page.locator('[data-concept-duplicate-open]')).toHaveAttribute('href', /\/concepts\/k3-supp$/)

    // 2. Click "补充已有概念" -> invokes supplement flow -> returns revision draft + non-blocking unlinked warning
    await page.locator('[data-concept-duplicate-supplement]').click()
    await expect(page.locator('[data-concept-draft-card]')).toBeVisible({ timeout: 15_000 })
    expect(llmCalls).toBe(1)
    await expect(page.locator('[data-concept-draft-warnings]')).toContainText('有效数字')
    await expect(page.locator('[data-concept-sidebar-confirm]')).toBeEnabled()

    // 3. Dashboard shows pending revision status + diff against published page -> confirm replaces published page cleanly
    await gotoAndSettle(page, '/dashboard', { idleTimeout: 3_000, chartsTimeout: 8_000 })
    await page.waitForSelector('.lec-dashboard[data-dashboard-ready="1"]')
    await page.locator('[data-dashboard-tab="figures"]').click() // v3.4: concept drafts are a tab of "figures and concepts"
    await page.locator('[data-dashboard-subtab="drafts"]').click()
    const revRow = page.locator('[data-concept-row="k3-supp"][data-concept-row-status="draft"][data-concept-row-revision="true"]')
    await expect(revRow).toBeVisible()
    await expect(revRow).toContainText('修订待确认')
    await revRow.click()

    await page.locator('[data-dc-confirm]').click()
    await expect(page.locator('[data-dc-page-diff]')).toContainText('+新增补充说明：补充已有概念写入草稿修订。')
    await page.locator('[data-dc-confirm-write]').click()
    await expect(page.locator('[data-concept-row="k3-supp"][data-concept-row-status="draft"]')).toHaveCount(0)
    expect(fs.existsSync(path.join(DRAFTS_DIR, 'k3-supp.md'))).toBe(false)
    const updatedPubRaw = fs.readFileSync(path.join(CONCEPTS_DIR, 'k3-supp.md'), 'utf8')
    expect(updatedPubRaw).toContain('status: published')
    expect(updatedPubRaw).toContain(`reviewedAt: "${new Date().toISOString().slice(0, 10)}"`)
    expect(updatedPubRaw).toContain('新增补充说明')

    // 4. Multi-match duplicate stop -> asks author to pick first without calling model
    await expect(async () => {
      await gotoAndSettle(page, TARGET_LECTURE_REL, { idleTimeout: 1_200, chartsTimeout: 2_000 })
      await expect(page.locator('.vp-doc p', { hasText: '本段测试' })).toBeVisible({ timeout: 2_000 })
    }).toPass({ intervals: [500], timeout: 30_000 })
    await selectExactTextInLocator(page, page.locator('.vp-doc p', { hasText: '本段测试' }), 'K3共享别名')
    await page.locator('[data-ai-toolbar-concept="create"]').click()
    await page.locator('[data-concept-generate-btn]').click()

    await expect(page.locator('[data-concept-duplicate-choice]')).toHaveCount(2)
    expect(llmCalls).toBe(1)
    await expect(page.locator('[data-concept-duplicate-supplement]')).toBeDisabled()
    await expect(page.locator('[data-concept-duplicate-open]')).toBeDisabled()
    await page.locator('[data-concept-duplicate-choice="dup-a-f9"]').check()
    await expect(page.locator('[data-concept-duplicate-supplement]')).toBeEnabled()
    await expect(page.locator('[data-concept-duplicate-open]')).toHaveAttribute('href', /\/concepts\/dup-a-f9$/)

    expect(pageErrors).toEqual([])
  })
})
