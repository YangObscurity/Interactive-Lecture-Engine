/**
 * tokens/customTint.ts — Runtime reader custom tint contrast guard & theme.json layer helpers (P6, WP-A4).
 * Pure math & DTCG validation reusing `tokens/color.ts` and `tokens/pack.ts`.
 * Placed under `theme/tokens/` so contrast constants live alongside token contract utilities.
 */

import { contrast, parseColor, parseHex, toHex, type Rgb } from './color'
import { MODE_TOKENS, READER_OVERRIDABLE, type ModeToken } from './contract'
import { parseThemePack, type ThemeLayer } from './pack'
import { STORAGE_KEYS } from '../../site.config.mts'

export interface CustomTintConfig {
  hue: number
  lightness: number
}

export type CustomTintFailReason = 'text' | 'muted' | 'accent'

export interface CustomTintResult {
  hue: number
  lightness: number
  dark: boolean
  bgHex: string
  surfaceHex: string
  borderHex: string
  textHex: string
  mutedHex: string
  accentHex: string
  accentTintHex: string
  onAccentHex: string
  textRatio: number
  mutedRatio: number
  accentRatio: number
  minRatio: number
  pass: boolean
  failReasons: CustomTintFailReason[]
  tokens: Record<string, string>
}

const READER_LIGHT_TEXT = '#1F2328'
export const CUSTOM_TINT_MIN_CONTRAST = 4.5
export const CUSTOM_TINT_TEXT_CONTRAST = 7.0
export const MAX_THEME_IMPORT_BYTES = 256 * 1024

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function hslToRgb(hue: number, satPct: number, lightPct: number): Rgb {
  const h = ((hue % 360) + 360) % 360
  const s = clamp(satPct, 0, 100) / 100
  const l = clamp(lightPct, 0, 100) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r1 = 0
  let g1 = 0
  let b1 = 0
  if (h < 60) {
    r1 = c
    g1 = x
  } else if (h < 120) {
    r1 = x
    g1 = c
  } else if (h < 180) {
    g1 = c
    b1 = x
  } else if (h < 240) {
    g1 = x
    b1 = c
  } else if (h < 300) {
    r1 = x
    b1 = c
  } else {
    r1 = c
    b1 = x
  }
  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  }
}

function searchContrast(
  from: number,
  to: number,
  step: number,
  hue: number,
  satPct: number,
  bgHex: string,
  minContrast: number,
): { hex: string; ratio: number; ok: boolean } {
  let lastHex = toHex(hslToRgb(hue, satPct, to))
  let lastRatio = contrast(lastHex, bgHex)
  for (let l = from; step > 0 ? l <= to : l >= to; l += step) {
    const hex = toHex(hslToRgb(hue, satPct, l))
    const ratio = contrast(hex, bgHex)
    lastHex = hex
    lastRatio = ratio
    if (ratio >= minContrast) {
      return { hex, ratio, ok: true }
    }
  }
  return { hex: lastHex, ratio: lastRatio, ok: lastRatio >= minContrast }
}

function mixHex(fgHex: string, bgHex: string, weight: number): string {
  const fg = parseHex(fgHex)
  const bg = parseHex(bgHex)
  if (!fg || !bg) return bgHex
  return toHex({
    r: fg.r * weight + bg.r * (1 - weight),
    g: fg.g * weight + bg.g * (1 - weight),
    b: fg.b * weight + bg.b * (1 - weight),
  })
}

