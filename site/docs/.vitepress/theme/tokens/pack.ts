/**
 * theme/tokens/pack.ts — theme pack parsing, three-layer overrides and validation (pure).
 *
 * A theme pack is a DTCG 2025.10 token file (`themes/<id>/theme.json`):
 *
 *   {
 *     "$extensions": { "org.lecture-engine": { "id": "datasheet", "label": "…", "contract": 1,
 *                       "skin": "pinout", "fonts": ["@fontsource-variable/…/wght.css"], "tints": [] } },
 *     "shared": { "font-body": { "$type": "fontFamily", "$value": ["…", "serif"] }, … },
 *     "modes":  { "light": { "$type": "color", "bg": { "$value": { "colorSpace": "srgb", … } }, … },
 *                 "dark": { … }, "<tint>": { … } }
 *   }
 *
 * Layers, later wins: theme pack → deployer `themeOverrides` (lecture.config.ts)
 * → reader overrides (settings panel / imported theme.json, P6). Reader layers only accept the
 * colour whitelist `READER_OVERRIDABLE`; every value is parsed individually and anything that could
 * smuggle CSS (`url(`, `expression`, `var(`, `;`, braces, …) is rejected.
 *
 * Used at build time by plugins/lectureThemePlugin.mts and (P6) at runtime for imported themes.
 */
import { parseColor, contrast, rgba } from './color'
import {
  BASE_MODES,
  CONTRAST_RULES,
  MARK_CONTRAST,
  MODE_TOKENS,
  READER_OVERRIDABLE,
  REQUIRED_MODE_TOKENS,
  SHARED_TOKENS,
  TEXT_CONTRAST,
  type ModeToken,
  type SharedToken,
} from './contract'
import { checkComponentsDeclaration, checkLayoutDeclaration, isLayoutEdgeStyle, type LayoutEdgeStyle } from '../slots/contract.ts'

export const EXTENSION_KEY = 'org.lecture-engine'
export const CONTRACT_VERSION = 1

export type IssueCode =
  | 'structure'
  | 'missing-token'
  | 'unknown-token'
  | 'invalid-value'
  | 'illegal-value'
  | 'not-overridable'
  | 'low-contrast'
  | 'slots'

export interface ThemeIssue {
  severity: 'error' | 'warning'
  code: IssueCode
  theme: string
  mode?: string
  token?: string
  message: string
  /** low-contrast only */
  ratio?: number
  need?: number
}

export type ModeValues = Partial<Record<ModeToken, string>>
export type SharedValues = Partial<Record<SharedToken, string>>

/** Parsed (validated) pack before inheritance / derivation. Values are CSS-ready strings. */
export interface ThemeSource {
  id: string
  label: string
  skin: string | null
  /** CSS module specifiers the pack needs (self-hosted fonts). Build-time only. */
  fonts: string[]
  /** Slot contract range the pack's components were written for (`"^1"`), or null when it declares none. */
  engine: string | null
  /** Slot name -> path relative to the pack folder, exactly as written (validated lexically, not on disk). */
  components: Record<string, string>
  /** `layout.edges` of the extension block (P4a WP-H3): the line style of the group page's lecture map; null when the pack declares none (the engine default `curve` applies). */
  edges: LayoutEdgeStyle | null
  shared: SharedValues
  /** `light`, `dark` and tint presets (tints hold only the tokens they change). */
  modes: Record<string, ModeValues>
}

/** A fully resolved theme: every shared token, every mode complete with derived tokens. */
export interface ResolvedTheme {
  id: string
  label: string
  skin: string | null
  fonts: string[]
  shared: Record<SharedToken, string>
  modes: Record<string, Record<ModeToken, string>>
  /** Tint preset names (modes other than light / dark), in pack order. */
  tints: string[]
}

/** Raw override layer (lecture.config.ts `themeOverrides[id]` or a reader layer). */
export interface ThemeLayer {
  shared?: Partial<Record<SharedToken, unknown>>
  modes?: Record<string, Partial<Record<ModeToken, unknown>> | undefined>
}

export type LayerOrigin = 'pack' | 'deployer' | 'reader'

