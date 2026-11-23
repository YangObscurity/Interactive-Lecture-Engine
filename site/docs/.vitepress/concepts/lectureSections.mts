/**
 * concepts/lectureSections.mts - cut a lecture into the `sections` of `tools/lectures.json`.
 *
 * A section starts at every `##` or `###` heading (a `###` ends the `##` before it: sections are flat). Its `anchor`
 * is the id VitePress gives the heading: the headings come from the markdown-it token stream of VitePress' own
 * renderer (`createMarkdownRenderer`: same slugify, same `{#id}` attributes, same de-duplication `-1`, `-2`), not from
 * a copy of its slug rules. `text` is the section's Markdown with HTML tags, comments, `<script>`/`<style>` blocks and
 * Vue components removed; math, code and tables are kept.
 */
import path from 'node:path'
import { splitMarkdownFrontmatter } from './frontmatter.ts'
import { computeMathRangesInBody } from './sourceRewriter.ts'

export interface LectureSection {
  heading: string
  anchor: string
  text: string
}

/** The part of a markdown-it token this module reads. */
export interface ParsedToken {
  type: string
  tag: string
  level: number
  map: [number, number] | null
  content: string
  attrGet(name: string): string | null
}

/** A markdown-it instance (VitePress' `MarkdownRenderer` is one): only `parse` is used. */
export interface MarkdownParser {
  parse(src: string, env: object): ParsedToken[]
}

let parserPromise: Promise<MarkdownParser> | null = null

/**
 * The renderer VitePress builds from its defaults plus the site's math plugin (math tokens must not leak into heading
 * slugs; the other site plugins do not touch headings). One instance per process.
 */
export function createAnchorParser(srcDir: string): Promise<MarkdownParser> {
  parserPromise ??= (async () => {
    const { createMarkdownRenderer } = await import('vitepress')
    const { mathPlugin } = await import('../math.mts')
    const md = await createMarkdownRenderer(path.resolve(srcDir), { config: (m) => void m.use(mathPlugin) }, '/')
    return md as unknown as MarkdownParser
  })()
  return parserPromise
}

const LINE_BREAK = /\r\n?|\n/

const HEADING_ATTRS = /\s*\{[#.][^}]*\}\s*$/

function headingText(token: ParsedToken | undefined): string {
  return (token?.content ?? '')
    .replace(HEADING_ATTRS, '')
    .replace(/(\*\*|__)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A lead made of horizontal rules only (`---` under the H1) is not text. */
const ONLY_RULES = /^(?:[-*_]{3,}\s*)+$/

const MASK = '\u{F0000}'

/**
 * Markdown -> the text the tools serve: tags and components out, math, code and tables in. Fenced code, inline code
 * and math are masked first, so `<` and `>` inside them (`a<b`, `Vec<int>`) survive.
 */
export function stripMarkupForTools(markdown: string): string {
  const kept: string[] = []
  const mask = (chunk: string): string => {
    kept.push(chunk)
    return `${MASK}${kept.length - 1}${MASK}`
  }

  // fenced code (``` or ~~~), line by line
  const out: string[] = []
  let fence: string | null = null
  let buf: string[] = []
  for (const line of markdown.split(LINE_BREAK)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence === null) {
      if (m) {
        fence = (m[1] as string)[0] as string
        buf = [line]
      } else {
        out.push(line)
      }
    } else {
      buf.push(line)
      if (m && (m[1] as string)[0] === fence) {
        out.push(mask(buf.join('\n')))
        fence = null
        buf = []
      }
    }
  }
  if (fence !== null) out.push(mask(buf.join('\n')))
  let text = out.join('\n')

  // math: \( \), \[ \], $$ $$
  const ranges = computeMathRangesInBody(text)
  if (ranges.length > 0) {
    let rebuilt = ''
    let cursor = 0
    for (const r of ranges) {
      rebuilt += text.slice(cursor, r.start) + mask(text.slice(r.start, r.end))
      cursor = r.end
    }
    text = rebuilt + text.slice(cursor)
  }

  // inline code
  text = text.replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, (m) => mask(m))

  text = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[A-Za-z][\w:.-]*(?:"[^"]*"|'[^']*'|[^<>"'])*>/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')

  const restore = new RegExp(`${MASK}(\\d+)${MASK}`, 'gu')
  return text.replace(restore, (_m, i: string) => kept[Number(i)] ?? '').trim()
}

interface HeadingMark {
  tag: string
  start: number
  end: number
  anchor: string
  heading: string
}

/**
 * Sections of one lecture file. `relativePath` is the page path under docs/ (`lr/L01.md`). `title` names the lead section (text before the first `##`/`###`, the H1 line left
 * out); that section is omitted when it has no text.
 */
export function splitLectureSections(raw: string, md: MarkdownParser, title = '', relativePath = ''): LectureSection[] {
  const { body } = splitMarkdownFrontmatter(raw ?? '')
  const lines = body.split(LINE_BREAK)
  // the site's own markdown plugins run too (concept links check the tier of the page), so they need the page path
  const tokens = md.parse(body, relativePath ? { relativePath } : {})
  const marks: HeadingMark[] = []
  tokens.forEach((t, i) => {
    if (t.type !== 'heading_open' || t.level !== 0 || !t.map) return
    marks.push({ tag: t.tag, start: t.map[0], end: t.map[1], anchor: t.attrGet('id') ?? '', heading: headingText(tokens[i + 1]) })
  })

  const cut = marks.filter((m) => m.tag === 'h2' || m.tag === 'h3')
  const sections: LectureSection[] = []

  const firstCut = cut[0]?.start ?? lines.length
  const h1Lines = new Set<number>()
  let lead: HeadingMark | undefined
  for (const m of marks) {
    if (m.tag !== 'h1' || m.start >= firstCut) continue
    lead ??= m
    for (let l = m.start; l < m.end; l++) h1Lines.add(l)
  }
  const leadText = stripMarkupForTools(lines.slice(0, firstCut).filter((_l, i) => !h1Lines.has(i)).join('\n'))
  if (leadText && !ONLY_RULES.test(leadText)) sections.push({ heading: lead?.heading || title, anchor: lead?.anchor ?? '', text: leadText })

  cut.forEach((m, i) => {
    const next = cut[i + 1]?.start ?? lines.length
    sections.push({ heading: m.heading, anchor: m.anchor, text: stripMarkupForTools(lines.slice(m.end, next).join('\n')) })
  })
  return sections
}
