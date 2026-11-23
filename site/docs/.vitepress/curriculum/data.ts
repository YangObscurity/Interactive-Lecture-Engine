/**
 * curriculum/data.ts - the curriculum the home map draws, built from plain values (P4a WP-H1,
 * docs-dev/MAP.md). Pure: no Node, no VitePress, no DOM. `node.mts` reads the disk and feeds it; the
 * tests feed it literals.
 *
 *   groups      the course groups in the order of groups.mts (temporary groups last), lectures by number
 *   edges       direct prerequisites between lectures `[from, to]` (`from` must be read before `to`): the union of
 *               `graph.json` (through `node.lecture`) and the `requires:` of the lecture frontmatter; an edge that points
 *               at a lecture that does not exist is dropped with a warning
 *   phases      the stages of a group: frontmatter `phase`, else the prototype's auto-chunking for groups of more than 8
 *               lectures (stages of 3-4), else none
 *
 * Lecture ids are `core/route.ts` ids in lower case (`g05-l19`), the same as the progress store uses, so the map can
 * look a status up without any conversion.
 */
import { pickLocalized } from '../i18n/index.ts'
import type { GroupI18n } from '../i18n/data.ts'
import type { LangCode } from '../i18n/langs.ts'
import { parseLecture } from '../theme/core/route.ts'

// ---- shapes -----------------------------------------------------------------------------------------------------

export interface CurriculumLecture {
  /** `g05-l19`. */
  id: string
  /** Lecture number (from the file name `L19.md`). */
  n: number
  /** Title without the "Lecture 19 ·" prefix. In a language the lecture is not translated into: the root-language title. */
  title: string
  /** URL path of the page to open (the translated page, or the root-language page when `untranslated`). */
  link: string
  /** Set (always `true`) when the title and the link are the root-language ones because the language has no translation of it. */
  untranslated?: true
  // ---- Notion fields (P4a WP-H3, docs-dev/MAP.md): present only when the lecture has a node in graph.json (and a
  // ---- record in graph-notion.json). They are the Chinese originals in every language bucket. Missing data = field absent.
  /** Node id in `graph.json`. */
  node?: string
  /** Notion category title (`graph.json` `categories[].title` of the node's category). */
  category?: string
  /** The Notion 说明 text. */
  desc?: string
  /** Difficulty, 1-5. */
  diff?: number
  /** Estimated minutes. */
  min?: number
  /** Link to the material (http / https only). */
  url?: string
}

/** The Notion fields of a lecture (a `CurriculumLecture` without the page fields). */
export type NotionFields = Pick<CurriculumLecture, 'node' | 'category' | 'desc' | 'diff' | 'min' | 'url'>

export interface CurriculumPhase {
  /** Frontmatter `phase`, or the lecture range `1-4` (with an en dash) for an automatic phase. */
  name: string
  /** Lecture numbers (`n`) of its first and last lecture, both inclusive. */
  from: number
  to: number
}

export interface CurriculumGroup {
  id: string
  dir: string
  title: string
  /** Category name in the language of the data; '' when the group has none. */
  category: string
  /** Colour slot 1-8 of the category (`--lec-cat-<slot>`), assigned over ALL groups of the site, so it does not move when a group is left out. */
  catSlot: number
  /** P4b: false when omitted from the dependency canvas (`groups.mts` `map: false`); stays in atlas and cards. */
  map?: false
  lectures: CurriculumLecture[]
  phases: CurriculumPhase[]
}

export interface CurriculumStats {
  groups: number
  lectures: number
  edges: number
}

export interface CurriculumData {
  version: 1
  /** Locale bucket of the data: `root` or a locale key (`en`), the same names `themeConfig` / `useData().localeIndex` use. */
  locale: string
  groups: CurriculumGroup[]
  /** `[from, to]` lecture ids, sorted. */
  edges: [string, string][]
  stats: CurriculumStats
}

export function statsOf(groups: readonly CurriculumGroup[], edges: readonly unknown[]): CurriculumStats {
  return { groups: groups.length, lectures: groups.reduce((n, g) => n + g.lectures.length, 0), edges: edges.length }
}

export function emptyCurriculum(locale: string): CurriculumData {
  return { version: 1, locale, groups: [], edges: [], stats: { groups: 0, lectures: 0, edges: 0 } }
}

// ---- ids and titles ---------------------------------------------------------------------------------------------

