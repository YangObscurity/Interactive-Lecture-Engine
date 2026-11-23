/**
 * concepts/graph.ts - the concept graph: name normalisation, build checks, and the tier-bounded neighbourhood of a
 * concept (used by the page panels and by the per-tier tool files `tools/concepts.json`).
 *
 * Pure: no `fs`, no VitePress. The Node side (`concepts/node.mts`, `concepts/toolFiles.mts`) loads the records.
 *
 * Tier rule (one place, `neighbourhoodOf`): a reader of tier R may be told about a concept, lecture or relation of
 * tier C only if `canRead(R, C)` (concepts/access.ts `canReaderTierReadConcept`). Both the panels (R = the tier of
 * the page) and the tool files (R = the tier of the file) go through it, so neither can name stricter content.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes, Text } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'
import { canReaderTierReadConcept } from './access.ts'
import { splitMarkdownFrontmatter, type ConceptMeta } from './frontmatter.ts'
import {
  RELATION_ROLES,
  RELATION_ROLE_IN,
  RELATION_ROLE_OUT,
  type ConceptRelation,
  type RelationRole,
} from './related.ts'
import { computeMathRangesInBody, findAllConceptLinksInMarkdown } from './sourceRewriter.ts'

import { NAME_NOISE, normalizeConceptName } from './names.ts'

// ---- names -------------------------------------------------------------------------------------------------------

export { NAME_NOISE, normalizeConceptName }

export type ConceptNameKind = 'term' | 'title' | 'english' | 'alias'

export interface ConceptName {
  name: string
  kind: ConceptNameKind
  normalized: string
}

/** Every name a concept answers to: term, title, English name and aliases (empty and repeated ones dropped). */
export function conceptNamesOf(meta: Pick<ConceptMeta, 'term' | 'title' | 'english' | 'aliases'>): ConceptName[] {
  const out: ConceptName[] = []
  const seen = new Set<string>()
  const add = (name: string, kind: ConceptNameKind): void => {
    const trimmed = (name ?? '').trim()
    const normalized = normalizeConceptName(trimmed)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    out.push({ name: trimmed, kind, normalized })
  }
  add(meta.term, 'term')
  add(meta.title, 'title')
  add(meta.english, 'english')
  for (const a of meta.aliases ?? []) add(a, 'alias')
  return out
}

// ---- records seen by the checks ------------------------------------------------------------------------------------

export interface CheckedConcept {
  slug: string
  /** Path shown in messages, relative to the docs root (`concepts/foo.md`). */
  file: string
  meta: ConceptMeta
  /** Whole file (frontmatter included): line numbers in messages count from the first line. */
  raw: string
  tier: string
}

export interface ConceptCheckResult {
  errors: string[]
  warnings: string[]
}

export interface ConceptCheckOptions {
  canRead?: (readerTier: string, contentTier: string) => boolean
  /** Published concepts left out of a partial build (LECTURE_BUILD_GROUPS): naming them is not an error. */
  filteredOut?: ReadonlySet<string>
}

function lineAt(raw: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < raw.length; i++) if (raw.charCodeAt(i) === 10) line++
  return line
}

/** `related` entries: unknown relation type (reported by the parser), unknown slug, self relation, stricter tier. */
export function checkRelated(concepts: readonly CheckedConcept[], opts: ConceptCheckOptions = {}): string[] {
  const canRead = opts.canRead ?? canReaderTierReadConcept
  const bySlug = new Map(concepts.map((c) => [c.slug, c]))
  const errors: string[] = []
  for (const c of concepts) {
    for (const problem of c.meta.relatedProblems ?? []) errors.push(`[concepts] ${c.file}: ${problem}`)
    for (const r of c.meta.related ?? []) {
      if (r.slug === c.slug) {
        errors.push(`[concepts] ${c.file}: related: "${r.slug}" relates to itself`)
        continue
      }
      const target = bySlug.get(r.slug)
      if (!target && opts.filteredOut?.has(r.slug)) continue
      if (!target) {
        errors.push(`[concepts] ${c.file}: related: unknown concept "${r.slug}"`)
        continue
      }
      if (!canRead(c.tier, target.tier)) {
        errors.push(
          `[concepts] ${c.file}: related: "${r.slug}" (tier "${target.tier}") is stricter than this page (tier "${c.tier}") and cannot be named here`,
        )
      }
    }
  }
  return errors
}

