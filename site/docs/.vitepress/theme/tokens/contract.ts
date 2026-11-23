/**
 * theme/tokens/contract.ts — the `--lec-*` token contract (spec board §00).
 *
 * Components may ONLY reference the names listed here. Theme packs (`themes/<id>/theme.json`) give
 * values to the theme tokens; the engine sets the engine tokens itself. `scripts/check_theme_contract.mjs`
 * reads this file (the `export const … = [ … ]` literals) and fails on any other `--lec-*` name.
 *
 * Pure data + types: no DOM, no Node APIs. Shared by the build-time compiler and the browser.
 */

/** Colour tokens every mode (light / dark / tint preset) must define. */
export const REQUIRED_MODE_TOKENS = [
  'bg',
  'surface',
  'text',
  'text-muted',
  'border',
  'accent',
  'on-accent',
  'done',
  'done-text',
  'danger',
  'warning',
  'cat-1',
  'cat-2',
  'cat-3',
  'cat-4',
  'cat-5',
  'cat-6',
] as const

/**
 * Colour tokens a mode may define. When absent the compiler derives them:
 * cat-7 / cat-8 wrap to cat-1 / cat-2; chip* fall back to text / bg / text (spec board `decls()`);
 * *-tint are the base colour at a fixed alpha.
 */
export const OPTIONAL_MODE_TOKENS = [
  'cat-7',
  'cat-8',
  'chip',
  'chip-text',
  'chip-edge',
  'accent-tint',
  'danger-tint',
  'warning-tint',
] as const

/** Theme-wide (mode-independent) tokens. All optional: missing ones inherit the `reader` defaults. */
export const SHARED_TOKENS = [
  'font-body',
  'font-heading',
  'font-mono',
  'font-body-serif',
  'font-body-sans',
  'radius-1',
  'radius-2',
  'status-radius',
  'heading-weight',
] as const

/**
 * Engine tokens: set by the engine stylesheet (or by reader preferences), never by a theme pack.
 * Typography line-height contract (plan §4, AGENTS.md §4.9): prose 17px × 2.212 = 37.6px line box,
 * inline maths .81em (= 0.86 × 16/17). Layout tokens predate V2 (AI sidebar width, cite size, chart
 * label line height) and are kept as engine tokens so existing CSS stays inside the contract.
 */
export const ENGINE_TOKENS = [
  'prose-size',
  'prose-line-height',
  'math-inline-size',
  'cite-size',
  'chart-line-height',
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'space-5',
  'space-6',
  'space-7',
  'space-8',
  'line-hair',
  'line-mid',
  'line-heavy',
  'ai-width',
  'ai-base-width',
] as const

export type RequiredModeToken = (typeof REQUIRED_MODE_TOKENS)[number]
export type OptionalModeToken = (typeof OPTIONAL_MODE_TOKENS)[number]
export type ModeToken = RequiredModeToken | OptionalModeToken
export type SharedToken = (typeof SHARED_TOKENS)[number]
export type EngineToken = (typeof ENGINE_TOKENS)[number]
export type ContractToken = ModeToken | SharedToken | EngineToken

export const MODE_TOKENS: readonly ModeToken[] = [...REQUIRED_MODE_TOKENS, ...OPTIONAL_MODE_TOKENS]

/** Every legal custom-property name (with the `--lec-` prefix). */
export const CONTRACT_NAMES: ReadonlySet<string> = new Set(
  [...MODE_TOKENS, ...SHARED_TOKENS, ...ENGINE_TOKENS].map((t) => `--lec-${t}`),
)

export function cssVar(token: ContractToken): string {
  return `--lec-${token}`
}

/** Number of category colour slots exposed to components (`--lec-cat-1` … `--lec-cat-8`). */
export const CATEGORY_SLOTS = 8

/** Modes every theme must ship. */
export const BASE_MODES = ['light', 'dark'] as const
export type BaseMode = (typeof BASE_MODES)[number]

/** Reader body-font sizes (px) offered by the settings panel (P6); 17 is the contract default. */
export const PROSE_SIZES = [16, 17, 18, 20] as const
export type ProseSize = (typeof PROSE_SIZES)[number]
export const DEFAULT_PROSE_SIZE: ProseSize = 17

/** Values of the engine tokens. Colour-free by construction. */
export const ENGINE_VALUES: Readonly<Record<Exclude<EngineToken, 'ai-width' | 'ai-base-width'>, string>> = {
  'prose-size': `${DEFAULT_PROSE_SIZE}px`,
  'prose-line-height': '2.212',
  'math-inline-size': '.81em',
  // User decision (2026-10): citation chips stay at 0.6em. The P2a spec board's .78em was a drafting error.
  'cite-size': '.6em',
  'chart-line-height': '1.5',
  'space-1': '4px',
  'space-2': '8px',
  'space-3': '12px',
  'space-4': '16px',
  'space-5': '24px',
  'space-6': '32px',
  'space-7': '48px',
  'space-8': '64px',
  'line-hair': '1px',
  'line-mid': '1.5px',
  'line-heavy': '2px',
}

/** Contrast floors against `--lec-bg` (spec board §00): text ≥ 4.5, graphical marks ≥ 3. */
export const TEXT_CONTRAST = 4.5
export const MARK_CONTRAST = 3

export type ContrastKind = 'text' | 'mark'

export interface ContrastRule {
  fg: ModeToken
  bg: ModeToken
  kind: ContrastKind
}

/** Pairs checked for every mode. `border` is decorative and not checked (spec board §00). */
export const CONTRAST_RULES: readonly ContrastRule[] = [
  { fg: 'text', bg: 'bg', kind: 'text' },
  { fg: 'text-muted', bg: 'bg', kind: 'text' },
  { fg: 'accent', bg: 'bg', kind: 'text' },
  { fg: 'done-text', bg: 'bg', kind: 'text' },
  { fg: 'danger', bg: 'bg', kind: 'text' },
  { fg: 'warning', bg: 'bg', kind: 'text' },
  { fg: 'text', bg: 'surface', kind: 'text' },
  { fg: 'text-muted', bg: 'surface', kind: 'text' },
  { fg: 'on-accent', bg: 'accent', kind: 'text' },
  { fg: 'chip-text', bg: 'chip', kind: 'text' },
  { fg: 'done', bg: 'bg', kind: 'mark' },
  { fg: 'cat-1', bg: 'bg', kind: 'mark' },
  { fg: 'cat-2', bg: 'bg', kind: 'mark' },
  { fg: 'cat-3', bg: 'bg', kind: 'mark' },
  { fg: 'cat-4', bg: 'bg', kind: 'mark' },
  { fg: 'cat-5', bg: 'bg', kind: 'mark' },
  { fg: 'cat-6', bg: 'bg', kind: 'mark' },
]

/**
 * Tokens a reader may override (settings panel / imported theme.json, P6). Fonts and structural
 * tokens are excluded on purpose: a reader layer can recolour, not restyle.
 */
export const READER_OVERRIDABLE: ReadonlySet<ModeToken> = new Set<ModeToken>([
  ...REQUIRED_MODE_TOKENS,
  'chip',
  'chip-text',
  'chip-edge',
])