function lastSegment(dir: string): string {
  return dir.split('/').filter(Boolean).pop() ?? ''
}

/** `lectureIdOf('courses/g01', 3)` -> `g01-l03`. */
export function lectureIdOf(dir: string, n: number): string {
  const r = parseLecture(`/${dir}/L${n}`)
  return (r ? r.lectureId : `${lastSegment(dir)}-L${String(n).padStart(2, '0')}`).toLowerCase()
}

/** Id and group of a lecture page path (`/g01/L13`); null when the path is not a lecture page. */
export function lectureOfPath(path: string): { id: string; group: string } | null {
  const r = parseLecture(path)
  return r ? { id: r.lectureId.toLowerCase(), group: r.group } : null
}

const NUMBER_PREFIX_RE = /^\s*(?:第\s*0*\d+\s*讲|(?:[A-Za-z]+\s+)?Lecture\s+0*\d+)\s*[·:：—\u2013-]\s*/

/** `第5讲 · 电阻` -> `电阻`, `Example Lecture 1 · Ohm's Law` -> `Ohm's Law`; a title that is only the prefix stays as it is. */
export function stripLectureNumber(title: string): string {
  const s = title.replace(NUMBER_PREFIX_RE, '').trim()
  return s === '' ? title.trim() : s
}

// ---- requires ---------------------------------------------------------------------------------------------------

/**
 * Lecture id a `requires` entry points at, or null when the entry is not a lecture reference. Accepted forms:
 * `g05/L18` and `/g05/L18` (also with nested directories: `courses/g01/L01`), `L18` (a lecture of the same group),
 * `g05-L18` (a lecture id).
 */
export function resolveRequire(ref: string, ownDir: string): { id: string; group: string } | null {
  const v = ref.trim().replace(/^\/+/, '').replace(/\.md$/i, '')
  if (v === '') return null
  if (/^L\d+$/i.test(v)) return lectureOfPath(`/${ownDir}/${v}`)
  const byPath = lectureOfPath(`/${v}`)
  if (byPath) return byPath
  const byId = /^([^/\s]+)-L(\d+)$/i.exec(v)
  if (byId) {
    const n = Number(byId[2])
    const group = (byId[1] as string).toLowerCase()
    return { id: `${group}-l${String(n).padStart(2, '0')}`, group }
  }
  return null
}

// ---- phases -----------------------------------------------------------------------------------------------------

/** Groups of more than this many lectures are cut into automatic phases when no lecture names a phase. */
export const AUTO_PHASE_MIN_LECTURES = 8

/** Sizes of the automatic phases of a group of `n` lectures: `ceil(n/4)` phases, the first `n % phases` one lecture bigger. */
export function autoPhaseSizes(n: number): number[] {
  if (n <= AUTO_PHASE_MIN_LECTURES) return []
  const nc = Math.ceil(n / 4)
  const base = Math.floor(n / nc)
  const extra = n % nc
  return Array.from({ length: nc }, (_, k) => base + (k < extra ? 1 : 0))
}

function rangeName(from: number, to: number): string {
  return `${from}\u2013${to}`
}

export interface PhaseInput {
  n: number
  phase: string | null
}

/**
 * The phases of a group (lectures in number order). Frontmatter wins: when any lecture names a phase, a lecture without
 * one belongs to the phase before it, one at the very start (before the first name) forms a phase named by its range,
 * and consecutive lectures with the same name are one phase. Without frontmatter phases: groups of more than 8
 * lectures are cut automatically, smaller groups have no phases.
 */
export function buildPhases(lectures: readonly PhaseInput[]): CurriculumPhase[] {
  const ls = [...lectures].sort((a, b) => a.n - b.n)
  if (ls.length === 0) return []
  if (ls.some((l) => l.phase !== null)) {
    const out: CurriculumPhase[] = []
    let cur: string | null = null
    let leadingEnd = -1
    ls.forEach((l, i) => {
      if (l.phase === null && cur === null) {
        leadingEnd = i
        return
      }
      const name = l.phase ?? (cur as string)
      const last = out[out.length - 1]
      if (last && name === cur) last.to = l.n
      else out.push({ name, from: l.n, to: l.n })
      cur = name
    })
    if (leadingEnd >= 0) out.unshift({ name: rangeName((ls[0] as PhaseInput).n, (ls[leadingEnd] as PhaseInput).n), from: (ls[0] as PhaseInput).n, to: (ls[leadingEnd] as PhaseInput).n })
    return out
  }
  const sizes = autoPhaseSizes(ls.length)
  const out: CurriculumPhase[] = []
  let i = 0
  for (const size of sizes) {
    const part = ls.slice(i, i + size)
    out.push({ name: rangeName((part[0] as PhaseInput).n, (part[part.length - 1] as PhaseInput).n), from: (part[0] as PhaseInput).n, to: (part[part.length - 1] as PhaseInput).n })
    i += size
  }
  return out
}

