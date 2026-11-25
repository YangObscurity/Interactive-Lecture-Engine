/**
 * charts/modal.ts — unified full-screen viewer (WP-F8), backed by PhotoSwipe v5 (MIT).
 *
 * Replaces the separate fullscreen modal logic: figures (`<img>` / SVG from `<LectureFigure>` or
 * the Dashboard gallery), interactive ECharts canvases, and Mermaid / WaveDrom vector diagrams share
 * one dialog with zoom, drag-to-pan, gallery prev/next navigation, keyboard shortcuts (Esc, arrows,
 * +/-/0), focus trap, and theme skinning via `--lec-*` CSS tokens.
 *
 * Interactive charts preserve the existing `.chart-body` DOM move lifecycle (moving the live body into
 * `.chart-modal__stage` inside the active PhotoSwipe slide and returning it on slide leave / close)
 * so ECharts keeps crisp canvas sizing (`chart.resize()`) and inline vectors keep sharp scrolling.
 */
import DOMPurify from 'dompurify'
import type PhotoSwipe from 'photoswipe'
import type { PhotoSwipeOptions, SlideData } from 'photoswipe'
import { currentLang, translate } from '../../i18n/index.ts'
import type { MessageKey } from '../../i18n/index.ts'
import { chartBody, fitInlineSvg, svgNaturalSize } from './dom'
import { figExtras } from './state'
import type { EChartsInstanceLike } from './state'

export interface ViewerSlide {
  kind: 'figure' | 'chart'
  id: string
  title: string
  src?: string
  width?: number
  height?: number
  caption?: string
  sourceText?: string
  /** Final URL (base already applied by the caller). */
  originalUrl?: string
  chartType?: string
  originEl?: HTMLElement | null
}

interface CanvasZoomAdapter {
  minScale: number
  maxScale: number
  fitCap: number
  baseSize(): { w: number; h: number }
  applyScale(scale: number): { w: number; h: number }
  onReset?(): void
}

interface InternalSlideData extends SlideData {
  lecSlide?: ViewerSlide
  isCanvas?: boolean
}

interface MountedCanvasState {
  slideIndex: number
  kind: 'chart' | 'vector-figure'
  body: HTMLElement | null
  restore?: { parent: Node; next: Node | null }
  stage: HTMLElement
  listeners: AbortController
  fitToStage: () => void
  onStageResize: () => void
  zoomBy: (factor: number, clientX?: number, clientY?: number) => void
  panBy: (dx: number, dy: number) => void
  isZoomed: () => boolean
  resetZoom: () => void
}

interface ActiveViewer {
  pswp: PhotoSwipe
  opener: HTMLElement | null
  slides: ViewerSlide[]
  listeners: AbortController
  mountedChart: MountedCanvasState | null
  barEl: HTMLElement | null
}

let active: ActiveViewer | null = null
let titleSeq = 0
/** Bumped by every open and every close request: a viewer whose library load finished late is dropped. */
let openSeq = 0

type PhotoSwipeCtor = typeof PhotoSwipe

let photoSwipeLoad: Promise<PhotoSwipeCtor> | null = null

/** PhotoSwipe loads on demand: pages without figures or charts never fetch it (a page that has some preloads it, see `preloadViewer`). */
function loadPhotoSwipe(): Promise<PhotoSwipeCtor> {
  photoSwipeLoad ??= Promise.all([import('photoswipe'), import('photoswipe/dist/photoswipe.css')]).then(
    ([mod]) => mod.default,
    (e: unknown) => {
      photoSwipeLoad = null
      throw e
    },
  )
  return photoSwipeLoad
}

/** Start loading the viewer library; called by pages that carry figures or charts so the first open is instant. */
export function preloadViewer(): void {
  if (typeof document === 'undefined') return
  void loadPhotoSwipe().catch(() => {
    /* offline: the first open tries again */
  })
}

export function isModalOpen(): boolean {
  return active !== null
}

/** The inline chart `<figure>` currently displayed in the viewer (null when closed or showing an image slide). */
export function modalOrigin(): HTMLElement | null {
  if (!active || !active.mountedChart) return null
  const slide = active.slides[active.mountedChart.slideIndex]
  return slide?.kind === 'chart' ? slide.originEl ?? null : null
}

