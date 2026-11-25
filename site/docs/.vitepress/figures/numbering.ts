/**
 * figures/numbering.ts - the one per-page figure numbering (S6Y, user decision 2026-11-23 21:47, s6y/DECISIONS.md).
 *
 * In one lecture, charts (`<figure class="chart">`) and figure-pack figures (`<LectureFigure>`) share one sequence
 * "图 <lecture>-<n>" in the order they appear on the page; tables (`kind: 'table'`) have their own "表 <lecture>-<n>"; a page
 * without a lecture number uses "图 <n>". The numbers are assigned at build time only (figures/markdown.ts writes them into
 * the `<LectureFigure encoded>` payload, the `[](fig:id)` link text and `data-fig-*` attributes on each chart figure); the
 * chart runtime (charts/page.ts, charts/frameSlot.ts) and the viewer only read them, and the search index
 * (search/figureLabels.ts) runs the same numbering over the markdown source so its labels match the page.
 *
 * The paper's own figure number (`source.number` in figures.json, e.g. "Fig. 3") is never replaced: it stays in the source
 * line ("出处：<论文>，原文 Fig. 3，第 2 页", registry.ts). Figure numbers authors wrote by hand in the prose are not rewritten.
 */
import type { FigureKind } from './types.ts'

/** One `<LectureFigure …/>` tag or one `<figure …>` opening tag, in source order. */
export interface FigureMarkupHit {
  type: 'lecture-figure' | 'chart'
  /** offset of the match in the scanned string */
  index: number
  /** the full matched text */
  text: string
  /** the attribute string of the tag */
  attrs: string
}

// `<LectureFigure …/>` (self-closing or with an empty close tag) | `<figure …>` (lower case, the chart contract)
const FIGURE_MARKUP_RE = /<LectureFigure\b([^>]*?)(?:\/>|><\/LectureFigure>)|<figure\b([^>]*)>/g

/** Whether a `<figure>` attribute string carries the class token `chart` (and not only `chart--modal` and the like). */
export function isChartFigureAttrs(attrs: string): boolean {
  const m = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
  const cls = m?.[1] ?? m?.[2] ?? ''
  const tokens = cls.split(/\s+/)
  return tokens.includes('chart') && !tokens.includes('chart--modal')
}

/** Every `<LectureFigure>` tag and chart `<figure>` opening tag in `html`, in order. Other `<figure>` tags are skipped. */
export function scanFigureMarkup(html: string): FigureMarkupHit[] {
  const out: FigureMarkupHit[] = []
  if (!html.includes('<LectureFigure') && !html.includes('<figure')) return out
  for (const m of html.matchAll(FIGURE_MARKUP_RE)) {
    if (m[1] !== undefined || m[0].startsWith('<LectureFigure')) {
      out.push({ type: 'lecture-figure', index: m.index ?? 0, text: m[0], attrs: m[1] ?? '' })
    } else if (isChartFigureAttrs(m[2] ?? '')) {
      out.push({ type: 'chart', index: m.index ?? 0, text: m[0], attrs: m[2] ?? '' })
    }
  }
  return out
}

/** Whether `html` contains markup the numbering looks at (cheap pre-check). */
export function hasFigureMarkup(html: string): boolean {
  return html.includes('<LectureFigure') || html.includes('<figure')
}

/** Lecture number of a page path (`mea/L05.md`, `en/log/L01.md` → 5, 1); 0 for pages that are not lectures. */
export function lectureNoOfPage(relPath: string): number {
  const m = /(?:^|\/)L(\d+)\.md$/i.exec(relPath.replace(/\\/g, '/'))
  return m?.[1] ? Number(m[1]) : 0
}

/**
 * The visible label: "图 5-2" / "表 5-1" (zh), "Fig. 5-2" / "Table 5-1" (en); without a lecture number "图 2" / "Fig. 2".
 * Same wording as the i18n keys `lecture.fig.numbered` / `lecture.fig.plain`.
 */
