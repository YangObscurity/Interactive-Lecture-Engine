/**
 * renderers/mermaid.ts — mermaid → inline SVG (lazy `import('mermaid')`).
 * Returns a disposer (inline-fit ResizeObserver) or null when aborted before anything was created.
 */
import { CHART_CODE_FONT, CHART_FONT, CHART_MERMAID_THEMES } from '../../../site.config.mts'
import { bindInlineFit, chartBody } from '../dom'
import { nextSeq } from '../state'
import type { Disposer } from '../state'
import type { RenderEnv } from './types'

interface MermaidLike {
  initialize(config: Record<string, unknown>): void
  render(id: string, code: string): Promise<{ svg: string }>
}

/**
 * Normalise common mermaid syntax slips (V1, kept verbatim):
 * 1. flowchart edge labels with parentheses / `==` get quoted (`-->|a (b)|` → `-->|"a (b)"|`);
 * 2. stateDiagram-v2: drop the unsupported `classDef default …`;
 * 3. sequenceDiagram messages: `;` → `，`, strip `#xx`.
 */
export function normalizeMermaidCode(code: string): string {
  if (!code) return code
  let lines = code.split('\n')
  const isStateDiagram = lines.some((l) => /^\s*stateDiagram/i.test(l))
  const isSequenceDiagram = lines.some((l) => /^\s*sequenceDiagram/i.test(l))

  if (isStateDiagram) {
    lines = lines.filter((l) => !/^\s*classDef\s+default\s+/i.test(l))
  }

  const result = lines.map((line) => {
    if (isSequenceDiagram) {
      const match = line.match(/^(\s*[\w一-龥]+(?:\s*-->>|\s*->>|\s*->|\s*-->)\s*[\w一-龥]+:\s*)(.+)$/)
      if (match) {
        const prefix = match[1] ?? ''
        let msg = (match[2] ?? '').trim()
        if (msg.includes(';') && !msg.startsWith('"')) {
          msg = msg.replace(/;/g, '，')
        }
        msg = msg.replace(/#xx/g, '')
        return prefix + msg
      }
      return line
    }

    return line.replace(
      /([=-]>|<==>|==>|-\.->)\s*\|([^"|\n]+?)\|\s*([A-Za-z0-9_[])/g,
      (m: string, arrow: string, label: string, target: string) => {
        const trimmed = label.trim()
        if ((trimmed.includes('(') || trimmed.includes(')') || trimmed.includes('==')) && !trimmed.startsWith('"')) {
          return `${arrow}|"${trimmed}"|${target}`
        }
        return m
      },
    )
  })

  return result.join('\n')
}

let mermaidPromise: Promise<MermaidLike> | null = null
function loadMermaid(): Promise<MermaidLike> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((mod) => {
        const m = mod as unknown as { default?: MermaidLike } & MermaidLike
        return m.default ?? m
      })
      .catch((err: unknown) => {
        mermaidPromise = null
        throw err
      })
  }
  return mermaidPromise
}

export function isDarkTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

export async function renderMermaid(fig: HTMLElement, rawCode: string, env: RenderEnv): Promise<Disposer | null> {
  const code = normalizeMermaidCode(rawCode)
  const body = chartBody(fig)
  if (!body) throw new Error('chart-body missing')
  const mermaid = await loadMermaid()
  if (env.signal.aborted) return null
  const isDark = isDarkTheme()

  // FE-040: securityLevel set to 'strict' after testing all 951 sidecar mermaid charts across the site with 0 errors.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? CHART_MERMAID_THEMES.dark : CHART_MERMAID_THEMES.light,
    fontFamily: CHART_FONT,
    // wrappingWidth defaults to 200; 1000 keeps long CJK lines inside their node boxes
    flowchart: { htmlLabels: true, useMaxWidth: false, wrappingWidth: 1000 },
    themeVariables: isDark ? { ...CHART_MERMAID_THEMES.darkVars } : { darkMode: false, fontFamily: CHART_FONT },
    // scoped to this svg by mermaid; applies while measuring AND rendering (see CHART_CODE_FONT)
    themeCSS: `code { font-family: ${CHART_CODE_FONT}; }`,
  })

  const cleanId = (fig.dataset.id || 'm').replace(/[^A-Za-z0-9_]/g, '')
  const id = 'm' + nextSeq() + '_' + cleanId
  const out = await mermaid.render(id, code)
  if (env.signal.aborted) return null
  body.innerHTML = out.svg
  return bindInlineFit(fig, body)
}