function clampVal(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function attachFreeCanvas(
  viewer: ActiveViewer,
  slideIndex: number,
  kind: 'chart' | 'vector-figure',
  stage: HTMLElement,
  canvasEl: HTMLElement,
  adapter: CanvasZoomAdapter,
  body: HTMLElement | null = null,
  restore?: { parent: Node; next: Node | null },
  extraResize?: () => void,
): MountedCanvasState {
  stage.classList.add('chart-modal__stage')
  canvasEl.classList.add('chart-modal__canvas')

  const listeners = new AbortController()
  const { signal } = listeners

  let scale = 1
  let fitScale = 1
  let tx = 0
  let ty = 0
  let curW = 0
  let curH = 0

  const stageDims = (): { w: number; h: number } => {
    const w = stage.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1200)
    const h = stage.clientHeight || (typeof window !== 'undefined' ? Math.max(240, window.innerHeight - 44) : 760)
    return { w, h }
  }

  const renderedDims = (): { w: number; h: number } => {
    const w = canvasEl.offsetWidth || curW
    const h = canvasEl.offsetHeight || curH
    return { w, h }
  }

  const applyTransform = () => {
    const { w: sw, h: sh } = stageDims()
    const { w: cw, h: ch } = renderedDims()
    const keepX = Math.min(80, Math.max(24, cw * 0.25))
    const keepY = Math.min(80, Math.max(24, ch * 0.25))
    tx = clampVal(tx, keepX - cw, sw - keepX)
    ty = clampVal(ty, keepY - ch, sh - keepY)
    canvasEl.style.transform = `translate3d(${Math.round(tx * 10) / 10}px, ${Math.round(ty * 10) / 10}px, 0)`
  }

  const fitToStage = () => {
    const { w: sw, h: sh } = stageDims()
    const base = adapter.baseSize()
    if (!base.w || !base.h) return
    const pad = 32
    const raw = Math.min((sw - pad) / base.w, (sh - pad) / base.h)
    fitScale = clampVal(raw, adapter.minScale, adapter.fitCap)
    scale = fitScale
    const applied = adapter.applyScale(scale)
    curW = applied.w
    curH = applied.h
    const { w: cw, h: ch } = renderedDims()
    tx = Math.round((sw - cw) / 2)
    ty = Math.round((sh - ch) / 2)
    applyTransform()
    extraResize?.()
  }

  const zoomAt = (factor: number, clientX?: number, clientY?: number) => {
    const next = clampVal(scale * factor, adapter.minScale, adapter.maxScale)
    const sr = stage.getBoundingClientRect()
    const sw = sr.width || stageDims().w
    const sh = sr.height || stageDims().h
    const ax = clientX !== undefined && sr.width > 0 ? clientX - sr.left : sw / 2
    const ay = clientY !== undefined && sr.height > 0 ? clientY - sr.top : sh / 2
    const before = renderedDims()
    const applied = adapter.applyScale(next)
    scale = next
    curW = applied.w
    curH = applied.h
    const after = renderedDims()
    tx = ax - (ax - tx) * (after.w / Math.max(1, before.w))
    ty = ay - (ay - ty) * (after.h / Math.max(1, before.h))
    applyTransform()
  }

  const resetZoom = () => {
    adapter.onReset?.()
    fitToStage()
  }

  const panBy = (dx: number, dy: number) => {
    tx += dx
    ty += dy
    applyTransform()
  }

  const isZoomed = () => scale > fitScale + 0.04

  const onStageResize = () => {
    if (Math.abs(scale - fitScale) < 0.02) {
      adapter.onReset?.()
      fitToStage()
    } else {
      applyTransform()
      extraResize?.()
    }
  }

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.deltaY !== 0) {
        zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY)
      } else if (e.deltaX !== 0) {
        panBy(-e.deltaX, 0)
      }
    },
    { passive: false, signal },
  )

  const pointers = new Map<number, { x: number; y: number }>()
  let panning = false
  let activePointerId = -1
  let capturedPointerId = -1
  let downX = 0
  let downY = 0
  let startTx = 0
  let startTy = 0
  let moved = false
  let lastDragEndAt = 0
  let downOnBlank = false
  let pinching = false
  let pinchLastDist = 0
  let pinchLastMidX = 0
  let pinchLastMidY = 0

  const releaseCapture = (pointerId: number) => {
    if (capturedPointerId !== pointerId) return
    capturedPointerId = -1
    try {
      if (stage.hasPointerCapture?.(pointerId)) stage.releasePointerCapture(pointerId)
    } catch {
      /* ignore */
    }
  }

  stage.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      e.stopPropagation()
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        if (capturedPointerId !== -1) releaseCapture(capturedPointerId)
        panning = false
        activePointerId = -1
        moved = true
        downOnBlank = false
        pinching = true
        const pts = Array.from(pointers.values())
        const p1 = pts[0]!
        const p2 = pts[1]!
        pinchLastDist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        pinchLastMidX = (p1.x + p2.x) / 2
        pinchLastMidY = (p1.y + p2.y) / 2
        stage.classList.add('grabbing')
        return
      }
      if (pointers.size > 2) return
      pinching = false
      panning = true
      activePointerId = e.pointerId
      downX = e.clientX
      downY = e.clientY
      startTx = tx
      startTy = ty
      moved = false
      downOnBlank = e.target === stage
    },
    { signal },
  )

  stage.addEventListener(
    'pointermove',
    (e) => {
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      }
      if (pinching && pointers.size >= 2) {
        e.stopPropagation()
        const pts = Array.from(pointers.values())
        const p1 = pts[0]!
        const p2 = pts[1]!
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        const midX = (p1.x + p2.x) / 2
        const midY = (p1.y + p2.y) / 2
        if (pinchLastDist > 8 && dist > 8) {
          tx += midX - pinchLastMidX
          ty += midY - pinchLastMidY
          zoomAt(dist / pinchLastDist, midX, midY)
        }
        pinchLastDist = dist
        pinchLastMidX = midX
        pinchLastMidY = midY
        return
      }
      if (!panning || e.pointerId !== activePointerId) return
      e.stopPropagation()
      const dx = e.clientX - downX
      const dy = e.clientY - downY
      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true
        stage.classList.add('grabbing')
        try {
          stage.setPointerCapture(e.pointerId)
          capturedPointerId = e.pointerId
        } catch {
          /* ignore synthetic events */
        }
      }
      tx = startTx + dx
      ty = startTy + dy
      applyTransform()
    },
    { signal },
  )

  const endPan = (e: PointerEvent) => {
    pointers.delete(e.pointerId)
    releaseCapture(e.pointerId)
    if (pinching) {
      if (pointers.size < 2) {
        pinching = false
        pinchLastDist = 0
        panning = false
        activePointerId = -1
        lastDragEndAt = Date.now()
        stage.classList.remove('grabbing')
      }
      return
    }
    if (!panning || (activePointerId !== -1 && e.pointerId !== activePointerId)) return
    panning = false
    activePointerId = -1
    if (moved) lastDragEndAt = Date.now()
    stage.classList.remove('grabbing')
  }

  stage.addEventListener('pointerup', endPan, { signal })
  stage.addEventListener('pointercancel', endPan, { signal })

  stage.addEventListener(
    'dblclick',
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (Math.abs(scale - fitScale) < 0.08) zoomAt(1.6, e.clientX, e.clientY)
      else resetZoom()
    },
    { signal },
  )

  stage.addEventListener(
    'click',
    (e) => {
      e.stopPropagation()
      if (moved && Date.now() - lastDragEndAt < 200) {
        moved = false
        downOnBlank = false
        return
      }
      moved = false
      const shouldClose = downOnBlank && e.target === stage
      downOnBlank = false
      if (shouldClose) closeModal()
    },
    { signal },
  )

  const state: MountedCanvasState = {
    slideIndex,
    kind,
    body,
    restore,
    stage,
    listeners,
    fitToStage,
    onStageResize,
    zoomBy: zoomAt,
    panBy,
    isZoomed,
    resetZoom,
  }
  viewer.mountedChart = state
  fitToStage()
  requestAnimationFrame(() => {
    if (viewer.mountedChart !== state) return
    fitToStage()
  })
  return state
}

