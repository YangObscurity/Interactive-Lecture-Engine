import { describe, expect, it } from 'vitest'
import {
  groupIdOfCatalogItem,
  groupIdOfGraphNode,
  insertPlaced,
  isSidebarPlaceholder,
  isTierSlice,
  mergeGraph,
  mergeSiteData,
  sidebarPlaceholder,
  splitCatalog,
  splitGraph,
  splitSiteData,
  type CatalogItemLike,
  type GraphNodeLike,
  type SiteLike,
  type SplitOptions,
  type TierSlice,
} from '../../docs/.vitepress/access/siteData'
import { lookupTier, resolveAccess, type GroupDir } from '../../docs/.vitepress/access/tiers'
import { namesOfSiteData } from '../../docs/.vitepress/access/build.mts'

/** Small deterministic PRNG (mulberry32) so the property loop is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LOCALES = ['en']

/** Site data shaped like the resolved VitePress config of this site: root theme + one locale. */
function makeSite(groups: readonly GroupDir[]): SiteLike {
  const entries = groups.map((g, i) => ({
    id: g.id,
    dir: g.dir,
    title: `Title of ${g.id}`,
    lectureCount: 3 + i,
    chartCount: 5 * i,
    lectures: [1, 2, 3].map((n) => ({ n, text: `${g.id} lecture ${n}`, link: `/${g.dir}/L0${n}` })),
  }))
  const sidebar = (prefix: string) => Object.fromEntries(groups.map((g) => [`${prefix}${g.dir}/`, [{ text: g.id, items: [{ text: `${g.id} L1`, link: `${prefix}${g.dir}/L01` }] }]]))
  const nav = (prefix: string) => [
    { text: 'Home', link: prefix },
    { text: 'Groups', items: groups.map((g) => ({ text: `${g.id} title`, link: `${prefix}${g.dir}/` })) },
  ]
  const i18nPages = Object.fromEntries(groups.flatMap((g) => [1, 2].map((n) => [`/${g.dir}/L0${n}`, { title: `${g.id} EN ${n}` }])))
  return {
    lang: 'zh-CN',
    themeConfig: {
      nav: nav('/'),
      sidebar: sidebar('/'),
      groups: entries,
      totals: { lectures: entries.reduce((a, e) => a + e.lectureCount, 0), charts: entries.reduce((a, e) => a + e.chartCount, 0) },
      siteMeta: { name: 'Site' },
      lectureModules: { progress: { adapter: 'local' } },
    },
    locales: {
      root: { label: '', lang: 'zh-CN' },
      en: { label: '', lang: 'en', link: '/en/', themeConfig: { outline: { label: 'On this page' }, nav: nav('/en/'), sidebar: sidebar('/en/'), i18nPages } },
    },
  }
}

const GROUPS: GroupDir[] = [
  { id: 'G01', dir: 'g01' },
  { id: 'G02', dir: 'g02' },
  { id: 'G03', dir: 'g03' },
  { id: 'LR', dir: 'lr' },
  { id: 'EX', dir: 'examples/g01' },
]

function splitOptions(tiers: Record<string, string>, inlineTier: string): SplitOptions {
  return { groups: GROUPS, tierOfGroup: (id) => tiers[id] ?? inlineTier, inlineTier, localeKeys: LOCALES }
}

