/**
 * map/atlas/measure.ts - text widths from the browser (P4a WP-H2): `measureText` on a canvas with the fonts the theme sets.
 * Client only; the server and the first client render use `estimateTextWidth` (layout.ts) so that both agree.
 */
import { estimateTextWidth } from './layout.ts'
import type { AtlasFontSpec } from './skins.ts'

export interface FontFamilies {
  body: string
  heading: string
  mono: string
}

/** The three font stacks of the active theme (`--lec-font-*`), read from `<html>`. */
export function readFontFamilies(root: HTMLElement = document.documentElement): FontFamilies {
  const cs = getComputedStyle(root)
  const get = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    body: get('--lec-font-body', 'sans-serif'),
    heading: get('--lec-font-heading', 'sans-serif'),
    mono: get('--lec-font-mono', 'monospace'),
  }
}

/** A width function backed by a canvas context; falls back to the estimate when no 2D context exists. */
export function canvasWidth(families: FontFamilies): (text: string, font: AtlasFontSpec) => number {
  const ctx = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!ctx) return estimateTextWidth
  return (text, font) => {
    ctx.font = `${font.weight} ${font.size}px ${families[font.family]}`
    return ctx.measureText(text).width
  }
}