function makeSvgAdapter(svg: SVGSVGElement, fallbackW = 480, fallbackH = 300, fitCap = 3): CanvasZoomAdapter {
  const natRaw = svgNaturalSize(svg)
  const natW = natRaw.w > 0 ? natRaw.w : fallbackW
  const natH = natRaw.h > 0 ? natRaw.h : fallbackH
  if (!svg.getAttribute('viewBox') && natW > 0 && natH > 0) {
    svg.setAttribute('viewBox', `0 0 ${natW} ${natH}`)
  }
  return {
    minScale: 0.08,
    maxScale: 16,
    fitCap,
    baseSize: () => ({ w: natW, h: natH }),
    applyScale: (s) => {
      const w = Math.max(16, Math.round(natW * s))
      const h = Math.max(16, Math.round(natH * s))
      svg.style.maxWidth = 'none'
      svg.style.width = `${w}px`
      svg.style.height = `${h}px`
      return { w, h }
    },
  }
}

function makeImgAdapter(img: HTMLImageElement, natW: number, natH: number): CanvasZoomAdapter {
  const w0 = Math.max(16, natW)
  const h0 = Math.max(16, natH)
  return {
    minScale: 0.1,
    maxScale: 8,
    fitCap: 3,
    baseSize: () => ({ w: w0, h: h0 }),
    applyScale: (s) => {
      const w = Math.max(16, Math.round(w0 * s))
      const h = Math.max(16, Math.round(h0 * s))
      img.style.width = `${w}px`
      img.style.height = `${h}px`
      img.style.maxWidth = 'none'
      return { w, h }
    },
  }
}

function makeEchartsAdapter(
  chart: EChartsInstanceLike,
  body: HTMLElement,
  stage: HTMLElement,
): CanvasZoomAdapter {
  let bw = 0
  let bh = 0
  const measureBase = () => {
    const sw = stage.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1200)
    const sh = stage.clientHeight || (typeof window !== 'undefined' ? Math.max(240, window.innerHeight - 44) : 760)
    bw = Math.max(320, sw - 32)
    bh = Math.max(240, sh - 32)
  }
  measureBase()
  return {
    minScale: 0.5,
    maxScale: 4,
    fitCap: 1,
    baseSize: () => {
      if (!bw || !bh) measureBase()
      return { w: bw, h: bh }
    },
    applyScale: (s) => {
      if (!bw || !bh) measureBase()
      const w = Math.round(bw * s)
      const h = Math.round(bh * s)
      body.style.width = `${w}px`
      body.style.height = `${h}px`
      requestAnimationFrame(() => chart.resize())
      return { w, h }
    },
    onReset: () => {
      measureBase()
    },
  }
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0)
}

