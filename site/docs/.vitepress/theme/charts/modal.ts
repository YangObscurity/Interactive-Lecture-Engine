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

interface ChartZoomApi {
  zoom(factor: number): void
  reset(): void
  zoomTo?(scale: number): void
}

interface InternalSlideData extends SlideData {
  lecSlide?: ViewerSlide
}

interface MountedChartState {
  slideIndex: number
  body: HTMLElement
  restore: { parent: Node; next: Node | null }
  stage: HTMLElement
  listeners: AbortController
  zoomApi: ChartZoomApi | null
  fitToStage: () => void
  zoomBy: (factor: number) => void
  resetZoom: () => void
}

interface ActiveViewer {
  pswp: PhotoSwipe
  opener: HTMLElement | null
  slides: ViewerSlide[]
  listeners: AbortController
  mountedChart: MountedChartState | null
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

function makeEchartsZoom(chart: EChartsInstanceLike, body: HTMLElement): ChartZoomApi {
  let z = 1
  let bw = 0
  let bh = 0
  const apply = () => {
    if (!bw) {
      bw = body.clientWidth
      bh = body.clientHeight
    }
    if (Math.abs(z - 1) < 0.001) {
      body.style.width = ''
      body.style.height = ''
    } else {
      body.style.width = Math.round(bw * z) + 'px'
      body.style.height = Math.round(bh * z) + 'px'
    }
    requestAnimationFrame(() => chart.resize())
  }
  return {
    zoom(f) {
      z = Math.min(4, Math.max(0.5, z * f))
      apply()
    },
    reset() {
      z = 1
      apply()
    },
  }
}

function makeSvgSizeZoom(svg: SVGSVGElement): ChartZoomApi {
  const nat = svgNaturalSize(svg)
  let z = 1
  const clamp = (v: number) => Math.min(12, Math.max(0.05, v))
  const apply = () => {
    if (!nat.w || !nat.h) return
    svg.style.maxWidth = 'none'
    svg.style.width = Math.round(nat.w * z) + 'px'
    svg.style.height = Math.round(nat.h * z) + 'px'
  }
  return {
    zoom(f) {
      z = clamp(z * f)
      apply()
    },
    zoomTo(s) {
      z = clamp(s)
      apply()
    },
    reset() {
      z = 1
      apply()
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
  if (ch.restore.parent) {
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
  stage.classList.add('chart-modal__stage')

  const restore = { parent: body.parentNode as Node, next: body.nextSibling }
  const extra = figExtras.get(fig)
  const type = item.chartType || fig.dataset.type || ''

  host.appendChild(body)
  body.style.width = ''
  body.style.height = ''
  // the inline figure hides its "loading" placeholder by status; the viewer's host figure has no status, so drop it here
  if (fig.dataset.chartStatus === 'ok') {
    for (const pending of Array.from(body.querySelectorAll(':scope > .chart-pending'))) pending.remove()
  }

  const svg = body.querySelector<SVGSVGElement>('svg')
  const api: ChartZoomApi | null =
    type === 'echarts' && extra?.chart ? makeEchartsZoom(extra.chart, body) : svg ? makeSvgSizeZoom(svg) : null

  const fitToStage = () => {
    if (type === 'echarts') {
      extra?.resize?.()
      return
    }
    if (!svg || !api?.zoomTo) return
    const nat = svgNaturalSize(svg)
    if (!nat.w || !nat.h) return
    const pad = 24
    const s = Math.min((stage.clientWidth - pad) / nat.w, (stage.clientHeight - pad) / nat.h)
    if (Number.isFinite(s) && s > 0) api.zoomTo(s)
  }

  const zoomBy = (f: number) => {
    if (!api) return
    const px = stage.scrollWidth ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth : 0.5
    const py = stage.scrollHeight ? (stage.scrollTop + stage.clientHeight / 2) / stage.scrollHeight : 0.5
    api.zoom(f)
    stage.scrollLeft = px * stage.scrollWidth - stage.clientWidth / 2
    stage.scrollTop = py * stage.scrollHeight - stage.clientHeight / 2
  }

  const resetZoom = () => {
    if (type === 'echarts') api?.reset()
    fitToStage()
    stage.scrollTo(0, 0)
  }

  const listeners = new AbortController()
  const { signal } = listeners

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
    },
    { passive: false, signal },
  )

  let panning = false
  let lastX = 0
  let lastY = 0
  let downX = 0
  let downY = 0
  let moved = false

  stage.addEventListener(
    'pointerdown',
    (e) => {
      // Prevent PhotoSwipe swipe/drag gestures from stealing chart panning inside `.chart-modal__stage`.
      e.stopPropagation()
    },
    { signal },
  )

  stage.addEventListener(
    'mousedown',
    (e) => {
      downX = e.clientX
      downY = e.clientY
      moved = false
      if (e.button !== 0) return
      panning = true
      lastX = e.clientX
      lastY = e.clientY
      stage.classList.add('grabbing')
    },
    { signal },
  )

  window.addEventListener(
    'mousemove',
    (e) => {
      if (panning && (Math.abs(e.clientX - downX) > 6 || Math.abs(e.clientY - downY) > 6)) moved = true
      if (!panning) return
      stage.scrollLeft -= e.clientX - lastX
      stage.scrollTop -= e.clientY - lastY
      lastX = e.clientX
      lastY = e.clientY
    },
    { signal },
  )

  window.addEventListener(
    'mouseup',
    () => {
      panning = false
      stage.classList.remove('grabbing')
    },
    { signal },
  )

  stage.addEventListener(
    'click',
    (e) => {
      e.stopPropagation()
      if (moved) return
      closeModal()
    },
    { signal },
  )

  viewer.mountedChart = {
    slideIndex,
    body,
    restore,
    stage,
    listeners,
    zoomApi: api,
    fitToStage,
    zoomBy,
    resetZoom,
  }

  requestAnimationFrame(() => {
    if (viewer.mountedChart?.stage !== stage) return
    extra?.resize?.()
    fitToStage()
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

function toPhotoSwipeItem(slide: ViewerSlide): InternalSlideData {
  if (slide.kind === 'chart') {
    const t = (slide.chartType || 'echarts').replace(/[^a-z0-9_-]/gi, '')
    return {
      html: `<div class="chart-modal__slot"><figure class="chart chart--modal" data-type="${t}"></figure></div>`,
      width: 1200,
      height: 800,
      lecSlide: slide,
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

function isSvgPath(url: string | undefined): boolean {
  if (!url) return false
  return url.toLowerCase().split(/[?#]/, 1)[0]!.endsWith('.svg')
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
    maxZoomLevel: 4,
    padding: { top: 56, bottom: 20, left: 20, right: 20 },
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
    if (cur.kind === 'chart' && viewer.mountedChart?.slideIndex === idx) {
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

  pswp.on('contentActivate', ({ content }) => {
    const meta = (content.data as InternalSlideData).lecSlide
    if (meta?.kind === 'chart' && content.element) {
      mountChartIntoSlide(viewer, content.index, content.element)
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
