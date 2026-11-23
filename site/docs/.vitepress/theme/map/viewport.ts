/**
 * map/viewport.ts - the pan / zoom state machine of the map (P4a WP-H1, prototype v17 "pan & zoom").
 * DOM only, no Vue (`useMapViewport` wraps it); the math is in geometry.ts. Tested with happy-dom:
 * tests/unit/map-viewport.test.ts.
 *
 * The view is a CSS `transform` on the `<svg>` element itself: no SVG relayout, shapes and lines are redrawn at the
 * true scale. While the view moves the svg carries the class `lec-moving`; `commit()` ends a movement: it redraws once
 * at the settled view, sets `--k` on the svg (for CSS that wants the scale) and clears the class.
 *
 *   drag                   moves the view live and commits on release; a press that does not move activates the map
 *   wheel                  zooms about the pointer, only when the map is active or Ctrl / Cmd is held; settles 140 ms
 *                          after the last event; never snaps label sizes
 *   + / - / arrows / Esc   keys while the stage has focus (not while typing in an input)
 *   fit / zoomTo / panTo   instant, or animated (ease-out cubic) unless `prefers-reduced-motion: reduce`; an animation
 *                          lands on a ladder scale and snaps the label sizes to the ladder while it runs
 *
 * Observers (`on`): `place` after every placement (labels redraw), `commit` when a movement ends, `state` when
 * `active` / `moved` / `dragging` / moving change, `resize` before a window resize is handled.
 */
import {
  DEFAULT_INSETS,
  PAN_MS,
  WHEEL_SETTLE_MS,
  ZOOM_BOX_MS,
  boxTransform,
  clampTransform,
  cssTransform,
  easeOutCubic,
  fitTransform,
  isDrag,
  keyAction,
  lerpTransform,
  panToTarget,
  wheelFactor,
  wheelZooms,
  zoomAbout,
} from './geometry'
import type { Box, Insets, Size, Transform } from './geometry'
import { MOVING_CLASS } from './labels'
import type { LabelView } from './labels'

export interface MapViewportOptions {
  stage: HTMLElement
  svg: SVGSVGElement
  /** Size of the content in canvas units; read whenever the view is clamped or fitted. */
  content: () => Size
  /** Screen pixels the HUD takes (the info panel side counts when `panelOpen`). Default: top 56, bottom 48, 16 at the sides. */
  insets?: (panelOpen: boolean) => Insets
  /** Default: the media query `prefers-reduced-motion: reduce`, read at the start of every animation. */
  reducedMotion?: () => boolean
  /** Selector of the HUD and panels over the stage: a press or wheel on them is not the map's. */
  ignore?: string
  /** Esc: return true when something else took it (a locked selection was cleared); false leaves the active state and blurs the stage. */
  onEscape?: () => boolean
  /** Test seams. */
  now?: () => number
  requestFrame?: (cb: (t: number) => void) => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export type MapViewportEvent = 'place' | 'commit' | 'state' | 'resize'

export const STAGE_ACTIVE_CLASS = 'lec-map--active'
export const STAGE_MOVED_CLASS = 'lec-map--moved'
export const STAGE_DRAGGING_CLASS = 'lec-map--dragging'

const isTypingTarget = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  if (!el || !el.tagName) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true
}

export class MapViewport {
  private readonly stage: HTMLElement
  private readonly svg: SVGSVGElement
  private readonly opts: MapViewportOptions
  private T: Transform = { k: 1, x: 0, y: 0 }
  private lastK = NaN
  private zoomAnchor: number | null = null
  private animId = 0
  private moving = false
  private isActive = false
  private everTouched = false
  private dragged = false
  private press: { x: number; y: number; tx: number; ty: number } | null = null
  private wheelTimer: unknown = null
  private stageSize: Size | null = null
  private ro: ResizeObserver | null = null
  private readonly abort = new AbortController()
  private readonly listeners: Record<MapViewportEvent, Set<() => void>> = { place: new Set(), commit: new Set(), state: new Set(), resize: new Set() }
  private readonly placeListeners = new Set<(view: LabelView) => void>()
  private readonly commitListeners = new Set<(t: Transform) => void>()

  constructor(opts: MapViewportOptions) {
    this.opts = opts
    this.stage = opts.stage
    this.svg = opts.svg
    this.bind()
  }

  // ---- state ---------------------------------------------------------------------------------------------------

  /** The current view (a copy). */
  get view(): Transform {
    return { ...this.T }
  }
  get active(): boolean {
    return this.isActive
  }
  /** True once the reader has dragged, zoomed or jumped (the "click the map to zoom" hint goes away). */
  get touched(): boolean {
    return this.everTouched
  }
  /** True while a drag has moved the view, and just after (until the click that ends the press has been handled): clicks should be ignored. */
  get wasDragged(): boolean {
    return this.dragged
  }
  get isMoving(): boolean {
    return this.moving
  }