function unmountActiveChart(viewer: ActiveViewer): void {
  const ch = viewer.mountedChart
  if (!ch) return
  viewer.mountedChart = null
  ch.listeners.abort()
  ch.stage.classList.remove('chart-modal__stage')
  if (ch.kind === 'chart' && ch.body && ch.restore?.parent) {
    const modalHost = ch.body.parentElement
    if (modalHost) {
      modalHost.classList.remove('chart-modal__canvas')
      modalHost.style.transform = ''
    }
    ch.restore.parent.insertBefore(ch.body, ch.restore.next)
    ch.body.style.width = ''
    ch.body.style.height = ''
    const svg = ch.body.querySelector<SVGSVGElement>('svg')
    if (svg) {
      svg.style.width = ''
      svg.style.height = ''
      svg.style.maxWidth = ''
    }
    const back = ch.restore.parent as HTMLElement
    figExtras.get(back)?.resize?.()
    requestAnimationFrame(() => fitInlineSvg(back, true))
  }
}

function mountChartIntoSlide(viewer: ActiveViewer, slideIndex: number, containerEl: HTMLElement): void {
  const item = viewer.slides[slideIndex]
  if (!item || item.kind !== 'chart' || !item.originEl) return
  if (viewer.mountedChart?.slideIndex === slideIndex) return
  unmountActiveChart(viewer)

  const fig = item.originEl
  const body = chartBody(fig)
  if (!body) return
  const stage = containerEl.querySelector<HTMLElement>('.chart-modal__slot')
  const host = containerEl.querySelector<HTMLElement>('figure.chart--modal')
  if (!stage || !host) return

  const restore = { parent: body.parentNode as Node, next: body.nextSibling }
  const extra = figExtras.get(fig)
  const type = item.chartType || fig.dataset.type || ''

  host.appendChild(body)
  body.style.width = ''
  body.style.height = ''
  if (fig.dataset.chartStatus === 'ok') {
    for (const pending of Array.from(body.querySelectorAll(':scope > .chart-pending'))) pending.remove()
  }

  const svg = body.querySelector<SVGSVGElement>('svg')
  let adapter: CanvasZoomAdapter
  if (type === 'echarts' && extra?.chart) {
    adapter = makeEchartsAdapter(extra.chart, body, stage)
  } else if (svg) {
    adapter = makeSvgAdapter(svg, 640, 400, 3)
  } else {
    adapter = {
      minScale: 1,
      maxScale: 1,
      fitCap: 1,
      baseSize: () => ({ w: body.clientWidth || 480, h: body.clientHeight || 300 }),
      applyScale: () => ({ w: body.clientWidth || 480, h: body.clientHeight || 300 }),
    }
  }

  attachFreeCanvas(viewer, slideIndex, 'chart', stage, host, adapter, body, restore, extra?.resize)
}

function sanitizeSvgMarkup(svgText: string): SVGSVGElement | null {
  const cleaned = DOMPurify.sanitize(svgText, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    ADD_ATTR: ['xlink:href', 'href'],
  })
  const doc = new DOMParser().parseFromString(cleaned, 'image/svg+xml')
  const root = doc.documentElement
  const svg = root instanceof SVGSVGElement ? root : doc.querySelector('svg')
  if (!svg || doc.querySelector('parsererror')) return null
  return document.importNode(svg, true) as SVGSVGElement
}

function mountVectorFigureIntoSlide(viewer: ActiveViewer, slideIndex: number, containerEl: HTMLElement): void {
  const item = viewer.slides[slideIndex]
  if (!item || !isVectorFigure(item) || !item.src) return
  if (viewer.mountedChart?.slideIndex === slideIndex) return
  unmountActiveChart(viewer)

  const stage = containerEl.querySelector<HTMLElement>('.chart-modal__slot')
  const host = containerEl.querySelector<HTMLElement>('.chart-modal__vec-host')
  if (!stage || !host) return

  const wHint = Math.max(1, item.width ?? 480)
  const hHint = Math.max(1, item.height ?? 300)

  const mountFallbackImg = () => {
    const target: ParentNode = host.shadowRoot ?? host
    while (target.firstChild) target.removeChild(target.firstChild)
    const img = document.createElement('img')
    img.className = 'chart-modal__svg-fallback'
    img.src = item.src || ''
    img.alt = item.caption || item.title
    img.draggable = false
    target.appendChild(img)
    const natW = img.naturalWidth || wHint
    const natH = img.naturalHeight || hHint
    attachFreeCanvas(viewer, slideIndex, 'vector-figure', stage, host, makeImgAdapter(img, natW, natH))
  }

  // Reserve a state controller before async SVG fetch completes so quick closes/slide switches cancel cleanly
  const ctl = new AbortController()
  const placeholder: MountedCanvasState = {
    slideIndex,
    kind: 'vector-figure',
    body: null,
    stage,
    listeners: ctl,
    fitToStage: () => {},
    onStageResize: () => {},
    zoomBy: () => {},
    panBy: () => {},
    isZoomed: () => false,
    resetZoom: () => {},
  }
  viewer.mountedChart = placeholder

  void fetch(item.src, { signal: ctl.signal })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    })
    .then((svgText) => {
      if (ctl.signal.aborted || viewer.mountedChart !== placeholder) return
      const svg = sanitizeSvgMarkup(svgText)
      if (!svg) {
        mountFallbackImg()
        return
      }
      host.innerHTML = ''
      const shadow = host.shadowRoot ?? (typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'open' }) : null)
      if (shadow) {
        shadow.innerHTML = ''
        const st = document.createElement('style')
        st.textContent =
          ':host{display:block;line-height:0} svg{display:block;max-width:none;height:auto;user-select:none;-webkit-user-select:none}'
        shadow.appendChild(st)
        shadow.appendChild(svg)
      } else {
        host.appendChild(svg)
      }
      attachFreeCanvas(viewer, slideIndex, 'vector-figure', stage, host, makeSvgAdapter(svg, wHint, hHint, 4))
    })
    .catch(() => {
      if (ctl.signal.aborted || viewer.mountedChart !== placeholder) return
      mountFallbackImg()
    })
}

