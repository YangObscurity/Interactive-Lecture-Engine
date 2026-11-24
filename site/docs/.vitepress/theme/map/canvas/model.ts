/**
 * map/canvas/model.ts - pure view-model & path geometry for the dependency canvas (`graph` mode, P4b).
 *
 * No Vue, no DOM, no ELK, no libavoid. Turns the pre-computed `CanvasBundle`, merged `CurriculumData` (titles,
 * categories, links, edges), and reading statuses into flat props for the four canvas slots (`CanvasBackdrop`,
 * `CanvasGroup`, `CanvasNode`, `CanvasEdge`) plus tracing routes and bounding boxes for `zoomToBox`.
 */
import type {
  CanvasBundle,
  CanvasDatasheetBoard,
  CanvasDatasheetMode,
  CanvasDsBus,
  CanvasDsUnit,
  CanvasReaderGroupLayout,
} from '../../../curriculum/canvasTypes.ts'
import { CANVAS_DS_DIM, CANVAS_READER_DIM } from '../../../curriculum/canvasTypes.ts'
import type { CurriculumData, CurriculumGroup, CurriculumLecture } from '../../../curriculum/data.ts'
import type { AtlasStatus, CanvasBundleSegment, CanvasDsPinNc, CanvasDsUnitView, CanvasEdgeProps, CanvasGroupProps, CanvasNodeProps, CanvasZoneBox } from '../../slots/registry.ts'
import { pad2 } from '../atlas/model.ts'

export type CanvasSkinId = 'reader' | 'datasheet'

export interface BoxRect {
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasLectureRef {
  id: string
  n: number
  title: string
  link: string
  groupId: string
}

export interface CanvasGraphIndex {
  byId: Map<string, CanvasLectureRef>
  groupsById: Map<string, CurriculumGroup>
  catNameBySlot: Map<number, string>
  pre: Map<string, string[]>
  post: Map<string, string[]>
  pairEdges: Map<string, Array<[string, string]>>
}

/** Exact prototype clipping weight (~0.55 per Latin/ASCII char, 1.0 per CJK). */
export function clipCanvasText(s: string, maxUnits: number): string {
  let out = ''
  let w = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    w += ch.charCodeAt(0) <= 0xff ? 0.55 : 1
    if (w > maxUnits) return `${out}…`
    out += ch
  }
  return out
}

export function buildCanvasIndex(cur: CurriculumData, edgesOverride?: ReadonlyArray<readonly [string, string, number?]>): CanvasGraphIndex {
  const byId = new Map<string, CanvasLectureRef>()
  const groupsById = new Map<string, CurriculumGroup>()
  const catNameBySlot = new Map<number, string>()
  for (const g of cur.groups) {
    groupsById.set(g.id, g)
    if (g.category && !catNameBySlot.has(g.catSlot)) catNameBySlot.set(g.catSlot, g.category)
    for (const l of g.lectures) {
      byId.set(l.id, { id: l.id, n: l.n, title: l.title, link: l.link, groupId: g.id })
    }
  }
  const pre = new Map<string, string[]>()
  const post = new Map<string, string[]>()
  const pairEdges = new Map<string, Array<[string, string]>>()
  const edges = edgesOverride ?? cur.edges
  for (const e of edges) {
    const s = e[0]
    const t = e[1]
    const ls = byId.get(s)
    const lt = byId.get(t)
    if (!ls || !lt || s === t) continue
    ;(pre.get(t) ?? pre.set(t, []).get(t)!).push(s)
    ;(post.get(s) ?? post.set(s, []).get(s)!).push(t)
    if (ls.groupId !== lt.groupId) {
      const k = ls.groupId < lt.groupId ? `${ls.groupId}|${lt.groupId}` : `${lt.groupId}|${ls.groupId}`
      ;(pairEdges.get(k) ?? pairEdges.set(k, []).get(k)!).push([s, t])
    }
  }
  return { byId, groupsById, catNameBySlot, pre, post, pairEdges }
}

export function canvasLectureMatches(lec: CurriculumLecture, groupId: string, query: string): boolean {
  if (!query) return false
  return lec.title.toLowerCase().includes(query) || `${groupId}-L${pad2(lec.n)}`.toLowerCase() === query
}

export function svgPolyline(pts: ReadonlyArray<readonly [number, number]>): string {
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')
}

export function readerBundleBezier(a: readonly [number, number], c: readonly [number, number], horiz: boolean): string {
  const k = Math.max(80, Math.abs(horiz ? c[0] - a[0] : c[1] - a[1]) * 0.45)
  const sx = horiz ? (c[0] > a[0] ? k : -k) : 0
  const sy = horiz ? 0 : c[1] > a[1] ? k : -k
  return `M${a[0]} ${a[1]}C${a[0] + sx} ${a[1] + sy} ${c[0] - sx} ${c[1] - sy} ${c[0]} ${c[1]}`
}

export function readerTraceCurve(a: readonly [number, number], b: readonly [number, number]): string {
  const dy = Math.max(50, Math.abs(b[1] - a[1]) * 0.45)
  return `M${a[0]} ${a[1]}C${a[0]} ${a[1] + dy} ${b[0]} ${b[1] - dy} ${b[0]} ${b[1]}`
}

// ---- Reader group-to-group routes ----------------------------------------------------------------------------------
//
// The prototype draws each group bundle as one bezier from the middle of a side of A to the middle of the facing side
// of B. That only works while no two bundles share a side and nothing stands between the two groups: with groups packed
// in a grid (the 9-group demo), MEA>PRB and MEA>PLN were the same vertical line (one could not be clicked) and MEA>PLN
// ran straight through PRB (S6Y audit-home #2). Here every bundle gets its own port on the box side (a few slots per
// side, one bundle per slot), runs through the gaps between the groups on an orthogonal grid (never into a box),
// prefers a gap no other bundle uses yet, and bundles that still share a stretch of a gap are spread into lanes.