// ---- inputs -----------------------------------------------------------------------------------------------------

export interface SourceLecture {
  n: number
  /** Root-language page path, e.g. `/g05/L18` (the key of the translation map). */
  link: string
  /** Root-language frontmatter title (with its number prefix); null / '' when the file has none. */
  title: string | null
  /** Frontmatter `requires` entries, as written. */
  requires: readonly string[]
  /** Frontmatter `phase`. */
  phase: string | null
}

export interface SourceGroup {
  id: string
  dir: string
  title: string
  category?: string
  map?: false
  i18n?: GroupI18n
  lectures: readonly SourceLecture[]
}

export interface GraphLike {
  nodes: ReadonlyArray<{ id?: unknown; lecture?: unknown; category?: unknown }>
  edges: ReadonlyArray<unknown>
  /** `[{ id: 'cat_13', title: '...' }]`; optional. */
  categories?: ReadonlyArray<unknown>
}

/** `graph-notion.json`: node id -> `{ desc, diff, min, url }` (every field optional). */
export type NotionLike = Readonly<Record<string, unknown>>

export interface LocaleInput {
  /** `root` or a locale key (`en`). */
  key: string
  lang: LangCode
  /** Root page path (`/g05/L18`) -> the translated page. Absent for the root language. */
  translations?: Readonly<Record<string, { link: string; title: string }>>
}

export interface BuildInput {
  /** The built groups in display order. */
  groups: readonly SourceGroup[]
  /** Directories of groups that exist but are not part of this build: edges to their lectures are dropped without a warning. */
  notBuiltDirs?: readonly string[]
  graph?: GraphLike | null
  /** Notion properties of the graph nodes (`site/data/graph-notion.json`); missing = lectures have no Notion fields beyond node and category. */
  notion?: NotionLike | null
  /** One entry per language; must contain `root`. */
  locales: readonly LocaleInput[]
  /** Colour slot of a group (assigned over all groups of the site). */
  slotOf: (groupId: string) => number
  /** Title of a lecture whose file has none (`第 5 讲`). */
  fallbackTitle: (lang: LangCode, n: number) => string
}

export type DropReason = 'missing-node' | 'missing-lecture' | 'not-built' | 'self'

export interface DroppedEdge {
  source: 'graph' | 'requires'
  reason: DropReason
  /** Human-readable ends (ids, node ids or the written reference). */
  from: string
  to: string
}

export interface CurriculumBuild {
  /** One entry per locale bucket (`root`, `en`, ...). */
  byLocale: Record<string, CurriculumData>
  dropped: DroppedEdge[]
  /** Messages for the build log: every dropped edge except the quiet reasons (`not-built`, `self`). */
  warnings: string[]
  edgeSources: { graph: number; requires: number; both: number; union: number }
}

const byPair = (a: readonly [string, string], b: readonly [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)

// ---- Notion fields ----------------------------------------------------------------------------------------------

/** Keep a Notion link only when it is an absolute http(s) URL (the panel renders it as a link). */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : undefined
}

/** The fields one node record holds, with every malformed value left out. */
export function notionFieldsOf(rec: unknown): Pick<NotionFields, 'desc' | 'diff' | 'min' | 'url'> {
  const out: Pick<NotionFields, 'desc' | 'diff' | 'min' | 'url'> = {}
  if (!isRec(rec)) return out
  if (typeof rec.desc === 'string' && rec.desc.trim() !== '') out.desc = rec.desc.trim()
  if (typeof rec.diff === 'number' && Number.isFinite(rec.diff) && rec.diff >= 1 && rec.diff <= 5) out.diff = Math.round(rec.diff)
  if (typeof rec.min === 'number' && Number.isFinite(rec.min) && rec.min > 0) out.min = Math.round(rec.min)
  const url = safeUrl(rec.url)
  if (url !== undefined) out.url = url
  return out
}

/**
 * Notion fields per lecture id, from the graph (node id, category title) and the Notion record of the node. A lecture with
 * no node gets no entry; a second node on the same lecture is ignored (the first in graph order wins).
 */
