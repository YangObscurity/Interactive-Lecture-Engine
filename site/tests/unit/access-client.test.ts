/**
 * P3b WP-A2: the client side of the access tiers (theme/access/*, the search plugin, the dev routes, the asset prefix).
 * Everything runs against a scripted gateway (a stub `fetch`); no browser and no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import MiniSearch from 'minisearch'
import { shallowRef } from 'vue'
import type { SearchDocument } from '../../docs/.vitepress/access/search'
import { mergeSiteData, splitGraph, splitSiteData } from '../../docs/.vitepress/access/siteData'
import type { GraphNodeLike, SiteLike, TierSlice } from '../../docs/.vitepress/access/siteData'
import { lookupTier, resolveAccess as planAccess } from '../../docs/.vitepress/access/tiers'
import type { LectureAccess } from '../../docs/.vitepress/access/tiers'
import { accessSearchPlugin, localesOfIndexSource, searchIndexModule } from '../../docs/.vitepress/access/vitePlugins.mts'
import { v2Search } from '../../docs/.vitepress/config.v2.mts'
import { getPageTier, setPageTier, tierAssetPrefix } from '../../docs/.vitepress/theme/access/paths'
import { EMPTY_ACCESS, fetchTierJson, loadMergedGraph, loadTierGraphs, resolveAccess } from '../../docs/.vitepress/theme/access/resolve'
import type { AccessDeps } from '../../docs/.vitepress/theme/access/resolve'
import { buildSearchIndex, mergeSearchIndex, searchIndexOptions } from '../../docs/.vitepress/theme/access/searchIndex'
import { accessVersion, configureAccess, currentAccessConfig, identityKey, lectureAccessOf, loadGraph, startAccess, subscribeAccess } from '../../docs/.vitepress/theme/access/store'
import { resetSession } from '../../docs/.vitepress/theme/auth/session'
import type { SessionState } from '../../docs/.vitepress/theme/auth/session'
import { createSidecarLoader } from '../../docs/.vitepress/theme/charts/sidecar'

// ---- a scripted gateway -------------------------------------------------------------------------------------------

type Verdict = number | 'network' | 'redirect' | 'html'
interface Call {
  url: string
  init: RequestInit | undefined
}

class Gateway {
  readonly calls: Call[] = []
  /** url (without query) -> body; a missing url is a 404. */
  readonly files = new Map<string, unknown>()
  /** Rule: path prefix -> verdict. First match wins; default 200. */
  rules: Array<[string, Verdict]> = []
  readonly fetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    this.calls.push({ url, init })
    const path = url.split('?')[0] as string
    const verdict = this.rules.find(([p]) => path.startsWith(p))?.[1] ?? 200
    if (verdict === 'network') return Promise.reject(new TypeError('network down'))
    if (verdict === 'redirect') return Promise.resolve({ status: 0, ok: false, type: 'opaqueredirect', json: () => Promise.reject(new Error('opaque')) } as unknown as Response)
    if (verdict === 'html') return Promise.resolve(new Response('<!doctype html><title>login</title>', { status: 200, headers: { 'content-type': 'text/html' } }))
    if (verdict !== 200) return Promise.resolve(new Response('denied', { status: verdict }))
    if (!this.files.has(path)) return Promise.resolve(new Response('missing', { status: 404 }))
    return Promise.resolve(new Response(JSON.stringify(this.files.get(path)), { status: 200, headers: { 'content-type': 'application/json' } }))
  }
  urls(): string[] {
    return this.calls.map((c) => c.url)
  }
}

const deps = (gw: Gateway, base = ''): AccessDeps => ({ fetch: gw.fetch, withBase: (p) => `${base}${p}` })

// ---- a site with one inline group and two restricted tiers ----------------------------------------------------------

const GROUPS = [
  { id: 'G06', dir: 'g06' },
  { id: 'G09', dir: 'g09' },
  { id: 'G12', dir: 'g12' },
]

