/**
 * tests/e2e/concept-panels.spec.ts - K1: the three panels at the end of a concept page and the per-tier tool data.
 *
 * prod only (a production build is required: `tools/*.json` are written by `buildEnd`). The five published concepts
 * (`docs/concepts/*.md`) are the fixture; the expected backlinks are derived here from the Markdown files with a
 * deliberately simple regex, not from the code under test.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, gotoAndSettle, DOCS_ROOT } from './fixtures'
import { THEME_MODES, useTheme } from './theme-helpers'

const CONCEPTS_DIR = path.join(DOCS_ROOT, 'concepts')

function publishedSlugs(): string[] {
  return fs
    .readdirSync(CONCEPTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort()
}

/** slug -> sorted slugs of the concept pages whose body links to it (`](concept:<slug>`). */
function expectedBacklinks(): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(publishedSlugs().map((s) => [s, []]))
  for (const slug of publishedSlugs()) {
    const body = fs.readFileSync(path.join(CONCEPTS_DIR, `${slug}.md`), 'utf8')
    const targets = new Set([...body.matchAll(/\]\(concept:([a-z0-9-]+)/g)].map((m) => m[1] as string))
    for (const t of targets) if (t !== slug && out[t]) out[t]!.push(slug)
  }
  for (const k of Object.keys(out)) out[k]!.sort()
  return out
}

interface ToolConcept {
  slug: string
  term: string
  related: Array<{ slug: string; rel: string }>
  links: string[]
  backlinks: string[]
  lectures: Array<{ route: string; id: string; title: string; count: number }>
  markdown: string
  url: string
}

