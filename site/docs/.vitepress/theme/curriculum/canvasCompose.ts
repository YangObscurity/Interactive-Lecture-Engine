/**
 * theme/curriculum/canvasCompose.ts - merges the inline CanvasBundle with 0..N readable restricted-tier slices
 * (P4b, docs-dev/MAP.md & P3b).
 *
 *   0 slices  -> inline CanvasBundle as built;
 *   1 slice   -> slice.boardWithInline (exact ELK + libavoid board computed for inline + tier);
 *   >=2 slices -> deterministic browser composition from inline + each tier's own precomputed intra-group layouts & DIP units,
 *                 adding cross-tier bundles & buses from the merged curriculum edges (zero ELK/libavoid in the browser,
 *                 zero cross-tier leak in any `/_access/<tier>/canvas.json` file).
 */
import type {
  CanvasBundle,
  CanvasBundleEdge,
  CanvasDatasheetBoard,
  CanvasDatasheetMode,
  CanvasDsBus,
  CanvasDsUnit,
  CanvasDsZone,
  CanvasReaderBoard,
  CanvasReaderGroupLayout,
  CanvasTierSlice,
} from '../../curriculum/canvasTypes'
import { CANVAS_DS_DIM, CANVAS_DS_SIDE, CANVAS_READER_DIM } from '../../curriculum/canvasTypes'

const roundHalf = (v: number): number => Math.round(v * 2) / 2

function transitiveReductionEdges(lectureIds: readonly string[], edges: ReadonlyArray<readonly [string, string]>): Set<string> {
  const adj = new Map<string, string[]>(lectureIds.map((id) => [id, []]))
  for (const [s, t] of edges) {
    const list = adj.get(s)
    if (list && adj.has(t)) list.push(t)
  }
  const reach = (s: string, t: string): boolean => {
    const seen = new Set<string>()
    const stack = (adj.get(s) ?? []).filter((x) => x !== t)
    while (stack.length > 0) {
      const x = stack.pop()!
      if (x === t) return true
      if (seen.has(x)) continue
      seen.add(x)
      for (const nx of adj.get(x) ?? []) stack.push(nx)
    }
    return false
  }
  return new Set(edges.filter(([s, t]) => !reach(s, t)).map(([s, t]) => `${s}>${t}`))
}

interface PackBox {
  id: string
  w: number
  h: number
}

function packRows(items: readonly PackBox[], gap: number, targetAspect: number): { width: number; height: number; pos: Map<string, { x: number; y: number }> } {
  const totalArea = items.reduce((s, x) => s + (x.w + gap) * (x.h + gap), 0)
  const targetWidth = Math.max(items.reduce((m, x) => Math.max(m, x.w), 0), Math.sqrt(totalArea * targetAspect))
  const pos = new Map<string, { x: number; y: number }>()
  let x = 0
  let y = 0
  let rowH = 0
  let maxW = 0
  for (const item of items) {
    if (x > 0 && x + item.w > targetWidth) {
      x = 0
      y += rowH + gap
      rowH = 0
    }
    pos.set(item.id, { x: roundHalf(x), y: roundHalf(y) })
    x += item.w + gap
    if (item.h > rowH) rowH = item.h
    if (x - gap > maxW) maxW = x - gap
  }
  return { width: roundHalf(maxW), height: roundHalf(y + rowH), pos }
}

