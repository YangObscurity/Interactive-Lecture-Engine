/**
 * core/langLinks.ts - which languages the site has, and where a page of one language maps to in another
 * (plan_v2_p2d_i18n.md 3.6 / WP-I3). Pure functions over VitePress site data (`site.locales`), no Vue, no DOM,
 * SSR-safe. Paths here never carry `site.base`; callers add it with `withBase`.
 */
import { isLangCode, type LangCode } from '../../i18n/langs.ts'
import type { I18nPages } from '../../i18n/data.ts'
import { normalisePath, parseLecture, splitLocale } from './route'

/** One language of the site. `key` is the route prefix without slashes ('' for the root language). */
export interface SiteLang {
  lang: LangCode
  key: string
  isRoot: boolean
}

/** The part of VitePress `site.locales` this module reads. */
export type SiteLocales = Record<string, { lang?: string; themeConfig?: { i18nPages?: I18nPages } } | undefined>

/** `/` + key for a non-root language, '' for the root language. */
export function localePrefix(key: string): string {
  return key ? '/' + key : ''
}

/** Root language first, then the other locales in declared order. Fewer than two entries = single-language site. */
export function siteLangs(locales: SiteLocales | undefined): SiteLang[] {
  if (!locales) return []
  const out: SiteLang[] = []
  const rootLang = locales.root?.lang
  if (!isLangCode(rootLang)) return []
  out.push({ lang: rootLang, key: '', isRoot: true })
  for (const [key, loc] of Object.entries(locales)) {
    if (key === 'root') continue
    if (isLangCode(loc?.lang)) out.push({ lang: loc.lang, key, isRoot: false })
  }
  return out
}

/** The translated lectures of locale `key` (root path -> title), or {} when the locale has none. */
export function i18nPagesOf(locales: SiteLocales | undefined, key: string): I18nPages {
  return locales?.[key]?.themeConfig?.i18nPages ?? {}
}

/** Does the lecture at root-language path `rootPath` (`/g01/L03`) exist in locale `key`? The root language always has it. */
export function hasTranslation(locales: SiteLocales | undefined, key: string, rootPath: string): boolean {
  if (!key) return true
  return Object.prototype.hasOwnProperty.call(i18nPagesOf(locales, key), rootPath)
}

export interface SwitchContext {
  locales: SiteLocales | undefined
  /** `dir` of every course group (`g01`, `courses/g01`). */
  groupDirs: readonly string[]
  base?: string
}

/**
 * Where a switch from the current page to language `target` lands (path without base, with the language prefix):
 *   lecture   -> the `target` version when it exists, else `target`'s page of the same group;
 *   group     -> the same group in `target`;
 *   otherwise -> `target`'s home.
 */
export function switchTarget(routePath: string, target: SiteLang, ctx: SwitchContext): string {
  const pre = localePrefix(target.key)
  const keys = siteLangs(ctx.locales).filter((l) => !l.isRoot).map((l) => l.key)
  const base = ctx.base ?? '/'
  const lec = parseLecture(routePath, base, keys)
  if (lec) {
    if (hasTranslation(ctx.locales, target.key, lec.path)) return `${pre}${lec.path}`
    return ctx.groupDirs.includes(lec.dir) ? `${pre}/${lec.dir}/` : `${pre}/`
  }
  const { path } = splitLocale(normalisePath(routePath, base), keys)
  const dir = path.replace(/^\//, '')
  if (dir && ctx.groupDirs.includes(dir)) return `${pre}/${dir}/`
  return `${pre}/`
}

/** A lecture as shown in locale `key`: translated -> the locale page and its title, else the root-language page and title. */
export function localizedLecture(
  rootPath: string,
  rootTitle: string,
  key: string,
  pages: I18nPages,
): { path: string; title: string; translated: boolean } {
  if (!key) return { path: rootPath, title: rootTitle, translated: true }
  const hit = pages[rootPath]
  if (hit) return { path: `/${key}${rootPath}`, title: hit.title, translated: true }
  return { path: rootPath, title: rootTitle, translated: false }
}