// ---------------------------------------------------------------------------- helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Anything that could escape a custom-property value or pull in remote content. */
const ILLEGAL_RE = /url\s*\(|expression\s*\(|var\s*\(|image-set\s*\(|@import|javascript:|[;{}<>\\]/i

/** First illegal string found inside a value (deep), or null. */
export function findIllegal(value: unknown): string | null {
  if (typeof value === 'string') return ILLEGAL_RE.test(value) ? value : null
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = findIllegal(v)
      if (bad !== null) return bad
    }
    return null
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$description') continue
      const bad = findIllegal(v)
      if (bad !== null) return bad
    }
  }
  return null
}

/** `{ "$value": x }` → x; plain values pass through (convenient for lecture.config.ts). */
function unwrap(raw: unknown): unknown {
  return isRecord(raw) && '$value' in raw ? raw.$value : raw
}

const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  '-apple-system',
  'BlinkMacSystemFont',
])
const FAMILY_NAME_RE = /^[\p{L}\p{N} _.-]+$/u

function parseFontFamily(v: unknown): { ok: true; css: string } | { ok: false; reason: string } {
  const list = typeof v === 'string' ? v.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')) : v
  if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'fontFamily must be a non-empty string or array' }
  const out: string[] = []
  for (const name of list) {
    if (typeof name !== 'string' || !FAMILY_NAME_RE.test(name)) {
      return { ok: false, reason: `invalid font family name ${JSON.stringify(name)}` }
    }
    out.push(GENERIC_FAMILIES.has(name) || /^[A-Za-z][A-Za-z0-9-]*$/.test(name) ? name : `"${name}"`)
  }
  return { ok: true, css: out.join(', ') }
}

function parseDimension(v: unknown, allowPercent: boolean): { ok: true; css: string } | { ok: false; reason: string } {
  if (!isRecord(v) || typeof v.value !== 'number' || !Number.isFinite(v.value) || v.value < 0) {
    return { ok: false, reason: 'dimension must be { value: number ≥ 0, unit }' }
  }
  const units = allowPercent ? ['px', 'rem', '%'] : ['px', 'rem']
  if (typeof v.unit !== 'string' || !units.includes(v.unit)) {
    return { ok: false, reason: `dimension unit must be one of ${units.join(' / ')}` }
  }
  return { ok: true, css: `${v.value}${v.unit}` }
}

function parseFontWeight(v: unknown): { ok: true; css: string } | { ok: false; reason: string } {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1000) return { ok: true, css: String(v) }
  if (v === 'normal') return { ok: true, css: '400' }
  if (v === 'bold') return { ok: true, css: '700' }
  return { ok: false, reason: 'fontWeight must be an integer 1–1000' }
}

/** Parse one shared token value (raw DTCG `$value` or plain value). */
export function parseSharedValue(token: SharedToken, raw: unknown): { ok: true; css: string } | { ok: false; reason: string } {
  const v = unwrap(raw)
  const bad = findIllegal(v)
  if (bad !== null) return { ok: false, reason: `illegal value ${JSON.stringify(bad)}` }
  if (token.startsWith('font-')) return parseFontFamily(v)
  if (token === 'heading-weight') return parseFontWeight(v)
  // DTCG 2025.10 dimensions allow px / rem; `%` is accepted for status-radius only (50% = round
  // status marks in the reader theme, spec board §05).
  return parseDimension(v, token === 'status-radius')
}

function isModeToken(k: string): k is ModeToken {
  return (MODE_TOKENS as readonly string[]).includes(k)
}
function isSharedToken(k: string): k is SharedToken {
  return (SHARED_TOKENS as readonly string[]).includes(k)
}

// ---------------------------------------------------------------------------- pack parsing

export interface ParseResult<T> {
  value: T
  issues: ThemeIssue[]
}

