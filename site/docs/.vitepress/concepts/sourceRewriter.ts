/**
 * concepts/sourceRewriter.ts - AST-based occurrence locator, diff builder, and concept link rewriter.
 *
 * Uses `mdast-util-from-markdown` + `unist-util-visit` to traverse lecture prose without regex-over-Markdown,
 * and `diff` (jsdiff) to build source patches shown to authors prior to writing.
 */
import { createTwoFilesPatch, structuredPatch } from 'diff'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Heading, Link, Nodes, PhrasingContent, Text } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'
import { splitMarkdownFrontmatter } from './frontmatter.ts'

export interface TextRange {
  start: number
  end: number
}

export interface OccurrenceCandidate {
  index: number
  startOffset: number
  endOffset: number
  line: number
  column: number
  heading: string
  before: string
  matchedText: string
  after: string
  snippet: string
  contextScore: number
  exactContextMatch: boolean
}

export interface LocateOccurrencesOptions {
  markdown: string
  selectedText: string
  aliases?: readonly string[]
  sectionHeading?: string
  beforeContext?: string
  afterContext?: string
}

export interface LocateOccurrencesResult {
  status: 'none' | 'unique' | 'needs_choice'
  candidates: OccurrenceCandidate[]
  recommendedIndex: number | null
  exactContextMatchCount: number
}

export interface SourceEdit {
  startOffset: number
  endOffset: number
  replacement: string
}

export interface DiffResult {
  nextMarkdown: string
  patch: string
  hunks: ReturnType<typeof structuredPatch>['hunks']
}

export interface ConceptLinkOccurrence {
  index: number
  startOffset: number
  endOffset: number
  line: number
  column: number
  innerMarkdown: string
  snippet: string
}

function lineColAt(source: string, offset: number): { line: number; column: number } {
  const prefix = source.slice(0, offset)
  const lines = prefix.split(/\r?\n/)
  const line = lines.length
  const column = (lines[lines.length - 1]?.length ?? 0) + 1
  return { line, column }
}

function extractNodePlainText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') return node.value
  if ('children' in node && Array.isArray(node.children)) {
    return (node.children as Nodes[]).map(extractNodePlainText).join('')
  }
  return ''
}

/** Identify TeX math spans (`$$...$$`, `\[...\]`, `\(...\)`) inside body text so edits never land inside formulas. */
export function computeMathRangesInBody(body: string): TextRange[] {
  const ranges: TextRange[] = []
  let i = 0
  while (i < body.length) {
    if (body[i] === '\\' && body[i + 1] === '(') {
      const end = body.indexOf('\\)', i + 2)
      if (end > i) {
        ranges.push({ start: i, end: end + 2 })
        i = end + 2
        continue
      }
    }
    if (body[i] === '\\' && body[i + 1] === '[') {
      const end = body.indexOf('\\]', i + 2)
      if (end > i) {
        ranges.push({ start: i, end: end + 2 })
        i = end + 2
        continue
      }
    }
    if (body[i] === '$' && body[i + 1] === '$' && body[i - 1] !== '\\') {
      const end = body.indexOf('$$', i + 2)
      if (end > i) {
        ranges.push({ start: i, end: end + 2 })
        i = end + 2
        continue
      }
    }
    i++
  }
  return ranges
}

function overlapsMath(ranges: readonly TextRange[], start: number, end: number): boolean {
  return ranges.some((r) => start < r.end && end > r.start)
}

function makeSnippet(source: string, start: number, end: number): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextNl = source.indexOf('\n', end)
  const lineEnd = nextNl === -1 ? source.length : nextNl
  const lineText = source.slice(lineStart, lineEnd).trim()
  if (lineText.length <= 140) return lineText
  const relStart = start - lineStart
  const sliceStart = Math.max(0, relStart - 45)
  const sliceEnd = Math.min(lineText.length, relStart + (end - start) + 45)
  return `${sliceStart > 0 ? '…' : ''}${lineText.slice(sliceStart, sliceEnd)}${sliceEnd < lineText.length ? '…' : ''}`
}

function overlapsTablePipeBoundary(body: string, start: number, end: number): boolean {
  const slice = body.slice(start, end)
  return slice.includes('|')
}

