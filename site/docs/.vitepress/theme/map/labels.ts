/**
 * map/labels.ts - the canvas label layer of the map (P4a WP-H1, prototype v11-v15).
 *
 * Why: the cost of repainting a Chinese-text SVG on every frame is the text. So the shapes and lines stay in the
 * `<svg>` (redrawn at the true scale, sharp), every `<text>` of it stays in the DOM (classes, CSS rules, data) but is
 * `display: none` (the map stylesheet does that), and one `<canvas>` over the map draws only the labels that are on
 * screen, at their on-screen pixel size, every time the view changes.
 *
 *   - the look (font, colour, weight, underline, halo, opacity) is READ from the CSS with `getComputedStyle`; a
 *     `MutationObserver` marks only the labels whose class changed (or whose subtree's did) for a re-read, and the
 *     whole layer when a class of the svg itself changes (zoom-level classes `lec-moving` / `lod-*` do not);
 *   - during an ANIMATED zoom the scale is snapped to the 2^(1/4) ladder (so a handful of glyph sizes is reused and
 *     the last frame already has the final size); drag and wheel never snap;
 *   - labels whose size on screen is under 4 px, or that are off screen, are not drawn;
 *   - a text is not clickable (it is `display: none`): give every label a transparent hit shape in the svg
 *     (`labelHitBox` computes it, the map stylesheet has `.lec-map-hit`);
 *   - web fonts: `display: none` text makes the browser fetch nothing, and whether a canvas draw starts the download of a
 *     unicode-range slice is up to the browser (Chrome 157 does; nothing promises it), so the layer asks for them itself (`document.fonts.load(font, the characters of the labels)`,
 *     batched per font) and repaints when a load resolves or the font set reports `loadingdone`;
 *   - styles are read once per collect / class change: everything on screen in the first paint, the rest in idle time, and the
 *     results are kept across frames, so a pan or drag frame never calls `getComputedStyle` once the layer has settled.
 *
 * DOM only, no Vue (the composable `useLabelLayer` wraps it). Tested with happy-dom and a stubbed 2D context:
 * tests/unit/map-labels.test.ts.
 */
import { ladder } from './geometry'
import type { Transform } from './geometry'

export interface LabelHalo {
  c: string
  w: number
}

export interface Label {
  el: SVGTextElement
  /** Baseline anchor in canvas units (the `x` / `y` attributes plus a `translate(...)` of the element). */
  x: number
  y: number
  /** Degrees. */
  rot: number
  text: string
  /** Free tag the `visible` rule switches on (`data-label-kind` of the element or of an ancestor; default `always`). */
  kind: string
  /** The label is drawn only at scales k with `minK <= k < maxK` (`data-min-zoom` / `data-max-zoom` of the element or an ancestor). */
  minK: number
  maxK: number
  align: CanvasTextAlign
  // read from the CSS (see `readLabelStyle`)
  alpha: number
  size: number
  font: string
  family: string
  fill: string
  under: boolean
  halo: LabelHalo | null
}

interface InternalLabel extends Label {
  _px?: number
  _font?: string
  /** The web-font faces for this text are in (or there are none): the label may be drawn. Reset when the label is restyled. */
  _fontOk?: boolean
}

/** How long a label waits for its web-font slices before it is drawn with whatever the browser has (fallback glyphs). */
export const FONT_GIVE_UP_MS = 3000

/**
 * True when drawing `text` in `font` would use only faces that are loaded (or system fonts): `document.fonts.check` is false
 * while a unicode-range slice that covers a character is still unloaded or loading. A canvas draw in that state uses the fallback
 * list, and on a machine whose fallback has no glyph for the character that is the tofu box (the live report of 2026-11-22), so the
 * layer draws nothing for such a label until the check passes or `FONT_GIVE_UP_MS` is over. A missing API or a font string the
 * browser cannot parse counts as "covered" (nothing to wait for).
 */
export function fontsCover(fonts: Pick<FontFaceSet, 'check'> | null | undefined, font: string, text: string): boolean {
  if (!fonts || typeof fonts.check !== 'function') return true
  try {
    return fonts.check(font, text)
  } catch {
    return true
  }
}

/** What the viewport tells the layer on every change of the view. */
export interface LabelView {
  transform: Transform
  /** True during an animated zoom: label sizes snap to the ladder. */
  ladder: boolean
}

export interface LabelDrawStats {
  /** Labels drawn by the last `draw`. */
  drawn: number
  /** Labels whose style was re-read by the last `draw`. */
  styled: number
}