const plan = planAccess({
  access: { default: 'public', enforcement: 'gateway', groups: { G09: { read: 'authenticated' }, G12: { read: ['staff'] } } },
  groupIds: GROUPS.map((g) => g.id),
})
const T_AUTH = 'authenticated'
const T_STAFF = plan.tiers.find((t) => t.id !== T_AUTH)?.id as string

function makeSite(): SiteLike {
  const entries = GROUPS.map((g) => ({ id: g.id, dir: g.dir, title: `Title ${g.id}`, lectures: [{ n: 1, text: `Lecture ${g.id}`, link: `/${g.dir}/L01` }], lectureCount: 1, chartCount: 1 }))
  return {
    themeConfig: {
      nav: [
        { text: 'Home', link: '/' },
        { text: 'Groups', items: entries.map((g) => ({ text: `${g.id} ${g.title}`, link: `/${g.dir}/` })) },
      ],
      sidebar: Object.fromEntries(entries.map((g) => [`/${g.dir}/`, [{ text: g.title, items: g.lectures.map((l) => ({ text: l.text, link: l.link })) }]])),
      groups: entries,
      totals: { lectures: 3, charts: 3 },
      i18nPages: {},
    },
    locales: {},
  }
}

function build() {
  const full = makeSite()
  const split = splitSiteData(full, { groups: GROUPS.map((g) => ({ ...g })), tierOfGroup: (id) => plan.tierOfGroup[id] as string, inlineTier: plan.inlineTier, localeKeys: [] })
  const inline = split.inline
  const lectureAccess: LectureAccess = { inlineTier: plan.inlineTier, tiers: plan.tiers.map((t) => t.id) }
  ;(inline.themeConfig as Record<string, unknown>).lectureAccess = lectureAccess
  return { full, inline, slices: split.slices, lectureAccess }
}

const groupIds = (site: unknown): string[] => ((site as SiteLike).themeConfig?.groups as Array<{ id: string }>).map((g) => g.id)

describe('resolveAccess', () => {
  it('makes no request at all when there is no restricted tier', async () => {
    const gw = new Gateway()
    expect(await resolveAccess(undefined, deps(gw))).toBe(EMPTY_ACCESS)
    expect(await resolveAccess({ inlineTier: 'public', tiers: [] }, deps(gw))).toBe(EMPTY_ACCESS)
    expect(gw.calls).toEqual([])
  })

  it('asks for site-data.json of every tier with manual redirects, same-origin credentials and no cache', async () => {
    const { slices, lectureAccess } = build()
    const gw = new Gateway()
    for (const [tier, slice] of Object.entries(slices)) gw.files.set(`/base/_access/${tier}/site-data.json`, slice)
    const r = await resolveAccess(lectureAccess, deps(gw, '/base'))
    expect(r.tiers.map((t) => t.id).sort()).toEqual([...lectureAccess.tiers].sort())
    expect(gw.calls).toHaveLength(2)
    for (const c of gw.calls) expect(c.init).toEqual({ redirect: 'manual', credentials: 'same-origin', cache: 'no-store' })
    expect(gw.urls().every((u) => u.endsWith('/site-data.json') && u.startsWith('/base/_access/'))).toBe(true)
  })

  it.each<[string, Verdict]>([
    ['401', 401],
    ['403', 403],
    ['a redirect to a login page', 'redirect'],
    ['a network error', 'network'],
    ['a 200 that is a login page, not JSON', 'html'],
    ['a 500', 500],
  ])('a tier counts as unreadable on %s', async (_label, verdict) => {
    const { slices, lectureAccess } = build()
    const gw = new Gateway()
    for (const [tier, slice] of Object.entries(slices)) gw.files.set(`/_access/${tier}/site-data.json`, slice)
    gw.rules = [[`/_access/${T_STAFF}/`, verdict]]
    const r = await resolveAccess(lectureAccess, deps(gw))
    expect(r.tiers.map((t) => t.id)).toEqual([T_AUTH])
  })

  it('refuses a 200 whose JSON is not a slice, or a slice of another tier', async () => {
    const { slices, lectureAccess } = build()
    const gw = new Gateway()
    gw.files.set(`/_access/${T_AUTH}/site-data.json`, { hello: 'world' })
    gw.files.set(`/_access/${T_STAFF}/site-data.json`, slices[T_AUTH])
    expect((await resolveAccess(lectureAccess, deps(gw))).tiers).toEqual([])
  })

  it('fetchTierJson: only 200 with JSON counts', async () => {
    const gw = new Gateway()
    gw.files.set('/a.json', [1])
    expect(await fetchTierJson(gw, '/a.json')).toEqual([1])
    expect(await fetchTierJson(gw, '/missing.json')).toBeUndefined()
  })
})

