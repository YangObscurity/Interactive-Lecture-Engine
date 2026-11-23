/**
 * P3b WP-A2: access tiers in the browser (docs-dev/ACCESS.md).
 *
 * Runs only in the `access` Playwright project, against a dist built by `npm run build:e2e:access`
 * (groups G06 inline, G09 `authenticated`, G12 for the gateway group `staff`), served by tests/e2e/access-server.mjs.
 * The authenticating gateway is simulated with `context.route`: a denied path answers 403, everything else goes through.
 *
 *   anonymous  : `/_access/authenticated/**`, `/_access/grp-*` and the pages and page chunks of G09 and G12 are denied
 *   signed-in  : only `/_access/grp-*` and G12 are denied
 *   staff      : nothing is denied
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, gotoAndSettle } from './fixtures'
import type { Page } from '@playwright/test'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = path.join(SITE, '.access-e2e')
const DIST = path.join(ROOT, 'dist')

interface ManifestTier {
  id: string
  groupIds: string[]
  dirs: string[]
}
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'access-manifest.json'), 'utf8')) as { tiers: ManifestTier[] }
const tierOf = (groupId: string): string => manifest.tiers.find((t) => t.groupIds.includes(groupId))?.id as string
const TIER = { G09: tierOf('G09'), G12: tierOf('G12') }
const DIR = { G06: 'g06', G09: 'g09', G12: 'g12' } as const
type GroupId = keyof typeof DIR
const ALL: GroupId[] = ['G06', 'G09', 'G12']

type Who = 'anonymous' | 'signed-in' | 'staff'
const ALLOWED: Record<Who, GroupId[]> = { anonymous: ['G06'], 'signed-in': ['G06', 'G09'], staff: ALL }

/** The paths the simulated gateway refuses for each reader. */
const DENIED: Record<Who, RegExp[]> = {
  anonymous: [/^\/_access\/(authenticated|grp-[0-9a-f]+)\//, /^\/(en\/)?g09(\/|$)/, /^\/(en\/)?g12(\/|$)/, /^\/assets\/(g09|g12|en_g09|en_g12)_/],
  'signed-in': [/^\/_access\/grp-[0-9a-f]+\//, /^\/(en\/)?g12(\/|$)/, /^\/assets\/(g12|en_g12)_/],
  staff: [],
}

const readJson = <T>(...parts: string[]): T => JSON.parse(fs.readFileSync(path.join(DIST, ...parts), 'utf8')) as T

interface Slice {
  totals: { lectures: number; charts: number }
}
const slice = (g: 'G09' | 'G12') => readJson<Slice>('_access', TIER[g], 'site-data.json')
const tierGraph = (g: 'G09' | 'G12') => readJson<unknown[]>('_access', TIER[g], 'graph.json')
const lectureFiles = (g: GroupId): string[] => fs.readdirSync(path.join(DIST, DIR[g])).filter((f) => /^L\d+\.html$/.test(f)).sort()

/** What the page must show for a reader: inline numbers (read from the SSR home page) plus the allowed tiers' slices. */
function expectedHome(who: Who, inlineHome: { lectures: number; charts: number }) {
  const allowed = ALLOWED[who]
  const restricted = allowed.filter((g): g is 'G09' | 'G12' => g !== 'G06')
  const inlineNodes = readJson<unknown[]>('notion_knowledge_graph.json').length
  return {
    groups: allowed,
    lectures: inlineHome.lectures + restricted.reduce((n, g) => n + slice(g).totals.lectures, 0),
    charts: inlineHome.charts + restricted.reduce((n, g) => n + slice(g).totals.charts, 0),
    nodes: inlineNodes + restricted.reduce((n, g) => n + tierGraph(g).length, 0),
  }
}

async function installGateway(page: Page, who: Who): Promise<{ requested: string[]; denied: string[] }> {
  const requested: string[] = []
  const denied: string[] = []
  const isDenied = (p: string) => DENIED[who].some((re) => re.test(p))
  await page.context().route(
    (url) => isDenied(url.pathname),
    (route) => {
      denied.push(new URL(route.request().url()).pathname)
      return route.fulfill({ status: 403, contentType: 'text/plain', body: 'denied by the gateway' })
    },
  )
  page.on('request', (r) => requested.push(new URL(r.url()).pathname))
  return { requested, denied }
}

/** Hydration complaints of Vue / the browser, from either console channel. */
function watchHydration(page: Page): string[] {
  const out: string[] = []
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && /hydrat/i.test(m.text())) out.push(m.text())
  })
  return out
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

