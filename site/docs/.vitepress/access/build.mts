/**
 * access/build.mts - the Node side of P3b (docs-dev/ACCESS.md). Imported by config.mts,
 * progress/seed.data.mts and docs/en/[group]/index.paths.mts; never by client code.
 *
 *   readAccessEnv / resolveBuildAccess   LECTURE_AUDIENCE, LECTURE_BUILD_GROUPS, LECTURE_ACCESS_JSON + the config
 *                                        block -> AccessPlan, with both build guards
 *   applyAccess                          post-process the finished VitePress config: reduce `themeConfig` and every
 *                                        locale to the inline tier, add `themeConfig.lectureAccess`, srcExclude of
 *                                        groups that are not built, the search `_render` hook, page data
 *                                        (`accessTier`, `groupMeta`), the sitemap filter and the `buildEnd` hook
 *   finalizeDist (buildEnd)              write `/_access/<tier>/...`, move charts and exports, split the graph and
 *                                        `lecture_catalog.json`, write the gateway manifest
 *   getRestrictedSearchDocuments         the pages the search hook took out of the built-in index (also in dev)
 *   (vitePlugins.mts)                    client side: the merged search index module and the dev-server /_access/ routes,
 *                                        added to `vite.plugins` by applyAccess when a restricted tier exists
 *
 * The tier model itself is pure and lives in tiers.ts / siteData.ts / search.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { MarkdownRenderer, PageData, SiteConfig, TransformPageContext, UserConfig } from 'vitepress'
import {
  AccessConfigError,
  assertBuildGuards,
  assertNoNestedDirs,
  chunkPatternsOf,
  lectureAccessOf,
  lookupTier,
  ownerOfPath,
  parseAccessJson,
  parseIdList,
  pathPrefixesOf,
  resolveAccess,
  tierBasePath,
  tierRank,
  validateAccessConfig,
  type AccessConfig,
  type AccessPlan,
  type GroupDir,
  type TierInfo,
} from './tiers.ts'
import { splitCatalog, splitGraph, splitSiteData, type CatalogItemLike, type GraphNodeLike, type SiteLike, type TierSlice } from './siteData.ts'
import { localeOfPath, searchDocumentsOf, type SearchDocument } from './search.ts'
import { accessVitePlugins } from './vitePlugins.mts'
import { curriculumLog } from '../curriculum/node.mts'
import { canvasSliceOf } from '../curriculum/canvasNode.mts'
import { splitCurriculum, type CurriculumSlice } from '../curriculum/split.ts'
import type { CurriculumBuild } from '../curriculum/data.ts'
import { contentForDocsRoot, loadConceptRecords, scanLectureFiles } from '../concepts/node.mts'
import { conceptTierChunkPattern } from '../concepts/access.ts'

type Rec = Record<string, unknown>

// ---- environment and plan ---------------------------------------------------------------------------------------

export interface AccessEnv {
  audience?: 'public'
  buildGroups?: string[]
  accessJson?: string
}

/** `LECTURE_AUDIENCE` (only `public`), `LECTURE_BUILD_GROUPS` (comma separated ids), `LECTURE_ACCESS_JSON`. */
export function readAccessEnv(env: Readonly<Record<string, string | undefined>> = process.env): AccessEnv {
  const out: AccessEnv = {}
  const audience = (env.LECTURE_AUDIENCE ?? '').trim()
  if (audience !== '') {
    if (audience !== 'public') throw new AccessConfigError(`LECTURE_AUDIENCE = ${JSON.stringify(audience)} is not supported (only: public). Use: npm run build -- --audience public`)
    out.audience = 'public'
  }
  const groups = parseIdList(env.LECTURE_BUILD_GROUPS)
  if (groups) out.buildGroups = groups
  const json = env.LECTURE_ACCESS_JSON
  if (json !== undefined && json.trim() !== '') out.accessJson = json
  return out
}

