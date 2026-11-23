/**
 * config.v2.mts — V2 additions to config.mts, kept out of that file so `git merge main` stays
 * conflict-light (plan §2.4: "v2 对 config.mts 的改动压缩成几行，其余放进新文件 config.v2.mts").
 *
 * P2b: theme packs (compile + validate at config load), the first-paint <head> script for reader
 * preferences, and category colour slots for course groups.
 * P2d: the site language and the VitePress chrome strings (outline, search, nav, ...) per language.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DefaultTheme, HeadConfig, LocaleConfig, SiteConfig, UserConfig } from 'vitepress'
import type { PluginOption } from 'vite'
import { resolveContent } from './content/paths.mts'
import { loadLectureConfig } from './content/config.mts'
import { SETTINGS } from '../../config/schema.ts'
import { loadSources, resolveAll } from '../../scripts/config/env.mts'
import { resolveHome, resolveI18n, resolveModules } from './lecture-config.mts'
import { translate, pickLocalized, pickSiteText, LANG_CODES, localeKeyOf, type LangCode } from './i18n/index.ts'
import type { GroupI18n, I18nPages, SiteMetaI18n } from './i18n/data.ts'
import { fillLecturesToken } from './site-texts-schema.ts'
import { scanTranslations, type TranslationScan } from './i18n/scan.mts'
import { localeLinksPlugin, type MarkdownItLike } from './plugins/localeLinks.mts'
import { buildThemes, lectureThemePlugin } from './plugins/lectureThemePlugin.mts'
import { dashboardDevPlugin } from './plugins/dashboardDevPlugin.mts'
import { companionPromptsPlugin, emitCompanionPromptsDist } from './plugins/companionPromptsPlugin.mts'
import { figuresDevPlugin } from './plugins/figuresDevPlugin.mts'
import { contentWatchPlugin } from './plugins/contentWatchPlugin.mts'
import { headScript } from './theme/tokens/prefs'
import { homeMapModeHeadScript } from './theme/core/homeMapMode'
import { groupSlots, type CategorisedGroup } from './theme/tokens/categories'
import { buildSearchArtifacts, writeSearchArtifacts, type BuildSearchOptions, type SearchGroupMeta } from './search/indexBuilder.ts'
import { createSearchVitePlugin } from './search/vitePlugin.mts'
import type { AccessPlan } from './access/tiers.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const contentPaths = resolveContent()
const lectureConfig = loadLectureConfig({ paths: contentPaths })
const themesDir = path.join(here, 'themes')

/** Throws (failing dev/build) when a theme pack or override is invalid. */
const themeBuild = buildThemes(lectureConfig, { themesDir, themeFile: contentPaths.themeFile })

/** Inline first-paint script: the remembered home map mode as `data-home-map` on `<html>` (theme/core/homeMapMode.ts). */
export function v2HomeMapHead(): HeadConfig {
  return ['script', { id: 'lecture-home-map' }, homeMapModeHeadScript()]
}

/**
 * The site-module choices and options, fully resolved (P3). Goes into `themeConfig.lectureModules`, the only way
 * client code learns them (a few dozen bytes per page); see theme/progress and theme/auth.
 */
export const v2Modules = resolveModules(lectureConfig)
/** The `home` block with defaults (P4a): `themeConfig.lectureHome`. */
export const v2Home = resolveHome(lectureConfig)

/** Inline first-paint script: data-lec-theme / -tint / -size / -font from reader prefs. */
export const v2Head: HeadConfig[] = [['script', { id: 'lecture-theme-prefs' }, headScript(themeBuild.runtime)]]

/**
 * Fail production builds if any mock companion flag (e.g. VITE_AI_MOCK) is enabled.
 * Plan B forbids shipping mock AI responders into production bundles.
 */
const TRUTHY_FLAG_RE = /^(?:1|true|yes|on)$/i
const MOCK_ENV_KEYS = ['VITE_AI_MOCK', 'VITE_FLAG_AI_MOCK', 'LECTURE_AI_MOCK', 'AI_MOCK'] as const