async function statNumbers(page: Page): Promise<number[]> {
  const texts = await page.locator('.hub-stats-strip .stat-num').allTextContents()
  return texts.map((t) => Number(t.trim()))
}

/** Text of the search box results for `query` (links of the results). */
async function searchLinks(page: Page, query: string): Promise<string[]> {
  await page.locator('.VPNavBarSearch button, #local-search button').first().click()
  const input = page.locator('#lec-search-input')
  await input.fill(query)
  // the box is idle once all shards finish loading and either hits or "no results" renders
  await expect.poll(async () => {
    const stillLoading = await page.locator('.sp-load').count()
    if (stillLoading > 0) return 0
    return (await page.locator('.sp-hit').count()) + (await page.locator('.sp-empty').count())
  }, { timeout: 20_000 }).toBeGreaterThan(0)
  const hrefs = await page.locator('.sp-hit').evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''))
  await page.keyboard.press('Escape')
  return hrefs
}

const SEARCH_WORD: Record<'G09' | 'G12', string> = { G09: 'VPC', G12: 'FreeRTOS' }

for (const who of ['anonymous', 'signed-in', 'staff'] as const) {
  test.describe(`gateway: ${who}`, () => {
    const allowed = ALLOWED[who]

    test('home page, nav menu, sidebar, search and merged graph show exactly what is allowed', async ({ page, request, pageErrors }) => {
      const hydration = watchHydration(page)
      const gw = await installGateway(page, who)

      // inline numbers come from the server-rendered home page
      const ssrHome = await (await request.get('/')).text()
      const ssrStats = [...ssrHome.matchAll(/<span\b[^>]*class="stat-num"[^>]*>(\d+)<\/span>/g)].map((m) =>
        Number(m[1])
      )
      expect(ssrStats.length, 'the SSR home page has the stat strip').toBeGreaterThanOrEqual(3)
      const want = expectedHome(who, { lectures: ssrStats[1] as number, charts: ssrStats[2] as number })

      await gotoAndSettle(page, '/')
      await page.waitForSelector('html[data-hydrated="1"]')

      // home page group cards and totals
      // P4a: the cards are the GroupCard slot (data-group), the overview map (atlas) shows exactly the readable groups too
      await expect(page.locator('#groups [data-slot="GroupCard"]')).toHaveCount(want.groups.length)
      expect(await page.locator('#groups [data-slot="GroupCard"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))).toEqual(want.groups)
      await expect.poll(() => page.locator('.am-group').evaluateAll((els) => els.map((e) => e.getAttribute('data-g')).sort())).toEqual([...want.groups].sort())
      // ... and no lecture row of a denied group, even with every branch open
      await page.locator('.am-expand button[data-x="all"]').click()
      const atlasLectures = await page.locator('.am-lec').evaluateAll((els) => els.map((e) => e.getAttribute('data-node') ?? ''))
      const dirs = want.groups.map((g) => DIR[g].split('/').pop())
      expect(atlasLectures.length).toBeGreaterThan(0)
      for (const id of atlasLectures) expect(dirs.some((d) => id.startsWith(`${d}-l`)), `${id} belongs to a readable group`).toBe(true)
      await expect.poll(() => statNumbers(page)).toEqual([want.groups.length, want.lectures, want.charts, want.nodes])

      // nav "groups" menu
      const cmenu = page.locator('.cm-trigger')
      if (await cmenu.count()) {
        await cmenu.click()
        const navLinks = page.locator('.cm-groups li a')
        await expect(navLinks).toHaveCount(want.groups.length)
        expect(await navLinks.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')))).toEqual(want.groups.map((g) => `/${DIR[g]}/`))
        await cmenu.click()
      } else {
        const navLinks = page.locator('.VPNavBarMenuGroup .VPMenuLink a')
        await expect(navLinks).toHaveCount(want.groups.length)
        expect(await navLinks.evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).getAttribute('href')))).toEqual(want.groups.map((g) => `/${DIR[g]}/`))
      }

      // merged graph: the inline graph plus the graph.json of the allowed tiers, nothing of the others
      const graphs = gw.requested.filter((p) => p.endsWith('/graph.json')).sort()
      const expectGraphs = allowed.filter((g): g is 'G09' | 'G12' => g !== 'G06').map((g) => `/_access/${TIER[g]}/graph.json`).sort()
      expect(graphs).toEqual(expectGraphs)

      // P4b dependency canvas (`graph` mode): only allowed groups & `/_access/<T>/canvas.json` requests
      await page.locator('[data-map-mode="graph"]').click()
      await page.waitForSelector('.cv-stage[data-canvas-ready="true"]', { state: 'attached' })
      await page.waitForFunction(() => document.querySelectorAll('.cv-node').length > 0)
      const canvasGroups = await page.locator('#atlas [data-slot="CanvasGroup"]').evaluateAll((els) =>
        els.map((e) => e.getAttribute('data-g')).sort(),
      )
      expect(canvasGroups).toEqual([...allowed].sort())
      for (const deniedGroup of ALL.filter((g) => !allowed.includes(g))) {
        await expect(page.locator(`.cv-node[data-id^="${DIR[deniedGroup]}-"]`)).toHaveCount(0)
      }
      const canvases = gw.requested.filter((p) => p.endsWith('/canvas.json')).sort()
      const expectCanvases = allowed.filter((g): g is 'G09' | 'G12' => g !== 'G06').map((g) => `/_access/${TIER[g]}/canvas.json`).sort()
      expect(canvases).toEqual(expectCanvases)

      // sidebar of an allowed lecture page (restricted tiers: it appears when the slice has arrived)
      for (const g of allowed) {
        await gotoAndSettle(page, `/${DIR[g]}/L01`)
        const count = lectureFiles(g).length
        await expect(page.locator('.VPSidebar a.link')).toHaveCount(count)
        await expect(page.locator('.VPSidebar .VPSidebarItem.level-0 > .item .text').first()).toContainText(g)
      }

      // search: an allowed group's distinctive word finds pages of the group, a denied one finds nothing of it
      await gotoAndSettle(page, '/')
      await page.waitForSelector('html[data-hydrated="1"]')
      for (const g of ['G09', 'G12'] as const) {
        const links = await searchLinks(page, SEARCH_WORD[g])
        const mine = links.filter((h) => h.startsWith(`/${DIR[g]}/`))
        if (allowed.includes(g)) expect(mine.length, `search for ${SEARCH_WORD[g]} finds ${g}`).toBeGreaterThan(0)
        else expect(mine, `search for ${SEARCH_WORD[g]} must not find ${g}`).toEqual([])
        for (const other of ['G09', 'G12'] as const) if (!allowed.includes(other)) expect(links.filter((h) => h.startsWith(`/${DIR[other]}/`))).toEqual([])
      }

      // nothing outside the allowed tiers was ever delivered
      for (const g of ['G09', 'G12'] as const) {
        if (allowed.includes(g)) expect(gw.denied.filter((p) => p.startsWith(`/_access/${TIER[g]}/`))).toEqual([])
      }
      expect(hydration).toEqual([])
      expect(pageErrors).toEqual([])
    })

    if (who === 'anonymous') {
      test('denied pages answer 403 and the home page never asks for a denied page chunk', async ({ page, pageErrors }) => {
        const hydration = watchHydration(page)
        const gw = await installGateway(page, who)
        for (const p of ['/g09/L01', '/g09/', '/g12/L01', '/en/g09/', '/en/g12/']) {
          const res = await page.goto(p)
          expect(res?.status(), p).toBe(403)
        }
        await gotoAndSettle(page, '/')
      await page.waitForSelector('html[data-hydrated="1"]')
        expect(gw.requested.filter((p) => /^\/assets\/(g09|g12|en_g09|en_g12)_/.test(p))).toEqual([])
        expect(hydration).toEqual([])
        expect(pageErrors).toEqual([])
      })
    } else {
      test('the group page is rendered on the server, hydrates cleanly and lists every lecture', async ({ page, request, pageErrors }) => {
        const hydration = watchHydration(page)
        await installGateway(page, who)
        const g = 'G09' as const
        const meta = readJson<{ groups: Array<{ value: { title: string; lectures: Array<{ text: string; link: string }> } }> }>('_access', TIER[g], 'site-data.json').groups[0]?.value
        expect(meta).toBeTruthy()

        // the server HTML (not the hydrated DOM): the group title and every lecture of the group
        const res = await request.get('/g09/')
        expect(res.status()).toBe(200)
        const html = await res.text()
        expect(html).toContain(escapeHtml(meta?.title ?? ''))
        for (const l of meta?.lectures ?? []) {
          expect(html, `server HTML lists ${l.link}`).toContain(`href="${l.link}"`)
          // the group page shows the title without its "第N讲 · " prefix (the number is its own element)
          expect(html, `server HTML lists the title of ${l.link}`).toContain(escapeHtml(l.text.replace(/^\s*第\s*\d+\s*讲\s*[·:：—-]\s*/, '')))
        }
        const ssrRows = (html.match(/class="gp-lc/g) ?? []).length

        await gotoAndSettle(page, '/g09/')
        const rows = page.locator('.gp-lanes a.gp-lc')
        await expect(rows).toHaveCount(meta?.lectures.length ?? -1)
        expect(ssrRows).toBe(meta?.lectures.length)
        expect(hydration).toEqual([])
        expect(pageErrors).toEqual([])
      })

      test('a lecture of the restricted tier loads its chart from /_access/<tier>/charts/ and the layout shift is measured', async ({ page, pageErrors }) => {
        const hydration = watchHydration(page)
        const gw = await installGateway(page, who)
        const chartFile = fs.readdirSync(path.join(DIST, '_access', TIER.G09, 'charts')).sort()[0] as string
        const lecture = /^G09-(L\d+)\.json$/.exec(chartFile)?.[1]
        expect(lecture, `a G09 chart file (${chartFile})`).toBeTruthy()

        // layout-shift entries and the position of the article, before the page scripts run
        await page.addInitScript(() => {
          const w = window as unknown as { __LS__: Array<{ value: number; t: number }>; __DOC_LEFT__: Array<{ left: number; t: number }>; __SIDEBAR_AT__?: number }
          w.__LS__ = []
          w.__DOC_LEFT__ = []
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__LS__.push({ value: e.value, t: performance.now() })
          }).observe({ type: 'layout-shift', buffered: true })
          const sample = () => {
            const el = document.querySelector('.vp-doc')
            if (el) w.__DOC_LEFT__.push({ left: Math.round(el.getBoundingClientRect().left), t: performance.now() })
            if (w.__SIDEBAR_AT__ === undefined && document.querySelector('.VPSidebar a.link')) w.__SIDEBAR_AT__ = performance.now()
          }
          document.addEventListener('DOMContentLoaded', sample)
          setInterval(sample, 50)
        })

        const done = await gotoAndSettle(page, `/g09/${lecture}`)
        expect(done, 'charts settled').toBe(true)
        await expect(page.locator('.VPSidebar a.link')).toHaveCount(lectureFiles('G09').length)

        const chartRequests = gw.requested.filter((p) => p.endsWith('.json') && p.includes('/charts/'))
        expect(chartRequests, 'chart data comes from the tier path').toContain(`/_access/authenticated/charts/${chartFile}`)
        expect(chartRequests.filter((p) => !p.startsWith('/_access/authenticated/charts/'))).toEqual([])
        expect(await page.locator('figure.chart svg, figure.chart canvas').count()).toBeGreaterThan(0)

        const m = await page.evaluate(() => {
          const w = window as unknown as { __LS__: Array<{ value: number; t: number }>; __DOC_LEFT__: Array<{ left: number; t: number }>; __SIDEBAR_AT__?: number }
          const lefts = w.__DOC_LEFT__
          const at = w.__SIDEBAR_AT__
          // the shift entries within 150 ms of the sidebar's first appearance (the chart rendering shifts later and is not the sidebar's doing)
          const near = at === undefined ? [] : w.__LS__.filter((e) => e.t <= at + 150 && e.t >= at - 150)
          return { cls: w.__LS__.reduce((n, e) => n + e.value, 0), sidebarCls: near.reduce((n, e) => n + e.value, 0), sidebarAt: at === undefined ? null : Math.round(at), entries: w.__LS__.length, firstLeft: lefts[0]?.left ?? null, lastLeft: lefts.at(-1)?.left ?? null, viewport: window.innerWidth }
        })
        const info = { page: `/g09/${lecture}`, who, cumulativeLayoutShift: Number(m.cls.toFixed(4)), shiftOfSidebarAppearing: Number(m.sidebarCls.toFixed(4)), sidebarAppearedAtMs: m.sidebarAt, shiftEntries: m.entries, articleLeftBeforeSidebarPx: m.firstLeft, articleLeftAfterSidebarPx: m.lastLeft, viewportWidthPx: m.viewport }
        test.info().annotations.push({ type: 'layout-shift', description: JSON.stringify(info) })
        console.warn(`[access-e2e] layout shift ${JSON.stringify(info)}`)
        // the inline sidebar placeholder lays the page out with its sidebar column from the server render:
        // the article must not move sideways when the tier's sidebar arrives (it moved 160 px, CLS 0.35, before the
        // placeholder). What is left (about 0.04-0.07: the sidebar filling in, plus the nav bar shift every page has)
        // must stay in the Web Vitals "good" range.
        expect(m.firstLeft, 'article left edge before the sidebar arrives').toBe(m.lastLeft)
        expect(m.sidebarCls, 'layout shift around the sidebar arriving').toBeLessThan(0.1)
        // the title block took the place the empty placeholder kept for it
        await expect(page.locator('.lec-tb')).toHaveCount(1)
        await expect(page.locator('.lec-tb-ph')).toHaveCount(0)
        expect(hydration).toEqual([])
        expect(pageErrors).toEqual([])
      })

      test('a restricted lecture whose tier data fails to arrive drops the empty title placeholder', async ({ page, pageErrors }) => {
        await installGateway(page, who)
        // the page itself came through the gateway, but the tier's site data does not (network error)
        await page.route('**/_access/*/site-data.json', (route) => route.abort())
        const lecture = (lectureFiles('G09')[0] as string).replace(/\.html$/, '')
        await page.goto(`/g09/${lecture}`)
        await page.waitForSelector('html[data-hydrated="1"]')
        await expect(page.locator('.lec-tb-ph')).toHaveCount(0)
        await expect(page.locator('.lec-tb')).toHaveCount(0)
        // these lectures carry their title only in the title block, so the article simply starts at the top: no empty box above it
        await expect(page.locator('.vp-doc')).toBeVisible()
        expect(await page.locator('.vp-doc').evaluate((el) => Math.round(el.getBoundingClientRect().top))).toBeLessThan(200)
        expect(pageErrors).toEqual([])
      })
    }
  })
}

