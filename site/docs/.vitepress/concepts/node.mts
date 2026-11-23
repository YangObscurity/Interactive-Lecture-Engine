/**
 * concepts/node.mts - Node-side concept repository loader, backlink scanner, and per-tier hover/backlink builders.
 *
 * All content paths are resolved through `V/content/paths.mts` (`conceptsDir`, `lecturesDir`, `docsRoot`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveContent, type ContentPaths } from '../content/paths.mts'
import { lookupTier, ownerOfPath, resolveAccess, type AccessPlan } from '../access/tiers.ts'
import {
  canReaderTierReadConcept,
  conceptDraftPreviewUrl,
  conceptPageUrl,
  resolveConceptTier,
} from './access.ts'
import {
  countConceptSources,
  hasUnverifiedMarkers,
  isValidConceptSlug,
  parseConceptMarkdown,
  type ConceptBacklinkPayload,
  type ConceptHoverEntry,
  type ConceptHoverPayload,
  type ConceptMeta,
  type ConceptRelatedLecture,
} from './frontmatter.ts'
import { findAllConceptLinksInMarkdown } from './sourceRewriter.ts'
import {
  buildConceptGraph,
  checkConcepts,
  type CheckedConcept,
  type ConceptCheckResult,
  type ConceptGraph,
  type LectureCitation,
} from './graph.ts'

export interface ConceptRecord {
  slug: string
  filePath: string
  relDocsPath: string
  locale: string
  isDraft: boolean
  meta: ConceptMeta
  body: string
  raw: string
  tier: string
  drop: boolean
  url: string
  sourcesCount: number
  hasUnverified: boolean
  unverifiedLines: string[]
}

export interface GroupInfo {
  id: string
  dir: string
  title?: string
}

export interface LectureFileEntry {
  absPath: string
  relDocsPath: string
  urlPath: string
  groupId: string
  tier: string
  code: string
  title: string
  raw: string
}

export function contentForDocsRoot(docsRoot: string): ContentPaths {
  const base = resolveContent()
  if (path.resolve(docsRoot) === path.resolve(base.docsRoot)) return base
  return {
    ...base,
    docsRoot: path.resolve(docsRoot),
    lecturesDir: path.resolve(docsRoot),
    conceptsDir: path.join(path.resolve(docsRoot), 'concepts'),
  }
}

export function tierOfPagePath(
  relDocsPath: string,
  groups: readonly GroupInfo[],
  localeKeys: readonly string[],
  plan: AccessPlan,
): string {
  const owner = ownerOfPath(relDocsPath, groups, localeKeys)
  if (!owner) return plan.inlineTier
  return lookupTier(plan, owner.groupId) ?? plan.inlineTier
}

const DEFAULT_PLAN: AccessPlan = resolveAccess({ groupIds: [] })

function walkMarkdownFiles(rootDir: string, skipDirs: ReadonlySet<string>): string[] {
  if (!fs.existsSync(rootDir)) return []
  const out: string[] = []
  const stack: string[] = [rootDir]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        stack.push(path.join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(path.join(dir, entry.name))
      }
    }
  }
  return out.sort()
}

function normalizePosix(p: string): string {
  return p.split(path.sep).join('/')
}

export function draftsDirOf(content: Pick<ContentPaths, 'conceptsDir'>): string {
  return path.join(content.conceptsDir, '_drafts')
}

export interface LoadConceptsOptions {
  content?: ContentPaths
  accessPlan?: AccessPlan
  builtGroupIds?: ReadonlySet<string>
  includeDrafts?: boolean
  isDev?: boolean
  localeKeys?: readonly string[]
}

/**
 * Load concept pages from `content.conceptsDir` (plus locale subfolders if present).
 * Drafts live under `<conceptsDir>/_drafts/` and are loaded ONLY when `includeDrafts === true`.
 */