export interface RouteBox {
  x: number
  y: number
  w: number
  h: number
}

export interface ReaderBundleRoute {
  pts: Array<[number, number]>
  d: string
}

/** Cost of a bend, and the extra cost factor of each other bundle already on a grid edge. */
const ROUTE_BEND = 40
const ROUTE_REUSE = 0.5
/** Most space between two lanes of one gap (canvas units), and the corner radius of the drawn path. */
const ROUTE_LANE = 18
const ROUTE_RADIUS = 26
/** Direction index = side index: 0 up / top, 1 right, 2 down / bottom, 3 left. */
const RDX = [0, 1, 0, -1] as const
const RDY = [-1, 0, 1, 0] as const

interface RouteSlot {
  box: number
  side: number
  center: number
  px: number
  py: number
  node: number
  used: boolean
}

class MinHeap {
  private c: number[] = []
  private s: number[] = []
  get size(): number {
    return this.c.length
  }
  push(cost: number, state: number): void {
    const c = this.c
    const s = this.s
    let i = c.length
    c.push(cost)
    s.push(state)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (c[p]! <= cost) break
      c[i] = c[p]!
      s[i] = s[p]!
      i = p
    }
    c[i] = cost
    s[i] = state
  }
  pop(): [number, number] {
    const c = this.c
    const s = this.s
    const top: [number, number] = [c[0]!, s[0]!]
    const lc = c.pop()!
    const ls = s.pop()!
    const n = c.length
    if (n > 0) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const r = l + 1
        const m = r < n && c[r]! < c[l]! ? r : l
        if (c[m]! >= lc) break
        c[i] = c[m]!
        s[i] = s[m]!
        i = m
      }
      c[i] = lc
      s[i] = ls
    }
    return top
  }
}

/** Orthogonal polyline with rounded corners (the arrow marker follows the last, straight piece). */
export function roundedRoutePath(pts: ReadonlyArray<readonly [number, number]>, radius = ROUTE_RADIUS): string {
  const f = (v: number): string => (Math.round(v * 10) / 10).toString()
  if (pts.length === 0) return ''
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]!
    const c = pts[i]!
    const n = pts[i + 1]!
    const lin = Math.hypot(c[0] - p[0], c[1] - p[1])
    const lout = Math.hypot(n[0] - c[0], n[1] - c[1])
    const r = Math.min(radius, lin / 2, lout / 2)
    if (r < 0.5 || lin === 0 || lout === 0) {
      d += `L${f(c[0])} ${f(c[1])}`
      continue
    }
    const ax = c[0] - ((c[0] - p[0]) / lin) * r
    const ay = c[1] - ((c[1] - p[1]) / lin) * r
    const bx = c[0] + ((n[0] - c[0]) / lout) * r
    const by = c[1] + ((n[1] - c[1]) / lout) * r
    d += `L${f(ax)} ${f(ay)}Q${f(c[0])} ${f(c[1])} ${f(bx)} ${f(by)}`
  }
  const last = pts[pts.length - 1]!
  return `${d}L${f(last[0])} ${f(last[1])}`
}

/** Drop repeated points and the middle point of three on one straight line. */
function simplifyRoute(pts: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (q && Math.abs(q[0] - p[0]) < 0.01 && Math.abs(q[1] - p[1]) < 0.01) continue
    const o = out[out.length - 2]
    if (o && q && ((Math.abs(o[0] - q[0]) < 0.01 && Math.abs(q[0] - p[0]) < 0.01) || (Math.abs(o[1] - q[1]) < 0.01 && Math.abs(q[1] - p[1]) < 0.01))) out.pop()
    out.push(p)
  }
  return out
}

/**
 * Route every bundle `[from box, to box]` between the group boxes (pure, deterministic). `gap` is the packing gap
 * between groups (the routes run along its middle), `width` / `height` the canvas. A bundle with no route returns null
 * (the caller falls back to the prototype bezier).
 */