export function assertNoMockFlagsInBuild(
  envSources: ReadonlyArray<Record<string, string | undefined> | undefined>,
): void {
  for (const env of envSources) {
    if (!env) continue
    for (const key of MOCK_ENV_KEYS) {
      const val = env[key]
      if (typeof val === 'string' && TRUTHY_FLAG_RE.test(val.trim())) {
        throw new Error(
          `[lecture-v2] Production build aborted: mock flag ${key}=${JSON.stringify(val)} must not be set in production.`,
        )
      }
    }
  }
}

function noMockInProdBuildPlugin(): PluginOption {
  return {
    name: 'lecture-no-mock-prod',
    apply: 'build',
    configResolved(cfg) {
      assertNoMockFlagsInBuild([process.env, cfg.env as Record<string, string | undefined> | undefined])
    },
  }
}

export const v2VitePlugins: PluginOption[] = [
  noMockInProdBuildPlugin(),
  lectureThemePlugin({ config: lectureConfig, themesDir, themeFile: contentPaths.themeFile, initial: themeBuild }),
  companionPromptsPlugin(),
  figuresDevPlugin(),
  dashboardDevPlugin(),
  contentWatchPlugin(),
]

export { emitCompanionPromptsDist }

/**
 * P2e: VitePress documents replacing an internal component with a Vite alias whose `find` matches the component file.
 * `theme/slots/VPSidebarItem.vue` is the 1.6.4 source plus the `SidebarStatus` slot (see the comment at its top).
 */
export const v2ViteAlias = [
  { find: /^.*\/VPSidebarItem\.vue$/, replacement: path.join(here, 'theme', 'slots', 'VPSidebarItem.vue').replace(/\\/g, '/') },
  { find: /^.*\/VPNavBar\.vue$/, replacement: path.join(here, 'theme', 'components', 'VPNavBar.vue').replace(/\\/g, '/') },
]

/**
 * Opt-in escape hatch for KNOWN dead links in content this branch must not edit (plan §2.5).
 * Default: nothing ignored, so `npm run build` keeps failing on dead links exactly as before.
 * Example (P2b, pre-existing on main b5e6c2e6: lr/L53.md links ./L54.md, which does not exist):
 *   LECTURE_IGNORE_DEAD_LINKS=./L54 npm run build
 */
