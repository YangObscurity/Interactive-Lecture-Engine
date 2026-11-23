/**
 * plugins/conceptsPlugin.mts - Vite dev-server & build emitter for per-tier concept hover / backlinks JSON.
 *
 * Notice:
 *   - Hover summaries are NEVER bundled into any JS chunk or virtual module.
 *   - Public hover file is emitted at `/concepts-hover.json`.
 *   - Restricted tier hover & backlinks files are emitted at `/_access/<tier>/concepts-hover.json`
 *     and `/_access/<tier>/concepts-backlinks.json`.
 *   - Drafts (`<conceptsDir>/_drafts/`) are excluded from all production build outputs.
 *   - AI tool data (`tools/*.json`, `_access/<tier>/tools/*.json`) comes from `concepts/toolFiles.mts`; the dev server
 *     serves the same files.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Connect, Plugin, ResolvedConfig } from 'vite'
import { resolveAccess, type AccessPlan } from '../access/tiers.ts'
import { loadLectureConfig } from '../content/config.mts'
import { type ContentPaths } from '../content/paths.mts'
import {
  buildBacklinkPayloadsByTier,
  buildHoverPayloadsByTier,
  computeConceptBacklinks,
  contentForDocsRoot,
  draftsDirOf,
  loadConceptRecords,
  scanLectureFiles,
  type GroupInfo,
} from '../concepts/node.mts'
import { createAnchorParser } from '../concepts/lectureSections.mts'
import { buildToolFiles, writeToolFiles } from '../concepts/toolFiles.mts'

export interface ConceptsPluginInput {
  docsRoot: string
  allGroups: readonly GroupInfo[]
  localeKeys: readonly string[]
  accessPlan: AccessPlan
}

interface CachedPayloads {
  files: Map<string, string>
}

export function buildConceptDistAssets(input: ConceptsPluginInput, content?: ContentPaths): Map<string, string> {
  const resolved = content ?? contentForDocsRoot(input.docsRoot)
  const builtGroupIds = new Set(input.allGroups.map((g) => g.id))
  const records = loadConceptRecords({
    content: resolved,
    accessPlan: input.accessPlan,
    builtGroupIds,
    includeDrafts: false,
    isDev: false,
    localeKeys: input.localeKeys,
  })

  const out = new Map<string, string>()
  const hoverByTier = buildHoverPayloadsByTier(records, input.accessPlan)
  for (const [tier, payload] of hoverByTier) {
    if (tier === input.accessPlan.inlineTier) {
      out.set('concepts-hover.json', JSON.stringify(payload))
    } else {
      out.set(`_access/${tier}/concepts-hover.json`, JSON.stringify(payload))
    }
  }

  const lectures = scanLectureFiles({
    content: resolved,
    groups: input.allGroups,
    localeKeys: input.localeKeys,
    accessPlan: input.accessPlan,
  })
  const backlinks = computeConceptBacklinks(lectures)
  const { restrictedByTier } = buildBacklinkPayloadsByTier(backlinks, input.accessPlan)
  for (const [tier, payload] of restrictedByTier) {
    out.set(`_access/${tier}/concepts-backlinks.json`, JSON.stringify(payload))
  }

  return out
}

export function writeConceptDistAssets(outDir: string, input: ConceptsPluginInput, content?: ContentPaths): void {
  const assets = buildConceptDistAssets(input, content)
  for (const [rel, body] of assets) {
    const abs = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, body, 'utf8')
  }
}

/**
 * Writes `tools/*.json` and `_access/<tier>/tools/*.json` into the output directory (buildEnd). Returns the size in bytes
 * of every file written, by path relative to `outDir`.
 */
export async function writeConceptToolsDist(
  outDir: string,
  input: ConceptsPluginInput,
  content?: ContentPaths,
): Promise<Map<string, number>> {
  const resolved = content ?? contentForDocsRoot(input.docsRoot)
  const records = loadConceptRecords({
    content: resolved,
    accessPlan: input.accessPlan,
    builtGroupIds: new Set(input.allGroups.map((g) => g.id)),
    includeDrafts: false,
    isDev: false,
    localeKeys: input.localeKeys,
  })
  const lectures = scanLectureFiles({
    content: resolved,
    groups: input.allGroups,
    localeKeys: input.localeKeys,
    accessPlan: input.accessPlan,
  })
  const md = await createAnchorParser(input.docsRoot)
  return writeToolFiles(outDir, { records, lectures, accessPlan: input.accessPlan, localeKeys: input.localeKeys, md })
}