/** Spec board §02 `customPalette()`: H 0..360, L 8..97, polarity flips at L < 50. */
export function computeCustomTint(hue: number, lightness: number): CustomTintResult {
  const cleanHue = Number.isFinite(hue) ? clamp(Math.round(hue), 0, 360) : 42
  const cleanLightness = Number.isFinite(lightness) ? clamp(Math.round(lightness), 8, 97) : 95
  const dark = cleanLightness < 50

  const bgHex = toHex(hslToRgb(cleanHue, 35, cleanLightness))
  const surfaceHex = toHex(hslToRgb(cleanHue, 32, clamp(dark ? cleanLightness + 4 : cleanLightness - 4, 2, 98)))
  const borderHex = toHex(hslToRgb(cleanHue, 22, clamp(dark ? cleanLightness + 12 : cleanLightness - 14, 2, 98)))

  const textRes = dark
    ? searchContrast(80, 98, 2, cleanHue, 18, bgHex, CUSTOM_TINT_TEXT_CONTRAST)
    : searchContrast(30, 4, -2, cleanHue, 18, bgHex, CUSTOM_TINT_TEXT_CONTRAST)
  const mutedRes = dark
    ? searchContrast(56, 96, 2, cleanHue, 12, bgHex, CUSTOM_TINT_MIN_CONTRAST)
    : searchContrast(44, 4, -2, cleanHue, 12, bgHex, CUSTOM_TINT_MIN_CONTRAST)
  const accentRes = dark
    ? searchContrast(62, 92, 2, 220, 75, bgHex, CUSTOM_TINT_MIN_CONTRAST)
    : searchContrast(44, 10, -2, 220, 70, bgHex, CUSTOM_TINT_MIN_CONTRAST)

  const accentTintHex = mixHex(accentRes.hex, bgHex, dark ? 0.18 : 0.12)
  const onAccentHex = contrast('#FFFFFF', accentRes.hex) >= contrast('#111827', accentRes.hex) ? '#FFFFFF' : '#111827'

  const failReasons: CustomTintFailReason[] = []
  if (!textRes.ok) failReasons.push('text')
  if (!mutedRes.ok) failReasons.push('muted')
  if (!accentRes.ok) failReasons.push('accent')

  const minRatio = Math.min(textRes.ratio, mutedRes.ratio, accentRes.ratio)
  const tokens: Record<string, string> = {
    '--lec-bg': bgHex,
    '--lec-surface': surfaceHex,
    '--lec-border': borderHex,
    '--lec-text': textRes.hex,
    '--lec-text-muted': mutedRes.hex,
    '--lec-accent': accentRes.hex,
    '--lec-accent-tint': accentTintHex,
    '--lec-on-accent': onAccentHex,
  }

  return {
    hue: cleanHue,
    lightness: cleanLightness,
    dark,
    bgHex,
    surfaceHex,
    borderHex,
    textHex: textRes.hex,
    mutedHex: mutedRes.hex,
    accentHex: accentRes.hex,
    accentTintHex,
    onAccentHex,
    textRatio: textRes.ratio,
    mutedRatio: mutedRes.ratio,
    accentRatio: accentRes.ratio,
    minRatio,
    pass: failReasons.length === 0,
    failReasons,
    tokens,
  }
}

export function readCustomTint(): CustomTintConfig | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.readerCustomTint)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.hue !== 'number' || typeof obj.lightness !== 'number') return null
    return { hue: obj.hue, lightness: obj.lightness }
  } catch {
    return null
  }
}

export function writeCustomTint(cfg: CustomTintConfig | null): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  try {
    if (!cfg) window.localStorage.removeItem(STORAGE_KEYS.readerCustomTint)
    else window.localStorage.setItem(STORAGE_KEYS.readerCustomTint, JSON.stringify(cfg))
  } catch {
    // ignore storage errors
  }
}

const CUSTOM_TINT_TOKEN_PROPS = [
  '--lec-bg',
  '--lec-surface',
  '--lec-border',
  '--lec-text',
  '--lec-text-muted',
  '--lec-accent',
  '--lec-accent-tint',
  '--lec-on-accent',
] as const

export function clearCustomTintProps(root: HTMLElement | null): void {
  if (!root) return
  for (const prop of CUSTOM_TINT_TOKEN_PROPS) {
    root.style.removeProperty(prop)
  }
  root.style.removeProperty('color-scheme')
}

export function applyCustomTintToRoot(root: HTMLElement | null, cfg: CustomTintConfig | null): boolean {
  if (!root) return false
  if (!cfg) {
    clearCustomTintProps(root)
    return true
  }
  const result = computeCustomTint(cfg.hue, cfg.lightness)
  if (!result.pass) {
    return false
  }
  for (const [prop, val] of Object.entries(result.tokens)) {
    root.style.setProperty(prop, val)
  }
  root.style.colorScheme = result.dark ? 'dark' : 'light'
  return true
}

export type ThemeImportOutcome =
  | { ok: true; tokenCount: number; layer: ThemeLayer }
  | { ok: false; message: string }

function sanitizeModeGroup(rawMode: Record<string, unknown>): {
  values: Partial<Record<ModeToken, string>>
  error?: string
} {
  const out: Partial<Record<ModeToken, string>> = {}
  for (const [k, rawVal] of Object.entries(rawMode)) {
    if (k.startsWith('$')) continue
    if (!(MODE_TOKENS as readonly string[]).includes(k)) {
      return { values: out, error: `Unknown token: ${k}` }
    }
    if (!READER_OVERRIDABLE.has(k as ModeToken)) {
      continue
    }
    const unwrapped =
      rawVal && typeof rawVal === 'object' && '$value' in (rawVal as Record<string, unknown>)
        ? (rawVal as Record<string, unknown>).$value
        : rawVal
    const parsed = parseColor(unwrapped)
    if (!parsed.ok) {
      return { values: out, error: `Invalid color for ${k}: ${parsed.reason}` }
    }
    out[k as ModeToken] = parsed.hex
  }
  return { values: out }
}

