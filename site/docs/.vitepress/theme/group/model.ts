/**
 * group/model.ts - the pure part of the group page (P4a WP-H3, docs-dev/MAP.md; port of the prototype's
 * `map.js`): the curriculum index, lanes, readiness, dependency chains, group-to-group counts, edge geometry, the
 * `#track-<lecture id>` anchor and newly ready lectures. No Vue, no DOM, no Node: tests/unit/group-model.test.ts.
 *
 * Statuses are the three the map draws (`read`, `reading`, `unread`); "ready" (可开始) is not a status but a fact derived from
 * them: an unread lecture whose every prerequisite (in this group or another) is read, in a group that has relation data.
 */
import type { CurriculumData } from '../../curriculum/data'
import type { ProgressStatus } from '../progress/types'

export type LecStatus = 'read' | 'reading' | 'unread'

export function lecStatusOf(s: ProgressStatus): LecStatus {
  return s === 'completed' ? 'read' : s === 'in_progress' ? 'reading' : 'unread'
}

/** The progress store's value for a map status (what the panel and the batch bar write). */
export function progressOf(s: LecStatus): ProgressStatus {
  return s === 'read' ? 'completed' : s === 'reading' ? 'in_progress' : 'not_started'
}

// ---- the curriculum index ----------------------------------------------------------------------------------------

export interface LecInfo {
  id: string
  n: number
  title: string
  /** Root-language page path (`/g05/L19`) or the translated one; no site base. */
  link: string
  groupId: string
  groupDir: string
  groupTitle: string
  category: string
  node?: string
  desc?: string
  diff?: number
  min?: number
  url?: string
}

/** `pre.get(x)` = the lectures read before `x`, `post.get(x)` = the lectures that name `x` as a prerequisite. */
export interface Relations {
  pre: Map<string, string[]>
  post: Map<string, string[]>
}

export function relationsOf(edges: ReadonlyArray<readonly [string, string]>): Relations {
  const pre = new Map<string, string[]>()
  const post = new Map<string, string[]>()
  for (const [from, to] of edges) {
    if (from === to) continue
    const a = pre.get(to)
    if (a) a.push(from)
    else pre.set(to, [from])
    const b = post.get(from)
    if (b) b.push(to)
    else post.set(from, [to])
  }
  return { pre, post }
}

export interface CurrIndex {
  lec: Map<string, LecInfo>
  rel: Relations
  /** Groups with at least one lecture that has a prerequisite or a follow-up (the others are listed by number only). */
  graphGroups: Set<string>
  /** Group id -> `{ id, dir, title }` in the order of the data. */
  groups: Map<string, { id: string; dir: string; title: string }>
}

export function indexCurriculum(data: CurriculumData | null): CurrIndex {
  const lec = new Map<string, LecInfo>()
  const groups = new Map<string, { id: string; dir: string; title: string }>()
  for (const g of data?.groups ?? []) {
    groups.set(g.id, { id: g.id, dir: g.dir, title: g.title })
    for (const l of g.lectures) {
      const info: LecInfo = { id: l.id, n: l.n, title: l.title, link: l.link, groupId: g.id, groupDir: g.dir, groupTitle: g.title, category: l.category ?? '' }
      if (l.node !== undefined) info.node = l.node
      if (l.desc !== undefined) info.desc = l.desc
      if (l.diff !== undefined) info.diff = l.diff
      if (l.min !== undefined) info.min = l.min
      if (l.url !== undefined) info.url = l.url
      lec.set(l.id, info)
    }
  }
  const rel = relationsOf((data?.edges ?? []).filter((e) => lec.has(e[0]) && lec.has(e[1])))
  const graphGroups = new Set<string>()
  for (const [id, info] of lec) if (rel.pre.has(id) || rel.post.has(id)) graphGroups.add(info.groupId)
  return { lec, rel, graphGroups, groups }
}

// ---- readiness and chains ----------------------------------------------------------------------------------------

/**
 * Ready (可开始): the lecture is unread, its group has relation data, and every prerequisite is read. A lecture with no
 * prerequisite at all is ready from the start (the panel says "没有先修，可以直接开始").
 */
