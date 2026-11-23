/**
 * map/atlas/layout.ts - the atlas layout (P4a WP-H2; prototype v16 `atlasLayout`): two sides balanced by lecture count, a
 * tidy tree (a parent sits midway between its first and last child), column widths taken from ALL nodes whether open
 * or not (so the columns do not move when a branch opens), links between two columns inside the parent's block, text
 * always horizontal, the left side mirrored.
 *
 * Pure: text widths come from an injected `AtlasText`; statuses, counts and the expansion are inputs. Coordinates in the
 * result are canvas units (the offset is already added), except `rel*` fields (centre-relative, used by the anchors).
 */
import { isNodeOpen, packageName, pad2 } from './model.ts'
import type { AtlasCount, AtlasCounts, AtlasExpansion, AtlasNode, AtlasTree } from './model.ts'
import { SKIN_METRICS, busX, inAnchor, outAnchor } from './skins.ts'
import type { AtlasFontSpec, AtlasSkinId, SkinMetrics } from './skins.ts'

// ---- text -------------------------------------------------------------------------------------------------------

export interface AtlasText {
  width(text: string, font: AtlasFontSpec): number
  /** The longest prefix that fits `maxW`, with an ellipsis when something was cut. */
  clip(text: string, maxW: number, font: AtlasFontSpec): string
}

/** Wrap a raw width function: memoised widths, and `clip` (cached too). */
export function createAtlasText(rawWidth: (text: string, font: AtlasFontSpec) => number): AtlasText {
  const widthsByFont = new WeakMap<AtlasFontSpec, Map<string, number>>()
  const clipsByFont = new WeakMap<AtlasFontSpec, Map<string, Map<number, string>>>()
  const widthMap = (font: AtlasFontSpec): Map<string, number> => {
    let m = widthsByFont.get(font)
    if (!m) {
      m = new Map()
      widthsByFont.set(font, m)
    }
    return m
  }
  const width = (text: string, font: AtlasFontSpec): number => {
    const m = widthMap(font)
    let w = m.get(text)
    if (w === undefined) {
      w = rawWidth(text, font)
      m.set(text, w)
    }
    return w
  }
  return {
    width,
    clip(text, maxW, font) {
      let byText = clipsByFont.get(font)
      if (!byText) {
        byText = new Map()
        clipsByFont.set(font, byText)
      }
      let byMax = byText.get(text)
      if (!byMax) {
        byMax = new Map()
        byText.set(text, byMax)
      }
      const hit = byMax.get(maxW)
      if (hit !== undefined) return hit
      let t = text
      if (width(t, font) > maxW) {
        while (t.length > 1 && width(`${t}…`, font) > maxW) t = t.slice(0, -1)
        t = `${t}…`
      }
      byMax.set(maxW, t)
      return t
    },
  }
}

/** Width estimate without a canvas (server render and the first client render, so both produce the same markup). */
export function estimateTextWidth(text: string, font: AtlasFontSpec): number {
  let units = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    units += c < 0x250 ? (font.family === 'mono' ? 0.6 : 0.55) : 1
  }
  return units * font.size
}

/** The prototype's `clip`: cut a name to `em` em (full-width characters count 1, Latin ones 0.55). No measuring needed. */
export function clipEm(text: string, em: number): string {
  let out = ''
  let w = 0
  for (const ch of text) {
    w += (ch.codePointAt(0) ?? 0) < 0x100 ? 0.55 : 1
    if (w > em) return `${out}…`
    out += ch
  }
  return out
}

/** The words the layout needs from the interface language (they change widths). */
export interface AtlasLabels {
  /** Reader phase label for an automatic phase: "Lectures 4-7". */
  range(from: number, to: number): string
  /** Datasheet zone caption: "5 groups, 12/66 read". */
  caption(groups: number, read: number, total: number): string
  /** Datasheet trunk label next to the category: "66 lectures". */
  trunk(lectures: number): string
  uncategorised: string
}

// ---- result -----------------------------------------------------------------------------------------------------

export interface LaidNode {
  node: AtlasNode
  id: string
  kind: AtlasNode['kind']
  side: -1 | 0 | 1
  slot: number
  open: boolean
  /** Placed on the canvas (not hidden inside a collapsed branch). */
  vis: boolean
  read: number
  reading: number
  total: number
  /** Canvas units: label start towards the centre, the other end, the left edge, the width and the row centre line. */
  xi: number
  xo: number
  x0: number
  w: number
  y: number
  /** Top and height of the block (the node and everything open under it), canvas units. */
  top: number
  bh: number
  /** Furthest reach from the centre line of this node or anything open under it (centre-relative, unsigned). */
  ext: number
  // texts, by kind
  /** Category: its name. Group: its title (clipped). Phase: its label. Lecture: its name (clipped). */
  label: string
  labelW: number
  /** Group: the id (`G05`) and its width; lecture: the number text. */
  idText: string
  idW: number
  /** Group: `18/31` and its width; category (datasheet): the caption and its width. */
  prog: string
  progW: number
  pkg: string
  // datasheet centre pads and lanes
  padY: number
  lane: number
}