export function routeReaderBundles(
  boxes: readonly RouteBox[],
  pairs: ReadonlyArray<readonly [number, number]>,
  opts: { gap: number; width: number; height: number },
): Array<ReaderBundleRoute | null> {
  const half = opts.gap / 2
  const clear = Math.max(4, Math.min(20, half - 6))
  const q = (v: number): number => Math.round(v * 10) / 10
  const inBox = (x: number, y: number, m: number): boolean => {
    for (const b of boxes) if (x > b.x - m && x < b.x + b.w + m && y > b.y - m && y < b.y + b.h + m) return true
    return false
  }

  // ports: a few slots on every side, with the grid point in the middle of the gap in front of each
  const raw: Array<Omit<RouteSlot, 'node' | 'used'> & { gx: number; gy: number }> = []
  boxes.forEach((b, bi) => {
    for (let side = 0; side < 4; side++) {
      const horiz = side === 0 || side === 2
      const len = horiz ? b.w : b.h
      const k = Math.max(1, Math.min(7, Math.floor(len / 60) - 1))
      for (let i = 0; i < k; i++) {
        const t = (i + 1) / (k + 1)
        const px = q(horiz ? b.x + b.w * t : side === 1 ? b.x + b.w : b.x)
        const py = q(horiz ? (side === 0 ? b.y : b.y + b.h) : b.y + b.h * t)
        raw.push({ box: bi, side, center: Math.abs(i - (k - 1) / 2), px, py, gx: q(px + RDX[side]! * half), gy: q(py + RDY[side]! * half) })
      }
    }
  })
  const xsSet = new Set<number>()
  const ysSet = new Set<number>()
  for (const b of boxes) {
    xsSet.add(q(b.x - half))
    xsSet.add(q(b.x + b.w + half))
    ysSet.add(q(b.y - half))
    ysSet.add(q(b.y + b.h + half))
  }
  for (const s of raw) {
    xsSet.add(s.gx)
    ysSet.add(s.gy)
  }
  const xs = [...xsSet].filter((x) => x >= 0 && x <= opts.width).sort((a, b) => a - b)
  const ys = [...ysSet].filter((y) => y >= 0 && y <= opts.height).sort((a, b) => a - b)
  const NX = xs.length
  const NY = ys.length
  const N = NX * NY
  const xi = new Map(xs.map((x, i) => [x, i]))
  const yi = new Map(ys.map((y, j) => [y, j]))
  const ok = new Uint8Array(N)
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) ok[j * NX + i] = inBox(xs[i]!, ys[j]!, clear) ? 0 : 1
  const segFree = (x0: number, y0: number, x1: number, y1: number): boolean => {
    const lx = Math.min(x0, x1)
    const hx = Math.max(x0, x1)
    const ly = Math.min(y0, y1)
    const hy = Math.max(y0, y1)
    for (const b of boxes) if (hx > b.x - clear && lx < b.x + b.w + clear && hy > b.y - clear && ly < b.y + b.h + clear) return false
    return true
  }
  // okH[n]: edge n -> n+1 is free; okV[n]: edge n -> n+NX is free
  const okH = new Uint8Array(N)
  const okV = new Uint8Array(N)
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const n = j * NX + i
      if (!ok[n]) continue
      if (i + 1 < NX && ok[n + 1] && segFree(xs[i]!, ys[j]!, xs[i + 1]!, ys[j]!)) okH[n] = 1
      if (j + 1 < NY && ok[n + NX] && segFree(xs[i]!, ys[j]!, xs[i]!, ys[j + 1]!)) okV[n] = 1
    }
  }
  const slots: RouteSlot[] = []
  for (const s of raw) {
    const i = xi.get(s.gx)
    const j = yi.get(s.gy)
    if (i === undefined || j === undefined || !ok[j * NX + i]) continue
    slots.push({ box: s.box, side: s.side, center: s.center, px: s.px, py: s.py, node: j * NX + i, used: false })
  }
  const usedH = new Uint16Array(N)
  const usedV = new Uint16Array(N)
  const step = (n: number, dir: number): number => {
    const i = n % NX
    if (dir === 0) return n >= NX && okV[n - NX] ? n - NX : -1
    if (dir === 1) return i + 1 < NX && okH[n] ? n + 1 : -1
    if (dir === 2) return n + NX < N && okV[n] ? n + NX : -1
    return i > 0 && okH[n - 1] ? n - 1 : -1
  }
  const edgeUse = (n: number, dir: number): number => (dir === 0 ? usedV[n - NX]! : dir === 1 ? usedH[n]! : dir === 2 ? usedV[n]! : usedH[n - 1]!)
  const markEdge = (n: number, m: number): void => {
    if (m === n + 1) usedH[n]!++
    else if (m === n - 1) usedH[m]!++
    else if (m === n + NX) usedV[n]!++
    else if (m === n - NX) usedV[m]!++
  }
  const coord = (n: number): [number, number] => [xs[n % NX]!, ys[Math.floor(n / NX)]!]

  const S = N * 4
  const SINK = S
  const dist = new Float64Array(S + 1)
  const prev = new Int32Array(S + 1)
  const routes: Array<Array<[number, number]> | null> = pairs.map(() => null)
  const centerOf = (b: RouteBox): [number, number] => [b.x + b.w / 2, b.y + b.h / 2]
  const order = pairs
    .map((p, idx) => {
      const a = boxes[p[0]]
      const b = boxes[p[1]]
      const ca = a ? centerOf(a) : [0, 0]
      const cb = b ? centerOf(b) : [0, 0]
      return { idx, len: Math.abs(ca[0]! - cb[0]!) + Math.abs(ca[1]! - cb[1]!) }
    })
    .sort((u, v) => u.len - v.len || u.idx - v.idx)

  for (const { idx } of order) {
    const [ai, bi] = pairs[idx]!
    if (ai === bi || !boxes[ai] || !boxes[bi]) continue
    dist.fill(Infinity)
    prev.fill(-1)
    const heap = new MinHeap()
    const srcSlot = new Map<number, RouteSlot>()
    for (const s of slots) {
      if (s.box !== ai || s.used) continue
      const st = s.node * 4 + s.side
      const c = half + s.center * 6
      if (c < dist[st]!) {
        dist[st] = c
        srcSlot.set(st, s)
        heap.push(c, st)
      }
    }
    const targets = new Map<number, RouteSlot[]>()
    for (const s of slots) if (s.box === bi && !s.used) (targets.get(s.node) ?? targets.set(s.node, []).get(s.node)!).push(s)
    let sinkSlot: RouteSlot | null = null
    while (heap.size > 0) {
      const [c, st] = heap.pop()
      if (c > dist[st]!) continue
      if (st === SINK) break
      const n = st >> 2
      const d = st & 3
      const tl = targets.get(n)
      if (tl) {
        for (const t of tl) {
          const inward = (t.side + 2) % 4
          const ct = c + half + (d !== inward ? ROUTE_BEND : 0) + t.center * 6
          if (ct < dist[SINK]!) {
            dist[SINK] = ct
            prev[SINK] = st
            sinkSlot = t
            heap.push(ct, SINK)
          }
        }
      }
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (d + 2) % 4) continue
        const m = step(n, nd)
        if (m < 0) continue
        const [x0, y0] = coord(n)
        const [x1, y1] = coord(m)
        const len = Math.abs(x1 - x0) + Math.abs(y1 - y0)
        const cm = c + len * (1 + ROUTE_REUSE * edgeUse(n, nd)) + (nd !== d ? ROUTE_BEND : 0)
        const sm = m * 4 + nd
        if (cm < dist[sm]!) {
          dist[sm] = cm
          prev[sm] = st
          heap.push(cm, sm)
        }
      }
    }
    if (!sinkSlot || prev[SINK]! < 0) continue
    const chain: number[] = []
    let st = prev[SINK]!
    let first = st
    while (st >= 0) {
      chain.push(st >> 2)
      first = st
      st = prev[st]!
    }
    chain.reverse()
    const src = srcSlot.get(first)
    if (!src) continue
    src.used = true
    sinkSlot.used = true
    for (let k = 1; k < chain.length; k++) if (chain[k] !== chain[k - 1]) markEdge(chain[k - 1]!, chain[k]!)
    routes[idx] = simplifyRoute([[src.px, src.py], ...chain.map(coord), [sinkSlot.px, sinkSlot.py]])
  }

  // lanes: bundles sharing a stretch of one grid line are spread across the gap
  interface Seg { r: number; i: number; vert: boolean; c: number; lo: number; hi: number; key: number }
  const lines = new Map<string, Seg[]>()
  routes.forEach((pts, r) => {
    if (!pts) return
    for (let i = 0; i + 1 < pts.length; i++) {
      const p = pts[i]!
      const n = pts[i + 1]!
      const vert = Math.abs(p[0] - n[0]) < 0.01
      const c = vert ? p[0] : p[1]
      const a = vert ? p[1] : p[0]
      const b = vert ? n[1] : n[0]
      const sg: Seg = { r, i, vert, c, lo: Math.min(a, b), hi: Math.max(a, b), key: 0 }
      const k = vert ? 'v' : 'h'
      ;(lines.get(k) ?? lines.set(k, []).get(k)!).push(sg)
    }
  })
  const off = routes.map((pts) => (pts ? new Float64Array(pts.length) : null))
  // segments of one direction that overlap (or touch) along their length and lie closer than two lanes across join one
  // band; every band of two or more bundles is spread
  for (const segs of lines.values()) {
    const parent = segs.map((_, i) => i)
    const root = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!
      return i
    }
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const u = segs[i]!
        const v = segs[j]!
        if (Math.abs(u.c - v.c) < 2 * ROUTE_LANE && u.lo <= v.hi + 0.5 && v.lo <= u.hi + 0.5) parent[root(i)] = root(j)
      }
    }
    const bands = new Map<number, Seg[]>()
    segs.forEach((s, i) => (bands.get(root(i)) ?? bands.set(root(i), []).get(root(i))!).push(s))
    for (const band of bands.values()) if (new Set(band.map((s) => s.r)).size >= 2) spread(band)
  }
  function spread(comp: Seg[]): void {
    const vert = comp[0]!.vert
    const c = comp.reduce((t, s) => t + s.c, 0) / comp.length
    const ax = vert ? 0 : 1
    for (const s of comp) {
      const pts = routes[s.r]!
      const side = (p: readonly [number, number] | undefined): number => (p ? Math.sign(p[ax] - s.c) : 0)
      s.key = side(pts[s.i - 1]) + side(pts[s.i + 2])
    }
    comp.sort((u, v) => u.c - v.c || u.key - v.key || u.r - v.r)
    const lo = Math.min(...comp.map((s) => s.lo))
    const hi = Math.max(...comp.map((s) => s.hi))
    let dl = c
    let dr = (vert ? opts.width : opts.height) - c
    for (const b of boxes) {
      const [b0, b1, p0, p1] = vert ? [b.y, b.y + b.h, b.x, b.x + b.w] : [b.x, b.x + b.w, b.y, b.y + b.h]
      if (!(b0 < hi && b1 > lo)) continue
      if (p1 <= c) dl = Math.min(dl, c - p1)
      else if (p0 >= c) dr = Math.min(dr, p0 - c)
    }
    // the lanes fill the free band around the line (8 units off each box and the canvas edge), centred on the line when
    // the band allows it; offset of segment i of its route: a vertical segment moves in x, a horizontal one in y (a port
    // moves along its side)
    const fl = Math.max(0, dl - 8)
    const fr = Math.max(0, dr - 8)
    const n = comp.length
    const sp = Math.min(ROUTE_LANE, (fl + fr) / (n - 1))
    const total = sp * (n - 1)
    const start = Math.min(Math.max(-total / 2, -fl), fr - total)
    comp.forEach((s, k) => {
      off[s.r]![s.i] = c + start + k * sp - s.c
    })
  }
  const outs = routes.map((pts, r) => {
    if (!pts) return null
    const o = off[r]!
    const out = pts.map((p): [number, number] => [p[0], p[1]])
    for (let i = 0; i + 1 < pts.length; i++) {
      if (!o[i]) continue
      const vert = Math.abs(pts[i]![0] - pts[i + 1]![0]) < 0.01
      const ax = vert ? 0 : 1
      out[i]![ax] += o[i]!
      out[i + 1]![ax] += o[i]!
    }
    return out
  })
  // two facing sides whose ports sit a little apart give a small S: move one port along its side so the line is straight
  const ports = (): Array<[number, number]> => outs.flatMap((p) => (p ? [p[0]!, p[p.length - 1]!] : []))
  outs.forEach((p, r) => {
    if (!p || p.length !== 4) return
    const horiz = Math.abs(p[0]![1] - p[1]![1]) < 0.01 && Math.abs(p[2]![1] - p[3]![1]) < 0.01
    const vert = Math.abs(p[0]![0] - p[1]![0]) < 0.01 && Math.abs(p[2]![0] - p[3]![0]) < 0.01
    if (!horiz && !vert) return
    const ax: 0 | 1 = horiz ? 1 : 0
    const along: 0 | 1 = horiz ? 0 : 1
    // only an S between two facing sides (both ends run the same way), not a U back to the same side
    if (Math.sign(p[1]![along] - p[0]![along]) !== Math.sign(p[3]![along] - p[2]![along])) return
    if (Math.abs(p[1]![ax] - p[2]![ax]) >= 2 * ROUTE_RADIUS) return
    const taken = ports()
    const fits = (end: 0 | 3, v: number): boolean => {
      const b = boxes[pairs[r]![end === 0 ? 0 : 1]]!
      const [lo, len] = horiz ? [b.y, b.h] : [b.x, b.w]
      if (v < lo + 12 || v > lo + len - 12) return false
      const at: [number, number] = horiz ? [p[end]![0], v] : [v, p[end]![1]]
      return !taken.some((q) => q !== p[end] && Math.hypot(q[0] - at[0], q[1] - at[1]) < 12)
    }
    if (fits(3, p[0]![ax])) {
      p[2]![ax] = p[0]![ax]
      p[3]![ax] = p[0]![ax]
    } else if (fits(0, p[3]![ax])) {
      p[0]![ax] = p[3]![ax]
      p[1]![ax] = p[3]![ax]
    } else return
    outs[r] = [p[0]!, p[3]!]
  })
  return outs.map((out) => (out ? { pts: out, d: roundedRoutePath(out) } : null))
}

