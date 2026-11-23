/**
 * scripts/content/contract.mts — the lecture contract as pure checks (docs/authoring/lecture-contract.md).
 *
 * Ported from scripts/check_lecture_contracts.py (frontmatter, quoted title, bare <a href>, fence languages, `{{`,
 * table columns, concept page rules) and extended with what the real lectures follow: `description` + `outline`,
 * `order` equal to the file number, the node info line, heading levels, chart placeholders against
 * `charts/<data-lecture>.json`, internal lecture links, and per-site required headings (check.config.json).
 * No file system access here: the caller (check.mts) passes lookups, so every rule is unit-testable.
 */

export type IssueLevel = 'fail' | 'warn' | 'info'

export interface ContentIssue {
  level: IssueLevel
  /** Stable id the Dashboard maps to its own wording, e.g. `chart.id_missing`. */
  code: string
  /** Path relative to the content root (forward slashes), when the issue belongs to a file. */
  file?: string
  line?: number
  message: string
}

export const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const FENCE_RE = /^\s*(```+|~~~+)(.*)$/
const NODE_RE = /(?:\u8282\u70b9\u6807\u8bc6|\u8282\u70b9|Node)\s*(?::\s*)?`?([a-zA-Z0-9_.-]+)`?/
const CHART_TYPES = new Set(['mermaid', 'echarts', 'wavedrom'])

export interface RequiredHeadingRule {
  heading: string
  exceptLastLecture?: boolean
  /** `<group dir>/<stem>` keys, e.g. `spi/L08`. */
  exempt?: readonly string[]
}

export type ChartLookup = (lectureId: string) => Record<string, { type?: unknown }> | null | 'invalid'

export interface LectureContext {
  /** Content-relative file, e.g. `lectures/g01/L02.md`. */
  file: string
  /** `<group dir>/<stem>`, e.g. `g01/L02`. */
  key: string
  groupId: string
  groupDir: string
  /** Lecture number from the file name. */
  n: number
  isLast: boolean
  requiredHeadings?: readonly RequiredHeadingRule[]
  readChart: ChartLookup
  /** Does `<lecturesDir>/<dir>/<stem>.md` exist (`stem` = `L02` or `index`)? */
  lectureExists: (dir: string, stem: string) => boolean
  /** Group dirs of the site (absolute links like `/g02/L03` are checked only for these). */
  groupDirs: ReadonlySet<string>
  /** Translation (`lectures/en/...`): the node line and required headings are not asked for. */
  translation?: boolean
}

export interface Frontmatter {
  block: string
  /** Line number (1-based) where the body starts. */
  bodyLine: number
  body: string
  fields: Map<string, string>
}

export function readFrontmatter(src: string): Frontmatter | null {
  const m = FRONTMATTER_RE.exec(src)
  if (!m) return null
  const block = m[1] ?? ''
  const fields = new Map<string, string>()
  for (const line of block.split(/\r?\n/)) {
    const f = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line)
    if (f) fields.set(f[1] as string, (f[2] as string).trim())
  }
  const consumed = m[0]
  return { block, fields, body: src.slice(consumed.length), bodyLine: consumed.split('\n').length }
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1)
  return t
}

/** Count `|` that are not escaped and not inside inline code (math `\|x\|` and `` `a|b` `` keep a table intact). */
export function countPipes(line: string): number {
  let n = 0
  let inCode = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '`') inCode = !inCode
    else if (ch === '|' && !inCode && !(i > 0 && line[i - 1] === '\\')) n++
  }
  return n
}

interface BodyLine {
  text: string
  /** 1-based line in the file. */
  line: number
  inFence: boolean
}

function bodyLines(body: string, firstLine: number): BodyLine[] {
  const out: BodyLine[] = []
  let fence: string | null = null
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string
    const f = FENCE_RE.exec(text)
    if (f) {
      const marker = (f[1] as string).slice(0, 3)
      if (fence === null) {
        fence = marker
        out.push({ text, line: firstLine + i, inFence: true })
        continue
      }
      if (marker === fence && (f[2] as string).trim() === '') {
        fence = null
        out.push({ text, line: firstLine + i, inFence: true })
        continue
      }
    }
    out.push({ text, line: firstLine + i, inFence: fence !== null })
  }
  return out
}

