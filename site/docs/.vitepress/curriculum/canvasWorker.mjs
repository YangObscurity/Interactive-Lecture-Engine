/**
 * curriculum/canvasWorker.mjs - deterministic child-process layout & routing worker (P4b).
 *
 * Ported from the home-canvas prototype with identical geometry/routing constants:
 *   - ELK `rectpacking` for packing group boxes, DIP units and category zones towards 16:9;
 *   - libavoid-js orthogonal routing inside reader groups and along datasheet inter-unit buses;
 *   - Zero wall-clock timing fields (`ms`) and zero localized titles;
 *   - Executed in a fresh Node child process per distinct input so libavoid WASM heap addresses never vary across runs.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ELK from 'elkjs/lib/elk.bundled.js'
import { AvoidLib } from 'libavoid-js'

await AvoidLib.load()
const A = AvoidLib.getInstance()
const elk = new ELK()

const r = (v) => Math.round(v * 2) / 2
const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8
const CROSS_LIMIT = 120

export const R = { NW: 184, NH: 32, HEAD: 52, PAD: 44, PADB: 70, GX: 48, GY: 66, BOUNDK: 0.95, BMAX: 16, GROUPGAP: 90, VIEW: [1440, 640] }
export const D = { PIT: 26, OFF: 26, LEG: 18, NAME: 196, NUMGAP: 8, BODYW: 168, BUSLEAD: 16, ZHEAD: 56, ZPAD: 80, BUSPITCH: 12, MAXSIDE: 20, UNITGAP: 70, GAP: 150 }
export const SIDE = D.LEG + D.NUMGAP + D.NAME

function newRouter(nudge) {
  const router = new A.Router(2)
  const P = A.RoutingParameter
  const O = A.RoutingOption
  router.setRoutingParameter(P.shapeBufferDistance, nudge.buffer)
  router.setRoutingParameter(P.idealNudgingDistance, nudge.nudge)
  router.setRoutingParameter(P.segmentPenalty, 60)
  router.setRoutingParameter(P.crossingPenalty, nudge.crossing)
  router.setRoutingParameter(P.fixedSharedPathPenalty, 400)
  router.setRoutingOption(O.nudgeOrthogonalSegmentsConnectedToShapes, !!nudge.ends)
  router.setRoutingOption(O.nudgeOrthogonalTouchingColinearSegments, true)
  router.setRoutingOption(O.performUnifyingNudgingPreprocessingStep, true)
  router.setRoutingOption(O.penaliseOrthogonalSharedPathsAtConnEnds, true)
  return router
}

const rect = (x, y, w, h) => new A.Rectangle(new A.Point(x, y), new A.Point(x + w, y + h))

function routeOf(c) {
  const rt = c.displayRoute()
  const pts = []
  for (let i = 0; i < rt.size(); i++) {
    const p = rt.at(i)
    pts.push([r(p.x), r(p.y)])
  }
  return pts
}

const pack = (items, spacing, aspect) =>
  elk.layout({
    id: 'p',
    layoutOptions: {
      'elk.algorithm': 'rectpacking',
      'elk.aspectRatio': String(aspect),
      'elk.spacing.nodeNode': String(spacing),
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      'elk.rectpacking.trybox': 'false',
      'elk.contentAlignment': 'V_TOP H_LEFT',
    },
    children: items,
  })

export function roundedPath(pts, rad = 10) {
  if (pts.length < 3) return pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ' ' + p[1]).join('')
  let d = 'M' + pts[0][0] + ' ' + pts[0][1]
  for (let i = 1; i < pts.length - 1; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]]
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1])
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
    const k = Math.min(rad, l1 / 2, l2 / 2)
    if (!k) {
      d += 'L' + b[0] + ' ' + b[1]
      continue
    }
    const p = [b[0] - ((b[0] - a[0]) / l1) * k, b[1] - ((b[1] - a[1]) / l1) * k]
    const q = [b[0] + ((c[0] - b[0]) / l2) * k, b[1] + ((c[1] - b[1]) / l2) * k]
    d += 'L' + r(p[0]) + ' ' + r(p[1]) + 'Q' + b[0] + ' ' + b[1] + ' ' + r(q[0]) + ' ' + r(q[1])
  }
  const z = pts[pts.length - 1]
  return d + 'L' + z[0] + ' ' + z[1]
}

export function transitiveReduction(lectures, edges) {
  const adj = new Map(lectures.map((l) => [l.id, []]))
  for (const [s, t] of edges) {
    const list = adj.get(s)
    if (list && adj.has(t)) list.push(t)
  }
  const reach = (s, t) => {
    const seen = new Set()
    const st = (adj.get(s) || []).filter((x) => x !== t)
    while (st.length) {
      const x = st.pop()
      if (x === t) return true
      if (seen.has(x)) continue
      seen.add(x)
      for (const nx of adj.get(x) || []) st.push(nx)
    }
    return false
  }
  return new Set(edges.filter(([s, t]) => !reach(s, t)).map(([s, t]) => s + '>' + t))
}

export function segOverlaps(paths, ends) {
  const segs = []
  paths.forEach((pts, bi) => {
    for (let i = 1; i < pts.length; i++) segs.push({ bi, a: pts[i - 1], c: pts[i] })
  })
  let n = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const S = segs[i]
      const T = segs[j]
      if (S.bi === T.bi) continue
      if (ends) {
        const [a1, b1] = ends[S.bi]
        const [a2, b2] = ends[T.bi]
        if (a1 === a2 || a1 === b2 || b1 === a2 || b1 === b2) continue
      }
      for (const ax of [0, 1]) {
        const o = 1 - ax
        if (S.a[o] === S.c[o] && T.a[o] === T.c[o] && Math.abs(S.a[o] - T.a[o]) < 3) {
          const lo = Math.max(Math.min(S.a[ax], S.c[ax]), Math.min(T.a[ax], T.c[ax]))
          const hi = Math.min(Math.max(S.a[ax], S.c[ax]), Math.max(T.a[ax], T.c[ax]))
          if (hi - lo > 6) n++
        }
      }
    }
  }
  return n
}

function routeGroup(nodes, intra, w, h) {
  if (intra.length === 0) return []
  const router = newRouter({ buffer: 8, nudge: 6, crossing: intra.length <= CROSS_LIMIT ? 100 : 0, ends: true })
  const shape = {}
  const keep = []
  nodes.forEach((n, i) => {
    const sh = new A.ShapeRef(router, rect(n.x, n.y, R.NW, R.NH))
    shape[n.id] = { sh, out: 2 * i + 1, in: 2 * i + 2 }
    for (const [c, x, y, d] of [
      [2 * i + 1, R.NW, R.NH / 2 + 5, RIGHT],
      [2 * i + 1, R.NW / 2 + 14, R.NH, DOWN],
      [2 * i + 2, 0, R.NH / 2 - 5, LEFT],
      [2 * i + 2, R.NW / 2 - 14, 0, UP],
    ]) {
      const pin = new A.ShapeConnectionPin(sh, c, x, y, false, 0, d)
      pin.setExclusive(false)
      keep.push(pin)
    }
    keep.push(sh)
  })
  const fr = 40
  for (const [x, y, ww, hh] of [
    [-fr, -fr, w + 2 * fr, fr],
    [-fr, h, w + 2 * fr, fr],
    [-fr, 0, fr, h],
    [w, 0, fr, h],
    [0, 0, w, R.HEAD - 14],
  ]) {
    keep.push(new A.ShapeRef(router, rect(x, y, ww, hh)))
  }
  const conns = intra.map(([s, t]) => ({ s, t, c: new A.ConnRef(router, new A.ConnEnd(shape[s].sh, shape[s].out), new A.ConnEnd(shape[t].sh, shape[t].in)) }))
  conns.forEach((x) => x.c.setRoutingType(A.ConnType.ConnType_Orthogonal))
  router.processTransaction()
  const eout = conns.map(({ s, t, c }) => {
    const pts = routeOf(c)
    return { s, t, pts, d: roundedPath(pts) }
  })
  router.delete()
  return eout
}

export async function readerLayout(input) {
  const offSet = new Set(input.offMapIds || [])
  for (const g of input.groups) if (g.map === false) offSet.add(g.id)

  // Groups without any valid prerequisite edge (intra- or inter-group) are left off the canvas automatically
  // whenever prerequisite edges are supplied (empty-edge geometry slices like per-tier `tierOwn` keep their groups).
  let pruned = (input.edges || []).length > 0
  while (pruned) {
    pruned = false
    const owner = new Map()
    for (const g of input.groups) {
      if (offSet.has(g.id) || g.lectures.length === 0) continue
      for (const l of g.lectures) owner.set(l.id, g.id)
    }
    const hasEdge = new Set()
    for (const [s, t] of input.edges || []) {
      if (s === t) continue
      const gs = owner.get(s)
      const gt = owner.get(t)
      if (!gs || !gt) continue
      hasEdge.add(gs)
      hasEdge.add(gt)
    }
    for (const g of input.groups) {
      if (!offSet.has(g.id) && g.lectures.length > 0 && !hasEdge.has(g.id)) {
        offSet.add(g.id)
        pruned = true
      }
    }
  }

  const offMap = input.groups.filter((g) => offSet.has(g.id)).map((g) => g.id)
  const groups = input.groups.filter((g) => !offSet.has(g.id) && g.lectures.length > 0)

  const lectures = []
  const byId = Object.create(null)
  for (const g of groups) {
    for (const l of [...g.lectures].sort((a, b) => a.n - b.n)) {
      const item = { id: l.id, n: l.n, g: g.id }
      lectures.push(item)
      byId[l.id] = item
    }
  }

  const edges = input.edges
    .filter(([s, t]) => byId[s] && byId[t] && s !== t)
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  const redKey = transitiveReduction(lectures, edges)
  const pre = new Map(lectures.map((l) => [l.id, []]))
  for (const [s, t] of edges) pre.get(t).push(s)

  const out = []
  for (const g of groups) {
    const kids = [...g.lectures].sort((a, b) => a.n - b.n)
    const inG = new Set(kids.map((l) => l.id))
    const depth = new Map()
    const state = new Map()
    const dep = (u) => {
      if (state.get(u) === 2) return depth.get(u)
      if (state.get(u) === 1) return 0
      state.set(u, 1)
      let d = 0
      for (const p of pre.get(u) || []) if (inG.has(p)) d = Math.max(d, dep(p) + 1)
      state.set(u, 2)
      depth.set(u, d)
      return d
    }
    kids.forEach((l) => dep(l.id))
    const order = [...kids].sort((a, b) => depth.get(a.id) - depth.get(b.id) || a.n - b.n)
    const bound = Math.max(2, Math.min(R.BMAX, Math.round(Math.sqrt(R.BOUNDK * kids.length))))
    const rows = []
    const rowOf = new Map()
    const col = new Map()
    order.forEach((l, i) => {
      const ri = Math.floor(i / bound)
      ;(rows[ri] = rows[ri] || []).push(l)
      rowOf.set(l.id, ri)
      col.set(l.id, i % bound)
    })
    const cols = Math.max(...rows.map((x) => x.length))
    const intra = edges.filter(([s, t]) => inG.has(s) && inG.has(t) && redKey.has(s + '>' + t))

    let w = 260
    let h = 160
    let nodes = []
    let eout = []
    let scale = 1
    for (const sc of [1, 1.4, 1.8, 2.4]) {
      scale = sc
      const GX = Math.round(R.GX * sc)
      const GY = Math.round(R.GY * sc)
      w = 2 * R.PAD + cols * R.NW + (cols - 1) * GX
      h = R.HEAD + rows.length * R.NH + (rows.length - 1) * GY + R.PADB
      nodes = kids.map((l) => ({
        id: l.id,
        x: r(R.PAD + col.get(l.id) * (R.NW + GX)),
        y: r(R.HEAD + rowOf.get(l.id) * (R.NH + GY)),
      }))
      eout = routeGroup(nodes, intra, w, h)
      if (!segOverlaps(eout.map((e) => e.pts), eout.map((e) => [e.s, e.t]))) break
    }
    out.push({
      id: g.id,
      dir: g.dir,
      cat: g.catSlot,
      rank: 0,
      x: 0,
      y: 0,
      w: r(Math.max(w, 260)),
      h: r(h),
      cols,
      rows: rows.length,
      gapScale: scale,
      nodes,
      edges: eout,
    })
  }

  if (out.length === 0) {
    return { W: 640, H: 360, NW: R.NW, NH: R.NH, HEAD: R.HEAD, groups: [], bundles: [], edges: [], offMap }
  }

  const pair = new Map()
  for (const [s, t] of edges) {
    const a = byId[s].g
    const b = byId[t].g
    if (a === b) continue
    const [x, y] = a < b ? [a, b] : [b, a]
    const k = x + '|' + y
    const v = pair.get(k) || { a: x, b: y, n: 0, fwd: 0 }
    v.n++
    if (a === x) v.fwd++
    pair.set(k, v)
  }
  const bundles = [...pair.values()].map((v) => (v.fwd * 2 >= v.n ? { a: v.a, b: v.b, n: v.n } : { a: v.b, b: v.a, n: v.n }))
  const outs = new Map(out.map((g) => [g.id, []]))
  for (const b of bundles) outs.get(b.a).push(b.b)

  const rank = new Map()
  const st = new Map()
  const gDepth = (u) => {
    if (st.get(u) === 2) return rank.get(u)
    if (st.get(u) === 1) return 0
    st.set(u, 1)
    let d = 0
    for (const [p, o] of outs) {
      if (o.includes(u)) d = Math.max(d, gDepth(p) + 1)
    }
    st.set(u, 2)
    rank.set(u, d)
    return d
  }
  out.forEach((g) => gDepth(g.id))
  out.forEach((g) => {
    g.rank = rank.get(g.id)
  })
  const ordered = [...out].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id, 'en', { numeric: true }))
  const top = await pack(ordered.map((g) => ({ id: g.id, width: g.w, height: g.h })), R.GROUPGAP, 1.78)
  const M = 48
  for (const c of top.children || []) {
    const g = out.find((x) => x.id === c.id)
    if (g) {
      g.x = r(M + c.x)
      g.y = r(M + c.y)
    }
  }
  return {
    W: r((top.width || 0) + 2 * M),
    H: r((top.height || 0) + 2 * M),
    NW: R.NW,
    NH: R.NH,
    HEAD: R.HEAD,
    groups: out,
    bundles,
    edges: edges.map(([s, t]) => [s, t, redKey.has(s + '>' + t) ? 1 : 0]),
    offMap,
  }
}

export async function datasheetLayout(Lr, MODE = 'compact') {
  if (Lr.groups.length === 0) {
    return { MODE, SIDE, W: 640, H: 360, zones: [], units: {}, buses: [], endErr: 0 }
  }
  const units = {}
  const unitOf = {}
  const blocks = []
  for (const g of Lr.groups) {
    const lec = [...g.nodes].sort((a, b) => {
      const na = parseInt(a.id.split('-l')[1] || '0', 10)
      const nb = parseInt(b.id.split('-l')[1] || '0', 10)
      return na - nb || a.id.localeCompare(b.id)
    })
    const nu = Math.max(1, Math.ceil(lec.length / (2 * D.MAXSIDE)))
    const size = Math.ceil(lec.length / nu)
    const ids = []
    for (let u = 0; u < nu; u++) {
      const part = lec.slice(u * size, (u + 1) * size)
      if (!part.length) continue
      const uid = nu > 1 ? g.id + 'ABCDEFGHIJKLMNOP'[u] : g.id
      const per = Math.ceil(part.length / 2)
      const bh = Math.max(2 * D.OFF + (per - 1) * D.PIT, 150)
      units[uid] = {
        g: g.id,
        part: nu > 1 ? 'ABCDEFGHIJKLMNOP'[u] : '',
        of: nu,
        lec: part.map((l) => l.id),
        per,
        total: per * 2,
        bw: D.BODYW,
        bh,
        w: D.BODYW + 2 * SIDE,
        h: bh + 2 * D.BUSLEAD,
        cat: g.cat,
      }
      part.forEach((l) => {
        unitOf[l.id] = uid
      })
      ids.push(uid)
    }
    const bw = ids.reduce((s, u) => s + units[u].w, 0) + D.UNITGAP * (ids.length - 1)
    const bh = Math.max(...ids.map((u) => units[u].h))
    blocks.push({ id: g.id, cat: g.cat, rank: g.rank, ids, w: bw, h: bh })
  }

  const order = [...blocks].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id, 'en', { numeric: true }))
  const place = (b, x, y) => {
    let cx = x
    for (const u of b.ids) {
      units[u].nx = cx
      units[u].ny = y + (b.h - units[u].h) / 2
      cx += units[u].w + D.UNITGAP
    }
  }
  const zones = []
  const M = 60
  if (MODE === 'zones') {
    const cats = [...new Set(order.map((b) => b.cat))]
    const zl = []
    for (const c of cats) {
      const bs = order.filter((b) => b.cat === c)
      const p = await pack(bs.map((b) => ({ id: b.id, width: b.w, height: b.h })), D.GAP, 1.4)
      zl.push({ id: 'Z' + c, cat: c, w: p.width + 2 * D.ZPAD, h: p.height + D.ZHEAD + D.ZPAD, kids: p.children || [] })
    }
    const top = await pack(zl.map((z) => ({ id: z.id, width: z.w, height: z.h })), D.GAP, 1.78)
    for (const z of zl) {
      const zp = (top.children || []).find((c) => c.id === z.id)
      const zx = M + (zp?.x || 0)
      const zy = M + (zp?.y || 0)
      zones.push({ cat: z.cat, x: r(zx), y: r(zy), w: r(z.w), h: r(z.h) })
      for (const k of z.kids) place(blocks.find((b) => b.id === k.id), zx + D.ZPAD + k.x, zy + D.ZHEAD + k.y)
    }
  } else {
    const p = await pack(order.map((b) => ({ id: b.id, width: b.w, height: b.h })), D.GAP, 1.78)
    for (const k of p.children || []) place(blocks.find((b) => b.id === k.id), M + k.x, M + k.y)
  }

  let W = 0
  let H = 0
  for (const k of Object.values(units)) {
    k.x = r(k.nx + SIDE)
    k.y = r(k.ny + D.BUSLEAD)
    W = Math.max(W, k.nx + k.w + M)
    H = Math.max(H, k.ny + k.h + M)
  }
  for (const z of zones) {
    W = Math.max(W, z.x + z.w + M)
    H = Math.max(H, z.y + z.h + M)
  }

  const pair = new Map()
  for (const [s, t] of Lr.edges) {
    const a = unitOf[s]
    const b = unitOf[t]
    if (!a || !b || a === b) continue
    const [x, y] = a < b ? [a, b] : [b, a]
    const k = x + '|' + y
    const v = pair.get(k) || { a: x, b: y, n: 0, fwd: 0 }
    v.n++
    if (a === x) v.fwd++
    pair.set(k, v)
  }
  const ubus = [...pair.values()].map((v) => (v.fwd * 2 >= v.n ? { ua: v.a, ub: v.b, n: v.n } : { ua: v.b, ub: v.a, n: v.n }))

  let buses = []
  let endErr = 0
  for (const k of Object.values(units)) k.ports = []
  if (ubus.length > 0) {
    const router = newRouter({ buffer: 14, nudge: 10, crossing: ubus.length <= CROSS_LIMIT ? 200 : 0 })
    const shapes = {}
    const slots = {}
    const keep = []
    let cls = 1
    for (const [id, k] of Object.entries(units)) {
      const sh = new A.ShapeRef(router, rect(k.nx, k.ny, k.w, k.h))
      shapes[id] = sh
      k.cls = cls++
      slots[id] = []
      const n = Math.floor((D.BODYW - 2 * D.BUSPITCH) / D.BUSPITCH) + 1
      for (let i = 0; i < n; i++) {
        const ox = SIDE + D.BUSPITCH + i * D.BUSPITCH
        for (const [oy, dir, side, dx] of [
          [0, UP, 'top', D.BUSPITCH / 2],
          [k.h, DOWN, 'bottom', 0],
        ]) {
          const pin = new A.ShapeConnectionPin(sh, k.cls, ox + dx, oy, false, 0, dir)
          pin.setExclusive(true)
          keep.push(pin)
          slots[id].push({ x: k.nx + ox + dx, y: k.ny + oy, side })
        }
      }
      keep.push(sh)
    }
    for (const z of zones) keep.push(new A.ShapeRef(router, rect(z.x + 8, z.y + 6, 190, 40)))
    const conns = ubus.map((b) => ({
      b,
      c: new A.ConnRef(router, new A.ConnEnd(shapes[b.ua], units[b.ua].cls), new A.ConnEnd(shapes[b.ub], units[b.ub].cls)),
    }))
    conns.forEach((x) => x.c.setRoutingType(A.ConnType.ConnType_Orthogonal))
    router.processTransaction()
    buses = conns.map(({ b, c }) => ({
      ua: b.ua,
      ub: b.ub,
      ga: units[b.ua].g,
      gb: units[b.ub].g,
      n: b.n,
      pts: routeOf(c),
    }))
    router.delete()

    buses.forEach((bus, i) => {
      for (const [id, p] of [
        [bus.ua, bus.pts[0]],
        [bus.ub, bus.pts[bus.pts.length - 1]],
      ]) {
        const m = slots[id].reduce((best, s) => {
          const d = Math.hypot(s.x - p[0], s.y - p[1])
          return !best || d < best.d ? { s, d } : best
        }, null)
        if (m) {
          endErr = Math.max(endErr, m.d)
          units[id].ports.push({ id: `${id}.${m.s.side === 'bottom' ? 'out' : 'in'}${i}`, x: r(m.s.x), y: r(m.s.y) })
        }
      }
    })
  }

  const outUnits = Object.fromEntries(
    Object.entries(units).map(([id, k]) => [
      id,
      { g: k.g, part: k.part, of: k.of, lec: k.lec, per: k.per, total: k.total, bw: k.bw, bh: k.bh, w: k.w, h: k.h, x: k.x, y: k.y, nx: r(k.nx), ny: r(k.ny), ports: k.ports },
    ]),
  )
  return { MODE, SIDE, W: r(W), H: r(H), zones, units: outUnits, buses, endErr }
}

export async function computeCanvasBundle(input) {
  const reader = await readerLayout(input)
  const compact = await datasheetLayout(reader, 'compact')
  const zones = await datasheetLayout(reader, 'zones')
  return { version: 1, reader, datasheet: { compact, zones } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = fs.readFileSync(0, 'utf8')
  const input = JSON.parse(raw)
  const bundle = await computeCanvasBundle(input)
  process.stdout.write(JSON.stringify(bundle))
}