const readerRouteCache = new WeakMap<object, Map<string, ReaderBundleRoute | null>>()

/** The routes of a reader layout, computed once per layout object; keyed `${a}>${b}`. */
export function readerBundleRoutes(R: {
  W: number
  H: number
  groups: ReadonlyArray<CanvasReaderGroupLayout>
  bundles: ReadonlyArray<{ a: string; b: string }>
}): Map<string, ReaderBundleRoute | null> {
  const hit = readerRouteCache.get(R)
  if (hit) return hit
  const index = new Map(R.groups.map((g, i) => [g.id, i]))
  const pairs: Array<[number, number]> = []
  const keys: string[] = []
  for (const b of R.bundles) {
    const a = index.get(b.a)
    const c = index.get(b.b)
    if (a === undefined || c === undefined) continue
    pairs.push([a, c])
    keys.push(`${b.a}>${b.b}`)
  }
  const routes = routeReaderBundles(R.groups, pairs, { gap: CANVAS_READER_DIM.GROUPGAP, width: R.W, height: R.H })
  const out = new Map<string, ReaderBundleRoute | null>()
  keys.forEach((k, i) => out.set(k, routes[i] ?? null))
  readerRouteCache.set(R, out)
  return out
}

// ---- Datasheet pinout layout geometry ----------------------------------------------------------------------------