// ---- pure helpers ----------------------------------------------------------------------------------------------

/** Labels smaller than this on screen (px) are not drawn. */
export const MIN_LABEL_PX = 4
/** A label whose anchor is further than this outside the stage horizontally / vertically is not drawn (px). */
export const CULL_X = 600
export const CULL_Y = 60

/** On-screen font size: the exact `size * k`, or `size * ladder(k)` during an animated zoom. */
export function labelPixelSize(size: number, k: number, onLadder: boolean): number {
  return onLadder ? size * ladder(k) : size * k
}

/** False when the anchor (screen px) is so far outside the `width x height` stage that no part of the text can show. */
export function labelOnScreen(sx: number, sy: number, width: number, height: number): boolean {
  return !(sx < -CULL_X || sx > width + CULL_X || sy < -CULL_Y || sy > height + CULL_Y)
}

/** Default visibility rule: inside the label's own zoom range. */
export function labelVisibleAt(label: Pick<Label, 'minK' | 'maxK'>, k: number): boolean {
  return k >= label.minK && k < label.maxK
}

/**
 * The transparent hit rectangle of a label (canvas units): the box of the text with a little air. `width` is the text
 * width in canvas units, `size` its font size; `align` as the svg `text-anchor` (start / middle / end).
 */
export function labelHitBox(x: number, y: number, width: number, size: number, align: 'start' | 'middle' | 'end' = 'start', pad = 3): { x: number; y: number; w: number; h: number } {
  const left = align === 'end' ? x - width : align === 'middle' ? x - width / 2 : x
  return { x: left - pad, y: y - size * 0.85 - pad, w: width + 2 * pad, h: size * 1.2 + 2 * pad }
}

const NUM = '[-+\\d.eE]+'
const TRANSLATE_RE = new RegExp(`translate\\((${NUM})[ ,]+(${NUM})\\)`)
const ROTATE_RE = new RegExp(`rotate\\((${NUM})\\)`)
const ANCHORS: Record<string, CanvasTextAlign> = { start: 'left', middle: 'center', end: 'right' }

/** Position, rotation and alignment of a `<text>`: `x` / `y` plus the translate of its own `transform`. */
export function readLabelGeometry(el: Element): { x: number; y: number; rot: number; align: CanvasTextAlign } {
  let x = Number(el.getAttribute('x')) || 0
  let y = Number(el.getAttribute('y')) || 0
  let rot = 0
  if (el.hasAttribute('transform')) {
    const tr = el.getAttribute('transform')
    if (tr) {
      const m = TRANSLATE_RE.exec(tr)
      const q = ROTATE_RE.exec(tr)
      if (m) {
        x += Number(m[1])
        y += Number(m[2])
      }
      if (q) rot = Number(q[1])
    }
  }
  return { x, y, rot, align: ANCHORS[el.getAttribute('text-anchor') ?? 'start'] ?? 'left' }
}

interface CachedStyle {
  alphaSelf: number
  size: number
  font: string
  family: string
  fill: string
  under: boolean
  halo: { c: string; w: number } | null
}

function computeNodeSig(el: Element): string {
  const cls = el.getAttribute('class') ?? ''
  const style = el.getAttribute('style') ?? ''
  const slot = el.getAttribute('data-slot') ?? ''
  const impl = el.getAttribute('data-slot-impl') ?? ''
  return `${el.localName}#${el.id}.${cls}[${style}]{${slot}|${impl}}`
}

function nodeSig(el: Element, sigs?: Map<Element, string>): string {
  if (!sigs) return computeNodeSig(el)
  let s = sigs.get(el)
  if (s === undefined) {
    s = computeNodeSig(el)
    sigs.set(el, s)
  }
  return s
}

function ancInfo(
  el: Element | null,
  svg: Element,
  alphaCache: Map<Element, number>,
  ancCache: Map<Element, { alpha: number; key: string }>,
  ancAlphaBySig: Map<string, number>,
  win: Window,
  sigs?: Map<Element, string>,
): { alpha: number; key: string } {
  if (!el || el === svg) return { alpha: 1, key: '' }
  const hit = ancCache.get(el)
  if (hit) return hit
  const parent = ancInfo(el.parentNode as Element | null, svg, alphaCache, ancCache, ancAlphaBySig, win, sigs)
  const key = `${parent.key}>${nodeSig(el, sigs)}`
  let o = alphaCache.get(el)
  if (o === undefined) {
    const sigHit = ancAlphaBySig.get(key)
    if (sigHit !== undefined) {
      o = sigHit
    } else {
      o = parseFloat(win.getComputedStyle(el).opacity)
      if (Number.isNaN(o)) o = 1
      ancAlphaBySig.set(key, o)
    }
    alphaCache.set(el, o)
  }
  const res = { alpha: parent.alpha * o, key }
  ancCache.set(el, res)
  return res
}

