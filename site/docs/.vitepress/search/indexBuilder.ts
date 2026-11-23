/**
 * search/indexBuilder.ts - Build-time pruned, locale-split, access-isolated search index builder (WP-F3).
 *
 * Outputs per locale (`root`, `en`, ...):
 *   public:  search/<locale>/{manifest.json, titles.json, shards/<shardId>.sz}
 *   tiers:   _access/<tier>/search/<locale>/{manifest.json, titles.json, shards/<shardId>.sz}
 *
 * Restricted tiers NEVER enter any public manifest, title index, or shard.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { lookupTier, ownerOfPath, tierBasePath, type AccessPlan } from '../access/tiers.ts'
import { conceptPageUrl, resolveConceptTier } from '../concepts/access.ts'
import { isValidConceptSlug, parseConceptMarkdown } from '../concepts/frontmatter.ts'
import {
  SHARDS_TOTAL_MAX_BYTES,
  TITLE_INDEX_MAX_BYTES,
  formatSearchUrl,
  slugifyHeading,
  type CompactHeading,
  type CompactTitlePage,
  type SearchManifestFile,
  type ShardMeta,
  type ShardPayload,
  type TitleIndexFile,
  type TitleIndexGroup,
} from './format.ts'
import { extractSearchablePage } from './markdown.ts'
import { createFigureKindLookup, defaultFiguresDir, resolveFigureXrefsForSearch, type FigureKindLookup } from './figureLabels.ts'

export interface SearchGroupMeta {
  id: string
  dir: string
  title: string
  catSlot?: number
}

export interface BuildSearchOptions {
  docsRoot: string
  allGroups: readonly SearchGroupMeta[]
  localeKeys: readonly string[]
  conceptsDir?: string
  base?: string
  cleanUrls?: boolean
  excludes?: readonly string[]
  accessPlan?: AccessPlan
  localizedGroupTitles?: Readonly<Record<string, Readonly<Record<string, string>>>>
  maxTitleBytes?: number
  maxShardBytes?: number
  /**
   * Figure-pack registries, to number `[](fig:id)` / `[](tab:id)` like the page does (search/figureLabels.ts). Defaults to
   * the content's figures directory (`resolveContent().figuresDir`); `figureKindOf` overrides the lookup (tests).
   */
  figuresDir?: string
  figureKindOf?: FigureKindLookup
}

export interface LocaleSearchStats {
  locale: string
  titleBytes: number
  shardBytes: number
  rawShardBytes: number
  pageCount: number
  sectionCount: number
  shardCount: number
}

export interface SearchBuildResult {
  /** Relative path from dist/ -> Buffer | string */
  artifacts: Map<string, Buffer | string>
  statsByLocale: Record<string, LocaleSearchStats>
  rootStats: LocaleSearchStats
}

export class SearchBudgetError extends Error {
  override name = 'SearchBudgetError'
}

const CJK_CHAR_RE = /[㐀-鿿]/

function walkMarkdown(root: string, dir: string = root, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.vitepress' || entry.name === 'public' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkMarkdown(root, full, out)
    } else if (entry.name.endsWith('.md')) {
      const rel = path.relative(root, full).replace(/\\/g, '/')
      // Skip dynamic VitePress route templates like `en/[group]/index.md`
      if (rel.includes('[') && rel.includes(']')) continue
      out.push(rel)
    }
  }
  return out
}

function isExcluded(relPath: string, patterns: readonly string[]): boolean {
  const clean = relPath.replace(/^\/+/, '')
  for (const pat of patterns) {
    const p = pat.replace(/^\/+/, '')
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -2)
      if (clean.startsWith(prefix)) return true
    } else if (clean === p) {
      return true
    }
  }
  return false
}

function localeOfRelPath(relPath: string, localeKeys: readonly string[]): string {
  const clean = relPath.replace(/^\/+/, '')
  return localeKeys.find((k) => clean.startsWith(`${k}/`)) ?? 'root'
}

