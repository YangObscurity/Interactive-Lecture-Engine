/**
 * Build-time markdown compiler & scanner for `<LectureFigure ... />` and `[](fig:id)` / `[](tab:id)` (WP-F8).
 *
 * Design:
 * - Resolves registries strictly from `paths.mts` (`figuresDir`).
 * - Assigns sequential per-lecture numbers separately for `figure` (`图 N` / `Fig. N`) and `table` (`表 N` / `Table N`).
 * - Replaces empty `[](fig:id)` / `[](tab:id)` link text with the SSR final label (preserving custom link text).
 * - Fails the build on unknown id, kind mismatch (`fig:` vs `tab:`), or public-tier citing a restricted-tier figure.
 * - Embeds resolved metadata only into the `<LectureFigure encoded="...">` & `.lec-xref` tags of that specific page,
 *   so non-figure pages load zero figure registries and public outputs contain zero restricted figure metadata.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { visit } from 'unist-util-visit'
import type { AccessPlan } from '../access/tiers.ts'
import type { ContentPaths } from '../content/paths.mts'
import {
  formatFigureSource,
  loadGroupRegistry,
  localizeFigureCaption,
  resolveGroupForPage,
  type LoadedGroupRegistry,
} from './registry.ts'
import {
  FigureNumbering,
  annotateChartFigureTag,
  formatFigureNumberLabel,
  hasFigureMarkup,
  isInlineMermaidInfo,
  lectureNoOfPage,
  renderInlineMermaidMetaTag,
  scanFigureMarkup,
  type InlineMermaidMode,
} from './numbering.ts'
import { CHART_INLINE_MERMAID } from '../site.config.mts'
import type {
  FigureBacklink,
  FigureEntry,
  FigureFloat,
  FigureHoverPreviewPayload,
  FigureKind,
  FigureSize,
  ResolvedFigureItem,
  ResolvedFigureMountProps,
} from './types.ts'

export interface FigureTagInvocation {
  ids: string[]
  size?: FigureSize
  float?: FigureFloat
}

export interface LectureCitationRef {
  kind: FigureKind | 'mount'
  targetGroup: string
  id: string
}

export interface FiguresMarkdownOptions {
  paths: Pick<ContentPaths, 'figuresDir'>
  groupDirs: readonly string[]
  groupIdByDir: ReadonlyMap<string, string>
  localeKeys: readonly string[]
  accessPlan: AccessPlan
  isBuild: boolean
  /** How fenced mermaid blocks participate in per-page figure numbering (default matches CHART_INLINE_MERMAID). */
  inlineMermaid?: InlineMermaidMode
  /** Optional sink collecting warnings across compiled pages (e.g., unused figures). */
  onWarning?: (msg: string) => void
}

function defaultInlineMermaidMode(): InlineMermaidMode {
  if (!CHART_INLINE_MERMAID.enabled) return 'none'
  const sels = CHART_INLINE_MERMAID.selectors as readonly string[]
  return sels.some((s) => s.includes('language-mermaid') && !s.includes(':chart')) ? 'all' : 'chart-only'
}

interface MarkdownItTokenLike {
  type: string
  tag: string
  nesting: number
  info?: string
  content: string
  children?: MarkdownItTokenLike[] | null
  attrGet(name: string): string | number | null
  attrSet(name: string, value: string): void
}

interface MarkdownItStateLike {
  tokens: MarkdownItTokenLike[]
  env: unknown
  Token: new (type: string, tag: string, nesting: -1 | 0 | 1) => MarkdownItTokenLike
}

const LECTURE_FIGURE_TAG_RE = /<LectureFigure\b([^>]*?)(?:\/>|><\/LectureFigure>)/g