describe('merging what the gateway let through', () => {
  it('site data: merging the readable slices gives exactly the readable groups; all slices give the original', () => {
    const { full, inline, slices } = build()
    expect(groupIds(inline)).toEqual(['G06'])
    expect(groupIds(mergeSiteData(inline, [slices[T_AUTH] as TierSlice]))).toEqual(['G06', 'G09'])
    expect(groupIds(mergeSiteData(inline, Object.values(slices)))).toEqual(['G06', 'G09', 'G12'])
    // the inline data carries lectureAccess, the original does not: compare the rest
    const merged = mergeSiteData(inline, Object.values(slices)) as SiteLike
    const theme = { ...(merged.themeConfig as Record<string, unknown>) }
    delete theme.lectureAccess
    expect({ ...merged, themeConfig: theme }).toEqual(full)
  })

  it('graph: inline nodes plus the graphs of the readable tiers only', async () => {
    const nodes: GraphNodeLike[] = [
      { nodeId: 'a', groupId: 'G06', lectureId: 'G06-L01' },
      { nodeId: 'b', groupId: 'G09', lectureId: 'G09-L01' },
      { nodeId: 'c', groupId: 'G12', lectureId: 'G12-L01' },
    ]
    const g = splitGraph(nodes, (id) => lookupTier(plan, id), plan.inlineTier)
    const { slices, lectureAccess } = build()
    const gw = new Gateway()
    gw.files.set('/notion_knowledge_graph.json', g.inline)
    for (const t of lectureAccess.tiers) {
      gw.files.set(`/_access/${t}/site-data.json`, slices[t])
      gw.files.set(`/_access/${t}/graph.json`, g.tiers[t] ?? [])
    }
    const access = await resolveAccess(lectureAccess, deps(gw))
    const merged = (await loadMergedGraph(access, deps(gw))) as GraphNodeLike[]
    expect(merged.map((n) => n.nodeId).sort()).toEqual(['a', 'b', 'c'])
    expect((await loadTierGraphs(access, deps(gw))).flat().map((n) => n.nodeId).sort()).toEqual(['b', 'c'])

    gw.rules = [[`/_access/${T_STAFF}/`, 403]]
    const some = await resolveAccess(lectureAccess, deps(gw))
    expect(((await loadMergedGraph(some, deps(gw))) as GraphNodeLike[]).map((n) => n.nodeId).sort()).toEqual(['a', 'b'])
  })

  it('graph: keeps the cache behaviour of each consumer (plain GET vs ?v= with no-store), and null when the inline file fails', async () => {
    const gw = new Gateway()
    gw.files.set('/notion_knowledge_graph.json', [{ nodeId: 'a' }])
    await loadMergedGraph(EMPTY_ACCESS, deps(gw))
    await loadMergedGraph(EMPTY_ACCESS, deps(gw), { fresh: true, now: () => 42 })
    expect(gw.calls[0]).toEqual({ url: '/notion_knowledge_graph.json', init: undefined })
    expect(gw.calls[1]).toEqual({ url: '/notion_knowledge_graph.json?v=42', init: { cache: 'no-store' } })
    gw.rules = [['/notion_knowledge_graph.json', 500]]
    expect(await loadMergedGraph(EMPTY_ACCESS, deps(gw))).toBeNull()
    gw.rules = [['/notion_knowledge_graph.json', 'network']]
    expect(await loadMergedGraph(EMPTY_ACCESS, deps(gw))).toBeNull()
    gw.rules = []
    gw.files.set('/notion_knowledge_graph.json', { not: 'an array' })
    expect(await loadMergedGraph(EMPTY_ACCESS, deps(gw))).toEqual({ not: 'an array' })
  })
})