/** Two concepts sharing a name or alias after normalisation; both files are reported. */
export function checkDuplicateNames(concepts: readonly CheckedConcept[]): string[] {
  const first = new Map<string, { concept: CheckedConcept; name: ConceptName }>()
  const errors: string[] = []
  const reported = new Set<string>()
  for (const c of concepts) {
    for (const n of conceptNamesOf(c.meta)) {
      const prev = first.get(n.normalized)
      if (!prev) {
        first.set(n.normalized, { concept: c, name: n })
        continue
      }
      if (prev.concept.slug === c.slug) continue
      const key = [prev.concept.slug, c.slug, n.normalized].join('|')
      if (reported.has(key)) continue
      reported.add(key)
      errors.push(
        `[concepts] duplicate concept name: ${prev.name.kind} "${prev.name.name}" of ${prev.concept.file} and ${n.kind} "${n.name}" of ${c.file} ` +
          `are the same name after normalising (NFKC, lower case, no whitespace or punctuation: "${n.normalized}")`,
      )
    }
  }
  return errors
}

/** `concept:` links inside concept pages: unknown slug, or a concept the page's own tier cannot read. */
export function checkConceptPageLinks(concepts: readonly CheckedConcept[], opts: ConceptCheckOptions = {}): string[] {
  const canRead = opts.canRead ?? canReaderTierReadConcept
  const bySlug = new Map(concepts.map((c) => [c.slug, c]))
  const errors: string[] = []
  for (const c of concepts) {
    for (const hit of findAllConceptLinksInMarkdown(c.raw)) {
      const target = bySlug.get(hit.slug)
      if (!target && opts.filteredOut?.has(hit.slug)) continue
      if (!target) {
        errors.push(`[concepts] ${c.file}:${hit.line}: unknown concept link "concept:${hit.slug}"`)
      } else if (!canRead(c.tier, target.tier)) {
        errors.push(
          `[concepts] ${c.file}:${hit.line}: tier "${c.tier}" cannot reference restricted concept "${hit.slug}" (tier "${target.tier}")`,
        )
      }
    }
  }
  return errors
}

export interface UnlinkedMention {
  line: number
  matched: string
}