export function parseLectureFigureTagAttrs(attrStr: string): FigureTagInvocation | null {
  const getAttr = (name: string): string | undefined => {
    const dq = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrStr)
    if (dq) return dq[1]
    const sq = new RegExp(`(?:^|\\s)${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrStr)
    if (sq) return sq[1]
    return undefined
  }

  const singleId = getAttr('id')
  const boundIds = getAttr(':ids')
  const plainIds = getAttr('ids')

  const ids: string[] = []
  if (singleId?.trim()) {
    ids.push(singleId.trim())
  } else if (boundIds?.trim()) {
    const raw = boundIds.trim()
    try {
      const normalizedJson = raw.startsWith('[') && raw.includes("'") ? raw.replace(/'/g, '"') : raw
      const parsed = JSON.parse(normalizedJson) as unknown
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string' && item.trim()) ids.push(item.trim())
        }
      }
    } catch {
      return null
    }
  } else if (plainIds?.trim()) {
    for (const part of plainIds.split(',')) {
      if (part.trim()) ids.push(part.trim())
    }
  }

  if (ids.length === 0) return null

  const sizeRaw = getAttr('size')?.trim()
  let size: FigureSize | undefined
  if (sizeRaw !== undefined) {
    if (sizeRaw !== 'thumb' && sizeRaw !== 'medium' && sizeRaw !== 'full') {
      throw new Error(`[figures] invalid <LectureFigure size="${sizeRaw}"> (expected thumb|medium|full)`)
    }
    size = sizeRaw
  }

  const floatRaw = getAttr('float')?.trim()
  let float: FigureFloat | undefined
  if (floatRaw !== undefined) {
    if (floatRaw !== 'right' && floatRaw !== 'left' && floatRaw !== 'none') {
      throw new Error(`[figures] invalid <LectureFigure float="${floatRaw}"> (expected right|left|none)`)
    }
    float = floatRaw
  }

  return { ids, size, float }
}

/** Parse optional `group:id` prefix; defaults to page's own group. */
export function splitFigureTarget(rawTarget: string, defaultGroup: string): { group: string; id: string } {
  const slashIdx = rawTarget.indexOf('/')
  if (slashIdx > 0) {
    const groupPart = rawTarget.slice(0, slashIdx).trim()
    const idPart = rawTarget.slice(slashIdx + 1).trim()
    if (groupPart && idPart) return { group: groupPart, id: idPart }
  }
  return { group: defaultGroup, id: rawTarget.trim() }
}

export { formatFigureNumberLabel }

export function isTierAccessAllowed(pageTier: string, targetTier: string, inlineTier = 'public'): boolean {
  if (targetTier === inlineTier || targetTier === 'public') return true
  if (pageTier === targetTier) return true
  if (targetTier === 'authenticated' && pageTier.startsWith('grp-')) return true
  return false
}

export function figurePublicUrl(
  targetGroup: string,
  file: string,
  targetTier: string,
  isBuild: boolean,
  inlineTier = 'public',
): string {
  const cleanFile = file.replace(/^\/+/, '')
  const cleanGroup = targetGroup.replace(/^\/+|\/+$/g, '')
  if (isBuild && targetTier !== inlineTier) {
    return `/_access/${targetTier}/figures/${cleanGroup}/${cleanFile}`
  }
  return `/figures/${cleanGroup}/${cleanFile}`
}

function pageLocaleKey(relPath: string, localeKeys: readonly string[]): string {
  const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  const head = norm.split('/')[0] ?? ''
  return localeKeys.includes(head) ? head : ''
}

function parseXrefScheme(href: string): { scheme: FigureKind; target: string } | null {
  if (href.startsWith('fig:')) return { scheme: 'figure', target: href.slice(4) }
  if (href.startsWith('tab:')) return { scheme: 'table', target: href.slice(4) }
  return null
}

/** Encode payload cleanly into an attribute without quotes, braces, `<`, `>`, `&`, or newlines. */
export function encodeFigurePayload(payload: unknown): string {
  return encodeURIComponent(JSON.stringify(payload))
}

export function decodeFigurePayload<T>(encoded: string): T | null {
  if (!encoded) return null
  try {
    return JSON.parse(decodeURIComponent(encoded)) as T
  } catch {
    return null
  }
}

export function createFiguresMarkdownPlugin(opts: FiguresMarkdownOptions) {
  const registryCache = new Map<string, LoadedGroupRegistry | null>()
  const getRegistry = (group: string): LoadedGroupRegistry | null => {
    if (!registryCache.has(group)) {
      registryCache.set(group, loadGroupRegistry(group, opts.paths))
    }
    return registryCache.get(group) ?? null
  }

  const tierOfGroup = (groupDir: string): string => {
    const groupId = opts.groupIdByDir.get(groupDir)
    if (!groupId) return opts.accessPlan.inlineTier
    return opts.accessPlan.tierOfGroup[groupId] ?? opts.accessPlan.inlineTier
  }

  const lookupEntry = (
    pageGroup: string | null,
    rawTarget: string,
    pageRelPath: string,
  ): { group: string; entry: FigureEntry; targetTier: string } => {
    const resolved = pageGroup
      ? splitFigureTarget(rawTarget, pageGroup)
      : splitFigureTarget(rawTarget, '')
    if (!resolved.group) {
      throw new Error(`[figures] ${pageRelPath}: cannot determine group for figure reference "${rawTarget}"`)
    }
    const pageTier = pageGroup ? tierOfGroup(pageGroup) : opts.accessPlan.inlineTier
    const targetTier = tierOfGroup(resolved.group)
    if (!isTierAccessAllowed(pageTier, targetTier, opts.accessPlan.inlineTier)) {
      throw new Error(
        `[figures] ${pageRelPath} (tier "${pageTier}") cannot reference restricted figure "${resolved.group}/${resolved.id}" (tier "${targetTier}")`,
      )
    }
    const reg = getRegistry(resolved.group)
    if (!reg) {
      throw new Error(
        `[figures] ${pageRelPath}: unknown figure "${rawTarget}" (no registry found for group "${resolved.group}")`,
      )
    }
    const entry = reg.byId.get(resolved.id)
    if (!entry) {
      throw new Error(`[figures] ${pageRelPath}: unknown figure id "${resolved.id}" in group "${resolved.group}"`)
    }
    return { group: resolved.group, entry, targetTier }
  }

  return function figuresMarkdownPlugin(md: {
    core: { ruler: { after(afterName: string, ruleName: string, fn: (state: MarkdownItStateLike) => void): void } }
  }): void {
    md.core.ruler.after('inline', 'lec-figures', (state: MarkdownItStateLike) => {
      const env = state.env as { relativePath?: string } | undefined
      const relPath = env?.relativePath
      if (!relPath) return

      const pageGroup = resolveGroupForPage(relPath, opts.groupDirs, opts.localeKeys)
      const localeKey = pageLocaleKey(relPath, opts.localeKeys)

      const numberByKey = new Map<string, { num: number; kind: FigureKind; entry: FigureEntry; group: string; targetTier: string }>()
      // one shared sequence for charts and figures, one for tables (figures/numbering.ts)
      const numbering = new FigureNumbering(lectureNoOfPage(relPath), localeKey)
      const chartNumbers: number[] = []
      const backlinksByKey = new Map<string, FigureBacklink[]>()

      const ensureNumbered = (group: string, entry: FigureEntry, targetTier: string): number => {
        const key = `${group}:${entry.id}`
        const existing = numberByKey.get(key)
        if (existing) return existing.num
        const num = numbering.numberOf(key, entry.kind)
        numberByKey.set(key, { num, kind: entry.kind, entry, group, targetTier })
        return num
      }

      // Pass 1a: number the mounted charts and `<LectureFigure>` tags in the order they appear on the page.
      const scanMounts = (html: string): void => {
        for (const hit of scanFigureMarkup(html)) {
          if (hit.type === 'chart') {
            chartNumbers.push(numbering.next('figure'))
            continue
          }
          const parsed = parseLectureFigureTagAttrs(hit.attrs)
          if (!parsed) {
            throw new Error(`[figures] ${relPath}: malformed <LectureFigure> tag: ${hit.text}`)
          }
          for (const rawId of parsed.ids) {
            const found = lookupEntry(pageGroup, rawId, relPath)
            ensureNumbered(found.group, found.entry, found.targetTier)
          }
        }
      }
      // cross-references in order; a cited figure that is not mounted on this page is numbered after the mounted ones
      const inlineMermaidMode = opts.inlineMermaid ?? defaultInlineMermaidMode()
      const xrefTargets: Array<{ group: string; entry: FigureEntry; targetTier: string }> = []
      for (const tok of state.tokens) {
        if (tok.type === 'fence' && isInlineMermaidInfo(tok.info ?? '', inlineMermaidMode)) {
          chartNumbers.push(numbering.next('figure'))
        } else if ((tok.type === 'html_block' || tok.type === 'html_inline') && hasFigureMarkup(tok.content)) {
          scanMounts(tok.content)
        } else if (tok.type === 'inline' && tok.children) {
          for (let i = 0; i < tok.children.length; i++) {
            const child = tok.children[i]
            if (!child) continue
            if (child.type === 'html_inline' && hasFigureMarkup(child.content)) {
              scanMounts(child.content)
            } else if (child.type === 'link_open') {
              const href = String(child.attrGet('href') ?? '')
              const xref = parseXrefScheme(href)
              if (!xref) continue
              const found = lookupEntry(pageGroup, xref.target, relPath)
              if (found.entry.kind !== xref.scheme) {
                throw new Error(
                  `[figures] ${relPath}: "${href}" expects kind="${xref.scheme}" but "${found.entry.id}" is "${found.entry.kind}"`,
                )
              }
              xrefTargets.push(found)
              const key = `${found.group}:${found.entry.id}`
              const list = backlinksByKey.get(key) ?? []
              const idx = list.length + 1
              list.push({ anchorId: `xref-${found.entry.id}-${idx}`, label: String(idx) })
              backlinksByKey.set(key, list)
            }
          }
        }
      }
      // Pass 1b: cited but not mounted here (e.g. `[](fig:other-group/id)`)
      for (const found of xrefTargets) ensureNumbered(found.group, found.entry, found.targetTier)

      if (numberByKey.size === 0 && chartNumbers.length === 0) return

      // Normalize single backlink marker to `↩` and multi backlink markers to `↩1`, `↩2`, ...
      for (const [, list] of backlinksByKey) {
        if (list.length === 1) {
          list[0]!.label = '↩'
        } else {
          for (let i = 0; i < list.length; i++) {
            list[i]!.label = `↩${i + 1}`
          }
        }
      }

      const toResolvedItem = (group: string, rawId: string): ResolvedFigureItem => {
        const target = splitFigureTarget(rawId, group)
        const key = `${target.group}:${target.id}`
        const rec = numberByKey.get(key)!
        const e = rec.entry
        return {
          id: e.id,
          kind: e.kind,
          src: figurePublicUrl(rec.group, e.file, rec.targetTier, opts.isBuild, opts.accessPlan.inlineTier),
          originalSrc: e.original
            ? figurePublicUrl(rec.group, e.original, rec.targetTier, opts.isBuild, opts.accessPlan.inlineTier)
            : undefined,
          width: e.width,
          height: e.height,
          num: rec.num,
          label: numbering.label(e.kind, rec.num),
          caption: localizeFigureCaption(e, localeKey),
          sourceText: formatFigureSource(e, localeKey),
          paper: e.source.paper,
          sourceNumber: e.source.number,
          sourcePage: e.source.page,
          doi: e.doi,
          url: e.url,
          backlinks: backlinksByKey.get(key) ?? [],
        }
      }

      const rewriteLectureFigureTag = (attrs: string): string => {
        const parsed = parseLectureFigureTagAttrs(attrs)!
        const items = parsed.ids.map((id) => toResolvedItem(pageGroup || '', id))
        const isGallery = items.length > 1
        const size: FigureSize = parsed.size ?? (isGallery ? 'full' : 'thumb')
        const float: FigureFloat = parsed.float ?? (isGallery || size !== 'thumb' ? 'none' : 'right')
        const propsPayload: ResolvedFigureMountProps = {
          group: pageGroup || '',
          size,
          float,
          items,
        }
        return `<LectureFigure encoded="${encodeFigurePayload(propsPayload)}" />`
      }
      // chart figures are consumed in the same order pass 1a numbered them
      let chartCursor = 0
      const rewriteFigureHtml = (html: string): string => {
        const hits = scanFigureMarkup(html)
        if (hits.length === 0) return html
        let out = ''
        let last = 0
        for (const hit of hits) {
          out += html.slice(last, hit.index)
          if (hit.type === 'chart') {
            const num = chartNumbers[chartCursor++] ?? 0
            out += num > 0 ? annotateChartFigureTag(hit.text, num, numbering.lectureNo, numbering.label('figure', num)) : hit.text
          } else {
            out += rewriteLectureFigureTag(hit.attrs)
          }
          last = hit.index + hit.text.length
        }
        return out + html.slice(last)
      }

      // Pass 2: rewrite `<LectureFigure>` tags, chart figures, inline mermaid blocks and `[...](fig:id)` / `[...](tab:id)` links.
      const seenOccurrence = new Map<string, number>()
      const nextTokens: MarkdownItTokenLike[] = []
      let touchedTokens = false
      for (const tok of state.tokens) {
        if (tok.type === 'fence' && isInlineMermaidInfo(tok.info ?? '', inlineMermaidMode)) {
          const num = chartNumbers[chartCursor++] ?? 0
          if (num > 0) {
            const metaTok = new state.Token('html_block', '', 0)
            metaTok.content = `${renderInlineMermaidMetaTag(num, numbering.lectureNo, numbering.label('figure', num))}\n`
            nextTokens.push(metaTok)
            touchedTokens = true
          }
          nextTokens.push(tok)
          continue
        }
        nextTokens.push(tok)
        if ((tok.type === 'html_block' || tok.type === 'html_inline') && hasFigureMarkup(tok.content)) {
          tok.content = rewriteFigureHtml(tok.content)
        } else if (tok.type === 'inline' && tok.children) {
          const nextChildren: MarkdownItTokenLike[] = []
          for (let i = 0; i < tok.children.length; i++) {
            const child = tok.children[i]!
            if (child.type === 'html_inline' && hasFigureMarkup(child.content)) {
              child.content = rewriteFigureHtml(child.content)
              nextChildren.push(child)
              continue
            }
            if (child.type === 'link_open') {
              const href = String(child.attrGet('href') ?? '')
              const xref = parseXrefScheme(href)
              if (xref) {
                const target = splitFigureTarget(xref.target, pageGroup || '')
                const key = `${target.group}:${target.id}`
                const rec = numberByKey.get(key)!
                const occ = (seenOccurrence.get(key) ?? 0) + 1
                seenOccurrence.set(key, occ)

                const label = numbering.label(rec.kind, rec.num)
                const preview: FigureHoverPreviewPayload = {
                  id: rec.entry.id,
                  kind: rec.kind,
                  label,
                  title: label,
                  src: figurePublicUrl(rec.group, rec.entry.file, rec.targetTier, opts.isBuild, opts.accessPlan.inlineTier),
                  caption: localizeFigureCaption(rec.entry, localeKey),
                  sourceText: formatFigureSource(rec.entry, localeKey),
                  width: rec.entry.width,
                  height: rec.entry.height,
                }

                child.attrSet('href', `#fig-${rec.entry.id}`)
                child.attrSet('id', `xref-${rec.entry.id}-${occ}`)
                child.attrSet('class', 'lec-xref')
                child.attrSet('data-xref-id', rec.entry.id)
                child.attrSet('data-xref-meta', encodeFigurePayload(preview))
                nextChildren.push(child)

                const upcoming = tok.children[i + 1]
                if (upcoming && upcoming.type === 'link_close') {
                  const textTok = new state.Token('text', '', 0)
                  textTok.content = label
                  nextChildren.push(textTok)
                }
                continue
              }
            }
            nextChildren.push(child)
          }
          tok.children = nextChildren
        }
      }
      if (touchedTokens) state.tokens = nextTokens
    })
  }
}

