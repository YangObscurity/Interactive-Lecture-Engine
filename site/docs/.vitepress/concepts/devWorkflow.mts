/**
 * concepts/devWorkflow.mts - Dev-only Author Mode backend workflows for Concept Pages (WP-F9).
 *
 * Handles:
 *   - Reading §7.3.3 lecture context directly from `paths.mts` directories
 *   - Running AI feature contract `concept-draft` with Ajv validation & retry-once guarantee
 *   - Reading/writing/discarding drafts under `<conceptsDir>/_drafts/` (with `.ctx.json` sidecar)
 *   - Previewing source diffs (`mdast-util-from-markdown` + `unist-util-visit` + `diff`)
 *   - Confirming drafts -> published concepts (`reviewedAt`) + lecture source rewrite
 *   - Delete impact preview & confirmed unlinking (`[text](concept:slug)` -> `text`)
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import { resolveGroups } from '../groups-source.mts'
import { resolveContent, type ContentPaths } from '../content/paths.mts'
import { loadLectureConfig } from '../content/config.mts'
import { resolveAccess } from '../access/tiers.ts'
import { loadAndValidateSitePrompts } from '../prompts/load.mts'
import { normalizePromptLang } from '../prompts/companion.ts'
import { loadAiContract } from '../prompts/loadContract.mts'
import {
  CONTRACT_INVALID_MESSAGE_EN,
  CONTRACT_INVALID_MESSAGE_ZH,
  runAiContract,
  validateContractOutput,
  type ContractModelRequest,
} from '../prompts/contracts.ts'
import { LANG_CODES, localeKeyOf } from '../i18n/langs.ts'
import {
  draftPayloadToConceptMarkdown,
  hasUnverifiedMarkers,
  isValidConceptSlug,
  parseConceptMarkdown,
  serializeConceptMarkdown,
  slugifyConcept,
  type ConceptDraftPayload,
  type ConceptHoverEntry,
  type ConceptHoverPayload,
} from './frontmatter.ts'
import {
  computeConceptBacklinks,
  draftsDirOf,
  filteredOutSlugs,
  loadConceptRecords,
  publishedConceptRecords,
  rootLocaleLectures,
  scanLectureFiles,
  type ConceptBacklinkRecord,
  type ConceptRecord,
  type LectureFileEntry,
} from './node.mts'
import { resolveConceptTier } from './access.ts'
import {
  checkConceptPageLinks,
  checkDuplicateNames,
  checkRelated,
  checkUnlinkedMentions,
  conceptNamesOf,
  type CheckedConcept,
} from './graph.ts'
import { NAME_NOISE, normalizeConceptName } from './names.ts'
import {
  createAnchorParser,
  splitLectureSections,
  type LectureSection,
  type MarkdownParser,
} from './lectureSections.mts'
import { atomicWriteFile, safeRemoveFile } from './safeWrite.mts'
import {
  buildMountConceptDiff,
  findConceptLinksInMarkdown,
  locateOccurrencesInLecture,
  unlinkConceptInMarkdown,
  type OccurrenceCandidate,
} from './sourceRewriter.ts'

export interface ConceptDashboardItem {
  slug: string
  term: string
  english: string
  aliases: string[]
  field: string
  groups: string[]
  summary: string
  status: 'draft' | 'published'
  isRevision?: boolean
  hasDraftRevision?: boolean
  generatedBy: string
  reviewedAt: string
  selectionSource?: string
  previewUrl: string
  occurrenceCount: number
  lectures: Array<{ lecturePath: string; code: string; title: string; count: number }>
  hasUnverified: boolean
  unverifiedLines: string[]
  sourcesCount: number
  body: string
  raw: string
  hasSelectionContext: boolean
}

export interface StoredSelectionContext {
  lecturePath: string
  selectedText: string
  sectionHeading?: string
  beforeContext?: string
  afterContext?: string
}

export interface ByokModelSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export function resolveConceptContentPaths(overrides?: { docsRoot?: string; conceptsDir?: string }): ContentPaths {
  const base = resolveContent()
  const resolvedDocs = overrides?.docsRoot ? path.resolve(overrides.docsRoot) : base.docsRoot
  const isCustomDocs = Boolean(overrides?.docsRoot) && resolvedDocs !== path.resolve(base.docsRoot)
  return {
    ...base,
    docsRoot: resolvedDocs,
    lecturesDir: isCustomDocs ? resolvedDocs : base.lecturesDir,
    conceptsDir: overrides?.conceptsDir
      ? path.resolve(overrides.conceptsDir)
      : isCustomDocs
        ? path.join(resolvedDocs, 'concepts')
        : base.conceptsDir,
  }
}

/** Every write of this module stays inside these folders (checked by real path, symlinks refused). */
function writeRoots(content: ContentPaths): string[] {
  return [content.conceptsDir, content.docsRoot, content.lecturesDir]
}

function digestOf(...parts: string[]): string {
  const h = createHash('sha256')
  for (const p of parts) h.update(p).update('|')
  return h.digest('hex').slice(0, 32)
}

function draftsCtxPath(content: ContentPaths, slug: string): string {
  return path.join(draftsDirOf(content), `${slug}.ctx.json`)
}

function draftMdPath(content: ContentPaths, slug: string): string {
  return path.join(draftsDirOf(content), `${slug}.md`)
}

function publishedMdPath(content: ContentPaths, slug: string): string {
  return path.join(content.conceptsDir, `${slug}.md`)
}

function assertSafeSlug(slugRaw: unknown): string {
  const slug = typeof slugRaw === 'string' ? slugRaw.trim() : ''
  if (!isValidConceptSlug(slug)) {
    throw new Error(`Invalid concept slug: ${JSON.stringify(slugRaw)}`)
  }
  return slug
}

function readSelectionContextSidecar(content: ContentPaths, slug: string): StoredSelectionContext | null {
  const p = draftsCtxPath(content, slug)
  if (!fs.existsSync(p)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<StoredSelectionContext>
    if (typeof parsed.lecturePath === 'string' && typeof parsed.selectedText === 'string') {
      return {
        lecturePath: parsed.lecturePath,
        selectedText: parsed.selectedText,
        sectionHeading: typeof parsed.sectionHeading === 'string' ? parsed.sectionHeading : undefined,
        beforeContext: typeof parsed.beforeContext === 'string' ? parsed.beforeContext : undefined,
        afterContext: typeof parsed.afterContext === 'string' ? parsed.afterContext : undefined,
      }
    }
  } catch {
    // ignore corrupt sidecar
  }
  return null
}

function writeSelectionContextSidecar(content: ContentPaths, slug: string, ctx: StoredSelectionContext): void {
  atomicWriteFile(draftsCtxPath(content, slug), JSON.stringify(ctx, null, 2), writeRoots(content))
}

function cleanSelectionContextSidecar(content: ContentPaths, slug: string): void {
  safeRemoveFile(draftsCtxPath(content, slug), writeRoots(content))
}

/** Keep mirrored published file in `docsRoot/concepts/` fresh when `conceptsDir !== docsRoot/concepts`. */
function syncMirroredPublishedFile(content: ContentPaths, slug: string, markdown: string | null): void {
  const docsConcepts = path.join(content.docsRoot, 'concepts')
  if (path.resolve(docsConcepts) === path.resolve(content.conceptsDir)) return
  const dest = path.join(docsConcepts, `${slug}.md`)
  if (markdown === null) {
    safeRemoveFile(dest, writeRoots(content))
    return
  }
  atomicWriteFile(dest, markdown, writeRoots(content))
}

/**
 * Content mode keeps the concepts outside `site/docs`: the draft preview page needs a copy under `<docsRoot>/concepts/_drafts/`
 * (`content:sync --drafts` mounts the existing ones; this keeps new, edited and removed drafts in step). No-op in place.
 */
