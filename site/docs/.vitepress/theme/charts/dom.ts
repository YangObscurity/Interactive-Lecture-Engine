/**
 * charts/dom.ts — DOM helpers shared by renderers, toolbar and modal (ported verbatim from V1
 * charts.ts; behaviour and produced markup are unchanged).
 */
import { CHART_TAG_LABELS } from '../../site.config.mts'
import { currentLang, translate } from '../../i18n/index.ts'
import type { MessageKey } from '../../i18n/index.ts'
import { svgFitters } from './state'
import type { Disposer } from './state'

const TAG_KEYS: Record<string, MessageKey | undefined> = {
  mermaid: 'chart.tag.mermaid',
  echarts: 'chart.tag.echarts',
  wavedrom: 'chart.tag.wavedrom',
}

/** Figure type label ("flow diagram" ...) in the current language; unknown types use site.config's labels. */
export function chartTagLabel(type: string): string | undefined {
  const key = TAG_KEYS[type]
  return key ? translate(currentLang(), key) : CHART_TAG_LABELS[type]
}

/** Replace the body content with an error box. */
export function showError(body: HTMLElement, msg: string): void {
  body.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'chart-error'
  div.textContent = msg
  body.appendChild(div)
}

/**
 * Fold the chart source into `details.chart-code` (once per figure). Local author / dev mode only: readers of the built site
 * see the picture and the caption (spec board 07).
 */
export function injectSource(fig: HTMLElement, code: string): void {
  if (!import.meta.env.DEV) return
  if (fig.querySelector('details.chart-code')) return
  const d = document.createElement('details')
  d.className = 'chart-code'
  const s = document.createElement('summary')
  s.textContent = translate(currentLang(), 'chart.source')
  const pre = document.createElement('pre')
  const el = document.createElement('code')
  el.textContent = code
  pre.appendChild(el)
  d.appendChild(s)
  d.appendChild(pre)
  fig.appendChild(d)
}

export function chartBody(fig: HTMLElement): HTMLElement | null {
  return fig.querySelector<HTMLElement>('.chart-body')
}

/** Natural SVG size: viewBox first, then width/height attributes (style scaling ignored). */
export function svgNaturalSize(svg: SVGSVGElement): { w: number; h: number } {
  let w = 0
  let h = 0
  const vb = svg.getAttribute('viewBox')
  if (vb) {
    const p = vb.trim().split(/[\s,]+/).map(Number)
    const pw = p[2] ?? 0
    const ph = p[3] ?? 0
    if (p.length === 4 && pw > 0 && ph > 0) {
      w = pw
      h = ph
    }
  }
  if (!w) w = parseFloat(svg.getAttribute('width') || '') || svg.clientWidth
  if (!h) h = parseFloat(svg.getAttribute('height') || '') || svg.clientHeight
  return { w, h }
}

/* Inline vector fit (scale down to width, never up; height follows; centred; no clipping).
   Only recomputed when the container width changes, otherwise setting the SVG height would
   re-trigger the ResizeObserver. */
const lastFitW = new WeakMap<HTMLElement, number>()

export function fitInlineSvg(fig: HTMLElement, force = false): void {
  const body = chartBody(fig)
  const svg = body?.querySelector<SVGSVGElement>('svg') ?? null
  if (!body || !svg) return
  if (body.closest('.chart-modal')) return // the modal fits via fitToStage
  const avail = body.clientWidth
  if (!avail) return
  if (!force && lastFitW.get(fig) === avail) return
  lastFitW.set(fig, avail)
  const nat = svgNaturalSize(svg)
  if (!nat.w || !nat.h) return
  const s = Math.min(1, avail / nat.w)
  svg.style.maxWidth = 'none'
  svg.style.width = Math.round(nat.w * s) + 'px'
  svg.style.height = Math.round(nat.h * s) + 'px'
  svg.style.display = 'block'
  svg.style.margin = '0 auto'
}

/** Fit now and on every container width change. Returns the observer disconnect. */
export function bindInlineFit(fig: HTMLElement, body: HTMLElement): Disposer {
  fitInlineSvg(fig, true)
  svgFitters.set(fig, () => fitInlineSvg(fig, true))
  fig.dataset.fitBound = '1' // V1 DOM marker, kept for byte compatibility
  if (typeof ResizeObserver === 'undefined') return () => svgFitters.delete(fig)
  const ro = new ResizeObserver(() => fitInlineSvg(fig))
  ro.observe(body)
  return () => {
    ro.disconnect()
    svgFitters.delete(fig)
  }
}

/** Give ECharts' SVG a viewBox so print / narrow layouts scale it instead of clipping. */
export function fixEchartsSvgViewbox(body: HTMLElement): void {
  const svg = body.querySelector('svg')
  if (!svg) return
  const w = parseFloat(svg.getAttribute('width') || '') || svg.clientWidth || parseFloat(svg.style.width || '')
  const h = parseFloat(svg.getAttribute('height') || '') || svg.clientHeight || parseFloat(svg.style.height || '')
  if (w > 0 && h > 0) {
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    svg.style.maxWidth = '100%'
    svg.style.width = '100%'
    svg.style.height = '100%'
    svg.style.overflow = 'hidden'
  }
}

/**
 * Real mermaid source of a VitePress fenced block: Shiki `.line` spans when present, otherwise the
 * text minus the copy button / language label.
 */
export function extractMermaidCode(block: HTMLElement): string {
  const lines = block.querySelectorAll<HTMLElement>('pre code .line, pre .line')
  if (lines.length > 0) {
    return Array.from(lines)
      .map((l) => l.textContent || '')
      .join('\n')
      .trim()
  }
  const codeEl = (block.querySelector('code') || block.querySelector('pre') || block).cloneNode(true) as HTMLElement
  codeEl.querySelectorAll('.copy, .lang').forEach((el) => el.remove())
  return (codeEl.textContent || '').trim()
}