/**
 * Re-read the look of a label from the CSS: opacity is the product of the element's and of every ancestor up to the
 * svg (`cache` shares ancestors between labels of one pass), the rest comes from the element's computed style. A
 * halo is a stroke painted first (`paint-order: stroke`).
 */
export function readLabelStyle(
  label: Label,
  svg: Element,
  cache: Map<Element, number>,
  win: Window = window,
  passCache?: {
    styles: Map<string, CachedStyle>
    anc: Map<Element, { alpha: number; key: string }>
    ancAlpha: Map<string, number>
    sigs?: Map<Element, string>
  },
): void {
  if (passCache) {
    const anc = ancInfo(label.el.parentNode as Element | null, svg, cache, passCache.anc, passCache.ancAlpha, win, passCache.sigs)
    const sig = `${anc.key}|${nodeSig(label.el, passCache.sigs)}`
    let st = passCache.styles.get(sig)
    if (!st) {
      const cs = win.getComputedStyle(label.el)
      let alphaSelf = parseFloat(cs.opacity)
      if (Number.isNaN(alphaSelf)) alphaSelf = 1
      const size = parseFloat(cs.fontSize)
      const paintOrder = cs.paintOrder || ''
      const stroke = cs.stroke || 'none'
      st = {
        alphaSelf,
        size: Number.isFinite(size) ? size : 12,
        font: [cs.fontStyle || 'normal', cs.fontWeight || '400'].join(' '),
        family: cs.fontFamily || 'sans-serif',
        fill: cs.fill && cs.fill !== 'none' ? cs.fill : cs.color || 'currentColor',
        under: (cs.textDecorationLine || '').indexOf('underline') >= 0,
        halo: paintOrder.indexOf('stroke') === 0 && stroke !== 'none' ? { c: stroke, w: parseFloat(cs.strokeWidth) || 0 } : null,
      }
      passCache.styles.set(sig, st)
    }
    label.alpha = st.alphaSelf * anc.alpha
    label.size = st.size
    label.font = st.font
    label.family = st.family
    label.fill = st.fill
    label.under = st.under
    label.halo = st.halo
    return
  }
  const cs = win.getComputedStyle(label.el)
  let a = parseFloat(cs.opacity)
  if (Number.isNaN(a)) a = 1
  for (let p = label.el.parentNode as Element | null; p && p !== svg; p = p.parentNode as Element | null) {
    let o = cache.get(p)
    if (o === undefined) {
      o = parseFloat(win.getComputedStyle(p).opacity)
      if (Number.isNaN(o)) o = 1
      cache.set(p, o)
    }
    a *= o
  }
  label.alpha = a
  const size = parseFloat(cs.fontSize)
  label.size = Number.isFinite(size) ? size : 12
  label.font = [cs.fontStyle || 'normal', cs.fontWeight || '400'].join(' ')
  label.family = cs.fontFamily || 'sans-serif'
  label.fill = cs.fill && cs.fill !== 'none' ? cs.fill : cs.color || 'currentColor'
  label.under = (cs.textDecorationLine || '').indexOf('underline') >= 0
  const paintOrder = cs.paintOrder || ''
  const stroke = cs.stroke || 'none'
  label.halo = paintOrder.indexOf('stroke') === 0 && stroke !== 'none' ? { c: stroke, w: parseFloat(cs.strokeWidth) || 0 } : null
}

// ---- the layer --------------------------------------------------------------------------------------------------