/** Parse and validate a theme.json document. Errors are collected, not thrown. */
export function parseThemePack(doc: unknown, expectedId?: string): ParseResult<ThemeSource> {
  const issues: ThemeIssue[] = []
  const meta = isRecord(doc) && isRecord(doc.$extensions) ? doc.$extensions[EXTENSION_KEY] : undefined
  const id = isRecord(meta) && typeof meta.id === 'string' ? meta.id : (expectedId ?? '?')
  const err = (code: IssueCode, message: string, extra: Partial<ThemeIssue> = {}) =>
    issues.push({ severity: 'error', code, theme: id, message, ...extra })

  const source: ThemeSource = { id, label: id, skin: null, fonts: [], engine: null, components: {}, edges: null, shared: {}, modes: {} }
  if (!isRecord(doc)) {
    err('structure', 'theme.json must be a JSON object')
    return { value: source, issues }
  }
  if (!isRecord(meta)) {
    err('structure', `missing $extensions["${EXTENSION_KEY}"] block (id, label, contract)`)
  } else {
    if (typeof meta.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(meta.id)) err('structure', 'extension "id" must be a lowercase identifier')
    if (expectedId && meta.id !== expectedId) err('structure', `extension id "${String(meta.id)}" does not match folder "${expectedId}"`)
    if (meta.contract !== CONTRACT_VERSION) err('structure', `unsupported contract version ${JSON.stringify(meta.contract)} (expected ${CONTRACT_VERSION})`)
    if (typeof meta.label === 'string') source.label = meta.label
    if (typeof meta.skin === 'string') source.skin = meta.skin
    if (meta.fonts !== undefined) {
      if (!Array.isArray(meta.fonts) || !meta.fonts.every((f): f is string => typeof f === 'string' && /^[@a-z0-9][\w@./-]*\.css$/i.test(f))) {
        err('structure', 'extension "fonts" must be an array of CSS module specifiers')
      } else source.fonts = [...meta.fonts]
    }
    // P2e: slot contract range + component map (docs-dev/SLOTS.md)
    for (const issue of checkComponentsDeclaration(meta)) {
      err('slots', `theme "${id}": ${issue.message}`, issue.slot ? { token: issue.slot } : {})
    }
    // P4a WP-H3: layout.edges
    for (const issue of checkLayoutDeclaration(meta)) err('structure', `theme "${id}": ${issue.message}`)
    if (isRecord(meta.layout) && isLayoutEdgeStyle(meta.layout.edges)) source.edges = meta.layout.edges
    if (typeof meta.engine === 'string') source.engine = meta.engine
    if (isRecord(meta.components)) {
      for (const [slot, file] of Object.entries(meta.components)) if (typeof file === 'string') source.components[slot] = file
    }
  }

  const shared = doc.shared
  if (shared !== undefined && !isRecord(shared)) err('structure', '"shared" must be a token group')
  if (isRecord(shared)) {
    for (const [k, raw] of Object.entries(shared)) {
      if (k.startsWith('$')) continue
      if (!isSharedToken(k)) {
        err('unknown-token', `unknown shared token --lec-${k}`, { token: k })
        continue
      }
      const r = parseSharedValue(k, raw)
      if (r.ok) source.shared[k] = r.css
      else err(r.reason.startsWith('illegal') ? 'illegal-value' : 'invalid-value', `--lec-${k}: ${r.reason}`, { token: k })
    }
  }

  const modes = doc.modes
  if (!isRecord(modes)) {
    err('structure', '"modes" group is required (light and dark)')
    return { value: source, issues }
  }
  for (const [mode, group] of Object.entries(modes)) {
    if (mode.startsWith('$')) continue
    if (!/^[a-z][a-z0-9-]*$/.test(mode)) {
      err('structure', `invalid mode name "${mode}"`, { mode })
      continue
    }
    if (!isRecord(group)) {
      err('structure', `mode "${mode}" must be a token group`, { mode })
      continue
    }
    const groupType = group.$type
    const values: ModeValues = {}
    for (const [k, raw] of Object.entries(group)) {
      if (k.startsWith('$')) continue
      if (!isModeToken(k)) {
        err('unknown-token', `mode "${mode}": unknown token --lec-${k}`, { mode, token: k })
        continue
      }
      const type = isRecord(raw) && typeof raw.$type === 'string' ? raw.$type : groupType
      if (type !== undefined && type !== 'color') {
        err('invalid-value', `mode "${mode}": --lec-${k} must have $type "color"`, { mode, token: k })
        continue
      }
      const v = unwrap(raw)
      const bad = findIllegal(v)
      if (bad !== null) {
        err('illegal-value', `mode "${mode}": --lec-${k}: illegal value ${JSON.stringify(bad)}`, { mode, token: k })
        continue
      }
      const c = parseColor(v)
      if (c.ok) values[k] = c.hex
      else err('invalid-value', `mode "${mode}": --lec-${k}: ${c.reason}`, { mode, token: k })
    }
    source.modes[mode] = values
  }
  for (const m of BASE_MODES) {
    if (!source.modes[m]) err('structure', `mode "${m}" is required`, { mode: m })
  }
  return { value: source, issues }
}