export interface AtlasLinkGeo {
  /** Id of the child (the link `parent>child`). */
  id: string
  parentId: string
  kind: 'cat' | 'group' | 'stage' | 'lec'
  side: -1 | 1
  slot: number
  x1: number
  y1: number
  x2: number
  y2: number
  bus: number
}

export interface AtlasLayout {
  skin: AtlasSkinId
  metrics: SkinMetrics
  /** Canvas size. */
  width: number
  height: number
  /** Canvas position of the centre of the centre box. */
  ox: number
  oy: number
  /** Column positions (centre-relative, unsigned): X[1] category ... X[4] lecture. */
  X: number[]
  /** Visible nodes in placement order: the centre first. */
  vis: LaidNode[]
  /** Every node (also those hidden in a collapsed branch) by id. */
  all: Map<string, LaidNode>
  links: AtlasLinkGeo[]
  center: { x: number; y: number; w: number; h: number; pads: Array<{ side: -1 | 1; y: number }> }
  /** Changes whenever the text of the svg changes (the label layer collects again). */
  key: string
}

export interface LayoutInput {
  tree: AtlasTree
  skin: AtlasSkinId
  text: AtlasText
  counts: AtlasCounts
  expansion: AtlasExpansion
  labels: AtlasLabels
}

const ZERO: AtlasCount = { read: 0, reading: 0 }

interface CachedLecMetrics {
  label: string
  idText: string
  labelW: number
  w: number
}
const lecCacheByText = new WeakMap<AtlasText, Record<AtlasSkinId, WeakMap<AtlasNode, CachedLecMetrics>>>()

function lecCacheFor(text: AtlasText, skin: AtlasSkinId): WeakMap<AtlasNode, CachedLecMetrics> {
  let bySkin = lecCacheByText.get(text)
  if (!bySkin) {
    bySkin = { reader: new WeakMap(), datasheet: new WeakMap() }
    lecCacheByText.set(text, bySkin)
  }
  return bySkin[skin]
}

