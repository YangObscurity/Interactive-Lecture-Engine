/**
 * concepts/frontmatter.ts - Pure Concept Page metadata parser, serializer, and contract draft formatter.
 *
 * Works in both Node and browser environments without external YAML dependencies.
 */

import { formatRelatedField, parseRelatedField, type ConceptRelation } from './related.ts'

export type ConceptStatus = 'draft' | 'published'

export interface ConceptRelatedLecture {
  lecturePath: string
  code: string
  title: string
  count: number
}

export interface ConceptMeta {
  slug: string
  title: string
  term: string
  english: string
  aliases: string[]
  field: string
  groups: string[]
  summary: string
  status: ConceptStatus
  generatedBy: string
  reviewedAt: string
  selectionSource?: string
  outline?: string
  /** `related:` entries that parsed; typed `{ slug, rel }` (see related.ts). */
  related: ConceptRelation[]
  /** Entries of `related:` that could not be used (unknown type, missing field); the build reports them as errors. */
  relatedProblems?: string[]
}

export interface ParsedConceptPage {
  meta: ConceptMeta
  body: string
  raw: string
  frontmatterRaw: string
}

export interface ConceptDraftParagraph {
  heading: string
  body: string
  sources: string[]
  verified: boolean
  unverifiedReason?: string
}

export interface ConceptDraftPayload {
  slug: string
  term: string
  english: string
  aliases: string[]
  field: string
  groups: string[]
  summary: string
  related?: ConceptRelation[]
  paragraphs: ConceptDraftParagraph[]
}

export interface ConceptHoverEntry {
  slug: string
  term: string
  english: string
  aliases: string[]
  field: string
  groups: string[]
  summary: string
  status: ConceptStatus
  url: string
}

export interface ConceptHoverPayload {
  v: 1
  tier: string
  items: Record<string, ConceptHoverEntry>
}

export interface ConceptBacklinkPayload {
  v: 1
  tier: string
  links: Record<string, ConceptRelatedLecture[]>
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const UNVERIFIED_RE = /\u5f85\u6838\u5b9e/

export function isValidConceptSlug(slug: string): boolean {
  return SLUG_RE.test(slug)
}

export function slugifyConcept(input: string, fallbackPrefix = 'concept'): string {
  const cleaned = (input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  if (cleaned.length >= 2 && isValidConceptSlug(cleaned)) return cleaned
  let h = 0x811c9dc5
  for (const ch of input ?? '') {
    h ^= ch.codePointAt(0) ?? 0
    h = Math.imul(h, 0x01000193)
  }
  return `${fallbackPrefix}-${(h >>> 0).toString(16).padStart(6, '0')}`
}

export function splitMarkdownFrontmatter(raw: string): { frontmatter: string; body: string; bodyStartOffset: number } {
  const normalized = (raw ?? '').replace(/^\uFEFF/, '')
  const open = /^---[ \t]*\r?\n/.exec(normalized)
  if (!open) return { frontmatter: '', body: normalized, bodyStartOffset: 0 }
  const afterOpen = open[0].length
  const rest = normalized.slice(afterOpen)
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest)
  if (!close) return { frontmatter: '', body: normalized, bodyStartOffset: 0 }
  const frontmatter = rest.slice(0, close.index)
  const bodyStartOffset = afterOpen + close.index + close[0].length
  const body = normalized.slice(bodyStartOffset)
  return { frontmatter, body, bodyStartOffset }
}

function unquoteScalar(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\')
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'")
  }
  return t.replace(/\s+#.*$/, '').trim()
}

function parseFlowArray(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, '').replace(/\]\s*(?:#.*)?$/, '')
  if (!inner.trim()) return []
  const items: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string
    if (quote) {
      cur += ch
      if (ch === quote && inner[i - 1] !== '\\') quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      const val = unquoteScalar(cur)
      if (val) items.push(val)
      cur = ''
    } else {
      cur += ch
    }
  }
  const tail = unquoteScalar(cur)
  if (tail) items.push(tail)
  return items
}