// ---------------------------------------------------------------------------- layers

/**
 * Apply an override layer on top of a source. Returns a new source; invalid entries are dropped
 * and reported. Reader layers: colour whitelist only, existing modes only.
 */
export function applyLayer(base: ThemeSource, layer: unknown, origin: Exclude<LayerOrigin, 'pack'>): ParseResult<ThemeSource> {
  const issues: ThemeIssue[] = []
  const out: ThemeSource = {
    ...base,
    shared: { ...base.shared },
    modes: Object.fromEntries(Object.entries(base.modes).map(([m, v]) => [m, { ...v }])),
  }
  const err = (code: IssueCode, message: string, extra: Partial<ThemeIssue> = {}) =>
    issues.push({ severity: 'error', code, theme: base.id, message: `${origin} override: ${message}`, ...extra })
  if (layer === undefined || layer === null) return { value: out, issues }
  if (!isRecord(layer)) {
    err('structure', 'layer must be an object { shared?, modes? }')
    return { value: out, issues }
  }
  for (const key of Object.keys(layer)) {
    if (key !== 'shared' && key !== 'modes') err('structure', `unknown key "${key}"`)
  }
  if (layer.shared !== undefined) {
    if (!isRecord(layer.shared)) err('structure', '"shared" must be an object')
    else
      for (const [k, raw] of Object.entries(layer.shared)) {
        if (!isSharedToken(k)) {
          err('unknown-token', `unknown shared token --lec-${k}`, { token: k })
          continue
        }
        if (origin === 'reader') {
          err('not-overridable', `--lec-${k} cannot be overridden by a reader`, { token: k })
          continue
        }
        const r = parseSharedValue(k, raw)
        if (r.ok) out.shared[k] = r.css
        else err(r.reason.startsWith('illegal') ? 'illegal-value' : 'invalid-value', `--lec-${k}: ${r.reason}`, { token: k })
      }
  }
  if (layer.modes !== undefined) {
    if (!isRecord(layer.modes)) err('structure', '"modes" must be an object')
    else
      for (const [mode, group] of Object.entries(layer.modes)) {
        if (group === undefined) continue
        if (!isRecord(group)) {
          err('structure', `mode "${mode}" must be an object`, { mode })
          continue
        }
        if (!out.modes[mode]) {
          if (origin === 'reader') {
            err('structure', `mode "${mode}" does not exist in theme "${base.id}"`, { mode })
            continue
          }
          out.modes[mode] = {}
        }
        const target = out.modes[mode] as ModeValues
        for (const [k, raw] of Object.entries(group)) {
          if (!isModeToken(k)) {
            err('unknown-token', `mode "${mode}": unknown token --lec-${k}`, { mode, token: k })
            continue
          }
          if (origin === 'reader' && !READER_OVERRIDABLE.has(k)) {
            err('not-overridable', `mode "${mode}": --lec-${k} cannot be overridden by a reader`, { mode, token: k })
            continue
          }
          const v = unwrap(raw)
          const bad = findIllegal(v)
          if (bad !== null) {
            err('illegal-value', `mode "${mode}": --lec-${k}: illegal value ${JSON.stringify(bad)}`, { mode, token: k })
            continue
          }
          const c = parseColor(v)
          if (c.ok) target[k] = c.hex
          else err('invalid-value', `mode "${mode}": --lec-${k}: ${c.reason}`, { mode, token: k })
        }
      }
  }
  return { value: out, issues }
}

// ---------------------------------------------------------------------------- resolve + check

const TINT_ALPHA: Record<'accent' | 'danger' | 'warning', { light: number; dark: number }> = {
  accent: { light: 0.08, dark: 0.12 },
  danger: { light: 0.07, dark: 0.12 },
  warning: { light: 0.09, dark: 0.12 },
}

