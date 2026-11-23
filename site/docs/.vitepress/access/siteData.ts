/**
 * access/siteData.ts - splitting the site data of a build into the inline part and one slice per restricted tier,
 * and merging slices back (docs-dev/ACCESS.md). Pure: no VitePress, no Node imports. The build
 * uses `splitSiteData`; the client (WP-A2) uses `mergeSiteData` on `siteDataRef` after fetching
 * `/_access/<tier>/site-data.json`. The two are inverse: merging the inline part with the slices of ALL tiers gives
 * back the original; with only some slices it gives the original minus the groups of the other tiers.
 *
 * What moves (everything else of `themeConfig` and `locales.*.themeConfig` stays untouched):
 *   themeConfig.groups                        one entry per group (kept in declaration order)
 *   themeConfig.totals                        lectures / charts (the slice carries the sum of its groups)
 *   <locale>.nav   groups dropdown items      the first nav item that has `items`; item of a group = its link
 *   <locale>.sidebar                          the key of a group (`/<dir>/`, `/<locale>/<dir>/`); the inline part keeps
 *                                             the key with an EMPTY placeholder group (`sidebarPlaceholder()`: no
 *                                             text, no items), so a restricted lecture page is laid out with its
 *                                             sidebar column from the first (server) render and does not jump
 *                                             sideways when the slice arrives. The placeholder carries only the
 *                                             folder path, which page ids and chunk names already reveal.
 *   <locale>.i18nPages                        the entries whose root path is below a group folder
 * where <locale> is `root` (top-level `themeConfig`) or a locale key (`locales.<key>.themeConfig`).
 *
 * Positions: an entry of an ordered list (groups, dropdown items) is stored as `{ order, inlineBefore, value }`:
 * `order` is its index in the original list, `inlineBefore` is how many inline entries precede it. The merge puts
 * every slice entry after the first `inlineBefore` inline entries, ordered by `order`, so the result keeps the
 * original order even when only some tiers are readable.
 */
import { ownerOfPath, type GroupDir } from './tiers.ts'

export type Json = unknown
type Rec = Record<string, unknown>

/**
 * Inline stand-in for the sidebar of a restricted group: one group with no text and no items. VitePress treats a
 * non-empty sidebar array as "this page has a sidebar", so the layout (sidebar column, article offset) is the same
 * before and after the slice is merged. `mergeSiteData` replaces it with the real entry when the tier is readable.
 */
export function sidebarPlaceholder(): Json[] {
  return [{ text: '', items: [] }]
}

/** True for the value `sidebarPlaceholder()` returns. */
export function isSidebarPlaceholder(v: unknown): boolean {
  if (!Array.isArray(v) || v.length !== 1) return false
  const g = v[0] as Rec | null
  return isRecLike(g) && g.text === '' && Array.isArray(g.items) && (g.items as unknown[]).length === 0 && Object.keys(g).length === 2
}