export interface LabelLayerOptions {
  /** The map stage; its size is the size of the canvas. */
  stage: HTMLElement
  svg: SVGSVGElement
  /** A canvas rendered by the component (`MapStage` does this, so Vue owns every child of the stage). Default: one is created and inserted right after the svg. */
  canvas?: HTMLCanvasElement
  /** Tag of a label for the `visible` rule; default: `data-label-kind` of the element or an ancestor, else `always`. */
  kindOf?: (el: SVGTextElement) => string
  /** Visibility at scale k; default: the label's `data-min-zoom` / `data-max-zoom` range. */
  visible?: (label: Label, k: number) => boolean
  /** Classes of the svg itself that do NOT restyle the labels when they change (zoom-level classes). Default: `lec-moving` and `lod-*`. */
  ignoreSvgClass?: (name: string) => boolean
  /** Attributes of `<html>` that restyle all labels when they change (theme switches). */
  themeAttributes?: readonly string[]
  /** Test seams. */
  getContext?: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null
  devicePixelRatio?: () => number
  requestFrame?: (cb: () => void) => number
  cancelFrame?: (id: number) => void
  /** Run `cb` when the thread is idle (default `requestIdleCallback`, else a timeout). */
  requestIdle?: (cb: () => void) => void
  /** Called each time the layer turns ready (see `LabelProbe.ready`): the first paint with all fonts in (or given up) and all labels styled. */
  onReady?: () => void
  /** Give-up time for the fonts, ms (default `FONT_GIVE_UP_MS`). */
  fontGiveUpMs?: number
}

/** What a test can read from the canvas (`canvas.lecLabels`): how often it was painted and whether the fonts are all in. */
export interface LabelProbe {
  /** Number of paints so far. */
  paints: number
  /** True when the last paint came after every font load requested by the labels had resolved and every label was styled. */
  fontsReady: boolean
  /** Labels left undrawn in the last paint because their web-font slices were not in yet. */
  waiting: number
  /** True once the wait for the fonts was given up (`FONT_GIVE_UP_MS`): labels are then drawn with the fallback. */
  gaveUp: boolean
  /** Labels drawn in the last paint. */
  drawn: number
  /** The last paint drew every visible label with its real font (or the wait was given up) and every label was styled. */
  ready: boolean
}

interface PassCache {
  styles: Map<string, CachedStyle>
  anc: Map<Element, { alpha: number; key: string }>
  ancAlpha: Map<string, number>
  sigs: Map<Element, string>
}
const newPassCache = (): PassCache => ({ styles: new Map(), anc: new Map(), ancAlpha: new Map(), sigs: new Map() })

/** The look of the labels is read in slices of at most this many ms in idle time. */
const IDLE_SLICE_MS = 6

export const LABEL_CANVAS_CLASS = 'lec-map-labels'
export const MOVING_CLASS = 'lec-moving'
export const THEME_ATTRIBUTES: readonly string[] = ['class', 'data-lec-theme', 'data-lec-tint', 'data-lec-size', 'data-lec-font']

const defaultIgnoreSvgClass = (name: string): boolean => name === MOVING_CLASS || name.startsWith('lod-')

export class LabelLayer {
  readonly canvas: HTMLCanvasElement
  labels: Label[] = []
  stats: LabelDrawStats = { drawn: 0, styled: 0 }

  private readonly stage: HTMLElement
  private readonly svg: SVGSVGElement
  private readonly ctx: CanvasRenderingContext2D | null
  private readonly opts: LabelLayerOptions
  private readonly byEl = new WeakMap<Element, Label>()
  private readonly dirty = new Set<Label>()
  private dirtyAll = true
  private invalidateStyleCache = true
  private paintDeferred = false
  /** Style results kept across frames: cleared when everything is re-read, and the element caches when an ancestor changes. */
  private passCache: PassCache = newPassCache()
  private alphaCache = new Map<Element, number>()
  private idlePending = false
  /** Characters each distinct font (style, weight, family) is used for; `fresh` = not yet asked from the browser. */
  private readonly needs = new Map<string, { font: string; chars: Set<string>; fresh: string }>()
  private loading = 0
  private paints = 0
  private fontsReady = false
  private waiting = 0
  private gaveUp = false
  private giveUpTimer: number | null = null
  private lastDrawn = 0
  private ready = false
  private frame = 0
  private dpr = 1
  private width = 0
  private height = 0
  private view: LabelView = { transform: { k: 1, x: 0, y: 0 }, ladder: false }
  private readonly observers: MutationObserver[] = []
  private mediaQuery: MediaQueryList | null = null
  private readonly onScheme = (): void => this.markAllDirty()
  private readonly onFontsDone = (): void => this.request()
  private readonly svgMutationInit: MutationObserverInit = { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true }
  private svgObserving = false
  private deferredSvgClass: string | null = null
  private destroyed = false
  private readonly ownCanvas: boolean