// ---- P4a WP-H1: the curriculum of each restricted tier (docs-dev/MAP.md section 1.4) --------------------------------

interface CurriculumSliceFile {
  version: number
  tier: string
  locale: string
  groups: Array<{ order: number; inlineBefore: number; value: { id: string; title: string; lectures: Array<{ id: string; title: string }> } }>
  edges: Array<[string, string]>
}

test.describe('curriculum slices', () => {
  test('every restricted tier has one valid file per locale with only its own groups, and its titles', () => {
    for (const g of ['G09', 'G12'] as const) {
      const site = readJson<{ groups: Array<{ value: { title: string; lectures: Array<{ text: string }> } }> }>('_access', TIER[g], 'site-data.json').groups[0]?.value
      for (const locale of ['root', 'en']) {
        const s = readJson<CurriculumSliceFile>('_access', TIER[g], `curriculum.${locale}.json`)
        expect(s.version).toBe(1)
        expect(s.tier).toBe(TIER[g])
        expect(s.locale).toBe(locale)
        expect(s.groups.map((p) => p.value.id)).toEqual([g])
        expect(s.groups[0]?.value.title).toBe(site?.title)
        expect(s.groups[0]?.value.lectures.length).toBe(lectureFiles(g).length)
        // every edge has an end in this tier, and the lecture ids of the tier follow the lecture folder
        const mine = (id: string): boolean => id.startsWith(`${DIR[g]}-l`)
        expect(s.edges.length).toBeGreaterThan(0)
        expect(s.edges.every(([a, b]) => mine(a) || mine(b))).toBe(true)
        expect(s.groups[0]?.value.lectures.every((l) => mine(l.id))).toBe(true)
      }
    }
    // the inline tier has no slice (its part is the data loader's)
    expect(fs.existsSync(path.join(DIST, '_access', 'public'))).toBe(false)
  })

  // P4a WP-H3: the Notion fields (说明 ...) of a restricted group's lectures travel with its tier file only
  test('the 说明 of a restricted lecture is in its tier file and in no inline or other tier file', () => {
    const descs = (g: 'G09' | 'G12'): string[] =>
      readJson<{ groups: Array<{ value: { lectures: Array<{ desc?: string }> } }> }>('_access', TIER[g], 'curriculum.root.json')
        .groups[0]?.value.lectures.flatMap((l) => (l.desc ? [l.desc] : [])) ?? []
    const g09 = descs('G09')
    expect(g09.length, 'G09 lectures have a 说明 in the Notion snapshot').toBeGreaterThan(0)
    const needles = g09.map((d) => Array.from(d).slice(0, 12).join(''))
    const others = [path.join(DIST, '_access', TIER.G12, 'curriculum.root.json'), path.join(DIST, '_access', TIER.G12, 'site-data.json')]
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name === '_access' || e.name === 'g09') continue
          walk(f, out)
        } else if (/\.(js|json|html)$/.test(e.name)) out.push(f)
      }
      return out
    }
    for (const f of [...others, ...walk(DIST)]) {
      const text = fs.readFileSync(f, 'utf8')
      for (const n of needles) expect(text.includes(n), `${path.relative(DIST, f)} must not contain a G09 说明 (${n})`).toBe(false)
    }
    // ... and the tier's own file does carry them, so the checks above are not vacuous
    const own = fs.readFileSync(path.join(DIST, '_access', TIER.G09, 'curriculum.root.json'), 'utf8')
    for (const n of needles) expect(own.includes(n)).toBe(true)
  })

  for (const who of ['anonymous', 'signed-in', 'staff'] as const) {
    test(`the gateway treats curriculum.<locale>.json and canvas.json like the other tier files: ${who}`, async ({ page }) => {
      await installGateway(page, who)
      await gotoAndSettle(page, '/')
      await page.waitForSelector('html[data-hydrated="1"]')
      const urls = (['G09', 'G12'] as const).flatMap((g) => [
        ...['root', 'en'].map((l) => `/_access/${TIER[g]}/curriculum.${l}.json`),
        `/_access/${TIER[g]}/canvas.json`,
      ])
      const status = await page.evaluate(async (list) => Promise.all(list.map(async (u) => (await fetch(u, { cache: 'no-store' })).status)), urls)
      const want = urls.map((u) => (ALLOWED[who].some((g) => g !== 'G06' && u.includes(`/${TIER[g as 'G09' | 'G12']}/`)) ? 200 : 403))
      expect(status).toEqual(want)
    })
  }

  test('canvas.json per restricted tier has zero cross-tier leakage', () => {
    for (const g of ['G09', 'G12'] as const) {
      const other = g === 'G09' ? 'g12-' : 'g09-'
      const raw = fs.readFileSync(path.join(DIST, '_access', TIER[g], 'canvas.json'), 'utf8')
      expect(raw.includes(other), `${g} canvas.json must not leak ${other}`).toBe(false)
      const s = JSON.parse(raw) as {
        version: number
        tier: string
        boardWithInline: { reader: { groups: Array<{ id: string }> } }
        tierOwn: { reader: { groups: Array<{ id: string }> } }
      }
      expect(s.version).toBe(1)
      expect(s.tier).toBe(TIER[g])
      expect(s.boardWithInline.reader.groups.map((x) => x.id).sort()).toEqual(['G06', g].sort())
      expect(s.tierOwn.reader.groups.map((x) => x.id)).toEqual([g])
    }
  })
})