describe('splitSiteData / mergeSiteData', () => {
  const site = makeSite(GROUPS)
  const tiers = { G02: 'authenticated', G03: 'grp-aaaaaaaa', LR: 'authenticated' }

  it('the inline part holds only inline-tier groups in every place; totals are those of the inline groups', () => {
    const { inline, slices } = splitSiteData(site, splitOptions(tiers, 'public'))
    const theme = inline.themeConfig as Record<string, unknown>
    expect((theme.groups as Array<{ id: string }>).map((g) => g.id)).toEqual(['G01', 'EX'])
    // real sidebars only for inline groups; restricted groups keep their key with an empty placeholder (no names)
    const realKeys = (sb: object) => Object.entries(sb).filter(([, v]) => !isSidebarPlaceholder(v)).map(([k]) => k)
    const placeholderKeys = (sb: object) => Object.entries(sb).filter(([, v]) => isSidebarPlaceholder(v)).map(([k]) => k)
    expect(realKeys(theme.sidebar as object)).toEqual(['/g01/', '/examples/g01/'])
    expect(placeholderKeys(theme.sidebar as object).sort()).toEqual(['/g02/', '/g03/', '/lr/'])
    expect(((theme.nav as Array<{ items?: unknown[] }>)[1] as { items: unknown[] }).items).toHaveLength(2)
    expect(theme.totals).toEqual({ lectures: 3 + 7, charts: 0 + 20 })
    const en = (inline.locales?.en as { themeConfig: Record<string, unknown> }).themeConfig
    expect(realKeys(en.sidebar as object)).toEqual(['/en/g01/', '/en/examples/g01/'])
    expect(placeholderKeys(en.sidebar as object).sort()).toEqual(['/en/g02/', '/en/g03/', '/en/lr/'])
    expect(Object.keys(en.i18nPages as object)).toEqual(['/g01/L01', '/g01/L02', '/examples/g01/L01', '/examples/g01/L02'])
    expect(Object.keys(slices).sort()).toEqual(['authenticated', 'grp-aaaaaaaa'])
    expect(slices.authenticated?.groups.map((p) => (p.value as { id: string }).id)).toEqual(['G02', 'LR'])
    expect(slices.authenticated?.totals).toEqual({ lectures: 4 + 6, charts: 5 + 15 })
    // untouched keys survive
    expect(theme.siteMeta).toEqual({ name: 'Site' })
    expect(theme.lectureModules).toEqual({ progress: { adapter: 'local' } })
    expect((inline.locales?.en as { themeConfig: Record<string, unknown> }).themeConfig.outline).toEqual({ label: 'On this page' })
  })

  it('nothing restricted inline: names of restricted groups appear nowhere in the inline part (only placeholder keys)', () => {
    const { inline, slices } = splitSiteData(site, splitOptions(tiers, 'public'))
    const text = JSON.stringify(inline)
    for (const id of ['G02', 'G03', 'LR']) expect(text, id).not.toMatch(new RegExp(`${id}(?![0-9])`))
    for (const name of Object.values(slices).flatMap((s) => namesOfSiteData(s))) expect(text, name).not.toContain(name)
    // a restricted folder path may only appear as a sidebar key whose value is the empty placeholder
    const sidebarOf = (t: unknown) => ((t as { sidebar?: Record<string, unknown> } | undefined)?.sidebar ?? {})
    const themes = [inline.themeConfig, ...Object.values(inline.locales ?? {}).map((l) => (l as { themeConfig?: unknown }).themeConfig)].filter((t) => t !== undefined)
    for (const t of themes) for (const [k, v] of Object.entries(sidebarOf(t))) if (/\/(g02|g03|lr)\/$/.test(k)) expect(isSidebarPlaceholder(v), k).toBe(true)
    const withoutSidebars = JSON.stringify(themes.map((t) => ({ ...(t as object), sidebar: undefined })))
    expect(withoutSidebars).not.toContain('/g02/')
    expect(withoutSidebars).not.toContain('/en/lr/')
  })

  it('the sidebar placeholder is what VitePress needs to lay out a sidebar (non-empty array) and holds no text', () => {
    const p = sidebarPlaceholder()
    expect(Array.isArray(p) && p.length > 0).toBe(true)
    expect(JSON.stringify(p)).toBe('[{"text":"","items":[]}]')
    expect(isSidebarPlaceholder(p)).toBe(true)
    expect(isSidebarPlaceholder([{ text: 'x', items: [] }])).toBe(false)
    expect(isSidebarPlaceholder([{ text: '', items: [{ text: 'a' }] }])).toBe(false)
  })

  it('does not mutate its input', () => {
    const copy = structuredClone(site)
    splitSiteData(site, splitOptions(tiers, 'public'))
    expect(site).toEqual(copy)
  })

  it('merging the inline part with the slices of ALL tiers gives back the original', () => {
    const { inline, slices } = splitSiteData(site, splitOptions(tiers, 'public'))
    expect(mergeSiteData(inline, Object.values(slices))).toEqual(site)
    // the order of the slices does not matter
    expect(mergeSiteData(inline, Object.values(slices).reverse())).toEqual(site)
  })

  it('merging only some slices gives the original minus the other tiers, in the original order', () => {
    const { inline, slices } = splitSiteData(site, splitOptions(tiers, 'public'))
    const auth = slices.authenticated as TierSlice
    const merged = mergeSiteData(inline, [auth])
    const theme = merged.themeConfig as { groups: Array<{ id: string }>; totals: { lectures: number } }
    expect(theme.groups.map((g) => g.id)).toEqual(['G01', 'G02', 'LR', 'EX'])
    expect(theme.totals.lectures).toBe(3 + 4 + 6 + 7)
    const nav = ((merged.themeConfig as { nav: Array<{ items?: Array<{ link: string }> }> }).nav[1] as { items: Array<{ link: string }> }).items
    expect(nav.map((i) => i.link)).toEqual(['/g01/', '/g02/', '/lr/', '/examples/g01/'])
    const en = (merged.locales?.en as { themeConfig: { sidebar: object; i18nPages: object } }).themeConfig
    const realEn = Object.entries(en.sidebar).filter(([, v]) => !isSidebarPlaceholder(v)).map(([k]) => k)
    expect(realEn.sort()).toEqual(['/en/examples/g01/', '/en/g01/', '/en/g02/', '/en/lr/'])
    // the unreadable tier keeps its placeholder: still no names of it
    expect(isSidebarPlaceholder((en.sidebar as Record<string, unknown>)['/en/g03/'])).toBe(true)
    expect(Object.keys(en.i18nPages)).toHaveLength(8)
    for (const name of namesOfSiteData(slices['grp-aaaaaaaa'] as TierSlice)) expect(JSON.stringify(merged), name).not.toContain(name)
  })

  it('the inverse property holds for random partitions of random group sets (200 cases)', () => {
    const rand = rng(20261118)
    for (let c = 0; c < 200; c++) {
      const n = 1 + Math.floor(rand() * 9)
      const groups: GroupDir[] = Array.from({ length: n }, (_, i) => ({ id: `G${String(i).padStart(2, '0')}`, dir: rand() < 0.2 ? `ex/g${i}` : `g${i}` }))
      const full = makeSite(groups)
      const pool = ['public', 'authenticated', 'grp-11111111', 'grp-22222222']
      const tierOf: Record<string, string> = Object.fromEntries(groups.map((g) => [g.id, pool[Math.floor(rand() * pool.length)] as string]))
      const inlineTier = pool[Math.floor(rand() * 2)] as string
      const { inline, slices } = splitSiteData(full, { groups, tierOfGroup: (id) => tierOf[id] as string, inlineTier, localeKeys: LOCALES })
      expect(mergeSiteData(inline, Object.values(slices)), `case ${c}`).toEqual(full)
      // any subset of slices keeps the original order of what is present
      const subset = Object.values(slices).filter(() => rand() < 0.5)
      const present = new Set(groups.filter((g) => tierOf[g.id] === inlineTier || subset.some((s) => s.tier === tierOf[g.id])).map((g) => g.id))
      const merged = mergeSiteData(inline, subset)
      expect((merged.themeConfig as { groups: Array<{ id: string }> }).groups.map((g) => g.id), `subset ${c}`).toEqual(groups.filter((g) => present.has(g.id)).map((g) => g.id))
    }
  })

  it('a site with a single tier splits into the original and no slices', () => {
    const { inline, slices } = splitSiteData(site, splitOptions({}, 'authenticated'))
    expect(inline).toEqual(site)
    expect(slices).toEqual({})
  })

  it('works on the plan of resolveAccess (groups of two restricted tiers)', () => {
    const plan = resolveAccess({ access: { groups: { G02: { read: 'authenticated' }, G03: { read: ['staff'] } } }, groupIds: GROUPS.map((g) => g.id) })
    const { inline, slices } = splitSiteData(site, { groups: GROUPS, tierOfGroup: (id) => plan.tierOfGroup[id] as string, inlineTier: plan.inlineTier, localeKeys: LOCALES })
    expect(Object.keys(slices).sort()).toEqual(plan.tiers.map((t) => t.id).sort())
    expect(mergeSiteData(inline, Object.values(slices))).toEqual(site)
  })

  it('names of a slice cover lecture titles, group titles and nav texts in all languages', () => {
    const { slices } = splitSiteData(site, splitOptions(tiers, 'public'))
    const names = namesOfSiteData(slices['grp-aaaaaaaa'])
    expect(names).toContain('Title of G03')
    expect(names).toContain('G03 lecture 2')
    expect(names).toContain('G03 title')
    expect(names).toContain('G03 EN 1')
  })

  it('isTierSlice accepts what split produced and rejects anything else', () => {
    const { slices } = splitSiteData(site, splitOptions(tiers, 'public'))
    for (const s of Object.values(slices)) expect(isTierSlice(JSON.parse(JSON.stringify(s)))).toBe(true)
    for (const bad of [null, [], {}, { version: 2 }, { ...slices.authenticated, groups: 'x' }, { ...slices.authenticated, locales: { root: { nav: [1], sidebar: {}, i18nPages: {} } } }, '<html>login</html>']) {
      expect(isTierSlice(bad)).toBe(false)
    }
  })

  it('insertPlaced puts entries after the first inlineBefore base items, ordered by order, clamped to the end', () => {
    const base = ['a', 'b']
    expect(insertPlaced(base, [{ order: 1, inlineBefore: 1, value: 'X' }, { order: 0, inlineBefore: 0, value: 'W' }])).toEqual(['W', 'a', 'X', 'b'])
    expect(insertPlaced(base, [{ order: 5, inlineBefore: 9, value: 'Z' }])).toEqual(['a', 'b', 'Z'])
    expect(insertPlaced(base, [])).toEqual(['a', 'b'])
  })
})

