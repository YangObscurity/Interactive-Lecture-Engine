/**
 * access/vitePlugins.mts - the two Vite plugins of the client side of P3b (docs-dev/ACCESS.md).
 * Imported by build.mts (`applyAccess` adds them to `vite.plugins` when a restricted tier exists); never by client code.
 *
 *   accessSearchPlugin   `enforce: 'pre'`; resolves only the exact id `@localSearchIndex` to its own module, which exports
 *                        `{ [locale]: () => searchIndexFor(locale, () => import('@localSearchIndex<locale>')) }`.
 *                        The per-locale ids stay with VitePress. The module id is `/@localSearchIndex`, the one VitePress
 *                        uses, so the dev server's hot update of the index still reaches it.
 *   accessDevPlugin      dev server only: serves `/_access/<tier>/(site-data.json | curriculum.<locale>.json | graph.json | search/<locale>.json |
 *                        lecture_catalog.json | charts/* | exports/*)` from the source data, so
 *                        `LECTURE_ACCESS_JSON=... npm run dev` shows the tiered behaviour without a build. There is no
 *                        gateway in dev: every tier is served to everybody (tests put their own gateway in front).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Connect, Plugin, ResolvedConfig } from 'vite'
import type { AccessRuntime, ApplyAccessInput } from './build.mts'
import { chartOwners, curriculumSliceOf, getRestrictedSearchDocuments, placeShared } from './build.mts'
import { canvasSliceOf } from '../curriculum/canvasNode.mts'
import { localeOfPath, searchDocumentsOf } from './search.ts'
import { splitCatalog, splitGraph } from './siteData.ts'
import type { CatalogItemLike, GraphNodeLike } from './siteData.ts'
import { lookupTier, ownerOfPath, tierBasePath } from './tiers.ts'
import { buildSearchArtifacts } from '../search/indexBuilder.ts'
import { resolveContent } from '../content/paths.mts'
import { buildFigureAuditAndGallery } from '../figures/gallery.ts'
import { ORIGINAL_FIGURE_EXTS, validateSafeFigureRelPath } from '../figures/pathGuard.ts'

const SEARCH_INDEX_ID = '@localSearchIndex'
/** The id VitePress resolves `@localSearchIndex` to (and invalidates when a page changes in dev). */
const SEARCH_INDEX_RESOLVED = `/${SEARCH_INDEX_ID}`

const here = path.dirname(fileURLToPath(import.meta.url))
/** Absolute, forward-slash path of the runtime glue the generated module imports. */
const SEARCH_RUNTIME = path.resolve(here, '../theme/access/searchRuntime.ts').replace(/\\/g, '/')

/** Source of the module that replaces `@localSearchIndex`. Pure; exported for tests. */
export function searchIndexModule(locales: readonly string[], runtimePath: string = SEARCH_RUNTIME): string {
  const entries = locales.map((l) => `${JSON.stringify(l)}: () => searchIndexFor(${JSON.stringify(l)}, () => import(${JSON.stringify(`${SEARCH_INDEX_ID}${l}`)}))`)
  return `import { searchIndexFor } from ${JSON.stringify(runtimePath)}\nexport default {${entries.join(',')}}\n`
}

/**
 * The locale keys in the source VitePress generates for `/@localSearchIndex` (`export default {"root": () => import(...), ...}`).
 * Empty when the source has another shape.
 */
export function localesOfIndexSource(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/(?:^|[{,])\s*("(?:[^"\\]|\\.)*")\s*:\s*\(\)\s*=>\s*import\(/g)) out.push(JSON.parse(m[1] as string) as string)
  return out
}

type LoadHook = (this: unknown, id: string) => unknown

/** The `load` hook of the VitePress local-search plugin (a function, or `{ handler }`), or undefined. */
function vitepressSearchLoad(config: ResolvedConfig): LoadHook | undefined {
  const plugin = config.plugins.find((p) => p.name === 'vitepress:local-search')
  const hook = plugin?.load as LoadHook | { handler: LoadHook } | undefined
  return typeof hook === 'function' ? hook : hook?.handler
}