export function loadConceptRecords(opts: LoadConceptsOptions = {}): ConceptRecord[] {
  const content = opts.content ?? resolveContent()
  const plan = opts.accessPlan ?? DEFAULT_PLAN
  const includeDrafts = opts.includeDrafts === true
  const isDev = opts.isDev === true
  const localeKeys = opts.localeKeys ?? []

  const records: ConceptRecord[] = []

  const readOneFile = (absPath: string, isDraft: boolean, locale: string): ConceptRecord | null => {
    const slug = path.basename(absPath, '.md')
    if (!isValidConceptSlug(slug)) return null
    const raw = fs.readFileSync(absPath, 'utf8')
    const parsed = parseConceptMarkdown(raw, slug)
    const status = isDraft ? 'draft' : parsed.meta.status
    const meta: ConceptMeta = { ...parsed.meta, slug, status }
    const tierRes = resolveConceptTier(meta.groups, plan, opts.builtGroupIds)
    const localePrefix = locale === 'root' ? '' : `/${locale}`
    const relDocsPath = isDraft
      ? `${locale === 'root' ? '' : `${locale}/`}concepts/_drafts/${slug}.md`
      : `${locale === 'root' ? '' : `${locale}/`}concepts/${slug}.md`
    const url = isDraft
      ? `${localePrefix}${conceptDraftPreviewUrl(slug)}`
      : `${localePrefix}${conceptPageUrl(slug, tierRes.tier, plan.inlineTier, isDev)}`
    const unverif = hasUnverifiedMarkers(raw)
    return {
      slug,
      filePath: absPath,
      relDocsPath,
      locale,
      isDraft,
      meta,
      body: parsed.body,
      raw,
      tier: tierRes.tier,
      drop: tierRes.drop,
      url,
      sourcesCount: countConceptSources(parsed.body),
      hasUnverified: unverif.hasUnverified,
      unverifiedLines: unverif.lines,
    }
  }

  // Root published concepts (directly under `conceptsDir` or top-level non-_drafts)
  if (fs.existsSync(content.conceptsDir)) {
    for (const entry of fs.readdirSync(content.conceptsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const rec = readOneFile(path.join(content.conceptsDir, entry.name), false, 'root')
        if (rec) records.push(rec)
      }
    }
    if (includeDrafts) {
      const draftsDir = draftsDirOf(content)
      if (fs.existsSync(draftsDir)) {
        for (const entry of fs.readdirSync(draftsDir, { withFileTypes: true })) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            const rec = readOneFile(path.join(draftsDir, entry.name), true, 'root')
            if (rec) records.push(rec)
          }
        }
      }
    }
  }

  // Localized concepts under `<docsRoot>/<loc>/concepts` (if any translated concept pages exist)
  for (const loc of localeKeys) {
    const locConcepts = path.join(content.docsRoot, loc, 'concepts')
    if (!fs.existsSync(locConcepts) || path.resolve(locConcepts) === path.resolve(content.conceptsDir)) continue
    for (const entry of fs.readdirSync(locConcepts, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const rec = readOneFile(path.join(locConcepts, entry.name), false, loc)
        if (rec) records.push(rec)
      }
    }
  }

  return records.sort((a, b) => a.slug.localeCompare(b.slug))
}