/** The tiers of this build from the config block and the environment, both guards applied. Throws AccessConfigError / AccessGuardError. */
export function resolveBuildAccess(
  access: AccessConfig | undefined,
  groups: readonly GroupDir[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): AccessPlan {
  const e = readAccessEnv(env)
  const groupIds = groups.map((g) => g.id)
  const block = e.accessJson !== undefined ? parseAccessJson(e.accessJson, groupIds) : validateAccessConfig(access, groupIds)
  const plan = resolveAccess({
    access: block,
    groupIds,
    ...(e.audience ? { audience: e.audience } : {}),
    ...(e.buildGroups ? { buildGroups: e.buildGroups } : {}),
    source: e.accessJson !== undefined ? 'LECTURE_ACCESS_JSON' : 'lecture.config.ts',
  })
  assertNoNestedDirs(groups.filter((g) => plan.keptGroupIds.includes(g.id)), plan.tierOfGroup)
  assertBuildGuards(plan)
  return plan
}

/**
 * For code that has no group list (the seed data loader, which must stay synchronous): a plan from the config block
 * and the environment alone. Group ids it has not been told about get the default tier (see `lookupTier`), so it
 * agrees with `resolveBuildAccess` for every group of groups.mts.
 */
export function resolveAccessWithoutGroups(access: AccessConfig | undefined, env: Readonly<Record<string, string | undefined>> = process.env): AccessPlan {
  const e = readAccessEnv(env)
  const block = e.accessJson !== undefined ? parseAccessJson(e.accessJson) : validateAccessConfig(access)
  const mentioned = Object.keys(block.groups ?? {})
  return resolveAccess({
    access: block,
    groupIds: [...new Set([...mentioned, ...(e.buildGroups ?? [])])],
    ...(e.audience ? { audience: e.audience } : {}),
    ...(e.buildGroups ? { buildGroups: e.buildGroups } : {}),
  })
}

// ---- search hook -----------------------------------------------------------------------------------------------

interface RestrictedPage {
  relativePath: string
  html: string
}

const restrictedPages = new Map<string, RestrictedPage>()

/** Pages the search hook of the running build/dev server took out of the built-in index, by docs-relative path. */
export function getRestrictedSearchDocuments(): ReadonlyMap<string, { relativePath: string; html: string }> {
  return restrictedPages
}

type RenderEnv = { relativePath?: string; frontmatter?: { search?: unknown } }

/** `themeConfig.search.options._render` (VitePress 1.6.4): the default render, but restricted pages are kept out of the index and remembered. */
function searchRender(isRestricted: (relativePath: string) => boolean) {
  return async (src: string, env: RenderEnv, md: MarkdownRenderer): Promise<string> => {
    const html = md.render(src, env)
    if (env.frontmatter?.search === false) return ''
    const rel = env.relativePath ?? ''
    if (rel && isRestricted(rel)) {
      restrictedPages.set(rel, { relativePath: rel, html })
      return ''
    }
    return html
  }
}

// ---- configuration post-processing ----------------------------------------------------------------------------

export interface AccessGroup extends GroupDir {
  title: string
  [key: string]: unknown
}

export interface ApplyAccessInput {
  plan: AccessPlan
  /** Every course group of groups.mts (built or not): id and folder. */
  allGroups: readonly GroupDir[]
  /** The built groups with their full `themeConfig.groups` entries. */
  groups: readonly AccessGroup[]
  /** Locale keys of the non-root languages. */
  localeKeys: readonly string[]
  /** docs/ */
  docsRoot: string
  /** Resolved charts directory (`docs/public/charts` or `content/charts`). */
  chartsDir?: string
  /** Resolved figures directory (`docs/public/figures` or `content/figures`). */
  figuresDir?: string
  /** Resolved `notion_knowledge_graph.json` path. */
  notionKnowledgeGraphFile?: string
  /** Resolved public assets directory (`docs/public` or `content/public`). */
  publicDir?: string
  /**
   * P4a: the curriculum of every language (curriculum/node.mts `buildCurriculumFromDisk`), called lazily by `buildEnd` and
   * by the dev server. Each restricted tier gets `/_access/<tier>/curriculum.<locale>.json`; optional so callers and tests
   * that do not build a curriculum are unaffected.
   */
  curriculum?: () => CurriculumBuild
}

/** The curriculum slice of one tier and one locale bucket (empty when the tier owns no group of it). Pure; exported for tests and the dev server. */
export function curriculumSliceOf(build: CurriculumBuild, plan: AccessPlan, tier: string, bucket: string): CurriculumSlice | undefined {
  const data = build.byLocale[bucket]
  if (!data) return undefined
  const split = splitCurriculum(data, { tierOfGroup: (id) => plan.tierOfGroup[id] ?? plan.inlineTier, inlineTier: plan.inlineTier })
  return split.slices[tier] ?? { version: 1, tier, locale: bucket, groups: [], edges: [] }
}

const DEFAULT_MIN_NAME = 4

/** How many leading characters of a lecture's 说明 the leak check searches for (P4a WP-H3). */
export const DESC_NEEDLE_LENGTH = 12

/** The part of a lecture's 说明 the leak check looks for in the other tiers' output ('' when it has none). */
export function descNeedle(lecture: { desc?: string }): string {
  return typeof lecture.desc === 'string' ? Array.from(lecture.desc.trim()).slice(0, DESC_NEEDLE_LENGTH).join('') : ''
}

/**
 * Names the leak check must look for that the site data does not carry (audit P4a): the curriculum keeps lecture
 * titles WITHOUT the "第N讲 · " prefix the sidebar uses, so a restricted lecture title leaking through the inline
 * curriculum would not match any sidebar name. Per restricted tier: its group titles and lecture titles in every
 * language, plus the first DESC_NEEDLE_LENGTH characters of each lecture's 说明 (P4a WP-H3: the Notion fields travel with the
 * lecture, so a restricted lecture's 说明 leaking into the inline curriculum must be found); a name that also belongs to the
 * inline tier, or is shorter than DEFAULT_MIN_NAME, is ambiguous (warning only), like the site-data names. Pure; exported for tests.
 */
export function curriculumNamesByTier(build: CurriculumBuild, plan: AccessPlan): Record<string, { names: string[]; ambiguous: string[] }> {
  const byTier = new Map<string, Set<string>>()
  const inline = new Set<string>()
  for (const data of Object.values(build.byLocale)) {
    for (const g of data.groups) {
      const tier = lookupTier(plan, g.id)
      if (tier === null) continue
      let into = inline
      if (tier !== plan.inlineTier) {
        let set = byTier.get(tier)
        if (!set) {
          set = new Set()
          byTier.set(tier, set)
        }
        into = set
      }
      into.add(g.title)
      for (const l of g.lectures) {
        into.add(l.title)
        const d = descNeedle(l)
        if (d !== '') into.add(d)
      }
    }
  }
  const out: Record<string, { names: string[]; ambiguous: string[] }> = {}
  for (const [tier, set] of byTier) {
    const all = [...set].filter((n) => n.trim() !== '').sort()
    const ambiguous = all.filter((n) => inline.has(n) || n.length < DEFAULT_MIN_NAME)
    out[tier] = { names: all.filter((n) => !ambiguous.includes(n)), ambiguous }
  }
  return out
}

function collectStrings(value: unknown, keys: readonly string[], out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, keys, out)
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && keys.includes(k) && v.trim()) out.add(v.trim())
      else collectStrings(v, keys, out)
    }
  }
}