export function conceptsVitePlugin(input: ConceptsPluginInput): Plugin {
  let resolved: ResolvedConfig | null = null
  let cache: CachedPayloads | null = null
  let toolsCache: Promise<Map<string, string>> | null = null

  const invalidate = (): void => {
    cache = null
    toolsCache = null
  }

  const getToolFiles = (): Promise<Map<string, string>> => {
    toolsCache ??= (async () => {
      const content = contentForDocsRoot(input.docsRoot)
      const cfg = loadLectureConfig({ paths: content })
      const plan = resolveAccess({ access: cfg.access, groupIds: input.allGroups.map((g) => g.id) })
      const records = loadConceptRecords({
        content,
        accessPlan: plan,
        builtGroupIds: new Set(input.allGroups.map((g) => g.id)),
        includeDrafts: false,
        isDev: true,
        localeKeys: input.localeKeys,
      })
      const lectures = scanLectureFiles({ content, groups: input.allGroups, localeKeys: input.localeKeys, accessPlan: plan })
      const md = await createAnchorParser(input.docsRoot)
      return buildToolFiles({ records, lectures, accessPlan: plan, localeKeys: input.localeKeys, md })
    })()
    return toolsCache
  }

  const getFiles = (): Map<string, string> => {
    if (cache) return cache.files
    const content = contentForDocsRoot(input.docsRoot)
    const cfg = loadLectureConfig({ paths: content })
    const plan = resolveAccess({ access: cfg.access, groupIds: input.allGroups.map((g) => g.id) })
    const builtGroupIds = new Set(input.allGroups.map((g) => g.id))
    const records = loadConceptRecords({
      content,
      accessPlan: plan,
      builtGroupIds,
      includeDrafts: true,
      isDev: true,
      localeKeys: input.localeKeys,
    })

    const map = new Map<string, string>()
    const hoverByTier = buildHoverPayloadsByTier(records, plan)
    for (const [tier, payload] of hoverByTier) {
      if (tier === plan.inlineTier) {
        map.set('concepts-hover.json', JSON.stringify(payload))
      } else {
        map.set(`_access/${tier}/concepts-hover.json`, JSON.stringify(payload))
      }
    }
    const lectures = scanLectureFiles({
      content,
      groups: input.allGroups,
      localeKeys: input.localeKeys,
      accessPlan: plan,
    })
    const backlinks = computeConceptBacklinks(lectures)
    const { restrictedByTier } = buildBacklinkPayloadsByTier(backlinks, plan)
    for (const [tier, payload] of restrictedByTier) {
      map.set(`_access/${tier}/concepts-backlinks.json`, JSON.stringify(payload))
    }

    cache = { files: map }
    return map
  }

  return {
    name: 'lecture:concepts-assets',
    apply: 'serve',
    configResolved(cfg) {
      resolved = cfg
    },
    configureServer(server) {
      const content = contentForDocsRoot(input.docsRoot)
      const watchDirs = [path.resolve(content.conceptsDir), path.resolve(draftsDirOf(content)), path.resolve(content.docsRoot)]
      const shouldInvalidate = (f: string): boolean => {
        const abs = path.resolve(f)
        return abs.endsWith('.md') && watchDirs.some((d) => abs.startsWith(d))
      }
      server.watcher.on('add', (f) => {
        if (shouldInvalidate(f)) invalidate()
      })
      server.watcher.on('change', (f) => {
        if (shouldInvalidate(f)) invalidate()
      })
      server.watcher.on('unlink', (f) => {
        if (shouldInvalidate(f)) invalidate()
      })

      const handler: Connect.NextHandleFunction = (req, res, next) => {
        const base = (resolved?.base ?? '/').replace(/\/$/, '')
        const url = (req.url ?? '').split('?')[0] ?? ''
        const rel = url.startsWith(`${base}/`) ? url.slice(base.length + 1) : url.replace(/^\//, '')
        const isTools = /^(?:_access\/[^/]+\/)?tools\/(?:concepts|lectures|tiers)\.json$/.test(rel)
        if (isTools) {
          getToolFiles().then(
            (files) => {
              const toolBody = files.get(rel)
              if (!toolBody) return next()
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/json; charset=utf-8')
              res.setHeader('Content-Length', String(Buffer.byteLength(toolBody, 'utf8')))
              res.setHeader('Cache-Control', 'no-store')
              res.end(toolBody)
            },
            (err) => next(err),
          )
          return
        }
        if (rel !== 'concepts-hover.json' && !/^_access\/[^/]+\/concepts-(?:hover|backlinks)\.json$/.test(rel)) {
          return next()
        }
        const body = getFiles().get(rel)
        if (!body) return next()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Content-Length', String(Buffer.byteLength(body, 'utf8')))
        res.setHeader('Cache-Control', 'no-store')
        res.end(body)
      }

      server.middlewares.use(handler)
    },
  }
}