  constructor(opts: LabelLayerOptions) {
    this.opts = opts
    this.stage = opts.stage
    this.svg = opts.svg
    const doc = opts.stage.ownerDocument
    this.ownCanvas = opts.canvas === undefined
    this.canvas = opts.canvas ?? doc.createElement('canvas')
    this.canvas.classList.add(LABEL_CANVAS_CLASS)
    this.canvas.setAttribute('aria-hidden', 'true')
    Object.defineProperty(this.canvas, 'lecLabels', {
      configurable: true,
      get: (): LabelProbe => ({
        paints: this.paints,
        fontsReady: this.fontsReady,
        waiting: this.waiting,
        gaveUp: this.gaveUp,
        drawn: this.lastDrawn,
        ready: this.ready,
      }),
    })
    if (this.ownCanvas) this.stage.insertBefore(this.canvas, this.svg.nextSibling)
    this.ctx = (opts.getContext ?? ((c) => c.getContext('2d')))(this.canvas)
    this.resize()

    const ignore = opts.ignoreSvgClass ?? defaultIgnoreSvgClass
    this.observers.push(this.observe(this.svg, this.svgMutationInit, (list) => this.onSvgMutations(list, ignore)))
    this.svgObserving = true
    this.observers.push(this.observe(doc.documentElement, { attributes: true, attributeFilter: [...(opts.themeAttributes ?? THEME_ATTRIBUTES)] }, () => this.markAllDirty()))
    const win = doc.defaultView
    if (win?.matchMedia) {
      this.mediaQuery = win.matchMedia('(prefers-color-scheme: dark)')
      this.mediaQuery.addEventListener?.('change', this.onScheme)
    }
    void doc.fonts?.ready?.then(() => this.markAllDirty())
    doc.fonts?.addEventListener?.('loadingdone', this.onFontsDone)
  }

  private observe(target: Node, init: MutationObserverInit, cb: MutationCallback): MutationObserver {
    const win = this.stage.ownerDocument.defaultView
    const Observer = win?.MutationObserver ?? MutationObserver
    const o = new Observer(cb)
    o.observe(target, init)
    return o
  }

  private onSvgMutations(list: MutationRecord[], ignore: (name: string) => boolean): void {
    let needPaint = false
    for (const m of list) {
      const t = m.target as Element
      if (t === this.svg) {
        const before = new Set((m.oldValue ?? '').split(/\s+/).filter(Boolean))
        const after = new Set((this.svg.getAttribute('class') ?? '').split(/\s+/).filter(Boolean))
        const changed = [...before, ...after].some((c) => before.has(c) !== after.has(c) && !ignore(c))
        if (changed) {
          this.dirtyAll = true
          this.invalidateStyleCache = true
          needPaint = true
        }
        continue
      }
      if (t.localName === 'text') {
        this.passCache.sigs.delete(t)
        const l = this.byEl.get(t)
        if (l) {
          this.dirty.add(l)
          needPaint = true
        }
        continue
      }
      // an ancestor changed: what was kept for its elements (opacity, signature) is stale
      this.passCache.anc.clear()
      this.passCache.sigs.delete(t)
      this.alphaCache.clear()
      t.querySelectorAll?.('text').forEach((x) => {
        const l = this.byEl.get(x)
        if (l) {
          this.dirty.add(l)
          needPaint = true
        }
      })
    }
    if (needPaint) this.request()
  }

