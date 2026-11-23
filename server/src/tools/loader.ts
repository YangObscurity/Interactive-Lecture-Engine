import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type {
  CallerIdentity,
  ConceptRecord,
  ConceptsFile,
  LectureRecord,
  LecturesFile,
  TierEntry,
  TiersFile,
} from './types.js'

const TOOLS_DIR = fileURLToPath(new URL('.', import.meta.url))
const DEFAULT_SERVER_ROOT = resolve(TOOLS_DIR, '../..')

// No tools/tiers.json means no tier at all (fail closed): on a private site the inline files under tools/ belong to the
// "authenticated" tier, so guessing "tools/ is public" would hand them to callers without a session or ticket.
const EMPTY_TIERS_FILE: TiersFile = {
  version: 1,
  tiers: [],
}

const conceptRelatedSchema = z.object({
  slug: z.string().min(1),
  rel: z.string().min(1),
})

const conceptLectureRefSchema = z.object({
  route: z.string().min(1),
  id: z.string().min(1),
  title: z.string(),
  count: z.number().int().nonnegative().default(1),
})

const conceptRecordSchema = z.object({
  slug: z.string().min(1),
  term: z.string().min(1),
  english: z.string().default(''),
  aliases: z.array(z.string()).default([]),
  field: z.string().default(''),
  groups: z.array(z.string()).default([]),
  summary: z.string().default(''),
  url: z.string().default(''),
  related: z.array(conceptRelatedSchema).default([]),
  links: z.array(z.string()).default([]),
  backlinks: z.array(z.string()).default([]),
  lectures: z.array(conceptLectureRefSchema).default([]),
  markdown: z.string().default(''),
})

const conceptsFileSchema = z.object({
  version: z.literal(1),
  tier: z.string().min(1),
  generatedAt: z.string().optional(),
  concepts: z.array(conceptRecordSchema),
})

const lectureSectionSchema = z.object({
  heading: z.string(),
  anchor: z.string(),
  text: z.string(),
})

const lectureRecordSchema = z.object({
  route: z.string().min(1),
  id: z.string().min(1),
  group: z.string().default(''),
  title: z.string(),
  sections: z.array(lectureSectionSchema),
})

const lecturesFileSchema = z.object({
  version: z.literal(1),
  tier: z.string().min(1),
  lectures: z.array(lectureRecordSchema),
})

const tierEntrySchema = z.object({
  id: z.string().min(1),
  read: z.enum(['public', 'authenticated', 'groups']),
  groups: z.array(z.string()).default([]),
  path: z.string().default(''),
})

const tiersFileSchema = z.object({
  version: z.literal(1),
  tiers: z.array(tierEntrySchema),
})

export function resolveSiteDistDir(
  configuredDir: string | null | undefined,
  options?: { serverRoot?: string; cwd?: string },
): string {
  const serverRoot = options?.serverRoot ?? DEFAULT_SERVER_ROOT
  const cwd = options?.cwd ?? process.cwd()
  const raw = typeof configuredDir === 'string' ? configuredDir.trim() : ''

  if (raw) {
    if (isAbsolute(raw)) return raw
    const fromCwd = resolve(cwd, raw)
    if (existsSync(fromCwd)) return fromCwd
    const fromServer = resolve(serverRoot, raw)
    if (existsSync(fromServer)) return fromServer
    const fromRepo = resolve(serverRoot, '..', raw)
    if (existsSync(fromRepo)) return fromRepo
    return fromCwd
  }

  return resolve(serverRoot, '../site/docs/.vitepress/dist')
}

export function tierToolsDir(distDir: string, tier: TierEntry): string {
  const cleaned = tier.path.trim().replace(/^\/+|\/+$/g, '')
  let dir: string
  if (cleaned === '') {
    dir = tier.id === 'public' ? resolve(distDir, 'tools') : resolve(distDir, '_access', tier.id, 'tools')
  } else if (cleaned === 'tools' || cleaned.endsWith('/tools')) {
    dir = resolve(distDir, cleaned)
  } else {
    dir = resolve(distDir, cleaned, 'tools')
  }
  // a tier path never leaves the site output
  const root = resolve(distDir)
  const rel = relative(root, dir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`tool tier ${JSON.stringify(tier.id)}: path ${JSON.stringify(tier.path)} is outside the site output`)
  }
  return dir
}