export const v2IgnoreDeadLinks: string[] = (process.env.LECTURE_IGNORE_DEAD_LINKS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

/** Attach `catSlot` (1…8, first-appearance order of `category`) to every group. */
export function withCategorySlots<G extends CategorisedGroup>(groups: G[]): Array<G & { catSlot: number }> {
  const slots = groupSlots(groups)
  return groups.map((g) => ({ ...g, catSlot: slots.get(g.id) as number }))
}

// ---- P2d: language and VitePress chrome strings -------------------------------------------------

/** Language of `/` (`lang` of the site config), from lecture.config.ts `i18n.root` (default 'zh-CN'). */
export const v2Lang: LangCode = resolveI18n(lectureConfig).root

const tr = (lang: LangCode, key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params, v2Lang)

/** `themeConfig` labels (outline, sidebar menu, dark-mode switch, doc footer, last updated) in `lang`. */
export function v2ChromeStrings(lang: LangCode) {
  return {
    outline: { level: [2, 3] as [number, number], label: tr(lang, 'chrome.outline') },
    sidebarMenuLabel: tr(lang, 'chrome.sidebarMenu'),
    returnToTopLabel: tr(lang, 'chrome.returnToTop'),
    darkModeSwitchLabel: tr(lang, 'chrome.darkModeSwitch'),
    lightModeSwitchTitle: tr(lang, 'chrome.lightModeTitle'),
    darkModeSwitchTitle: tr(lang, 'chrome.darkModeTitle'),
    docFooter: { prev: tr(lang, 'chrome.docFooterPrev'), next: tr(lang, 'chrome.docFooterNext') },
    lastUpdatedText: tr(lang, 'chrome.lastUpdated'),
  } satisfies DefaultTheme.Config
}

/** Local-search UI translations (`themeConfig.search.options.translations`) in `lang`. */
export function v2SearchTranslations(lang: LangCode) {
  return {
    button: { buttonText: tr(lang, 'search.button'), buttonAriaLabel: tr(lang, 'search.button') },
    modal: {
      noResultsText: tr(lang, 'search.noResults'),
      resetButtonTitle: tr(lang, 'search.resetButton'),
      footer: {
        selectText: tr(lang, 'search.footerSelect'),
        navigateText: tr(lang, 'search.footerNavigate'),
        closeText: tr(lang, 'search.footerClose'),
      },
    },
  } satisfies NonNullable<DefaultTheme.LocalSearchOptions['translations']>
}

/** Top-nav labels: the overview link, the course-group dropdown, and the temporary-group suffix. */
export function v2NavLabels(lang: LangCode) {
  return { home: tr(lang, 'nav.home'), groups: tr(lang, 'nav.groups'), temp: tr(lang, 'nav.temp') }
}

/** Sidebar text of a lecture whose markdown has no frontmatter title. */
export function v2LectureFallback(lang: LangCode, n: number): string {
  return tr(lang, 'lecture.fallbackTitle', { n })
}

// ---- P2d WP-I2: locales, translations, cross-locale links, hreflang -------------------------------

const docsRoot = contentPaths.docsRoot
const repoRoot = contentPaths.repoRoot
const i18nResolved = resolveI18n(lectureConfig)

/** Enabled non-root languages (root excluded), in declared order. */
export const v2OtherLangs: LangCode[] = i18nResolved.locales.filter((l) => l !== v2Lang)

/** Route prefixes of the enabled non-root languages (`['en']`). Empty = single-language site. */
export const v2LocaleKeys: string[] = v2OtherLangs.map(localeKeyOf)

/** Route prefixes of languages that are NOT enabled: `docs/<key>/**` is excluded from the build. */
const disabledKeys: string[] = LANG_CODES.filter((l) => !i18nResolved.locales.includes(l)).map(localeKeyOf)

/** Which lectures exist in which non-root language (`docs/<key>/**` files named L<digits>.md), scanned once at config load. */
export const v2Translations: TranslationScan = scanTranslations(docsRoot, v2LocaleKeys)

/** Minimal group shape the locale builders need (the processed groups of config.mts fit it). */
export interface V2LocaleGroup {
  id: string
  dir: string
  title: string
  temp?: boolean
  i18n?: GroupI18n
}

export interface V2LocaleInput {
  groups: readonly V2LocaleGroup[]
  siteMeta: { name: string; shortName?: string; text?: string; tagline: string; description?: string; i18n?: SiteMetaI18n }
  totals?: { lectures: number; charts: number }
  /** P3b: false for the root path (`/g05/L01`) of a lecture whose group is not built; its `i18nPages` entry is left out. Default: all. */
  includeRootPath?: (rootPath: string) => boolean
}

/** `themeConfig` of a non-root locale: chrome strings, nav, sidebar, plus the translation map. */
export type V2LocaleTheme = DefaultTheme.Config & { i18nPages: I18nPages }

/**
 * WP-F3: disable VitePress' monolithic local search (`@localSearchIndex*.js` = 27.7 MB) cleanly by leaving
 * `themeConfig.search` unset while our split/pruned search index & themed SearchPanel handle search.
 */
export function v2Search(): DefaultTheme.Config['search'] {
  return undefined
}

export interface V2SearchInput {
  docsRoot: string
  allGroups: readonly (SearchGroupMeta & { i18n?: GroupI18n })[]
  conceptsDir?: string
  accessPlan?: AccessPlan
  base?: string
  cleanUrls?: boolean
}

export function v2ConceptExcludes(
  isBuild: boolean = process.argv.some((a) => a === 'build'),
  localeKeys: readonly string[] = v2LocaleKeys,
): string[] {
  if (!isBuild) return []
  return ['concepts/_drafts/**', ...localeKeys.map((k) => `${k}/concepts/_drafts/**`)]
}

export function v2LocalizedGroupTitles(
  allGroups: readonly (SearchGroupMeta & { i18n?: GroupI18n })[],
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const lang of v2OtherLangs) {
    const key = localeKeyOf(lang)
    const map: Record<string, string> = {}
    for (const g of allGroups) map[g.id] = pickLocalized(g, lang, 'title')
    out[key] = map
  }
  return out
}