describe('the access store', () => {
  let site: ReturnType<typeof build>
  let gw: Gateway
  let ref: { value: unknown }

  const arm = (): void => {
    site = build()
    gw = new Gateway()
    for (const [tier, slice] of Object.entries(site.slices)) gw.files.set(`/_access/${tier}/site-data.json`, slice)
    ref = shallowRef<unknown>(site.inline)
    configureAccess({ siteData: ref, withBase: (p) => p, fetch: gw.fetch })
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }

  beforeEach(() => {
    resetSession()
    arm()
  })
  afterEach(() => resetSession())

  it('startAccess replaces siteData.value with the merged data; nothing is requested before it runs', async () => {
    expect(gw.calls).toEqual([])
    const stop = startAccess()
    await settle()
    expect(groupIds(ref.value)).toEqual(['G06', 'G09', 'G12'])
    stop()
  })

  it('a denied tier stays out of the merged data', async () => {
    gw.rules = [[`/_access/${T_STAFF}/`, 403]]
    const stop = startAccess()
    await settle()
    expect(groupIds(ref.value)).toEqual(['G06', 'G09'])
    stop()
  })

  it('hands the readable tiers graph nodes to the seed callback', async () => {
    gw.files.set(`/_access/${T_AUTH}/graph.json`, [{ nodeId: 'b', lectureId: 'G09-L01', status: '未开始' }])
    gw.files.set(`/_access/${T_STAFF}/graph.json`, [{ nodeId: 'c', lectureId: 'G12-L01', status: '未开始' }])
    gw.rules = [[`/_access/${T_STAFF}/`, 403]]
    const seen: GraphNodeLike[][] = []
    const stop = startAccess({ onTierNodes: (n) => seen.push(n) })
    await settle()
    expect(seen.flat().map((n) => n.nodeId)).toEqual(['b'])
    stop()
  })

  it('identityKey: only a signed-in user is a distinct identity', () => {
    const anon: SessionState = { status: 'anonymous', source: 'server' }
    const user = (id: string): SessionState => ({ status: 'authenticated', user: { id, name: null, email: null }, roles: [], groups: [], logoutUrl: null })
    expect(identityKey({ status: 'unknown' })).toBe(identityKey(anon))
    expect(identityKey({ status: 'unavailable', reason: 'unauthorized' })).toBe(identityKey(anon))
    expect(identityKey(user('a'))).not.toBe(identityKey(anon))
    expect(identityKey(user('a'))).not.toBe(identityKey(user('b')))
  })

  it('with no restricted tier configured: no request from startAccess, getAccess or loadGraph', async () => {
    const plain = makeSite()
    ;(plain.themeConfig as Record<string, unknown>).lectureAccess = { inlineTier: 'public', tiers: [] }
    const g = new Gateway()
    g.files.set('/notion_knowledge_graph.json', [{ nodeId: 'a' }])
    const r = shallowRef<unknown>(plain)
    configureAccess({ siteData: r, withBase: (p) => p, fetch: g.fetch })
    const stop = startAccess()
    await settle()
    expect(await loadGraph()).toEqual([{ nodeId: 'a' }])
    expect(g.urls()).toEqual(['/notion_knowledge_graph.json'])
    expect(r.value).toBe(plain)
    stop()
  })

  it('notifies subscribers once per resolution', async () => {
    let n = 0
    const off = subscribeAccess(() => n++)
    const stop = startAccess()
    await settle()
    expect(n).toBe(1)
    expect(accessVersion()).toBe(1)
    off()
    stop()
  })

  it('lectureAccessOf / currentAccessConfig read themeConfig.lectureAccess and ignore malformed values', () => {
    expect(currentAccessConfig()?.tiers).toEqual(site.lectureAccess.tiers)
    expect(lectureAccessOf({ themeConfig: { lectureAccess: { inlineTier: 1, tiers: [] } } })).toBeUndefined()
    expect(lectureAccessOf(undefined)).toBeUndefined()
    expect(lectureAccessOf({ themeConfig: { lectureAccess: { inlineTier: 'public', tiers: ['x', 3] } } })).toEqual({ inlineTier: 'public', tiers: ['x'] })
  })
})

