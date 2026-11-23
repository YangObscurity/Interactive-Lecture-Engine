/**
 * DOM contract freeze. External consumers depend on these hooks:
 *   plugins/lectureExportPlugin.mjs, scripts/pregenerate_assets.mjs, scripts/check_body_links.py and site audit scripts.
 * V2 may restyle anything, but every assertion here must keep passing. Expected counts are
 * derived from the markdown sources at test time — no hard-coded numbers, no vacuous passes.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, gotoAndSettle, DOCS_ROOT } from './fixtures'

// ---------------------------------------------------------------- markdown-derived expectations

/** Remove fenced code blocks so placeholders/maths shown as code samples are not counted. */
function stripFences(md: string): string {
  const out: string[] = []
  let fence: string | null = null // e.g. "```" or "~~~~"
  for (const line of md.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence === null) {
      if (marker) fence = marker
      else out.push(line)
    } else if (
      marker &&
      marker.startsWith(fence.charAt(0)) &&
      marker.length >= fence.length &&
      /^ {0,3}[`~]+\s*$/.test(line)
    ) {
      fence = null
    }
  }
  return out.join('\n')
}

interface LectureInfo {
  file: string
  url: string
  /** sidecar placeholders: <figure class="chart" data-lecture=…> */
  figures: number
  /** ```mermaid fences → runtime figure.chart.inline-mermaid */
  inlineMermaid: number
  cites: number
  /** $$…$$, \[…\] (blocks) and \(…\) (inline) — the only delimiters math.mts handles */
  mathBlocks: number
  mathInline: number
}

function readLecture(rel: string): LectureInfo {
  const raw = fs.readFileSync(path.join(DOCS_ROOT, rel), 'utf8')
  const body = stripFences(raw)
  const count = (re: RegExp) => (body.match(re) || []).length
  return {
    file: rel,
    url: '/' + rel.replace(/\\/g, '/').replace(/\.md$/, ''),
    figures: count(/<figure\s+class="chart"[^>]*\bdata-lecture=/g),
    inlineMermaid: (raw.match(/^\s*```mermaid\b/gm) || []).length,
    cites: count(/class="cite"/g),
    mathBlocks: count(/\$\$[\s\S]+?\$\$/g) + count(/\\\[[\s\S]+?\\\]/g),
    mathInline: count(/\\\([\s\S]+?\\\)/g),
  }
}

function lecturesIn(dir: string): LectureInfo[] {
  const abs = path.join(DOCS_ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs
    .readdirSync(abs)
    .filter((f) => /^L\d+.*\.md$/.test(f))
    .sort()
    .map((f) => readLecture(`${dir}/${f}`))
}

/** group dirs whose index.md mounts <GroupIndex /> */
const GROUP_DIRS = fs
  .readdirSync(DOCS_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name)
  .filter((d) => {
    const idx = path.join(DOCS_ROOT, d, 'index.md')
    return fs.existsSync(idx) && /<GroupIndex\b/.test(fs.readFileSync(idx, 'utf8'))
  })
  .sort()

// Primary contract lecture: first G01 lecture that has chart placeholders, cites AND math.
const G01 = lecturesIn('g01')
const PRIMARY = G01.find((l) => l.figures > 0 && l.cites > 0 && l.mathBlocks + l.mathInline > 0)

// ---------------------------------------------------------------- shared helpers

/** 503s from the disabled backend show up as "Failed to load resource" console errors — expected noise. */
const isBackendNoise = (t: string) => /Failed to load resource.*\b503\b/.test(t)

const unexpectedConsole = (errs: string[]) => errs.filter((t) => !isBackendNoise(t))

async function assertChartsContract(page: import('@playwright/test').Page, info: LectureInfo) {
  const sidecar = page.locator('figure.chart:not(.inline-mermaid)')
  const inline = page.locator('figure.chart.inline-mermaid')
  await expect(sidecar, `${info.file}: sidecar figure count`).toHaveCount(info.figures)
  await expect(inline, `${info.file}: inline mermaid figure count`).toHaveCount(info.inlineMermaid)

  const all = page.locator('figure.chart')
  const n = await all.count()
  expect(n, `${info.file}: total figure.chart`).toBe(info.figures + info.inlineMermaid)
  // every figure eventually gets data-rendered + skeleton + a terminal status
  await expect(page.locator('figure.chart:not([data-rendered])')).toHaveCount(0)
  await expect(page.locator('figure.chart[data-chart-status="loading"]')).toHaveCount(0, { timeout: 30_000 })
  for (let i = 0; i < n; i++) {
    const fig = all.nth(i)
    await expect(fig).toHaveAttribute('data-rendered', /.+/)
    await expect(fig).toHaveAttribute('data-chart-status', 'ok')
    await expect(fig.locator('.chart-body')).toHaveCount(1)
    // spec board 07: no tag / tool bar / source button; one hover enlarge icon
    await expect(fig.locator('.chart-tools, .chart-tag')).toHaveCount(0)
    await expect(fig.locator('button.chart-enlarge[data-act="expand"]')).toHaveCount(1)
  }
  await expect(page.locator('[data-chart-status]')).toHaveCount(n)
  expect(await page.evaluate(() => (window as unknown as { __CHARTS_DONE__?: boolean }).__CHARTS_DONE__)).toBe(true)
}

// ---------------------------------------------------------------- tests

test.describe('DOM contract', () => {
  test('preconditions: lecture & group lists are non-empty (no vacuous pass)', () => {
    expect(G01.length, 'docs/g01/L*.md').toBeGreaterThan(0)
    expect(PRIMARY, 'a g01 lecture with charts + cites + math').toBeDefined()
    expect(GROUP_DIRS.length, 'group index pages with <GroupIndex />').toBeGreaterThan(0)
  })

  test('lecture page: shell hooks, charts, cites, math, body-link gate', async ({ page, pageErrors, consoleErrors }) => {
    const info = PRIMARY
    if (!info) throw new Error('no primary g01 lecture (see preconditions test)')
    const done = await gotoAndSettle(page, info.url)
    expect(done, '__CHARTS_DONE__ observed').toBe(true)

    // shell hooks used by export plugin / audits
    await expect(page.locator('.vp-doc')).toHaveCount(1)
    await expect(page.locator('.VPDoc .content-container')).toHaveCount(1)
    expect(await page.locator('.VPDocAsideOutline a').count()).toBeGreaterThan(0)
    expect(await page.locator('.outline-link').count()).toBeGreaterThan(0)

    await assertChartsContract(page, info)

    // .cite chips render as <span>, one per source occurrence
    await expect(page.locator('.vp-doc .cite[data-cite]')).toHaveCount(info.cites)
    expect(await page.locator('.vp-doc .cite').evaluateAll((els) => els.every((e) => e.tagName === 'SPAN'))).toBe(true)

    // body-link gate (check_body_links.py): no real external <a> inside the document body
    await expect(page.locator('.vp-doc a[href^="http"]')).toHaveCount(0)

    // build-time KaTeX: every delimiter pair becomes a .math-node carrying its TeX source
    await expect(page.locator('.vp-doc .math-node.math-block[data-tex]')).toHaveCount(info.mathBlocks)
    await expect(page.locator('.vp-doc .math-node.math-inline[data-tex]')).toHaveCount(info.mathInline)

    expect(pageErrors.map(String)).toEqual([])
    expect(unexpectedConsole(consoleErrors)).toEqual([])
  })

  test('lecture SSR HTML: no <a href="http…"> anywhere in the shipped page (check_body_links gate)', async ({ request }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod', 'gate applies to built HTML only')
    if (!PRIMARY) throw new Error('no primary g01 lecture (see preconditions test)')
    const res = await request.get(PRIMARY.url)
    expect(res.status()).toBe(200)
    const html = await res.text()
    expect(html.match(/class="cite"/g)?.length ?? 0, 'instrument self-check: cites present').toBeGreaterThan(0)
    expect(html.match(/<a\s[^>]*href="https?:\/\/[^"]*"[^>]*>/g) ?? []).toEqual([])
  })

  test('home page renders', async ({ page, pageErrors }) => {
    await gotoAndSettle(page, '/')
    await expect(page.locator('#app')).not.toBeEmpty()
    await expect(page.locator('.VPHome, .VPContent').first()).toBeVisible()
    expect(pageErrors.map(String)).toEqual([])
  })

  for (const dir of GROUP_DIRS) {
    test(`group index /${dir}/ returns 200 without pageerror`, async ({ page, pageErrors }) => {
      const res = await page.goto(`/${dir}/`, { waitUntil: 'domcontentloaded' })
      expect(res?.status()).toBe(200)
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
      await expect(page.locator('.VPContent')).toBeVisible()
      expect(pageErrors.map(String)).toEqual([])
    })
  }

  // plan §8: one lecture per group — rendered figure count == placeholder count, no console error
  for (const dir of GROUP_DIRS) {
    test(`group ${dir}: first charted lecture renders every figure`, async ({ page, pageErrors, consoleErrors }) => {
      const lecs = lecturesIn(dir)
      expect(lecs.length, `docs/${dir}/L*.md`).toBeGreaterThan(0)
      const info = lecs.find((l) => l.figures > 0) ?? lecs[0]
      if (!info) throw new Error(`docs/${dir}: no lecture found`)
      await gotoAndSettle(page, info.url)
      if (info.figures + info.inlineMermaid > 0) await assertChartsContract(page, info)
      await expect(page.locator('.vp-doc a[href^="http"]')).toHaveCount(0)
      expect(pageErrors.map(String)).toEqual([])
      expect(unexpectedConsole(consoleErrors)).toEqual([])
    })
  }
})