export function notionByLecture(graph: GraphLike | null | undefined, notion: NotionLike | null | undefined): Map<string, NotionFields> {
  const out = new Map<string, NotionFields>()
  if (!graph) return out
  const titles = new Map<string, string>()
  for (const c of graph.categories ?? []) if (isRec(c) && typeof c.id === 'string' && typeof c.title === 'string' && c.title.trim() !== '') titles.set(c.id, c.title.trim())
  for (const n of graph.nodes) {
    if (typeof n.id !== 'string' || typeof n.lecture !== 'string') continue
    const hit = lectureOfPath(n.lecture)
    if (!hit || out.has(hit.id)) continue
    const f: NotionFields = { node: n.id }
    const cat = typeof n.category === 'string' ? titles.get(n.category) : undefined
    if (cat !== undefined) f.category = cat
    Object.assign(f, notionFieldsOf(notion?.[n.id]))
    out.set(hit.id, f)
  }
  return out
}

// ---- build ------------------------------------------------------------------------------------------------------

/** Build the curriculum of every locale. Edges and phases do not depend on the language. */
export function buildCurriculum(input: BuildInput): CurriculumBuild {
  const rootLoc = input.locales.find((l) => l.key === 'root')
  if (!rootLoc) throw new Error("buildCurriculum: locales must contain the 'root' entry")
  const warnings: string[] = []
  const dropped: DroppedEdge[] = []

  // lecture ids
  const known = new Map<string, string>()
  const phasesOf = new Map<string, CurriculumPhase[]>()
  const notBuilt = new Set((input.notBuiltDirs ?? []).map((d) => lastSegment(d).toLowerCase()))
  for (const g of input.groups) {
    for (const l of g.lectures) {
      const id = lectureIdOf(g.dir, l.n)
      if (known.has(id)) warnings.push(`lecture id ${id} is used by two lectures (${known.get(id)} and ${g.id}); the later one wins in the edge lookup`)
      known.set(id, g.id)
    }
    phasesOf.set(g.id, buildPhases(g.lectures))
  }

  // edges: graph.json
  const fromGraph = new Set<string>()
  const key = (a: string, b: string): string => `${a}\u0000${b}`
  const note = (d: DroppedEdge, text: string, quiet: boolean): void => {
    dropped.push(d)
    if (!quiet) warnings.push(text)
  }
  if (input.graph) {
    const nodeLecture = new Map<string, { id: string; state: 'ok' | 'missing' | 'not-built' }>()
    for (const n of input.graph.nodes) {
      if (typeof n.id !== 'string' || typeof n.lecture !== 'string') continue
      const hit = lectureOfPath(n.lecture)
      if (!hit) continue
      nodeLecture.set(n.id, { id: hit.id, state: known.has(hit.id) ? 'ok' : notBuilt.has(hit.group) ? 'not-built' : 'missing' })
    }
    for (const e of input.graph.edges) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || typeof e[1] !== 'string') continue
      const [a, b] = [e[0], e[1]]
      const na = nodeLecture.get(a)
      const nb = nodeLecture.get(b)
      if (na?.state === 'not-built' || nb?.state === 'not-built') {
        dropped.push({ source: 'graph', reason: 'not-built', from: na?.id ?? a, to: nb?.id ?? b })
      } else if (!na || !nb) {
        note({ source: 'graph', reason: 'missing-node', from: a, to: b }, `graph.json edge ${a} -> ${b} dropped: ${na ? b : a} is not a node with a lecture`, false)
      } else if (na.state === 'missing' || nb.state === 'missing') {
        note({ source: 'graph', reason: 'missing-lecture', from: na.id, to: nb.id }, `graph.json edge ${a} -> ${b} dropped: lecture ${na.state === 'missing' ? na.id : nb.id} does not exist`, false)
      } else if (na.id === nb.id) {
        dropped.push({ source: 'graph', reason: 'self', from: na.id, to: nb.id })
      } else fromGraph.add(key(na.id, nb.id))
    }
  }

  // edges: frontmatter requires
  const fromRequires = new Set<string>()
  for (const g of input.groups) {
    for (const l of g.lectures) {
      const to = lectureIdOf(g.dir, l.n)
      for (const ref of l.requires) {
        const hit = resolveRequire(ref, g.dir)
        if (!hit) {
          note({ source: 'requires', reason: 'missing-lecture', from: ref, to }, `${to}: requires "${ref}" is not a lecture reference (use g05/L18); dropped`, false)
        } else if (known.has(hit.id)) {
          if (hit.id === to) dropped.push({ source: 'requires', reason: 'self', from: hit.id, to })
          else fromRequires.add(key(hit.id, to))
        } else if (notBuilt.has(hit.group)) {
          dropped.push({ source: 'requires', reason: 'not-built', from: hit.id, to })
        } else {
          note({ source: 'requires', reason: 'missing-lecture', from: hit.id, to }, `${to}: requires ${ref} dropped: lecture ${hit.id} does not exist`, false)
        }
      }
    }
  }

  const union = new Set<string>([...fromGraph, ...fromRequires])
  const edges = [...union].map((k) => k.split('\u0000') as [string, string]).sort(byPair)
  const both = [...fromGraph].filter((k) => fromRequires.has(k)).length

  const notionOf = notionByLecture(input.graph, input.notion)
  const byLocale: Record<string, CurriculumData> = {}
  for (const loc of input.locales) {
    const groups: CurriculumGroup[] = input.groups.map((g) => ({
      id: g.id,
      dir: g.dir,
      title: pickLocalized(g, loc.lang, 'title'),
      category: pickLocalized(g, loc.lang, 'category'),
      catSlot: input.slotOf(g.id),
      ...(g.map === false ? { map: false as const } : {}),
      lectures: [...g.lectures]
        .sort((a, b) => a.n - b.n)
        .map((l): CurriculumLecture => {
          const id = lectureIdOf(g.dir, l.n)
          const notionFields = notionOf.get(id)
          const rootTitle = stripLectureNumber(l.title && l.title.trim() !== '' ? l.title : input.fallbackTitle(rootLoc.lang, l.n))
          const base = ((): CurriculumLecture => {
            if (loc.key === 'root' || loc.translations === undefined) return { id, n: l.n, title: rootTitle, link: l.link }
            const tr = loc.translations[l.link]
            if (!tr) return { id, n: l.n, title: rootTitle, link: l.link, untranslated: true }
            return { id, n: l.n, title: stripLectureNumber(tr.title !== '' ? tr.title : input.fallbackTitle(loc.lang, l.n)), link: tr.link }
          })()
          return notionFields ? { ...base, ...notionFields } : base
        }),
      phases: (phasesOf.get(g.id) ?? []).map((p) => ({ ...p })),
    }))
    byLocale[loc.key] = { version: 1, locale: loc.key, groups, edges: edges.map((e) => [e[0], e[1]] as [string, string]), stats: statsOf(groups, edges) }
  }

  return { byLocale, dropped, warnings, edgeSources: { graph: fromGraph.size, requires: fromRequires.size, both, union: union.size } }
}

