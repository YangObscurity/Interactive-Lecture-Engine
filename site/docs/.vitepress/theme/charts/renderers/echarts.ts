/**
 * renderers/echarts.ts — ECharts option JSON → chart (lazy `import('echarts/core')`, tree-shaken to used charts/components).
 *
 * Rendering supports light and dark themes (FE-030).
 * SVG renderer first, canvas fallback; animation off; no toolbox unless the author writes one (export is in the viewer);
 * confined tooltip; layout normalisation; SVG viewBox fix for print/export.
 */
import { CHART_ECHARTS_GRID, CHART_FONT } from '../../../site.config.mts'
import { currentLang, translate } from '../../../i18n/index.ts'
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

/** The ECharts tool icons at the top right: px from the chart box's right / top edge, and the row's size (padding included). */
export interface ToolRow {
  right: number
  top: number
  width: number
  height: number
}

/** ECharts toolbox: icon size, gap between icons (ECharts default), box padding (ECharts default). */
const TOOL_ICON = 13
const TOOL_ICON_GAP = 8
const TOOL_PAD = 5
/** Space kept between the tool icons and the engine's enlarge icon. */
const TOOL_ENLARGE_GAP = 6
/** The corner position when there is no enlarge icon to avoid (the viewer). */
const TOOL_CORNER = { right: 10, top: 6 }

/**
 * Where the ECharts tool icons go. The engine's enlarge icon (`.chart-enlarge`, styles/base.css) sits at the figure's top
 * right and stays visible on touch screens, so the tool icons go to its left, centred on the same line: neither covers the
 * other. Measured from the laid-out icon, so any skin's figure padding and icon size are respected; when the figure is not
 * laid out yet, the icon's CSS offsets are used. In the viewer (no enlarge icon) the tool icons stay in the corner.
 */
export function toolboxPlacement(fig: HTMLElement, body: HTMLElement, count: number): ToolRow {
  const width = count * TOOL_ICON + Math.max(0, count - 1) * TOOL_ICON_GAP + 2 * TOOL_PAD
  const height = TOOL_ICON + 2 * TOOL_PAD
  const corner: ToolRow = { ...TOOL_CORNER, width, height }
  if (fig.classList.contains('chart--modal') || fig.classList.contains('big')) return corner
  const btn = Array.from(fig.querySelectorAll<HTMLElement>('.chart-enlarge')).find((b) => b.closest('figure') === fig)
  if (!btn) return corner
  const cs = getComputedStyle(btn)
  if (cs.display === 'none') return corner
  const b = btn.getBoundingClientRect()
  const r = body.getBoundingClientRect()
  let fromRight: number // body right edge -> enlarge icon left edge
  let centreY: number // enlarge icon centre, from the body top
  if (b.width > 0 && r.width > 0) {
    fromRight = r.right - b.left
    centreY = (b.top + b.bottom) / 2 - r.top
  } else {
    const fcs = getComputedStyle(fig)
    const px = (v: string): number => parseFloat(v) || 0
    fromRight = px(cs.right) + px(cs.width) - px(fcs.paddingRight)
    centreY = px(cs.top) + px(cs.height) / 2 - px(fcs.paddingTop)
  }
  if (fromRight <= 0) return corner
  return {
    right: Math.max(TOOL_CORNER.right, Math.ceil(fromRight + TOOL_ENLARGE_GAP - TOOL_PAD)),
    top: Math.max(0, Math.round(centreY - height / 2)),
    width,
    height,
  }
}

/**
 * title / legend / grid overlap normalisation (V1, unchanged): only moves things *down*, and only
 * when the author did not set a position or the declared one really overlaps — hand-tuned charts
 * are left alone. Grid margins / containLabel come from `CHART_ECHARTS_GRID`.
 * `tools` is the row of tool icons at the top right (see `toolboxPlacement`): a centred title or legend the engine placed
 * (the author set no position) that would run into it is moved left, or below the row when it does not fit beside it.
 */