/**
 * `fallbackLocales`: used only when VitePress' own source for the id cannot be read. VitePress' `load` for the exact id
 * is what indexes every page in a production build (`scanForBuild`), so it is called here, once per load of the module,
 * exactly as it would have been; its answer is only used for the list of locales.
 */
export function accessSearchPlugin(fallbackLocales: readonly string[]): Plugin {
  let vpLoad: LoadHook | undefined
  return {
    name: 'lecture:access-search-index',
    enforce: 'pre',
    configResolved(config) {
      vpLoad = vitepressSearchLoad(config)
    },
    resolveId(id) {
      // exact match only: `@localSearchIndexroot`, `@localSearchIndexen`, ... belong to VitePress
      if (id === SEARCH_INDEX_ID) return SEARCH_INDEX_RESOLVED
      return undefined
    },
    async load(id) {
      if (id !== SEARCH_INDEX_RESOLVED) return undefined
      const original = vpLoad ? await vpLoad.call(this, id) : undefined
      const found = typeof original === 'string' ? localesOfIndexSource(original) : []
      return searchIndexModule(found.length > 0 ? found : fallbackLocales)
    },
  }
}

// ---- dev server -------------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8'

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.statusCode = status
  res.setHeader('Content-Type', type)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

const TYPES: Record<string, string> = {
  '.json': JSON_TYPE,
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
}

/** A file below `root`, or null when the path escapes it (`..`) or does not name a file. */
function safeFile(root: string, rel: string): string | null {
  const target = path.resolve(root, rel)
  const inside = path.relative(root, target)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null
  return fs.existsSync(target) && fs.statSync(target).isFile() ? target : null
}

export interface DevTierData {
  /** The answer of a JSON path, or `file`: a source file to stream, or `raw`: raw binary buffer. Undefined result = 404. */
  json?: unknown
  file?: string
  raw?: Buffer
  contentType?: string
}

const searchBuildCache = new Map<string, ReturnType<typeof buildSearchArtifacts>>()

export function invalidateAccessSearchCache(): void {
  searchBuildCache.clear()
}