/** Prose of one line with inline code spans and inline math removed. */
function stripInline(text: string): string {
  return text.replace(/`[^`\n]*`/g, ' ').replace(/\\\(.*?\\\)/g, ' ').replace(/\$[^$\n]+\$/g, ' ')
}

export function checkTables(lines: readonly BodyLine[], file: string): ContentIssue[] {
  const issues: ContentIssue[] = []
  let i = 0
  while (i < lines.length - 1) {
    const cur = lines[i] as BodyLine
    const next = lines[i + 1] as BodyLine
    if (!cur.inFence && !next.inFence && cur.text.trimStart().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(next.text)) {
      const cols = countPipes(cur.text)
      let j = i + 2
      while (j < lines.length && !(lines[j] as BodyLine).inFence && (lines[j] as BodyLine).text.trimStart().startsWith('|')) {
        const row = lines[j] as BodyLine
        if (countPipes(row.text) !== cols) {
          issues.push({ level: 'fail', code: 'lecture.table_columns', file, line: row.line, message: `table row has ${countPipes(row.text)} column separators, the header has ${cols}` })
        }
        j++
      }
      i = j
    } else i++
  }
  return issues
}

const LINK_RE = /(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

/** Internal lecture links (`./L02`, `../g02/L03.md`, `/g02/L03#x`, `./index.md`) whose target lecture is missing. */
export function checkLinks(lines: readonly BodyLine[], ctx: LectureContext): ContentIssue[] {
  const issues: ContentIssue[] = []
  for (const l of lines) {
    if (l.inFence) continue
    for (const m of stripInline(l.text).matchAll(LINK_RE)) {
      const href = m[1] as string
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue
      const target = href.split('#')[0]?.split('?')[0] ?? ''
      if (target === '') continue
      const resolved = resolveLectureLink(target, ctx)
      if (resolved && !ctx.lectureExists(resolved.dir, resolved.stem)) {
        issues.push({ level: 'fail', code: 'link.broken', file: ctx.file, line: l.line, message: `link "${href}" points at ${resolved.dir}/${resolved.stem}.md, which does not exist` })
      }
    }
  }
  return issues
}

function resolveLectureLink(target: string, ctx: LectureContext): { dir: string; stem: string } | null {
  const clean = target.replace(/\.(?:md|html)$/, '').replace(/\/$/, '/index')
  let parts: string[]
  if (clean.startsWith('/')) {
    parts = clean.slice(1).split('/')
    if (ctx.translation && parts[0] === 'en') parts = parts.slice(1)
    const stem = parts[parts.length - 1] ?? ''
    const dir = parts.slice(0, -1).join('/')
    if (!ctx.groupDirs.has(dir)) return null
    if (!/^L\d+$/.test(stem) && stem !== 'index') return null
    return { dir, stem }
  }
  parts = ctx.groupDir.split('/')
  for (const seg of clean.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const stem = parts[parts.length - 1] ?? ''
  const dir = parts.slice(0, -1).join('/')
  if (!/^L\d+$/.test(stem) && stem !== 'index') return null
  if (!ctx.groupDirs.has(dir)) return null
  return { dir, stem }
}

const FIGURE_RE = /<figure\b([^>]*)>/g

export interface ChartRef {
  lecture: string
  id: string
  type: string
  line: number
}

export function chartRefsOf(lines: readonly BodyLine[]): { refs: ChartRef[]; issues: Omit<ContentIssue, 'file'>[] } {
  const refs: ChartRef[] = []
  const issues: Omit<ContentIssue, 'file'>[] = []
  for (const l of lines) {
    if (l.inFence) continue
    for (const m of l.text.matchAll(FIGURE_RE)) {
      const attrs = m[1] as string
      if (!/\bclass="[^"]*\bchart\b/.test(attrs) && !/\bdata-lecture=/.test(attrs)) continue
      const lecture = /\bdata-lecture="([^"]*)"/.exec(attrs)?.[1] ?? ''
      const id = /\bdata-id="([^"]*)"/.exec(attrs)?.[1] ?? ''
      const type = /\bdata-type="([^"]*)"/.exec(attrs)?.[1] ?? ''
      if (!lecture || !id || !type) {
        issues.push({ level: 'fail', code: 'chart.attr_missing', line: l.line, message: 'chart placeholder needs data-lecture, data-id and data-type' })
        continue
      }
      refs.push({ lecture, id, type, line: l.line })
    }
  }
  return { refs, issues }
}