  /** Subscribe to `place` (a view for the label layer), `commit` or `state` / `resize` (no argument). Returns the unsubscribe function. */
  on(event: 'place', fn: (view: LabelView) => void): () => void
  on(event: 'commit', fn: (t: Transform) => void): () => void
  on(event: 'state' | 'resize', fn: () => void): () => void
  on(event: MapViewportEvent, fn: ((view: LabelView) => void) | ((t: Transform) => void) | (() => void)): () => void {
    if (event === 'place') {
      this.placeListeners.add(fn as (view: LabelView) => void)
      return () => void this.placeListeners.delete(fn as (view: LabelView) => void)
    }
    if (event === 'commit') {
      this.commitListeners.add(fn as (t: Transform) => void)
      return () => void this.commitListeners.delete(fn as (t: Transform) => void)
    }
    this.listeners[event].add(fn as () => void)
    return () => void this.listeners[event].delete(fn as () => void)
  }

  private emit(event: 'state' | 'resize'): void {
    for (const fn of [...this.listeners[event]]) fn()
  }

  // ---- placement -----------------------------------------------------------------------------------------------

  private size(): Size {
    if (this.stageSize) return this.stageSize
    const r = this.stage.getBoundingClientRect()
    const s = { width: r.width, height: r.height }
    if (s.width > 0 && s.height > 0 && this.ro) this.stageSize = s
    return s
  }

  private insets(panelOpen = false): Insets {
    return (this.opts.insets ?? (() => DEFAULT_INSETS))(panelOpen)
  }

  private clamp(stageSize: Size = this.size()): void {
    this.T = clampTransform(this.T, this.opts.content(), stageSize)
  }

  private place(): void {
    this.svg.style.transform = cssTransform(this.T)
    const view: LabelView = { transform: { ...this.T }, ladder: this.moving && this.zoomAnchor !== null }
    for (const fn of [...this.placeListeners]) fn(view)
  }

  private setMoving(v: boolean): void {
    if (this.moving === v) return
    this.moving = v
    this.svg.classList.toggle(MOVING_CLASS, v)
    this.emit('state')
  }

  /** End of a movement: clamp, clear `lec-moving`, redraw once at the settled view. */
  commit(stageSize?: Size): void {
    this.clamp(stageSize)
    this.setMoving(false)
    this.place()
    if (this.T.k !== this.lastK) {
      this.lastK = this.T.k
      this.svg.style.setProperty('--k', String(this.T.k))
    }
    this.zoomAnchor = null
    const t = { ...this.T }
    for (const fn of [...this.commitListeners]) fn(t)
  }

  private live(): void {
    this.clamp()
    this.setMoving(true)
    this.place()
  }

  private cancelAnimation(): void {
    this.animId++
    this.zoomAnchor = null
  }

  private touch(): void {
    if (this.everTouched) return
    this.everTouched = true
    this.stage.classList.add(STAGE_MOVED_CLASS)
    this.emit('state')
  }

  private setActive(v: boolean): void {
    if (this.isActive === v) return
    this.isActive = v
    this.stage.classList.toggle(STAGE_ACTIVE_CLASS, v)
    this.emit('state')
  }

  // ---- commands --------------------------------------------------------------------------------------------------

  /** Set the view (clamped) and settle. */
  setView(t: Transform): void {
    this.cancelAnimation()
    this.T = { ...t }
    this.commit()
  }

  /** Show the whole content (instant). Not a user movement: the hint stays. */
  fit(): void {
    this.cancelAnimation()
    const stageSize = this.size()
    this.T = fitTransform(this.opts.content(), stageSize, this.insets().top)
    this.commit(stageSize)
  }

  /** Zoom by `factor` about the screen point (cx, cy) (instant). */
  zoomAt(factor: number, cx: number, cy: number): void {
    this.cancelAnimation()
    this.T = zoomAbout(this.T, factor, cx, cy)
    this.commit()
  }

  /** Zoom by `factor` about the middle of the stage (the + / - buttons and keys). */
  zoomBy(factor: number): void {
    this.touch()
    const s = this.size()
    this.zoomAt(factor, s.width / 2, s.height / 2)
  }

  /** Move the view by (dx, dy) screen pixels (instant). */
  panBy(dx: number, dy: number): void {
    this.cancelAnimation()
    this.T = { ...this.T, x: this.T.x + dx, y: this.T.y + dy }
    this.commit()
  }

  /** Centre the canvas point (cx, cy) at `ladder(max(scale, 0.7))`, animated. */
  panTo(cx: number, cy: number): void {
    this.touch()
    this.animateTo(panToTarget(this.T, cx, cy, this.size()), PAN_MS)
  }

  /** Show a canvas box completely, clear of the HUD (and of the side panel when `panelOpen`), animated. */
  zoomToBox(box: Box, options: { panelOpen?: boolean } = {}): void {
    this.touch()
    this.animateTo(boxTransform(box, this.size(), this.insets(options.panelOpen === true)), ZOOM_BOX_MS)
  }