export interface DsPinGeom {
  x: number
  y: number
  tip: readonly [number, number]
  side: -1 | 1
  no: number
  lecId: string | null
}

export interface DsResolvedUnit {
  unit: CanvasDsUnit
  pkg: string
  box: BoxRect
  pins: DsPinGeom[]
}

export interface DsPinoutModel {
  units: Map<string, DsResolvedUnit>
  byGroup: Map<string, DsResolvedUnit[]>
  pins: Map<string, DsPinGeom>
  unitOf: Map<string, string>
  busOf: Map<string, CanvasDsBus>
}

export function resolveDatasheetPinout(board: CanvasDatasheetBoard): DsPinoutModel {
  const units = new Map<string, DsResolvedUnit>()
  const byGroup = new Map<string, DsResolvedUnit[]>()
  const pins = new Map<string, DsPinGeom>()
  const unitOf = new Map<string, string>()
  const busOf = new Map<string, CanvasDsBus>()

  for (const [uid, k] of Object.entries(board.units)) {
    const pkg = `${k.total > 8 ? 'DIP-' : 'SOIC-'}${k.total}`
    const pinList: DsPinGeom[] = []
    const y0 = k.y + (k.h - (k.per - 1) * CANVAS_DS_DIM.PIT) / 2
    for (let i = 0; i < k.total; i++) {
      // Counter-clockwise DIP pin numbering (spec board §12): left side top->bottom, right side bottom->top
      const left = i < k.per
      const j = left ? i : k.total - 1 - i
      const side: -1 | 1 = left ? -1 : 1
      const px = left ? k.x : k.x + k.bw
      const py = y0 + j * CANVAS_DS_DIM.PIT
      const lecId = k.lec[i] ?? null
      const pin: DsPinGeom = {
        x: px,
        y: py,
        tip: [px + side * CANVAS_DS_DIM.LEG, py],
        side,
        no: i + 1,
        lecId,
      }
      pinList.push(pin)
      if (lecId) {
        pins.set(lecId, pin)
        unitOf.set(lecId, uid)
      }
    }
    const resolved: DsResolvedUnit = { unit: k, pkg, box: { x: k.nx, y: k.ny, w: k.w, h: k.h }, pins: pinList }
    units.set(uid, resolved)
    const list = byGroup.get(k.g) ?? []
    list.push(resolved)
    byGroup.set(k.g, list)
  }

  for (const b of board.buses) busOf.set(`${b.ua}>${b.ub}`, b)
  return { units, byGroup, pins, unitOf, busOf }
}

// ---- Board view builder (flat props per frame / state change) -----------------------------------------------------

export interface CanvasFocusState {
  activeNodes: ReadonlySet<string>
  activeGroups: ReadonlySet<string>
  lockedId: string | null
  activePairKey: string | null
  preEdges: ReadonlyArray<readonly [string, string]>
  postEdges: ReadonlyArray<readonly [string, string]>
}