export function v2SearchBuildOptions(input: V2SearchInput): BuildSearchOptions {
  return {
    docsRoot: input.docsRoot,
    allGroups: input.allGroups,
    localeKeys: v2LocaleKeys,
    conceptsDir: input.conceptsDir,
    base: input.base ?? '/',
    cleanUrls: input.cleanUrls ?? true,
    excludes: [...disabledKeys.map((k) => `${k}/**`), ...v2DashboardExcludes(), ...v2ConceptExcludes(true)],
    accessPlan: input.accessPlan,
    localizedGroupTitles: v2LocalizedGroupTitles(input.allGroups),
  }
}

export function v2SearchPlugin(input: V2SearchInput): PluginOption {
  return createSearchVitePlugin(() => v2SearchBuildOptions(input))
}

export function v2WriteSearchDist(outDir: string, input: V2SearchInput): void {
  const result = buildSearchArtifacts(v2SearchBuildOptions(input))
  writeSearchArtifacts(outDir, result)
}

/** Translated lectures of `dir` in locale `key`, by lecture number. */
function translatedLectures(key: string, lang: LangCode, dir: string): Array<{ n: number; text: string; link: string }> {
  const prefix = `/${dir}/`
  const out: Array<{ n: number; text: string; link: string }> = []
  for (const [rootPath, page] of Object.entries(v2Translations[key] ?? {})) {
    if (!rootPath.startsWith(prefix)) continue
    const m = /^L(\d+)$/.exec(rootPath.slice(prefix.length))
    if (!m) continue
    const n = Number(m[1])
    out.push({ n, text: page.title || v2LectureFallback(lang, n), link: page.link })
  }
  return out.sort((a, b) => a.n - b.n)
}

/** Description of the site in `lang`: the home description, else the tagline, else '' (no meta description). */
export function siteDescription(siteMeta: V2LocaleInput['siteMeta'], lang: LangCode): string {
  return pickSiteText(siteMeta, lang, 'description') || pickSiteText(siteMeta, lang, 'tagline')
}

function localeThemeConfig(lang: LangCode, input: V2LocaleInput): V2LocaleTheme {
  const key = localeKeyOf(lang)
  const labels = v2NavLabels(lang)
  const groupTitle = (g: V2LocaleGroup) => `${g.id} · ${pickLocalized(g, lang, 'title')}`
  const fullTitle = pickSiteText(input.siteMeta, lang, 'name')
  const shortTitle = pickSiteText(input.siteMeta, lang, 'shortName')
  const siteTitle = shortTitle
    ? `<span class="site-title-full">${fullTitle}</span><span class="site-title-short">${shortTitle}</span>`
    : fullTitle
  const sidebar: DefaultTheme.SidebarMulti = {}
  for (const g of input.groups) {
    const items = translatedLectures(key, lang, g.dir).map((l) => ({ text: l.text, link: l.link }))
    if (items.length) sidebar[`/${key}/${g.dir}/`] = [{ text: groupTitle(g), collapsed: false, items }]
  }
  const i18nPages: I18nPages = {}
  for (const [rootPath, page] of Object.entries(v2Translations[key] ?? {})) {
    if (input.includeRootPath && !input.includeRootPath(rootPath)) continue
    const n = Number(/L(\d+)$/.exec(rootPath)?.[1] ?? 0)
    i18nPages[rootPath] = { title: page.title || v2LectureFallback(lang, n) }
  }
  return {
    ...v2ChromeStrings(lang),
    siteTitle,
    nav: [
      { text: labels.home, link: `/${key}/` },
      {
        text: labels.groups,
        component: 'NavCourseMenuHost',
        items: input.groups.map((g) => ({ text: `${groupTitle(g)}${g.temp ? labels.temp : ''}`, link: `/${key}/${g.dir}/` })),
      } as DefaultTheme.NavItemWithChildren & { component: string },
    ],
    sidebar,
    i18nPages,
  }
}

/**
 * VitePress `locales`: `root` (the root language) plus one entry per enabled other language, or undefined for
 * a single-language site. `label` is '' ON PURPOSE for every entry: the default theme renders its language
 * menu (VPNavBarTranslations, the flyout block of VPNavBarExtra, VPNavScreenTranslations) only when
 * `localeLinks.length && currentLang.label` (useLangs() in theme-default/composables/langs.js), and
 * `localeLinks` skips every locale whose label equals the current one. An empty label therefore hides all
 * three menus with no CSS and no theme override; WP-I3's own switcher does not need `label`.
 */
