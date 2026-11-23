/**
 * charts/print.ts — export / print bus (app scope, installed once).
 *
 * Contract kept from V1 (used by plugins/lectureExportPlugin.mjs, LectureExportButton.vue,
 * scripts/pregenerate_assets.mjs):
 *   - `window.__RESIZE_ALL_CHARTS__(targetWidth?)`: resize every ECharts figure to `targetWidth`
 *     (or its container width) and re-fit every inline SVG;
 *   - `beforeprint`: open all non-chart `<details>` (marked `data-print-auto-opened`) and resize
 *     charts to the A4 content width 660; `afterprint`: undo both.
 */
import { chartBody, fitInlineSvg, fixEchartsSvgViewbox } from './dom'
import { figExtras, svgFitters } from './state'

export const PRINT_WIDTH = 660

export function resizeAllCharts(targetWidth?: number): void {
  document.querySelectorAll<HTMLElement>('figure.chart[data-type="echarts"]').forEach((fig) => {
    const body = chartBody(fig)
    const chart = figExtras.get(fig)?.chart
    if (!body || !chart || chart.isDisposed?.()) return
    try {
      const w = targetWidth && targetWidth > 0 ? targetWidth : body.clientWidth || PRINT_WIDTH
      const h = body.clientHeight || 430
      chart.resize({ width: w, height: h })
      fixEchartsSvgViewbox(body)
    } catch {
      /* ignore */
    }
  })
  document.querySelectorAll<HTMLElement>('figure.chart').forEach((fig) => {
    const fit = svgFitters.get(fig)
    try {
      if (fit) fit()
      else fitInlineSvg(fig, true)
    } catch {
      /* ignore */
    }
  })
}

let installed: AbortController | null = null

/** Idempotent. With a signal, aborting it uninstalls (and allows a later re-install). */
export function installPrintBus(signal?: AbortSignal): void {
  if (typeof window === 'undefined' || installed) return
  const ctl = new AbortController()
  installed = ctl
  const opts = { signal: ctl.signal }
  window.__RESIZE_ALL_CHARTS__ = resizeAllCharts

  window.addEventListener(
    'beforeprint',
    () => {
      document.querySelectorAll<HTMLDetailsElement>('details:not(.chart-code)').forEach((d) => {
        if (!d.open) {
          d.setAttribute('open', '')
          d.dataset.printAutoOpened = '1'
        }
      })
      window.__RESIZE_ALL_CHARTS__?.(PRINT_WIDTH)
    },
    opts,
  )
  window.addEventListener(
    'afterprint',
    () => {
      document.querySelectorAll<HTMLDetailsElement>('details[data-print-auto-opened="1"]').forEach((d) => {
        d.removeAttribute('open')
        delete d.dataset.printAutoOpened
      })
      window.__RESIZE_ALL_CHARTS__?.()
    },
    opts,
  )

  ctl.signal.addEventListener('abort', () => {
    if (window.__RESIZE_ALL_CHARTS__ === resizeAllCharts) delete window.__RESIZE_ALL_CHARTS__
    if (installed === ctl) installed = null
  })
  signal?.addEventListener('abort', () => ctl.abort(), { once: true })
}
