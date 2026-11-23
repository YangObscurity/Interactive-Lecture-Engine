/**
 * markdownMath.ts — AI companion maths: sanitize the model's Markdown/HTML first, render KaTeX after.
 *
 * Why: the model-content sanitizer (SANITIZE_CONFIG, FE-002) forbids `style`, and KaTeX's HTML output
 * relies on inline styles (fraction bars, radicals, sub/superscript shifts, struts). Running KaTeX
 * output through that sanitizer broke the layout; loosening it would let the model inject styles.
 *
 * Order per render:
 *   1. marked parses the model's Markdown; each maths token is rendered by KaTeX right away, but the
 *      result is parked in a per-render slot table and only an empty placeholder element
 *      `<span data-ai-math-slot="<nonce>-<n>"></span>` goes into the HTML.
 *   2. That HTML (model text + placeholders) goes through the unchanged model sanitizer.
 *   3. Placeholders that survived are replaced with their KaTeX output, which first passes a second,
 *      KaTeX-only sanitizer pass (KATEX_SANITIZE_CONFIG: same tag bans and event-attribute bans, but
 *      `style` allowed) as defence in depth.
 *
 * The nonce is random per render, so the model cannot forge a placeholder; even a forged one could only
 * pull in KaTeX output that was generated from the model's own TeX under KATEX_OPTIONS.
 * KaTeX runs with trust: false (so \href, \url, \includegraphics, \htmlClass, \htmlId, \htmlStyle and
 * \htmlData render as error text), bounded maxSize/maxExpand and a TeX length cap.
 */
import katex from 'katex'
import {
  SANITIZE_CONFIG,
  escapeHtml,
  sanitizeHtmlFailClosed,
  type DomPurifyInstance,
  type DomPurifySanitizeFn,
  type SanitizeConfig,
} from './markdownSanitize'

/** Longest TeX source rendered; longer input is shown as escaped text. */
export const MAX_TEX_LENGTH = 4000

export const KATEX_OPTIONS = Object.freeze({
  throwOnError: false,
  errorColor: 'currentColor',
  strict: false,
  // never trust model TeX: \href, \url, \includegraphics, \html* are rendered as errors
  trust: false,
  // em; caps \rule, \kern, \hspace, \raisebox … (KaTeX default is Infinity)
  maxSize: 20,
  // macro expansions per formula; stops \def recursion bombs (KaTeX default 1000)
  maxExpand: 500,
  output: 'htmlAndMathml' as const,
})

/** Second pass for KaTeX output only: the model sanitizer's bans, plus the attributes KaTeX emits. */
export const KATEX_SANITIZE_CONFIG: Readonly<SanitizeConfig> = Object.freeze({
  USE_PROFILES: { ...(SANITIZE_CONFIG.USE_PROFILES ?? {}) },
  ADD_TAGS: [...(SANITIZE_CONFIG.ADD_TAGS ?? [])],
  ADD_ATTR: [
    ...(SANITIZE_CONFIG.ADD_ATTR ?? []).filter((a) => a !== 'data-tex' && a !== 'data-code'),
    'style', 'preserveAspectRatio',
  ],
  FORBID_TAGS: [...(SANITIZE_CONFIG.FORBID_TAGS ?? []), 'a'],
  FORBID_ATTR: (SANITIZE_CONFIG.FORBID_ATTR ?? []).filter((a) => a !== 'style'),
})

/**
 * Shiki output (code blocks) takes the same route: the highlighted HTML is parked in a slot, the model
 * sanitizer never sees it, and it goes in after a code-only pass. Shiki writes its token colours as inline
 * styles; the model sanitizer (FE-002) drops them, which left companion code blocks without syntax colours.
 * The code pass allows `style`, then keeps only Shiki's own declarations with hex colours or font keywords.
 */
export const CODE_SANITIZE_CONFIG: Readonly<SanitizeConfig> = Object.freeze({
  USE_PROFILES: { html: true },
  ADD_TAGS: [],
  ADD_ATTR: ['style', 'tabindex'],
  FORBID_TAGS: [...(SANITIZE_CONFIG.FORBID_TAGS ?? []), 'a', 'svg', 'math'],
  FORBID_ATTR: (SANITIZE_CONFIG.FORBID_ATTR ?? []).filter((a) => a !== 'style'),
})