export function normalizeEchartsLayout(opt: Obj, boxW: number, boxH: number, tools?: ToolRow): void {
  const titles = objs(opt.title).filter((t) => t.text || t.subtext)
  const legends = objs(opt.legend).filter((l) => l.data)

  if (opt.grid == null && (opt.xAxis != null || opt.yAxis != null)) opt.grid = [{}]
  const grids = objs(opt.grid)
  const fb = CHART_ECHARTS_GRID.fallback
  // the left edge of the tool row and its bottom, in px of the chart box (no row: nothing to avoid)
  const toolsLeft = tools ? boxW - tools.right - tools.width : boxW
  const toolsBottom = tools ? tools.top + tools.height : 0
  /** A centred box [w wide, from y top to y bottom] the engine placed: keep it clear of the tool row. */
  const avoidTools = (o: Obj, w: number, top: number, bottom: number): void => {
    if (!tools || o.left !== 'center' || o.right != null || top >= toolsBottom || bottom <= tools.top) return
    if ((boxW + w) / 2 <= toolsLeft - 4) return
    if (8 + w <= toolsLeft - 8) o.left = 8
    else o.top = toolsBottom + 2
  }

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
    const textTop = toPx(t.top, boxH, 4)
    // its drawn width for the tool row: ECharts' default title size is 18 px bold (the 14 above only sizes the rows, as in V1)
    const drawnFs = num(ts && ts.fontSize) || 18
    let drawnW = 0
    for (const ch of String(t.text || '')) drawnW += ch.charCodeAt(0) > 255 ? drawnFs : drawnFs * 0.62
    avoidTools(t, Math.min(drawnW, avail), textTop, textTop + Math.round(drawnFs * 1.45))
    titleBottom = toPx(t.top, boxH, 4) + Math.round(fs * 1.45 * lines) + (subFs ? Math.round(subFs * 1.5) + 4 : 0) + 8
  }

  // 2) legend: below the title when undeclared; pushed down when it overlaps the title
  let legendBottom = 0
  const l = legends[0]
  if (l) {
    const declared = l.top
    const asIs = declared == null ? -1 : toPx(declared, boxH, -1)
    let top = asIs === -1 ? (titles.length ? titleBottom : 4) : asIs
    if (asIs === -1 && !titles.length && l.bottom == null && l.left == null && l.right == null && tools) {
      // a top legend without a title: estimate its width (symbol 25 + gap 10 + name) and keep it clear of the tool row
      let w = 0
      for (const d of asArr(l.data)) {
        const name = String(isObj(d) ? d.name ?? '' : d ?? '')
        w += 35
        for (const ch of name) w += ch.charCodeAt(0) > 255 ? 12 : 7
      }
      const probe: Obj = { left: 'center' }
      avoidTools(probe, w, top, top + 24)
      if (probe.left !== 'center') l.left = probe.left
      if (probe.top != null) top = toPx(probe.top, boxH, top)
    }
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
  // spec board 07: the figure shows no always-on buttons (export lives in the viewer's tool bar, charts/modal.ts), so the
  // engine no longer adds the ECharts toolbox (S6Y audit-spec #8). An author's own `toolbox` with features is kept.
  const authorTools = isObj(opt.toolbox) ? opt.toolbox : null
  let toolRow: ToolRow | undefined
  if (authorTools && authorTools.show !== false && isObj(authorTools.feature)) {
    const toolCount = Object.values(authorTools.feature).filter((f) => !isObj(f) || f.show !== false).length
    const row = toolboxPlacement(fig, body, toolCount)
    opt.toolbox = Object.assign({ right: row.right, top: row.top, itemSize: TOOL_ICON, itemGap: TOOL_ICON_GAP, padding: TOOL_PAD }, authorTools)
    // an author who placed the toolbox keeps it; the layout only avoids the row the engine placed
    const engineRow = authorTools.right == null && authorTools.left == null && authorTools.top == null && authorTools.bottom == null
    if (engineRow && toolCount > 0) toolRow = row
  } else {
    opt.toolbox = { show: false }
  }
  opt.tooltip = Object.assign({ confine: true }, isObj(opt.tooltip) ? opt.tooltip : {})
  normalizeEchartsLayout(opt, body.clientWidth || 660, body.clientHeight || 430, toolRow)

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

  // the "loading" placeholder (charts/page.ts) goes before ECharts measures the box: left in place it pushed the chart down
  // by its own height, which clipped the x axis in the viewer where the placeholder is not hidden (S6Y audit-spec #10)
  for (const pending of Array.from(body.querySelectorAll(':scope > .chart-pending'))) pending.remove()

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