test.describe('concept page panels and tool data (@concept-panels)', () => {
  test.beforeEach(() => {
    test.skip(test.info().project.name !== 'prod', 'needs the production build (tools/*.json come from buildEnd)')
  })

  test('/concepts/actuation-lease: related (by role), cited-by and lecture panels with working links', async ({ page, pageErrors }) => {
    await gotoAndSettle(page, '/concepts/actuation-lease', { idleTimeout: 4_000, chartsTimeout: 6_000 })
    const root = page.locator('[data-concept-related]')
    await expect(root).toBeVisible()

    const related = root.locator('[data-concept-panel="related"]')
    await expect(related.locator('h2')).toHaveText('相关概念')
    // `related: optimistic-concurrency-control (prerequisite)` on this page; the other page lists this one as `applied-in`,
    // and a pair written on both pages shows the other concept once, under this page's own relation
    await expect(related.locator('[data-rel-role="prerequisite"] h3')).toHaveText('前置概念')
    await expect(related.locator('[data-rel-role="prerequisite"] [data-concept-link="optimistic-concurrency-control"]')).toBeVisible()
    await expect(related.locator('[data-rel-role="applies"]')).toHaveCount(0)
    await expect(related.locator('[data-concept-link="optimistic-concurrency-control"]')).toHaveCount(1)

    const backlinks = root.locator('[data-concept-panel="backlinks"]')
    await expect(backlinks.locator('h2')).toHaveText('被这些概念引用')
    await expect(backlinks.locator('[data-concept-link]')).toHaveCount(1)
    await expect(backlinks.locator('[data-concept-link="optimistic-concurrency-control"]')).toContainText('乐观并发控制')

    const lectures = root.locator('[data-concept-panel="lectures"]')
    await expect(lectures.locator('h2')).toHaveText('出现在这些讲')
    const lectureLink = lectures.locator('a[data-lecture-link="LR-L01"]')
    await expect(lectureLink).toHaveAttribute('href', '/lr/L01')
    await expect(lectureLink).toContainText(/\d+ 处/)

    // concept card navigates to the other concept page, whose panels point back here
    await backlinks.locator('[data-concept-link="optimistic-concurrency-control"]').click()
    await expect(page).toHaveURL(/\/concepts\/optimistic-concurrency-control$/)
    await expect(page.locator('[data-concept-panel="related"] [data-rel-role="applied-in"] [data-concept-link="actuation-lease"]')).toBeVisible()
    await expect(page.locator('[data-concept-panel="backlinks"] [data-concept-link="actuation-lease"]')).toBeVisible()
    expect(pageErrors).toEqual([])
  })

  test('a panel without entries is not rendered', async ({ page }) => {
    await gotoAndSettle(page, '/concepts/int8-quantization', { idleTimeout: 4_000, chartsTimeout: 6_000 })
    const root = page.locator('[data-concept-related]')
    await expect(root.locator('[data-concept-panel="lectures"]')).toBeVisible()
    await expect(root.locator('[data-concept-panel="related"]')).toHaveCount(0)
    await expect(root.locator('[data-concept-panel="backlinks"]')).toHaveCount(0)
  })

  for (const [theme, mode] of THEME_MODES) {
    for (const [label, size] of [['desktop', { width: 1280, height: 900 }], ['375px', { width: 375, height: 800 }]] as const) {
      test(`panels fit and wear the ${theme} shape (${mode}, ${label})`, async ({ page }) => {
        await page.setViewportSize(size)
        await useTheme(page, theme, mode)
        await gotoAndSettle(page, '/concepts/actuation-lease', { idleTimeout: 4_000, chartsTimeout: 6_000 })
        const root = page.locator('[data-concept-related]')
        await root.scrollIntoViewIfNeeded()
        await expect(root.locator('[data-concept-panel]')).toHaveCount(3)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
        expect(overflow).toBeLessThanOrEqual(0)
        const box = await root.boundingBox()
        expect(box!.x + box!.width).toBeLessThanOrEqual(size.width)
        const card = root.locator('.lec-cpanel-card').first()
        const style = await card.evaluate((el) => {
          const s = getComputedStyle(el)
          return { left: Number.parseFloat(s.borderLeftWidth), top: Number.parseFloat(s.borderTopWidth), radius: Number.parseFloat(s.borderTopLeftRadius) }
        })
        if (theme === 'datasheet') {
          // datasheet: square card with a heavy left edge; reader: hairline all round with a rounded corner
          expect(style.left).toBeGreaterThan(style.top)
          expect(style.radius).toBeLessThanOrEqual(2)
        } else {
          expect(style.left).toBe(style.top)
          expect(style.radius).toBeGreaterThanOrEqual(4)
        }
      })
    }
  }

  test('tools/concepts.json lists the five concepts with correct backlinks; tiers.json and lectures.json are served', async ({ request }) => {
    const slugs = publishedSlugs()
    expect(slugs).toHaveLength(5)
    const res = await request.get('/tools/concepts.json')
    expect(res.status()).toBe(200)
    const data = (await res.json()) as { version: number; tier: string; generatedAt: string; concepts: ToolConcept[] }
    expect(data.version).toBe(1)
    expect(typeof data.tier).toBe('string')
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false)
    expect(data.concepts.map((c) => c.slug).sort()).toEqual(slugs)

    const expected = expectedBacklinks()
    for (const c of data.concepts) {
      expect(c.backlinks, `backlinks of ${c.slug}`).toEqual(expected[c.slug])
      expect(c.url).toBe(`/concepts/${c.slug}`)
      expect(c.markdown.length).toBeGreaterThan(100)
      expect(c.markdown).not.toContain('status: published')
      for (const rel of c.related) expect(slugs).toContain(rel.slug)
    }
    const lease = data.concepts.find((c) => c.slug === 'actuation-lease')!
    expect(lease.related).toEqual([{ slug: 'optimistic-concurrency-control', rel: 'prerequisite' }])
    expect(lease.links).toEqual(['optimistic-concurrency-control'])
    expect(lease.lectures.some((l) => l.id === 'LR-L01' && l.route === '/lr/L01' && l.count >= 1)).toBe(true)

    const tiers = (await (await request.get('/tools/tiers.json')).json()) as { version: number; tiers: Array<{ id: string; read: string; path: string }> }
    expect(tiers.version).toBe(1)
    expect(tiers.tiers[0]).toMatchObject({ id: data.tier, path: '/tools/' })

    // lectures.json is ~19 MB for this site: only its headers are checked here (unit tests cover the sections)
    const head = await request.head('/tools/lectures.json')
    expect(head.status()).toBe(200)
    expect(Number(head.headers()['content-length'] ?? 0)).toBeGreaterThan(1_000_000)
  })
})