export function locateOccurrencesInLecture(opts: LocateOccurrencesOptions): LocateOccurrencesResult {
  const raw = opts.markdown ?? ''
  const target = (opts.selectedText ?? '').trim()
  if (!target) {
    return { status: 'none', candidates: [], recommendedIndex: null, exactContextMatchCount: 0 }
  }

  const { body, bodyStartOffset } = splitMarkdownFrontmatter(raw)
  const tree = fromMarkdown(body)
  const mathRanges = computeMathRangesInBody(body)

  const needles = [target]
  for (const a of opts.aliases ?? []) {
    const trimmed = a.trim()
    if (trimmed && !needles.includes(trimmed)) needles.push(trimmed)
  }

  const beforeCtx = (opts.beforeContext ?? '').trimEnd()
  const afterCtx = (opts.afterContext ?? '').trimStart()
  const wantedHeading = (opts.sectionHeading ?? '').trim()

  const candidates: OccurrenceCandidate[] = []
  let activeHeading = ''

  const scanTextNode = (node: Text): void => {
    const startBase = node.position?.start.offset
    const endBase = node.position?.end.offset
    if (startBase === undefined || endBase === undefined) return
    const slice = body.slice(startBase, endBase)
    for (const needle of needles) {
      let from = 0
      while (from < slice.length) {
        const hitAt = slice.indexOf(needle, from)
        if (hitAt === -1) break
        const bodyStart = startBase + hitAt
        const bodyEnd = bodyStart + needle.length
        from = hitAt + needle.length

        if (overlapsMath(mathRanges, bodyStart, bodyEnd)) continue
        if (overlapsTablePipeBoundary(body, bodyStart, bodyEnd)) continue

        const absStart = bodyStartOffset + bodyStart
        const absEnd = bodyStartOffset + bodyEnd
        const { line, column } = lineColAt(raw, absStart)
        const before = body.slice(Math.max(0, bodyStart - 40), bodyStart)
        const after = body.slice(bodyEnd, Math.min(body.length, bodyEnd + 40))

        let score = 0
        if (wantedHeading && activeHeading && activeHeading.includes(wantedHeading)) score += 3
        const normalizeInlineCtx = (s: string) => s.replace(/[*_~`]+/g, '').replace(/\s+/g, ' ')
        const beforeSuffix = normalizeInlineCtx(beforeCtx).trimEnd().slice(-20)
        const afterPrefix = normalizeInlineCtx(afterCtx).trimStart().slice(0, 20)
        const normBefore = normalizeInlineCtx(before).trimEnd()
        const normAfter = normalizeInlineCtx(after).trimStart()
        const beforeMatch = beforeSuffix.length >= 2 && normBefore.endsWith(beforeSuffix)
        const afterMatch = afterPrefix.length >= 2 && normAfter.startsWith(afterPrefix)
        if (beforeMatch) score += 2
        if (afterMatch) score += 2
        const exactContextMatch = Boolean((beforeMatch && afterMatch) || (beforeMatch && !afterPrefix) || (afterMatch && !beforeSuffix))

        candidates.push({
          index: candidates.length,
          startOffset: absStart,
          endOffset: absEnd,
          line,
          column,
          heading: activeHeading,
          before,
          matchedText: body.slice(bodyStart, bodyEnd),
          after,
          snippet: makeSnippet(body, bodyStart, bodyEnd),
          contextScore: score,
          exactContextMatch,
        })
      }
      if (candidates.length > 0 && needle === target) {
        break
      }
    }
  }

  visit(tree, (node: Nodes) => {
    if (node.type === 'heading') {
      activeHeading = extractNodePlainText(node as Heading).trim()
      return SKIP
    }
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html' || node.type === 'link') {
      return SKIP
    }
    if (node.type === 'text') {
      scanTextNode(node)
    }
    return undefined
  })

  if (candidates.length === 0) {
    return { status: 'none', candidates: [], recommendedIndex: null, exactContextMatchCount: 0 }
  }
  if (candidates.length === 1) {
    return {
      status: 'unique',
      candidates,
      recommendedIndex: 0,
      exactContextMatchCount: 1,
    }
  }

  const exactMatches = candidates.filter((c) => c.exactContextMatch)
  if (exactMatches.length === 1) {
    return {
      status: 'unique',
      candidates,
      recommendedIndex: exactMatches[0]!.index,
      exactContextMatchCount: 1,
    }
  }

  let best: OccurrenceCandidate | null = null
  let tie = false
  for (const c of candidates) {
    if (!best || c.contextScore > best.contextScore) {
      best = c
      tie = false
    } else if (c.contextScore === best.contextScore) {
      tie = true
    }
  }
  const recommendedIndex = best && !tie && best.contextScore > 0 ? best.index : null

  return {
    status: 'needs_choice',
    candidates,
    recommendedIndex,
    exactContextMatchCount: exactMatches.length,
  }
}

export function applySourceEdits(
  markdown: string,
  edits: readonly SourceEdit[],
  filePathLabel = 'lecture.md',
): DiffResult {
  const sorted = [...edits].sort((a, b) => b.startOffset - a.startOffset)
  let nextMarkdown = markdown
  for (const edit of sorted) {
    nextMarkdown =
      nextMarkdown.slice(0, edit.startOffset) + edit.replacement + nextMarkdown.slice(edit.endOffset)
  }
  const patch = createTwoFilesPatch(filePathLabel, filePathLabel, markdown, nextMarkdown, 'before', 'after', {
    context: 2,
  })
  const sp = structuredPatch(filePathLabel, filePathLabel, markdown, nextMarkdown, 'before', 'after', {
    context: 2,
  })
  return { nextMarkdown, patch, hunks: sp.hunks }
}

export function buildMountConceptDiff(
  markdown: string,
  slug: string,
  selectedRanges: readonly TextRange[],
  filePathLabel = 'lecture.md',
): DiffResult {
  const edits: SourceEdit[] = selectedRanges.map((r) => ({
    startOffset: r.start,
    endOffset: r.end,
    replacement: `[${markdown.slice(r.start, r.end)}](concept:${slug})`,
  }))
  return applySourceEdits(markdown, edits, filePathLabel)
}

function conceptSlugFromUrl(url: string): string | null {
  if (!url.startsWith('concept:')) return null
  const raw = url.slice('concept:'.length).split('#')[0]?.trim() ?? ''
  return raw || null
}

function extractRawInnerLinkText(body: string, node: Link): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start !== undefined && end !== undefined) {
    const raw = body.slice(start, end)
    if (raw.startsWith('[')) {
      const targetIdx = raw.lastIndexOf(`](${node.url}`)
      if (targetIdx > 0) {
        return raw.slice(1, targetIdx)
      }
      const closeBracket = raw.lastIndexOf('](')
      if (closeBracket > 0) return raw.slice(1, closeBracket)
    }
  }
  return (node.children as PhrasingContent[]).map((c) => extractNodePlainText(c as Nodes)).join('')
}

export function findAllConceptLinksInMarkdown(markdown: string): Array<{ slug: string } & ConceptLinkOccurrence> {
  const raw = markdown ?? ''
  if (!raw.includes('concept:')) return []
  const { body, bodyStartOffset } = splitMarkdownFrontmatter(raw)
  const tree = fromMarkdown(body)
  const out: Array<{ slug: string } & ConceptLinkOccurrence> = []

  visit(tree, (node: Nodes) => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html') return SKIP
    if (node.type !== 'link') return undefined
    const slug = conceptSlugFromUrl(node.url)
    if (!slug) return SKIP
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return SKIP
    const absStart = bodyStartOffset + start
    const absEnd = bodyStartOffset + end
    const { line, column } = lineColAt(raw, absStart)
    out.push({
      index: out.length,
      slug,
      startOffset: absStart,
      endOffset: absEnd,
      line,
      column,
      innerMarkdown: extractRawInnerLinkText(body, node),
      snippet: makeSnippet(body, start, end),
    })
    return SKIP
  })

  return out
}

export function findConceptLinksInMarkdown(markdown: string, slug: string): ConceptLinkOccurrence[] {
  return findAllConceptLinksInMarkdown(markdown)
    .filter((hit) => hit.slug === slug)
    .map(({ slug: _slug, ...rest }, idx) => ({ ...rest, index: idx }))
}

export function unlinkConceptInMarkdown(
  markdown: string,
  slug: string,
  filePathLabel = 'lecture.md',
): { removedCount: number } & DiffResult {
  const hits = findConceptLinksInMarkdown(markdown, slug)
  if (hits.length === 0) {
    return { removedCount: 0, nextMarkdown: markdown, patch: '', hunks: [] }
  }
  const edits: SourceEdit[] = hits.map((h) => ({
    startOffset: h.startOffset,
    endOffset: h.endOffset,
    replacement: h.innerMarkdown,
  }))
  const diff = applySourceEdits(markdown, edits, filePathLabel)
  return { removedCount: hits.length, ...diff }
}
