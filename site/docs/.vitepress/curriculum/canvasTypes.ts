/**
 * curriculum/canvasTypes.ts - pure types, geometry constants and validators of the pre-computed dependency canvas
 * layouts (P4b, docs-dev/MAP.md; constants from the home-canvas prototype).
 *
 * Pure TypeScript: no Node, no Vue, no ELK, no libavoid. Contains geometry and ids only (never localized titles),
 * so the build output is locale-independent and restricted groups can be stripped cleanly from inline chunks.
 */

export const CANVAS_READER_DIM = {
  NW: 184,
  NH: 32,
  HEAD: 52,
  PAD: 44,
  PADB: 70,
  GX: 48,
  GY: 66,
  BOUNDK: 0.95,
  BMAX: 16,
  GROUPGAP: 90,
  VIEW: [1440, 640] as const,
} as const

export const CANVAS_DS_DIM = {
  PIT: 26,
  OFF: 26,
  LEG: 18,
  NAME: 196,
  NUMGAP: 8,
  BODYW: 168,
  BUSLEAD: 16,
  ZHEAD: 56,
  ZPAD: 80,
  BUSPITCH: 12,
  MAXSIDE: 20,
  UNITGAP: 70,
  GAP: 150,
} as const

export const CANVAS_DS_SIDE = CANVAS_DS_DIM.LEG + CANVAS_DS_DIM.NUMGAP + CANVAS_DS_DIM.NAME

export type CanvasDatasheetMode = 'compact' | 'zones'

export interface CanvasWorkerLectureInput {
  id: string
  n: number
}

export interface CanvasWorkerGroupInput {
  id: string
  dir: string
  catSlot: number
  map?: false
  lectures: CanvasWorkerLectureInput[]
}

export interface CanvasWorkerInput {
  groups: CanvasWorkerGroupInput[]
  edges: Array<readonly [string, string]>
  offMapIds?: readonly string[]
}

export interface CanvasReaderNodePos {
  id: string
  x: number
  y: number
}

export interface CanvasReaderEdgeRoute {
  s: string
  t: string
  pts: Array<[number, number]>
  d: string
}

export interface CanvasReaderGroupLayout {
  id: string
  dir: string
  cat: number
  rank: number
  x: number
  y: number
  w: number
  h: number
  cols: number
  rows: number
  gapScale: number
  nodes: CanvasReaderNodePos[]
  edges: CanvasReaderEdgeRoute[]
}

export interface CanvasBundleEdge {
  a: string
  b: string
  n: number
}

export interface CanvasReaderBoard {
  W: number
  H: number
  NW: number
  NH: number
  HEAD: number
  groups: CanvasReaderGroupLayout[]
  bundles: CanvasBundleEdge[]
  /** [fromLectureId, toLectureId, isInTransitiveReduction (0 | 1)]. */
  edges: Array<[string, string, 0 | 1]>
  offMap: string[]
}

export interface CanvasDsPort {
  id: string
  x: number
  y: number
}

export interface CanvasDsUnit {
  g: string
  part: string
  of: number
  lec: string[]
  per: number
  total: number
  bw: number
  bh: number
  w: number
  h: number
  x: number
  y: number
  nx: number
  ny: number
  ports: CanvasDsPort[]
}

export interface CanvasDsZone {
  cat: number
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasDsBus {
  ua: string
  ub: string
  ga: string
  gb: string
  n: number
  pts: Array<[number, number]>
}

export interface CanvasDatasheetBoard {
  MODE: CanvasDatasheetMode
  SIDE: number
  W: number
  H: number
  zones: CanvasDsZone[]
  units: Record<string, CanvasDsUnit>
  buses: CanvasDsBus[]
  endErr: number
}

export interface CanvasBundle {
  version: 1
  reader: CanvasReaderBoard
  datasheet: {
    compact: CanvasDatasheetBoard
    zones: CanvasDatasheetBoard
  }
}

/** Per-tier canvas file `/_access/<tier>/canvas.json`. Zero cross-tier leakage: `boardWithInline` covers `inline + T` only; `tierOwn` covers `T` groups only. */
export interface CanvasTierSlice {
  version: 1
  tier: string
  /** Exact ELK + libavoid layout of `inline + this tier` (used when this is the sole readable restricted tier). */
  boardWithInline: CanvasBundle
  /** Per-group layouts belonging solely to this tier (composed client-side when >= 2 restricted tiers are readable). */
  tierOwn: CanvasBundle
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function isCanvasBundle(v: unknown): v is CanvasBundle {
  if (!isRec(v) || v.version !== 1) return false
  const r = v.reader
  const d = v.datasheet
  if (!isRec(r) || typeof r.W !== 'number' || typeof r.H !== 'number' || !Array.isArray(r.groups) || !Array.isArray(r.bundles) || !Array.isArray(r.edges) || !Array.isArray(r.offMap)) return false
  if (!isRec(d) || !isDsBoard(d.compact) || !isDsBoard(d.zones)) return false
  return true
}

function isDsBoard(v: unknown): v is CanvasDatasheetBoard {
  return isRec(v) && typeof v.W === 'number' && typeof v.H === 'number' && isRec(v.units) && Array.isArray(v.zones) && Array.isArray(v.buses)
}

export function isCanvasTierSlice(v: unknown): v is CanvasTierSlice {
  return isRec(v) && v.version === 1 && typeof v.tier === 'string' && isCanvasBundle(v.boardWithInline) && isCanvasBundle(v.tierOwn)
}

export function emptyCanvasBundle(offMap: string[] = []): CanvasBundle {
  return {
    version: 1,
    reader: { W: 640, H: 360, NW: CANVAS_READER_DIM.NW, NH: CANVAS_READER_DIM.NH, HEAD: CANVAS_READER_DIM.HEAD, groups: [], bundles: [], edges: [], offMap },
    datasheet: {
      compact: { MODE: 'compact', SIDE: CANVAS_DS_SIDE, W: 640, H: 360, zones: [], units: {}, buses: [], endErr: 0 },
      zones: { MODE: 'zones', SIDE: CANVAS_DS_SIDE, W: 640, H: 360, zones: [], units: {}, buses: [], endErr: 0 },
    },
  }
}
