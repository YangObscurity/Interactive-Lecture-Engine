/**
 * map/atlas/skins.ts - the geometry a skin reserves for its atlas components (P4a WP-H2; prototype v16 `AMET` and `AS.*.inA/outA/link`).
 *
 * Both skins share the tree and the layout; what differs is the size of the rows and where a link leaves a parent and
 * enters a child, because the components draw different shapes there (a toggle button, a chip's pad). The components
 * of the same skin draw inside exactly these boxes (docs-dev/SLOTS.md, atlas slots).
 *
 * The skin of the current theme is the implementation of the `AtlasCenter` slot: `datasheet` for the datasheet theme's
 * components, `reader` for the engine default components and for any other implementation.
 *
 * Pure, centre-relative coordinates (x to the right of the centre line, y down from the middle of the centre); the layout
 * adds the offset of the canvas.
 */
import type { AtlasKind, AtlasNode } from './model.ts'

export type AtlasSkinId = 'reader' | 'datasheet'

/** Fonts the layout measures; the components' CSS classes use the same families, sizes and weights. */
export interface AtlasFontSpec {
  size: number
  weight: number
  /** `--lec-font-body`, `--lec-font-heading` or `--lec-font-mono`. */
  family: 'body' | 'heading' | 'mono'
}

export interface SkinMetrics {
  id: AtlasSkinId
  /** Row heights of a lecture, a phase and a group. */
  lec: number
  stage: number
  group: number
  /** Gaps between categories, between groups of a category, between phases of a group. */
  gCat: number
  gGroup: number
  gStage: number
  /** The centre box. */
  rootW: number
  rootH: number
  /** Gaps between the columns centre | category | group | phase | lecture. */
  c1: number
  c2: number
  c3: number
  c4: number
  /** Width reserved for a +/- button. */
  tog: number
  /** Status strip: distance between two marks and width of a mark. */
  tick: number
  tw: number
  /** Where a lecture's name starts, measured from the column. */
  lecX: number
  /** Size of the lecture name (the layout measures with it). */
  lecFont: number
  /** Group chip width (datasheet: the chip has a fixed width). */
  chipW: number
  fonts: {
    /** The site name in the centre box. */
    center: AtlasFontSpec
    cat: AtlasFontSpec
    /** Datasheet: the caption of the zone box. */
    catCaption: AtlasFontSpec
    groupId: AtlasFontSpec
    groupTitle: AtlasFontSpec
    groupProg: AtlasFontSpec
    stage: AtlasFontSpec
    lec: AtlasFontSpec
  }
}

export const SKIN_METRICS: Readonly<Record<AtlasSkinId, SkinMetrics>> = {
  reader: {
    id: 'reader', lec: 20, stage: 21, group: 30, gCat: 34, gGroup: 8, gStage: 2, rootW: 232, rootH: 92,
    c1: 96, c2: 46, c3: 40, c4: 30, tog: 22, tick: 5, tw: 3, lecX: 36, lecFont: 13, chipW: 0,
    fonts: {
      center: { size: 24, weight: 800, family: 'heading' },
      cat: { size: 17, weight: 800, family: 'heading' },
      catCaption: { size: 11, weight: 400, family: 'mono' },
      groupId: { size: 15, weight: 800, family: 'heading' },
      groupTitle: { size: 14, weight: 500, family: 'body' },
      groupProg: { size: 11.5, weight: 400, family: 'mono' },
      stage: { size: 12.5, weight: 500, family: 'body' },
      lec: { size: 13, weight: 400, family: 'body' },
    },
  },
  datasheet: {
    id: 'datasheet', lec: 19, stage: 21, group: 46, gCat: 58, gGroup: 6, gStage: 4, rootW: 284, rootH: 136,
    c1: 118, c2: 34, c3: 40, c4: 34, tog: 20, tick: 6, tw: 4, lecX: 44, lecFont: 12.5, chipW: 236,
    fonts: {
      center: { size: 28, weight: 900, family: 'heading' },
      cat: { size: 15, weight: 700, family: 'heading' },
      catCaption: { size: 11, weight: 400, family: 'mono' },
      groupId: { size: 15, weight: 900, family: 'heading' },
      groupTitle: { size: 12.5, weight: 500, family: 'body' },
      groupProg: { size: 10.5, weight: 400, family: 'mono' },
      stage: { size: 11.5, weight: 400, family: 'mono' },
      lec: { size: 12.5, weight: 400, family: 'body' },
    },
  },
}

/** The skin for the implementation id `data-slot-impl` reports (`datasheet`, `default`, a pack id ...). */
export function skinOfImpl(impl: string | null | undefined): AtlasSkinId {
  return impl === 'datasheet' ? 'datasheet' : 'reader'
}

type Point = readonly [number, number]

export interface AtlasAnchorInput {
  /** The column x of the category (`X[1]`). */
  catX: number
  rootW: number
}

const isStage = (k: AtlasKind): boolean => k === 'stage'

/** Where a link enters a node (centre-relative). */
export function inAnchor(skin: AtlasSkinId, x: { kind: AtlasKind; side: -1 | 0 | 1; xi: number; y: number }, g: AtlasAnchorInput): Point {
  if (skin === 'reader') return x.kind === 'lec' ? [x.xi, x.y] : [x.xi, x.y + (isStage(x.kind) ? 8 : 10)]
  if (x.kind === 'cat') return [x.side * (g.catX - 12), x.y]
  if (x.kind === 'group') return [x.xi - x.side * 7, x.y]
  if (x.kind === 'stage') return [x.xi - x.side * 5, x.y]
  return [x.xi, x.y]
}

/** Where a link leaves `parent` towards `child` (centre-relative). `padY` is the datasheet centre's pad of that category. */
export function outAnchor(
  skin: AtlasSkinId,
  parent: { kind: AtlasKind; side: -1 | 0 | 1; xo: number; y: number },
  child: { side: -1 | 0 | 1; padY: number },
  g: AtlasAnchorInput,
): Point {
  if (skin === 'reader') {
    if (parent.kind === 'root') return [child.side * (g.rootW / 2), 0]
    if (parent.kind === 'cat') return [parent.xo, parent.y + 10]
    return [parent.xo + parent.side * (parent.kind === 'group' ? 17.5 : 14.5), parent.y + (isStage(parent.kind) ? 8 : 10)]
  }
  if (parent.kind === 'root') return [child.side * (g.rootW / 2 + 10), child.padY]
  if (parent.kind === 'cat') return [parent.side * (g.catX - 12), parent.y]
  return [parent.xo + parent.side * (parent.kind === 'group' ? 17 : 16), parent.y]
}

/** Datasheet: x of the vertical segment of a right-angle trace (the bus). The reader's curves do not use it. */
export function busX(skin: AtlasSkinId, node: Pick<AtlasNode, 'kind' | 'side'>, parentKind: AtlasKind, fromX: number, lane: number, rootW: number): number {
  if (skin === 'reader') return fromX
  return parentKind === 'root' ? node.side * (rootW / 2 + 22 + lane * 9) : fromX + node.side * 12
}
