/**
 * charts/index.ts — lecture chart runtime (mermaid / echarts / wavedrom), V2 lifecycle.
 *
 *   import { chartsFeature } from './charts'   // PageFeature: mount once per page visit
 *   import { chartsAppFeature } from './charts' // optional AppFeature: print bus (also lazily
 *                                               // installed by the first mount)
 *
 * Placeholders in markdown stay `<figure class="chart" data-lecture data-id data-type></figure>`;
 * sources come from the sidecar `<DATA_FILES.chartsDir>/<lecture>.json`. Fenced ```mermaid blocks
 * are upgraded per `CHART_INLINE_MERMAID`.
 *
 * Debug: `__LECTURE_DEBUG__.panel('charts')` (live instance counts by type, generation, last
 * settle), actions `rerenderAll`, `disposeAll`.
 */
import { withBase } from 'vitepress'
import type { AppFeature, PageContext, PageFeature } from '../core/types'
import { registerDebugPanel } from '../debug/registry'
import { waitForChartFonts } from './fonts'
import { mountFigureFrame } from './frameSlot'
import { closeModal, isModalOpen } from './modal'
import { CHARTS_SETTLED_EVENT, PageCharts, describeFigures, getCurrentPage, stats } from './page'
import type { ChartsDeps } from './page'
import { installPrintBus } from './print'
import { liveCounts } from './registry'
import { renderEcharts } from './renderers/echarts'
import { renderMermaid } from './renderers/mermaid'
import { renderWavedrom } from './renderers/wavedrom'
import { createSidecarLoader } from './sidecar'
import { getPageTier, tierAssetPrefix } from '../access/paths'
import { currentAccessConfig } from '../access/store'

export { CHARTS_SETTLED_EVENT }
export type { ChartsSettledDetail } from './page'

// P3b: a lecture of a restricted tier keeps its chart data under /_access/<tier>/charts/ (production only)
const sidecar = createSidecarLoader({
  withBase,
  prefix: () => tierAssetPrefix(getPageTier(), currentAccessConfig()?.tiers, import.meta.env.DEV),
})

const deps: ChartsDeps = {
  loadSidecar: (lecture) => sidecar.load(lecture),
  waitFonts: (signal, text) => waitForChartFonts(signal, text),
  mountFrame: mountFigureFrame,
  renderers: {
    mermaid: renderMermaid,
    echarts: renderEcharts,
    wavedrom: renderWavedrom,
  },
}

/** Mount the chart runtime for one page visit. Resolves when the generation settles. */
export function mountCharts(ctx: PageContext, overrides: Partial<ChartsDeps> = {}): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  installPrintBus()
  const page = new PageCharts(ctx.path, ctx.signal, { ...deps, ...overrides })
  ctx.defer(() => {
    closeModal()
    page.destroy()
  })
  return page.run()
}

export const chartsFeature: PageFeature = {
  id: 'charts',
  mount: (ctx) => mountCharts(ctx),
}

export const chartsAppFeature: AppFeature = {
  id: 'charts-print-bus',
  install: (signal) => installPrintBus(signal),
}

registerDebugPanel('charts', {
  describe: () => ({
    generation: stats.generation,
    path: stats.path,
    running: stats.running,
    lastSettle: stats.lastSettle,
    chartsDone: typeof window !== 'undefined' ? window.__CHARTS_DONE__ ?? null : null,
    /** live (not yet disposed) handles across all pages, by kind — echarts = ECharts instances */
    live: liveCounts(),
    page: getCurrentPage()?.registry.counts() ?? {},
    figures: typeof document !== 'undefined' ? describeFigures() : null,
    sidecarCache: sidecar.size,
    modalOpen: isModalOpen(),
  }),
  actions: {
    rerenderAll: () => getCurrentPage()?.rerender() ?? null,
    disposeAll: () => {
      getCurrentPage()?.disposeAll()
      return liveCounts()
    },
  },
})