export function isReady(id: string, index: CurrIndex, status: (id: string) => LecStatus): boolean {
  const info = index.lec.get(id)
  if (!info || !index.graphGroups.has(info.groupId) || status(id) !== 'unread') return false
  return (index.rel.pre.get(id) ?? []).every((p) => status(p) === 'read')
}

/** The ids that are ready among `ids`. */
export function readySet(ids: readonly string[], index: CurrIndex, status: (id: string) => LecStatus): Set<string> {
  const out = new Set<string>()
  for (const id of ids) if (isReady(id, index, status)) out.add(id)
  return out
}

/**
 * Everything reachable along `rel` from `id` inside one group, nearest first (breadth first). The walk does not pass through
 * a lecture of another group (the prototype's rule: an indirect chain is a chain of this group).
 */
export function closure(id: string, rel: Map<string, string[]>, groupOf: (id: string) => string | undefined, groupId: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const queue = [...(rel.get(id) ?? [])]
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i] as string
    if (seen.has(v) || v === id || groupOf(v) !== groupId) continue
    seen.add(v)
    out.push(v)
    for (const w of rel.get(v) ?? []) queue.push(w)
  }
  return out
}

export type Role = 'self' | 'pre' | 'post' | 'pre2' | 'post2'

/** The role of every lecture of the group while `id` is tracked: direct relations first, then the indirect ones. */
export function rolesOf(id: string, index: CurrIndex, groupId: string): Map<string, Role> {
  const out = new Map<string, Role>()
  const groupOf = (x: string): string | undefined => index.lec.get(x)?.groupId
  const put = (ids: readonly string[], role: Role): void => {
    for (const v of ids) if (groupOf(v) === groupId && !out.has(v)) out.set(v, role)
  }
  out.set(id, 'self')
  put(index.rel.pre.get(id) ?? [], 'pre')
  put(index.rel.post.get(id) ?? [], 'post')
  put(closure(id, index.rel.pre, groupOf, groupId), 'pre2')
  put(closure(id, index.rel.post, groupOf, groupId), 'post2')
  return out
}

export function byOrder(index: CurrIndex): (a: string, b: string) => number {
  return (a, b) => {
    const x = index.lec.get(a)
    const y = index.lec.get(b)
    if (!x || !y) return 0
    return x.groupId === y.groupId ? x.n - y.n : x.groupId.localeCompare(y.groupId)
  }
}

// ---- lanes -------------------------------------------------------------------------------------------------------

export interface Lane<T> {
  /** Category title; '' for the lectures that have none. */
  category: string
  lectures: T[]
}

/** Notion-category lanes in the order the categories first appear in the lecture list. */
export function lanesOf<T extends { category: string }>(lectures: readonly T[]): Array<Lane<T>> {
  const lanes: Array<Lane<T>> = []
  const by = new Map<string, Lane<T>>()
  for (const l of lectures) {
    let lane = by.get(l.category)
    if (!lane) {
      lane = { category: l.category, lectures: [] }
      by.set(l.category, lane)
      lanes.push(lane)
    }
    lane.lectures.push(l)
  }
  return lanes
}

// ---- groups that this group builds on / leads to -----------------------------------------------------------------

export interface GroupRef {
  id: string
  dir: string
  title: string
  /** Number of prerequisite edges between the two groups (in the direction asked for). */
  count: number
}