export function closeModal(): void {
  openSeq++
  const cur = active
  if (!cur) return
  try {
    cur.pswp.close()
  } catch {
    cleanupViewer(cur)
  }
}

function cleanupViewer(viewer: ActiveViewer): void {
  if (active === viewer) active = null
  unmountActiveChart(viewer)
  viewer.listeners.abort()
  document.documentElement.classList.remove('chart-modal-open')
  const opener = viewer.opener
  if (opener && opener.isConnected && typeof opener.focus === 'function') {
    try {
      opener.focus({ preventScroll: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * Viewer title of a chart: its number and caption, as under the figure ("图 5-2 插值结果"; spec board 07: no type tag, no
 * internal `MEA-L05#c2` id — S6Y audit-spec #10). The number is the build-time `data-fig-label` (figures/numbering.ts).
 */
export function slideTitleText(fig: HTMLElement): string {
  const L = (key: MessageKey): string => translate(currentLang(), key)
  const label = fig.dataset.figLabel || fig.querySelector('.lec-ff-no')?.textContent?.trim() || ''
  const caption = fig.querySelector('.lec-ff-caption')?.textContent?.trim() || fig.dataset.caption || fig.dataset.title || ''
  const text = [label, caption].filter(Boolean).join(' ')
  return text || L('chart.modal.defaultTitle')
}

/** A file name from the slide title ("图 5-2 插值结果" → "图_5-2_插值结果"). */
function exportFileName(slide: ViewerSlide, ext: string): string {
  const base = (slide.title || slide.id || 'figure').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 80)
  return `${base || 'figure'}.${ext}`
}

function triggerDownload(href: string, name: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * Viewer export (spec board 07: "导出放在查看器里"; S6Y audit-spec #8): a figure downloads its file (the original when the
 * figure pack has one); a chart downloads its drawing as SVG (ECharts uses the SVG renderer, Mermaid and WaveDrom are SVG),
 * or PNG when the chart fell back to a canvas.
 */
export function exportSlide(slide: ViewerSlide | undefined, liveBody: HTMLElement | null = null): void {
  if (!slide || typeof document === 'undefined') return
  if (slide.kind === 'figure') {
    const href = slide.originalUrl || slide.src
    if (!href) return
    const ext = (href.split(/[?#]/, 1)[0]!.split('.').pop() || 'png').toLowerCase()
    triggerDownload(href, exportFileName(slide, ext))
    return
  }
  const body = liveBody ?? (slide.originEl ? chartBody(slide.originEl) : null)
  if (!body) return
  const svg = body.querySelector<SVGSVGElement>('svg')
  if (svg) {
    const clone = svg.cloneNode(true) as SVGSVGElement
    if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const xml = new XMLSerializer().serializeToString(clone)
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }))
    triggerDownload(url, exportFileName(slide, 'svg'))
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return
  }
  const canvas = body.querySelector<HTMLCanvasElement>('canvas')
  if (canvas) triggerDownload(canvas.toDataURL('image/png'), exportFileName(slide, 'png'))
}

/** Collect every figure (`<LectureFigure>`) and rendered diagram (`figure.chart`) in page reading order. */
export function collectPageViewerSlides(): ViewerSlide[] {
  if (typeof document === 'undefined') return []
  const out: ViewerSlide[] = []
  const nodes = document.querySelectorAll<HTMLElement>(
    '.vp-doc .lec-fig-item[data-lec-fig-slide], .vp-doc figure.chart:not(.chart--modal)',
  )
  for (const el of nodes) {
    const rawSlide = el.dataset.lecFigSlide
    if (rawSlide) {
      try {
        const parsed = JSON.parse(rawSlide) as Omit<ViewerSlide, 'originEl'>
        out.push({ ...parsed, originEl: el })
      } catch {
        /* skip malformed metadata */
      }
      continue
    }
    if (el.matches('figure.chart')) {
      const body = chartBody(el)
      if (!body) continue
      out.push({
        kind: 'chart',
        id: el.dataset.id || el.id || `chart-${out.length + 1}`,
        title: slideTitleText(el),
        chartType: el.dataset.type || '',
        originEl: el,
      })
    }
  }
  return out
}

function isSvgPath(url: string | undefined): boolean {
  if (!url) return false
  const low = url.toLowerCase()
  return low.split(/[?#]/, 1)[0]!.endsWith('.svg') || low.startsWith('data:image/svg+xml')
}

function isVectorFigure(slide: ViewerSlide): boolean {
  return slide.kind === 'figure' && isSvgPath(slide.src)
}

function toPhotoSwipeItem(slide: ViewerSlide): InternalSlideData {
  const vw = typeof window !== 'undefined' ? Math.max(320, window.innerWidth) : 1200
  const vh = typeof window !== 'undefined' ? Math.max(240, window.innerHeight - 44) : 760
  if (slide.kind === 'chart') {
    const t = (slide.chartType || 'echarts').replace(/[^a-z0-9_-]/gi, '')
    return {
      html: `<div class="chart-modal__slot"><figure class="chart chart--modal" data-type="${t}"></figure></div>`,
      width: vw,
      height: vh,
      lecSlide: slide,
      isCanvas: true,
    }
  }
  if (isVectorFigure(slide)) {
    return {
      html: '<div class="chart-modal__slot chart-modal__slot--vec"><div class="chart-modal__vec-host"></div></div>',
      width: vw,
      height: vh,
      lecSlide: slide,
      isCanvas: true,
    }
  }
  return {
    src: slide.src || '',
    width: Math.max(1, slide.width ?? 1000),
    height: Math.max(1, slide.height ?? 700),
    alt: slide.caption || slide.title,
    lecSlide: slide,
  }
}

export function openUnifiedViewer(
  target: ViewerSlide | ViewerSlide[],
  opener: HTMLElement | null = null,
  explicitStartIndex = 0,
): void {
  if (typeof document === 'undefined') return
  if (active) closeModal()
  const seq = ++openSeq

  let slides: ViewerSlide[]
  let startIndex = 0

  if (Array.isArray(target)) {
    slides = target
    startIndex = Math.max(0, Math.min(target.length - 1, explicitStartIndex))
  } else {
    const pageSlides = collectPageViewerSlides()
    const matchIdx = pageSlides.findIndex(
      (s) =>
        (target.originEl && s.originEl === target.originEl) ||
        (s.kind === target.kind && s.id === target.id && (!target.src || s.src === target.src)),
    )
    if (matchIdx >= 0) {
      slides = pageSlides
      startIndex = matchIdx
    } else {
      slides = [target]
      startIndex = 0
    }
  }

  if (slides.length === 0) return

  const activeEl = document.activeElement as HTMLElement | null
  const firstOrigin = slides[startIndex]?.originEl ?? null
  const restoreTo = opener ?? (activeEl && activeEl !== document.body && firstOrigin?.contains(activeEl) ? activeEl : null)

  void loadPhotoSwipe().then(
    (Ctor) => {
      if (seq !== openSeq) return
      startViewer(Ctor, slides, startIndex, restoreTo)
    },
    () => {
      /* library chunk failed to load (offline): the inline figure stays as it is */
    },
  )
}

function startViewer(
  PhotoSwipeClass: PhotoSwipeCtor,
  slides: ViewerSlide[],
  startIndex: number,
  restoreTo: HTMLElement | null,
): void {
  const L = (key: MessageKey): string => translate(currentLang(), key)
  const titleId = 'chart-modal-title-' + ++titleSeq
  const dataSource = slides.map(toPhotoSwipeItem)

  const pswpOpts: PhotoSwipeOptions = {
    dataSource,
    index: startIndex,
    mainClass: 'chart-modal lec-viewer',
    bgOpacity: 1,
    spacing: 0.06,
    loop: false,
    allowPanToNext: false,
    wheelToZoom: true,
    closeOnVerticalDrag: false,
    pinchToClose: false,
    arrowPrev: false,
    arrowNext: false,
    zoom: false,
    close: false,
    counter: false,
    trapFocus: true,
    returnFocus: false,
    escKey: true,
    arrowKeys: true,
    bgClickAction: 'close',
    imageClickAction: 'zoom',
    tapAction: 'close',
    showHideAnimationType: 'none',
    maxZoomLevel: 8,
    paddingFn: (_viewportSize, itemData) =>
      (itemData as InternalSlideData).isCanvas
        ? { top: 44, bottom: 0, left: 0, right: 0 }
        : { top: 56, bottom: 20, left: 20, right: 20 },
  }

  const pswp = new PhotoSwipeClass(pswpOpts)
  const listeners = new AbortController()
  const viewer: ActiveViewer = {
    pswp,
    opener: restoreTo,
    slides,
    listeners,
    mountedChart: null,
    barEl: null,
  }
  active = viewer

  const syncHeader = () => {
    const bar = viewer.barEl
    if (!bar) return
    const idx = pswp.currIndex
    const cur = slides[idx]
    const titleEl = bar.querySelector<HTMLElement>('.chart-modal__title')
    if (titleEl && cur) titleEl.textContent = cur.title
    const counterEl = bar.querySelector<HTMLElement>('.chart-modal__counter')
    if (counterEl) {
      if (slides.length > 1) {
        counterEl.textContent = `${idx + 1} / ${slides.length}`
        counterEl.removeAttribute('hidden')
      } else {
        counterEl.setAttribute('hidden', '')
      }
    }
    const prevBtn = bar.querySelector<HTMLButtonElement>('[data-m="prev"]')
    const nextBtn = bar.querySelector<HTMLButtonElement>('[data-m="next"]')
    if (prevBtn) prevBtn.disabled = idx <= 0
    if (nextBtn) nextBtn.disabled = idx >= slides.length - 1

    const origLink = bar.querySelector<HTMLAnchorElement>('[data-m="original"]')
    if (origLink) {
      if (cur?.originalUrl) {
        origLink.href = cur.originalUrl
        origLink.removeAttribute('hidden')
      } else {
        origLink.removeAttribute('href')
        origLink.setAttribute('hidden', '')
      }
    }

    if (pswp.element) {
      const isRasterFig = Boolean(cur && cur.kind === 'figure' && !isSvgPath(cur.src))
      pswp.element.classList.toggle('lec-viewer--raster', isRasterFig)
    }
  }

  const zoomCurrent = (mode: 'in' | 'out' | 'reset') => {
    const idx = pswp.currIndex
    const cur = slides[idx]
    if (!cur) return
    if (viewer.mountedChart?.slideIndex === idx) {
      if (mode === 'in') viewer.mountedChart.zoomBy(1.3)
      else if (mode === 'out') viewer.mountedChart.zoomBy(1 / 1.3)
      else viewer.mountedChart.resetZoom()
      return
    }
    const slide = pswp.currSlide
    if (!slide) return
    const center = { x: pswp.viewportSize.x / 2, y: pswp.viewportSize.y / 2 }
    if (mode === 'reset') {
      slide.zoomTo(slide.zoomLevels.fit, center, 150)
    } else {
      const factor = mode === 'in' ? 1.3 : 1 / 1.3
      const next = Math.max(slide.zoomLevels.min, Math.min(slide.zoomLevels.max, slide.currZoomLevel * factor))
      slide.zoomTo(next, center, 120)
    }
  }

  pswp.on('uiRegister', () => {
    pswp.ui?.registerElement({
      name: 'lec-modal-bar',
      order: 9,
      isButton: false,
      appendTo: 'wrapper',
      html:
        `<div class="chart-modal__bar">` +
        `<span class="chart-modal__title" id="${titleId}"></span>` +
        `<span class="chart-modal__counter" hidden></span>` +
        `<span class="chart-modal__ops">` +
        (slides.length > 1
          ? `<button type="button" data-m="prev" title="${L('chart.modal.prev')}" aria-label="${L('chart.modal.prev')}">&#8249;</button>` +
            `<button type="button" data-m="next" title="${L('chart.modal.next')}" aria-label="${L('chart.modal.next')}">&#8250;</button>`
          : '') +
        `<a class="chart-modal__orig" data-m="original" target="_blank" rel="noopener noreferrer" hidden>${L('lecture.fig.openOriginal')}</a>` +
        `<button type="button" class="chart-modal__export" data-m="export" title="${L('chart.modal.exportTitle')}" aria-label="${L('chart.modal.exportTitle')}">${L('chart.modal.export')}</button>` +
        `<button type="button" data-m="in" title="${L('chart.modal.zoomIn')}" aria-label="${L('chart.modal.zoomIn')}">&#43;</button>` +
        `<button type="button" data-m="out" title="${L('chart.modal.zoomOut')}" aria-label="${L('chart.modal.zoomOut')}">&#8722;</button>` +
        `<button type="button" data-m="reset" title="${L('chart.modal.reset')}" aria-label="${L('chart.modal.reset')}">&#8634;</button>` +
        `<button type="button" data-m="close" title="${L('chart.modal.closeTitle')}" aria-label="${L('chart.modal.close')}">&#10005;</button>` +
        `</span></div>`,
      onInit: (el) => {
        viewer.barEl = el
        el.addEventListener(
          'pointerdown',
          (ev) => ev.stopPropagation(),
          { signal: listeners.signal },
        )
        el.addEventListener(
          'click',
          (ev) => {
            const btn = (ev.target as HTMLElement | null)?.closest?.('[data-m]') as HTMLElement | null
            if (!btn) return
            const act = btn.getAttribute('data-m')
            if (act === 'close') {
              ev.preventDefault()
              closeModal()
            } else if (act === 'prev') {
              ev.preventDefault()
              pswp.prev()
            } else if (act === 'next') {
              ev.preventDefault()
              pswp.next()
            } else if (act === 'in' || act === 'out' || act === 'reset') {
              ev.preventDefault()
              zoomCurrent(act)
            } else if (act === 'export') {
              ev.preventDefault()
              exportSlide(slides[pswp.currIndex], viewer.mountedChart?.slideIndex === pswp.currIndex ? viewer.mountedChart.body : null)
            }
          },
          { signal: listeners.signal },
        )
      },
    })
  })

  pswp.on('calcSlideSize', ({ slide }) => {
    if (!(slide.data as InternalSlideData).isCanvas) return
    const w = Math.max(1, slide.panAreaSize.x)
    const h = Math.max(1, slide.panAreaSize.y)
    slide.width = w
    slide.height = h
    slide.zoomLevels.fit = 1
    slide.zoomLevels.fill = 1
    slide.zoomLevels.vFill = 1
    slide.zoomLevels.initial = 1
    slide.zoomLevels.secondary = 1
    slide.zoomLevels.min = 1
    slide.zoomLevels.max = 1
  })

  pswp.on('resize', () => {
    viewer.mountedChart?.onStageResize()
  })

  pswp.on('contentActivate', ({ content }) => {
    const meta = (content.data as InternalSlideData).lecSlide
    if (meta?.kind === 'chart' && content.element) {
      mountChartIntoSlide(viewer, content.index, content.element)
    } else if (meta && isVectorFigure(meta) && content.element) {
      mountVectorFigureIntoSlide(viewer, content.index, content.element)
    } else {
      unmountActiveChart(viewer)
    }
    syncHeader()
  })

  pswp.on('contentDeactivate', ({ content }) => {
    if (viewer.mountedChart?.slideIndex === content.index) {
      unmountActiveChart(viewer)
    }
  })

  pswp.on('change', () => {
    syncHeader()
  })

  pswp.on('keydown', (ev) => {
    const ke = ev.originalEvent
    if (ke.key === 'Tab') {
      const rootEl = pswp.element
      if (!rootEl) return
      const items = focusables(rootEl)
      if (!items.length) {
        ke.preventDefault()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const cur = document.activeElement
      if (ke.shiftKey) {
        if (cur === first || !rootEl.contains(cur)) {
          ke.preventDefault()
          last.focus()
        } else {
          // Allow native Shift+Tab between internal controls while keeping focus inside dialog.
          return
        }
      } else if (cur === last || !rootEl.contains(cur)) {
        ke.preventDefault()
        first.focus()
      } else {
        return
      }
      return
    }
    const mc = viewer.mountedChart?.slideIndex === pswp.currIndex ? viewer.mountedChart : null
    if (mc) {
      const step = ke.shiftKey ? 120 : 80
      if (ke.key === 'ArrowUp') {
        ke.preventDefault()
        ev.preventDefault()
        mc.panBy(0, step)
        return
      }
      if (ke.key === 'ArrowDown') {
        ke.preventDefault()
        ev.preventDefault()
        mc.panBy(0, -step)
        return
      }
      if ((ke.key === 'ArrowLeft' || ke.key === 'ArrowRight') && (ke.shiftKey || mc.isZoomed() || slides.length <= 1)) {
        ke.preventDefault()
        ev.preventDefault()
        mc.panBy(ke.key === 'ArrowLeft' ? step : -step, 0)
        return
      }
    }
    if (ke.key === '+' || ke.key === '=') {
      ke.preventDefault()
      zoomCurrent('in')
    } else if (ke.key === '-' || ke.key === '_') {
      ke.preventDefault()
      zoomCurrent('out')
    } else if (ke.key === '0') {
      ke.preventDefault()
      zoomCurrent('reset')
    }
  })

  pswp.on('beforeOpen', () => {
    document.documentElement.classList.add('chart-modal-open')
    if (pswp.element) {
      pswp.element.setAttribute('aria-labelledby', titleId)
      pswp.element.setAttribute('aria-modal', 'true')
    }
  })

  pswp.on('afterInit', () => {
    syncHeader()
    const closeBtn = viewer.barEl?.querySelector<HTMLElement>('[data-m="close"]')
    try {
      closeBtn?.focus({ preventScroll: true })
    } catch {
      /* ignore */
    }
  })

  pswp.on('close', () => {
    unmountActiveChart(viewer)
    document.documentElement.classList.remove('chart-modal-open')
  })

  pswp.on('destroy', () => {
    cleanupViewer(viewer)
  })

  pswp.init()
}

/** Open an inline diagram (`figure.chart`) in the unified viewer (backwards-compatible entry). */
export function openChartModal(fig: HTMLElement, opener: HTMLElement | null = null): void {
  const body = chartBody(fig)
  if (!body) return
  openUnifiedViewer(
    {
      kind: 'chart',
      id: fig.dataset.id || fig.id || 'chart',
      title: slideTitleText(fig),
      chartType: fig.dataset.type || '',
      originEl: fig,
    },
    opener,
  )
}
