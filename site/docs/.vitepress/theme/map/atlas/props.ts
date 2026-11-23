/**
 * map/atlas/props.ts - from a laid-out node to the props of its slot component (P4a WP-H2).
 *
 * Pure. The props of a slot are the contract (theme/slots/registry.ts): geometry (canvas units) and state. They are
 * flat and made of numbers, strings and booleans, so a component whose values did not change is not rendered again.
 */
import type { AtlasCategoryProps, AtlasCenterProps, AtlasGroupProps, AtlasLectureProps, AtlasLinkProps, AtlasPhaseProps, AtlasStatus } from '../../slots/registry.ts'
import { highlightOf } from './focus.ts'
import type { AtlasFocus } from './focus.ts'
import type { AtlasLayout, AtlasLinkGeo, LaidNode } from './layout.ts'

export interface PropsContext {
  layout: AtlasLayout
  statuses: ReadonlyMap<string, AtlasStatus>
  focus: AtlasFocus | null
  /** Rows that light up for the search hits. */
  matches: ReadonlySet<string>
  /** Centre box texts (already clipped and translated). */
  centerTitle: string
  centerSubtitle: string
  trunk: (lectures: number) => string
}

/** `r` / `g` / `u` per lecture of a node, in reading order. */
export function ticksOf(L: LaidNode, statuses: ReadonlyMap<string, AtlasStatus>): string {
  let out = ''
  for (const l of L.node.lec) {
    const s = statuses.get(l.id)
    out += s === 'read' ? 'r' : s === 'reading' ? 'g' : 'u'
  }
  return out
}

export function centerProps(ctx: PropsContext, read: number, reading: number, total: number): AtlasCenterProps {
  const c = ctx.layout.center
  return { id: 'root', x: c.x, y: c.y, w: c.w, h: c.h, title: ctx.centerTitle, subtitle: ctx.centerSubtitle, read, reading, total, pads: c.pads }
}

export function categoryProps(L: LaidNode, ctx: PropsContext): AtlasCategoryProps {
  const { layout } = ctx
  const side = L.side as -1 | 1
  const inner = (layout.X[1] as number) - 12
  const outer = L.ext + 16
  return {
    id: L.id,
    side,
    slot: L.slot,
    highlight: highlightOf(ctx.focus, L.id),
    match: ctx.matches.has(L.id),
    xi: L.xi,
    xo: L.xo,
    x0: L.x0,
    w: L.w,
    y: L.y,
    label: L.label,
    labelW: L.labelW,
    groups: L.node.kids.length,
    total: L.total,
    read: L.read,
    innerX: Math.round((layout.ox + side * inner) * 10) / 10,
    outerX: Math.round((layout.ox + side * outer) * 10) / 10,
    zoneTop: Math.round((L.top - 12) * 10) / 10,
    zoneH: Math.round((L.bh + 24) * 10) / 10,
    caption: L.prog,
    captionW: L.progW,
    trunk: ctx.trunk(L.total),
  }
}

export function groupProps(L: LaidNode, ctx: PropsContext): AtlasGroupProps {
  const { layout } = ctx
  const M = layout.metrics
  const side = L.side as -1 | 1
  const col = layout.X[3] as number
  const from = Math.abs(L.xo - layout.ox) + M.tog - 4
  return {
    id: L.id,
    side,
    slot: L.slot,
    highlight: highlightOf(ctx.focus, L.id),
    match: ctx.matches.has(L.id),
    xi: L.xi,
    xo: L.xo,
    x0: L.x0,
    w: L.w,
    y: L.y,
    ticks: ticksOf(L, ctx.statuses),
    stripFrom: Math.round((layout.ox + side * from) * 10) / 10,
    stripCol: Math.round((layout.ox + side * col) * 10) / 10,
    tick: M.tick,
    tickW: M.tw,
    groupId: L.idText,
    title: L.label,
    idW: L.idW,
    titleW: L.labelW,
    pkg: L.pkg,
    progress: L.prog,
    progressW: L.progW,
    total: L.total,
    read: L.read,
    reading: L.reading,
    open: L.open,
  }
}

export function phaseProps(L: LaidNode, ctx: PropsContext): AtlasPhaseProps {
  const { layout } = ctx
  const M = layout.metrics
  const side = L.side as -1 | 1
  const col = layout.X[4] as number
  const from = Math.abs(L.xo - layout.ox) + M.tog - 4
  return {
    id: L.id,
    side,
    slot: L.slot,
    highlight: highlightOf(ctx.focus, L.id),
    match: ctx.matches.has(L.id),
    xi: L.xi,
    xo: L.xo,
    x0: L.x0,
    w: L.w,
    y: L.y,
    ticks: ticksOf(L, ctx.statuses),
    stripFrom: Math.round((layout.ox + side * from) * 10) / 10,
    stripCol: Math.round((layout.ox + side * col) * 10) / 10,
    tick: M.tick,
    tickW: M.tw,
    label: L.label,
    labelW: L.labelW,
    total: L.total,
    read: L.read,
    reading: L.reading,
    open: L.open,
  }
}

export function lectureProps(L: LaidNode, ctx: PropsContext): AtlasLectureProps {
  const side = L.side as -1 | 1
  const lec = L.node.lecture
  return {
    id: L.id,
    side,
    slot: L.slot,
    highlight: highlightOf(ctx.focus, L.id),
    match: ctx.matches.has(L.id),
    xi: L.xi,
    xo: L.xo,
    x0: L.x0,
    w: L.w,
    y: L.y,
    number: L.idText,
    label: L.label,
    title: lec?.title ?? '',
    labelX: Math.round((L.xi + side * ctx.layout.metrics.lecX) * 10) / 10,
    labelW: L.labelW,
    status: ctx.statuses.get(L.id) ?? 'unread',
  }
}

export function linkProps(g: AtlasLinkGeo, ctx: PropsContext): AtlasLinkProps {
  return { id: g.id, parentId: g.parentId, kind: g.kind, side: g.side, slot: g.slot, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, bus: g.bus, on: ctx.focus?.links.has(g.id) === true }
}