/** What `/_access/<tier>/<rest>` answers in dev. Reads the source files, no server needed; exported for tests. */
export function devTierResponse(runtime: AccessRuntime, input: ApplyAccessInput, base: string, cleanUrls: boolean, tier: string, rest: string): DevTierData | undefined {
  const { plan } = runtime
  const t = runtime.tiers.find((x) => x.info.id === tier)
  if (!t) return undefined
  const contentPaths = resolveContent()
  const useDefaultContent = path.resolve(input.docsRoot) === path.resolve(contentPaths.docsRoot)
  const docsPub = path.join(input.docsRoot, 'public')
  const contentPub = input.publicDir ?? (useDefaultContent ? contentPaths.publicDir : docsPub)
  const chartsDir = input.chartsDir ?? (useDefaultContent ? contentPaths.chartsDir : path.join(docsPub, 'charts'))
  const notionGraphFile =
    input.notionKnowledgeGraphFile ??
    (useDefaultContent ? contentPaths.graphDir.notionKnowledgeGraph : path.join(docsPub, path.basename(contentPaths.graphDir.notionKnowledgeGraph)))
  const readPublicJson = (fileName: string) => {
    const fromContent = path.join(contentPub, fileName)
    if (fs.existsSync(fromContent)) return readJsonFile(fromContent)
    const fromDocs = path.join(docsPub, fileName)
    return fromDocs === fromContent ? undefined : readJsonFile(fromDocs)
  }
  const tierOf = (id: string) => lookupTier(plan, id)

  if (rest === 'site-data.json') return { json: t.slice }

  const cur = /^curriculum\.([^/]+)\.json$/.exec(rest)
  if (cur) {
    const build = input.curriculum?.()
    const slice = build ? curriculumSliceOf(build, plan, tier, cur[1] as string) : undefined
    return slice ? { json: slice } : undefined
  }

  if (rest === 'canvas.json') {
    const build = input.curriculum?.()
    const root = build?.byLocale.root
    return root ? { json: canvasSliceOf(root, plan, tier) } : undefined
  }

  if (rest === 'graph.json') {
    const nodes = readJsonFile(notionGraphFile)
    return { json: Array.isArray(nodes) ? (splitGraph(nodes as GraphNodeLike[], tierOf, plan.inlineTier).tiers[tier] ?? []) : [] }
  }

  if (rest === 'lecture_catalog.json') {
    const items = readPublicJson('lecture_catalog.json')
    return { json: Array.isArray(items) ? (splitCatalog(items as CatalogItemLike[], tierOf, plan.inlineTier).tiers[tier] ?? []) : [] }
  }

  const splitSearch = /^search\/([^/]+)\/(manifest\.json|titles\.json|shards\/[^/]+\.sz)$/.exec(rest)
  if (splitSearch) {
    const cacheKey = `${input.docsRoot}|${base}|${cleanUrls}|${runtime.plan.tiers.map((x) => x.id).join(',')}`
    let built = searchBuildCache.get(cacheKey)
    if (!built) {
      built = buildSearchArtifacts({
        docsRoot: input.docsRoot,
        allGroups: input.allGroups.map((g) => {
          const match = input.groups.find((x) => x.id === g.id)
          return { id: g.id, dir: g.dir, title: match?.title ?? g.id }
        }),
        localeKeys: input.localeKeys,
        base,
        cleanUrls,
        accessPlan: runtime.plan,
      })
      searchBuildCache.set(cacheKey, built)
    }
    const relKey = `${tierBasePath(tier).slice(1)}/${rest}`
    const payload = built.artifacts.get(relKey)
    if (!payload) return undefined
    const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
    if (rest.endsWith('.json')) return { json: JSON.parse(buf.toString('utf8')) as unknown }
    return { raw: buf, contentType: 'application/octet-stream' }
  }

  const search = /^search\/([^/]+)\.json$/.exec(rest)
  if (search) {
    const locale = search[1] as string
    const docs = [...getRestrictedSearchDocuments().values()]
      .filter((p) => {
        const owner = ownerOfPath(p.relativePath, input.allGroups, input.localeKeys)
        return owner !== null && plan.tierOfGroup[owner.groupId] === tier && localeOfPath(p.relativePath, input.localeKeys) === locale
      })
      .sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1))
      .flatMap((p) => searchDocumentsOf(p.relativePath, p.html, base, cleanUrls))
    return { json: docs }
  }

  const chart = /^charts\/([^/]+\.json)$/.exec(rest)
  if (chart) {
    const file = chart[1] as string
    const owners = chartOwners(input.docsRoot, input.allGroups, input.localeKeys).get(file)
    if (!owners) return undefined
    const verdict = placeShared([...owners].map(tierOf), plan.inlineTier)
    if (verdict.action !== 'move' || verdict.tier !== tier) return undefined
    const f = safeFile(chartsDir, file)
    return f ? { file: f } : undefined
  }

  if (rest === 'figures-gallery.json') {
    const paths = resolveContent()
    const audit = buildFigureAuditAndGallery(
      {
        paths: {
          ...paths,
          figuresDir: input.figuresDir || paths.figuresDir,
          lecturesDir: input.docsRoot,
          docsRoot: input.docsRoot,
        },
        groups: input.allGroups,
        localeKeys: input.localeKeys,
        accessPlan: plan,
      },
      { verifyFiles: false, isBuild: false },
    )
    return { json: { version: 1, items: audit.gallery.filter((item) => item.tier === tier) } }
  }

  const fig = /^figures\/(.+)$/.exec(rest)
  if (fig) {
    const relative = fig[1] as string
    const guard = validateSafeFigureRelPath(relative, { allowedExts: ORIGINAL_FIGURE_EXTS })
    if (!guard.ok) return undefined
    if (!t.dirs.some((d) => guard.normalized.startsWith(`${d}/`))) return undefined
    const paths = resolveContent()
    const figuresRoot = input.figuresDir || paths.figuresDir
    const f =
      safeFile(figuresRoot, guard.normalized) ??
      safeFile(path.join(docsPub, 'figures'), guard.normalized)
    return f ? { file: f } : undefined
  }

  if (rest === 'exports/manifest.json') {
    const manifest = readPublicJson(path.join('exports', 'manifest.json')) as { items?: Record<string, unknown> } | undefined
    if (!manifest) return undefined
    const dirs = t.dirs.map((d) => `${d}/`)
    const items = Object.fromEntries(Object.entries(manifest.items ?? {}).filter(([k]) => dirs.some((d) => k.startsWith(d))))
    return { json: { ...manifest, items } }
  }

  const exp = /^exports\/(.+)$/.exec(rest)
  if (exp) {
    const relative = exp[1] as string
    if (!t.dirs.some((d) => relative.startsWith(`${d}/`))) return undefined
    const f = safeFile(path.join(contentPub, 'exports'), relative) ?? safeFile(path.join(docsPub, 'exports'), relative)
    return f ? { file: f } : undefined
  }
  return undefined
}