/**
 * AST-based citation & mount extractor using `mdast-util-from-markdown` + `unist-util-visit`
 * for `check:figures` and Dashboard "used in" reporting. Ignores code blocks & inline code.
 */
export function collectLectureCitationsFromMarkdown(source: string, defaultGroup: string): LectureCitationRef[] {
  const out: LectureCitationRef[] = []
  const tree = fromMarkdown(source)
  visit(tree, (node) => {
    if (node.type === 'link') {
      const url = node.url || ''
      if (url.startsWith('fig:') || url.startsWith('tab:')) {
        const scheme: FigureKind = url.startsWith('fig:') ? 'figure' : 'table'
        const target = splitFigureTarget(url.slice(4), defaultGroup)
        out.push({ kind: scheme, targetGroup: target.group, id: target.id })
      }
    } else if (node.type === 'html' && node.value.includes('<LectureFigure')) {
      for (const m of node.value.matchAll(LECTURE_FIGURE_TAG_RE)) {
        const parsed = parseLectureFigureTagAttrs(m[1] ?? '')
        if (!parsed) continue
        for (const rawId of parsed.ids) {
          const target = splitFigureTarget(rawId, defaultGroup)
          out.push({ kind: 'mount', targetGroup: target.group, id: target.id })
        }
      }
    }
  })
  return out
}