export function v2Locales(input: V2LocaleInput): LocaleConfig<V2LocaleTheme> | undefined {
  if (!v2OtherLangs.length) return undefined
  const locales: LocaleConfig<V2LocaleTheme> = { root: { label: '', lang: v2Lang } }
  for (const lang of v2OtherLangs) {
    locales[localeKeyOf(lang)] = {
      label: '',
      lang,
      link: `/${localeKeyOf(lang)}/`,
      title: pickSiteText(input.siteMeta, lang, 'name'),
      description: fillLecturesToken(siteDescription(input.siteMeta, lang), input.totals?.lectures),
      themeConfig: localeThemeConfig(lang, input),
    }
  }
  return locales
}

/** Public address of the site (SITE_URL: real env var > repo-root .env), or null for a private site. Never logged. */
function resolveSiteUrl(): URL | null {
  const setting = SETTINGS.filter((s) => s.key === 'SITE_URL')
  const value = resolveAll(loadSources({ repoRoot }), setting)[0]?.value
  if (!value) {
    // eslint-disable-next-line no-console -- a build log line, not an error
    console.log('[i18n] SITE_URL not set: no sitemap.xml and no hreflang links (private site)')
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('[i18n] SITE_URL is not a valid URL (value not shown): fix it in .env / the environment, or unset it')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('[i18n] SITE_URL must start with http:// or https:// (value not shown)')
  }
  // eslint-disable-next-line no-console -- a build log line, not an error
  console.log('[i18n] SITE_URL set: sitemap.xml and hreflang links are generated')
  return url
}

const v2SiteUrl = resolveSiteUrl()

/** Absolute URL of a page (`g01/L01.md` -> `https://host/g01/L01`), honouring `cleanUrls` and `base`. */
export function v2AbsoluteUrl(origin: string, base: string, relativeMd: string, cleanUrls: boolean): string {
  const rel = relativeMd.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, cleanUrls ? '' : '.html')
  const b = base.endsWith('/') ? base : base + '/'
  return origin.replace(/\/$/, '') + (b.startsWith('/') ? b : '/' + b) + rel
}

/**
 * hreflang alternates of a page, or [] when it exists in fewer than two languages. `pages` = every source page
 * (`siteConfig.pages`, dynamic routes included). Each version lists ALL versions, itself included, plus
 * `x-default` -> the root-language version (Google: every version must list every version, or the links are ignored).
 */
export function v2Hreflang(relativePath: string, pages: ReadonlySet<string>, origin: string, base: string, cleanUrls: boolean): HeadConfig[] {
  const key = v2LocaleKeys.find((k) => relativePath.startsWith(k + '/'))
  const rest = key ? relativePath.slice(key.length + 1) : relativePath
  const versions: Array<{ lang: LangCode; md: string }> = []
  if (pages.has(rest)) versions.push({ lang: v2Lang, md: rest })
  for (const lang of v2OtherLangs) {
    const md = `${localeKeyOf(lang)}/${rest}`
    if (pages.has(md)) versions.push({ lang, md })
  }
  if (versions.length < 2) return []
  const tags: HeadConfig[] = versions.map((v) => ['link', { rel: 'alternate', hreflang: v.lang, href: v2AbsoluteUrl(origin, base, v.md, cleanUrls) }])
  const root = versions.find((v) => v.lang === v2Lang)
  if (root) tags.push(['link', { rel: 'alternate', hreflang: 'x-default', href: v2AbsoluteUrl(origin, base, root.md, cleanUrls) }])
  return tags
}

let pageSetOf: { pages: readonly string[]; set: Set<string> } | undefined
function pageSet(siteConfig: SiteConfig): Set<string> {
  if (pageSetOf?.pages !== siteConfig.pages) pageSetOf = { pages: siteConfig.pages, set: new Set(siteConfig.pages) }
  return pageSetOf.set
}

/**
 * P6.5: When `auth.adapter === 'none'` on a production build (`vitepress build`), exclude `/dashboard` and all
 * localized `/<key>/dashboard` pages from `dist/`. In `vitepress dev`, the dashboard stays reachable locally.
 */