describe('chart and export paths', () => {
  it('uses /_access/<tier> only in production and only for a tier listed as restricted', () => {
    expect(tierAssetPrefix('authenticated', ['authenticated'], false)).toBe('/_access/authenticated')
    expect(tierAssetPrefix('authenticated', ['authenticated'], true)).toBe('')
    expect(tierAssetPrefix('public', ['authenticated'], false)).toBe('')
    expect(tierAssetPrefix(undefined, ['authenticated'], false)).toBe('')
    expect(tierAssetPrefix('authenticated', undefined, false)).toBe('')
    expect(tierAssetPrefix('authenticated', [], false)).toBe('')
  })

  it('the sidecar URL follows the page tier, base first', () => {
    const loader = createSidecarLoader({ withBase: (p) => `/b${p}`, prefix: () => tierAssetPrefix(getPageTier(), ['grp-1'], false) })
    setPageTier(null)
    expect(loader.url('G09-L01')).toBe('/b/charts/G09-L01.json')
    setPageTier('grp-1')
    expect(loader.url('G09-L01')).toBe('/b/_access/grp-1/charts/G09-L01.json')
    setPageTier(undefined)
    expect(getPageTier()).toBeNull()
  })
})

describe('search index merge', () => {
  const docs = (prefix: string, words: string[]): SearchDocument[] => words.map((w, i) => ({ id: `/${prefix}/L0${i}#h`, title: `${w} title`, titles: [`${prefix} part`], text: `body of ${w} in ${prefix}` }))
  const open = docs('g06', ['alpha', 'bravo'])
  const restricted = docs('g09', ['charlie', 'delta'])
  const opts = searchIndexOptions(undefined)

  function fullIndex(all: SearchDocument[]): MiniSearch<SearchDocument> {
    const m = new MiniSearch<SearchDocument>(opts)
    m.addAll(all)
    return m
  }
  const ids = (m: MiniSearch, q: string): string[] => m.search(q, { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 2, titles: 1 } }).map((r) => String(r.id)).sort()

  it('built-in plus tier documents answers like one index built from everything', () => {
    const builtin = JSON.stringify(fullIndex(open))
    const merged = MiniSearch.loadJSON<SearchDocument>(mergeSearchIndex(builtin, restricted, opts), opts)
    const whole = fullIndex([...open, ...restricted])
    for (const q of ['alpha', 'charlie', 'title', 'body', 'g09', 'part', 'delt', 'nothing-here']) expect(ids(merged, q)).toEqual(ids(whole, q))
  })

  it('without documents the built-in index is returned as it is', () => {
    expect(mergeSearchIndex('{"x":1}', [], opts)).toBe('{"x":1}')
  })

  it('built-in local search is disabled while searchIndexOptions stays compatible with VitePress options', () => {
    expect(opts).toEqual({ fields: ['title', 'titles', 'text'], storeFields: ['title', 'titles'] })
    expect(v2Search()).toBeUndefined()
    const site = { themeConfig: { search: { provider: 'local', options: { miniSearch: { options: { extractField: undefined, tokenize: undefined, idField: 'id' } } } } } }
    expect(searchIndexOptions(site)).toMatchObject({ fields: ['title', 'titles', 'text'], idField: 'id' })
  })

  it('buildSearchIndex: untouched and request-free without readable tiers; readable tiers add their documents', async () => {
    const gw = new Gateway()
    const builtin = JSON.stringify(fullIndex(open))
    const none = await buildSearchIndex(async () => ({ default: builtin }), { access: EMPTY_ACCESS, locale: 'root', deps: deps(gw), site: undefined })
    expect(none.default).toBe(builtin)
    expect(gw.calls).toEqual([])

    const { slices } = build()
    gw.files.set(`/_access/${T_AUTH}/search/root.json`, restricted)
    gw.files.set(`/_access/${T_STAFF}/search/root.json`, [{ id: 'bad' }])
    const access = { tiers: [T_AUTH, T_STAFF].map((id) => ({ id, slice: slices[id] as TierSlice })) }
    const out = await buildSearchIndex(async () => ({ default: builtin }), { access, locale: 'root', deps: deps(gw), site: undefined })
    const index = MiniSearch.loadJSON<SearchDocument>(out.default, opts)
    expect(ids(index, 'charlie')).toEqual(['/g09/L00#h'])
    expect(ids(index, 'alpha')).toEqual(['/g06/L00#h'])
    expect(gw.urls().sort()).toEqual([`/_access/${T_AUTH}/search/root.json`, `/_access/${T_STAFF}/search/root.json`].sort())
  })
})