export interface PageFigureUsage {
  /** Normalized route path without locale/extension, e.g. `/g01/L01` or `/courses/g01/L01`. */
  route: string
  /** Relative file path under docsRoot / lecturesDir, e.g. `g01/L01.md`. */
  relPath: string
  /** Page title parsed from frontmatter/heading if present. */
  title: string
  groupDir: string
  citations: LectureCitationRef[]
}

function extractMarkdownTitle(src: string, fallback: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src)
  if (fm?.[1]) {
    const tMatch = /^title:\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\r\n]+))/m.exec(fm[1])
    const val = (tMatch?.[1] ?? tMatch?.[2] ?? tMatch?.[3] ?? '').trim()
    if (val) return val
  }
  const h1 = /^#\s+(.+)$/m.exec(src)
  if (h1?.[1]) return h1[1].trim()
  return fallback
}

export function scanLectureFigureUsage(
  lecturesRoot: string,
  docsFallbackRoot: string,
  groupDirs: readonly string[],
  localeKeys: readonly string[],
): PageFigureUsage[] {
  const out: PageFigureUsage[] = []
  const rootsToScan = Array.from(new Set([path.resolve(lecturesRoot), path.resolve(docsFallbackRoot)]))

  const seenRelPaths = new Set<string>()
  const scanDir = (baseRoot: string, groupDir: string, prefixLocale: string) => {
    const dirOnDisk = path.join(baseRoot, ...(prefixLocale ? [prefixLocale] : []), ...groupDir.split('/'))
    if (!fs.existsSync(dirOnDisk)) return
    for (const ent of fs.readdirSync(dirOnDisk, { withFileTypes: true })) {
      if (!ent.isFile() || !/^L\d+\.md$/.test(ent.name)) continue
      const rel = [...(prefixLocale ? [prefixLocale] : []), groupDir, ent.name].join('/')
      if (seenRelPaths.has(rel)) continue
      seenRelPaths.add(rel)
      const fullPath = path.join(dirOnDisk, ent.name)
      const src = fs.readFileSync(fullPath, 'utf8')
      const citations = collectLectureCitationsFromMarkdown(src, groupDir)
      const stem = ent.name.slice(0, -3)
      const route = prefixLocale ? `/${prefixLocale}/${groupDir}/${stem}` : `/${groupDir}/${stem}`
      out.push({
        route,
        relPath: rel,
        title: extractMarkdownTitle(src, `${groupDir}/${stem}`),
        groupDir,
        citations,
      })
    }
  }

  for (const baseRoot of rootsToScan) {
    for (const groupDir of groupDirs) {
      scanDir(baseRoot, groupDir, '')
      for (const loc of localeKeys) {
        scanDir(baseRoot, groupDir, loc)
      }
    }
  }

  return out
}