export function validateThemeImportJson(rawText: string): ThemeImportOutcome {
  if (rawText.length > MAX_THEME_IMPORT_BYTES) {
    return { ok: false, message: 'Theme file exceeds 256 KB size limit' }
  }
  let doc: unknown
  try {
    doc = JSON.parse(rawText)
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : 'Invalid JSON' }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, message: 'Theme file must be a JSON object' }
  }
  const obj = doc as Record<string, unknown>

  const modesOut: Record<string, Partial<Record<ModeToken, string>>> = {}
  let tokenCount = 0

  if ('$extensions' in obj) {
    const packed = parseThemePack(obj)
    const fatal = packed.issues.find((i) => i.severity === 'error')
    if (fatal) {
      return { ok: false, message: fatal.message }
    }
    for (const [modeName, tokens] of Object.entries(packed.value.modes)) {
      const modeVals: Partial<Record<ModeToken, string>> = {}
      for (const [tk, val] of Object.entries(tokens)) {
        if (val && READER_OVERRIDABLE.has(tk as ModeToken)) {
          modeVals[tk as ModeToken] = val
          tokenCount += 1
        }
      }
      if (Object.keys(modeVals).length > 0) modesOut[modeName] = modeVals
    }
  } else if (obj.modes && typeof obj.modes === 'object' && !Array.isArray(obj.modes)) {
    for (const [modeName, rawGroup] of Object.entries(obj.modes as Record<string, unknown>)) {
      if (!rawGroup || typeof rawGroup !== 'object' || Array.isArray(rawGroup)) {
        return { ok: false, message: `Invalid mode "${modeName}"` }
      }
      const res = sanitizeModeGroup(rawGroup as Record<string, unknown>)
      if (res.error) return { ok: false, message: res.error }
      const keys = Object.keys(res.values)
      if (keys.length > 0) {
        modesOut[modeName] = res.values
        tokenCount += keys.length
      }
    }
  } else {
    return { ok: false, message: 'Missing "modes" token group' }
  }

  if (tokenCount === 0) {
    return { ok: false, message: 'No reader-overridable color tokens found' }
  }

  for (const [modeName, vals] of Object.entries(modesOut)) {
    const bgHex = vals.bg ?? (modeName === 'dark' ? '#14171C' : '#FFFFFF')
    const textHex = vals.text ?? (modeName === 'dark' ? '#E6EDF3' : READER_LIGHT_TEXT)
    if (parseHex(bgHex) && parseHex(textHex)) {
      const ratio = contrast(textHex, bgHex)
      if (ratio < CUSTOM_TINT_MIN_CONTRAST) {
        return {
          ok: false,
          message: `Mode "${modeName}" text contrast ${ratio.toFixed(2)}:1 is below ${CUSTOM_TINT_MIN_CONTRAST}:1`,
        }
      }
    }
  }

  return { ok: true, tokenCount, layer: { modes: modesOut } }
}

export function readReaderThemeLayer(): ThemeLayer | null {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.readerThemeLayer)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as ThemeLayer
  } catch {
    return null
  }
}

export function writeReaderThemeLayer(layer: ThemeLayer | null): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return
  try {
    if (!layer) window.localStorage.removeItem(STORAGE_KEYS.readerThemeLayer)
    else window.localStorage.setItem(STORAGE_KEYS.readerThemeLayer, JSON.stringify(layer))
  } catch {
    // ignore storage errors
  }
}

export function applyThemeLayerToRoot(
  root: HTMLElement | null,
  layer: ThemeLayer | null,
  isDark: boolean,
  activeTint: string | null = null
): void {
  if (!root) return
  for (const token of READER_OVERRIDABLE) {
    root.style.removeProperty(`--lec-${token}`)
  }
  if (!layer?.modes) return
  const modeKey = isDark ? 'dark' : activeTint && layer.modes[activeTint] ? activeTint : 'light'
  const values = layer.modes[modeKey] ?? layer.modes.light
  if (!values) return
  for (const [token, val] of Object.entries(values)) {
    if (typeof val === 'string' && READER_OVERRIDABLE.has(token as ModeToken)) {
      root.style.setProperty(`--lec-${token}`, val)
    }
  }
}
