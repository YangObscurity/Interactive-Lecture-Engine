/**
 * charts/page.ts — one chart run per page visit ("generation").
 *
 * Fixes vs V1 (review FE-025/026/027/033/034):
 *   - no shared in-flight promise: every mount starts its own generation immediately; the previous
 *     page's run is aborted by its own ctx and can never block or swallow the new one;
 *   - placeholders are claimed synchronously before the first await (V1 d48d0cc4);
 *   - abort checks after every await; every renderer returns a disposer, owned by a per-page
 *     ChartRegistry that is closed on leave (LIFO, error-isolated);
 *   - `window.__CHARTS_DONE__` is reset at the start of each generation and set true only when
 *     that same generation settles; then `lecture:charts-settled` ({ path, count }) is dispatched;
 *   - the dark/light MutationObserver that re-renders mermaid is page-scoped (created only when the
 *     page has charts, disconnected on leave) and only touches this page's figures.
 */
import { CHART_INLINE_MERMAID } from '../../site.config.mts'
import { CHARTS_SETTLED_EVENT } from '../core/lifecycle'
import { currentLang, translate } from '../../i18n/index.ts'
import type { ChartsSettledDetail as CoreSettledDetail } from '../core/lifecycle'
import { extractMermaidCode, injectSource, showError } from './dom'
import { closeModal, modalOrigin, openChartModal, preloadViewer } from './modal'
import { ChartRegistry } from './registry'
import type { Renderer } from './renderers/types'
import type { InlineMermaidConfig } from './scan'
import { INLINE_SOURCE, claimInlineMermaidBlocks, claimSidecarFigures, removeStaleInlineFigures } from './scan'
import { INLINE_MERMAID_META_CLASS } from '../../figures/numbering.ts'
import { chartSourceOf, type SidecarData } from './sidecar'
import { bumpSeq } from './state'
import type { Disposer } from './state'
import { attachTools, ensureSkeleton } from './toolbar'

export { CHARTS_SETTLED_EVENT }

/** `lecture:charts-settled` detail: the core contract (`{ path }`) plus chart run facts. */
export interface ChartsSettledDetail extends CoreSettledDetail {
  /** number of chart figures handled by this generation */
  count: number
  generation: number
  ms: number
}

export interface ChartsDeps {
  loadSidecar(lecture: string): Promise<SidecarData | null>
  waitFonts(signal: AbortSignal, text: string): Promise<unknown>
  renderers: Readonly<Record<string, Renderer>>
  inline?: InlineMermaidConfig
  /** Theme re-render debounce (V1: 80 ms). */
  themeDebounceMs?: number
  /** Optional P5 WP-R1 chrome slot mounter (`FigureFrame`). Omitted in unit tests without Vite virtual modules. */
  mountFrame?(fig: HTMLElement, meta: { type: string; index: number; lectureNo: number; label?: string; title: string; caption: string }, signal: AbortSignal): void
}

// ---------------------------------------------------------------------------------------------
// generation bookkeeping (module state: numbers only, nothing keyed by DOM except the WeakMap)
// ---------------------------------------------------------------------------------------------

let generationSeq = 0
const liveGenerations = new Set<number>()
const claimOwner = new WeakMap<Element, number>()

export interface ChartsStats {
  generation: number
  path: string | null
  running: boolean
  lastSettle: { generation: number; path: string; count: number; ms: number; at: string } | null
}

export const stats: ChartsStats = { generation: 0, path: null, running: false, lastSettle: null }

/** The page currently mounted (debug panel actions operate on it). */
let currentPage: PageCharts | null = null
export function getCurrentPage(): PageCharts | null {
  return currentPage
}
function markCurrent(page: PageCharts | null): void {
  currentPage = page
}