export function checkCharts(lines: readonly BodyLine[], ctx: LectureContext): ContentIssue[] {
  const { refs, issues } = chartRefsOf(lines)
  const out: ContentIssue[] = issues.map((i) => ({ ...i, file: ctx.file }))
  const expected = `${ctx.groupId}-L${String(ctx.n).padStart(2, '0')}`
  const seen = new Set<string>()
  for (const r of refs) {
    const key = `${r.lecture}#${r.id}`
    if (seen.has(key)) out.push({ level: 'fail', code: 'chart.duplicate', file: ctx.file, line: r.line, message: `chart ${key} is placed twice` })
    seen.add(key)
    if (!CHART_TYPES.has(r.type)) {
      out.push({ level: 'fail', code: 'chart.type_unknown', file: ctx.file, line: r.line, message: `data-type "${r.type}" (allowed: mermaid, echarts, wavedrom)` })
      continue
    }
    if (r.lecture !== expected && r.lecture !== `${ctx.groupId}-L${ctx.n}`) {
      out.push({ level: 'warn', code: 'chart.prefix', file: ctx.file, line: r.line, message: `data-lecture "${r.lecture}" is not ${expected} (the chart file of this lecture)` })
    }
    const data = ctx.readChart(r.lecture)
    if (data === null) {
      out.push({ level: 'fail', code: 'chart.file_missing', file: ctx.file, line: r.line, message: `charts/${r.lecture}.json does not exist` })
      continue
    }
    if (data === 'invalid') {
      out.push({ level: 'fail', code: 'chart.json_invalid', file: ctx.file, line: r.line, message: `charts/${r.lecture}.json is not a JSON object` })
      continue
    }
    const entry = data[r.id]
    if (!entry) {
      out.push({ level: 'fail', code: 'chart.id_missing', file: ctx.file, line: r.line, message: `charts/${r.lecture}.json has no "${r.id}"` })
      continue
    }
    if (typeof entry.type === 'string' && entry.type !== r.type) {
      out.push({ level: 'fail', code: 'chart.type_mismatch', file: ctx.file, line: r.line, message: `${key}: placeholder says ${r.type}, the data says ${entry.type}` })
    }
  }
  return out
}

