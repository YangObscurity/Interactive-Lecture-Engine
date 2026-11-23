/**
 * Shared types for group-managed figures (WP-F8).
 * Kept pure (no Node / Ajv / VitePress / content-path imports) so client and SSR bundles stay small.
 */

export type FigureKind = 'figure' | 'table'
export type FigureSize = 'thumb' | 'medium' | 'full'
export type FigureFloat = 'right' | 'left' | 'none'

export interface FigureCaption {
  zh: string
  en: string
}

export interface FigureSource {
  paper: string
  number?: string
  page?: number | string
}

export interface FigureEntry {
  id: string
  file: string
  kind: FigureKind
  width: number
  height: number
  caption: FigureCaption
  source: FigureSource
  doi?: string
  url?: string
  sha256: string
  original?: string
}

export interface FiguresRegistry {
  version: 1
  group: string
  figures: FigureEntry[]
}

export interface FigureBacklink {
  /** DOM element id of the in-text cross-reference anchor (`xref-<figId>-<k>`). */
  anchorId: string
  /** Sequential citation marker (e.g. `↑` or `1`, `2` when referenced multiple times). */
  label: string
}

export interface ResolvedFigureItem {
  id: string
  kind: FigureKind
  /** Presentation URL (dev or production; tier-prefixed for restricted groups in production). */
  src: string
  /** Optional raw file URL for "open original" in the viewer; never preloaded. */
  originalSrc?: string
  width: number
  height: number
  /** Per-lecture sequential number assigned in order of appearance per kind. */
  num: number
  /** Localized display title, e.g. `图 1` / `Fig. 1` / `表 1` / `Table 1`. */
  label: string
  caption: string
  sourceText: string
  paper: string
  sourceNumber?: string
  sourcePage?: number | string
  doi?: string
  url?: string
  backlinks: readonly FigureBacklink[]
}

export interface ResolvedFigureMountProps {
  group: string
  size: FigureSize
  float: FigureFloat
  items: readonly ResolvedFigureItem[]
}

export interface FigureHoverPreviewPayload {
  id: string
  kind: FigureKind
  label: string
  title: string
  src: string
  caption: string
  sourceText: string
  width: number
  height: number
}

export interface GalleryLectureRef {
  route: string
  title: string
}

export interface FigureGalleryItem {
  group: string
  groupId: string
  groupTitle: { zh: string; en: string }
  tier: string
  id: string
  kind: FigureKind
  file: string
  src: string
  originalSrc?: string
  width: number
  height: number
  bytes: number
  caption: FigureCaption
  source: FigureSource
  doi?: string
  url?: string
  sha256: string
  usedIn: GalleryLectureRef[]
}

export interface GalleryPayload {
  version: 1
  items: FigureGalleryItem[]
}