function parseLectureCode(
  pathWithoutLocale: string,
  groupId: string,
): { lectureNo: number | null; code: string } {
  const m = /(?:^|\/)L(\d+)\.md$/i.exec(pathWithoutLocale)
  if (m && m[1] !== undefined) {
    const lectureNo = Number.parseInt(m[1], 10)
    const pad = m[1].padStart(2, '0')
    const code = `${groupId}-L${pad}`
    return { lectureNo, code }
  }
  return { lectureNo: null, code: groupId === 'SITE' ? '' : groupId }
}

interface BuiltBucketPage {
  groupId: string
  shardId: string
  groupMeta: TitleIndexGroup
  lectureNo: number | null
  code: string
  url: string
  title: string
  headings: CompactHeading[]
  aliases?: string[]
  conceptGroups?: string[]
  sections: Array<{ anchor: string; path: string[]; text: string }>
}

interface BucketAccumulator {
  groupOrder: readonly string[]
  pages: BuiltBucketPage[]
}

function safeGroupTitleForLocale(
  meta: SearchGroupMeta,
  locale: string,
  localizedGroupTitles?: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string {
  const translated = localizedGroupTitles?.[locale]?.[meta.id]
  if (translated) return translated
  if (locale !== 'root' && CJK_CHAR_RE.test(meta.title)) return meta.id
  return meta.title
}

function emitBucket(
  bucket: BucketAccumulator,
  locale: string,
  prefix: string,
  artifacts: Map<string, Buffer | string>,
): LocaleSearchStats {
  const orderMap = new Map<string, number>()
  bucket.groupOrder.forEach((id, i) => orderMap.set(id, i))

  const groups: TitleIndexGroup[] = []
  const groupIdxById = new Map<string, number>()
  const pagesSorted = [...bucket.pages].sort((a, b) => {
    const ga = orderMap.get(a.groupId) ?? 999
    const gb = orderMap.get(b.groupId) ?? 999
    if (ga !== gb) return ga - gb
    const la = a.lectureNo ?? -1
    const lb = b.lectureNo ?? -1
    if (la !== lb) return la - lb
    return a.url < b.url ? -1 : a.url > b.url ? 1 : 0
  })

  for (const p of pagesSorted) {
    if (!groupIdxById.has(p.groupId)) {
      groupIdxById.set(p.groupId, groups.length)
      groups.push(p.groupMeta)
    }
  }

  const compactPages: CompactTitlePage[] = pagesSorted.map((p) => {
    const hasAliases = (p.aliases?.length ?? 0) > 0
    const hasConceptGroups = (p.conceptGroups?.length ?? 0) > 0
    if (hasAliases || hasConceptGroups) {
      return [
        groupIdxById.get(p.groupId) ?? 0,
        p.lectureNo,
        p.code,
        p.url,
        p.title,
        p.headings,
        p.aliases ?? [],
        p.conceptGroups ?? [],
      ]
    }
    return [
      groupIdxById.get(p.groupId) ?? 0,
      p.lectureNo,
      p.code,
      p.url,
      p.title,
      p.headings,
    ]
  })

  const titlePayload: TitleIndexFile = {
    v: 1,
    locale,
    groups,
    pages: compactPages,
  }
  const titleJson = JSON.stringify(titlePayload)
  const titleBuf = Buffer.from(titleJson, 'utf8')
  artifacts.set(`${prefix}/titles.json`, titleBuf)

  // Build per-group compressed shards
  const pagesByShard = new Map<string, BuiltBucketPage[]>()
  for (const p of pagesSorted) {
    const list = pagesByShard.get(p.shardId)
    if (list) list.push(p)
    else pagesByShard.set(p.shardId, [p])
  }

  const shards: ShardMeta[] = []
  let totalShardBytes = 0
  let totalRawShardBytes = 0
  let totalSections = 0

  for (const [shardId, shardPages] of pagesByShard) {
    const groupId = shardPages[0]?.groupId ?? shardId.toUpperCase()
    const urls = shardPages.map((p) => p.url)
    const sections: ShardPayload['sections'] = []
    shardPages.forEach((p, pageIdx) => {
      for (const sec of p.sections) {
        sections.push([pageIdx, sec.anchor, sec.path, sec.text])
      }
    })
    totalSections += sections.length
    const shardPayload: ShardPayload = {
      v: 1,
      shardId,
      groupId,
      pages: urls,
      sections,
    }
    const rawBuf = Buffer.from(JSON.stringify(shardPayload), 'utf8')
    const compressedBuf = zlib.deflateRawSync(rawBuf, { level: 9 })
    const relShardUrl = `shards/${shardId}.sz`
    artifacts.set(`${prefix}/${relShardUrl}`, compressedBuf)
    totalShardBytes += compressedBuf.byteLength
    totalRawShardBytes += rawBuf.byteLength
    shards.push({
      shardId,
      groupId,
      url: relShardUrl,
      bytes: compressedBuf.byteLength,
      rawBytes: rawBuf.byteLength,
      pageCount: urls.length,
    })
  }

  const manifest: SearchManifestFile = {
    v: 1,
    locale,
    titleFile: 'titles.json',
    titleBytes: titleBuf.byteLength,
    totalShardBytes,
    totalRawShardBytes,
    shards,
  }
  artifacts.set(`${prefix}/manifest.json`, Buffer.from(JSON.stringify(manifest), 'utf8'))

  return {
    locale,
    titleBytes: titleBuf.byteLength,
    shardBytes: totalShardBytes,
    rawShardBytes: totalRawShardBytes,
    pageCount: pagesSorted.length,
    sectionCount: totalSections,
    shardCount: shards.length,
  }
}

/** Build the split, pruned, access-isolated search artifacts in memory and assert root budgets. */
export function buildSearchArtifacts(opts: BuildSearchOptions): SearchBuildResult {
  const base = opts.base ?? '/'
  const cleanUrls = opts.cleanUrls ?? true
  const excludes = opts.excludes ?? []
  const maxTitleBytes = opts.maxTitleBytes ?? TITLE_INDEX_MAX_BYTES
  const maxShardBytes = opts.maxShardBytes ?? SHARDS_TOTAL_MAX_BYTES
  const groupOrder = [...opts.allGroups.map((g) => g.id), 'CONCEPTS', 'SITE']
  const groupById = new Map(opts.allGroups.map((g) => [g.id, g]))
  const builtGroupIds = new Set(opts.allGroups.map((g) => g.id))
  const locales = ['root', ...opts.localeKeys]

  const allFiles = walkMarkdown(opts.docsRoot).sort()
  // Also include published root concepts when `conceptsDir` lives outside `docsRoot` (e.g. content mode without pre-sync).
  const indexedConceptSlugs = new Set<string>()
  // tierKey (`public` or tierId) -> locale -> BuiltBucketPage[]
  const buckets = new Map<string, Map<string, BuiltBucketPage[]>>()
  const ensureList = (bucketKey: string, locale: string): BuiltBucketPage[] => {
    let byLoc = buckets.get(bucketKey)
    if (!byLoc) {
      byLoc = new Map()
      buckets.set(bucketKey, byLoc)
    }
    let list = byLoc.get(locale)
    if (!list) {
      list = []
      byLoc.set(locale, list)
    }
    return list
  }

  const inlineTier = opts.accessPlan?.inlineTier ?? 'public'
  const figureKindOf = opts.figureKindOf ?? createFigureKindLookup(opts.figuresDir ?? defaultFiguresDir())
  const withFigureLabels = (md: string, relPath: string, locale: string, pageGroup: string | null): string =>
    resolveFigureXrefsForSearch(md, { relPath, pageGroup, localeKey: locale === 'root' ? '' : locale, kindOf: figureKindOf })

  for (const relPath of allFiles) {
    if (isExcluded(relPath, excludes)) continue
    const locale = localeOfRelPath(relPath, opts.localeKeys)
    const pathNoLocale = locale === 'root' ? relPath : relPath.slice(locale.length + 1)

    const owner = ownerOfPath(relPath, opts.allGroups, opts.localeKeys)
    let bucketKey = inlineTier
    let groupId: string
    let shardId: string
    let groupMeta: TitleIndexGroup

    if (owner) {
      const tier = opts.accessPlan ? lookupTier(opts.accessPlan, owner.groupId) : inlineTier
      if (tier === null) continue // omitted by buildGroups / removedGroupIds
      bucketKey = tier
      groupId = owner.groupId
      shardId = owner.dir.replace(/\//g, '_')
      const rawMeta = groupById.get(owner.groupId) ?? { id: owner.groupId, dir: owner.dir, title: owner.groupId, catSlot: 1 }
      groupMeta = {
        id: groupId,
        dir: owner.dir,
        title: safeGroupTitleForLocale(rawMeta, locale, opts.localizedGroupTitles),
        catSlot: rawMeta.catSlot ?? 1,
      }
    } else if (pathNoLocale.startsWith('concepts/')) {
      // Drafts (`concepts/_drafts/**`) are NEVER indexed into search artifacts.
      if (pathNoLocale.startsWith('concepts/_drafts/') || !/^concepts\/[^/]+\.md$/.test(pathNoLocale)) {
        continue
      }
      const slug = path.basename(pathNoLocale, '.md')
      if (!isValidConceptSlug(slug)) continue
      const md = fs.readFileSync(path.join(opts.docsRoot, relPath), 'utf8')
      const parsed = parseConceptMarkdown(md, slug)
      if (parsed.meta.status === 'draft') continue
      if (opts.accessPlan) {
        const res = resolveConceptTier(parsed.meta.groups, opts.accessPlan, builtGroupIds)
        if (res.drop) continue
        bucketKey = res.tier
      } else {
        bucketKey = inlineTier
      }
      if (locale === 'root') indexedConceptSlugs.add(slug)
      const conceptPath = conceptPageUrl(slug, bucketKey, inlineTier, false)
      const relOutPath = `${locale === 'root' ? '' : `${locale}/`}${conceptPath.replace(/^\/+/, '')}.md`
      const conceptLabel = safeGroupTitleForLocale(
        { id: 'CONCEPTS', dir: 'concepts', title: '概念' },
        locale,
        opts.localizedGroupTitles,
      )
      const extracted = extractSearchablePage(parsed.body, parsed.meta.term || slug)
      if (extracted.skipped) continue
      const headings: CompactHeading[] = extracted.headings.map((h) =>
        h.slug === slugifyHeading(h.text) ? [h.level, h.text] : [h.level, h.text, h.slug],
      )
      ensureList(bucketKey, locale).push({
        groupId: 'CONCEPTS',
        shardId: 'concepts',
        groupMeta: { id: 'CONCEPTS', dir: 'concepts', title: conceptLabel, catSlot: 0 },
        lectureNo: null,
        code: 'CONCEPT',
        url: formatSearchUrl(base, relOutPath, cleanUrls),
        title: parsed.meta.term || extracted.title,
        headings,
        aliases: parsed.meta.aliases,
        conceptGroups: parsed.meta.groups,
        sections: extracted.sections,
      })
      continue
    } else {
      groupId = 'SITE'
      shardId = 'site'
      groupMeta = { id: 'SITE', dir: '', title: 'Site', catSlot: 2 }
    }

    const md = withFigureLabels(fs.readFileSync(path.join(opts.docsRoot, relPath), 'utf8'), relPath, locale, owner?.dir ?? null)
    const { lectureNo, code } = parseLectureCode(pathNoLocale, groupId)
    const fallbackTitle = code || pathNoLocale.replace(/\.md$/, '')
    const extracted = extractSearchablePage(md, fallbackTitle)
    if (extracted.skipped) continue

    const headings: CompactHeading[] = extracted.headings.map((h) =>
      h.slug === slugifyHeading(h.text) ? [h.level, h.text] : [h.level, h.text, h.slug],
    )

    ensureList(bucketKey, locale).push({
      groupId,
      shardId,
      groupMeta,
      lectureNo,
      code,
      url: formatSearchUrl(base, relPath, cleanUrls),
      title: extracted.title,
      headings,
      sections: extracted.sections,
    })
  }

  if (opts.conceptsDir && fs.existsSync(opts.conceptsDir)) {
    for (const entry of fs.readdirSync(opts.conceptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const slug = path.basename(entry.name, '.md')
      if (!isValidConceptSlug(slug) || indexedConceptSlugs.has(slug)) continue
      const md = fs.readFileSync(path.join(opts.conceptsDir, entry.name), 'utf8')
      const parsed = parseConceptMarkdown(md, slug)
      if (parsed.meta.status === 'draft') continue
      let bucketKey = inlineTier
      if (opts.accessPlan) {
        const res = resolveConceptTier(parsed.meta.groups, opts.accessPlan, builtGroupIds)
        if (res.drop) continue
        bucketKey = res.tier
      }
      const conceptPath = conceptPageUrl(slug, bucketKey, inlineTier, false)
      const relOutPath = `${conceptPath.replace(/^\/+/, '')}.md`
      const conceptLabel = safeGroupTitleForLocale(
        { id: 'CONCEPTS', dir: 'concepts', title: '概念' },
        'root',
        opts.localizedGroupTitles,
      )
      const extracted = extractSearchablePage(parsed.body, parsed.meta.term || slug)
      if (extracted.skipped) continue
      const headings: CompactHeading[] = extracted.headings.map((h) =>
        h.slug === slugifyHeading(h.text) ? [h.level, h.text] : [h.level, h.text, h.slug],
      )
      ensureList(bucketKey, 'root').push({
        groupId: 'CONCEPTS',
        shardId: 'concepts',
        groupMeta: { id: 'CONCEPTS', dir: 'concepts', title: conceptLabel, catSlot: 0 },
        lectureNo: null,
        code: 'CONCEPT',
        url: formatSearchUrl(base, relOutPath, cleanUrls),
        title: parsed.meta.term || extracted.title,
        headings,
        aliases: parsed.meta.aliases,
        conceptGroups: parsed.meta.groups,
        sections: extracted.sections,
      })
    }
  }

  const artifacts = new Map<string, Buffer | string>()
  const statsByLocale: Record<string, LocaleSearchStats> = {}

  for (const locale of locales) {
    const pages = buckets.get(inlineTier)?.get(locale) ?? []
    statsByLocale[locale] = emitBucket({ groupOrder, pages }, locale, `search/${locale}`, artifacts)
  }

  // Restricted tiers: write ONLY into `_access/<tier>/search/<locale>/...`
  for (const tierInfo of opts.accessPlan?.tiers ?? []) {
    const tierId = tierInfo.id
    for (const locale of locales) {
      const pages = buckets.get(tierId)?.get(locale) ?? []
      const tierPrefix = `${tierBasePath(tierId).slice(1)}/search/${locale}`
      emitBucket({ groupOrder, pages }, locale, tierPrefix, artifacts)
    }
  }

  const rootStats = statsByLocale.root ?? {
    locale: 'root',
    titleBytes: 0,
    shardBytes: 0,
    rawShardBytes: 0,
    pageCount: 0,
    sectionCount: 0,
    shardCount: 0,
  }

  if (rootStats.titleBytes > maxTitleBytes) {
    throw new SearchBudgetError(
      `Root title index exceeds budget: ${rootStats.titleBytes} bytes > limit ${maxTitleBytes} bytes`,
    )
  }
  if (rootStats.shardBytes > maxShardBytes) {
    throw new SearchBudgetError(
      `Root body shards total exceeds budget: ${rootStats.shardBytes} bytes > limit ${maxShardBytes} bytes`,
    )
  }

  return { artifacts, statsByLocale, rootStats }
}

/** Write all generated public & restricted search artifacts under `outDir`. */
export function writeSearchArtifacts(outDir: string, result: SearchBuildResult): void {
  const rootResolved = path.resolve(outDir)
  for (const [rel, body] of result.artifacts) {
    const dest = path.resolve(rootResolved, rel)
    const check = path.relative(rootResolved, dest)
    if (!check || check.startsWith('..') || path.isAbsolute(check)) {
      throw new Error(`Refusing to write outside outDir: ${rel}`)
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, body)
  }
}