/** Every rule for one lecture source. */
export function checkLectureSource(src: string, ctx: LectureContext): ContentIssue[] {
  const issues: ContentIssue[] = []
  const add = (level: IssueLevel, code: string, message: string, line?: number) => issues.push({ level, code, file: ctx.file, ...(line ? { line } : {}), message })

  const fm = readFrontmatter(src)
  if (!fm) {
    add('fail', 'lecture.frontmatter_missing', 'no frontmatter (--- title / order / description / outline ---)', 1)
  } else {
    const title = fm.fields.get('title')
    if (title === undefined || unquote(title) === '') add('fail', 'lecture.title_missing', 'frontmatter has no title')
    else if (!title.startsWith('"')) add('fail', 'lecture.title_unquoted', 'title must be in double quotes ("...")')
    if (!ctx.translation) {
      const order = fm.fields.get('order')
      if (order === undefined || !/^\d+$/.test(order)) add('fail', 'lecture.order_missing', 'frontmatter needs order: <integer>')
      else if (Number(order) !== ctx.n) add('fail', 'lecture.order_mismatch', `order is ${order}, the file is L${ctx.n}`)
      const desc = fm.fields.get('description')
      if (desc === undefined || unquote(desc) === '') add('fail', 'lecture.description_missing', 'frontmatter has no description (the node info line)')
      else if (!NODE_RE.test(unquote(desc))) add('info', 'lecture.node_missing', 'description names no node (节点 `id` / Node `id`): the lecture is not tied to the graph')
      if (fm.fields.get('outline') === undefined) add('fail', 'lecture.outline_missing', 'frontmatter has no outline (use outline: deep)')
    }
  }

  const body = fm ? fm.body : src
  const lines = bodyLines(body, fm ? fm.bodyLine : 1)

  // raw links and Vue interpolation
  for (const l of lines) {
    if (l.inFence) continue
    if (/<a\s[^>]*href="https?:\/\//.test(l.text)) add('fail', 'lecture.bare_link', 'raw <a href="http..."> in the body: use a .cite capsule (<span class="cite" data-cite="...">)', l.line)
  }
  if (lines.some((l) => !l.inFence && stripInline(l.text).includes('{{'))) add('warn', 'lecture.vue_interpolation', 'contains "{{" outside code: Vue reads it as interpolation')

  // fences without a language
  let noLang = 0
  let open = false
  for (const l of lines) {
    const f = FENCE_RE.exec(l.text)
    if (!f) continue
    if (!open) {
      open = true
      if ((f[2] as string).trim() === '') noLang++
    } else if ((f[2] as string).trim() === '') open = false
  }
  if (noLang > 0) add('warn', 'lecture.fence_language', `${noLang} code fence(s) without a language`)

  // headings
  let h1 = 0
  let prev = 1
  let skips = 0
  let firstSkip = 0
  for (const l of lines) {
    if (l.inFence) continue
    const h = /^(#{1,6})\s+\S/.exec(l.text)
    if (!h) continue
    const level = (h[1] as string).length
    if (level === 1) h1++
    if (level > prev + 1) {
      skips++
      if (!firstSkip) firstSkip = l.line
    }
    prev = level
  }
  if (h1 > 1) add('warn', 'lecture.h1_multiple', `${h1} level-1 headings: keep one (the title)`)
  if (skips > 0) add('warn', 'lecture.heading_skip', `${skips} heading(s) skip a level (for example ## then ####)`, firstSkip)

  issues.push(...checkTables(lines, ctx.file))
  issues.push(...checkCharts(lines, ctx))
  issues.push(...checkLinks(lines, ctx))

  if (!ctx.translation) {
    for (const rule of ctx.requiredHeadings ?? []) {
      if ((rule.exempt ?? []).includes(ctx.key)) continue
      if (rule.exceptLastLecture !== false && ctx.isLast) continue
      const has = lines.some((l) => !l.inFence && l.text.trim() === rule.heading.trim())
      if (!has) add('fail', 'lecture.required_heading', `missing "${rule.heading}" (check.config.json requiredHeadings)`)
    }
  }
  return issues
}

/** Translation against its original: same chart placeholders (docs-dev/I18N.md). */
export function compareTranslationCharts(original: string, translation: string, file: string): ContentIssue[] {
  const keys = (src: string) => {
    const fm = readFrontmatter(src)
    const lines = bodyLines(fm ? fm.body : src, 1)
    return new Set(chartRefsOf(lines).refs.map((r) => `${r.lecture}#${r.id}`))
  }
  const a = keys(original)
  const b = keys(translation)
  const missing = [...a].filter((k) => !b.has(k))
  const extra = [...b].filter((k) => !a.has(k))
  if (missing.length === 0 && extra.length === 0) return []
  return [
    {
      level: 'warn',
      code: 'translation.charts_differ',
      file,
      message: `chart placeholders differ from the original${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; extra ${extra.join(', ')}` : ''}`,
    },
  ]
}

// ── concept pages (ported from check_concept_file in check_lecture_contracts.py) ──

const CONCEPT_FIELDS = ['title', 'term', 'english', 'field', 'groups', 'summary', 'status'] as const

function stripCodeAndMath(text: string): string {
  const out: string[] = []
  let inFence = false
  for (const line of text.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) out.push(line)
  }
  return out
    .join('\n')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\\(.*?\\\)/g, ' ')
}

export function checkConceptSource(src: string, opts: { file: string; isDraft: boolean }): ContentIssue[] {
  const issues: ContentIssue[] = []
  const add = (level: IssueLevel, code: string, message: string) => issues.push({ level, code, file: opts.file, message })
  const fm = readFrontmatter(src.replace(/\r\n/g, '\n'))
  const body = fm ? fm.body : src
  if (!fm) add('fail', 'concept.frontmatter_missing', 'concept page has no frontmatter')
  else for (const f of CONCEPT_FIELDS) if (!fm.fields.has(f)) add('fail', 'concept.field_missing', `frontmatter has no ${f}`)

  if (/<a\s[^>]*href="https?:\/\//.test(src)) add('fail', 'concept.bare_link', 'raw <a href="http..."> in the body: use a .cite capsule')
  if (/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(body)) add('fail', 'concept.markdown_link', 'Markdown link to http... in the body: use a .cite capsule')
  if (src.includes('[[concept:')) add('fail', 'concept.old_syntax', 'old [[concept:...]] syntax: write [text](concept:slug)')

  let inFence = false
  for (const line of body.split(/\r?\n/)) {
    const f = FENCE_RE.exec(line)
    if (!f) continue
    if (!inFence && (f[2] as string).trim().toLowerCase() === 'math') add('fail', 'concept.math_fence', '```math fence: write LaTeX \\( \\) or $$ $$')
    inFence = !inFence
  }

  const prose = stripCodeAndMath(body)
  const unbalanced = prose.split('\n').filter((l) => (l.match(/(?<!\\)\*\*/g) ?? []).length % 2 !== 0).length
  if (unbalanced) add('fail', 'concept.bold_unbalanced', `${unbalanced} line(s) with an unclosed **`)

  if (src.includes('待核实')) {
    if (opts.isDraft) add('warn', 'concept.unverified_draft', 'draft still has "待核实" marks (clear them before publishing)')
    else add('fail', 'concept.unverified', 'published concept page still has "待核实" marks')
  }

  const sections = body.split(/^##\s+/m)
  let missingSource = 0
  sections.forEach((sec, idx) => {
    const clean = stripCodeAndMath(sec).trim()
    if (!clean) return
    let lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
    lines = idx === 0 ? lines.filter((l) => !l.startsWith('# ')) : lines.slice(1)
    const prosey = lines.filter((l) => !l.startsWith('>') && !/^[（(](?:出处|来源)/.test(l) && !l.startsWith('|'))
    if (prosey.length === 0) return
    const cited = /class=["']cite["']/.test(sec) || /[（(](?:出处|来源)\s*[：:]/.test(sec)
    if (!cited && !(opts.isDraft && sec.includes('待核实'))) missingSource++
  })
  if (missingSource) add('fail', 'concept.source_missing', `${missingSource} section(s) name no source (出处 / .cite)`)

  const tableLines = bodyLines(body, 1)
  for (const t of checkTables(tableLines, opts.file)) issues.push({ ...t, code: 'concept.table_columns', line: undefined })
  return issues
}

// ── graph ──

export interface GraphInput {
  /** Parsed graph.json, or 'invalid', or null when the file does not exist. */
  graph: unknown
  bindings: unknown
  graphFile: string
  bindingsFile: string
  /** `/g03/L56` style link -> does the lecture exist? */
  lectureLinkExists: (link: string) => boolean
}

export function checkGraph(g: GraphInput): ContentIssue[] {
  const issues: ContentIssue[] = []
  const nodeIds = new Set<string>()
  if (g.graph === 'invalid') issues.push({ level: 'fail', code: 'graph.invalid', file: g.graphFile, message: 'graph.json is not valid JSON' })
  else if (g.graph && typeof g.graph === 'object') {
    const nodes = (g.graph as { nodes?: unknown }).nodes
    if (!Array.isArray(nodes)) issues.push({ level: 'fail', code: 'graph.invalid', file: g.graphFile, message: 'graph.json has no nodes array' })
    else {
      const missing: string[] = []
      for (const node of nodes as { id?: unknown; lecture?: unknown }[]) {
        if (typeof node?.id === 'string') nodeIds.add(node.id)
        if (typeof node?.lecture === 'string' && node.lecture !== '' && !g.lectureLinkExists(node.lecture)) missing.push(`${String(node.id)} -> ${node.lecture}`)
      }
      if (missing.length > 0) {
        issues.push({ level: 'warn', code: 'graph.lecture_missing', file: g.graphFile, message: `${missing.length} node(s) point at a lecture that does not exist: ${missing.slice(0, 5).join('; ')}${missing.length > 5 ? '; ...' : ''}` })
      }
    }
  }
  if (g.bindings === 'invalid') issues.push({ level: 'fail', code: 'graph.bindings_invalid', file: g.bindingsFile, message: 'graph-bindings.json is not valid JSON' })
  else if (g.bindings && typeof g.bindings === 'object') {
    const map = (g.bindings as { bindings?: unknown }).bindings
    if (!map || typeof map !== 'object' || Array.isArray(map)) {
      issues.push({ level: 'fail', code: 'graph.bindings_invalid', file: g.bindingsFile, message: 'graph-bindings.json needs { "schema": 1, "bindings": { "<node id>": "/<group dir>/Lxx" } }' })
    } else {
      for (const [node, link] of Object.entries(map as Record<string, unknown>)) {
        if (typeof link !== 'string' || !g.lectureLinkExists(link)) {
          issues.push({ level: 'fail', code: 'graph.binding_lecture_missing', file: g.bindingsFile, message: `binding ${node} -> ${String(link)}: the lecture does not exist` })
        } else if (g.graph && g.graph !== 'invalid' && nodeIds.size > 0 && !nodeIds.has(node)) {
          issues.push({ level: 'warn', code: 'graph.binding_node_unknown', file: g.bindingsFile, message: `binding ${node}: no such node in graph.json` })
        }
      }
    }
  }
  return issues
}