  /** Collect the `<text>` elements of the svg again (call after the svg content was re-rendered). */
  collect(): void {
    const customKind = this.opts.kindOf
    const attrCache = new Map<Element, { kind: string; minK: number; maxK: number }>()
    const stop = this.svg.parentNode
    const resolveAttrs = (el: Element): { kind: string; minK: number; maxK: number } => {
      const hit = attrCache.get(el)
      if (hit) return hit
      const parent = el.parentNode as Element | null
      const base = parent && parent !== stop ? resolveAttrs(parent) : { kind: 'always', minK: 0, maxK: Infinity }
      const rk = el.getAttribute('data-label-kind')
      const rmin = el.getAttribute('data-min-zoom')
      const rmax = el.getAttribute('data-max-zoom')
      if (rk === null && rmin === null && rmax === null) {
        attrCache.set(el, base)
        return base
      }
      const nmin = rmin !== null ? Number(rmin) : NaN
      const nmax = rmax !== null ? Number(rmax) : NaN
      const res = {
        kind: rk ?? base.kind,
        minK: Number.isFinite(nmin) ? nmin : base.minK,
        maxK: Number.isFinite(nmax) ? nmax : base.maxK,
      }
      attrCache.set(el, res)
      return res
    }
    this.labels = []
    this.dirty.clear()
    this.paintDeferred = false
    this.resetAncCache()
    this.svg.querySelectorAll('text').forEach((t) => {
      const x = Number(t.getAttribute('x')) || 0
      const y = Number(t.getAttribute('y')) || 0
      let gx = x
      let gy = y
      let rot = 0
      if (t.hasAttribute('transform')) {
        const tr = t.getAttribute('transform')
        if (tr) {
          const m = TRANSLATE_RE.exec(tr)
          const q = ROTATE_RE.exec(tr)
          if (m) {
            gx += Number(m[1])
            gy += Number(m[2])
          }
          if (q) rot = Number(q[1])
        }
      }
      const align = ANCHORS[t.getAttribute('text-anchor') ?? 'start'] ?? 'left'
      const attrs = resolveAttrs(t)
      const label: Label = {
        el: t,
        x: gx,
        y: gy,
        rot,
        align,
        text: t.textContent ?? '',
        kind: customKind ? customKind(t) : attrs.kind,
        minK: attrs.minK,
        maxK: attrs.maxK,
        alpha: 1,
        size: 12,
        font: 'normal 400',
        family: 'sans-serif',
        fill: 'currentColor',
        under: false,
        halo: null,
      }
      this.labels.push(label)
      this.byEl.set(t, label)
    })
    // Discard DOM mutations produced by the render batch we just collected so onSvgMutations does not re-scan them.
    const svgObserver = this.observers[0] as (MutationObserver & { takeRecords?: () => MutationRecord[] }) | undefined
    svgObserver?.takeRecords?.()
    if (this.deferredSvgClass !== null && this.deferredSvgClass !== (this.svg.getAttribute('class') ?? '')) {
      this.invalidateStyleCache = true
    }
    this.deferredSvgClass = null
    if (!this.svgObserving && !this.destroyed) {
      svgObserver?.observe(this.svg, this.svgMutationInit)
      this.svgObserving = true
    }
    this.dirtyAll = true
    this.request()
  }

  /** Match the canvas to the stage size and the device pixel ratio (window resize, device change). */
  resize(): void {
    const r = this.stage.getBoundingClientRect()
    this.dpr = (this.opts.devicePixelRatio ?? ((): number => this.stage.ownerDocument.defaultView?.devicePixelRatio ?? 1))() || 1
    this.width = r.width
    this.height = r.height
    this.canvas.width = Math.round(r.width * this.dpr)
    this.canvas.height = Math.round(r.height * this.dpr)
    this.canvas.style.width = `${r.width}px`
    this.canvas.style.height = `${r.height}px`
    this.request()
  }

  markAllDirty(): void {
    this.dirtyAll = true
    this.invalidateStyleCache = true
    this.request()
  }

  markDirty(el: Element): void {
    const l = this.byEl.get(el)
    if (l) this.dirty.add(l)
    this.request()
  }

  /** Draw at once for `view` (the viewport calls this on every placement) and cancel a pending frame. */
  draw(view: LabelView): void {
    this.view = view
    this.cancelFrame()
    if (this.paintDeferred) {
      this.request()
      return
    }
    this.paint()
  }

  /** Defer synchronous `draw()` painting until the next `collect()` after a coordinated DOM + view update. */
  deferUntilCollect(): void {
    this.paintDeferred = true
    if (this.svgObserving && !this.destroyed) {
      this.deferredSvgClass = this.svg.getAttribute('class') ?? ''
      this.observers[0]?.disconnect()
      this.svgObserving = false
    }
  }

  /** Draw in the next animation frame with the last view (restyles, resizes, new labels). */
  request(): void {
    if (this.frame || this.destroyed) return
    const raf = this.opts.requestFrame ?? ((cb: () => void): number => (this.stage.ownerDocument.defaultView ?? window).requestAnimationFrame(cb))
    this.frame = raf(() => {
      this.frame = 0
      this.paint()
    })
  }

  private cancelFrame(): void {
    if (!this.frame) return
    const caf = this.opts.cancelFrame ?? ((id: number): void => (this.stage.ownerDocument.defaultView ?? window).cancelAnimationFrame(id))
    caf(this.frame)
    this.frame = 0
  }

  private resetAncCache(): void {
    this.passCache.anc.clear()
    this.passCache.sigs.clear()
    this.alphaCache.clear()
  }