/** Every user-visible name of a slice or of site data: lecture titles, group titles, nav and sidebar texts (all languages). */
export function namesOfSiteData(value: unknown): string[] {
  const out = new Set<string>()
  collectStrings(value, ['text', 'title'], out)
  return [...out].sort()
}

export interface TierBuild {
  info: TierInfo
  slice: TierSlice
  /** Names of this tier that no inline text shares (what `check:access:dist` searches for). */
  names: string[]
  /** Names this tier shares with inline text: not searchable without false positives. */
  ambiguousNames: string[]
  dirs: string[]
}

export interface AccessRuntime {
  plan: AccessPlan
  tiers: TierBuild[]
  inline: SiteLike
}

/** Split the site data of the (already built-groups-only) config into the inline part and the tier slices. */
export function buildAccessRuntime(site: SiteLike, input: ApplyAccessInput): AccessRuntime {
  const { plan } = input
  const split = splitSiteData(site, {
    groups: input.groups,
    tierOfGroup: (id) => plan.tierOfGroup[id] ?? plan.inlineTier,
    inlineTier: plan.inlineTier,
    localeKeys: input.localeKeys,
  })
  const inlineNames = new Set(namesOfSiteData(split.inline))
  const tiers: TierBuild[] = plan.tiers.map((info) => {
    const slice: TierSlice = split.slices[info.id] ?? { version: 1, tier: info.id, groups: [], totals: { lectures: 0, charts: 0 }, locales: {} }
    const all = namesOfSiteData(slice)
    const ambiguous = all.filter((n) => inlineNames.has(n) || n.length < DEFAULT_MIN_NAME)
    return {
      info,
      slice,
      names: all.filter((n) => !ambiguous.includes(n)),
      ambiguousNames: ambiguous,
      dirs: info.groupIds.map((id) => input.groups.find((g) => g.id === id)?.dir ?? '').filter(Boolean),
    }
  })
  return { plan, tiers, inline: split.inline }
}

