/**
 * concepts/related.ts - the `related` frontmatter of a concept page: relation types, the reading direction of each
 * type, and a dependency-free parser for the two YAML spellings authors use. Pure (no Node, no Vue), shared by the
 * frontmatter parser, the build checks and the page panels.
 *
 *   related:
 *     - { slug: optimistic-concurrency-control, rel: prerequisite }
 *     - slug: event-triggered-sampling          # block form works too
 *       rel: contrast
 *
 * Direction. `{ slug: T, rel }` written on page S describes T from S's point of view:
 *   prerequisite  T is a prerequisite of S            (S page lists T under "prerequisites")
 *   part-of       S is a part of T
 *   contrast      S and T are contrasted (symmetric)
 *   generalizes   S is the general form, T a special case of S
 *   special-case  S is a special case of T
 *   applied-in    S is applied in T
 * T's page shows S under the inverse role (see `RELATION_ROLE_IN`).
 */

export const CONCEPT_RELS = ['prerequisite', 'part-of', 'contrast', 'generalizes', 'special-case', 'applied-in'] as const
export type ConceptRel = (typeof CONCEPT_RELS)[number]

export interface ConceptRelation {
  slug: string
  rel: ConceptRel
}

/**
 * What the OTHER concept is, as seen from the page that lists it. Both directions of every relation map into
 * these nine roles, so a relation written on one page and its inverse on the other end share one heading.
 */
export const RELATION_ROLES = [
  'prerequisite',
  'required-by',
  'part-of',
  'has-part',
  'contrast',
  'generalization',
  'specialization',
  'applied-in',
  'applies',
] as const
export type RelationRole = (typeof RELATION_ROLES)[number]

/** Role of T on S's page for `S -> T` written with `rel`. */
export const RELATION_ROLE_OUT: Readonly<Record<ConceptRel, RelationRole>> = {
  prerequisite: 'prerequisite',
  'part-of': 'part-of',
  contrast: 'contrast',
  generalizes: 'specialization',
  'special-case': 'generalization',
  'applied-in': 'applied-in',
}

/** Role of S on T's page for the same relation (the inverse reading). */
export const RELATION_ROLE_IN: Readonly<Record<ConceptRel, RelationRole>> = {
  prerequisite: 'required-by',
  'part-of': 'has-part',
  contrast: 'contrast',
  generalizes: 'generalization',
  'special-case': 'specialization',
  'applied-in': 'applies',
}

export function isConceptRel(v: unknown): v is ConceptRel {
  return typeof v === 'string' && (CONCEPT_RELS as readonly string[]).includes(v)
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface ParsedRelated {
  relations: ConceptRelation[]
  /** One human readable message per entry that could not be used (unknown type, missing field, malformed). */
  problems: string[]
}

function unquote(raw: string): string {
  const t = raw.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1)
  return t.replace(/\s+#.*$/, '').trim()
}

/** Split on top-level commas (outside quotes, braces and brackets). */
function splitTopLevel(inner: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let quote: '"' | "'" | null = null
  for (const ch of inner) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '{' || ch === '[') {
      depth++
      cur += ch
    } else if (ch === '}' || ch === ']') {
      depth--
      cur += ch
    } else if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

function parseFlowMap(raw: string): Record<string, string> | null {
  const t = raw.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  const map: Record<string, string> = {}
  for (const pair of splitTopLevel(t.slice(1, -1))) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(pair)
    if (!m) return null
    map[m[1] as string] = unquote(m[2] ?? '')
  }
  return map
}

function indentOf(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? '').length
}

/** Raw entries of the `related:` key: each is a map of string fields, or a bare string that is not a map. */
function readEntries(frontmatter: string): Array<Record<string, string> | string> | null {
  const lines = frontmatter.split(/\r?\n/)
  const start = lines.findIndex((l) => /^related\s*:/.test(l))
  if (start < 0) return null
  const head = (lines[start] as string).replace(/^related\s*:\s*/, '').trim()
  if (head.startsWith('[')) {
    const inner = head.replace(/^\[/, '').replace(/\]\s*(?:#.*)?$/, '')
    return splitTopLevel(inner).map((item) => parseFlowMap(item) ?? unquote(item))
  }
  if (head !== '' && !head.startsWith('#')) return [head]

  const entries: Array<Record<string, string> | string> = []
  let i = start + 1
  while (i < lines.length) {
    const line = lines[i] as string
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const item = /^(\s*)-\s*(.*)$/.exec(line)
    if (!item) break
    const baseIndent = (item[1] ?? '').length
    const first = (item[2] ?? '').trim()
    const flow = parseFlowMap(first)
    if (flow) {
      entries.push(flow)
      i++
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(first)
    if (!kv) {
      entries.push(unquote(first))
      i++
      continue
    }
    const map: Record<string, string> = { [kv[1] as string]: unquote(kv[2] ?? '') }
    i++
    while (i < lines.length) {
      const next = lines[i] as string
      if (!next.trim() || next.trim().startsWith('#')) {
        i++
        continue
      }
      if (indentOf(next) <= baseIndent) break
      const m = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(next)
      if (!m) break
      map[m[1] as string] = unquote(m[2] ?? '')
      i++
    }
    entries.push(map)
  }
  return entries
}

/**
 * Parse the `related` key out of a frontmatter block (the text between the `---` lines). Never throws: entries that
 * cannot be used end up in `problems` (the build turns them into errors), the rest in `relations`.
 */
export function parseRelatedField(frontmatter: string): ParsedRelated {
  const entries = readEntries(frontmatter ?? '')
  const out: ParsedRelated = { relations: [], problems: [] }
  if (!entries) return out
  const seen = new Set<string>()
  entries.forEach((entry, idx) => {
    const where = `related[${idx}]`
    if (typeof entry === 'string') {
      out.problems.push(`${where}: expected { slug, rel }, got ${JSON.stringify(entry)}`)
      return
    }
    const slug = (entry.slug ?? '').trim()
    const rel = (entry.rel ?? '').trim()
    if (!slug || !rel) {
      out.problems.push(`${where}: needs both slug and rel (got ${JSON.stringify(entry)})`)
      return
    }
    if (!SLUG_RE.test(slug)) {
      out.problems.push(`${where}: "${slug}" is not a valid concept slug`)
      return
    }
    if (!isConceptRel(rel)) {
      out.problems.push(`${where}: unknown relation type "${rel}" (allowed: ${CONCEPT_RELS.join(', ')})`)
      return
    }
    const key = `${slug}|${rel}`
    if (seen.has(key)) return
    seen.add(key)
    out.relations.push({ slug, rel })
  })
  return out
}

/** `related:` block for the serializer (two-space list of flow maps); empty string when there is nothing to write. */
export function formatRelatedField(relations: readonly ConceptRelation[]): string {
  if (relations.length === 0) return ''
  return ['related:', ...relations.map((r) => `  - { slug: ${r.slug}, rel: ${r.rel} }`)].join('\n')
}