function syncMirroredDraftFile(content: ContentPaths, slug: string, markdown: string | null): void {
  const docsDrafts = path.join(content.docsRoot, 'concepts', '_drafts')
  if (path.resolve(docsDrafts) === path.resolve(draftsDirOf(content))) return
  const dest = path.join(docsDrafts, `${slug}.md`)
  if (markdown === null) safeRemoveFile(dest, writeRoots(content))
  else atomicWriteFile(dest, markdown, writeRoots(content))
}

function validatePublishedConceptContracts(raw: string): string[] {
  const errors: string[] = []
  const parsed = parseConceptMarkdown(raw)
  if (!parsed.meta.term) errors.push('Concept frontmatter missing term')
  if (!parsed.meta.english) errors.push('Concept frontmatter missing english')
  if (!parsed.meta.field) errors.push('Concept frontmatter missing field')
  if (!parsed.meta.summary) errors.push('Concept frontmatter missing summary')
  if (parsed.meta.groups.length === 0) errors.push('Concept frontmatter missing groups')

  const unverified = hasUnverifiedMarkers(raw)
  if (unverified.hasUnverified) {
    errors.push('概念页仍包含「待核实」内容，核实并消除后才可确认发布')
  }
  if (/<a\s[^>]*href=["']https?:\/\//i.test(raw) || /\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(parsed.body)) {
    errors.push('禁止裸外链或 Markdown 外部链接，请改用 .cite 胶囊')
  }
  if (raw.includes('[[concept:')) {
    errors.push('禁止旧语法 [[concept:...]]')
  }
  if (/```math\b/i.test(parsed.body)) {
    errors.push('禁止 ```math 代码围栏，请使用 LaTeX 定界符')
  }

  // Balanced ** check per line outside code fences/inline code/math
  const lines = parsed.body.split(/\r?\n/)
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i] ?? ''
    if (/^```/.test(ln.trim())) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const stripped = ln
      .replace(/`[^`]+`/g, ' ')
      .replace(/\\\([^)]*\\\)/g, ' ')
      .replace(/\$\$[^$]*\$\$/g, ' ')
    const pairs = stripped.match(/(?<!\\)\*\*/g) ?? []
    if (pairs.length % 2 !== 0) {
      errors.push(`第 ${i + 1} 行粗体 ** 未成对闭合`)
    }
  }

  // Every substantive ## section must carry a source citation
  const sections = parsed.body.split(/^##\s+/m)
  for (let i = 0; i < sections.length; i++) {
    const sec = (sections[i] ?? '').trim()
    if (!sec) continue
    const secLines = sec
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    const bodyLines = i === 0 ? secLines.filter((l) => !l.startsWith('# ')) : secLines.slice(1)
    const proseLines = bodyLines.filter(
      (l) => !l.startsWith('>') && !/^[（(](?:出处|来源)[：:]/.test(l) && !l.startsWith('|'),
    )
    if (proseLines.length === 0) continue
    const hasCite = /class=["']cite["']/.test(sec) || /[（(](?:出处|来源)\s*[：:]/.test(sec)
    if (!hasCite) {
      errors.push(`第 ${i + 1} 节缺少来源出处标注`)
    }
  }

  return errors
}

async function resolveContextDeps(
  content: ContentPaths,
  opts?: { includeBacklinks?: boolean; skipLectures?: boolean },
) {
  const { GROUPS } = await resolveGroups()
  const cfg = loadLectureConfig({ paths: content })
  const localeKeys = LANG_CODES.slice(1).map((l) => localeKeyOf(l))
  const accessPlan = resolveAccess({ access: cfg.access, groupIds: GROUPS.map((g) => g.id) })
  const builtGroupIds = new Set(GROUPS.map((g) => g.id))
  const records = loadConceptRecords({
    content,
    accessPlan,
    builtGroupIds,
    includeDrafts: true,
    isDev: true,
    localeKeys,
  })
  const lectures = opts?.skipLectures
    ? []
    : scanLectureFiles({
        content,
        groups: GROUPS,
        localeKeys,
        accessPlan,
      })
  const backlinks: Map<string, ConceptBacklinkRecord[]> =
    opts?.includeBacklinks === false || opts?.skipLectures
      ? new Map()
      : computeConceptBacklinks(lectures)
  return { GROUPS, accessPlan, localeKeys, records, lectures, backlinks, builtGroupIds }
}

const CONTEXT_CHAR_LIMIT = 24_000
const MAX_OCCURRENCE_SECTIONS = 10
const MAX_OCCURRENCE_TEXT_CHARS = 1500
const MAX_NEIGHBOURS = 15

export interface DuplicateConceptMatch {
  slug: string
  term: string
  url: string
  status: 'draft' | 'published'
}

export interface LectureOccurrenceContextItem {
  lectureCode: string
  lecturePath: string
  title: string
  heading: string
  anchor: string
  link: string
  mentions: number
  text: string
}

export interface NeighbourConceptContextItem {
  slug: string
  term: string
  aliases: string[]
  summary: string
  related: ConceptRecord['meta']['related']
}

const HAS_CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const ASCII_WORD_RE = /[a-z0-9]/
const lectureSectionCache = new Map<string, { sig: string; sections: LectureSection[] }>()

async function getCachedLectureSections(
  content: ContentPaths,
  lec: LectureFileEntry,
  parser: MarkdownParser,
): Promise<LectureSection[]> {
  const sig = digestOf(String(lec.raw.length), lec.raw)
  const key = `${path.resolve(content.docsRoot)}::${lec.relDocsPath}`
  const hit = lectureSectionCache.get(key)
  if (hit && hit.sig === sig) return hit.sections
  const sections = splitLectureSections(lec.raw, parser, lec.title, lec.relDocsPath)
  lectureSectionCache.set(key, { sig, sections })
  return sections
}

function isSearchableConceptNeedle(name: string): boolean {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return false
  return Array.from(trimmed).length >= (HAS_CJK_RE.test(trimmed) ? 2 : 3)
}

function spaceNormalizedText(raw: string): string {
  return (raw ?? '').normalize('NFKC').toLowerCase().replace(NAME_NOISE, ' ').trim()
}

function countConceptMentionsInText(rawText: string, needles: readonly string[]): number {
  const uniqueNorms = new Map<string, string>()
  for (const raw of needles) {
    const norm = normalizeConceptName(raw)
    if (!norm) continue
    if (!uniqueNorms.has(norm)) uniqueNorms.set(norm, raw)
  }
  if (uniqueNorms.size === 0) return 0

  const cjkNeedles: string[] = []
  const asciiNeedles: Array<{ spaced: string; compact: string }> = []
  for (const [norm, orig] of uniqueNorms) {
    if (HAS_CJK_RE.test(norm)) {
      cjkNeedles.push(norm)
    } else {
      const spaced = spaceNormalizedText(orig)
      if (spaced) asciiNeedles.push({ spaced, compact: norm })
    }
  }
  cjkNeedles.sort((a, b) => b.length - a.length)
  asciiNeedles.sort((a, b) => b.spaced.length - a.spaced.length)

  let total = 0

  if (cjkNeedles.length > 0) {
    const compactHaystack = normalizeConceptName(rawText)
    let i = 0
    while (i < compactHaystack.length) {
      let matched = 0
      for (const n of cjkNeedles) {
        if (compactHaystack.startsWith(n, i)) {
          matched = n.length
          break
        }
      }
      if (matched > 0) {
        total++
        i += matched
      } else {
        i++
      }
    }
  }

  if (asciiNeedles.length > 0) {
    const spacedHaystack = spaceNormalizedText(rawText)
    const compactHaystack = normalizeConceptName(rawText)
    const takenSpaced: Array<{ start: number; end: number }> = []
    for (const { spaced, compact } of asciiNeedles) {
      let matchedThisNeedle = 0
      let from = 0
      while (from <= spacedHaystack.length - spaced.length) {
        const at = spacedHaystack.indexOf(spaced, from)
        if (at < 0) break
        from = at + Math.max(1, spaced.length)
        const prevCh = at > 0 ? (spacedHaystack[at - 1] ?? '') : ''
        const nextCh = spacedHaystack[at + spaced.length] ?? ''
        if ((prevCh && ASCII_WORD_RE.test(prevCh)) || (nextCh && ASCII_WORD_RE.test(nextCh))) continue
        const end = at + spaced.length
        if (takenSpaced.some((t) => at < t.end && end > t.start)) continue
        takenSpaced.push({ start: at, end })
        matchedThisNeedle++
      }
      // Fallback for CamelCase / joined forms (e.g. "ActuationLease") on longer ASCII terms
      if (matchedThisNeedle === 0 && compact !== spaced && compact.length >= 5) {
        let cf = 0
        while (cf <= compactHaystack.length - compact.length) {
          const at = compactHaystack.indexOf(compact, cf)
          if (at < 0) break
          cf = at + compact.length
          matchedThisNeedle++
        }
      }
      total += matchedThisNeedle
    }
  }

  return total
}

function truncateOccurrenceText(text: string, limit = MAX_OCCURRENCE_TEXT_CHARS): string {
  const clean = text.trim()
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit - 1).trimEnd()}…`
}

function findDuplicateConceptMatches(records: readonly ConceptRecord[], selectedText: string): DuplicateConceptMatch[] {
  const norm = normalizeConceptName(selectedText)
  if (!norm) return []
  const bySlug = new Map<string, { pub?: ConceptRecord; draft?: ConceptRecord; hit: boolean }>()
  for (const r of records) {
    if (r.locale !== 'root') continue
    const bucket = bySlug.get(r.slug) ?? { hit: false }
    if (r.isDraft) bucket.draft = r
    else bucket.pub = r
    if (conceptNamesOf(r.meta).some((n) => n.normalized === norm)) {
      bucket.hit = true
    }
    bySlug.set(r.slug, bucket)
  }
  const out: DuplicateConceptMatch[] = []
  for (const [slug, bucket] of bySlug) {
    if (!bucket.hit) continue
    const preferred = bucket.pub ?? bucket.draft
    if (!preferred) continue
    out.push({
      slug,
      term: preferred.meta.term,
      url: bucket.pub ? bucket.pub.url : preferred.url,
      status: bucket.pub ? 'published' : 'draft',
    })
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

function resolveLectureEntryByPath(
  lecturePath: string,
  lectures: ReturnType<typeof scanLectureFiles>,
) {
  const norm = lecturePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.html$/, '').replace(/\.md$/, '')
  return (
    lectures.find((l) => l.urlPath.slice(1) === norm || l.relDocsPath.replace(/\.md$/, '') === norm) ?? null
  )
}

export type BuildLectureContextResult =
  | {
      ok: false
      errorCode: 'DUPLICATE'
      existing: DuplicateConceptMatch
      matches: DuplicateConceptMatch[]
    }
  | {
      ok: true
      context: Record<string, unknown>
      contextChars: number
      lectureGroupId: string | null
      lectureTitle: string
      selectionSource: string
      existingConcept: ConceptRecord | null
    }

/** §7.3.3 Context assembly directly from local content directory. */
export async function buildLectureContextForDraft(
  content: ContentPaths,
  input: {
    mode?: 'create' | 'edit' | 'supplement'
    lecturePath: string
    selectedText: string
    sectionHeading?: string
    beforeContext?: string
    afterContext?: string
    targetSlug?: string
    aliases?: readonly string[]
  },
): Promise<BuildLectureContextResult> {
  const mode = input.mode ?? 'create'
  const deps = await resolveContextDeps(content, { includeBacklinks: false })

  if (mode === 'create' && !input.targetSlug) {
    const matches = findDuplicateConceptMatches(deps.records, input.selectedText)
    if (matches.length > 0) {
      return {
        ok: false,
        errorCode: 'DUPLICATE',
        existing: matches[0]!,
        matches,
      }
    }
  }

  const lec = resolveLectureEntryByPath(input.lecturePath, deps.lectures)

  let enclosingParagraph = ''
  let resolvedHeading = (input.sectionHeading ?? '').trim()
  let lectureSources: string[] = []
  let lectureGroupId: string | null = null
  let lectureTitle = input.lecturePath

  if (lec) {
    lectureGroupId = lec.groupId
    lectureTitle = lec.title
    const located = locateOccurrencesInLecture({
      markdown: lec.raw,
      selectedText: input.selectedText,
      sectionHeading: input.sectionHeading,
      beforeContext: input.beforeContext,
      afterContext: input.afterContext,
    })
    const best =
      (located.recommendedIndex !== null ? located.candidates[located.recommendedIndex] : null) ??
      located.candidates[0]
    if (best) {
      if (!resolvedHeading && best.heading) resolvedHeading = best.heading
      enclosingParagraph = extractEnclosingParagraph(lec.raw, best.startOffset)
    }
    lectureSources = extractLectureReferences(lec.raw)
  }

  const existingConcept = input.targetSlug
    ? mode === 'edit'
      ? deps.records.find((r) => r.isDraft && r.slug === input.targetSlug) ??
        deps.records.find((r) => !r.isDraft && r.slug === input.targetSlug) ??
        null
      : deps.records.find((r) => !r.isDraft && r.slug === input.targetSlug) ??
        deps.records.find((r) => r.slug === input.targetSlug) ??
        null
    : null

  const rootPublished = publishedConceptRecords(deps.records)
  const existingSummaryList = rootPublished.map((r) => ({
    slug: r.slug,
    term: r.meta.term,
    aliases: r.meta.aliases,
    field: r.meta.field,
    summary: r.meta.summary,
  }))

  // Look up mentions across all root-locale lectures
  const searchNeedles = [
    input.selectedText,
    ...(input.aliases ?? []),
    ...(existingConcept ? conceptNamesOf(existingConcept.meta).map((n) => n.name) : []),
  ]
    .map((s) => s.trim())
    .filter(Boolean)

  const rootLectures = rootLocaleLectures(deps.lectures, deps.localeKeys, deps.accessPlan)
  const occCandidates: Array<LectureOccurrenceContextItem & { isSelected: boolean }> = []
  if (searchNeedles.length > 0 && rootLectures.length > 0) {
    const parser = await createAnchorParser(content.docsRoot)
    for (const rootLec of rootLectures) {
      const sections = await getCachedLectureSections(content, rootLec, parser)
      const isSelected = Boolean(lec && rootLec.urlPath === lec.urlPath)
      for (const sec of sections) {
        const mentions = countConceptMentionsInText(`${sec.heading}\n${sec.text}`, searchNeedles)
        if (mentions <= 0) continue
        occCandidates.push({
          lectureCode: rootLec.code,
          lecturePath: rootLec.urlPath,
          title: rootLec.title,
          heading: sec.heading,
          anchor: sec.anchor,
          link: sec.anchor ? `${rootLec.urlPath}#${sec.anchor}` : rootLec.urlPath,
          mentions,
          isSelected,
          text: truncateOccurrenceText(sec.text, MAX_OCCURRENCE_TEXT_CHARS),
        })
      }
    }
  }

  occCandidates.sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1
    if (a.mentions !== b.mentions) return b.mentions - a.mentions
    return a.lectureCode.localeCompare(b.lectureCode)
  })
  const occurrences: LectureOccurrenceContextItem[] = occCandidates
    .slice(0, MAX_OCCURRENCE_SECTIONS)
    .map(({ isSelected: _isSel, ...rest }) => rest)

  // Find neighbour concepts appearing in the selected passage or the selected occurrence sections
  const passageHaystack = [input.beforeContext, input.selectedText, input.afterContext, enclosingParagraph]
    .filter(Boolean)
    .join('\n')
  const occHaystack = occurrences.map((o) => `${o.heading}\n${o.text}`).join('\n')
  const neighbourRanked: Array<{ score: number; item: NeighbourConceptContextItem }> = []
  for (const r of rootPublished) {
    if (existingConcept && r.slug === existingConcept.slug) continue
    const names = conceptNamesOf(r.meta)
      .map((n) => n.name)
      .filter((n) => isSearchableConceptNeedle(n))
    if (names.length === 0) continue
    const passageHits = passageHaystack ? countConceptMentionsInText(passageHaystack, names) : 0
    const sectionHits = occHaystack ? countConceptMentionsInText(occHaystack, names) : 0
    if (passageHits + sectionHits === 0) continue
    neighbourRanked.push({
      score: passageHits * 100 + sectionHits,
      item: {
        slug: r.slug,
        term: r.meta.term,
        aliases: r.meta.aliases,
        summary: r.meta.summary,
        related: r.meta.related,
      },
    })
  }
  neighbourRanked.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.item.slug.localeCompare(b.item.slug)
  })
  const neighbours: NeighbourConceptContextItem[] = neighbourRanked
    .slice(0, MAX_NEIGHBOURS)
    .map((entry) => entry.item)

  const selectionSource = lec
    ? resolvedHeading
      ? `${lec.code} · ${resolvedHeading}`
      : lec.code
    : input.lecturePath

  const context: Record<string, unknown> = {
    selectedTerm: input.selectedText,
    lecture: lec ? { path: lec.urlPath, code: lec.code, title: lec.title, groupId: lec.groupId } : { path: input.lecturePath },
    sectionHeading: resolvedHeading,
    enclosingParagraph,
    lectureSources,
    occurrences,
    neighbours,
    existingConcepts: existingSummaryList,
    ...(existingConcept
      ? {
          currentConcept: {
            slug: existingConcept.slug,
            meta: existingConcept.meta,
            body: existingConcept.body,
          },
        }
      : {}),
  }

  // the model gets LF text whatever the checkout uses (a CRLF checkout would otherwise inflate the size and the prompt)
  // (occurrences and neighbours stay the same array objects: the trimming below pops from them)
  const lf = (v: unknown): unknown =>
    typeof v === 'string'
      ? v.replace(/\r\n?/g, '\n')
      : Array.isArray(v)
        ? v.map(lf)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, lf(x)]))
          : v
  for (const key of Object.keys(context)) {
    if (key !== 'occurrences' && key !== 'neighbours') context[key] = lf(context[key])
  }
  for (const o of occurrences) o.text = lf(o.text) as string
  for (let i = 0; i < neighbours.length; i++) neighbours[i] = lf(neighbours[i]) as NeighbourConceptContextItem
  const measureChars = (): number => JSON.stringify(context).length
  while (measureChars() > CONTEXT_CHAR_LIMIT && occurrences.length > 0) {
    const last = occurrences[occurrences.length - 1]!
    const overflow = measureChars() - CONTEXT_CHAR_LIMIT
    if (occurrences.length === 1 && last.text.length > overflow + 200) {
      last.text = `${last.text.slice(0, Math.max(120, last.text.length - overflow - 40)).trimEnd()}…`
      break
    }
    occurrences.pop()
  }
  while (measureChars() > CONTEXT_CHAR_LIMIT && neighbours.length > 0) {
    neighbours.pop()
  }

  return {
    ok: true,
    lectureGroupId,
    lectureTitle,
    selectionSource,
    existingConcept,
    contextChars: measureChars(),
    context,
  }
}

