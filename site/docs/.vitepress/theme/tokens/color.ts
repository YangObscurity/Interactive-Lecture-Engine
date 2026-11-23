/**
 * theme/tokens/color.ts — colour parsing and WCAG 2.x contrast (pure, browser + Node).
 *
 * Accepted inputs (everything else is rejected, never guessed):
 *   - CSS hex `#rgb` / `#rrggbb` (alpha forms are rejected: contract colours are opaque);
 *   - DTCG 2025.10 colour objects `{ colorSpace: 'srgb', components: [r, g, b], alpha?, hex? }` with
 *     components in [0, 1]; other colour spaces are accepted only through their `hex` fallback.
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

export function parseHex(input: string): Rgb | null {
  const m = HEX_RE.exec(input.trim())
  if (!m || m[1] === undefined) return null
  let h = m[1]
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

export function toHex({ r, g, b }: Rgb): string {
  const p = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${p(r)}${p(g)}${p(b)}`.toUpperCase()
}

export type ColorParse = { ok: true; hex: string; rgb: Rgb } | { ok: false; reason: string }

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Parse a token colour value (hex string or DTCG colour object) to an opaque sRGB hex. */
export function parseColor(value: unknown): ColorParse {
  if (typeof value === 'string') {
    const rgb = parseHex(value)
    return rgb ? { ok: true, hex: toHex(rgb), rgb } : { ok: false, reason: `not a #rgb / #rrggbb colour: ${JSON.stringify(value)}` }
  }
  if (!isRecord(value)) return { ok: false, reason: 'colour must be a hex string or a DTCG colour object' }
  const alpha = value.alpha
  if (alpha !== undefined && alpha !== 1) return { ok: false, reason: 'contract colours must be opaque (alpha 1)' }
  const space = value.colorSpace
  const comps = value.components
  if (space === 'srgb' && Array.isArray(comps) && comps.length === 3) {
    const [r, g, b] = comps as unknown[]
    if (![r, g, b].every((c): c is number => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1)) {
      return { ok: false, reason: 'srgb components must be three numbers in [0, 1]' }
    }
    const rgb = { r: (r as number) * 255, g: (g as number) * 255, b: (b as number) * 255 }
    const hex = toHex(rgb)
    const fromHex = typeof value.hex === 'string' ? parseHex(value.hex) : null
    if (typeof value.hex === 'string' && !fromHex) return { ok: false, reason: `invalid hex fallback ${JSON.stringify(value.hex)}` }
    if (fromHex && toHex(fromHex) !== hex) {
      return { ok: false, reason: `components ${hex} disagree with hex fallback ${toHex(fromHex)}` }
    }
    return { ok: true, hex, rgb: parseHex(hex) as Rgb }
  }
  if (typeof value.hex === 'string') {
    const rgb = parseHex(value.hex)
    if (rgb) return { ok: true, hex: toHex(rgb), rgb }
  }
  return { ok: false, reason: `unsupported colour space ${JSON.stringify(space)} without a hex fallback` }
}

function channel(v: number): number {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** WCAG 2.x relative luminance. */
export function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
}

/** WCAG 2.x contrast ratio (1 … 21). */
export function contrast(a: Rgb | string, b: Rgb | string): number {
  const x = typeof a === 'string' ? parseHex(a) : a
  const y = typeof b === 'string' ? parseHex(b) : b
  if (!x || !y) throw new TypeError('contrast: invalid colour')
  const la = luminance(x)
  const lb = luminance(y)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `rgba(r, g, b, a)` CSS for a derived translucent token. */
export function rgba(hex: string, alpha: number): string {
  const c = parseHex(hex)
  if (!c) throw new TypeError(`rgba: invalid colour ${hex}`)
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`
}

/** sRGB components rounded to 4 decimals (for writing DTCG colour objects). */
export function toComponents(hex: string): [number, number, number] {
  const c = parseHex(hex)
  if (!c) throw new TypeError(`toComponents: invalid colour ${hex}`)
  const r4 = (v: number) => Math.round((v / 255) * 10000) / 10000
  return [r4(c.r), r4(c.g), r4(c.b)]
}