describe('graph split', () => {
  const node = (nodeId: string, groupId: string | null, lectureId: string | null = null): GraphNodeLike => ({ nodeId, groupId, lectureId, lecturePath: lectureId ? `/${(groupId ?? '').toLowerCase()}/${lectureId.split('-')[1]}` : null })
  const nodes = [node('a', 'G01', 'G01-L01'), node('b', 'G02', 'G02-L01'), node('c', 'G03', 'G03-L07'), node('d', '', null), node('e', null, 'LR-L03'), node('f', 'G99', 'G99-L01')]

  it('groupIdOfGraphNode: groupId, else the lectureId prefix, else null', () => {
    expect(groupIdOfGraphNode(nodes[0] as GraphNodeLike)).toBe('G01')
    expect(groupIdOfGraphNode(nodes[3] as GraphNodeLike)).toBeNull()
    expect(groupIdOfGraphNode(nodes[4] as GraphNodeLike)).toBe('LR')
  })

  it('splits by tier; nodes without a group stay inline; groups not built are dropped; merging gives back all kept nodes', () => {
    const plan = resolveAccess({ access: { groups: { G02: { read: 'authenticated' }, G03: { read: ['staff'] } } }, groupIds: ['G01', 'G02', 'G03', 'LR'], buildGroups: ['G01', 'G02', 'G03'] })
    const g = splitGraph(nodes, (id) => lookupTier(plan, id), plan.inlineTier)
    expect(g.inline.map((n) => n.nodeId)).toEqual(['a', 'd'])
    expect(g.tiers.authenticated?.map((n) => n.nodeId)).toEqual(['b'])
    expect(Object.values(g.tiers).flat().map((n) => n.nodeId).sort()).toEqual(['b', 'c'])
    expect(g.dropped.map((n) => n.nodeId).sort()).toEqual(['e', 'f'])
    const merged = mergeGraph(g.inline, Object.values(g.tiers))
    expect(merged.map((n) => n.nodeId).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('with every tier readable the merge has exactly the nodes of the original (no build limit)', () => {
    const plan = resolveAccess({ access: { groups: { G02: { read: 'authenticated' }, G03: { read: ['staff'] } } }, groupIds: ['G01', 'G02', 'G03', 'LR', 'G99'] })
    const g = splitGraph(nodes, (id) => lookupTier(plan, id), plan.inlineTier)
    expect(g.dropped).toEqual([])
    expect(mergeGraph(g.inline, Object.values(g.tiers)).map((n) => n.nodeId).sort()).toEqual(nodes.map((n) => n.nodeId).sort())
  })
})

describe('lecture catalog split (remote_server.py reads the inline copy from the web root)', () => {
  const items = [
    { id: 'G01-L01', group: 'G01', title: 'a' },
    { id: 'G02-L03', group: 'G02', title: 'b' },
    { id: 'G03-L07', title: 'c' },
    { id: 'LR-L01', group: 'LR', title: 'd' },
    { title: 'no id' },
  ]

  it('groupIdOfCatalogItem: group, else the id prefix, else null', () => {
    expect(groupIdOfCatalogItem(items[0] as CatalogItemLike)).toBe('G01')
    expect(groupIdOfCatalogItem(items[2] as CatalogItemLike)).toBe('G03')
    expect(groupIdOfCatalogItem(items[4] as CatalogItemLike)).toBeNull()
  })

  it('splits by tier like the graph; entries without a group stay inline; groups not built are dropped', () => {
    const plan = resolveAccess({ access: { groups: { G02: { read: 'authenticated' }, G03: { read: ['staff'] } } }, groupIds: ['G01', 'G02', 'G03', 'LR'], buildGroups: ['G01', 'G02', 'G03'] })
    const c = splitCatalog(items, (id) => lookupTier(plan, id), plan.inlineTier)
    expect(c.inline.map((i) => i.title)).toEqual(['a', 'no id'])
    expect(c.tiers.authenticated?.map((i) => i.title)).toEqual(['b'])
    expect(Object.values(c.tiers).flat().map((i) => i.title).sort()).toEqual(['b', 'c'])
    expect(c.dropped.map((i) => i.title)).toEqual(['d'])
  })

  it('nothing restricted: every entry stays inline (the file is left untouched by the build)', () => {
    const plan = resolveAccess({ access: { default: 'authenticated', enforcement: 'gateway' }, groupIds: ['G01', 'G02', 'G03', 'LR'] })
    const c = splitCatalog(items, (id) => lookupTier(plan, id), plan.inlineTier)
    expect(c.inline).toHaveLength(items.length)
    expect(c.tiers).toEqual({})
    expect(c.dropped).toEqual([])
  })
})