function extractEnclosingParagraph(raw: string, offset: number): string {
  // blank lines in a CRLF file are "\r\n\r\n" (also "\n\r\n" around the offset); every blank line ends a paragraph
  const blank = /\r?\n[ \t]*\r?\n/g
  let start = 0
  let end = raw.length
  for (const m of raw.matchAll(blank)) {
    const at = m.index ?? 0
    if (at + m[0].length <= offset) start = at + m[0].length
    else if (at >= offset) {
      end = at
      break
    }
  }
  return raw.slice(start, end).trim()
}

function extractLectureReferences(raw: string): string[] {
  const refs = new Set<string>()
  for (const m of raw.matchAll(/<span\b[^>]*class=["']cite["'][^>]*data-cite=["']([^"']+)["'][^>]*>([\s\S]*?)<\/span>/gi)) {
    const url = (m[1] ?? '').trim()
    const label = (m[2] ?? '').replace(/<[^>]*>/g, '').trim()
    if (url) refs.add(label ? `${label} (${url})` : url)
  }
  for (const m of raw.matchAll(/[（(](?:出处|来源)\s*[：:]([^）)\n]+)[）)]/g)) {
    const val = (m[1] ?? '').trim()
    if (val) refs.add(val)
  }
  return [...refs].slice(0, 40)
}

export async function listAllConceptsDev(content: ContentPaths): Promise<ConceptDashboardItem[]> {
  const deps = await resolveContextDeps(content)
  const rootRecords = deps.records.filter((r) => r.locale === 'root')
  const publishedSlugs = new Set(rootRecords.filter((r) => !r.isDraft).map((r) => r.slug))
  const draftSlugs = new Set(rootRecords.filter((r) => r.isDraft).map((r) => r.slug))
  return rootRecords
    .map((r) => {
      const bl = deps.backlinks.get(r.slug) ?? []
      const occurrenceCount = bl.reduce((sum, item) => sum + item.count, 0)
      const ctxSidecar = r.isDraft ? readSelectionContextSidecar(content, r.slug) : null
      return {
        slug: r.slug,
        term: r.meta.term,
        english: r.meta.english,
        aliases: r.meta.aliases,
        field: r.meta.field,
        groups: r.meta.groups,
        summary: r.meta.summary,
        status: r.isDraft ? 'draft' : r.meta.status,
        isRevision: r.isDraft && publishedSlugs.has(r.slug),
        hasDraftRevision: !r.isDraft && draftSlugs.has(r.slug),
        generatedBy: r.meta.generatedBy,
        reviewedAt: r.meta.reviewedAt,
        selectionSource: r.meta.selectionSource,
        previewUrl: r.url,
        occurrenceCount,
        lectures: bl.map((b) => ({ lecturePath: b.lecturePath, code: b.code, title: b.title, count: b.count })),
        hasUnverified: r.hasUnverified,
        unverifiedLines: r.unverifiedLines,
        sourcesCount: r.sourcesCount,
        body: r.body,
        raw: r.raw,
        hasSelectionContext: Boolean(ctxSidecar),
      }
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'draft' ? -1 : 1
      return a.slug.localeCompare(b.slug)
    })
}

export async function buildDevHoverPayload(content: ContentPaths): Promise<ConceptHoverPayload> {
  const deps = await resolveContextDeps(content)
  const items: Record<string, ConceptHoverEntry> = {}
  for (const r of deps.records) {
    if (r.locale !== 'root') continue
    items[r.slug] = {
      slug: r.slug,
      term: r.meta.term,
      english: r.meta.english,
      aliases: r.meta.aliases,
      field: r.meta.field,
      groups: r.meta.groups,
      summary: r.meta.summary,
      status: r.isDraft ? 'draft' : r.meta.status,
      url: r.url,
    }
  }
  return { v: 1, tier: 'dev', items }
}

async function callOpenAiEndpoint(
  cfg: ByokModelSettings,
  req: ContractModelRequest,
): Promise<string> {
  const baseUrl = cfg.baseUrl.replace(/\/+$/, '')
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`

  const send = async (withResponseFormat: boolean) => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: req.messages,
      temperature: 0.2,
    }
    if (withResponseFormat) {
      body.response_format = req.responseFormat
    }
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    })
  }

  let res = await send(true)
  if (res.status === 400) {
    const errText = await res.text().catch(() => '')
    if (/response_format|json_schema/i.test(errText)) {
      res = await send(false)
    } else {
      throw new Error(`OpenAI endpoint HTTP 400: ${errText.slice(0, 240)}`)
    }
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`OpenAI endpoint HTTP ${res.status}: ${errText.slice(0, 240)}`)
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return json.choices?.[0]?.message?.content ?? ''
}

export interface GenerateDraftInput {
  mode: 'create' | 'edit' | 'supplement'
  lecturePath?: string
  selectedText: string
  sectionHeading?: string
  beforeContext?: string
  afterContext?: string
  targetSlug?: string
  instruction?: string
  lang?: 'zh' | 'en'
  byok?: ByokModelSettings | null
  /** Optional raw/parsed draft payload already generated client-side (BYOK) for schema validation & persistence. */
  draftPayload?: unknown
  /** Optional direct markdown override when saving manual author edits on a draft. */
  markdownOverride?: string
  /** Optional callback notified synchronously after writing concept/lecture files (dev Vite invalidation). */
  onFilesChanged?: (files: readonly string[]) => void
}

function resolvePayloadGroups(
  payloadGroups: readonly string[],
  fallbackGroupId: string | null,
): string[] {
  return payloadGroups.length > 0 ? [...payloadGroups] : fallbackGroupId ? [fallbackGroupId] : ['G01']
}

function runDraftGraphChecks(
  deps: Awaited<ReturnType<typeof resolveContextDeps>>,
  opts: {
    slug: string
    groups: readonly string[]
    md: string
    mode: 'create' | 'edit' | 'supplement'
    explicitTargetSlug?: string
    payload?: ConceptDraftPayload
  },
): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  if (opts.payload) {
    for (const para of opts.payload.paragraphs) {
      if (para.verified && (!Array.isArray(para.sources) || para.sources.length === 0)) {
        errors.push(`段落 "${para.heading}" verified=true 时必须提供 sources`)
      }
      if (!para.verified) {
        if (!(para.unverifiedReason ?? '').trim()) {
          errors.push(`段落 "${para.heading}" verified=false 时必须提供 unverifiedReason`)
        }
        if (!para.body.includes('待核实')) {
          errors.push(`段落 "${para.heading}" verified=false 时 body 必须包含「待核实」标记`)
        }
      }
    }
  }

  if (opts.mode === 'create' && !opts.explicitTargetSlug) {
    const existingSlugMatch = deps.records.some((r) => r.locale === 'root' && r.slug === opts.slug)
    if (existingSlugMatch) {
      errors.push(`概念 "${opts.slug}" 已存在，请改用补充已有概念`)
    }
  }

  const parsed = parseConceptMarkdown(opts.md, opts.slug)
  const meta = { ...parsed.meta, slug: opts.slug }
  const tierRes = resolveConceptTier(opts.groups, deps.accessPlan, deps.builtGroupIds)
  const draftChecked: CheckedConcept = {
    slug: opts.slug,
    file: `concepts/_drafts/${opts.slug}.md`,
    meta,
    raw: opts.md,
    tier: tierRes.tier,
  }

  const publishedOther: CheckedConcept[] = publishedConceptRecords(deps.records)
    .filter((r) => r.slug !== opts.slug)
    .map((r) => ({
      slug: r.slug,
      file: r.relDocsPath,
      meta: r.meta,
      raw: r.raw,
      tier: r.tier,
    }))

  const otherNamedBySlug = new Map<string, CheckedConcept>()
  for (const r of deps.records) {
    if (r.locale !== 'root' || r.drop || r.slug === opts.slug) continue
    const prev = otherNamedBySlug.get(r.slug)
    if (!prev) {
      otherNamedBySlug.set(r.slug, {
        slug: r.slug,
        file: r.relDocsPath,
        meta: { ...r.meta, aliases: [...r.meta.aliases] },
        raw: r.raw,
        tier: r.tier,
      })
    } else {
      const merged = new Set([...prev.meta.aliases, r.meta.term, r.meta.english, ...r.meta.aliases])
      prev.meta = { ...prev.meta, aliases: [...merged] }
    }
  }

  const publishedPlusDraft = [...publishedOther, draftChecked]
  const filtered = filteredOutSlugs(deps.records)
  const relErrors = checkRelated(publishedPlusDraft, { filteredOut: filtered }).filter((m) =>
    m.includes(draftChecked.file),
  )
  const linkErrors = checkConceptPageLinks(publishedPlusDraft, { filteredOut: filtered }).filter((m) =>
    m.includes(draftChecked.file),
  )
  const dupErrors = checkDuplicateNames([...otherNamedBySlug.values(), draftChecked]).filter((m) =>
    m.includes(draftChecked.file),
  )
  const warnings = checkUnlinkedMentions(publishedPlusDraft).filter((m) => m.includes(draftChecked.file))

  return {
    errors: [...errors, ...dupErrors, ...linkErrors, ...relErrors],
    warnings,
  }
}

export async function generateOrSaveConceptDraft(
  content: ContentPaths,
  input: GenerateDraftInput,
): Promise<
  | {
      ok: true
      slug: string
      previewUrl: string
      contractVersion: number
      hasUnverified: boolean
      warnings: string[]
      item: ConceptDashboardItem
    }
  | {
      ok: false
      errorCode: 'DUPLICATE'
      existing: DuplicateConceptMatch
      matches: DuplicateConceptMatch[]
      message: string
      errors: string[]
      contractVersion?: number
    }
  | {
      ok: false
      errorCode: 'SCHEMA_INVALID' | 'MODEL_ERROR' | 'BAD_INPUT'
      message: string
      errors: string[]
      contractVersion?: number
    }
> {
  const contract = loadAiContract('concept-draft')
  const lang = input.lang === 'en' ? 'en' : 'zh'
  const invalidMsg = lang === 'en' ? CONTRACT_INVALID_MESSAGE_EN : CONTRACT_INVALID_MESSAGE_ZH
  const mode = input.mode ?? 'create'

  // Branch A: Manual edit of an existing draft markdown in preview/dashboard
  if (typeof input.markdownOverride === 'string' && input.targetSlug) {
    const slug = assertSafeSlug(input.targetSlug)
    const parsed = parseConceptMarkdown(input.markdownOverride, slug)
    const meta = { ...parsed.meta, slug, status: 'draft' as const, reviewedAt: '' }
    const normalized = serializeConceptMarkdown(meta, parsed.body)
    const deps = await resolveContextDeps(content, { includeBacklinks: false, skipLectures: true })
    const check = runDraftGraphChecks(deps, {
      slug,
      groups: meta.groups,
      md: normalized,
      mode: 'edit',
      explicitTargetSlug: slug,
    })
    if (check.errors.length > 0) {
      return {
        ok: false,
        errorCode: 'SCHEMA_INVALID',
        message: invalidMsg,
        errors: check.errors,
        contractVersion: contract.version,
      }
    }
    atomicWriteFile(draftMdPath(content, slug), normalized, writeRoots(content))
    syncMirroredDraftFile(content, slug, normalized)
    input.onFilesChanged?.([draftMdPath(content, slug)])
    const all = await listAllConceptsDev(content)
    const item = all.find((c) => c.slug === slug && c.status === 'draft')!
    return {
      ok: true,
      slug,
      previewUrl: item.previewUrl,
      contractVersion: contract.version,
      hasUnverified: item.hasUnverified,
      warnings: check.warnings,
      item,
    }
  }

  const selectedText = (input.selectedText ?? '').trim()
  if (!selectedText && !input.draftPayload) {
    return {
      ok: false,
      errorCode: 'BAD_INPUT',
      message: 'selectedText is required',
      errors: ['selectedText is required'],
    }
  }

  let resolvedTargetSlug = input.targetSlug
  if (mode === 'supplement' && !resolvedTargetSlug && selectedText) {
    const preDeps = await resolveContextDeps(content, { includeBacklinks: false, skipLectures: true })
    const matches = findDuplicateConceptMatches(preDeps.records, selectedText)
    if (matches.length === 1) {
      resolvedTargetSlug = matches[0]!.slug
    } else if (matches.length > 1) {
      return {
        ok: false,
        errorCode: 'DUPLICATE',
        existing: matches[0]!,
        matches,
        message: lang === 'en' ? 'Multiple matching concepts found; pick one first' : '存在多个同名已有概念，请先选择要补充的目标',
        errors: matches.map((m) => `${m.term} (${m.slug})`),
        contractVersion: contract.version,
      }
    } else {
      return {
        ok: false,
        errorCode: 'BAD_INPUT',
        message: lang === 'en' ? 'No existing concept matched for supplement mode' : '未找到匹配的已有概念，无法补充',
        errors: ['targetSlug is required when selectedText does not match an existing concept'],
      }
    }
  }

  const ctxBuilt = await buildLectureContextForDraft(content, {
    mode,
    lecturePath: input.lecturePath ?? '',
    selectedText: selectedText || (resolvedTargetSlug ?? ''),
    sectionHeading: input.sectionHeading,
    beforeContext: input.beforeContext,
    afterContext: input.afterContext,
    targetSlug: resolvedTargetSlug,
  })

  if ('errorCode' in ctxBuilt) {
    return {
      ok: false,
      errorCode: 'DUPLICATE',
      existing: ctxBuilt.existing,
      matches: ctxBuilt.matches,
      message:
        lang === 'en'
          ? `Concept "${ctxBuilt.existing.term}" (${ctxBuilt.existing.slug}) already exists`
          : `概念「${ctxBuilt.existing.term}」（${ctxBuilt.existing.slug}）已存在，未调用模型`,
      errors: ctxBuilt.matches.map((m) => `${m.term} (${m.slug})`),
      contractVersion: contract.version,
    }
  }

  const checkDeps = await resolveContextDeps(content, { includeBacklinks: false, skipLectures: true })
  const inheritedSelectionSource = ctxBuilt.existingConcept?.meta.selectionSource || ctxBuilt.selectionSource

  let validatedDraft: ConceptDraftPayload
  let generatedByLabel = `concept-draft@v${contract.version}`
  let lastWarnings: string[] = []

  if (input.draftPayload !== undefined) {
    const check = validateContractOutput<ConceptDraftPayload>(contract, input.draftPayload)
    if (!check.ok) {
      return {
        ok: false,
        errorCode: 'SCHEMA_INVALID',
        message: invalidMsg,
        errors: 'errors' in check ? check.errors : [invalidMsg],
        contractVersion: contract.version,
      }
    }
    const candSlugRaw = resolvedTargetSlug || check.data.slug || slugifyConcept(check.data.english || check.data.term)
    if (!isValidConceptSlug(candSlugRaw)) {
      return {
        ok: false,
        errorCode: 'SCHEMA_INVALID',
        message: invalidMsg,
        errors: [`Invalid concept slug: ${JSON.stringify(candSlugRaw)}`],
        contractVersion: contract.version,
      }
    }
    const candGroups = resolvePayloadGroups(check.data.groups, ctxBuilt.lectureGroupId)
    const candMd = draftPayloadToConceptMarkdown(
      { ...check.data, slug: candSlugRaw, groups: candGroups },
      { generatedBy: `byok:concept-draft@v${contract.version}`, selectionSource: inheritedSelectionSource },
    )
    const semantic = runDraftGraphChecks(checkDeps, {
      slug: candSlugRaw,
      groups: candGroups,
      md: candMd,
      mode,
      explicitTargetSlug: resolvedTargetSlug,
      payload: check.data,
    })
    if (semantic.errors.length > 0) {
      return {
        ok: false,
        errorCode: 'SCHEMA_INVALID',
        message: invalidMsg,
        errors: semantic.errors,
        contractVersion: contract.version,
      }
    }
    lastWarnings = semantic.warnings
    validatedDraft = check.data
    generatedByLabel = `byok:concept-draft@v${contract.version}`
  } else {
    const envBase = process.env.LECTURE_AI_BASE_URL || process.env.OPENAI_BASE_URL || ''
    const envKey = process.env.LECTURE_AI_API_KEY || process.env.OPENAI_API_KEY || ''
    const envModel = process.env.LECTURE_AI_MODEL || 'gpt-4o-mini'
    const modelCfg: ByokModelSettings | null =
      input.byok?.baseUrl && input.byok?.apiKey && input.byok?.model
        ? input.byok
        : envBase && envKey
          ? { baseUrl: envBase, apiKey: envKey, model: envModel }
          : null

    if (!modelCfg) {
      return {
        ok: false,
        errorCode: 'MODEL_ERROR',
        message: lang === 'en' ? 'No BYOK or local AI endpoint configured' : '未配置 BYOK 或本地 AI 接口',
        errors: ['No model endpoint configured'],
        contractVersion: contract.version,
      }
    }

    const prompts = loadAndValidateSitePrompts()
    const promptLang = normalizePromptLang(lang)
    const systemPrompt = prompts.prompts.system[promptLang]

    const result = await runAiContract<ConceptDraftPayload>({
      contract,
      companionSystemPrompt: systemPrompt,
      lang,
      taskInput: {
        mode,
        instruction: input.instruction ?? '',
        selectionSource: ctxBuilt.selectionSource,
        ...ctxBuilt.context,
      },
      validateData: (candidate) => {
        const candSlugRaw = resolvedTargetSlug || candidate.slug || slugifyConcept(candidate.english || candidate.term)
        if (!isValidConceptSlug(candSlugRaw)) {
          return { ok: false, errors: [`Invalid concept slug: ${JSON.stringify(candSlugRaw)}`] }
        }
        const candGroups = resolvePayloadGroups(candidate.groups, ctxBuilt.lectureGroupId)
        const candMd = draftPayloadToConceptMarkdown(
          { ...candidate, slug: candSlugRaw, groups: candGroups },
          { generatedBy: `contract:${contract.id}@v${contract.version}`, selectionSource: inheritedSelectionSource },
        )
        const semantic = runDraftGraphChecks(checkDeps, {
          slug: candSlugRaw,
          groups: candGroups,
          md: candMd,
          mode,
          explicitTargetSlug: resolvedTargetSlug,
          payload: candidate,
        })
        if (semantic.errors.length > 0) {
          return { ok: false, errors: semantic.errors }
        }
        lastWarnings = semantic.warnings
        return { ok: true }
      },
      invokeModel: (req) => callOpenAiEndpoint(modelCfg, req),
    })

    if (!result.ok) {
      return {
        ok: false,
        errorCode: 'errorCode' in result ? result.errorCode : 'SCHEMA_INVALID',
        message: 'message' in result ? result.message : invalidMsg,
        errors: 'errors' in result ? result.errors : [invalidMsg],
        contractVersion: contract.version,
      }
    }
    validatedDraft = result.data
    generatedByLabel = `contract:${result.contractId}@v${result.contractVersion}`
  }

  const finalSlug = assertSafeSlug(
    resolvedTargetSlug || validatedDraft.slug || slugifyConcept(validatedDraft.english || validatedDraft.term),
  )
  const finalGroups = resolvePayloadGroups(validatedDraft.groups, ctxBuilt.lectureGroupId)

  const md = draftPayloadToConceptMarkdown(
    { ...validatedDraft, slug: finalSlug, groups: finalGroups },
    {
      generatedBy: generatedByLabel,
      selectionSource: inheritedSelectionSource,
    },
  )

  atomicWriteFile(draftMdPath(content, finalSlug), md, writeRoots(content))
  syncMirroredDraftFile(content, finalSlug, md)
  input.onFilesChanged?.([draftMdPath(content, finalSlug)])

  if (input.lecturePath && selectedText) {
    writeSelectionContextSidecar(content, finalSlug, {
      lecturePath: input.lecturePath,
      selectedText,
      sectionHeading: input.sectionHeading,
      beforeContext: input.beforeContext,
      afterContext: input.afterContext,
    })
  }

  const all = await listAllConceptsDev(content)
  const item = all.find((c) => c.slug === finalSlug && c.status === 'draft')!
  return {
    ok: true,
    slug: finalSlug,
    previewUrl: item.previewUrl,
    contractVersion: contract.version,
    hasUnverified: item.hasUnverified,
    warnings: lastWarnings,
    item,
  }
}

export async function previewConfirmConcept(
  content: ContentPaths,
  input: {
    slug: string
    lecturePath?: string
    selectedText?: string
    selectedOffsets?: readonly number[]
    allOccurrences?: boolean
    skipMount?: boolean
  },
): Promise<
  | {
      ok: true
      slug: string
      canConfirm: boolean
      blockedByUnverified: boolean
      unverifiedLines: string[]
      contractErrors: string[]
      mountStatus: 'ready' | 'needs_choice' | 'not_found' | 'no_mount'
      lecturePath: string
      candidates: OccurrenceCandidate[]
      recommendedIndex: number | null
      chosenIndices: number[]
      lecturePatch: string
      conceptPatch: string
      manualSyntax: string
      /** Digest of the exact bytes `executeConfirmConcept` would write; the client sends it back to prove it confirms what it saw. */
      previewToken: string
    }
  | { ok: false; error: string }
> {
  const slug = assertSafeSlug(input.slug)
  const dPath = draftMdPath(content, slug)
  const pPath = publishedMdPath(content, slug)
  const hasDraft = fs.existsSync(dPath)
  const hasPub = fs.existsSync(pPath)
  if (!hasDraft && !hasPub) {
    return { ok: false, error: `Concept draft or page not found: ${slug}` }
  }

  const rawSource = fs.readFileSync(hasDraft ? dPath : pPath, 'utf8')
  const parsed = parseConceptMarkdown(rawSource, slug)
  const today = new Date().toISOString().slice(0, 10)
  const publishedMarkdown = serializeConceptMarkdown(
    {
      ...parsed.meta,
      slug,
      status: 'published',
      reviewedAt: today,
    },
    parsed.body,
  )

  let mountedLectureNext = ''
  const unverif = hasUnverifiedMarkers(rawSource)
  const contractErrors = validatePublishedConceptContracts(publishedMarkdown)

  const prevPubRaw = hasPub ? fs.readFileSync(pPath, 'utf8') : ''
  const conceptPatch = createTwoFilesPatch(`concepts/${slug}.md`, `concepts/${slug}.md`, prevPubRaw, publishedMarkdown, 'before', 'after', {
    context: 2,
  })

  const sidecar = readSelectionContextSidecar(content, slug)
  const targetLecturePath = input.skipMount ? '' : (input.lecturePath || sidecar?.lecturePath || '')
  const targetText = (input.selectedText || sidecar?.selectedText || parsed.meta.term).trim()
  const manualSyntax = `[${targetText || parsed.meta.term}](concept:${slug})`

  if (!targetLecturePath) {
    return {
      ok: true,
      slug,
      canConfirm: !unverif.hasUnverified && contractErrors.length === 0,
      blockedByUnverified: unverif.hasUnverified,
      unverifiedLines: unverif.lines,
      contractErrors,
      mountStatus: 'no_mount',
      lecturePath: '',
      candidates: [],
      recommendedIndex: null,
      chosenIndices: [],
      lecturePatch: '',
      conceptPatch,
      manualSyntax,
      previewToken: digestOf(slug, prevPubRaw, publishedMarkdown, mountedLectureNext),
    }
  }

  const deps = await resolveContextDeps(content)
  const lec = resolveLectureEntryByPath(targetLecturePath, deps.lectures)
  if (!lec) {
    return {
      ok: true,
      slug,
      canConfirm: !unverif.hasUnverified && contractErrors.length === 0,
      blockedByUnverified: unverif.hasUnverified,
      unverifiedLines: unverif.lines,
      contractErrors,
      mountStatus: 'not_found',
      lecturePath: targetLecturePath,
      candidates: [],
      recommendedIndex: null,
      chosenIndices: [],
      lecturePatch: '',
      conceptPatch,
      manualSyntax,
      previewToken: digestOf(slug, prevPubRaw, publishedMarkdown, mountedLectureNext),
    }
  }

  const located = locateOccurrencesInLecture({
    markdown: lec.raw,
    selectedText: targetText,
    aliases: parsed.meta.aliases,
    sectionHeading: sidecar?.sectionHeading,
    beforeContext: sidecar?.beforeContext,
    afterContext: sidecar?.afterContext,
  })

  if (located.status === 'none') {
    return {
      ok: true,
      slug,
      canConfirm: !unverif.hasUnverified && contractErrors.length === 0,
      blockedByUnverified: unverif.hasUnverified,
      unverifiedLines: unverif.lines,
      contractErrors,
      mountStatus: 'not_found',
      lecturePath: lec.urlPath,
      candidates: [],
      recommendedIndex: null,
      chosenIndices: [],
      lecturePatch: '',
      conceptPatch,
      manualSyntax,
      previewToken: digestOf(slug, prevPubRaw, publishedMarkdown, mountedLectureNext),
    }
  }

  let chosenIndices: number[] = []
  if (input.allOccurrences) {
    chosenIndices = located.candidates.map((c) => c.index)
  } else if (Array.isArray(input.selectedOffsets) && input.selectedOffsets.length > 0) {
    chosenIndices = located.candidates
      .filter((c) => input.selectedOffsets!.includes(c.index) || input.selectedOffsets!.includes(c.startOffset))
      .map((c) => c.index)
  } else if (located.status === 'unique' && located.recommendedIndex !== null) {
    chosenIndices = [located.recommendedIndex]
  }

  if (chosenIndices.length === 0) {
    return {
      ok: true,
      slug,
      canConfirm: false,
      blockedByUnverified: unverif.hasUnverified,
      unverifiedLines: unverif.lines,
      contractErrors,
      mountStatus: 'needs_choice',
      lecturePath: lec.urlPath,
      candidates: located.candidates,
      recommendedIndex: located.recommendedIndex,
      chosenIndices: [],
      lecturePatch: '',
      conceptPatch,
      manualSyntax,
      previewToken: digestOf(slug, prevPubRaw, publishedMarkdown, mountedLectureNext),
    }
  }

  const ranges = chosenIndices
    .map((idx) => located.candidates[idx])
    .filter((c): c is OccurrenceCandidate => Boolean(c))
    .map((c) => ({ start: c.startOffset, end: c.endOffset }))

  const mountDiff = buildMountConceptDiff(lec.raw, slug, ranges, lec.relDocsPath)
  mountedLectureNext = mountDiff.nextMarkdown

  return {
    ok: true,
    slug,
    canConfirm: !unverif.hasUnverified && contractErrors.length === 0,
    blockedByUnverified: unverif.hasUnverified,
    unverifiedLines: unverif.lines,
    contractErrors,
    mountStatus: 'ready',
    lecturePath: lec.urlPath,
    candidates: located.candidates,
    recommendedIndex: located.recommendedIndex,
    chosenIndices,
    lecturePatch: mountDiff.patch,
    conceptPatch,
    manualSyntax,
    previewToken: digestOf(slug, prevPubRaw, publishedMarkdown, mountedLectureNext),
  }
}

export async function executeConfirmConcept(
  content: ContentPaths,
  input: {
    slug: string
    lecturePath?: string
    selectedText?: string
    selectedOffsets?: readonly number[]
    allOccurrences?: boolean
    skipMount?: boolean
    /** `previewToken` of the preview the author confirmed; a changed source since then refuses the write. */
    expectedPreviewToken?: string
    onFilesChanged?: (files: readonly string[]) => void
  },
): Promise<{ ok: true; slug: string; url: string; updatedLecture: string | null } | { ok: false; error: string }> {
  const preview = await previewConfirmConcept(content, input)
  if (!preview.ok) {
    return { ok: false, error: 'error' in preview ? preview.error : 'Preview failed' }
  }
  if (preview.blockedByUnverified) {
    return { ok: false, error: 'Blocked: unresolved 待核实 markers remain in concept draft.' }
  }
  if (preview.contractErrors.length > 0) {
    return { ok: false, error: preview.contractErrors.join('; ') }
  }
  if (!preview.canConfirm) {
    return { ok: false, error: 'Occurrence choice is required before confirming write.' }
  }
  if (input.expectedPreviewToken !== undefined && input.expectedPreviewToken !== preview.previewToken) {
    return { ok: false, error: 'STALE_PREVIEW: the files changed since the diff was shown; preview again before confirming.' }
  }

  const slug = assertSafeSlug(input.slug)
  const dPath = draftMdPath(content, slug)
  const pPath = publishedMdPath(content, slug)
  const rawSource = fs.readFileSync(fs.existsSync(dPath) ? dPath : pPath, 'utf8')
  const parsed = parseConceptMarkdown(rawSource, slug)
  const today = new Date().toISOString().slice(0, 10)
  const publishedMarkdown = serializeConceptMarkdown(
    {
      ...parsed.meta,
      slug,
      status: 'published',
      reviewedAt: today,
    },
    parsed.body,
  )

  const roots = writeRoots(content)
  const changedFiles: string[] = [dPath, pPath]
  // The concept page goes first: a lecture that links to a missing page would break the build, a page nobody links yet does not.
  atomicWriteFile(pPath, publishedMarkdown, roots)
  syncMirroredPublishedFile(content, slug, publishedMarkdown)
  const mirroredPub = path.join(content.docsRoot, 'concepts', `${slug}.md`)
  if (path.resolve(mirroredPub) !== path.resolve(pPath)) changedFiles.push(mirroredPub)

  let updatedLecture: string | null = null
  if (preview.mountStatus === 'ready' && preview.lecturePath && preview.chosenIndices.length > 0) {
    const deps = await resolveContextDeps(content, { includeBacklinks: false })
    const lec = resolveLectureEntryByPath(preview.lecturePath, deps.lectures)
    if (lec) {
      const ranges = preview.chosenIndices
        .map((idx) => preview.candidates[idx])
        .filter((c): c is OccurrenceCandidate => Boolean(c))
        .map((c) => ({ start: c.startOffset, end: c.endOffset }))
      if (ranges.length > 0) {
        const diffRes = buildMountConceptDiff(lec.raw, slug, ranges, lec.relDocsPath)
        atomicWriteFile(lec.absPath, diffRes.nextMarkdown, roots)
        changedFiles.push(lec.absPath)
        // Also update docsRoot copy in content mode
        const mirroredLec = path.join(content.docsRoot, lec.relDocsPath)
        if (path.resolve(mirroredLec) !== path.resolve(lec.absPath) && fs.existsSync(mirroredLec)) {
          atomicWriteFile(mirroredLec, diffRes.nextMarkdown, roots)
          changedFiles.push(mirroredLec)
        }
        updatedLecture = lec.urlPath
      }
    }
  }

  safeRemoveFile(dPath, roots)
  syncMirroredDraftFile(content, slug, null)
  cleanSelectionContextSidecar(content, slug)
  input.onFilesChanged?.(changedFiles)

  return { ok: true, slug, url: `/concepts/${slug}`, updatedLecture }
}

export function discardConceptDraft(
  content: ContentPaths,
  slugRaw: string,
  onFilesChanged?: (files: readonly string[]) => void,
): { ok: true; slug: string } {
  const slug = assertSafeSlug(slugRaw)
  const dPath = draftMdPath(content, slug)
  safeRemoveFile(dPath, writeRoots(content))
  syncMirroredDraftFile(content, slug, null)
  cleanSelectionContextSidecar(content, slug)
  onFilesChanged?.([dPath])
  return { ok: true, slug }
}

export async function previewDeleteConcept(content: ContentPaths, slugRaw: string) {
  const slug = assertSafeSlug(slugRaw)
  const deps = await resolveContextDeps(content)
  const record = deps.records.find((r) => r.slug === slug && !r.isDraft) ?? deps.records.find((r) => r.slug === slug) ?? null
  const impact: Array<{
    lecturePath: string
    relDocsPath: string
    code: string
    title: string
    count: number
    patch: string
  }> = []

  let totalOccurrences = 0
  for (const lec of deps.lectures) {
    const links = findConceptLinksInMarkdown(lec.raw, slug)
    if (links.length === 0) continue
    totalOccurrences += links.length
    const unlinked = unlinkConceptInMarkdown(lec.raw, slug, lec.relDocsPath)
    impact.push({
      lecturePath: lec.urlPath,
      relDocsPath: lec.relDocsPath,
      code: lec.code,
      title: lec.title,
      count: links.length,
      patch: unlinked.patch,
    })
  }

  return {
    ok: true as const,
    slug,
    term: record?.meta.term ?? slug,
    totalLectures: impact.length,
    totalOccurrences,
    impact,
    previewToken: digestOf(slug, ...impact.map((i) => `${i.relDocsPath}\n${i.patch}`)),
  }
}

export async function executeDeleteConcept(
  content: ContentPaths,
  slugRaw: string,
  onFilesChanged?: (files: readonly string[]) => void,
  expectedPreviewToken?: string,
): Promise<
  | { ok: true; slug: string; unlinkedLectures: number; unlinkedOccurrences: number }
  | { ok: false; error: string }
> {
  const slug = assertSafeSlug(slugRaw)
  if (expectedPreviewToken !== undefined) {
    const current = await previewDeleteConcept(content, slug)
    if (current.previewToken !== expectedPreviewToken) {
      return { ok: false, error: 'STALE_PREVIEW: the lectures changed since the impact was shown; preview again before deleting.' }
    }
  }
  const roots = writeRoots(content)
  const deps = await resolveContextDeps(content, { includeBacklinks: false })
  let unlinkedLectures = 0
  let unlinkedOccurrences = 0
  const changedFiles: string[] = [publishedMdPath(content, slug), draftMdPath(content, slug)]

  for (const lec of deps.lectures) {
    const unlinked = unlinkConceptInMarkdown(lec.raw, slug, lec.relDocsPath)
    if (unlinked.removedCount > 0) {
      atomicWriteFile(lec.absPath, unlinked.nextMarkdown, roots)
      changedFiles.push(lec.absPath)
      const mirroredLec = path.join(content.docsRoot, lec.relDocsPath)
      if (path.resolve(mirroredLec) !== path.resolve(lec.absPath) && fs.existsSync(mirroredLec)) {
        atomicWriteFile(mirroredLec, unlinked.nextMarkdown, roots)
        changedFiles.push(mirroredLec)
      }
      unlinkedLectures++
      unlinkedOccurrences += unlinked.removedCount
    }
  }

  safeRemoveFile(publishedMdPath(content, slug), roots)
  safeRemoveFile(draftMdPath(content, slug), roots)
  syncMirroredDraftFile(content, slug, null)
  cleanSelectionContextSidecar(content, slug)
  syncMirroredPublishedFile(content, slug, null)
  onFilesChanged?.(changedFiles)

  return {
    ok: true as const,
    slug,
    unlinkedLectures,
    unlinkedOccurrences,
  }
}