function composeReader(boards: readonly CanvasReaderBoard[], mergedEdges: ReadonlyArray<readonly [string, string]>): CanvasReaderBoard {
  const seenGroup = new Set<string>()
  const groups: CanvasReaderGroupLayout[] = []
  const offMapSet = new Set<string>()
  const lecGroup = new Map<string, string>()
  const allLecs: string[] = []

  for (const b of boards) {
    for (const o of b.offMap) offMapSet.add(o)
    for (const g of b.groups) {
      if (seenGroup.has(g.id)) continue
      seenGroup.add(g.id)
      groups.push({ ...g, nodes: g.nodes.map((n) => ({ ...n })), edges: g.edges.map((e) => ({ ...e })) })
      for (const n of g.nodes) {
        lecGroup.set(n.id, g.id)
        allLecs.push(n.id)
      }
    }
  }

  const edges = mergedEdges.filter(([s, t]) => s !== t && lecGroup.has(s) && lecGroup.has(t))
  const redKey = transitiveReductionEdges(allLecs, edges)
  const pair = new Map<string, { a: string; b: string; n: number; fwd: number }>()
  for (const [s, t] of edges) {
    const a = lecGroup.get(s)!
    const b = lecGroup.get(t)!
    if (a === b) continue
    const [x, y] = a < b ? [a, b] : [b, a]
    const k = `${x}|${y}`
    const v = pair.get(k) ?? { a: x, b: y, n: 0, fwd: 0 }
    v.n++
    if (a === x) v.fwd++
    pair.set(k, v)
  }
  const bundles: CanvasBundleEdge[] = [...pair.values()].map((v) => (v.fwd * 2 >= v.n ? { a: v.a, b: v.b, n: v.n } : { a: v.b, b: v.a, n: v.n }))

  groups.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id, 'en', { numeric: true }))
  const packed = packRows(groups.map((g) => ({ id: g.id, w: g.w, h: g.h })), CANVAS_READER_DIM.GROUPGAP, 1.78)
  const M = 48
  for (const g of groups) {
    const p = packed.pos.get(g.id) ?? { x: 0, y: 0 }
    g.x = roundHalf(M + p.x)
    g.y = roundHalf(M + p.y)
  }

  return {
    W: roundHalf(packed.width + 2 * M),
    H: roundHalf(packed.height + 2 * M),
    NW: CANVAS_READER_DIM.NW,
    NH: CANVAS_READER_DIM.NH,
    HEAD: CANVAS_READER_DIM.HEAD,
    groups,
    bundles,
    edges: edges.map(([s, t]) => [s, t, redKey.has(`${s}>${t}`) ? 1 : 0] as [string, string, 0 | 1]),
    offMap: [...offMapSet],
  }
}