export interface CanvasBoardDrawState {
  skin: CanvasSkinId
  width: number
  height: number
  backdrop: { zones: CanvasZoneBox[] }
  groups: CanvasGroupProps[]
  nodes: CanvasNodeProps[]
  intraEdges: CanvasEdgeProps[]
  bundleEdges: CanvasEdgeProps[]
  traceEdges: Array<{ key: string; from: string; to: string; props: CanvasEdgeProps }>
  bigLabels: Array<{ id: string; x: number; y: number; size: number }>
  groupBoxOf: (groupId: string) => BoxRect | null
  nodeBoxOf: (lecId: string) => BoxRect | null
  focusPointOf: (lecId: string) => readonly [number, number] | null
}

export function buildCanvasBoardView(input: {
  bundle: CanvasBundle
  skin: CanvasSkinId
  dsMode: CanvasDatasheetMode
  curriculum: CurriculumData
  index: CanvasGraphIndex
  statuses: ReadonlyMap<string, AtlasStatus>
  focus: CanvasFocusState
  hoverNodeId: string | null
  hotPairKey: string | null
  hotTraceKey: string | null
  matches: ReadonlySet<string>
  labels: {
    uncategorised: string
    toUnit: (target: string, count: number) => string
    fromUnit: (source: string, count: number) => string
  }
}): CanvasBoardDrawState {
  const { bundle, skin, dsMode, index, statuses, focus, hoverNodeId, hotPairKey, hotTraceKey, matches, labels } = input
  const R = bundle.reader
  const GMap = new Map<string, CanvasReaderGroupLayout>(R.groups.map((g) => [g.id, g]))
  const DsBoard: CanvasDatasheetBoard = bundle.datasheet[dsMode]
  const pinout = skin === 'datasheet' ? resolveDatasheetPinout(DsBoard) : null

  const readerPos = new Map<string, { x: number; y: number }>()
  for (const g of R.groups) {
    for (const n of g.nodes) readerPos.set(n.id, { x: g.x + n.x, y: g.y + n.y })
  }

  const width = skin === 'datasheet' ? DsBoard.W : R.W
  const height = skin === 'datasheet' ? DsBoard.H : R.H

  const catName = (slot: number): string => index.catNameBySlot.get(slot) || labels.uncategorised

  const zones: CanvasZoneBox[] =
    skin === 'datasheet'
      ? DsBoard.zones.map((z) => ({ cat: z.cat, name: catName(z.cat), x: z.x, y: z.y, w: z.w, h: z.h }))
      : []

  const groups: CanvasGroupProps[] = []
  const nodes: CanvasNodeProps[] = []
  const intraEdges: CanvasEdgeProps[] = []
  const bigLabels: Array<{ id: string; x: number; y: number; size: number }> = []

  const groupDone = (g: CanvasReaderGroupLayout): { done: number; total: number } => {
    let done = 0
    for (const n of g.nodes) if (statuses.get(n.id) === 'read') done++
    return { done, total: g.nodes.length }
  }

  for (const g of R.groups) {
    const cg = index.groupsById.get(g.id)
    const rawTitle = cg?.title ?? g.id
    const { done, total } = groupDone(g)
    const active = focus.activeGroups.has(g.id)

    if (skin === 'reader') {
      const fs = Math.max(60, Math.min(g.w * 0.42, g.h * 0.5, 260))
      bigLabels.push({ id: g.id, x: g.x + g.w / 2, y: g.y + g.h / 2 + fs * 0.35, size: fs })
      groups.push({
        id: g.id,
        cat: g.cat,
        catName: catName(g.cat),
        title: clipCanvasText(`${g.id}  ${rawTitle}`, Math.max(6, (g.w - 90) / 17)),
        progress: `${done} / ${total}`,
        active,
        x: g.x,
        y: g.y,
        w: g.w,
        h: g.h,
        units: [],
        unitBuses: [],
      })

      for (const n of g.nodes) {
        const l = index.byId.get(n.id)
        const pos = readerPos.get(n.id)!
        nodes.push({
          id: n.id,
          number: l ? pad2(l.n) : '00',
          pinNumber: l?.n ?? 0,
          label: clipCanvasText(l?.title ?? n.id, 11),
          status: statuses.get(n.id) ?? 'unread',
          hover: hoverNodeId === n.id,
          locked: focus.lockedId === n.id,
          active: focus.activeNodes.has(n.id),
          match: matches.has(n.id),
          x: pos.x,
          y: pos.y,
          w: CANVAS_READER_DIM.NW,
          h: CANVAS_READER_DIM.NH,
          pinX: pos.x,
          pinY: pos.y,
          tipX: pos.x,
          pinSide: 1,
          legLen: 0,
          nameX: pos.x,
          hitX: pos.x,
          hitW: CANVAS_READER_DIM.NW,
        })
      }

      for (const e of g.edges) {
        if (!e.d) continue
        intraEdges.push({
          kind: 'intra',
          d: e.d,
          tx: g.x,
          ty: g.y,
          weight: 1.2,
          pairKey: `${e.s}>${e.t}`,
          active: false,
          hot: false,
          segments: [],
        })
      }
    } else if (pinout) {
      const dsUnits = pinout.byGroup.get(g.id) ?? []
      const unitViews: CanvasDsUnitView[] = dsUnits.map((ru, ui) => {
        const ncPins: CanvasDsPinNc[] = []
        for (const p of ru.pins) {
          if (!p.lecId) ncPins.push({ x: p.x, y: p.y, tipX: p.tip[0], side: p.side })
        }
        return {
          uid: ru.unit.g + ru.unit.part,
          part: ru.unit.part,
          of: ru.unit.of,
          pkg: ru.pkg,
          x: ru.unit.x,
          y: ru.unit.y,
          w: ru.unit.bw,
          h: ru.unit.bh,
          showCatTag: DsBoard.zones.length === 0 && ui === 0,
          ports: ru.unit.ports.map((pt) => ({ x: pt.x, y: pt.y, out: pt.id.includes('.out') })),
          ncPins,
        }
      })
      const firstUnit = dsUnits[0]
      const chipW = firstUnit?.unit.bw ?? CANVAS_DS_DIM.BODYW
      const unitBuses = DsBoard.buses
        .filter((b) => b.ga === g.id && b.gb === g.id)
        .map((b) => ({ d: svgPolyline(b.pts), weight: 0.6 + Math.log2(b.n) * 0.45 }))

      groups.push({
        id: g.id,
        cat: g.cat,
        catName: catName(g.cat),
        title: clipCanvasText(rawTitle, Math.max(5, (chipW - 20) / 16)),
        progress: `${done}/${total}`,
        active,
        x: firstUnit?.unit.nx ?? 0,
        y: firstUnit?.unit.ny ?? 0,
        w: firstUnit?.unit.w ?? chipW,
        h: firstUnit?.unit.h ?? 150,
        units: unitViews,
        unitBuses,
      })

      for (const ru of dsUnits) {
        for (const p of ru.pins) {
          if (!p.lecId) continue
          const l = index.byId.get(p.lecId)
          const nameX = p.tip[0] + p.side * CANVAS_DS_DIM.NUMGAP
          const farX = p.x + p.side * (CANVAS_DS_DIM.LEG + CANVAS_DS_DIM.NUMGAP + CANVAS_DS_DIM.NAME)
          nodes.push({
            id: p.lecId,
            number: l ? pad2(l.n) : '00',
            pinNumber: p.no,
            label: clipCanvasText(l?.title ?? p.lecId, 13),
            status: statuses.get(p.lecId) ?? 'unread',
            hover: hoverNodeId === p.lecId,
            locked: focus.lockedId === p.lecId,
            active: focus.activeNodes.has(p.lecId),
            match: matches.has(p.lecId),
            x: p.tip[0] - CANVAS_READER_DIM.NW / 2,
            y: p.tip[1] - CANVAS_READER_DIM.NH / 2,
            w: CANVAS_READER_DIM.NW,
            h: CANVAS_READER_DIM.NH,
            pinX: p.x,
            pinY: p.y,
            tipX: p.tip[0],
            pinSide: p.side,
            legLen: CANVAS_DS_DIM.LEG,
            nameX,
            hitX: Math.min(p.x, farX),
            hitW: Math.abs(farX - p.x),
          })
        }
      }
    }
  }

  // Inter-group bundles / buses
  const bundleEdges: CanvasEdgeProps[] = []
  const readerRoutes = skin === 'reader' ? readerBundleRoutes(R) : null
  for (const b of R.bundles) {
    const pairKey = b.a < b.b ? `${b.a}|${b.b}` : `${b.b}|${b.a}`
    const active = focus.activePairKey === pairKey
    const hot = hotPairKey === pairKey
    if (skin === 'reader') {
      const A = GMap.get(b.a)
      const B = GMap.get(b.b)
      if (!A || !B) continue
      let d = readerRoutes?.get(`${b.a}>${b.b}`)?.d ?? ''
      if (!d) {
        // no way through the gaps (should not happen with a packed layout): the prototype's bezier between side middles
        let p1: [number, number]
        let p2: [number, number]
        let horiz = true
        if (B.x >= A.x + A.w) {
          p1 = [A.x + A.w, A.y + A.h / 2]
          p2 = [B.x, B.y + B.h / 2]
        } else if (A.x >= B.x + B.w) {
          p1 = [A.x, A.y + A.h / 2]
          p2 = [B.x + B.w, B.y + B.h / 2]
        } else if (B.y >= A.y) {
          p1 = [A.x + A.w / 2, A.y + A.h]
          p2 = [B.x + B.w / 2, B.y]
          horiz = false
        } else {
          p1 = [A.x + A.w / 2, A.y]
          p2 = [B.x + B.w / 2, B.y + B.h]
          horiz = false
        }
        d = readerBundleBezier(p1, p2, horiz)
      }
      bundleEdges.push({
        kind: 'bundle',
        d,
        tx: 0,
        ty: 0,
        weight: 1 + Math.log2(b.n) * 0.8,
        pairKey,
        active,
        hot,
        segments: [],
      })
    } else {
      const parts = DsBoard.buses.filter((x) => (x.ga === b.a && x.gb === b.b) || (x.ga === b.b && x.gb === b.a))
      const segments: CanvasBundleSegment[] = []
      let dAll = ''
      for (const seg of parts) {
        const sd = svgPolyline(seg.pts)
        dAll += sd
        const ua = DsBoard.units[seg.ua]
        const ub = DsBoard.units[seg.ub]
        const tags: Array<{ text: string; x: number; y: number }> = []
        if (ua && ub && seg.pts.length >= 2) {
          const endpoints: Array<{ p: readonly [number, number]; u: CanvasDsUnit; text: string }> = [
            { p: seg.pts[0]!, u: ua, text: labels.toUnit(`${seg.gb}${ub.part ? `·${ub.part}` : ''}`, seg.n) },
            { p: seg.pts[seg.pts.length - 1]!, u: ub, text: labels.fromUnit(`${seg.ga}${ua.part ? `·${ua.part}` : ''}`, seg.n) },
          ]
          for (const ep of endpoints) {
            const below = ep.p[1] > ep.u.y + ep.u.bh / 2
            tags.push({ text: ep.text, x: ep.p[0] + 8, y: below ? ep.p[1] + 34 : ep.p[1] - 24 })
          }
        }
        segments.push({ d: sd, weight: 0.6 + Math.log2(seg.n) * 0.45, tags })
      }
      bundleEdges.push({
        kind: 'bundle',
        d: dAll,
        tx: 0,
        ty: 0,
        weight: 1,
        pairKey,
        active,
        hot,
        segments,
      })
    }
  }

  // Highlighted trace links
  let dsLane = 0
  const dsLinkPath = (s: string, t: string): string => {
    if (!pinout) return ''
    const a = pinout.pins.get(s)
    const b = pinout.pins.get(t)
    const ua = pinout.unitOf.get(s)
    const ub = pinout.unitOf.get(t)
    if (!a || !b || !ua || !ub) return ''
    const ca = pinout.units.get(ua)?.unit
    if (!ca) return ''
    dsLane++
    if (ua === ub) {
      const lane = Math.min(dsLane, 12) * 6
      let lx: number
      if (a.side < 0 && b.side < 0) lx = ca.x + 10 + lane
      else if (a.side > 0 && b.side > 0) lx = ca.x + ca.bw - 10 - lane
      else lx = ca.x + ca.bw / 2 + ((dsLane % 9) - 4) * 6
      return svgPolyline([a.tip, [a.x, a.y], [lx, a.y], [lx, b.y], [b.x, b.y], b.tip])
    }
    const direct = pinout.busOf.get(`${ua}>${ub}`)
    const bus = direct ?? pinout.busOf.get(`${ub}>${ua}`)
    if (!bus || bus.pts.length < 2) {
      return svgPolyline([a.tip, [a.x, a.y], [b.x, b.y], b.tip])
    }
    const pts = direct ? bus.pts.slice() : bus.pts.slice().reverse()
    const pa = pts[0]!
    const pb = pts[pts.length - 1]!
    return svgPolyline([a.tip, [a.x, a.y], [pa[0], a.y], ...pts, [pb[0], b.y], [b.x, b.y], b.tip])
  }

  const readerLinkPath = (s: string, t: string): string => {
    const ps = readerPos.get(s)
    const pt = readerPos.get(t)
    if (!ps || !pt) return ''
    return readerTraceCurve([ps.x + CANVAS_READER_DIM.NW / 2, ps.y + CANVAS_READER_DIM.NH], [pt.x + CANVAS_READER_DIM.NW / 2, pt.y])
  }

  const traceEdges: Array<{ key: string; from: string; to: string; props: CanvasEdgeProps }> = []
  const pushTrace = (s: string, t: string, kind: 'trace-pre' | 'trace-post'): void => {
    const key = `${kind}:${s}>${t}`
    const d = skin === 'datasheet' ? dsLinkPath(s, t) : readerLinkPath(s, t)
    if (!d) return
    traceEdges.push({
      key,
      from: s,
      to: t,
      props: { kind, d, tx: 0, ty: 0, weight: 2.5, pairKey: key, active: true, hot: hotTraceKey === key, segments: [] },
    })
  }
  for (const [s, t] of focus.preEdges) pushTrace(s, t, 'trace-pre')
  for (const [s, t] of focus.postEdges) pushTrace(s, t, 'trace-post')

  const groupBoxOf = (groupId: string): BoxRect | null => {
    if (skin === 'reader') {
      const g = GMap.get(groupId)
      return g ? { x: g.x, y: g.y, w: g.w, h: g.h } : null
    }
    const ds = pinout?.byGroup.get(groupId)
    if (!ds || ds.length === 0) return null
    let x0 = Infinity
    let y0 = Infinity
    let r0 = -Infinity
    let b0 = -Infinity
    for (const c of ds) {
      x0 = Math.min(x0, c.box.x)
      y0 = Math.min(y0, c.box.y)
      r0 = Math.max(r0, c.box.x + c.box.w)
      b0 = Math.max(b0, c.box.y + c.box.h)
    }
    return { x: x0, y: y0 - 20, w: r0 - x0, h: b0 - y0 + 20 }
  }

  const nodeBoxOf = (lecId: string): BoxRect | null => {
    if (skin === 'reader') {
      const p = readerPos.get(lecId)
      return p ? { x: p.x, y: p.y, w: CANVAS_READER_DIM.NW, h: CANVAS_READER_DIM.NH } : null
    }
    const p = pinout?.pins.get(lecId)
    if (!p) return null
    const far = p.x + p.side * (CANVAS_DS_DIM.LEG + CANVAS_DS_DIM.NUMGAP + CANVAS_DS_DIM.NAME)
    return { x: Math.min(p.x, far), y: p.y - 14, w: Math.abs(far - p.x), h: 28 }
  }

  const focusPointOf = (lecId: string): readonly [number, number] | null => {
    if (skin === 'reader') {
      const p = readerPos.get(lecId)
      return p ? [p.x + CANVAS_READER_DIM.NW / 2, p.y + CANVAS_READER_DIM.NH / 2] : null
    }
    const p = pinout?.pins.get(lecId)
    return p ? p.tip : null
  }

  return {
    skin,
    width,
    height,
    backdrop: { zones },
    groups,
    nodes,
    intraEdges,
    bundleEdges,
    traceEdges,
    bigLabels,
    groupBoxOf,
    nodeBoxOf,
    focusPointOf,
  }
}

export function unionBoxes(boxes: ReadonlyArray<BoxRect | null>): BoxRect | null {
  let x0 = Infinity
  let y0 = Infinity
  let r0 = -Infinity
  let b0 = -Infinity
  for (const bx of boxes) {
    if (!bx) continue
    x0 = Math.min(x0, bx.x)
    y0 = Math.min(y0, bx.y)
    r0 = Math.max(r0, bx.x + bx.w)
    b0 = Math.max(b0, bx.y + bx.h)
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: r0 - x0, h: b0 - y0 } : null
}
