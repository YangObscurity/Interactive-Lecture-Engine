/**
 * charts/fonts.ts — per-chart font readiness (replaces V1's global `document.fonts.ready` wait).
 *
 * Mermaid measures label text while laying out nodes; if the CJK face is still loading it measures
 * the fallback and the text later overflows its box (V1 c63ec19f). V1 waited for *every* font on the
 * page (`document.fonts.ready`, up to 2.5 s) before any chart. Here each chart only asks for the
 * faces of `CHART_FONT` that cover its own text (`document.fonts.load('14px <family>', sample)`),
 * capped at 1.5 s and abortable.
 *
 * Pixel equivalence: charts are drawn with `CHART_FONT` only. None of its families is declared via
 * @font-face on this site (they resolve to system fonts), so `load()` resolves immediately and text
 * measurement is identical to V1; when a web font for one of these families is added later (plan §4),
 * this waits for exactly that face instead of the whole page.
 */
import { CHART_FONT } from '../../site.config.mts'

export const FONT_WAIT_CAP_MS = 1500
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math', 'emoji'])

/** Non-generic families of a CSS font stack, quotes preserved (`'Noto Sans SC'`). */
export function chartFontFamilies(stack: string = CHART_FONT): string[] {
  return stack
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !GENERIC.has(s.replace(/['"]/g, '').toLowerCase()))
}

/** Distinct characters of `text` (max 256) — enough for the browser to pick the unicode-range faces. */
export function sampleText(text: string, max = 256): string {
  const seen = new Set<string>()
  for (const ch of text) {
    if (ch.trim() === '') continue
    seen.add(ch)
    if (seen.size >= max) break
  }
  return seen.size ? [...seen].join('') : '中文Aa'
}

export type FontWaitResult = 'loaded' | 'timeout' | 'aborted' | 'unsupported'

export interface FontWaitOptions {
  timeoutMs?: number
  fonts?: Pick<FontFaceSet, 'load'> | null
  families?: string[]
}

export function waitForChartFonts(
  signal: AbortSignal,
  text: string,
  opts: FontWaitOptions = {},
): Promise<FontWaitResult> {
  if (signal.aborted) return Promise.resolve('aborted')
  const fonts = opts.fonts !== undefined ? opts.fonts : typeof document !== 'undefined' ? document.fonts : null
  if (!fonts || typeof fonts.load !== 'function') return Promise.resolve('unsupported')
  const families = opts.families ?? chartFontFamilies()
  const sample = sampleText(text)
  return new Promise<FontWaitResult>((resolve) => {
    let finished = false
    const finish = (r: FontWaitResult) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = () => finish('aborted')
    const timer = setTimeout(() => finish('timeout'), opts.timeoutMs ?? FONT_WAIT_CAP_MS)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.all(families.map((f) => fonts.load(`14px ${f}`, sample).catch(() => [])))
      .then(() => finish('loaded'))
      .catch(() => finish('loaded'))
  })
}