function composeDatasheet(
  boards: readonly CanvasDatasheetBoard[],
  reader: CanvasReaderBoard,
  mode: CanvasDatasheetMode,
): CanvasDatasheetBoard {
  const units: Record<string, CanvasDsUnit> = {}
  const byGroup = new Map<string, CanvasDsUnit[]>()
  const unitOf: Record<string, string> = {}

  for (const b of boards) {
    for (const [uid, u] of Object.entries(b.units)) {
      if (units[uid]) continue
      const copy: CanvasDsUnit = { ...u, lec: [...u.lec], ports: [] }
      units[uid] = copy
      for (const lid of copy.lec) unitOf[lid] = uid
      const list = byGroup.get(copy.g) ?? []
      list.push(copy)
      byGroup.set(copy.g, list)
    }
  }

  const groupMeta = new Map(reader.groups.map((g) => [g.id, g]))
  const blocks = [...byGroup.entries()].map(([gid, list]) => {
    list.sort((a, b) => a.part.localeCompare(b.part))
    const bw = list.reduce((s, u) => s + u.w, 0) + CANVAS_DS_DIM.UNITGAP * (list.length - 1)
    const bh = Math.max(...list.map((u) => u.h))
    const gm = groupMeta.get(gid)
    return { id: gid, cat: gm?.cat ?? 1, rank: gm?.rank ?? 0, list, w: bw, h: bh }
  })
  blocks.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id, 'en', { numeric: true }))

  const placeBlock = (blk: (typeof blocks)[number], x: number, y: number): void => {
    let cx = x
    for (const u of blk.list) {
      u.nx = roundHalf(cx)
      u.ny = roundHalf(y + (blk.h - u.h) / 2)
      u.x = roundHalf(u.nx + CANVAS_DS_SIDE)
      u.y = roundHalf(u.ny + CANVAS_DS_DIM.BUSLEAD)
      cx += u.w + CANVAS_DS_DIM.UNITGAP
    }
  }

  const M = 60
  const zones: CanvasDsZone[] = []
  let W = 640
  let H = 360

  if (mode === 'zones' && blocks.length > 0) {
    const cats = [...new Set(blocks.map((b) => b.cat))]
    const zPackedList = cats.map((cat) => {
      const sub = blocks.filter((b) => b.cat === cat)
      const inner = packRows(sub.map((b) => ({ id: b.id, w: b.w, h: b.h })), CANVAS_DS_DIM.GAP, 1.4)
      return {
        id: `Z${cat}`,
        cat,
        w: roundHalf(inner.width + 2 * CANVAS_DS_DIM.ZPAD),
        h: roundHalf(inner.height + CANVAS_DS_DIM.ZHEAD + CANVAS_DS_DIM.ZPAD),
        sub,
        inner,
      }
    })
    const top = packRows(zPackedList.map((z) => ({ id: z.id, w: z.w, h: z.h })), CANVAS_DS_DIM.GAP, 1.78)
    W = roundHalf(top.width + 2 * M)
    H = roundHalf(top.height + 2 * M)
    for (const z of zPackedList) {
      const p = top.pos.get(z.id) ?? { x: 0, y: 0 }
      const zx = roundHalf(M + p.x)
      const zy = roundHalf(M + p.y)
      zones.push({ cat: z.cat, x: zx, y: zy, w: z.w, h: z.h })
      for (const blk of z.sub) {
        const bp = z.inner.pos.get(blk.id) ?? { x: 0, y: 0 }
        placeBlock(blk, zx + CANVAS_DS_DIM.ZPAD + bp.x, zy + CANVAS_DS_DIM.ZHEAD + bp.y)
      }
    }
  } else if (blocks.length > 0) {
    const top = packRows(blocks.map((b) => ({ id: b.id, w: b.w, h: b.h })), CANVAS_DS_DIM.GAP, 1.78)
    W = roundHalf(top.width + 2 * M)
    H = roundHalf(top.height + 2 * M)
    for (const blk of blocks) {
      const bp = top.pos.get(blk.id) ?? { x: 0, y: 0 }
      placeBlock(blk, M + bp.x, M + bp.y)
    }
  }

  const pair = new Map<string, { ua: string; ub: string; n: number; fwd: number }>()
  for (const [s, t] of reader.edges) {
    const a = unitOf[s]
    const b = unitOf[t]
    if (!a || !b || a === b) continue
    const [x, y] = a < b ? [a, b] : [b, a]
    const k = `${x}|${y}`
    const v = pair.get(k) ?? { ua: x, ub: y, n: 0, fwd: 0 }
    v.n++
    if (a === x) v.fwd++
    pair.set(k, v)
  }

  const usedOut = new Map<string, number>()
  const usedIn = new Map<string, number>()
  const allocPort = (uid: string, side: 'bottom' | 'top', idx: number): { x: number; y: number } => {
    const u = units[uid]!
    const n = Math.floor((CANVAS_DS_DIM.BODYW - 2 * CANVAS_DS_DIM.BUSPITCH) / CANVAS_DS_DIM.BUSPITCH) + 1
    const map = side === 'bottom' ? usedOut : usedIn
    const k = map.get(uid) ?? 0
    map.set(uid, k + 1)
    const slot = k % Math.max(1, n)
    const dx = side === 'top' ? CANVAS_DS_DIM.BUSPITCH / 2 : 0
    const x = roundHalf(u.nx + CANVAS_DS_SIDE + CANVAS_DS_DIM.BUSPITCH + slot * CANVAS_DS_DIM.BUSPITCH + dx)
    const y = roundHalf(side === 'bottom' ? u.ny + u.h : u.ny)
    u.ports.push({ id: `${uid}.${side === 'bottom' ? 'out' : 'in'}${idx}`, x, y })
    return { x, y }
  }

  const buses: CanvasDsBus[] = [...pair.values()].map((v, i) => {
    const ua = v.fwd * 2 >= v.n ? v.ua : v.ub
    const ub = v.fwd * 2 >= v.n ? v.ub : v.ua
    const pa = allocPort(ua, 'bottom', i)
    const pb = allocPort(ub, 'top', i)
    const midY = roundHalf((pa.y + pb.y) / 2 + ((i % 7) - 3) * 8)
    const pts: Array<[number, number]> = pa.y <= pb.y
      ? [[pa.x, pa.y], [pa.x, midY], [pb.x, midY], [pb.x, pb.y]]
      : (() => {
          const laneX = roundHalf(Math.min(pa.x, pb.x) - 32 - (i % 5) * 10)
          return [[pa.x, pa.y], [pa.x, pa.y + 18], [laneX, pa.y + 18], [laneX, pb.y - 18], [pb.x, pb.y - 18], [pb.x, pb.y]]
        })()
    return { ua, ub, ga: units[ua]!.g, gb: units[ub]!.g, n: v.n, pts }
  })

  return { MODE: mode, SIDE: CANVAS_DS_SIDE, W, H, zones, units, buses, endErr: 0 }
}

/** Compose inline CanvasBundle with 0..N readable restricted-tier slices and the merged curriculum's edges. */
export function composeCanvas(
  inline: CanvasBundle,
  slices: readonly CanvasTierSlice[],
  mergedEdges: ReadonlyArray<readonly [string, string]>,
): CanvasBundle {
  if (slices.length === 0) return inline
  if (slices.length === 1) return slices[0]!.boardWithInline

  const reader = composeReader([inline.reader, ...slices.map((s) => s.tierOwn.reader)], mergedEdges)
  const compact = composeDatasheet([inline.datasheet.compact, ...slices.map((s) => s.tierOwn.datasheet.compact)], reader, 'compact')
  const zones = composeDatasheet([inline.datasheet.zones, ...slices.map((s) => s.tierOwn.datasheet.zones)], reader, 'zones')
  return { version: 1, reader, datasheet: { compact, zones } }
}
