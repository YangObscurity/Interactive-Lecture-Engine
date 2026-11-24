/**
 * search/markdown.ts - Pure markdown extraction and pruning for WP-F3.
 *
 * Strips:
 *   - YAML frontmatter (respects `search: false`)
 *   - fenced code blocks & chart sources (`mermaid`, `mermaid:chart`, `echarts`, `wavedrom`, etc.)
 *   - display math (`$$...$$`, `\[...\]`) & inline math (`\(...\)`)
 *   - HTML comments (`<!-- ... -->`) and raw HTML tags / heavy blocks (`<svg>`, `<style>`, `<script>`, `<figure>`)
 * Keeps:
 *   - document title, section headings (`H2`..`H4` with hierarchical breadcrumb paths & VitePress-compatible anchors),
 *     and clean prose text (paragraphs, list items, blockquotes, readable table cells without syntax noise).
 */
import { slugifyHeading } from './format.ts'

export interface HeadingEntry {
  level: number
  text: string
  slug: string
  path: string[]
}

export interface SectionEntry {
  anchor: string
  path: string[]
  text: string
}

export interface ExtractedPage {
  title: string
  skipped: boolean
  headings: HeadingEntry[]
  sections: SectionEntry[]
}

interface ParsedFrontmatter {
  title?: string
  searchDisabled: boolean
  body: string
}

export function parseFrontmatter(md: string): ParsedFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md)
  if (!m) return { searchDisabled: false, body: md }
  const fm = m[1] ?? ''
  const body = md.slice(m[0].length)
  const searchDisabled = /^search:\s*false\b/m.test(fm)
  const titleMatch = /^title:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\r\n]+))\s*$/m.exec(fm)
  let title: string | undefined
  if (titleMatch) {
    if (titleMatch[1] !== undefined) title = titleMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim()
    else if (titleMatch[2] !== undefined) title = titleMatch[2].replace(/\\'/g, "'").trim()
    else if (titleMatch[3] !== undefined) title = titleMatch[3].trim()
  }
  return { title, searchDisabled, body }
}

