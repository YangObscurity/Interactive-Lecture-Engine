/**
 * curriculum/frontmatter.ts - the few frontmatter fields the curriculum needs (P4a, docs-dev/MAP.md).
 * Pure: no Node, no VitePress. A lecture file may carry
 *
 *   title: "第5讲 · ..."             the sidebar title (quotes stripped, like i18n/scan.mts readTitle)
 *   requires: [g05/L18, g05/L19]    direct prerequisites; also a block list ("- g05/L18" lines)
 *   phase: 基础                      the phase the lecture belongs to (consecutive lectures with one name = one phase)
 *
 * This is a reader of these keys, not a YAML parser: nested values, anchors and multi-line scalars are not supported.
 */

export interface LectureFrontmatter {
  title: string | null
  requires: string[]
  phase: string | null
}

/** The text between the opening `---` line and the next `---` line, or '' when the file has no frontmatter. */
export function frontmatterBlock(src: string): string {
  const text = src.replace(/^\uFEFF/, '')
  if (!/^---[ \t]*\r?\n/.test(text)) return ''
  const rest = text.replace(/^---[ \t]*\r?\n/, '')
  const end = /^---[ \t]*$/m.exec(rest)
  return end ? rest.slice(0, end.index) : ''
}

/** `"a b"` / `'a b'` / `a b` -> `a b` (a quoted value keeps `#`; an unquoted one ends at ` #`). */
export function unquote(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'")
  return v.replace(/\s+#.*$/, '').trim()
}

/** Items of a flow list `[a, "b, c", 'd']`; commas inside quotes stay in the item. */
export function parseFlowList(raw: string): string[] {
  const body = raw.trim().replace(/^\[/, '').replace(/\]\s*(?:#.*)?$/, '')
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of body) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map(unquote).filter((s) => s !== '')
}

/** Read `title`, `requires` and `phase` from a markdown source. Missing keys give null / []. */
export function readLectureFrontmatter(src: string): LectureFrontmatter {
  const lines = frontmatterBlock(src).split(/\r?\n/)
  const out: LectureFrontmatter = { title: null, requires: [], phase: null }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as string
    const value = (m[2] as string).trim()
    if (key === 'title') {
      const t = unquote(value)
      if (t !== '') out.title = t
    } else if (key === 'phase') {
      const p = unquote(value)
      if (p !== '') out.phase = p
    } else if (key === 'requires') {
      if (value.startsWith('[')) out.requires = parseFlowList(value)
      else if (value === '' || value.startsWith('#')) {
        const items: string[] = []
        while (i + 1 < lines.length) {
          const item = /^\s*-\s+(.*)$/.exec(lines[i + 1] as string)
          if (!item) break
          const v = unquote(item[1] as string)
          if (v !== '') items.push(v)
          i++
        }
        out.requires = items
      } else {
        const v = unquote(value)
        out.requires = v === '' ? [] : [v]
      }
    }
  }
  return out
}