/** Fill derived optional tokens (spec board `decls()`). Requires the required tokens. */
function derive(values: ModeValues, dark: boolean): Record<ModeToken, string> {
  const v = { ...values } as Record<ModeToken, string>
  v['cat-7'] ??= v['cat-1']
  v['cat-8'] ??= v['cat-2']
  v.chip ??= v.text
  v['chip-text'] ??= v.bg
  v['chip-edge'] ??= v.text
  // the map stage (S6Y AH #6): a pack without its own canvas keeps the page background behind the maps
  v.canvas ??= v.bg
  for (const k of ['accent', 'danger', 'warning'] as const) {
    const tint = `${k}-tint` as const
    v[tint] ??= rgba(v[k], TINT_ALPHA[k][dark ? 'dark' : 'light'])
  }
  return v
}

/**
 * Inherit shared tokens from `base` (the reader pack), merge tint presets over `light`, derive
 * optional tokens, and report missing required tokens (always errors, naming the token).
 */
export function resolveTheme(src: ThemeSource, base?: ThemeSource): ParseResult<ResolvedTheme | null> {
  const issues: ThemeIssue[] = []
  const shared = { ...(base?.shared ?? {}), ...src.shared } as SharedValues
  for (const t of SHARED_TOKENS) {
    if (shared[t] === undefined) {
      issues.push({ severity: 'error', code: 'missing-token', theme: src.id, token: t, message: `missing shared token --lec-${t} (and no base theme provides it)` })
    }
  }
  const light = src.modes.light ?? {}
  const modes: Record<string, Record<ModeToken, string>> = {}
  const tints: string[] = []
  for (const [mode, own] of Object.entries(src.modes)) {
    const isBase = (BASE_MODES as readonly string[]).includes(mode)
    if (!isBase) tints.push(mode)
    const merged: ModeValues = isBase ? { ...own } : { ...light, ...own }
    // a tint changes the page background: the light canvas (grey) would not sit on it; derive it from the tint's bg
    if (!isBase && own.canvas === undefined) delete merged.canvas
    const missing = REQUIRED_MODE_TOKENS.filter((t) => merged[t] === undefined)
    for (const t of missing) {
      issues.push({ severity: 'error', code: 'missing-token', theme: src.id, mode, token: t, message: `theme "${src.id}" mode "${mode}": missing required token --lec-${t}` })
    }
    if (missing.length === 0) modes[mode] = derive(merged, mode === 'dark')
  }
  const ok = !issues.some((i) => i.severity === 'error') && BASE_MODES.every((m) => modes[m])
  return {
    value: ok
      ? { id: src.id, label: src.label, skin: src.skin, fonts: src.fonts, shared: shared as Record<SharedToken, string>, modes, tints }
      : null,
    issues,
  }
}

export interface ContrastRow {
  mode: string
  fg: ModeToken
  bg: ModeToken
  ratio: number
  need: number
  pass: boolean
}

/** Every contrast rule for every mode of a resolved theme. */
export function contrastReport(theme: ResolvedTheme): ContrastRow[] {
  const rows: ContrastRow[] = []
  for (const [mode, v] of Object.entries(theme.modes)) {
    for (const rule of CONTRAST_RULES) {
      const need = rule.kind === 'text' ? TEXT_CONTRAST : MARK_CONTRAST
      const ratio = contrast(v[rule.fg], v[rule.bg])
      rows.push({ mode, fg: rule.fg, bg: rule.bg, ratio, need, pass: ratio >= need })
    }
  }
  return rows
}

/** Contrast failures as issues (warnings; the caller escalates under --strict). */
export function checkContrast(theme: ResolvedTheme, severity: 'warning' | 'error' = 'warning'): ThemeIssue[] {
  return contrastReport(theme)
    .filter((r) => !r.pass)
    .map((r) => ({
      severity,
      code: 'low-contrast' as const,
      theme: theme.id,
      mode: r.mode,
      token: r.fg,
      ratio: r.ratio,
      need: r.need,
      message: `theme "${theme.id}" mode "${r.mode}": --lec-${r.fg} on --lec-${r.bg} is ${r.ratio.toFixed(2)}:1 (needs ${r.need}:1)`,
    }))
}

export function formatIssue(i: ThemeIssue): string {
  return `[lecture-theme] ${i.severity.toUpperCase()} ${i.code}: ${i.message}`
}
