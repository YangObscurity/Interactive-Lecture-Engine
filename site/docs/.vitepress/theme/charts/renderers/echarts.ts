/**
 * renderers/echarts.ts — ECharts option JSON → chart (lazy `import('echarts/core')`, tree-shaken to used charts/components).
 *
 * Rendering supports light and dark themes (FE-030).
 * SVG renderer first, canvas fallback; animation off; toolbox;
 * confined tooltip; layout normalisation; SVG viewBox fix for print/export.
 */
import { CHART_ECHARTS_GRID, CHART_FONT } from '../../../site.config.mts'
import { currentLang, translate } from '../../../i18n/index.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import { chartBody, fixEchartsSvgViewbox, showError } from '../dom'
import { figExtras } from '../state'
import type { Disposer, EChartsInstanceLike } from '../state'
import { isDarkTheme } from './mermaid'
import type { RenderEnv } from './types'

interface EChartsModuleLike {
  init(dom: HTMLElement, theme: string | null, opts: { renderer: 'svg' | 'canvas'; devicePixelRatio?: number }): EChartsInstanceLike
  getInstanceByDom?(dom: HTMLElement): EChartsInstanceLike | undefined
  registerTheme?(name: string, theme: Record<string, unknown>): void
}

function getLecToken(name: string): string {
  if (typeof document === 'undefined') return ''
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Perceived luminance (0-255) of a `#rgb` / `#rrggbb` / `black` colour; null for anything else (named, rgb(), var()). */
function hexLuminance(colorStr: string): number | null {
  const c = colorStr.trim().toLowerCase()
  if (c === 'black') return 0
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c)
  const hex = m?.[1]
  if (!hex) return null
  const full = hex.length === 3 ? hex.split('').map((h) => h + h).join('') : hex
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000
}

/** Text drawn in near-black stays unreadable on a dark surface. */
function isDarkColor(colorStr: string): boolean {
  const lum = hexLuminance(colorStr)
  return lum !== null && lum < 80
}

/** Pale grey grid/split lines vanish into a dark surface (white and near-white are left alone). */
function isLightSplit(colorStr: string): boolean {
  const lum = hexLuminance(colorStr)
  return lum !== null && lum > 180 && lum < 250
}

function ensureDarkTheme(echarts: EChartsModuleLike): void {
  if (!echarts.registerTheme) return
  const textColor = getLecToken('--lec-text')
  const textMuted = getLecToken('--lec-text-muted')
  const border = getLecToken('--lec-border')
  const surface = getLecToken('--lec-surface')
  const palette = [
    getLecToken('--lec-cat-1'),
    getLecToken('--lec-cat-2'),
    getLecToken('--lec-cat-3'),
    getLecToken('--lec-cat-4'),
    getLecToken('--lec-cat-5'),
    getLecToken('--lec-cat-6'),
    getLecToken('--lec-accent'),
    getLecToken('--lec-warning'),
    getLecToken('--lec-danger'),
  ].filter(Boolean)

  echarts.registerTheme('lecture-dark', {
    darkMode: true,
    backgroundColor: 'transparent',
    color: palette.length ? palette : undefined,
    textStyle: {
      color: textColor,
      fontFamily: CHART_FONT,
    },
    title: {
      textStyle: { color: textColor },
      subtextStyle: { color: textMuted },
    },
    line: {
      itemStyle: { borderWidth: 1 },
      lineStyle: { width: 2 },
    },
    categoryAxis: {
      axisLine: { show: true, lineStyle: { color: border } },
      axisTick: { show: true, lineStyle: { color: border } },
      axisLabel: { show: true, color: textMuted },
      splitLine: { show: false, lineStyle: { color: border } },
    },
    valueAxis: {
      axisLine: { show: true, lineStyle: { color: border } },
      axisTick: { show: true, lineStyle: { color: border } },
      axisLabel: { show: true, color: textMuted },
      splitLine: { show: true, lineStyle: { color: border } },
    },
    logAxis: {
      axisLine: { show: true, lineStyle: { color: border } },
      axisTick: { show: true, lineStyle: { color: border } },
      axisLabel: { show: true, color: textMuted },
      splitLine: { show: true, lineStyle: { color: border } },
    },
    timeAxis: {
      axisLine: { show: true, lineStyle: { color: border } },
      axisTick: { show: true, lineStyle: { color: border } },
      axisLabel: { show: true, color: textMuted },
      splitLine: { show: true, lineStyle: { color: border } },
    },
    legend: {
      textStyle: { color: textColor },
    },
    tooltip: {
      backgroundColor: surface,
      borderColor: border,
      textStyle: { color: textColor },
    },
    toolbox: {
      iconStyle: {
        borderColor: textMuted,
      },
      emphasis: {
        iconStyle: {
          borderColor: textColor,
        },
      },
    },
  })
}