describe('the Vite search plugin', () => {
  type PluginLike = { enforce?: string; configResolved?: (c: unknown) => void; resolveId: (id: string) => string | undefined; load: (this: unknown, id: string) => Promise<string | undefined> }
  const make = (locales: string[]): PluginLike => accessSearchPlugin(locales) as unknown as PluginLike

  it('is a pre plugin that resolves only the exact id @localSearchIndex', () => {
    const plugin = make(['root', 'en'])
    expect(plugin.enforce).toBe('pre')
    expect(plugin.resolveId('@localSearchIndex')).toBe('/@localSearchIndex')
    for (const id of ['@localSearchIndexroot', '@localSearchIndexen', '/@localSearchIndex', '@localSearchIndex/x', 'x@localSearchIndex']) expect(plugin.resolveId(id)).toBeUndefined()
  })

  it('loads a module with one entry per locale that wraps the VitePress per-locale module', async () => {
    const plugin = make(['root', 'en'])
    expect(await plugin.load.call({}, '/@localSearchIndexroot')).toBeUndefined()
    const code = (await plugin.load.call({}, '/@localSearchIndex')) as string
    expect(code).toContain('export default {')
    expect(code).toContain('"root": () => searchIndexFor("root", () => import("@localSearchIndexroot"))')
    expect(code).toContain('"en": () => searchIndexFor("en", () => import("@localSearchIndexen"))')
    expect(code).toMatch(/^import \{ searchIndexFor \} from ".*theme\/access\/searchRuntime\.ts"/)
  })

  it('still runs the load of the VitePress local-search plugin (it indexes the pages in a production build) and takes its locale list', async () => {
    const plugin = make(['fallback'])
    const seen: string[] = []
    plugin.configResolved?.({
      plugins: [
        { name: 'other', load: () => 'no' },
        {
          name: 'vitepress:local-search',
          load(id: string) {
            seen.push(id)
            return `export default {"root": () => import('@localSearchIndexroot'),"en": () => import('@localSearchIndexen')}`
          },
        },
      ],
    })
    const code = (await plugin.load.call({}, '/@localSearchIndex')) as string
    expect(seen).toEqual(['/@localSearchIndex'])
    expect(code).toContain('"root"')
    expect(code).toContain('"en"')
    expect(code).not.toContain('fallback')
  })

  it('localesOfIndexSource reads the keys VitePress writes, and nothing from another shape', () => {
    expect(localesOfIndexSource(`export default {"root": () => import('@localSearchIndexroot'),"zh-Hant": () => import('@localSearchIndexzh-Hant')}`)).toEqual(['root', 'zh-Hant'])
    expect(localesOfIndexSource("export default '{}'")).toEqual([])
  })

  it('searchIndexModule is deterministic', () => {
    const expected = ['import { searchIndexFor } from "/x.ts"', 'export default {"root": () => searchIndexFor("root", () => import("@localSearchIndexroot"))}', ''].join('\n')
    expect(searchIndexModule(['root'], '/x.ts')).toBe(expected)
  })
})
