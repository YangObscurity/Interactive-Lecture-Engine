/**
 * charts/toolbar.ts — figure skeleton (.chart-body + figcaption.chart-cap) and the delegated click handling.
 * Labels come from site.config (single source, review FE-033).
 *
 * Readers see the picture and the caption only (spec board 07): the type tag, the source button and the always-on tool bar of V1
 * are gone; the one control is the enlarge icon `button.chart-enlarge[data-act=expand]`, visible on hover (styles/base.css).
 */
import { CHART_TOOLS_BY_TYPE, CHART_TOOL_DEFS } from '../../site.config.mts'
import { currentLang, translate } from '../../i18n/index.ts'
import type { MessageKey } from '../../i18n/index.ts'
import { chartBody } from './dom'

/** Tool buttons whose hover text / aria label come from the dictionary (key = CHART_TOOL_DEFS key). */
const TOOL_TITLE_KEYS: Record<string, MessageKey | undefined> = {
  expand: 'chart.tool.expand',
  src: 'chart.tool.source',
}

/** Build the skeleton. Idempotent: body is created once; caption falls back to plain HTML when no slot host owns it. */
export function ensureSkeleton(fig: HTMLElement): HTMLElement {
  const type = fig.dataset.type || ''
  if (!fig.id) {
    if (fig.dataset.lecture && fig.dataset.id) {
      fig.id = 'fig-' + fig.dataset.lecture + '-' + fig.dataset.id
    } else if (fig.dataset.id) {
      fig.id = 'fig-' + fig.dataset.id
    }
  }
  let body = chartBody(fig)
  if (!body) {
    body = document.createElement('div')
    body.className = 'chart-body'
    fig.insertBefore(body, fig.firstChild)
  }
  if (!fig.querySelector(':scope > .lec-ff-host')) {
    const cap = document.createElement('figcaption')
    cap.className = 'chart-cap'
    cap.innerHTML = enlargeHtml(type)
    const old = fig.querySelector(':scope > figcaption.chart-cap')
    if (old) fig.replaceChild(cap, old)
    else fig.appendChild(cap)
  }
  return body
}

export interface ChartButtonDef {
  act: string
  title: string
  label: string
}

export function chartButtons(type: string): ChartButtonDef[] {
  const keys = CHART_TOOLS_BY_TYPE[type] || CHART_TOOLS_BY_TYPE.mermaid || []
  const out: ChartButtonDef[] = []
  for (const k of keys) {
    const d = CHART_TOOL_DEFS[k]
    if (!d) continue
    const titleKey = TOOL_TITLE_KEYS[k]
    const title = titleKey ? translate(currentLang(), titleKey) : d[1]
    out.push({ act: d[0], title, label: d[2] })
  }
  return out
}

/** The hover enlarge icon (the only control of a figure; same markup as slots/default/parts/EnlargeIcon.vue). */
export function enlargeHtml(type: string): string {
  const b = chartButtons(type).find((x) => x.act === 'expand')
  const title = b ? b.title : ''
  return (
    '<button type="button" class="chart-enlarge" data-act="expand" title="' + title + '" aria-label="' + title + '">' +
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">' +
    '<path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5L7 9" /></svg></button>'
  )
}

/** Inline body click → full screen, except ECharts (clicks belong to ECharts' own interactions). */
export function enlargeOnBodyClick(fig: HTMLElement): boolean {
  return fig.dataset.type !== 'echarts'
}

export interface ToolHandlers {
  expand(fig: HTMLElement, opener: HTMLElement | null): void
}

/**
 * Delegated click handler on the figure (the caption is rebuilt, so buttons can't hold listeners).
 * Bound once per figure per page generation; removed when `signal` aborts.
 */
export function attachTools(fig: HTMLElement, signal: AbortSignal, handlers: ToolHandlers): void {
  fig.dataset.toolsBound = '1' // V1 DOM marker, kept for byte compatibility
  fig.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement | null
      const hit = (t?.closest?.('[data-act]') as HTMLElement | null) ?? null
      if (hit && fig.contains(hit)) {
        const act = hit.getAttribute('data-act')
        if (act === 'expand') handlers.expand(fig, hit)
        else if (act === 'src') {
          const d = fig.querySelector<HTMLDetailsElement>('details.chart-code')
          if (d) d.open = !d.open
        }
        return
      }
      const body = chartBody(fig)
      if (!body || !t || !body.contains(t)) return
      if (!enlargeOnBodyClick(fig)) return
      handlers.expand(fig, null)
    },
    { signal },
  )
}
