/**
 * map/geometry.ts - the pure math of the map viewport (P4a WP-H1, docs-dev/MAP.md), ported from the
 * home-canvas prototype v17 (`clamp` / `zoomAt` / `fit` / `panTo` / `zoomToBox` /
 * `ladder`) with the same parameters. No DOM, no Vue: everything here is unit-tested (tests/unit/map-geometry.test.ts).
 *
 * A view is a `Transform` `{ k, x, y }`: canvas point (cx, cy) is drawn at screen point (x + cx * k, y + cy * k),
 * measured from the top-left of the stage. The content is `width x height` canvas units.
 */

export interface Transform {
  k: number
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** A box in canvas units. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Screen pixels the HUD takes at each edge of the stage; `zoomToBox` keeps the box clear of them. */
export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
}

/** Zoom limits (prototype `zoomAt`, `wheel`, `zoomToBox`). */
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = 2.5
/** The content keeps at least this many screen pixels inside the stage when panning (prototype `clamp`). */
export const KEEP_PX = 80
/** Distance of a key press on an arrow key, in screen pixels. */
export const PAN_STEP = 80
/** Zoom factor of the + / - buttons and of the + / - keys. */
export const BUTTON_ZOOM = 1.4
export const KEY_ZOOM = 1.25
/** Wheel: factor = exp(-deltaY * WHEEL_SENSITIVITY). */
export const WHEEL_SENSITIVITY = 0.0015
/** Top row of the HUD (search, legend): `fit` leaves it free. */
export const HUD_TOP = 56
/** Bottom row of the HUD: `zoomToBox` leaves it free. */
export const HUD_BOTTOM = 48
/** `fit` fills this much of the free area. */
export const FIT_FILL = 0.96
/** Duration of the animated `panTo` and `zoomToBox`, in ms. */
export const PAN_MS = 320
export const ZOOM_BOX_MS = 380
/** A `panTo` never zooms out below this scale (it zooms in to it when the view is further out). */
export const PAN_MIN_ZOOM = 0.7
/** The wheel settles (redraws once, exact sizes) this long after the last wheel event, in ms. */
export const WHEEL_SETTLE_MS = 140

export const clampZoom = (k: number, min: number = MIN_ZOOM, max: number = MAX_ZOOM): number => Math.max(min, Math.min(max, k))

// ---- the label-size ladder ----------------------------------------------------------------------------------------

/** Steps per octave of the ladder: scales are 2^(n/4). */
export const LADDER_STEPS = 4

/** Nearest ladder scale: `2^(round(log2(k) * 4) / 4)`. Used only for animated zooms (labels reuse a few glyph sizes). */
export function ladder(k: number): number {
  return Math.pow(2, Math.round(Math.log2(k) * LADDER_STEPS) / LADDER_STEPS)
}

/** Largest ladder scale not above `k` (a box that has to fit is never rounded up past its fitting scale). */
export function ladderDown(k: number): number {
  return Math.pow(2, Math.floor(Math.log2(k) * LADDER_STEPS + 1e-9) / LADDER_STEPS)
}

// ---- transforms -------------------------------------------------------------------------------------------------

/**
 * Keep the content reachable: at least `keep` px of it stay inside the stage on every side
 * (`x` in `[keep - w*k, view.width - keep]`, same for `y`). The scale is not touched.
 */
export function clampTransform(t: Transform, content: Size, view: Size, keep: number = KEEP_PX): Transform {
  const w = content.width * t.k
  const h = content.height * t.k
  return {
    k: t.k,
    x: Math.min(view.width - keep, Math.max(keep - w, t.x)),
    y: Math.min(view.height - keep, Math.max(keep - h, t.y)),
  }
}

/** Zoom by `factor` about the screen point (cx, cy): that point stays where it is. The result scale is clamped to the zoom limits. */
export function zoomAbout(t: Transform, factor: number, cx: number, cy: number, min: number = MIN_ZOOM, max: number = MAX_ZOOM): Transform {
  const k = clampZoom(t.k * factor, min, max)
  const r = k / t.k
  return { k, x: cx - (cx - t.x) * r, y: cy - (cy - t.y) * r }
}