  private resetStyleCache(): void {
    this.passCache = newPassCache()
    this.alphaCache = new Map()
  }

  /** Read the look of one label (kept across frames) and note which characters its font must cover. */
  private styleLabel(l: InternalLabel, win: Window): void {
    readLabelStyle(l, this.svg, this.alphaCache, win, this.passCache)
    l._font = ''
    l._fontOk = false
    const key = `${l.font}|${l.family}`
    let need = this.needs.get(key)
    if (!need) {
      need = { font: `${l.font} 16px ${l.family}`, chars: new Set(), fresh: '' }
      this.needs.set(key, need)
    }
    for (const ch of l.text) {
      if (ch.trim() === '' || need.chars.has(ch)) continue
      need.chars.add(ch)
      need.fresh += ch
    }
  }

  /**
   * Ask the browser for the font faces the labels use: the svg text, being `display: none`, starts no download, and a canvas draw
   * is not promised to (Chrome 157 does fetch the slices; without a repaint after they arrive the canvas keeps the fallback
   * glyphs). One call per font for the characters not yet asked for; a repaint follows each batch.
   */
  private loadFonts(): void {
    const fonts = this.stage.ownerDocument.fonts
    if (!fonts?.load) return
    for (const need of this.needs.values()) {
      if (!need.fresh) continue
      const text = need.fresh
      need.fresh = ''
      this.loading++
      void fonts
        .load(need.font, text)
        .catch(() => [])
        .then(() => {
          this.loading--
          this.request()
        })
    }
  }

  /** Style what is still unread in slices of idle time; the next frames then find every label styled. */
  private scheduleIdleStyle(): void {
    if (this.idlePending || this.destroyed || !this.dirty.size) return
    this.idlePending = true
    const win = this.stage.ownerDocument.defaultView ?? window
    const idle =
      this.opts.requestIdle ??
      ((cb: () => void): void => {
        if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(() => cb())
        else win.setTimeout(cb, 16)
      })
    idle(() => {
      this.idlePending = false
      if (this.destroyed) return
      const t0 = performance.now()
      for (const l of this.dirty) {
        this.styleLabel(l, win)
        this.dirty.delete(l)
        if (performance.now() - t0 > IDLE_SLICE_MS) break
      }
      if (this.dirty.size) this.scheduleIdleStyle()
      else {
        this.loadFonts()
        this.request()
      }
    })
  }