// ---- runtime check ----------------------------------------------------------------------------------------------

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Shape check of JSON that claims to be a CurriculumData (the client treats anything else as unreadable). */
export function isCurriculumData(v: unknown): v is CurriculumData {
  if (!isRec(v) || v.version !== 1 || typeof v.locale !== 'string' || !Array.isArray(v.groups) || !Array.isArray(v.edges) || !isRec(v.stats)) return false
  return v.groups.every((g) => isGroup(g)) && v.edges.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')
}

function isLecture(l: unknown): l is CurriculumLecture {
  if (!isRec(l) || typeof l.id !== 'string' || typeof l.n !== 'number' || typeof l.title !== 'string' || typeof l.link !== 'string') return false
  const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string'
  const optNum = (v: unknown): boolean => v === undefined || (typeof v === 'number' && Number.isFinite(v))
  return optStr(l.node) && optStr(l.category) && optStr(l.desc) && optStr(l.url) && optNum(l.diff) && optNum(l.min)
}

export function isGroup(g: unknown): g is CurriculumGroup {
  return (
    isRec(g) &&
    typeof g.id === 'string' &&
    typeof g.dir === 'string' &&
    typeof g.title === 'string' &&
    typeof g.category === 'string' &&
    typeof g.catSlot === 'number' &&
    (g.map === undefined || g.map === false) &&
    Array.isArray(g.lectures) &&
    g.lectures.every(isLecture) &&
    Array.isArray(g.phases) &&
    g.phases.every((p) => isRec(p) && typeof p.name === 'string' && typeof p.from === 'number' && typeof p.to === 'number')
  )
}