const SHIKI_COLOUR_DECL = /^(--shiki-(?:light|dark)(?:-bg)?|color|background-color)\s*:\s*#[0-9a-f]{3,8}$/i
const SHIKI_FONT_DECL =
  /^(?:--shiki-(?:light|dark)-)?(?:font-style\s*:\s*(?:italic|normal)|font-weight\s*:\s*(?:bold|normal|[1-9]00)|text-decoration\s*:\s*(?:underline|line-through|none))$/i

/** Keep only Shiki's colour / font declarations in every style attribute; drop the attribute if none is left. */
export function filterCodeStyles(html: string): string {
  return html.replace(/\sstyle="([^"]*)"/gi, (_m, value: string) => {
    const kept = value
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && (SHIKI_COLOUR_DECL.test(d) || SHIKI_FONT_DECL.test(d)))
    return kept.length ? ` style="${kept.join(';')}"` : ''
  })
}

export function renderKatexHtml(tex: string, displayMode: boolean): string {
  if (tex.length > MAX_TEX_LENGTH) return `<span class="katex-fallback">${escapeHtml(tex)}</span>`
  try {
    return katex.renderToString(tex, { ...KATEX_OPTIONS, displayMode })
  } catch {
    return `<span class="katex-fallback">${escapeHtml(tex)}</span>`
  }
}

interface SlotTable {
  nonce: string
  html: { html: string; kind: 'math' | 'code' }[]
}

let activeSlots: SlotTable | null = null

function makeNonce(): string {
  const bytes = new Uint8Array(8)
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Called by the Markdown maths renderers. Inside renderMarkdownWithMath it returns a placeholder;
 * outside a render (no slot table) it fails closed to escaped TeX.
 */
export function mathSlot(tex: string, displayMode: boolean): string {
  if (!activeSlots) return `<span class="katex-fallback">${escapeHtml(tex)}</span>`
  const n = activeSlots.html.push({ html: renderKatexHtml(tex, displayMode), kind: 'math' }) - 1
  return `<span data-ai-math-slot="${activeSlots.nonce}-${n}"></span>`
}

/**
 * Called by the Markdown code renderer with Shiki's HTML for one block. Inside renderMarkdownWithMath it
 * returns a placeholder (filled after sanitizing, see CODE_SANITIZE_CONFIG); outside a render it fails
 * closed to the escaped plain code.
 */
export function codeSlot(highlightedHtml: string, plainCode: string): string {
  if (!activeSlots) return `<pre class="shiki-fallback"><code>${escapeHtml(plainCode)}</code></pre>`
  const n = activeSlots.html.push({ html: highlightedHtml, kind: 'code' }) - 1
  return `<span data-ai-math-slot="${activeSlots.nonce}-${n}"></span>`
}

/**
 * Parse Markdown with `parse` (whose maths renderers call mathSlot), sanitize the result with the
 * model sanitizer, then put the KaTeX output into the surviving placeholders.
 */
export function renderMarkdownWithMath(
  markdown: string,
  parse: (md: string) => string,
  purify: DomPurifySanitizeFn | DomPurifyInstance | null,
): string {
  const slots: SlotTable = { nonce: makeNonce(), html: [] }
  const previous = activeSlots
  activeSlots = slots
  let parsed: string
  try {
    parsed = parse(markdown)
  } finally {
    activeSlots = previous
  }
  const clean = sanitizeHtmlFailClosed(parsed, purify)
  if (slots.html.length === 0) return clean
  const placeholder = new RegExp(`<span data-ai-math-slot="${slots.nonce}-(\\d+)"></span>`, 'g')
  return clean.replace(placeholder, (_m, n: string) => {
    const slot = slots.html[Number(n)]
    if (slot === undefined) return ''
    if (slot.kind === 'code') return filterCodeStyles(sanitizeHtmlFailClosed(slot.html, purify, CODE_SANITIZE_CONFIG))
    return sanitizeHtmlFailClosed(slot.html, purify, KATEX_SANITIZE_CONFIG)
  })
}