  private paint(): void {
    this.paintDeferred = false
    const ctx = this.ctx
    const win = this.stage.ownerDocument.defaultView ?? window
    let styled = 0
    let waiting = 0
    const fonts = this.gaveUp ? null : this.stage.ownerDocument.fonts
    if (this.dirtyAll) {
      for (const l of this.labels) this.dirty.add(l)
      this.dirtyAll = false
      if (this.invalidateStyleCache) {
        this.resetStyleCache()
        this.invalidateStyleCache = false
      } else {
        this.resetAncCache()
      }
    }
    if (!ctx) {
      for (const l of this.dirty) this.styleLabel(l, win)
      styled = this.dirty.size
      this.dirty.clear()
      this.loadFonts()
      this.stats = { drawn: 0, styled }
      this.finishPaint(0)
      return
    }
    const { transform: T, ladder: onLadder } = this.view
    const k = T.k
    const visible = this.opts.visible ?? labelVisibleAt
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.textBaseline = 'alphabetic'
    ctx.lineJoin = 'round'
    let drawn = 0
    let lastAlpha = -1
    let lastFont = ''
    let lastAlign: CanvasTextAlign | '' = ''
    let lastFill = ''
    let lastStroke = ''
    let lastLineW = -1
    for (const raw of this.labels) {
      const l = raw as InternalLabel
      if (!visible(l, k)) continue
      const sx = T.x + l.x * k
      const sy = T.y + l.y * k
      if (!labelOnScreen(sx, sy, this.width, this.height)) continue
      // a label that is on screen and still unread (the first paint after a collect or a class change) is read now; the others
      // were read before, in this paint or in idle time, and cost nothing here
      if (this.dirty.has(l)) {
        this.styleLabel(l, win)
        this.dirty.delete(l)
        styled++
      }
      if (!(l.alpha > 0.01)) continue
      if (l.size * k < MIN_LABEL_PX) continue
      const px = labelPixelSize(l.size, k, onLadder)
      let fontSpec = l._font
      if (!fontSpec || l._px !== px) {
        fontSpec = `${l.font} ${px}px ${l.family}`
        l._px = px
        l._font = fontSpec
      }
      // a label whose web-font slices are still coming is not drawn (the fallback could be tofu); the paint that follows the load draws it
      if (fonts && !l._fontOk) {
        if (fontsCover(fonts, fontSpec, l.text)) l._fontOk = true
        else {
          waiting++
          continue
        }
      }
      if (l.rot) {
        ctx.save()
        ctx.translate(sx, sy)
        ctx.rotate((l.rot * Math.PI) / 180)
        ctx.globalAlpha = l.alpha
        ctx.font = fontSpec
        ctx.textAlign = l.align
        ctx.textBaseline = 'alphabetic'
        if (l.halo && l.halo.w) {
          ctx.lineJoin = 'round'
          ctx.lineWidth = l.halo.w * k
          ctx.strokeStyle = l.halo.c
          ctx.strokeText(l.text, 0, 0)
        }
        ctx.fillStyle = l.fill
        ctx.fillText(l.text, 0, 0)
        if (l.under) {
          const w = ctx.measureText(l.text).width
          const x0 = l.align === 'right' ? -w : l.align === 'center' ? -w / 2 : 0
          ctx.fillRect(x0, Math.max(1, px * 0.12), w, Math.max(1, px * 0.07))
        }
        ctx.restore()
        lastAlpha = -1
        lastFont = ''
        lastAlign = ''
        lastFill = ''
        lastStroke = ''
        lastLineW = -1
      } else {
        if (lastAlpha !== l.alpha) {
          ctx.globalAlpha = l.alpha
          lastAlpha = l.alpha
        }
        if (lastFont !== fontSpec) {
          ctx.font = fontSpec
          lastFont = fontSpec
        }
        if (lastAlign !== l.align) {
          ctx.textAlign = l.align
          lastAlign = l.align
        }
        if (l.halo && l.halo.w) {
          const lw = l.halo.w * k
          if (lastLineW !== lw) {
            ctx.lineWidth = lw
            lastLineW = lw
          }
          if (lastStroke !== l.halo.c) {
            ctx.strokeStyle = l.halo.c
            lastStroke = l.halo.c
          }
          ctx.strokeText(l.text, sx, sy)
        }
        if (lastFill !== l.fill) {
          ctx.fillStyle = l.fill
          lastFill = l.fill
        }
        ctx.fillText(l.text, sx, sy)
        if (l.under) {
          const w = ctx.measureText(l.text).width
          const x0 = sx + (l.align === 'right' ? -w : l.align === 'center' ? -w / 2 : 0)
          ctx.fillRect(x0, sy + Math.max(1, px * 0.12), w, Math.max(1, px * 0.07))
        }
      }
      drawn++
    }
    if (lastAlpha !== -1 && lastAlpha !== 1) ctx.globalAlpha = 1
    this.stats = { drawn, styled }
    if (styled) this.loadFonts()
    this.scheduleIdleStyle()
    this.finishPaint(waiting)
  }

  private finishPaint(waiting: number): void {
    this.paints++
    this.waiting = waiting
    this.lastDrawn = this.stats.drawn
    this.fontsReady = this.loading === 0 && this.dirty.size === 0
    if (waiting > 0 && !this.gaveUp && this.giveUpTimer === null) {
      const win = this.stage.ownerDocument.defaultView ?? window
      this.giveUpTimer = win.setTimeout(() => {
        this.giveUpTimer = null
        if (this.destroyed) return
        this.gaveUp = true
        this.request()
      }, this.opts.fontGiveUpMs ?? FONT_GIVE_UP_MS)
    }
    const ready = waiting === 0 && this.dirty.size === 0 && this.labels.length > 0
    const turned = ready && !this.ready
    this.ready = ready
    if (turned) this.opts.onReady?.()
  }

  destroy(): void {
    this.destroyed = true
    if (this.giveUpTimer !== null) (this.stage.ownerDocument.defaultView ?? window).clearTimeout(this.giveUpTimer)
    this.giveUpTimer = null
    this.cancelFrame()
    for (const o of this.observers) o.disconnect()
    this.observers.length = 0
    this.mediaQuery?.removeEventListener?.('change', this.onScheme)
    this.stage.ownerDocument.fonts?.removeEventListener?.('loadingdone', this.onFontsDone)
    if (this.ownCanvas) this.canvas.remove()
    this.labels = []
    this.dirty.clear()
    this.paintDeferred = false
  }
}