/** Shortest name worth looking for: two CJK characters, or three characters of any other script. */
function searchable(name: string): boolean {
  const cjk = /[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(name)
  return Array.from(name).length >= (cjk ? 2 : 3)
}

const WORD = /[A-Za-z0-9_]/

function plainTextRangesOf(body: string): Array<{ start: number; end: number }> {
  const tree = fromMarkdown(body)
  const out: Array<{ start: number; end: number }> = []
  visit(tree, (node: Nodes) => {
    if (
      node.type === 'heading' ||
      node.type === 'code' ||
      node.type === 'inlineCode' ||
      node.type === 'html' ||
      node.type === 'link' ||
      node.type === 'linkReference' ||
      node.type === 'definition' ||
      node.type === 'yaml'
    ) {
      return SKIP
    }
    if (node.type === 'text') {
      const start = (node as Text).position?.start.offset
      const end = (node as Text).position?.end.offset
      if (start !== undefined && end !== undefined) out.push({ start, end })
    }
    return undefined
  })
  return out
}

/**
 * Places in the prose of `raw` where one of `names` occurs without being a link. Headings, code, math, link text and
 * HTML are skipped. Longer names win over shorter ones that sit inside them; ASCII names match case-insensitively and
 * only as whole words. `line` counts from the first line of the file.
 */
export function findUnlinkedMentions(raw: string, names: readonly string[]): UnlinkedMention[] {
  const { body, bodyStartOffset } = splitMarkdownFrontmatter(raw ?? '')
  const needles = [...new Set(names.map((n) => n.trim()).filter((n) => n && searchable(n)))].sort((a, b) => b.length - a.length)
  if (needles.length === 0 || !body.trim()) return []
  const math = computeMathRangesInBody(body)
  const overlapsMath = (s: number, e: number): boolean => math.some((r) => s < r.end && e > r.start)
  const taken: Array<{ start: number; end: number }> = []
  const hits: Array<UnlinkedMention & { at: number }> = []

  for (const range of plainTextRangesOf(body)) {
    const slice = body.slice(range.start, range.end)
    const lower = slice.toLowerCase()
    for (const needle of needles) {
      const needleLower = needle.toLowerCase()
      let from = 0
      while (from <= lower.length - needleLower.length) {
        const at = lower.indexOf(needleLower, from)
        if (at < 0) break
        from = at + Math.max(1, needleLower.length)
        const start = range.start + at
        const end = start + needle.length
        if (WORD.test(needle[0] as string) && at > 0 && WORD.test(slice[at - 1] as string)) continue
        if (WORD.test(needle[needle.length - 1] as string) && WORD.test(slice[at + needle.length] ?? '')) continue
        if (overlapsMath(start, end)) continue
        if (taken.some((t) => start < t.end && end > t.start)) continue
        taken.push({ start, end })
        hits.push({ at: start, line: lineAt(raw, bodyStartOffset + start), matched: body.slice(start, end) })
      }
    }
  }
  return hits.sort((a, b) => a.at - b.at).map(({ line, matched }) => ({ line, matched }))
}

/** Warning per place where a concept page names ANOTHER concept (term, English name, alias) without linking it. */
export function checkUnlinkedMentions(concepts: readonly CheckedConcept[]): string[] {
  const warnings: string[] = []
  for (const c of concepts) {
    const own = new Set(conceptNamesOf(c.meta).map((n) => n.normalized))
    const owners = new Map<string, { other: CheckedConcept; kind: ConceptNameKind; name: string }>()
    for (const other of concepts) {
      if (other.slug === c.slug) continue
      for (const n of conceptNamesOf(other.meta)) {
        if (own.has(n.normalized) || !searchable(n.name)) continue
        const key = n.name.toLowerCase()
        if (!owners.has(key)) owners.set(key, { other, kind: n.kind, name: n.name })
      }
    }
    if (owners.size === 0) continue
    for (const m of findUnlinkedMentions(c.raw, [...owners.values()].map((o) => o.name))) {
      const owner = owners.get(m.matched.toLowerCase())
      warnings.push(
        `[concepts] ${c.file}:${m.line}: mentions "${m.matched}"${owner ? ` (${owner.kind} of concept ${owner.other.slug})` : ''} without a link`,
      )
    }
  }
  return warnings
}

/** All concept checks over the published concepts of the build: errors fail the build, warnings are listed. */
export function checkConcepts(concepts: readonly CheckedConcept[], opts: ConceptCheckOptions = {}): ConceptCheckResult {
  return {
    errors: [...checkRelated(concepts, opts), ...checkDuplicateNames(concepts), ...checkConceptPageLinks(concepts, opts)],
    warnings: checkUnlinkedMentions(concepts),
  }
}

// ---- the graph ------------------------------------------------------------------------------------------------------

export interface GraphConceptInput {
  slug: string
  tier: string
  url: string
  meta: ConceptMeta
  /** Markdown without frontmatter. */
  body: string
}

export interface LectureCitation {
  route: string
  id: string
  title: string
  tier: string
  count: number
}

export interface GraphNode extends GraphConceptInput {
  /** `concept:` links of the body: known slugs other than itself, in order of first appearance. */
  links: string[]
  /** Relations written on this concept (targets that exist; self relations dropped). */
  related: ConceptRelation[]
  /** Relations other concepts wrote about this one. */
  inbound: Array<{ from: string; rel: ConceptRelation['rel'] }>
  /** Concepts whose body links here. */
  backlinks: string[]
  lectures: LectureCitation[]
}

export interface ConceptGraph {
  nodes: Map<string, GraphNode>
  canRead: (readerTier: string, contentTier: string) => boolean
}

export function buildConceptGraph(
  concepts: readonly GraphConceptInput[],
  citations: ReadonlyMap<string, readonly LectureCitation[]>,
  canRead: (readerTier: string, contentTier: string) => boolean = canReaderTierReadConcept,
): ConceptGraph {
  const nodes = new Map<string, GraphNode>()
  for (const c of concepts) {
    nodes.set(c.slug, { ...c, links: [], related: [], inbound: [], backlinks: [], lectures: [...(citations.get(c.slug) ?? [])] })
  }
  for (const node of nodes.values()) {
    const seen = new Set<string>()
    for (const hit of findAllConceptLinksInMarkdown(node.body)) {
      if (hit.slug === node.slug || seen.has(hit.slug) || !nodes.has(hit.slug)) continue
      seen.add(hit.slug)
      node.links.push(hit.slug)
    }
    node.related = (node.meta.related ?? []).filter((r) => r.slug !== node.slug && nodes.has(r.slug))
  }
  for (const node of nodes.values()) {
    for (const r of node.related) (nodes.get(r.slug) as GraphNode).inbound.push({ from: node.slug, rel: r.rel })
    for (const target of node.links) (nodes.get(target) as GraphNode).backlinks.push(node.slug)
  }
  for (const node of nodes.values()) {
    node.backlinks.sort()
    node.inbound.sort((a, b) => a.from.localeCompare(b.from) || a.rel.localeCompare(b.rel))
    node.lectures.sort((a, b) => a.id.localeCompare(b.id) || a.route.localeCompare(b.route))
  }
  return { nodes, canRead }
}

export interface RelatedGroupSlugs {
  role: RelationRole
  slugs: string[]
}

export interface Neighbourhood {
  /** Outgoing relations a reader of `readerTier` may be told about (the concept's own `related`). */
  related: ConceptRelation[]
  /** Both directions merged by role, in the fixed order of RELATION_ROLES; empty roles left out. */
  roles: RelatedGroupSlugs[]
  links: string[]
  backlinks: string[]
  lectures: LectureCitation[]
}

/** What `readerTier` may be told about concept `slug`: every neighbour of a stricter tier is left out. */
export function neighbourhoodOf(graph: ConceptGraph, slug: string, readerTier: string): Neighbourhood {
  const node = graph.nodes.get(slug)
  const empty: Neighbourhood = { related: [], roles: [], links: [], backlinks: [], lectures: [] }
  if (!node) return empty
  const readable = (other: string): boolean => {
    const n = graph.nodes.get(other)
    return Boolean(n) && graph.canRead(readerTier, (n as GraphNode).tier)
  }
  const related = node.related.filter((r) => readable(r.slug))
  const byRole = new Map<RelationRole, Set<string>>()
  const put = (role: RelationRole, other: string): void => {
    const set = byRole.get(role) ?? new Set<string>()
    set.add(other)
    byRole.set(role, set)
  }
  for (const r of related) put(RELATION_ROLE_OUT[r.rel], r.slug)
  // a pair written on both pages (A lists B, B lists A) shows the other concept once, under this page's own relation
  const listedHere = new Set(related.map((r) => r.slug))
  for (const i of node.inbound) if (readable(i.from) && !listedHere.has(i.from)) put(RELATION_ROLE_IN[i.rel], i.from)
  const roles: RelatedGroupSlugs[] = []
  for (const role of RELATION_ROLES) {
    const set = byRole.get(role)
    if (set && set.size > 0) roles.push({ role, slugs: [...set].sort() })
  }
  return {
    related,
    roles,
    links: node.links.filter(readable),
    backlinks: node.backlinks.filter(readable),
    lectures: node.lectures.filter((l) => graph.canRead(readerTier, l.tier)),
  }
}

// ---- page panels -----------------------------------------------------------------------------------------------------

export interface PanelConcept {
  slug: string
  term: string
  summary: string
  url: string
}

export interface PanelLecture {
  route: string
  id: string
  title: string
  count: number
}

/** `frontmatter.conceptPanels` of a concept page: three lists, each omitted (empty) when there is nothing to show. */
export interface ConceptPanels {
  related: Array<{ role: RelationRole; items: PanelConcept[] }>
  backlinks: PanelConcept[]
  lectures: PanelLecture[]
}

export function conceptPanelsOf(graph: ConceptGraph, slug: string, pageTier: string): ConceptPanels {
  const hood = neighbourhoodOf(graph, slug, pageTier)
  const item = (s: string): PanelConcept => {
    const n = graph.nodes.get(s) as GraphNode
    return { slug: s, term: n.meta.term, summary: n.meta.summary, url: n.url }
  }
  return {
    related: hood.roles.map((g) => ({ role: g.role, items: g.slugs.map(item) })),
    backlinks: hood.backlinks.map(item),
    lectures: hood.lectures.map((l) => ({ route: l.route, id: l.id, title: l.title, count: l.count })),
  }
}