function decodeBasicEntities(str: string): string {
  return str
    .replace(/&ZeroWidthSpace;|&#x200b;|&#8203;|\u200b/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

/** Strip fenced code blocks and chart fences line-by-line (supporting >= opening fence length & nested fences). */
export function stripFences(md: string): string {
  const lines = md.split(/\r?\n/)
  const out: string[] = []
  let activeFence: { ch: string; len: number } | null = null

  for (const line of lines) {
    if (!activeFence) {
      // Handle top-level or blockquote-indented fences (` ```lang` or `~~~lang`)
      const m = /^[ \t>]{0,6}(`{3,}|~{3,})([^\n]*)$/.exec(line)
      if (m) {
        const seq = m[1] ?? '```'
        activeFence = { ch: seq[0] ?? '`', len: seq.length }
        continue
      }
      out.push(line)
    } else {
      const closeRe = new RegExp(`^[ \\t>]{0,6}${activeFence.ch}{${activeFence.len},}[ \\t]*$`)
      if (closeRe.test(line)) {
        activeFence = null
      }
    }
  }
  return out.join('\n')
}

function stripNonProseBlocks(raw: string): string {
  let s = stripFences(raw)
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<(script|style|svg|figure)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  // Display and inline KaTeX math (`$$...$$`, `\[...\]`, `\(...\)`)
  s = s.replace(/\$\$[\s\S]*?\$\$/g, ' ')
  s = s.replace(/\\\[[\s\S]*?\\\]/g, ' ')
  s = s.replace(/\\\([\s\S]*?\\\)/g, ' ')
  return s
}

function cleanHeadingText(raw: string): string {
  let s = raw.replace(/\s*#+\s*$/, '')
  s = s.replace(/\\\([\s\S]*?\\\)/g, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1')
  s = s.replace(/~~([^~]+)~~/g, '$1')
  s = decodeBasicEntities(s)
  return s.replace(/\s+/g, ' ').trim()
}

export function cleanProseSegment(raw: string): string {
  let s = stripNonProseBlocks(raw)
  // Drop lecture metadata quote lines (`> 节点 \`...\`` / `> Node \`...\``)
  s = s.replace(/^[ \t]*>\s*(?:\*\*)?(?:节点标识|节点|Node)(?=\s|:|：|\*|$)[^\n]*$/gim, ' ')
  // Drop VitePress custom container fences (`::: tip`, `::: details Title` -> keep Title only)
  s = s.replace(/^[ \t]*:::[ \t]*(?:tip|info|warning|danger|caution|details|raw)?[ \t]*/gim, ' ')
  // Drop horizontal rules / setext lines
  s = s.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, ' ')
  // Drop pipe-table alignment separators (`| :--- | :---: |`), turn remaining pipes into space separators
  s = s.replace(/^[ \t]*\|[\s:-]+(?:\|[\s:-]+)*\|?[ \t]*$/gm, ' ')
  s = s.replace(/\|/g, ' ')
  // Markdown images and links
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
  // empty-text links left over (`[](fig:id)` the index builder could not number, search/figureLabels.ts) carry no prose
  s = s.replace(/\[\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // Strip remaining HTML tags (preserving inner prose such as cite chip labels)
  s = s.replace(/<[^>]+>/g, ' ')
  // Remove bare HTTP/HTTPS URLs
  s = s.replace(/https?:\/\/\S+/g, ' ')
  // Clean list markers & blockquote prefixes
  s = s.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, ' ')
  s = s.replace(/^[ \t]*>+[ \t]?/gm, ' ')
  // Strip inline formatting syntax while preserving identifiers like `gpio_set_level`
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/[*~]+/g, '')
  s = s.replace(/(^|\s)__(?=\S)|(?<=\S)__(?=\s|$)/g, '$1')
  s = decodeBasicEntities(s)
  return s.replace(/\s+/g, ' ').trim()
}

const HEADING_RE = /^[ ]{0,3}(#{1,4})[ \t]+(.+?)\s*$/

/** Parse and prune a single Markdown document into searchable title/headings metadata and section texts. */
export function extractSearchablePage(md: string, fallbackTitle: string): ExtractedPage {
  const { title: fmTitle, searchDisabled, body } = parseFrontmatter(md)
  if (searchDisabled) {
    return { title: fmTitle ?? fallbackTitle, skipped: true, headings: [], sections: [] }
  }

  // First remove fenced blocks, comments, heavy HTML blocks and display math before splitting headings
  const cleanStructure = stripNonProseBlocks(body)
  const lines = cleanStructure.split(/\r?\n/)

  let firstH1 = ''
  const headings: HeadingEntry[] = []
  const sections: SectionEntry[] = []
  const seenSlugs = Object.create(null) as Record<string, true>
  const stack: Array<{ level: number; text: string }> = []

  let curAnchor = ''
  let curPath: string[] = []
  let buf: string[] = []

  const flush = (): void => {
    if (buf.length === 0) return
    const text = cleanProseSegment(buf.join('\n'))
    buf = []
    if (!text) return
    sections.push({ anchor: curAnchor, path: [...curPath], text })
  }

  for (const line of lines) {
    const hm = HEADING_RE.exec(line)
    if (hm) {
      flush()
      const level = (hm[1] ?? '#').length
      const text = cleanHeadingText(hm[2] ?? '')
      if (!text) continue

      const baseSlug = slugifyHeading(text)
      let slug = baseSlug
      let idx = 1
      while (Object.prototype.hasOwnProperty.call(seenSlugs, slug)) {
        slug = `${baseSlug}-${idx++}`
      }
      seenSlugs[slug] = true

      if (level === 1) {
        if (!firstH1) firstH1 = text
        curAnchor = slug
        curPath = []
        continue
      }

      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
        stack.pop()
      }
      const path = stack.map((s) => s.text)
      stack.push({ level, text })
      headings.push({ level, text, slug, path })
      curAnchor = slug
      curPath = [...path, text]
    } else {
      buf.push(line)
    }
  }
  flush()

  return {
    title: fmTitle || firstH1 || fallbackTitle,
    skipped: false,
    headings,
    sections,
  }
}
