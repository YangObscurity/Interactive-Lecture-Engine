/**
 * search/figureLabels.ts - resolve `[](fig:id)` / `[](tab:id)` in a page's markdown to the label the page shows
 * ("图 5-2", "表 5-1"), before the search index cuts the prose into snippets (S6Y audit-spec #13: snippets showed the raw
 * `[](fig:mea-ruler)`).
 *
 * The numbering is the page's own (figures/numbering.ts, the same rules figures/markdown.ts applies at build time): charts
 * and `<LectureFigure>` in order of appearance share one sequence, tables have their own, cited-but-not-mounted figures come
 * after. Code blocks and inline code are ignored (mdast). A link with its own text keeps that text.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { visit } from 'unist-util-visit'
import { resolveContent } from '../content/paths.mts'
import { parseLectureFigureTagAttrs, splitFigureTarget } from '../figures/markdown.ts'
import { FigureNumbering, isInlineMermaidInfo, lectureNoOfPage, scanFigureMarkup, type InlineMermaidMode } from '../figures/numbering.ts'
import { CHART_INLINE_MERMAID } from '../site.config.mts'
import { loadGroupRegistry, type LoadedGroupRegistry } from '../figures/registry.ts'
import type { FigureKind } from '../figures/types.ts'

/** Kind of a figure-pack entry (`figure` / `table`), or undefined when it can't be looked up. */
export type FigureKindLookup = (group: string, id: string) => FigureKind | undefined

/** Registry-backed lookup (lazy, one registry per group). Without a figures directory every lookup is undefined. */
export function createFigureKindLookup(figuresDir: string | undefined): FigureKindLookup {
  const cache = new Map<string, LoadedGroupRegistry | null>()
  return (group, id) => {
    if (!figuresDir || !group) return undefined
    if (!cache.has(group)) {
      try {
        cache.set(group, loadGroupRegistry(group, { figuresDir }))
      } catch {
        cache.set(group, null)
      }
    }
    return cache.get(group)?.byId.get(id)?.kind
  }
}

/** The content's figures directory (`content/paths.mts`), or undefined when the content root can't be resolved. */
export function defaultFiguresDir(): string | undefined {
  try {
    return resolveContent().figuresDir
  } catch {
    return undefined
  }
}

export interface ResolveFigureXrefsOptions {
  /** page path relative to the docs root, e.g. `mea/L05.md`, `en/log/L01.md` (gives the lecture number) */
  relPath: string
  /** the page's group directory (`mea`), null for pages outside a group */
  pageGroup: string | null
  /** `en` for English pages, '' for the root locale */
  localeKey: string
  kindOf: FigureKindLookup
}

interface XrefHit {
  start: number
  end: number
  key: string
  kind: FigureKind
  empty: boolean
}

/** `md` with every empty `[](fig:id)` / `[](tab:id)` replaced by its label; other text unchanged. */
export function resolveFigureXrefsForSearch(md: string, opts: ResolveFigureXrefsOptions): string {
  if (!md.includes('](fig:') && !md.includes('](tab:')) return md
  const numbering = new FigureNumbering(lectureNoOfPage(opts.relPath), opts.localeKey)
  const inlineMode: InlineMermaidMode = !CHART_INLINE_MERMAID.enabled
    ? 'none'
    : (CHART_INLINE_MERMAID.selectors as readonly string[]).some((s) => s.includes('language-mermaid') && !s.includes(':chart'))
      ? 'all'
      : 'chart-only'
  const group = opts.pageGroup ?? ''
  const xrefs: XrefHit[] = []
  const tree = fromMarkdown(md)
  visit(tree, (node) => {
    if (node.type === 'code') {
      const info = [node.lang, node.meta].filter(Boolean).join(' ')
      if (isInlineMermaidInfo(info, inlineMode)) {
        numbering.next('figure')
      }
    } else if (node.type === 'html') {
      for (const hit of scanFigureMarkup(node.value)) {
        if (hit.type === 'chart') {
          numbering.next('figure')
          continue
        }
        let ids: string[] = []
        try {
          ids = parseLectureFigureTagAttrs(hit.attrs)?.ids ?? []
        } catch {
          ids = []
        }
        for (const raw of ids) {
          const t = splitFigureTarget(raw, group)
          numbering.numberOf(`${t.group}:${t.id}`, opts.kindOf(t.group, t.id) ?? 'figure')
        }
      }
    } else if (node.type === 'link') {
      const url = node.url || ''
      const kind: FigureKind | null = url.startsWith('fig:') ? 'figure' : url.startsWith('tab:') ? 'table' : null
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (!kind || start === undefined || end === undefined) return
      const t = splitFigureTarget(url.slice(4), group)
      xrefs.push({ start, end, key: `${t.group}:${t.id}`, kind, empty: node.children.length === 0 })
    }
  })
  if (xrefs.length === 0) return md
  for (const x of xrefs) numbering.numberOf(x.key, x.kind)
  let out = md
  for (const x of [...xrefs].sort((a, b) => b.start - a.start)) {
    if (!x.empty) continue
    const rec = numbering.get(x.key)
    const label = rec ? numbering.label(rec.kind, rec.num) : ''
    out = out.slice(0, x.start) + label + out.slice(x.end)
  }
  return out
}