export function resolveReadableTiers(
  identity: CallerIdentity | null | undefined,
  tiersFile: TiersFile,
): string[] {
  const out = new Set<string>()
  const isAuthenticated = Boolean(identity?.authenticated)
  const callerGroups = new Set((identity?.groups ?? []).map((g) => g.trim()).filter(Boolean))

  let hasPublic = false
  for (const tier of tiersFile.tiers) {
    if (tier.read === 'public') {
      hasPublic = true
      out.add(tier.id)
      continue
    }
    if (!isAuthenticated) continue
    if (tier.read === 'authenticated') {
      out.add(tier.id)
      continue
    }
    if (tier.read === 'groups') {
      if (tier.groups.some((g) => callerGroups.has(g))) {
        out.add(tier.id)
      }
    }
  }

  if (!hasPublic) {
    out.add('public')
  }
  return [...out]
}

interface CachedFile<T> {
  mtimeMs: number
  size: number
  value: T
}

export class ToolDataStore {
  private readonly distDir: string
  private tiersCache: CachedFile<TiersFile> | null = null
  private readonly conceptsCache = new Map<string, CachedFile<ConceptsFile>>()
  private readonly lecturesCache = new Map<string, CachedFile<LecturesFile>>()

  constructor(configuredDistDir: string | null | undefined, options?: { serverRoot?: string; cwd?: string }) {
    this.distDir = resolveSiteDistDir(configuredDistDir, options)
  }

  getDistDir(): string {
    return this.distDir
  }

  loadTiers(): TiersFile {
    const filePath = resolve(this.distDir, 'tools/tiers.json')
    if (!existsSync(filePath)) {
      this.tiersCache = null
      return EMPTY_TIERS_FILE
    }
    const stat = statSync(filePath)
    if (this.tiersCache && this.tiersCache.mtimeMs === stat.mtimeMs && this.tiersCache.size === stat.size) {
      return this.tiersCache.value
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    const value = tiersFileSchema.parse(raw)
    this.tiersCache = { mtimeMs: stat.mtimeMs, size: stat.size, value }
    return value
  }

  loadConceptsForTier(tier: TierEntry): ConceptRecord[] {
    const filePath = resolve(tierToolsDir(this.distDir, tier), 'concepts.json')
    if (!existsSync(filePath)) {
      this.conceptsCache.delete(filePath)
      return []
    }
    const stat = statSync(filePath)
    const cached = this.conceptsCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value.tier === tier.id ? cached.value.concepts : []
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    const value = conceptsFileSchema.parse(raw)
    this.conceptsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    // a file that names another tier is not served for this one (a misplaced or stale build output)
    return value.tier === tier.id ? value.concepts : []
  }

  loadLecturesForTier(tier: TierEntry): LectureRecord[] {
    const filePath = resolve(tierToolsDir(this.distDir, tier), 'lectures.json')
    if (!existsSync(filePath)) {
      this.lecturesCache.delete(filePath)
      return []
    }
    const stat = statSync(filePath)
    const cached = this.lecturesCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.value.tier === tier.id ? cached.value.lectures : []
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown
    const value = lecturesFileSchema.parse(raw)
    this.lecturesCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value.tier === tier.id ? value.lectures : []
  }

  /** Load merged concepts and lectures strictly from the caller's allowed tiers. */
  loadVisibleData(readableTierIds: readonly string[]): {
    concepts: Map<string, ConceptRecord>
    lectures: Map<string, LectureRecord>
  } {
    const tiersFile = this.loadTiers()
    const allowedSet = new Set(readableTierIds)
    // only tiers that tools/tiers.json declares; "public" reads nothing on a site without a public tier
    const tierEntries = tiersFile.tiers.filter((t) => allowedSet.has(t.id))

    const concepts = new Map<string, ConceptRecord>()
    const lectures = new Map<string, LectureRecord>()

    for (const tier of tierEntries) {
      for (const concept of this.loadConceptsForTier(tier)) {
        concepts.set(concept.slug, concept)
      }
      for (const lecture of this.loadLecturesForTier(tier)) {
        lectures.set(lecture.route, lecture)
      }
    }

    return { concepts, lectures }
  }
}