export function parseConceptFrontmatterBlock(block: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1] as string
    const val = (match[2] ?? '').trim()
    if (val.startsWith('[')) {
      out[key] = parseFlowArray(val)
    } else if (val === '' || val.startsWith('#')) {
      const arr: string[] = []
      let sawList = false
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1] ?? ''
        const item = /^\s*-\s+(.*)$/.exec(nextLine)
        if (!item) break
        sawList = true
        const clean = unquoteScalar(item[1] ?? '')
        if (clean) arr.push(clean)
        i++
      }
      out[key] = sawList ? arr : ''
    } else {
      out[key] = unquoteScalar(val)
    }
  }
  return out
}

function asString(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v.join(', ').trim()
  return (v ?? '').trim()
}

function asStringArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean)
  if (typeof v === 'string' && v.trim()) return [v.trim()]
  return []
}

export function parseConceptMarkdown(raw: string, fallbackSlug = ''): ParsedConceptPage {
  const { frontmatter, body } = splitMarkdownFrontmatter(raw)
  const fm = parseConceptFrontmatterBlock(frontmatter)
  const term = asString(fm.term) || asString(fm.title) || fallbackSlug
  const title = asString(fm.title) || term
  const statusRaw = asString(fm.status)
  const status: ConceptStatus = statusRaw === 'published' ? 'published' : 'draft'
  const groups = asStringArray(fm.groups).map((g) => g.toUpperCase())
  const relatedParsed = parseRelatedField(frontmatter)
  const meta: ConceptMeta = {
    slug: fallbackSlug || slugifyConcept(asString(fm.english) || term),
    title,
    term,
    english: asString(fm.english),
    aliases: asStringArray(fm.aliases),
    field: asString(fm.field) || asString(fm.domain),
    groups,
    summary: asString(fm.summary),
    status,
    generatedBy: asString(fm.generatedBy),
    reviewedAt: asString(fm.reviewedAt),
    selectionSource: asString(fm.selectionSource) || undefined,
    outline: asString(fm.outline) || 'deep',
    related: relatedParsed.relations,
    ...(relatedParsed.problems.length > 0 ? { relatedProblems: relatedParsed.problems } : {}),
  }
  return { meta, body, raw, frontmatterRaw: frontmatter }
}

function quoteYamlString(val: string): string {
  const escaped = (val ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')
  return `"${escaped}"`
}

function formatYamlStringList(items: readonly string[]): string {
  return `[${items.map((x) => quoteYamlString(x)).join(', ')}]`
}

export function serializeConceptMarkdown(meta: ConceptMeta, body: string): string {
  const fmLines = [
    '---',
    `title: ${quoteYamlString(meta.title || meta.term)}`,
    `term: ${quoteYamlString(meta.term)}`,
    `english: ${quoteYamlString(meta.english)}`,
    `aliases: ${formatYamlStringList(meta.aliases)}`,
    `field: ${quoteYamlString(meta.field)}`,
    `groups: ${formatYamlStringList(meta.groups.map((g) => g.toUpperCase()))}`,
    `summary: ${quoteYamlString(meta.summary)}`,
    `status: ${meta.status}`,
    `generatedBy: ${quoteYamlString(meta.generatedBy)}`,
    `reviewedAt: ${quoteYamlString(meta.reviewedAt)}`,
  ]
  if (meta.selectionSource) {
    fmLines.push(`selectionSource: ${quoteYamlString(meta.selectionSource)}`)
  }
  fmLines.push(`outline: ${meta.outline || 'deep'}`)
  const relatedBlock = formatRelatedField(meta.related ?? [])
  if (relatedBlock) fmLines.push(relatedBlock)
  fmLines.push('---')

  let cleanBody = (body ?? '').replace(/^\r?\n+/, '').trimEnd()
  if (!/^#\s+/m.test(cleanBody)) {
    cleanBody = `# ${meta.term}\n\n${cleanBody}`.trimEnd()
  }
  return `${fmLines.join('\n')}\n\n${cleanBody}\n`
}

export function hasUnverifiedMarkers(rawMarkdown: string): { hasUnverified: boolean; lines: string[] } {
  const matched: string[] = []
  for (const line of (rawMarkdown ?? '').split(/\r?\n/)) {
    if (UNVERIFIED_RE.test(line)) {
      matched.push(line.trim())
    }
  }
  return { hasUnverified: matched.length > 0, lines: matched }
}

function formatSourceItem(source: string): string {
  const trimmed = source.trim()
  if (/^<span\s+class=["']cite["']/i.test(trimmed)) return trimmed
  const withMdLinks = trimmed.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    const text = label.trim() || url
    return `<span class="cite" data-cite="${url}" title="${url}">${text}</span>`
  })
  if (withMdLinks !== trimmed) return withMdLinks
  const urlMatch = /^(.*?)\s+(https?:\/\/\S+)$/.exec(trimmed)
  if (urlMatch) {
    const label = (urlMatch[1] ?? '').trim() || urlMatch[2]!
    const url = urlMatch[2]!
    return `<span class="cite" data-cite="${url}" title="${url}">${label}</span>`
  }
  if (/^https?:\/\/\S+$/.test(trimmed)) {
    return `<span class="cite" data-cite="${trimmed}" title="${trimmed}">${trimmed}</span>`
  }
  return trimmed.replace(/(https?:\/\/[^\s)）>\]"']+)/g, (url: string) => {
    return `<span class="cite" data-cite="${url}" title="${url}">${url}</span>`
  })
}

