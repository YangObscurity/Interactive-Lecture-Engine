/**
 * curriculum/canvasMetrics.ts - pure geometry & routing quality checks for canvas layouts (ported from boardlib.mjs).
 */
import type { CanvasDatasheetBoard, CanvasReaderBoard } from './canvasTypes.ts'
import { CANVAS_READER_DIM } from './canvasTypes.ts'

type Point = readonly [number, number]
interface RectBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export function segmentOverlaps(paths: ReadonlyArray<ReadonlyArray<Point>>, ends?: ReadonlyArray<readonly [string, string]>): number {
  const segs: Array<{ bi: number; a: Point; c: Point }> = []
  paths.forEach((pts, bi) => {
    for (let i = 1; i < pts.length; i++) segs.push({ bi, a: pts[i - 1] as Point, c: pts[i] as Point })
  })
  let n = 0
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const S = segs[i]
      const T = segs[j]
      if (!S || !T || S.bi === T.bi) continue
      if (ends) {
        const ea = ends[S.bi]
        const eb = ends[T.bi]
        if (ea && eb && (ea[0] === eb[0] || ea[0] === eb[1] || ea[1] === eb[0] || ea[1] === eb[1])) continue
      }
      for (const ax of [0, 1] as const) {
        const o = (1 - ax) as 0 | 1
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

export function routesThroughBoxes(
  paths: ReadonlyArray<ReadonlyArray<Point>>,
  rects: readonly RectBox[],
  own: (routeIdx: number, boxIdx: number) => boolean,
): number {
  let n = 0
  paths.forEach((pts, i) => {
    for (let k = 1; k < pts.length; k++) {
      const [x1, y1] = pts[k - 1] as Point
      const [x2, y2] = pts[k] as Point
      rects.forEach((q, j) => {
        if (own(i, j)) return
        if (Math.max(x1, x2) > q.x + 1 && Math.min(x1, x2) < q.x + q.w - 1 && Math.max(y1, y2) > q.y + 1 && Math.min(y1, y2) < q.y + q.h - 1) n++
      })
    }
  })
  return n
}

export interface ReaderBoardMetrics {
  groups: number
  nodeOverlap: number
  edgesThroughNodes: number
  edgeOverlaps: number
  worstFitK: number
  unreadable: number
}

export function measureReaderBoard(Lr: CanvasReaderBoard): ReaderBoardMetrics {
  const [vw, vh] = CANVAS_READER_DIM.VIEW
  let nodeOverlap = 0
  let edgesThroughNodes = 0
  let edgeOverlaps = 0
  const fit: number[] = []
  for (const g of Lr.groups) {
    fit.push(Math.min(vw / (g.w + 40), vh / (g.h + 40)))
    const rects: RectBox[] = g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: CANVAS_READER_DIM.NW, h: CANVAS_READER_DIM.NH }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!
        const b = rects[j]!
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) nodeOverlap++
      }
    }
    edgesThroughNodes += routesThroughBoxes(
      g.edges.map((e) => e.pts),
      rects,
      (i, j) => rects[j]?.id === g.edges[i]?.s || rects[j]?.id === g.edges[i]?.t,
    )
    edgeOverlaps += segmentOverlaps(
      g.edges.map((e) => e.pts),
      g.edges.map((e) => [e.s, e.t]),
    )
  }
  const worstFitK = fit.length ? Math.min(...fit) : 1
  return {
    groups: Lr.groups.length,
    nodeOverlap,
    edgesThroughNodes,
    edgeOverlaps,
    worstFitK,
    unreadable: fit.filter((k) => k < 0.45).length,
  }
}

export interface DatasheetBoardMetrics {
  units: number
  buses: number
  endErr: number
  overlaps: number
  diagonal: number
  throughUnits: number
  unreadable: number
}

export function measureDatasheetBoard(Ds: CanvasDatasheetBoard): DatasheetBoardMetrics {
  const [vw, vh] = CANVAS_READER_DIM.VIEW
  const ids = Object.keys(Ds.units)
  const rects: RectBox[] = ids.map((id) => {
    const u = Ds.units[id]!
    return { id, x: u.nx, y: u.ny, w: u.w, h: u.h }
  })
  const throughUnits = routesThroughBoxes(
    Ds.buses.map((b) => b.pts),
    rects,
    (i, j) => rects[j]?.id === Ds.buses[i]?.ua || rects[j]?.id === Ds.buses[i]?.ub,
  )
  let diagonal = 0
  for (const b of Ds.buses) {
    for (let i = 1; i < b.pts.length; i++) {
      if (b.pts[i]![0] !== b.pts[i - 1]![0] && b.pts[i]![1] !== b.pts[i - 1]![1]) diagonal++
    }
  }
  const fit = rects.map((q) => Math.min(vw / (q.w + 40), vh / (q.h + 40)))
  return {
    units: ids.length,
    buses: Ds.buses.length,
    endErr: +Ds.endErr.toFixed(1),
    overlaps: segmentOverlaps(
      Ds.buses.map((b) => b.pts),
      Ds.buses.map((b) => [b.ua, b.ub]),
    ),
    diagonal,
    throughUnits,
    unreadable: fit.filter((k) => k < 0.45).length,
  }
}