  /** Move to `target`; the animation (or the jump, with reduced motion) ends on `target.k` and commits. */
  animateTo(target: Transform, ms: number): void {
    const id = ++this.animId
    this.zoomAnchor = target.k
    const reduce = (this.opts.reducedMotion ?? ((): boolean => this.stage.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true))()
    if (reduce) {
      this.T = { ...target }
      this.commit()
      return
    }
    const from = { ...this.T }
    const now = this.opts.now ?? ((): number => performance.now())
    const raf = this.opts.requestFrame ?? ((cb: (t: number) => void): number => (this.stage.ownerDocument.defaultView ?? window).requestAnimationFrame(cb))
    const t0 = now()
    const step = (t: number): void => {
      if (id !== this.animId) return
      const u = Math.min(1, (t - t0) / ms)
      this.T = lerpTransform(from, target, easeOutCubic(u))
      if (u < 1) {
        this.live()
        raf(step)
      } else this.commit()
    }
    step(t0)
  }

  // ---- input -----------------------------------------------------------------------------------------------------

  private bind(): void {
    const signal = this.abort.signal
    const doc = this.stage.ownerDocument
    const win = doc.defaultView ?? window
    const ignored = (t: EventTarget | null): boolean => this.opts.ignore !== undefined && t instanceof Element && t.closest(this.opts.ignore) !== null

    this.stage.addEventListener(
      'wheel',
      (ev) => {
        if (ignored(ev.target)) return
        if (!wheelZooms({ active: this.isActive, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey })) return
        ev.preventDefault()
        this.touch()
        const r = this.stage.getBoundingClientRect()
        this.cancelAnimation()
        this.T = zoomAbout(this.T, wheelFactor(ev.deltaY), ev.clientX - r.left, ev.clientY - r.top)
        this.live()
        const clear = this.opts.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>))
        const set = this.opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
        if (this.wheelTimer !== null) clear(this.wheelTimer)
        this.wheelTimer = set(() => {
          this.wheelTimer = null
          this.commit()
        }, WHEEL_SETTLE_MS)
      },
      { passive: false, signal },
    )

    this.stage.addEventListener(
      'pointerdown',
      (ev) => {
        if (ignored(ev.target)) return
        this.press = { x: ev.clientX, y: ev.clientY, tx: this.T.x, ty: this.T.y }
        this.dragged = false
      },
      { signal },
    )
    win.addEventListener(
      'pointermove',
      (ev) => {
        const p = this.press
        if (!p) return
        const dx = ev.clientX - p.x
        const dy = ev.clientY - p.y
        if (!this.dragged && isDrag(dx, dy)) {
          this.dragged = true
          this.stage.classList.add(STAGE_DRAGGING_CLASS)
          this.touch()
          this.emit('state')
        }
        if (this.dragged) {
          this.cancelAnimation()
          this.T = { ...this.T, x: p.tx + dx, y: p.ty + dy }
          this.live()
        }
      },
      { signal },
    )
    win.addEventListener(
      'pointerup',
      () => {
        if (this.press && this.dragged) this.commit()
        if (this.press && !this.dragged) this.setActive(true)
        this.press = null
        this.stage.classList.remove(STAGE_DRAGGING_CLASS)
        // the click that ends the press comes after pointerup: `wasDragged` stays true until then
        const set = this.opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms))
        set(() => {
          this.dragged = false
          this.emit('state')
        }, 0)
      },
      { signal },
    )
    doc.addEventListener(
      'pointerdown',
      (ev) => {
        if (!(ev.target instanceof Node) || !this.stage.contains(ev.target)) this.setActive(false)
      },
      { signal },
    )

    this.stage.addEventListener(
      'keydown',
      (ev) => {
        if (isTypingTarget(ev.target)) return
        const a = keyAction(ev.key)
        if (!a) return
        if (a.type === 'escape') {
          if (!this.opts.onEscape?.()) {
            this.setActive(false)
            this.stage.blur()
          }
        } else if (a.type === 'zoom') this.zoomBy(a.factor)
        else this.panBy(a.dx, a.dy)
        ev.preventDefault()
      },
      { signal },
    )

    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => {
        this.stageSize = null
      })
      this.ro.observe(this.stage)
    }
    win.addEventListener(
      'resize',
      () => {
        this.stageSize = null
        this.emit('resize')
        // a reader who has not touched the map still sees all of it after a resize; a reader who has keeps the view
        if (this.everTouched) this.commit()
        else this.fit()
      },
      { signal },
    )
  }

  destroy(): void {
    this.ro?.disconnect()
    this.ro = null
    this.stageSize = null
    this.abort.abort()
    this.cancelAnimation()
    if (this.wheelTimer !== null) (this.opts.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.wheelTimer)
    this.wheelTimer = null
    this.placeListeners.clear()
    this.commitListeners.clear()
    for (const s of Object.values(this.listeners)) s.clear()
    this.stage.classList.remove(STAGE_ACTIVE_CLASS, STAGE_DRAGGING_CLASS)
    this.svg.classList.remove(MOVING_CLASS)
  }
}