export interface DraftToMarkdownOptions {
  generatedBy?: string
  selectionSource?: string
  groupsOverride?: readonly string[]
}

export function draftPayloadToConceptMarkdown(
  payload: ConceptDraftPayload,
  opts: DraftToMarkdownOptions = {},
): string {
  const groups = (opts.groupsOverride && opts.groupsOverride.length > 0 ? opts.groupsOverride : payload.groups).map((g) =>
    g.toUpperCase(),
  )
  const sections: string[] = [`# ${payload.term}`]

  for (const para of payload.paragraphs) {
    const chunk: string[] = []
    if (para.heading.trim()) {
      chunk.push(`## ${para.heading.trim()}`)
    }
    let bodyText = para.body.trim()
    if (!para.verified && !UNVERIFIED_RE.test(bodyText)) {
      bodyText = `${bodyText}\n\n> **待核实**：${(para.unverifiedReason ?? '请作者核对讲义原文与权威出处').trim()}`
    } else if (!para.verified && para.unverifiedReason && !bodyText.includes(para.unverifiedReason.trim())) {
      bodyText = `${bodyText}\n\n> **待核实**：${para.unverifiedReason.trim()}`
    }
    chunk.push(bodyText)
    if (para.sources.length > 0) {
      const renderedSources = para.sources.map(formatSourceItem).join('；')
      chunk.push(`（出处：${renderedSources}）`)
    } else if (para.verified) {
      chunk.push(`> **待核实**：未附具体出处，请补充讲义或权威来源后再发布`)
    }
    sections.push(chunk.join('\n\n'))
  }

  const meta: ConceptMeta = {
    slug: payload.slug,
    title: payload.term,
    term: payload.term,
    english: payload.english,
    aliases: payload.aliases,
    field: payload.field,
    groups,
    summary: payload.summary,
    status: 'draft',
    generatedBy: opts.generatedBy ?? 'concept-draft@v2',
    reviewedAt: '',
    selectionSource: opts.selectionSource,
    outline: 'deep',
    related: Array.isArray(payload.related) ? payload.related : [],
  }

  return serializeConceptMarkdown(meta, sections.join('\n\n'))
}

export function countConceptSources(body: string): number {
  const text = body ?? ''
  const citeTags = text.match(/class=["']cite["']/g)?.length ?? 0
  const parenSources = text.match(/[（(](?:出处|来源)\s*[：:]/g)?.length ?? 0
  return Math.max(citeTags, parenSources)
}
