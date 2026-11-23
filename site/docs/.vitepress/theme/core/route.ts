/**
 * core/route.ts — the single source for route path normalisation and lecture id parsing.
 *
 * Every V2 module asks this file "which page is this?" instead of carrying its own regex
 * (review FE-035 / FE-058). Pure functions, SSR-safe, no imports.
 *
 * Formats (must stay byte-identical to V1, users' localStorage depends on them):
 *   - normalised path  `/g05/L19` — what V1 reading-progress used as its store key
 *     (`location.pathname` minus trailing slash and `.html`). Case is preserved.
 *   - lectureId        `g05-L19`  — what V1 `useLectureContext` produced and neonRepository
 *     stores (it lower-cases ids itself: `g05-l19`). Group = LAST directory segment, lower-cased;
 *     number zero-padded to 2 digits (`L100` stays `L100`).
 *
 * Nested group directories (`dir: 'courses/g01'` → `/courses/g01/L01`) are supported: the
 * directory part may have any depth; the lecture is always the last segment `L<digits>`.
 */

export interface LectureRoute {
  /** Normalised page path WITHOUT the locale prefix, e.g. `/courses/g01/L01` (also for `/en/courses/g01/L01`). */
  path: string
  /** Locale key of the URL (`en`); absent for root-language pages (and when no `localeKeys` were given). */
  locale?: string
  /** Full directory part as written in the URL (case preserved), e.g. `courses/g01`. */
  dir: string
  /** Last directory segment, lower-cased — the V1 "groupDir", e.g. `g01`. */
  group: string
  /** First path segment as written (V1 reading-progress `entry.group`), e.g. `courses`. */
  topSegment: string
  /** Lecture code as written in the URL, upper-cased `L` + digits, e.g. `L01`. */
  lectureCode: string
  /** Lecture number, e.g. `1`. */
  lectureNo: number
  /** V1 lecture id, e.g. `g01-L01`. */
  lectureId: string
}

const LECTURE_RE = /^\/(.+?)\/(L(\d+))$/i

/** Strip `base` (VitePress `site.base`, default `/`) from the front of a path. */
function stripBase(path: string, base: string): string {
  if (!base || base === '/') return path
  const b = base.endsWith('/') ? base.slice(0, -1) : base
  if (path === b) return '/'
  return path.startsWith(b + '/') ? path.slice(b.length) : path
}

/**
 * Normalise a route path or pathname:
 *   - query string and hash are dropped; `base` is stripped;
 *   - repeated slashes collapse; `.html` and a trailing `/index` are removed;
 *   - trailing slash removed (except for the root `/`).
 *
 * `/g05/L19.html` → `/g05/L19`, `/g05/L19/` → `/g05/L19`, `/g01/` → `/g01`, `/index.html` → `/`.
 */
export function normalisePath(raw: string, base = '/'): string {
  let p = (raw || '/').split(/[?#]/, 1)[0] || '/'
  if (!p.startsWith('/')) p = '/' + p
  p = p.replace(/\/{2,}/g, '/')
  p = stripBase(p, base)
  p = p.replace(/\.html$/i, '')
  p = p.replace(/(^|\/)index$/i, '$1')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p || '/'
}

/**
 * Split the locale prefix off a path: `/en/g01/L03` → `{ locale: 'en', path: '/g01/L03' }`,
 * `/en/` and `/en` → `{ locale: 'en', path: '/' }`. Anything else keeps its path and gets `locale: null`.
 * `localeKeys` are the NON-root locale keys of the site (VitePress `site.locales` minus `root`); the match is
 * on whole segments and ignores case. Query string and hash are kept on the returned path.
 */
export function splitLocale(path: string, localeKeys: readonly string[] = []): { locale: string | null; path: string } {
  if (!localeKeys.length) return { locale: null, path }
  const p = path.startsWith('/') ? path : '/' + path
  const m = /^\/([^/?#]+)(?=[/?#]|$)/.exec(p)
  const head = m?.[1]
  const hit = head === undefined ? undefined : localeKeys.find((k) => k.toLowerCase() === head.toLowerCase())
  if (hit === undefined) return { locale: null, path }
  const rest = p.slice(m![0].length)
  return { locale: hit, path: rest === '' || rest[0] === '?' || rest[0] === '#' ? '/' + rest : rest }
}

/** Raw path → base stripped, repeated slashes collapsed, locale split off (query / hash dropped). */
function prepare(raw: string, base: string, localeKeys: readonly string[]): { locale: string | null; path: string } {
  let p = (raw || '').split(/[?#]/, 1)[0] || ''
  if (p && !p.startsWith('/')) p = '/' + p
  p = stripBase(p.replace(/\/{2,}/g, '/'), base)
  return splitLocale(p, localeKeys)
}

/**
 * Home page (`/`, `/index`, `/index.html`, empty) — the same exclusion V1 reading-mode used.
 * With `localeKeys`, `/en/` and `/en/index.html` are home pages too.
 */
export function isHome(raw: string, base = '/', localeKeys: readonly string[] = []): boolean {
  return normalisePath(prepare(raw, base, localeKeys).path) === '/'
}

/**
 * Directory index page (`/g01/`, `/g01/index`, `/g01/index.html`, `/lr/`), i.e. a non-home path
 * whose raw form ends with `/` or `/index[.html]`. Lecture pages never match.
 */
export function isGroupIndex(raw: string, base = '/', localeKeys: readonly string[] = []): boolean {
  if (isHome(raw, base, localeKeys) || isLecture(raw, base, localeKeys)) return false
  const p = prepare(raw, base, localeKeys).path
  return /\/$/.test(p) || /\/index(?:\.html)?$/i.test(p)
}

/**
 * Parse a lecture page path. Returns null for anything that is not `/<dir…>/L<digits>`.
 * With `localeKeys`, a locale prefix is removed first: `/en/g05/L19` and `/g05/L19` give the same `path`
 * (so they share storage keys such as reading progress) and `locale` tells them apart.
 */
export function parseLecture(raw: string, base = '/', localeKeys: readonly string[] = []): LectureRoute | null {
  const { locale, path: unprefixed } = prepare(raw, base, localeKeys)
  const path = normalisePath(unprefixed)
  const m = LECTURE_RE.exec(path)
  if (!m) return null
  const dir = m[1] as string
  const segments = dir.split('/').filter(Boolean)
  if (!segments.length || segments.some((s) => /\s/.test(s) || s === '.' || s === '..')) return null
  const lectureNo = parseInt(m[3] as string, 10)
  const group = (segments[segments.length - 1] as string).toLowerCase()
  return {
    path,
    ...(locale !== null ? { locale } : {}),
    dir,
    group,
    topSegment: segments[0] as string,
    lectureCode: 'L' + (m[3] as string),
    lectureNo,
    lectureId: `${group}-L${String(lectureNo).padStart(2, '0')}`,
  }
}

/** True for lecture pages (`/<dir…>/L<digits>`). */
export function isLecture(raw: string, base = '/', localeKeys: readonly string[] = []): boolean {
  return parseLecture(raw, base, localeKeys) !== null
}