export function v2DashboardExcludes(
  modules = v2Modules,
  isBuild: boolean = process.argv.some((a) => a === 'build'),
  env: Readonly<Record<string, string | undefined>> = process.env,
  localeKeys: readonly string[] = v2LocaleKeys,
): string[] {
  if (modules.auth.adapter !== 'none' || !isBuild || env.LECTURE_DASHBOARD_BUILD === '1') return []
  return ['dashboard.md', ...localeKeys.map((k) => `${k}/dashboard.md`)]
}

/**
 * Everything locale-related for the top level of `defineConfig`: `locales`, `srcExclude` (languages that are not
 * enabled), and, only with SITE_URL, `sitemap` (VitePress writes the xhtml:link alternates itself) and the
 * hreflang `transformHead`. Spread it into the config.
 */
export function v2LocaleConfig(input: V2LocaleInput): Partial<UserConfig<V2LocaleTheme>> {
  const cfg: Partial<UserConfig<V2LocaleTheme>> = {}
  const locales = v2Locales(input)
  if (locales) cfg.locales = locales
  const excludes = [...disabledKeys.map((k) => `${k}/**`), ...v2DashboardExcludes(), ...v2ConceptExcludes()]
  if (excludes.length) cfg.srcExclude = excludes
  // dynamic group pages (docs/<key>/[group]/) carry their localized title / description as route params;
  // a `{lectures}` placeholder in a description is filled with the build's lecture count.
  cfg.transformPageData = (pageData) => {
    if (v2OtherLangs.length) {
      const p = pageData.params as { title?: string; description?: string } | undefined
      if (p?.title) pageData.title = p.title
      if (p?.description) pageData.description = p.description
    }
    // home pages: title and description come from the site texts (the home markdown carries no frontmatter text)
    const homeLang = [v2Lang, ...v2OtherLangs].find((lang) => pageData.relativePath === (lang === v2Lang ? 'index.md' : `${localeKeyOf(lang)}/index.md`))
    if (homeLang) {
      pageData.title = pickSiteText(input.siteMeta, homeLang, 'name')
      pageData.description = siteDescription(input.siteMeta, homeLang)
    }
    // `{lectures}` in a page description is the lecture count of this build (one source: the scanned groups)
    if (typeof pageData.description === 'string') {
      pageData.description = fillLecturesToken(pageData.description, input.totals?.lectures)
    }
  }
  if (v2SiteUrl) {
    cfg.sitemap = {
      hostname: v2SiteUrl.origin,
      transformItems: (items) =>
        items.filter(
          (item) =>
            !/(?:^|\/)dashboard(?:\/|\.html)?$/.test(item.url) &&
            !item.url.includes('/_access/') &&
            !item.url.includes('/_drafts/'),
        ),
    }
    if (v2OtherLangs.length) {
      cfg.transformHead = ({ pageData, siteConfig }) =>
        v2Hreflang(pageData.relativePath, pageSet(siteConfig), v2SiteUrl.origin, siteConfig.site.base, siteConfig.cleanUrls ?? false)
    }
  }
  return cfg
}

/** markdown-it plugin: links to lectures not translated into the page's language point at the root-language page. */
export function v2LocaleLinks(md: MarkdownItLike): void {
  localeLinksPlugin(md, { localeKeys: v2LocaleKeys, exists: (key, rootPath) => v2Translations[key]?.[rootPath] !== undefined })
}

/**
 * Inline first-paint script (reading mode, before the first paint, no flash). Same logic and storage key as
 * before P2d; with other languages enabled every locale home (`/en/`) counts as home too, like `/`.
 * Keep it in step with theme/reading/readingMode.ts and core/route.ts `isHome`.
 */
export function v2ReadingModeHead(): HeadConfig {
  const localeHome = v2LocaleKeys.length ? `&&!/^\\/(?:${v2LocaleKeys.join('|')})\\/?$/.test(p)` : ''
  return [
    'script',
    {},
    "try{var p=location.pathname.replace(/index(?:\\.html)?$/,'').replace(/\\.html$/,'');" +
      `if(p!==''&&p!=='/'${localeHome}&&localStorage.getItem('lecture-reading-mode')==='1')` +
      "document.documentElement.classList.add('reading-mode')}catch(e){}",
  ]
}