/**
 * Apply the access plan to a finished VitePress user config (the object `defineConfig` returned). Returns a new
 * object; `cfg` is not mutated. With no restricted tier and no group left out, the only change to the built site is
 * `themeConfig.lectureAccess`.
 */
export function applyAccess<C extends UserConfig>(cfg: C, input: ApplyAccessInput): C {
  const { plan } = input
  const site: SiteLike = { themeConfig: (cfg.themeConfig ?? {}) as unknown as Rec, locales: (cfg.locales ?? undefined) as unknown as Record<string, Rec> | undefined }
  const runtime = buildAccessRuntime(site, input)
  const keptDirs = input.groups.map((g) => ({ id: g.id, dir: g.dir }))
  const restrictedConceptTierOf = (rel: string): string | null => {
    const m = /^(?:[a-z]{2}(?:-[a-z]{2})?\/)?_access\/([^/]+)\/concepts\/[^/]+\.md$/i.exec(rel.replace(/^\/+/, ''))
    return m?.[1] ?? null
  }
  const restrictedPage = (rel: string): boolean => {
    if (restrictedConceptTierOf(rel) !== null) return true
    const owner = ownerOfPath(rel, keptDirs, input.localeKeys)
    return owner !== null && (plan.tierOfGroup[owner.groupId] ?? plan.inlineTier) !== plan.inlineTier
  }
  const hasRestricted = plan.tiers.length > 0

  const out = { ...cfg } as unknown as Rec
  const themeConfig: Rec = { ...(runtime.inline.themeConfig ?? {}), lectureAccess: lectureAccessOf(plan) }
  if (hasRestricted && themeConfig.search && typeof themeConfig.search === 'object') {
    const search = themeConfig.search as Rec
    themeConfig.search = { ...search, options: { ...((search.options as Rec | undefined) ?? {}), _render: searchRender(restrictedPage) } }
  }
  out.themeConfig = themeConfig
  if (runtime.inline.locales) out.locales = runtime.inline.locales
  // client side (WP-A2): the merged search index and the dev-server routes of /_access/<tier>/; nothing is added without a restricted tier
  if (hasRestricted) {
    const vite = (cfg.vite ?? {}) as Rec
    out.vite = { ...vite, plugins: [...((vite.plugins as unknown[] | undefined) ?? []), ...accessVitePlugins(runtime, input)] }
  }

  // groups that are not built: their pages are not sources, and links to them are not dead links
  const exclude = input.allGroups
    .filter((g) => plan.removedGroupIds.includes(g.id))
    .flatMap((g) => pathPrefixesOf(g.dir, input.localeKeys).map((p) => `${p.slice(1)}**`))
  if (exclude.length) out.srcExclude = [...((cfg.srcExclude as string[] | undefined) ?? []), ...exclude]

  if (hasRestricted) {
    const priorTransform = cfg.transformPageData
    const metaOf = new Map(input.groups.map((g) => [g.id, g]))
    out.transformPageData = async (pageData: PageData, ctx: TransformPageContext) => {
      const prior = priorTransform ? await priorTransform(pageData, ctx) : undefined
      const rel = String(pageData.relativePath ?? '')
      const owner = ownerOfPath(rel, keptDirs, input.localeKeys)
      if (owner) {
        const fm = (pageData.frontmatter ??= {}) as Rec
        const tier = plan.tierOfGroup[owner.groupId] ?? plan.inlineTier
        fm.accessTier = tier
        const isIndex = rel === `${owner.locale ? `${owner.locale}/` : ''}${owner.dir}/index.md`
        if (tier !== plan.inlineTier) {
          if (isIndex) fm.groupMeta = metaOf.get(owner.groupId)
          else if (metaOf.get(owner.groupId)?.temp === true) fm.groupTemp = true
        }
      }
      return prior
    }
    const sitemap = cfg.sitemap as { transformItems?: (items: Array<{ url: string }>) => Array<{ url: string }> | Promise<Array<{ url: string }>> } | undefined
    if (sitemap) {
      const priorItems = sitemap.transformItems
      out.sitemap = { ...sitemap, transformItems: async (items: Array<{ url: string }>) => (await (priorItems ? priorItems(items) : items)).filter((i) => !restrictedPage(i.url)) }
    }
  }

  const priorBuildEnd = cfg.buildEnd
  out.buildEnd = async (siteConfig: SiteConfig) => {
    if (priorBuildEnd) await priorBuildEnd(siteConfig)
    finalizeDist(siteConfig, runtime, input)
  }
  return out as unknown as C
}