export function layoutAtlas(input: LayoutInput): AtlasLayout {
  const { tree, skin, text, counts, expansion, labels } = input
  const M = SKIN_METRICS[skin]
  const ds = skin === 'datasheet'
  const lecCache = lecCacheFor(text, skin)
  const all = new Map<string, LaidNode>()
  const W = [0, 0, 0, 0, 0]

  const open = (n: AtlasNode): boolean => isNodeOpen(n, counts, expansion)

  // widths of every node, open or not
  const make = (n: AtlasNode): LaidNode => {
    const c = counts.get(n.id) ?? ZERO
    const L: LaidNode = {
      node: n, id: n.id, kind: n.kind, side: n.side, slot: n.slot, open: false, vis: false,
      read: c.read, reading: c.reading, total: n.lec.length,
      xi: 0, xo: 0, x0: 0, w: 0, y: 0, top: 0, bh: 0, ext: 0,
      label: '', labelW: 0, idText: '', idW: 0, prog: '', progW: 0, pkg: '', padY: 0, lane: 0,
    }
    all.set(n.id, L)
    if (n.kind === 'cat') {
      L.label = n.name || labels.uncategorised
      L.labelW = text.width(L.label, M.fonts.cat)
      if (ds) {
        L.prog = labels.caption(n.kids.length, c.read, n.lec.length)
        L.progW = text.width(L.prog, M.fonts.catCaption)
        L.w = 24
      } else L.w = L.labelW + 8
    } else if (n.kind === 'group') {
      L.pkg = packageName(n.lec.length)
      L.prog = `${c.read}/${n.lec.length}`
      L.idText = n.id
      L.idW = text.width(n.id, M.fonts.groupId)
      if (!ds) {
        L.label = text.clip(n.name, 210, M.fonts.groupTitle)
        L.labelW = text.width(L.label, M.fonts.groupTitle)
        L.progW = text.width(L.prog, M.fonts.groupProg)
        L.w = L.idW + 8 + L.labelW + 10 + L.progW
      } else {
        L.label = text.clip(n.name, M.chipW - 38 - L.idW, M.fonts.groupTitle)
        L.labelW = text.width(L.label, M.fonts.groupTitle)
        L.progW = text.width(L.prog, M.fonts.groupProg)
        L.w = M.chipW
      }
    } else if (n.kind === 'stage') {
      const first = n.lec[0]
      const last = n.lec[n.lec.length - 1]
      if (!ds) {
        const auto = /^\d+\s*[–-]\s*\d+$/.test(n.name) || n.name === ''
        L.label = auto && first && last ? labels.range(first.n, last.n) : n.name
      } else {
        const letter = String.fromCharCode(65 + (n.idx % 26))
        L.label = n.lec.length > 1 ? `P${letter}0–${n.lec.length - 1}` : `P${letter}0`
      }
      L.labelW = text.width(L.label, M.fonts.stage)
      L.w = L.labelW
    } else if (n.kind === 'lec') {
      let cached = lecCache.get(n)
      if (!cached) {
        const label = clipEm(n.name, 17)
        const idText = pad2(n.lecture?.n ?? 0)
        const labelW = text.width(label, M.fonts.lec)
        cached = { label, idText, labelW, w: M.lecX + labelW }
        lecCache.set(n, cached)
      }
      L.label = cached.label
      L.idText = cached.idText
      L.labelW = cached.labelW
      L.w = cached.w
    }
    if (n.depth >= 1 && n.depth <= 3) W[n.depth] = Math.max(W[n.depth] as number, L.w)
    n.kids.forEach(make)
    return L
  }
  const R = make(tree.root)

  const X = [0, M.rootW / 2 + M.c1]
  X[2] = (X[1] as number) + (W[1] as number) + M.c2
  X[3] = (X[2] as number) + (W[2] as number) + M.tog + M.c3
  X[4] = (X[3] as number) + (W[3] as number) + M.tog + M.c4

  const ownH = (n: AtlasNode): number => (n.kind === 'lec' ? M.lec : n.kind === 'stage' ? M.stage : n.kind === 'group' ? M.group : 0)
  const gapIn = (n: AtlasNode): number => (n.kind === 'root' ? M.gCat : n.kind === 'cat' ? M.gGroup : n.kids[0]?.kind === 'stage' ? M.gStage : 0)

  const block = new Map<string, number>()
  const measure = (n: AtlasNode): number => {
    let h: number
    if (!open(n)) h = ownH(n)
    else {
      let t = 0
      const g = gapIn(n)
      n.kids.forEach((k, i) => {
        t += measure(k) + (i ? g : 0)
      })
      h = Math.max(ownH(n), t)
    }
    block.set(n.id, h)
    return h
  }

  const vis: LaidNode[] = [R]
  R.open = true
  R.vis = true
  const place = (n: AtlasNode, top: number): void => {
    const L = all.get(n.id) as LaidNode
    vis.push(L)
    L.vis = true
    L.top = top
    L.bh = block.get(n.id) as number
    L.xi = n.side * (X[n.depth] as number)
    L.xo = L.xi + n.side * L.w
    L.x0 = Math.min(L.xi, L.xo)
    L.open = open(n)
    if (!L.open) {
      L.y = top + L.bh / 2
      return
    }
    let t = 0
    const g = gapIn(n)
    n.kids.forEach((k, i) => {
      t += (block.get(k.id) as number) + (i ? g : 0)
    })
    let y = top + (L.bh - t) / 2
    n.kids.forEach((k) => {
      place(k, y)
      y += (block.get(k.id) as number) + g
    })
    const first = all.get((n.kids[0] as AtlasNode).id) as LaidNode
    const last = all.get((n.kids[n.kids.length - 1] as AtlasNode).id) as LaidNode
    L.y = (first.y + last.y) / 2
  }
  for (const side of [-1, 1] as const) {
    const list = tree.root.kids.filter((c) => c.side === side)
    let t = 0
    list.forEach((c, i) => {
      t += measure(c) + (i ? M.gCat : 0)
    })
    let y = -t / 2
    list.forEach((c) => {
      place(c, y)
      y += (block.get(c.id) as number) + M.gCat
    })
  }

  // how far each visible row reaches from the centre line; every ancestor learns the furthest reach below it
  let x0 = -M.rootW / 2
  let x1 = M.rootW / 2
  let y0 = -M.rootH / 2
  let y1 = M.rootH / 2
  for (const L of vis) {
    if (L.kind === 'root') continue
    let far = Math.abs(L.xo) + (L.kind === 'group' || L.kind === 'stage' ? M.tog : 0)
    if (L.kind === 'group' && !L.open) far = (X[3] as number) + L.total * M.tick + 4
    if (L.kind === 'stage' && !L.open) far = (X[4] as number) + L.total * M.tick + 4
    for (let p: AtlasNode | null = L.node; p && p.kind !== 'root'; p = p.parent) {
      const P = all.get(p.id) as LaidNode
      P.ext = Math.max(P.ext, far)
    }
    if (L.side < 0) x0 = Math.min(x0, -far)
    else x1 = Math.max(x1, far)
    y0 = Math.min(y0, L.top)
    y1 = Math.max(y1, L.top + L.bh)
  }
  const mg = 80
  const ox = mg - x0
  const oy = mg - y0
  const width = Math.ceil(x1 - x0 + 2 * mg)
  const height = Math.ceil(y1 - y0 + 2 * mg)

  // datasheet centre: one pad per category on its side; the trace of a category turning up takes an inner lane the higher its
  // lead, one turning down the lower its lead, so no two cross
  const pads: Array<{ side: -1 | 1; y: number }> = []
  if (ds) {
    for (const side of [-1, 1] as const) {
      const cs = tree.root.kids.filter((c) => c.side === side).map((c) => all.get(c.id) as LaidNode)
      const k = cs.length
      cs.forEach((c, i) => {
        c.padY = (i - (k - 1) / 2) * 22
        pads.push({ side, y: c.padY + oy })
      })
      const up = cs.filter((c) => c.y < c.padY)
      const dn = cs.filter((c) => c.y >= c.padY).reverse()
      up.forEach((c, i) => {
        c.lane = i
      })
      dn.forEach((c, i) => {
        c.lane = i
      })
    }
  }

  // links, canvas units
  const anchors = { catX: X[1] as number, rootW: M.rootW }
  const links: AtlasLinkGeo[] = []
  for (const L of vis) {
    if (L.kind === 'root') continue
    const parent = all.get((L.node.parent as AtlasNode).id) as LaidNode
    const a = outAnchor(skin, parent, { side: L.side, padY: L.padY }, anchors)
    const b = inAnchor(skin, L, anchors)
    links.push({
      id: L.id,
      parentId: parent.id,
      kind: L.kind as AtlasLinkGeo['kind'],
      side: L.side as -1 | 1,
      slot: L.slot,
      x1: round1(a[0] + ox),
      y1: round1(a[1] + oy),
      x2: round1(b[0] + ox),
      y2: round1(b[1] + oy),
      bus: round1(busX(skin, L, parent.kind, a[0], L.lane, M.rootW) + ox),
    })
  }

  // canvas coordinates
  for (const L of all.values()) {
    L.xi = round1(L.xi + ox)
    L.xo = round1(L.xo + ox)
    L.x0 = round1(L.x0 + ox)
    L.y = round1(L.y + oy)
    L.top = round1(L.top + oy)
  }
  R.xi = R.xo = R.x0 = ox
  R.y = oy

  // the key changes whenever a label moves: the stage re-collects the canvas labels (and an untouched map refits) on a new key only.
  // The x positions are part of it because measured text widths (a font slice that arrives late) can move labels sideways while
  // the size and the rows stay the same; without them the label layer kept painting the old positions.
  const key = `${skin}|${width}x${height}|${ox}|${vis.length}|${vis.map((n) => `${n.id}:${n.label}:${n.prog}:${n.y}:${n.x0}:${n.xi}:${n.xo}`).join(',')}`
  return {
    skin, metrics: M, width, height, ox, oy, X, vis, all, links,
    center: { x: round1(ox - M.rootW / 2), y: round1(oy - M.rootH / 2), w: M.rootW, h: M.rootH, pads },
    key: hash(key),
  }
}

const round1 = (v: number): number => Math.round(v * 10) / 10

/** A short fingerprint (FNV-1a) so that `key` stays small. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** The box of a node and everything open under it (canvas units; prototype `blockBox`). */
export function blockBox(L: LaidNode, ox: number): { x: number; y: number; w: number; h: number } {
  const inner = Math.abs(L.xi - ox) - 12
  const outer = L.ext + 8
  const left = L.side > 0 ? inner : -outer
  const right = L.side > 0 ? outer : -inner
  return { x: round1(left + ox), y: L.top - 8, w: right - left, h: L.bh + 16 }
}

/** Where on screen a node's row starts (prototype `screenOf`), for keeping it in place while the layout changes. */
export function screenOfNode(L: LaidNode, view: { k: number; x: number; y: number }): [number, number] {
  return [view.x + L.xi * view.k, view.y + L.y * view.k]
}