export function accessDevPlugin(runtime: AccessRuntime, input: ApplyAccessInput): Plugin {
  let resolved: ResolvedConfig | null = null
  return {
    name: 'lecture:access-dev-server',
    apply: 'serve',
    configResolved(config) {
      resolved = config
    },
    configureServer(server) {
      const docsRoot = path.resolve(input.docsRoot)
      const onMd = (f: string) => {
        if (f.endsWith('.md') && path.resolve(f).startsWith(docsRoot)) invalidateAccessSearchCache()
      }
      server.watcher.on('add', onMd)
      server.watcher.on('change', onMd)
      server.watcher.on('unlink', onMd)

      const handler: Connect.NextHandleFunction = (req, res, next) => {
        const base = resolved?.base ?? '/'
        const url = (req.url ?? '').split('?')[0] ?? ''
        const prefix = `${base.replace(/\/$/, '')}/_access/`
        if (!url.startsWith(prefix)) return next()
        const m = /^([^/]+)\/(.+)$/.exec(url.slice(prefix.length))
        if (!m) return send(res, 404, 'not found', 'text/plain')
        let rest = m[2] as string
        try {
          rest = decodeURIComponent(rest)
        } catch {
          return send(res, 400, 'bad request', 'text/plain')
        }
        if (rest.split('/').includes('..')) return send(res, 400, 'bad request', 'text/plain')
        const answer = devTierResponse(runtime, input, base, true, m[1] as string, rest)
        if (!answer) return send(res, 404, 'not found', 'text/plain')
        if (answer.file) return send(res, 200, fs.readFileSync(answer.file), TYPES[path.extname(answer.file).toLowerCase()] ?? 'application/octet-stream')
        if (answer.raw) {
          res.setHeader('Content-Length', String(answer.raw.byteLength))
          return send(res, 200, answer.raw, answer.contentType ?? 'application/octet-stream')
        }
        return send(res, 200, JSON.stringify(answer.json ?? null), JSON_TYPE)
      }
      // a plain `use` in `configureServer` runs before Vite's internal middlewares (the SPA fallback would answer these paths with the page)
      server.middlewares.use(handler)
    },
  }
}

/** The plugins `applyAccess` adds when the build has a restricted tier. */
export function accessVitePlugins(runtime: AccessRuntime, input: ApplyAccessInput): Plugin[] {
  return [accessSearchPlugin(['root', ...input.localeKeys]), accessDevPlugin(runtime, input)]
}