// ---- dist ------------------------------------------------------------------------------------------------------

function posix(p: string): string {
  return p.replace(/\\/g, '/')
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`[access] refusing to touch ${target}: not inside ${root}`)
}

function writeJson(file: string, value: unknown, indent?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, indent), 'utf8')
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch {
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
}

function removePath(outDir: string, target: string): void {
  assertInside(outDir, target)
  fs.rmSync(target, { recursive: true, force: true })
}

/** `data-lecture` values of the `<figure>` anchors of a markdown file: the same rule as config.mts `readLectureIds` (sidecar file name = value). */
function readFigureLectureIds(src: string): Set<string> {
  const out = new Set<string>()
  const re = /<figure\b[^>]*\bdata-lecture="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.add(m[1] as string)
  return out
}

/** chart sidecar file name (`G01-L01.json`) -> ids of the groups whose pages (any language) use it. */
export function chartOwners(docsRoot: string, groups: readonly GroupDir[], localeKeys: readonly string[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>()
  for (const g of groups) {
    for (const base of [g.dir, ...localeKeys.map((k) => `${k}/${g.dir}`)]) {
      const dir = path.join(docsRoot, base)
      if (!fs.existsSync(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        if (!/^L\d+\.md$/.test(f)) continue
        for (const id of readFigureLectureIds(fs.readFileSync(path.join(dir, f), 'utf8'))) {
          const file = `${id}.json`
          if (!owners.has(file)) owners.set(file, new Set())
          owners.get(file)?.add(g.id)
        }
      }
    }
  }
  return owners
}

/**
 * Where a file used by several groups goes: stays inline when any built inline group uses it, is dropped when no
 * built group uses it, else it goes to the lowest restricted tier (ties: the smaller tier id).
 */
export function placeShared(tiers: ReadonlyArray<string | null>, inlineTier: string): { action: 'stay' } | { action: 'drop' } | { action: 'move'; tier: string } {
  const built = tiers.filter((t): t is string => t !== null)
  if (built.length === 0) return { action: 'drop' }
  if (built.includes(inlineTier)) return { action: 'stay' }
  const best = [...built].sort((a, b) => tierRank(a) - tierRank(b) || (a < b ? -1 : a > b ? 1 : 0))[0] as string
  return { action: 'move', tier: best }
}

function warn(msg: string): void {
  console.warn(`[access] ${msg}`)
}

function log(msg: string): void {
  // eslint-disable-next-line no-console -- a build log line
  console.log(`[access] ${msg}`)
}

/** What `buildEnd` does; exported for tests that run it on a prepared dist. */
export function finalizeDist(siteConfig: SiteConfig, runtime: AccessRuntime, input: ApplyAccessInput): void {
  const { plan } = runtime
  const outDir = siteConfig.outDir
  const exists = (rel: string) => fs.existsSync(path.join(outDir, rel))

  const allDirs: GroupDir[] = [...input.allGroups]
  const tierOf = (id: string) => lookupTier(plan, id)

  // ---- lecture catalog: never read by the site, but scripts/remote_server.py (Dify tool search / summary, Notion
  // page-id lookup) reads it from the web root. Split it like the graph; untouched when nothing is restricted.
  const catalogFile = path.join(outDir, 'lecture_catalog.json')
  if (exists('lecture_catalog.json')) {
    const raw = fs.readFileSync(catalogFile, 'utf8')
    const items = readJson(catalogFile)
    if (Array.isArray(items)) {
      const c = splitCatalog(items as CatalogItemLike[], tierOf, plan.inlineTier)
      if (c.dropped.length || Object.keys(c.tiers).length) {
        const indent = /^\[\s*\n\s{2}\S/.test(raw) ? 2 : undefined
        writeJson(catalogFile, c.inline, indent)
      }
      for (const t of plan.tiers) writeJson(path.join(outDir, tierBasePath(t.id), 'lecture_catalog.json'), c.tiers[t.id] ?? [])
      log(`catalog: ${c.inline.length} inline lecture(s), ${Object.values(c.tiers).reduce((a, n) => a + n.length, 0)} in restricted tiers, ${c.dropped.length} dropped`)
    } else {
      warn('lecture_catalog.json is not a JSON array: left as it is')
    }
  }

  // ---- knowledge graph
  const graphFile = path.join(outDir, 'notion_knowledge_graph.json')
  const nodeIdsOf: Record<string, string[]> = {}
  if (exists('notion_knowledge_graph.json')) {
    const raw = fs.readFileSync(graphFile, 'utf8')
    const nodes = readJson(graphFile)
    if (Array.isArray(nodes)) {
      const g = splitGraph(nodes as GraphNodeLike[], tierOf, plan.inlineTier)
      if (g.dropped.length || Object.keys(g.tiers).length) {
        const indent = /^\[\s*\n\s{2}\S/.test(raw) ? 2 : undefined
        writeJson(graphFile, g.inline, indent)
      }
      for (const t of plan.tiers) {
        const tierNodes = g.tiers[t.id] ?? []
        writeJson(path.join(outDir, tierBasePath(t.id), 'graph.json'), tierNodes)
        nodeIdsOf[t.id] = tierNodes.map((n) => (typeof n.nodeId === 'string' ? n.nodeId : '')).filter(Boolean)
      }
      log(`graph: ${g.inline.length} inline node(s), ${Object.values(g.tiers).reduce((a, n) => a + n.length, 0)} in restricted tiers, ${g.dropped.length} dropped`)
    } else {
      warn('notion_knowledge_graph.json is not a JSON array: left as it is')
    }
  }

  // ---- charts
  if (exists('charts')) {
    const owners = chartOwners(input.docsRoot, allDirs, input.localeKeys)
    let moved = 0
    let dropped = 0
    for (const file of fs.readdirSync(path.join(outDir, 'charts'))) {
      const ownerIds = owners.get(file)
      if (!ownerIds) continue
      const verdict = placeShared([...ownerIds].map(tierOf), plan.inlineTier)
      const from = path.join(outDir, 'charts', file)
      if (verdict.action === 'drop') {
        removePath(outDir, from)
        dropped++
      } else if (verdict.action === 'move') {
        moveFile(from, path.join(outDir, tierBasePath(verdict.tier), 'charts', file))
        moved++
      }
    }
    if (moved || dropped) log(`charts: ${moved} moved to restricted tiers, ${dropped} dropped`)
  }

  // ---- figures (per group folder)
  if (exists('figures')) {
    let figMoved = 0
    let figDropped = 0
    for (const g of allDirs) {
      const tier = tierOf(g.id)
      const folder = path.join(outDir, 'figures', ...g.dir.split('/'))
      if (!fs.existsSync(folder)) continue
      if (tier === null) {
        removePath(outDir, folder)
        figDropped++
      } else if (tier !== plan.inlineTier) {
        moveFile(folder, path.join(outDir, tierBasePath(tier), 'figures', ...g.dir.split('/')))
        figMoved++
      }
    }
    if (figMoved || figDropped) log(`figures: ${figMoved} group dir(s) moved to restricted tiers, ${figDropped} dropped`)
  }

  // ---- exports (per group folder) and their manifest
  if (exists('exports')) {
    const manifestFile = path.join(outDir, 'exports', 'manifest.json')
    const manifest = readJson(manifestFile) as { items?: Record<string, unknown> } | undefined
    const itemsOfTier: Record<string, Record<string, unknown>> = {}
    let changed = false
    for (const g of allDirs) {
      const tier = tierOf(g.id)
      const folder = path.join(outDir, 'exports', g.dir)
      const prefix = `${g.dir}/`
      if (tier === null) {
        if (fs.existsSync(folder)) removePath(outDir, folder)
        for (const key of Object.keys(manifest?.items ?? {})) if (key.startsWith(prefix)) { delete manifest?.items?.[key]; changed = true }
      } else if (tier !== plan.inlineTier) {
        if (fs.existsSync(folder)) moveFile(folder, path.join(outDir, tierBasePath(tier), 'exports', g.dir))
        for (const [key, value] of Object.entries(manifest?.items ?? {})) {
          if (!key.startsWith(prefix)) continue
          ;(itemsOfTier[tier] ??= {})[key] = value
          delete manifest?.items?.[key]
          changed = true
        }
      }
    }
    if (manifest && changed) {
      writeJson(manifestFile, manifest, 2)
      for (const [tier, items] of Object.entries(itemsOfTier)) writeJson(path.join(outDir, tierBasePath(tier), 'exports', 'manifest.json'), { ...manifest, items }, 2)
    }
  }

  // ---- per tier: site data and search documents
  const locales = ['root', ...input.localeKeys]
  const pagesAll = [...siteConfig.pages]
  for (const t of runtime.tiers) {
    const base = path.join(outDir, tierBasePath(t.info.id))
    writeJson(path.join(base, 'site-data.json'), t.slice)
    const mine = [...restrictedPages.values()].filter((p) => {
      const owner = ownerOfPath(p.relativePath, allDirs, input.localeKeys)
      return owner !== null && plan.tierOfGroup[owner.groupId] === t.info.id
    })
    mine.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
    for (const locale of locales) {
      const splitManifest = path.join(base, 'search', locale, 'manifest.json')
      if (fs.existsSync(splitManifest)) continue
      const docs: SearchDocument[] = mine
        .filter((p) => localeOfPath(p.relativePath, input.localeKeys) === locale)
        .flatMap((p) => searchDocumentsOf(p.relativePath, p.html, siteConfig.site.base, siteConfig.cleanUrls ?? false))
      writeJson(path.join(base, 'search', `${locale}.json`), docs)
    }
    const hasSplitSearch = fs.existsSync(path.join(base, 'search', 'root', 'manifest.json'))
    if (!hasSplitSearch && mine.length === 0 && t.info.groupIds.length > 0) warn(`tier ${t.info.id}: no restricted page went through the search hook (search documents are empty)`)
  }

  // ---- curriculum (P4a) & canvas layout (P4b): the inline part is a VitePress data loader; every restricted tier gets its slices
  const curriculum = input.curriculum?.()
  if (curriculum) {
    const { stats, warnings } = curriculumLog(curriculum)
    log(`curriculum: ${stats}`)
    for (const w of warnings) warn(`curriculum: ${w}`)
    const rootCur = curriculum.byLocale.root
    for (const t of runtime.tiers) {
      for (const bucket of Object.keys(curriculum.byLocale)) {
        const slice = curriculumSliceOf(curriculum, plan, t.info.id, bucket)
        if (slice) writeJson(path.join(outDir, tierBasePath(t.info.id), `curriculum.${bucket}.json`), slice)
      }
      if (rootCur) writeJson(path.join(outDir, tierBasePath(t.info.id), 'canvas.json'), canvasSliceOf(rootCur, plan, t.info.id))
    }
  }

  // ---- gateway manifest
  const manifestDir = path.resolve(input.docsRoot, '..', '.lecture-build')
  const curriculumNames = curriculum ? curriculumNamesByTier(curriculum, plan) : {}
  const builtGroupIds = new Set(input.allGroups.map((g) => g.id))
  const conceptRecords = loadConceptRecords({
    content: contentForDocsRoot(input.docsRoot),
    accessPlan: plan,
    builtGroupIds,
    includeDrafts: false,
    isDev: false,
    localeKeys: input.localeKeys,
  })
  const inlineConceptTerms = new Set(
    conceptRecords.filter((r) => !r.isDraft && !r.drop && r.tier === plan.inlineTier).map((r) => r.meta.term),
  )
  // a concept term that also stands in the text or title of a lecture of ANOTHER tier is an ordinary word there (a lecture on
  // optimistic concurrency names the concept without being a leak), so it cannot be searched for: ambiguous, like shared titles
  const otherTierLectures = scanLectureFiles({
    content: contentForDocsRoot(input.docsRoot),
    groups: input.allGroups,
    localeKeys: input.localeKeys,
    accessPlan: plan,
  }).filter((l) => !plan.removedGroupIds.includes(l.groupId))
  const conceptNamesByTier = new Map<string, string[]>()
  const conceptAmbiguousByTier = new Map<string, string[]>()
  for (const r of conceptRecords) {
    if (r.isDraft || r.drop || r.tier === plan.inlineTier) continue
    if (r.meta.term.length < DEFAULT_MIN_NAME || inlineConceptTerms.has(r.meta.term)) continue
    if (otherTierLectures.some((l) => l.tier !== r.tier && l.raw.includes(r.meta.term))) {
      conceptAmbiguousByTier.set(r.tier, [...(conceptAmbiguousByTier.get(r.tier) ?? []), r.meta.term])
      continue
    }
    const list = conceptNamesByTier.get(r.tier) ?? []
    list.push(r.meta.term)
    conceptNamesByTier.set(r.tier, list)
  }
  const union = (a: readonly string[], b: readonly string[] | undefined) => [...new Set([...a, ...(b ?? [])])]
  const tierManifest = runtime.tiers.map((t) => ({
    id: t.info.id,
    rule: t.info.rule,
    groupIds: t.info.groupIds,
    dirs: t.dirs,
    pathPrefixes: [...t.dirs.flatMap((d) => pathPrefixesOf(d, input.localeKeys)), `${tierBasePath(t.info.id)}/`],
    pageChunkPatterns: [
      ...t.dirs.flatMap((d) => chunkPatternsOf(d, input.localeKeys)),
      conceptTierChunkPattern(t.info.id, input.localeKeys),
    ],
    pages: pagesAll
      .filter((p) => {
        if (p.startsWith(`_access/${t.info.id}/concepts/`)) return true
        if (input.localeKeys.some((k) => p.startsWith(`${k}/_access/${t.info.id}/concepts/`))) return true
        const owner = ownerOfPath(p, allDirs, input.localeKeys)
        return owner !== null && plan.tierOfGroup[owner.groupId] === t.info.id
      })
      .sort(),
    // site-data names (full sidebar titles) plus the curriculum's prefix-less titles and restricted concept terms
    names: union(
      union(t.names, curriculumNames[t.info.id]?.names),
      conceptNamesByTier.get(t.info.id),
    ).filter((n) => !t.ambiguousNames.includes(n) && !(curriculumNames[t.info.id]?.ambiguous ?? []).includes(n)),
    ambiguousNames: union(union(t.ambiguousNames, curriculumNames[t.info.id]?.ambiguous), conceptAmbiguousByTier.get(t.info.id)),
    nodeIds: nodeIdsOf[t.info.id] ?? [],
  }))
  writeJson(
    path.join(manifestDir, 'access-manifest.json'),
    {
      version: 1,
      builtAt: new Date().toISOString(),
      outDir: posix(path.resolve(outDir)),
      audience: plan.audience,
      enforcement: plan.enforcement,
      defaultTier: plan.defaultTier,
      inlineTier: plan.inlineTier,
      localeKeys: input.localeKeys,
      removedGroupIds: plan.removedGroupIds,
      tiers: tierManifest,
    },
    2,
  )
  log(`inline tier ${plan.inlineTier}; restricted tiers: ${plan.tiers.map((t) => t.id).join(', ') || 'none'}; manifest: ${posix(path.join(manifestDir, 'access-manifest.json'))}`)
}