/** Cross-group prerequisites (`pre`: lectures of other groups this group needs) and follow-ups (`post`), by group, most edges first. */
export function groupLinks(groupId: string, index: CurrIndex): { pre: GroupRef[]; post: GroupRef[] } {
  const pre = new Map<string, number>()
  const post = new Map<string, number>()
  for (const [id, info] of index.lec) {
    if (info.groupId !== groupId) continue
    for (const p of index.rel.pre.get(id) ?? []) {
      const o = index.lec.get(p)?.groupId
      if (o !== undefined && o !== groupId) pre.set(o, (pre.get(o) ?? 0) + 1)
    }
    for (const p of index.rel.post.get(id) ?? []) {
      const o = index.lec.get(p)?.groupId
      if (o !== undefined && o !== groupId) post.set(o, (post.get(o) ?? 0) + 1)
    }
  }
  const list = (m: Map<string, number>): GroupRef[] =>
    [...m.entries()]
      .map(([id, count]) => ({ id, dir: index.groups.get(id)?.dir ?? id.toLowerCase(), title: index.groups.get(id)?.title ?? '', count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  return { pre: list(pre), post: list(post) }
}

// ---- edges -------------------------------------------------------------------------------------------------------

export type EdgeStyle = 'curve' | 'orthogonal'
export const EDGE_STYLES: readonly EdgeStyle[] = ['curve', 'orthogonal']
export const DEFAULT_EDGE_STYLE: EdgeStyle = 'curve'

export function isEdgeStyle(v: unknown): v is EdgeStyle {
  return typeof v === 'string' && (EDGE_STYLES as readonly string[]).includes(v)
}

/** `layout.edges` of `theme`, or null when the table has no entry or a value that is not a style. */
export function edgeStyleOf(layout: Readonly<Record<string, { edges?: unknown } | undefined>>, theme: string): EdgeStyle | null {
  const v = layout[theme]?.edges
  return isEdgeStyle(v) ? v : null
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Where a line leaves `r` towards `o`: `[x, y, dx, dy]` with `(dx, dy)` the outward direction (a side when the two sit on one row, else top / bottom). */
export function anchor(r: Box, o: Box): [number, number, number, number] {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const ox = o.x + o.w / 2
  const oy = o.y + o.h / 2
  if (Math.abs(oy - cy) < r.h) return ox > cx ? [r.x + r.w, cy, 1, 0] : [r.x, cy, -1, 0]
  return oy > cy ? [cx, r.y + r.h, 0, 1] : [cx, r.y, 0, -1]
}

const half = (v: number): number => Math.round(v * 2) / 2

/** SVG path data of the line from box `a` to box `b`: a cubic curve, or right angles with a stub of 10 px at both ends. */
export function edgePath(a: Box, b: Box, style: EdgeStyle): string {
  const p = anchor(a, b)
  const q = anchor(b, a)
  if (style === 'orthogonal') {
    const p1: [number, number] = [p[0] + p[2] * 10, p[1] + p[3] * 10]
    const q1: [number, number] = [q[0] + q[2] * 10, q[1] + q[3] * 10]
    let pts: Array<[number, number]>
    if (p[3] !== 0) {
      const my = (p1[1] + q1[1]) / 2
      pts = [[p[0], p[1]], p1, [p1[0], my], [q1[0], my], q1, [q[0], q[1]]]
    } else {
      const mx = (p1[0] + q1[0]) / 2
      pts = [[p[0], p[1]], p1, [mx, p1[1]], [mx, q1[1]], q1, [q[0], q[1]]]
    }
    return 'M' + pts.map((t) => `${half(t[0])} ${half(t[1])}`).join('L')
  }
  const d = Math.max(28, Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.35)
  return `M${half(p[0])} ${half(p[1])}C${half(p[0] + p[2] * d)} ${half(p[1] + p[3] * d)} ${half(q[0] + q[2] * d)} ${half(q[1] + q[3] * d)} ${half(q[0])} ${half(q[1])}`
}

// ---- the track anchor --------------------------------------------------------------------------------------------

export const TRACK_PREFIX = '#track-'

/** `#track-g06-l03`: where a cross-group "追踪" lands. */
export function trackHash(lectureId: string): string {
  return `${TRACK_PREFIX}${lectureId}`
}

/** The lecture id of a `#track-<id>` hash (lower case), or null. */
export function parseTrackHash(hash: string): string | null {
  const m = /^#track-([a-z0-9_-]+)$/i.exec(hash.trim())
  return m ? (m[1] as string).toLowerCase() : null
}

// ---- completion --------------------------------------------------------------------------------------------------

/** Ids in `after` that were not in `before`. */
export function newlyReady(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((id) => !before.has(id))
}

// ---- small helpers -----------------------------------------------------------------------------------------------

/** `{ done, total }` of a list of statuses (read lectures). */
export function countRead(statuses: readonly LecStatus[]): number {
  return statuses.filter((s) => s === 'read').length
}

/** The pin number of a package of `n` lectures: odd counts get one padding pin (NC). */
export function pinCount(n: number): number {
  return n + (n % 2)
}