function setDone(v: boolean): void {
  if (typeof window !== 'undefined') window.__CHARTS_DONE__ = v
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// ---------------------------------------------------------------------------------------------

interface TrackedChart {
  fig: HTMLElement
  type: string
  code: string
  release: Disposer | null
}

export class PageCharts {
  readonly registry = new ChartRegistry()
  private pass: AbortController | null = null
  private charts: TrackedChart[] = []
  private themeWatch: Disposer | null = null
  private destroyed = false
  private readonly inline: InlineMermaidConfig

  constructor(
    readonly path: string,
    private readonly pageSignal: AbortSignal,
    private readonly deps: ChartsDeps,
    private readonly root: ParentNode = document,
  ) {
    this.inline = deps.inline ?? CHART_INLINE_MERMAID
    markCurrent(this)
  }

  /** Run a generation now. Resolves when it settles (or was aborted). */
  run(): Promise<void> {
    if (this.destroyed || this.pageSignal.aborted) return Promise.resolve()
    this.endPass()
    const gen = ++generationSeq
    liveGenerations.add(gen)
    const pass = new AbortController()
    this.pass = pass
    const onPageAbort = () => pass.abort()
    this.pageSignal.addEventListener('abort', onPageAbort, { once: true })
    pass.signal.addEventListener(
      'abort',
      () => {
        liveGenerations.delete(gen)
        this.pageSignal.removeEventListener('abort', onPageAbort)
      },
      { once: true },
    )
    stats.generation = gen
    stats.path = this.path
    stats.running = true
    return this.runPass(gen, pass.signal).finally(() => {
      if (stats.generation === gen) stats.running = false
    })
  }

  /** Abort the running pass and dispose everything it created (registry stays open). */
  private endPass(): void {
    if (this.pass) {
      this.pass.abort()
      this.pass = null
    }
    this.charts = []
    this.themeWatch = null // its disposer is owned by the registry
    this.registry.disposeAll()
  }

  /** Debug: dispose and re-render every chart of this page. */
  rerender(): Promise<void> {
    return this.run()
  }

  /** Debug: dispose everything (charts stay claimed but empty until the next visit / rerender). */
  disposeAll(): void {
    this.endPass()
    if (stats.path === this.path) stats.running = false
  }

  /** ctx.defer target: leave the page. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.pass) this.pass.abort()
    this.pass = null
    this.charts = []
    this.registry.close()
    if (currentPage === this) markCurrent(null)
  }

  // -------------------------------------------------------------------------------------------

  private hooks(gen: number) {
    return {
      isStale: (el: Element) => {
        const owner = claimOwner.get(el)
        return owner !== undefined && !liveGenerations.has(owner)
      },
      own: (el: Element) => {
        claimOwner.set(el, gen)
      },
    }
  }

  private async runPass(gen: number, signal: AbortSignal): Promise<void> {
    const started = now()
    // a modal left open by a previous page whose figure is gone: close it before scanning
    const origin = modalOrigin()
    if (origin && !origin.isConnected) closeModal()

    // ---- synchronous claim (before the first await) ----
    const hooks = this.hooks(gen)
    removeStaleInlineFigures(this.root, hooks)
    const figs = claimSidecarFigures(this.root, hooks)
    const blocks = claimInlineMermaidBlocks(this.root, this.inline, hooks)

    if (!figs.length && !blocks.length) {
      setDone(true)
      this.settle(gen, signal, 0, started)
      return
    }
    setDone(false)
    this.registry.add('modal', () => {
      const o = modalOrigin()
      if (o && (o === this.root || (this.root as Node).contains?.(o))) closeModal()
    })
    this.watchTheme(signal)

    const jobs: Promise<void>[] = []
    let count = 0

    // The number is assigned at build time (figures/numbering.ts via figures/markdown.ts: charts and <LectureFigure> share
    // one sequence per lecture) and arrives as `data-fig-no` / `data-fig-lec` / `data-fig-label`; the runtime never counts.
    // Only figures without it (inline ```mermaid blocks created here) fall back to their position among the page's charts.
    const figureIndexOf = (fig: HTMLElement): number => {
      const fromBuild = Number(fig.dataset.figNo)
      if (Number.isFinite(fromBuild) && fromBuild > 0) return fromBuild
      const all = Array.from(this.root.querySelectorAll<HTMLElement>('figure.chart:not(.chart--modal)'))
      const idx = all.indexOf(fig)
      return idx >= 0 ? idx + 1 : 1
    }
    const lectureNoOf = (fig: HTMLElement): number => {
      if (fig.dataset.figLec !== undefined && fig.dataset.figLec !== '') return Number(fig.dataset.figLec) || 0
      const fromData = /L(\d+)$/i.exec(fig.dataset.lecture || '')
      if (fromData?.[1]) return Number(fromData[1])
      const fromPath = /\/L(\d+)(?:\.html)?$/i.exec(this.path)
      return fromPath?.[1] ? Number(fromPath[1]) : 0
    }
    const mountChrome = (fig: HTMLElement, type: string, title = '', caption = '') => {
      this.deps.mountFrame?.(
        fig,
        { type, index: figureIndexOf(fig), lectureNo: lectureNoOf(fig), label: fig.dataset.figLabel || '', title, caption },
        signal,
      )
    }

    // ---- inline ```mermaid blocks (figures created synchronously, rendered concurrently: V1) ----
    const inlineTasks: Array<{ fig: HTMLElement; code: string }> = []
    for (const block of blocks) {
      const code = extractMermaidCode(block)
      if (!code) {
        // no source: keep the original code block rather than an empty chart (ledger 3.1)
        delete block.dataset.mermaidRendered
        block.style.display = ''
        continue
      }
      const prevMeta = block.previousElementSibling as HTMLElement | null
      if (prevMeta?.classList?.contains(INLINE_MERMAID_META_CLASS)) {
        if (prevMeta.dataset.figNo) block.dataset.figNo = prevMeta.dataset.figNo
        if (prevMeta.dataset.figLec) block.dataset.figLec = prevMeta.dataset.figLec
        if (prevMeta.dataset.figLabel) block.dataset.figLabel = prevMeta.dataset.figLabel
        prevMeta.remove()
      }
      const fig = document.createElement('figure')
      fig.className = 'chart ' + this.inline.className
      fig.dataset.type = 'mermaid'
      fig.dataset.id = 'inline_' + bumpSeq()
      if (block.dataset.figNo) fig.dataset.figNo = block.dataset.figNo
      if (block.dataset.figLec) fig.dataset.figLec = block.dataset.figLec
      if (block.dataset.figLabel) fig.dataset.figLabel = block.dataset.figLabel
      // contract (V1 5c6e5a18): inline figures never carry data-lecture (check_figs2.py 1:1 gate)
      fig.dataset.source = INLINE_SOURCE
      block.parentNode?.insertBefore(fig, block)
      block.style.display = 'none'
      claimOwner.set(fig, gen)
      claimOwner.set(block, gen)

      const body = ensureSkeleton(fig)
      if (this.inline.keepSource) injectSource(fig, code)
      fig.dataset.rendered = '1'
      fig.dataset.chartStatus = 'loading'
      if (!body.childElementCount) body.innerHTML = '<div class="chart-pending">' + translate(currentLang(), 'chart.pending.flow') + '</div>'
      count++
      inlineTasks.push({ fig, code })
    }
    for (const { fig, code } of inlineTasks) {
      mountChrome(fig, 'mermaid', fig.dataset.title ?? '', fig.dataset.caption ?? '')
      jobs.push(
        (async () => {
          try {
            const ok = await this.renderOne(fig, 'mermaid', code, signal)
            if (!ok) return
            fig.dataset.chartStatus = 'ok'
          } catch (e) {
            if (signal.aborted) return
            fig.dataset.chartStatus = 'error'
            console.warn('[chart] Inline mermaid render failed, falling back to code block:', e)
            fig.remove()
            const prev = fig.nextElementSibling as HTMLElement | null
            if (prev?.matches?.('div[class*="language-"]')) prev.style.display = ''
          }
        })(),
      )
    }

    // ---- sidecar figures, grouped by lecture; sequential within a lecture (V1 order) ----
    const byLecture = new Map<string, HTMLElement[]>()
    for (const f of figs) {
      const lec = f.dataset.lecture || ''
      const list = byLecture.get(lec)
      if (list) list.push(f)
      else byLecture.set(lec, [f])
    }
    count += figs.length

    for (const [lecture, list] of byLecture) {
      jobs.push(
        (async () => {
          const data = await this.deps.loadSidecar(lecture)
          if (signal.aborted) return
          for (const fig of list) {
            if (signal.aborted) return
            const key = fig.dataset.id || ''
            const def = data?.[key]
            if (def?.type) fig.dataset.type = def.type
            const body = ensureSkeleton(fig)
            mountChrome(fig, def?.type || fig.dataset.type || '', def?.title ?? '', def?.caption ?? '')
            fig.dataset.rendered = '1'
            fig.dataset.chartStatus = 'loading'
            if (!body.childElementCount) body.innerHTML = '<div class="chart-pending">' + translate(currentLang(), 'chart.pending.generic') + '</div>'

            if (!def) {
              fig.dataset.chartStatus = 'missing'
              showError(body, translate(currentLang(), 'chart.error.missingSource', { lecture, key }))
              console.warn('[chart] source missing:', lecture, key, data ? 'key not in json' : 'json fetch failed')
              continue
            }
            const source = chartSourceOf(def)
            injectSource(fig, source)
            if (!this.deps.renderers[def.type]) {
              showError(body, translate(currentLang(), 'chart.error.unknownType', { type: def.type }))
              fig.dataset.chartStatus = 'unknown-type'
              continue
            }
            try {
              const ok = await this.renderOne(fig, def.type, source, signal)
              if (!ok) return
              fig.dataset.chartStatus = 'ok'
            } catch (e) {
              if (signal.aborted) return
              fig.dataset.chartStatus = 'error'
              const msg = (e instanceof Error && e.message) || String(e)
              showError(body, translate(currentLang(), 'chart.error.renderFailed', { type: def.type, message: String(msg).slice(0, 160) }))
              console.error('[chart] render failed:', lecture, key, def.type, e)
            }
          }
        })(),
      )
    }

    await Promise.all(jobs)
    this.settle(gen, signal, count, started)
  }

  /**
   * Fonts → renderer → register disposer → bind tools. Returns false when aborted (status untouched).
   * A renderer that returns null without being aborted handled the failure itself (error box): V1
   * reported those as `ok`, and so do we.
   */
  private async renderOne(fig: HTMLElement, type: string, code: string, signal: AbortSignal): Promise<boolean> {
    const renderer = this.deps.renderers[type]
    if (!renderer) throw new Error('unknown chart type ' + type)
    await this.deps.waitFonts(signal, code)
    if (signal.aborted) return false
    const dispose = await renderer(fig, code, { signal })
    const release = dispose ? this.registry.add(type, dispose) : null
    if (signal.aborted) {
      release?.()
      return false
    }
    if (dispose) {
      // V1 bound the tools only after a successful render
      this.bindTools(fig, signal)
      this.charts.push({ fig, type, code, release })
    }
    return true
  }

  private toolsBoundFor = new WeakMap<HTMLElement, AbortSignal>()
  private bindTools(fig: HTMLElement, signal: AbortSignal): void {
    if (this.toolsBoundFor.get(fig) === signal) return
    this.toolsBoundFor.set(fig, signal)
    preloadViewer()
    attachTools(fig, signal, { expand: (f, opener) => openChartModal(f, opener) })
  }

  /** Page-scoped dark/light & skin watcher: re-render this page's charts (V1: 80 ms debounce, FE-030). */
  private watchTheme(signal: AbortSignal): void {
    if (this.themeWatch || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return
    const html = document.documentElement
    let lastIsDark = html.classList.contains('dark')
    let lastSkin = html.getAttribute('data-lec-theme') ?? ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const mo = new MutationObserver(() => {
      const curDark = html.classList.contains('dark')
      const curSkin = html.getAttribute('data-lec-theme') ?? ''
      if (curDark === lastIsDark && curSkin === lastSkin) return
      lastIsDark = curDark
      lastSkin = curSkin
      if (this.charts.length > 0) setDone(false)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void this.rerenderCharts(signal)
      }, this.deps.themeDebounceMs ?? 80)
    })
    mo.observe(html, { attributes: true, attributeFilter: ['class', 'data-lec-theme'] })
    const dispose = () => {
      mo.disconnect()
      if (timer) clearTimeout(timer)
    }
    this.themeWatch = dispose
    this.registry.add('observer', dispose)
  }

  private async rerenderCharts(signal: AbortSignal): Promise<void> {
    const started = now()
    for (const entry of [...this.charts]) {
      if (signal.aborted) return
      if (!entry.fig.isConnected) continue
      const renderer = this.deps.renderers[entry.type]
      if (!renderer) continue
      try {
        const dispose = await renderer(entry.fig, entry.code, { signal })
        if (signal.aborted) {
          dispose?.()
          return
        }
        if (dispose) {
          entry.release?.()
          entry.release = this.registry.add(entry.type, dispose)
        }
      } catch (e) {
        console.warn(`[chart] theme re-render failed for ${entry.type}:`, e)
      }
    }
    this.settle(generationSeq, signal, this.charts.length, started)
  }

  private settle(gen: number, signal: AbortSignal, count: number, started: number): void {
    if (signal.aborted || gen !== generationSeq) return
    const ms = Math.round(now() - started)
    setDone(true)
    stats.running = false
    stats.lastSettle = { generation: gen, path: this.path, count, ms, at: new Date().toISOString() }
    if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return
    const detail: ChartsSettledDetail = { path: this.path, count, generation: gen, ms }
    // core contract: always dispatched asynchronously (listeners attach during the same mount tick)
    queueMicrotask(() => {
      if (signal.aborted || gen !== generationSeq) return
      window.dispatchEvent(new CustomEvent<ChartsSettledDetail>(CHARTS_SETTLED_EVENT, { detail }))
    })
  }
}

/** Test seam. */
export function __resetPageStateForTests(): void {
  generationSeq = 0
  liveGenerations.clear()
  currentPage = null
  stats.generation = 0
  stats.path = null
  stats.running = false
  stats.lastSettle = null
}

/** Count charts (figure.chart outside the modal) on the page by type and status. */
export function describeFigures(root: ParentNode = document): { byType: Record<string, number>; byStatus: Record<string, number> } {
  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  for (const fig of Array.from(root.querySelectorAll<HTMLElement>('figure.chart'))) {
    if (fig.classList.contains('chart--modal')) continue
    const t = fig.dataset.type || '?'
    const s = fig.dataset.chartStatus || 'none'
    byType[t] = (byType[t] ?? 0) + 1
    byStatus[s] = (byStatus[s] ?? 0) + 1
  }
  return { byType, byStatus }
}
