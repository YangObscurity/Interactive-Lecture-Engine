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
  for (const b of R.bundles) {
    const pairKey = b.a < b.b ? `${b.a}|${b.b}` : `${b.b}|${b.a}`
    const active = focus.activePairKey === pairKey
    const hot = hotPairKey === pairKey
    if (skin === 'reader') {
      const A = GMap.get(b.a)
      const B = GMap.get(b.b)
      if (!A || !B) continue
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
      const d = readerBundleBezier(p1, p2, horiz)
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