function isRecLike(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** An entry of an ordered list together with its position (see the file comment). */
export interface Placed {
  order: number
  inlineBefore: number
  value: Json
}

export interface LocaleSlice {
  nav: Placed[]
  sidebar: Rec
  i18nPages: Rec
}

/** The content of `/_access/<tier>/site-data.json`. */
export interface TierSlice {
  version: 1
  tier: string
  groups: Placed[]
  totals: { lectures: number; charts: number }
  /** Key `root` or a locale key. */
  locales: Record<string, LocaleSlice>
}

/** The parts of the resolved VitePress site config this module touches. */
export interface SiteLike {
  themeConfig?: Rec
  locales?: Record<string, Rec>
  [key: string]: unknown
}

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Runtime check of a fetched slice (JSON that does not look like a slice is treated as unreadable by the client). */
export function isTierSlice(v: unknown): v is TierSlice {
  if (!isRec(v) || v.version !== 1 || typeof v.tier !== 'string' || !Array.isArray(v.groups) || !isRec(v.locales) || !isRec(v.totals)) return false
  const placed = (x: unknown): boolean => isRec(x) && typeof x.order === 'number' && typeof x.inlineBefore === 'number' && 'value' in x
  if (!v.groups.every(placed)) return false
  return Object.values(v.locales).every((l) => isRec(l) && Array.isArray(l.nav) && l.nav.every(placed) && isRec(l.sidebar) && isRec(l.i18nPages))
}

/** The `themeConfig` of a locale bucket: `root` is the top level, others live under `locales.<key>.themeConfig`. */
function themeOf(site: SiteLike, bucket: string): Rec | undefined {
  if (bucket === 'root') return site.themeConfig
  const l = site.locales?.[bucket]
  return isRec(l) && isRec(l.themeConfig) ? l.themeConfig : undefined
}

function withTheme(site: SiteLike, bucket: string, theme: Rec): SiteLike {
  if (bucket === 'root') return { ...site, themeConfig: theme }
  const l = (site.locales?.[bucket] ?? {}) as Rec
  return { ...site, locales: { ...site.locales, [bucket]: { ...l, themeConfig: theme } } }
}

/** Index of the groups dropdown in a nav array: the first item that has an `items` array; -1 when there is none. */
function dropdownIndex(nav: unknown): number {
  return Array.isArray(nav) ? nav.findIndex((i) => isRec(i) && Array.isArray(i.items)) : -1
}

function linkPrefixOf(bucket: string): string {
  return bucket === 'root' ? '/' : `/${bucket}/`
}

function sum(a: number, b: number): number {
  return a + b
}

export interface SplitOptions {
  groups: readonly GroupDir[]
  /** Tier of a group id. */
  tierOfGroup: (groupId: string) => string
  inlineTier: string
  /** Locale keys of the non-root languages. */
  localeKeys: readonly string[]
}

export interface SplitResult {
  inline: SiteLike
  /** One slice per restricted tier that owns at least one group, in the order the tiers first appear. */
  slices: Record<string, TierSlice>
}

/**
 * Split the site data. `site.themeConfig.groups` defines which groups exist; entries whose id is not in
 * `options.groups` stay inline. Does not mutate `site`.
 */
export function splitSiteData(site: SiteLike, options: SplitOptions): SplitResult {
  const dirOf = new Map(options.groups.map((g) => [g.id, g.dir]))
  const slices: Record<string, TierSlice> = {}
  const restricted = (groupId: string): string | null => {
    const t = options.tierOfGroup(groupId)
    return t === options.inlineTier ? null : t
  }
  const sliceOf = (tier: string): TierSlice => (slices[tier] ??= { version: 1, tier, groups: [], totals: { lectures: 0, charts: 0 }, locales: {} })
  const localeSlice = (tier: string, bucket: string): LocaleSlice => (sliceOf(tier).locales[bucket] ??= { nav: [], sidebar: {}, i18nPages: {} })

  let out: SiteLike = site
  const buckets = ['root', ...options.localeKeys]

  // themeConfig.groups and totals (root only)
  const rootTheme = site.themeConfig
  if (rootTheme && Array.isArray(rootTheme.groups)) {
    const keep: unknown[] = []
    rootTheme.groups.forEach((g, order) => {
      const id = isRec(g) && typeof g.id === 'string' ? g.id : null
      const tier = id && dirOf.has(id) ? restricted(id) : null
      if (!tier) {
        keep.push(g)
        return
      }
      const s = sliceOf(tier)
      s.groups.push({ order, inlineBefore: keep.length, value: g })
      const rec = g as Rec
      s.totals.lectures += typeof rec.lectureCount === 'number' ? rec.lectureCount : 0
      s.totals.charts += typeof rec.chartCount === 'number' ? rec.chartCount : 0
    })
    const totals = isRec(rootTheme.totals) ? rootTheme.totals : undefined
    const moved = Object.values(slices).reduce((a, s) => ({ lectures: a.lectures + s.totals.lectures, charts: a.charts + s.totals.charts }), { lectures: 0, charts: 0 })
    out = withTheme(out, 'root', {
      ...rootTheme,
      groups: keep,
      ...(totals ? { totals: { ...totals, lectures: Number(totals.lectures) - moved.lectures, charts: Number(totals.charts) - moved.charts } } : {}),
    })
  }

  for (const bucket of buckets) {
    const theme = themeOf(out, bucket)
    if (!theme) continue
    const prefix = linkPrefixOf(bucket)
    const linkOwner = new Map(options.groups.map((g) => [`${prefix}${g.dir}/`, g.id]))
    const next: Rec = { ...theme }

    // nav: items of the groups dropdown
    const di = dropdownIndex(theme.nav)
    if (di >= 0) {
      const nav = theme.nav as unknown[]
      const dropdown = nav[di] as Rec
      const keep: unknown[] = []
      ;(dropdown.items as unknown[]).forEach((item, order) => {
        const owner = isRec(item) && typeof item.link === 'string' ? linkOwner.get(item.link) : undefined
        const tier = owner ? restricted(owner) : null
        if (!tier) keep.push(item)
        else localeSlice(tier, bucket).nav.push({ order, inlineBefore: keep.length, value: item })
      })
      next.nav = nav.map((n, i) => (i === di ? { ...dropdown, items: keep } : n))
    }

    // sidebar: one key per group
    if (isRec(theme.sidebar)) {
      const keep: Rec = {}
      for (const [key, value] of Object.entries(theme.sidebar)) {
        const owner = linkOwner.get(key)
        const tier = owner ? restricted(owner) : null
        if (!tier) keep[key] = value
        else {
          localeSlice(tier, bucket).sidebar[key] = value
          keep[key] = sidebarPlaceholder()
        }
      }
      next.sidebar = keep
    }

    // i18nPages: root paths below a group folder
    if (isRec(theme.i18nPages)) {
      const keep: Rec = {}
      for (const [key, value] of Object.entries(theme.i18nPages)) {
        const owner = ownerOfPath(key, options.groups, [])
        const tier = owner ? restricted(owner.groupId) : null
        if (!tier) keep[key] = value
        else localeSlice(tier, bucket).i18nPages[key] = value
      }
      next.i18nPages = keep
    }
    out = withTheme(out, bucket, next)
  }
  return { inline: out, slices }
}

/**
 * Put `entries` (from any number of slices) back into `base`: after the first `inlineBefore` base items, ordered
 * by `order`. Items that were never moved keep their relative order.
 */
export function insertPlaced(base: readonly unknown[], entries: readonly Placed[]): unknown[] {
  const sorted = [...entries].sort((a, b) => a.order - b.order)
  const out: unknown[] = []
  let e = 0
  for (let k = 0; k <= base.length; k++) {
    while (e < sorted.length && Math.min((sorted[e] as Placed).inlineBefore, base.length) <= k) out.push((sorted[e++] as Placed).value)
    if (k < base.length) out.push(base[k])
  }
  return out
}

/** Merge slices into site data. Pure; `site` is not mutated. Slices of the same tier or unknown shape are not checked: use `isTierSlice` first. */
export function mergeSiteData(site: SiteLike, slices: readonly TierSlice[]): SiteLike {
  if (slices.length === 0) return site
  let out: SiteLike = site

  const rootTheme = site.themeConfig
  if (rootTheme) {
    const placed = slices.flatMap((s) => s.groups)
    const totals = isRec(rootTheme.totals) ? rootTheme.totals : undefined
    const lectures = slices.map((s) => s.totals.lectures).reduce(sum, 0)
    const charts = slices.map((s) => s.totals.charts).reduce(sum, 0)
    out = withTheme(out, 'root', {
      ...rootTheme,
      ...(Array.isArray(rootTheme.groups) ? { groups: insertPlaced(rootTheme.groups, placed) } : {}),
      ...(totals ? { totals: { ...totals, lectures: Number(totals.lectures) + lectures, charts: Number(totals.charts) + charts } } : {}),
    })
  }

  const buckets = new Set(slices.flatMap((s) => Object.keys(s.locales)))
  for (const bucket of buckets) {
    const theme = themeOf(out, bucket)
    if (!theme) continue
    const parts = slices.map((s) => s.locales[bucket]).filter((l): l is LocaleSlice => l !== undefined)
    const next: Rec = { ...theme }
    const di = dropdownIndex(theme.nav)
    if (di >= 0) {
      const nav = theme.nav as unknown[]
      const dropdown = nav[di] as Rec
      next.nav = nav.map((n, i) => (i === di ? { ...dropdown, items: insertPlaced(dropdown.items as unknown[], parts.flatMap((p) => p.nav)) } : n))
    }
    if (isRec(theme.sidebar)) next.sidebar = Object.assign({}, theme.sidebar, ...parts.map((p) => p.sidebar))
    if (isRec(theme.i18nPages)) next.i18nPages = Object.assign({}, theme.i18nPages, ...parts.map((p) => p.i18nPages))
    out = withTheme(out, bucket, next)
  }
  return out
}

// ---- knowledge graph --------------------------------------------------------------------------------------------

/** A node of `notion_knowledge_graph.json`; only the fields the tier lookup needs. */
export interface GraphNodeLike {
  groupId?: string | null
  lectureId?: string | null
  lecturePath?: string | null
  [key: string]: unknown
}

/**
 * The group id of a graph node: its `groupId`, else the part of `lectureId` before `-L<number>` (`G05-L19` -> `G05`);
 * null for nodes that belong to no group (they stay inline). The seed loader (progress/seed.data.mts) and the build
 * use this one rule, so the seed and the inline graph always cover the same nodes.
 */
export function groupIdOfGraphNode(node: GraphNodeLike): string | null {
  if (typeof node.groupId === 'string' && node.groupId.trim()) return node.groupId.trim()
  if (typeof node.lectureId === 'string') {
    const m = /^(.+)-L\d+$/i.exec(node.lectureId.trim())
    if (m) return m[1] as string
  }
  return null
}

export interface GraphSplit {
  inline: GraphNodeLike[]
  /** Nodes of each restricted tier. */
  tiers: Record<string, GraphNodeLike[]>
  /** Nodes of groups that are not built at all. */
  dropped: GraphNodeLike[]
}

/**
 * Split graph nodes by tier. `tierOf` returns the tier of a group id, or null when the group is not built (its
 * nodes are dropped). Nodes of the inline tier and nodes without a group stay inline.
 */
export function splitGraph(nodes: readonly GraphNodeLike[], tierOf: (groupId: string) => string | null, inlineTier: string): GraphSplit {
  const out: GraphSplit = { inline: [], tiers: {}, dropped: [] }
  for (const n of nodes) {
    const gid = groupIdOfGraphNode(n)
    if (!gid) {
      out.inline.push(n)
      continue
    }
    const tier = tierOf(gid)
    if (tier === null) out.dropped.push(n)
    else if (tier === inlineTier) out.inline.push(n)
    else (out.tiers[tier] ??= []).push(n)
  }
  return out
}

/** One entry of `lecture_catalog.json` (only the fields the split reads). */
export interface CatalogItemLike {
  id?: unknown
  group?: unknown
  [key: string]: unknown
}

/** Group id of a catalog entry: `group`, or the prefix of `id` (`G01-L01` -> `G01`). */
export function groupIdOfCatalogItem(item: CatalogItemLike): string | null {
  if (typeof item.group === 'string' && item.group.trim()) return item.group.trim()
  if (typeof item.id === 'string') {
    const m = /^(.+)-L\d+$/i.exec(item.id.trim())
    if (m) return m[1] as string
  }
  return null
}

export interface CatalogSplit {
  inline: CatalogItemLike[]
  tiers: Record<string, CatalogItemLike[]>
  dropped: CatalogItemLike[]
}

/**
 * Split `lecture_catalog.json` like the graph. The site itself never reads the catalog, but the Notion / Dify tool
 * service (`scripts/remote_server.py`) reads it from the web root, so the inline part stays at its public path
 * (unchanged when there is no restricted tier) and each restricted tier gets its own copy under `/_access/<tier>/`.
 */
export function splitCatalog(items: readonly CatalogItemLike[], tierOf: (groupId: string) => string | null, inlineTier: string): CatalogSplit {
  const out: CatalogSplit = { inline: [], tiers: {}, dropped: [] }
  for (const item of items) {
    const gid = groupIdOfCatalogItem(item)
    const tier = gid ? tierOf(gid) : inlineTier
    if (tier === null) out.dropped.push(item)
    else if (tier === inlineTier) out.inline.push(item)
    else (out.tiers[tier] ??= []).push(item)
  }
  return out
}

/** Inline nodes followed by the nodes of every readable tier (a node never appears twice; order inside a part is kept). */
export function mergeGraph(inline: readonly GraphNodeLike[], tiers: ReadonlyArray<readonly GraphNodeLike[]>): GraphNodeLike[] {
  return [...inline, ...tiers.flat()]
}