function adaptOptionForTheme(opt: Obj, isDark: boolean): void {
  if (!isDark) return
  const textColor = getLecToken('--lec-text')
  const border = getLecToken('--lec-border')

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const obj = node as Record<string, unknown>
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') {
        if (key === 'color' && isDarkColor(val)) {
          obj[key] = textColor
        } else if (key === 'color' && isLightSplit(val)) {
          obj[key] = border
        }
      } else if (typeof val === 'object' && val !== null) {
        walk(val)
      }
    }
  }

  walk(opt.title)
  walk(opt.xAxis)
  walk(opt.yAxis)
  walk(opt.legend)
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const asArr = (v: unknown): unknown[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const objs = (v: unknown): Obj[] => asArr(v).filter(isObj)
const num = (v: unknown): number => Number(v)

/** ECharts `%` / px / number → px. */
export function toPx(v: unknown, base: number, dflt: number): number {
  if (v == null || v === '') return dflt
  if (typeof v === 'number') return v
  const s = String(v).trim()
  if (s.slice(-1) === '%') {
    const n = parseFloat(s)
    return isNaN(n) ? dflt : (n / 100) * base
  }
  const n = parseFloat(s)
  return isNaN(n) ? dflt : n
}

/**
 * title / legend / grid overlap normalisation (V1, unchanged): only moves things *down*, and only
 * when the author did not set a position or the declared one really overlaps — hand-tuned charts
 * are left alone. Grid margins / containLabel come from `CHART_ECHARTS_GRID`.
 */
export function normalizeEchartsLayout(opt: Obj, boxW: number, boxH: number): void {
  const titles = objs(opt.title).filter((t) => t.text || t.subtext)
  const legends = objs(opt.legend).filter((l) => l.data)

  if (opt.grid == null && (opt.xAxis != null || opt.yAxis != null)) opt.grid = [{}]
  const grids = objs(opt.grid)
  const fb = CHART_ECHARTS_GRID.fallback

  // 1) title: make the default position explicit, estimate wrapped lines from its width
  let titleBottom = 0
  const t = titles[0]
  if (t) {
    if (t.top == null) t.top = 4
    if (t.left == null && t.right == null) t.left = 'center'
    const ts = isObj(t.textStyle) ? t.textStyle : null
    const ss = isObj(t.subtextStyle) ? t.subtextStyle : null
    const fs = num(ts && ts.fontSize) || 14
    const subFs = t.subtext ? num(ss && ss.fontSize) || 12 : 0
    let w = 0
    for (const ch of String(t.text || '')) w += ch.charCodeAt(0) > 255 ? fs : fs * 0.6
    const avail = Math.max(120, boxW * 0.86)
    const lines = Math.max(1, Math.ceil(w / avail))
    titleBottom = toPx(t.top, boxH, 4) + Math.round(fs * 1.45 * lines) + (subFs ? Math.round(subFs * 1.5) + 4 : 0) + 8
  }

  // 2) legend: below the title when undeclared; pushed down when it overlaps the title
  let legendBottom = 0
  const l = legends[0]
  if (l) {
    const declared = l.top
    const asIs = declared == null ? -1 : toPx(declared, boxH, -1)
    let top = asIs === -1 ? (titles.length ? titleBottom : 4) : asIs
    if (titles.length && top < titleBottom) top = titleBottom
    if (top !== asIs) l.top = top
    if (l.left == null && l.right == null) l.left = 'center'
    legendBottom = top + 30
  }

  // 3) plot area below title/legend; containLabel keeps axis labels inside the canvas
  const needTop = legendBottom || titleBottom ? Math.ceil((legendBottom || titleBottom) + 12) : null
  for (const g of grids) {
    if (CHART_ECHARTS_GRID.containLabel && (g.containLabel == null || g.containLabel === false)) {
      g.containLabel = true
    }
    if (g.left == null) g.left = fb.left
    else if (toPx(g.left, boxW, fb.left) < fb.left) g.left = fb.left

    if (g.right == null) g.right = fb.right
    else if (toPx(g.right, boxW, fb.right) < fb.right) g.right = fb.right

    if (g.bottom == null) g.bottom = fb.bottom
    else if (toPx(g.bottom, boxH, fb.bottom) < fb.bottom) g.bottom = fb.bottom

    if (needTop != null) {
      if (g.top == null) g.top = needTop
      else if (toPx(g.top, boxH, 60) < needTop) g.top = needTop
    }
  }

  // 4) x-axis name sits at the axis end; widen grid.right so it is not clipped
  for (const ax of objs(opt.xAxis)) {
    if (!ax.name || ax.nameLocation != null) continue
    const al = isObj(ax.axisLabel) ? ax.axisLabel : null
    const fs = num(al && al.fontSize) || 11
    const needRight = String(ax.name).length * fs + 24
    for (const g of grids) {
      const cur = toPx(g.right, boxW, fb.right)
      if (cur < needRight) g.right = Math.ceil(needRight)
    }
  }
}

let echartsPromise: Promise<EChartsModuleLike> | null = null
function loadECharts(): Promise<EChartsModuleLike> {
  if (!echartsPromise) {
    echartsPromise = import('./echartsDeps')
      .then((deps) => deps as unknown as EChartsModuleLike)
      .catch((err: unknown) => {
        echartsPromise = null
        throw err
      })
  }
  return echartsPromise
}

export async function renderEcharts(fig: HTMLElement, code: string, env: RenderEnv): Promise<Disposer | null> {
  const body = chartBody(fig)
  if (!body) throw new Error('chart-body missing')
  let opt: Obj
  try {
    const parsed: unknown = JSON.parse(code)
    if (!isObj(parsed)) throw new Error('not an object')
    opt = parsed
  } catch {
    showError(body, translate(currentLang(), 'chart.echarts.parseFailed'))
    return null
  }
  const echarts = await loadECharts()
  if (env.signal.aborted) return null

  opt.animation = false
  opt.textStyle = Object.assign({}, isObj(opt.textStyle) ? opt.textStyle : {}, { fontFamily: CHART_FONT })
  const L = (key: MessageKey): string => translate(currentLang(), key)
  opt.toolbox = Object.assign(
    {
      right: 10,
      top: 6,
      itemSize: 13,
      feature: {
        saveAsImage: { title: L('chart.echarts.saveImage'), pixelRatio: 3 },
        dataView: { title: L('chart.echarts.dataView'), readOnly: true, lang: [L('chart.echarts.dataViewTitle'), L('chart.modal.close'), L('chart.echarts.refresh')] },
        restore: { title: L('chart.echarts.restore') },
      },
    },
    isObj(opt.toolbox) ? opt.toolbox : {},
  )
  opt.tooltip = Object.assign({ confine: true }, isObj(opt.tooltip) ? opt.tooltip : {})
  normalizeEchartsLayout(opt, body.clientWidth || 660, body.clientHeight || 430)

  ensureDarkTheme(echarts)
  const isDark = isDarkTheme()
  adaptOptionForTheme(opt, isDark)

  // never stack instances on one container (re-render / re-entry)
  try {
    const prev = echarts.getInstanceByDom?.(body)
    if (prev && !(prev.isDisposed?.() ?? false)) prev.dispose()
  } catch {
    /* ignore */
  }

  let chart: EChartsInstanceLike
  try {
    chart = echarts.init(body, isDark ? 'lecture-dark' : null, { renderer: 'svg' })
  } catch {
    // canvas fallback kept on purpose (ledger 3.1): the SVG path is what export/print rely on
    const dpr = typeof window !== 'undefined' ? Math.min(Math.max(window.devicePixelRatio || 1, 2.0), 3.0) : 2.5
    chart = echarts.init(body, isDark ? 'lecture-dark' : null, { renderer: 'canvas', devicePixelRatio: dpr })
  }
  const resize = () => {
    chart.resize()
    fixEchartsSvgViewbox(body)
  }
  chart.setOption(opt, true)
  fixEchartsSvgViewbox(body)
  const raf = requestAnimationFrame(() => fixEchartsSvgViewbox(body))
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (chart.isDisposed?.()) return
      resize()
    })
    ro.observe(body)
  }
  figExtras.set(fig, { chart, resize })

  return () => {
    cancelAnimationFrame(raf)
    ro?.disconnect()
    if (figExtras.get(fig)?.chart === chart) figExtras.delete(fig)
    if (!(chart.isDisposed?.() ?? false)) chart.dispose()
  }
}