function readTitleFromMarkdown(raw: string, fallback: string): string {
  const m = /^title:\s*(.+)$/m.exec(raw)
  if (m?.[1]) {
    const t = m[1].trim().replace(/^["']|["']$/g, '')
    if (t) return t
  }
  const h1 = /^#\s+(.+)$/m.exec(raw)
  if (h1?.[1]) return h1[1].trim()
  return fallback
}

export interface ScanLecturesOptions {
  content?: ContentPaths
  groups: readonly GroupInfo[]
  localeKeys?: readonly string[]
  accessPlan?: AccessPlan
}

export function scanLectureFiles(opts: ScanLecturesOptions): LectureFileEntry[] {
  const content = opts.content ?? resolveContent()
  const plan = opts.accessPlan ?? DEFAULT_PLAN
  const localeKeys = opts.localeKeys ?? []
  const groupByDir = new Map<string, GroupInfo>(opts.groups.map((g) => [g.dir.replace(/^\/+|\/+$/g, ''), g]))
  const scanRoots = [content.lecturesDir]
  const skip = new Set(['node_modules', '.vitepress', 'dist', 'cache', 'concepts', 'public'])

  const seenPaths = new Set<string>()
  const out: LectureFileEntry[] = []

  const addFile = (absPath: string, baseDir: string, localePrefix = ''): void => {
    const relFromBase = normalizePosix(path.relative(baseDir, absPath))
    if (!/(?:^|\/)L\d+\.md$/.test(relFromBase)) return
    const firstDir = relFromBase.split('/')[0] ?? ''
    const group = groupByDir.get(firstDir)
    if (!group) return
    const relDocsPath = localePrefix ? `${localePrefix}/${relFromBase}` : relFromBase
    if (seenPaths.has(relDocsPath)) return
    seenPaths.add(relDocsPath)

    const raw = fs.readFileSync(absPath, 'utf8')
    const baseName = path.basename(absPath, '.md')
    const code = `${group.id}-${baseName}`
    const title = readTitleFromMarkdown(raw, code)
    const tier = tierOfPagePath(relDocsPath, opts.groups, localeKeys, plan)
    out.push({
      absPath,
      relDocsPath,
      urlPath: `/${relDocsPath.replace(/\.md$/, '')}`,
      groupId: group.id,
      tier,
      code,
      title,
      raw,
    })
  }

  for (const base of scanRoots) {
    for (const file of walkMarkdownFiles(base, skip)) {
      addFile(file, base, '')
    }
  }
  for (const loc of localeKeys) {
    const locDir = path.join(content.docsRoot, loc)
    for (const file of walkMarkdownFiles(locDir, skip)) {
      addFile(file, locDir, loc)
    }
  }

  return out.sort((a, b) => a.relDocsPath.localeCompare(b.relDocsPath))
}

export interface ConceptBacklinkRecord extends ConceptRelatedLecture {
  groupId: string
  lectureTier: string
}

export function computeConceptBacklinks(
  lectures: readonly LectureFileEntry[],
): Map<string, ConceptBacklinkRecord[]> {
  const bySlug = new Map<string, Map<string, ConceptBacklinkRecord>>()

  for (const lec of lectures) {
    const hits = findAllConceptLinksInMarkdown(lec.raw)
    if (hits.length === 0) continue
    const counts = new Map<string, number>()
    for (const hit of hits) {
      counts.set(hit.slug, (counts.get(hit.slug) ?? 0) + 1)
    }
    for (const [slug, count] of counts) {
      let map = bySlug.get(slug)
      if (!map) {
        map = new Map()
        bySlug.set(slug, map)
      }
      map.set(lec.urlPath, {
        lecturePath: lec.urlPath,
        code: lec.code,
        title: lec.title,
        count,
        groupId: lec.groupId,
        lectureTier: lec.tier,
      })
    }
  }

  const out = new Map<string, ConceptBacklinkRecord[]>()
  for (const [slug, map] of bySlug) {
    out.set(
      slug,
      [...map.values()].sort((a, b) => a.code.localeCompare(b.code)),
    )
  }
  return out
}

export function buildHoverPayloadsByTier(
  records: readonly ConceptRecord[],
  accessPlan: AccessPlan,
): Map<string, ConceptHoverPayload> {
  const result = new Map<string, ConceptHoverPayload>()
  result.set(accessPlan.inlineTier, { v: 1, tier: accessPlan.inlineTier, items: {} })
  for (const t of accessPlan.tiers) {
    result.set(t.id, { v: 1, tier: t.id, items: {} })
  }

  for (const rec of records) {
    if (rec.isDraft || rec.drop) continue
    // Only root-locale (or keyed by locale? slug is unique per locale; key by slug for root, and `${locale}/${slug}` if localized)
    if (rec.locale !== 'root') continue
    const bucket = result.get(rec.tier)
    if (!bucket) continue
    const entry: ConceptHoverEntry = {
      slug: rec.slug,
      term: rec.meta.term,
      english: rec.meta.english,
      aliases: rec.meta.aliases,
      field: rec.meta.field,
      groups: rec.meta.groups,
      summary: rec.meta.summary,
      status: rec.meta.status,
      url: rec.url,
    }
    bucket.items[rec.slug] = entry
  }

  return result
}

export function buildBacklinkPayloadsByTier(
  backlinks: ReadonlyMap<string, readonly ConceptBacklinkRecord[]>,
  accessPlan: AccessPlan,
): {
  inlineBySlug: Map<string, ConceptRelatedLecture[]>
  restrictedByTier: Map<string, ConceptBacklinkPayload>
} {
  const inlineBySlug = new Map<string, ConceptRelatedLecture[]>()
  const restrictedByTier = new Map<string, ConceptBacklinkPayload>()
  for (const t of accessPlan.tiers) {
    restrictedByTier.set(t.id, { v: 1, tier: t.id, links: {} })
  }

  for (const [slug, list] of backlinks) {
    for (const item of list) {
      const publicEntry: ConceptRelatedLecture = {
        lecturePath: item.lecturePath,
        code: item.code,
        title: item.title,
        count: item.count,
      }
      if (item.lectureTier === accessPlan.inlineTier) {
        const arr = inlineBySlug.get(slug) ?? []
        arr.push(publicEntry)
        inlineBySlug.set(slug, arr)
      } else {
        const payload = restrictedByTier.get(item.lectureTier)
        if (payload) {
          payload.links[slug] = [...(payload.links[slug] ?? []), publicEntry]
        }
      }
    }
  }

  return { inlineBySlug, restrictedByTier }
}

/** Validate every concept link in every lecture against published records and access-tier rules. */
export function validateAllLectureConceptLinks(opts: {
  lectures: readonly LectureFileEntry[]
  records: readonly ConceptRecord[]
}): {
  errors: string[]
  countsBySlug: Map<string, number>
  unknownByLecture: Array<{ lecture: string; slug: string }>
  accessViolations: Array<{ lecture: string; lectureTier: string; slug: string; conceptTier: string }>
} {
  const bySlug = new Map<string, ConceptRecord>()
  for (const r of opts.records) {
    if (!r.isDraft && !r.drop && r.locale === 'root') {
      bySlug.set(r.slug, r)
    }
  }

  const errors: string[] = []
  const countsBySlug = new Map<string, number>()
  const unknownByLecture: Array<{ lecture: string; slug: string }> = []
  const accessViolations: Array<{ lecture: string; lectureTier: string; slug: string; conceptTier: string }> = []

  for (const lec of opts.lectures) {
    const hits = findAllConceptLinksInMarkdown(lec.raw)
    for (const hit of hits) {
      countsBySlug.set(hit.slug, (countsBySlug.get(hit.slug) ?? 0) + 1)
      const concept = bySlug.get(hit.slug)
      if (!concept) {
        unknownByLecture.push({ lecture: lec.relDocsPath, slug: hit.slug })
        errors.push(`[concepts] ${lec.relDocsPath}:${hit.line}: unknown concept link "concept:${hit.slug}"`)
        continue
      }
      if (!canReaderTierReadConcept(lec.tier, concept.tier)) {
        accessViolations.push({
          lecture: lec.relDocsPath,
          lectureTier: lec.tier,
          slug: hit.slug,
          conceptTier: concept.tier,
        })
        errors.push(
          `[concepts] ${lec.relDocsPath}:${hit.line}: tier "${lec.tier}" cannot reference restricted concept "${hit.slug}" (tier "${concept.tier}")`,
        )
      }
    }
  }

  return { errors, countsBySlug, unknownByLecture, accessViolations }
}

/** Published concepts of the root locale that the build keeps: what the checks, the graph and the tool files work on. */
export function publishedConceptRecords(records: readonly ConceptRecord[]): ConceptRecord[] {
  return records.filter((r) => !r.isDraft && !r.drop && r.locale === 'root')
}

/** Published concepts that exist but were left out of this build by the build-group filter. */
export function filteredOutSlugs(records: readonly ConceptRecord[]): Set<string> {
  return new Set(records.filter((r) => !r.isDraft && r.drop && r.locale === 'root').map((r) => r.slug))
}

export function checkedConceptsOf(records: readonly ConceptRecord[]): CheckedConcept[] {
  return publishedConceptRecords(records).map((r) => ({
    slug: r.slug,
    file: r.relDocsPath,
    meta: r.meta,
    raw: r.raw,
    tier: r.tier,
  }))
}

/** Errors (fail the build) and warnings of the concept checks: related, duplicate names, links inside concept pages, unlinked mentions. */
export function runConceptChecks(records: readonly ConceptRecord[]): ConceptCheckResult {
  return checkConcepts(checkedConceptsOf(records), { filteredOut: filteredOutSlugs(records) })
}

/**
 * Lectures of the root language only (concept links of translated copies would count twice), and, when `plan` is given,
 * only those of groups this build keeps (a partial build still scans every group folder).
 */
export function rootLocaleLectures(
  lectures: readonly LectureFileEntry[],
  localeKeys: readonly string[],
  plan?: AccessPlan,
): LectureFileEntry[] {
  return lectures.filter(
    (l) => !localeKeys.some((k) => l.relDocsPath.startsWith(`${k}/`)) && !(plan && plan.removedGroupIds.includes(l.groupId)),
  )
}

/** The concept graph of a build: published concepts plus the lectures that link to them. */
export function buildGraphFromRecords(
  records: readonly ConceptRecord[],
  lectures: readonly LectureFileEntry[],
  extra: readonly ConceptRecord[] = [],
): ConceptGraph {
  const concepts = [...publishedConceptRecords(records), ...extra].map((r) => ({
    slug: r.slug,
    tier: r.tier,
    url: r.url,
    meta: r.meta,
    body: r.body,
  }))
  const citations = new Map<string, LectureCitation[]>()
  for (const [slug, list] of computeConceptBacklinks(lectures)) {
    citations.set(
      slug,
      list.map((b) => ({ route: b.lecturePath, id: b.code, title: b.title, tier: b.lectureTier, count: b.count })),
    )
  }
  return buildConceptGraph(concepts, citations)
}