export function formatFigureNumberLabel(kind: FigureKind, num: number, localeKey: string, lectureNo = 0): string {
  const n = lectureNo > 0 ? `${lectureNo}-${num}` : String(num)
  if (localeKey === 'en') return kind === 'table' ? `Table ${n}` : `Fig. ${n}`
  return kind === 'table' ? `表 ${n}` : `图 ${n}`
}

/** Label of a gallery spanning `first`..`last` of one kind: "图 6-1–6-2" (a single number when they are the same). */
export function formatFigureRangeLabel(kind: FigureKind, first: number, last: number, localeKey: string, lectureNo = 0): string {
  const a = formatFigureNumberLabel(kind, first, localeKey, lectureNo)
  if (first === last) return a
  const b = lectureNo > 0 ? `${lectureNo}-${last}` : String(last)
  return `${a}–${b}`
}

/** The per-page counters: one shared by charts and figures, one for tables. */
export class FigureNumbering {
  private readonly counters: Record<FigureKind, number> = { figure: 0, table: 0 }
  private readonly byKey = new Map<string, { kind: FigureKind; num: number }>()

  constructor(
    readonly lectureNo: number,
    readonly localeKey: string,
  ) {}

  /** The next number of `kind` (charts are `figure`). */
  next(kind: FigureKind): number {
    this.counters[kind] += 1
    return this.counters[kind]
  }

  /** Number of a keyed figure-pack entry: its first appearance assigns it, later appearances reuse it. */
  numberOf(key: string, kind: FigureKind): number {
    const hit = this.byKey.get(key)
    if (hit) return hit.num
    const num = this.next(kind)
    this.byKey.set(key, { kind, num })
    return num
  }

  has(key: string): boolean {
    return this.byKey.has(key)
  }

  get(key: string): { kind: FigureKind; num: number } | undefined {
    return this.byKey.get(key)
  }

  label(kind: FigureKind, num: number): string {
    return formatFigureNumberLabel(kind, num, this.localeKey, this.lectureNo)
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Add the build-time number to a chart `<figure …>` opening tag: `data-fig-no` (sequence number), `data-fig-lec`
 * (lecture number, 0 when none) and `data-fig-label` (the final label). A tag that already has `data-fig-no` is kept.
 */
export function annotateChartFigureTag(tag: string, num: number, lectureNo: number, label: string): string {
  if (/\bdata-fig-no\s*=/.test(tag)) return tag
  const attrs = ` data-fig-no="${num}" data-fig-lec="${lectureNo}" data-fig-label="${escapeAttr(label)}"`
  return tag.replace(/\s*>$/, `${attrs}>`)
}

export type InlineMermaidMode = 'all' | 'chart-only' | 'none'

export const INLINE_MERMAID_META_CLASS = 'lec-mermaid-num'

/** Extract normalized fence language token matching VitePress preWrapper rules (`mermaid:line-numbers` -> `mermaid`). */
export function isInlineMermaidInfo(info: string, mode: InlineMermaidMode = 'all'): boolean {
  if (mode === 'none') return false
  const cleaned = (info || '')
    .trim()
    .replace(/=\d*/, '')
    .replace(/:(no-)?line-numbers(?:[{ ]|$|=\d*).*/, '')
    .replace(/(?:-vue|\{| ).*$/, '')
  if (mode === 'chart-only') return cleaned === 'mermaid:chart'
  return cleaned === 'mermaid' || cleaned === 'mermaid:chart'
}

/** Build-time hidden anchor placed immediately before an inline mermaid fence so runtime charts/page.ts preserves sequence numbers. */
export function renderInlineMermaidMetaTag(num: number, lectureNo: number, label: string): string {
  return `<span class="${INLINE_MERMAID_META_CLASS}" data-fig-no="${num}" data-fig-lec="${lectureNo}" data-fig-label="${escapeAttr(label)}" hidden></span>`
}