/** The view that shows the whole content, centred below the HUD row (prototype `fit`). */
export function fitTransform(content: Size, view: Size, top: number = HUD_TOP, fill: number = FIT_FILL): Transform {
  const k = Math.min(view.width / content.width, (view.height - top) / content.height) * fill
  return { k, x: (view.width - content.width * k) / 2, y: top + (view.height - top - content.height * k) / 2 }
}

/** The view that has the canvas point (cx, cy) in the middle of the stage at scale `k`. */
export function centerOn(cx: number, cy: number, view: Size, k: number): Transform {
  return { k, x: view.width / 2 - cx * k, y: view.height / 2 - cy * k }
}

/** Target of `panTo`: centre (cx, cy) at `ladder(max(current scale, 0.7))` (prototype `panTo`). */
export function panToTarget(current: Transform, cx: number, cy: number, view: Size): Transform {
  return centerOn(cx, cy, view, ladder(Math.max(current.k, PAN_MIN_ZOOM)))
}

export const DEFAULT_INSETS: Readonly<Insets> = { top: HUD_TOP, bottom: HUD_BOTTOM, left: 16, right: 16 }

/** Padding around the box, in screen pixels, in `boxTransform`. */
export const BOX_PAD = 24

/**
 * The view that shows a whole canvas box inside the stage, clear of the HUD `insets`, centred in the free area
 * (prototype `zoomToBox`). The scale is the biggest ladder scale that still fits, within the zoom limits.
 */
export function boxTransform(box: Box, view: Size, insets: Insets = DEFAULT_INSETS, pad: number = BOX_PAD): Transform {
  const aw = view.width - insets.left - insets.right
  const ah = view.height - insets.top - insets.bottom
  const k = ladderDown(clampZoom(Math.min(aw / (box.w + 2 * pad), ah / (box.h + 2 * pad))))
  return { k, x: insets.left + (aw - box.w * k) / 2 - box.x * k, y: insets.top + (ah - box.h * k) / 2 - box.y * k }
}

/** Linear blend of two views (animation frame at eased progress `e` in 0..1). */
export function lerpTransform(a: Transform, b: Transform, e: number): Transform {
  return { k: a.k + (b.k - a.k) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e }
}

/** Ease-out cubic, as the prototype's animations. */
export const easeOutCubic = (u: number): number => 1 - Math.pow(1 - u, 3)

/** The CSS `transform` the svg element carries for a view. */
export function cssTransform(t: Transform): string {
  return `translate(${t.x}px,${t.y}px) scale(${t.k})`
}

export const sameTransform = (a: Transform, b: Transform): boolean => a.k === b.k && a.x === b.x && a.y === b.y

// ---- input rules ------------------------------------------------------------------------------------------------

/** Wheel zoom factor for a wheel delta. */
export const wheelFactor = (deltaY: number): number => Math.exp(-deltaY * WHEEL_SENSITIVITY)

/** The wheel zooms the map only after a click on it (`active`) or with Ctrl / Cmd held; otherwise the page scrolls. */
export function wheelZooms(state: { active: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return state.active || state.ctrlKey || state.metaKey
}

export type KeyAction =
  | { type: 'zoom'; factor: number }
  | { type: 'pan'; dx: number; dy: number }
  | { type: 'escape' }

/** What a key does on the map: + / = zoom in, - zoom out, arrows pan by 80 px, Esc leaves the active state. Anything else: null. */
export function keyAction(key: string): KeyAction | null {
  switch (key) {
    case 'Escape':
      return { type: 'escape' }
    case '+':
    case '=':
      return { type: 'zoom', factor: KEY_ZOOM }
    case '-':
      return { type: 'zoom', factor: 1 / KEY_ZOOM }
    case 'ArrowLeft':
      return { type: 'pan', dx: PAN_STEP, dy: 0 }
    case 'ArrowRight':
      return { type: 'pan', dx: -PAN_STEP, dy: 0 }
    case 'ArrowUp':
      return { type: 'pan', dx: 0, dy: PAN_STEP }
    case 'ArrowDown':
      return { type: 'pan', dx: 0, dy: -PAN_STEP }
    default:
      return null
  }
}

/** Pointer travel (px) after which a press becomes a drag. */
export const DRAG_THRESHOLD = 4
export const isDrag = (dx: number, dy: number): boolean => Math.hypot(dx, dy) > DRAG_THRESHOLD

/** Info panel and wheel hint: the panel is not shown on stages narrower than this (CSS pixels of the window). */
export const INFO_MIN_WIDTH = 700
