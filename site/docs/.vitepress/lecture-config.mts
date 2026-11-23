/**
 * lecture-config.mts — typed `defineLectureConfig` for `site/lecture.config.ts`.
 *
 * Non-secret deployer configuration. P2b added the theme block; P2c adds the `modules` block,
 * whose choices and defaults come from config/schema.ts (the single source of truth), so a wrong value is a
 * type error in the editor and a clear error at build time. Secrets never go here: they live in .env.
 */
import type { ThemeLayer } from './theme/tokens/pack'
import { SITE_BLOCKS, SITE_MODULES, optionsOf, type SiteModuleId, type SiteModuleOptions } from '../../config/schema.ts'
import { DEFAULT_ROOT_LANG, isLangCode, LANG_CODES, type LangCode } from './i18n/langs.ts'
import { AccessConfigError, validateAccessConfig, type AccessConfig } from './access/tiers.ts'

/** Built-in theme packs under docs/.vitepress/themes/<id>/. */
export const BUILTIN_THEME_IDS = ['reader', 'datasheet'] as const
export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number]
/** A built-in theme id, or the id of a pack registered in `themePacks` (P2e). The `string & {}` keeps editor completion of the built-ins. */
export type ThemeId = BuiltinThemeId | (string & {})

type SiteModules = typeof SITE_MODULES
type AdapterChoice<M extends SiteModuleId> = { [F in SiteModules[M]['field']]: SiteModules[M]['values'][number] }
/**
 * The `modules` block: the choice and the options of each site module, e.g.
 * `{ progress: { adapter: 'rest', notionSync: true } }`. Everything is optional; omitted values use the schema default.
 */
export type ModulesConfig = {
  [M in SiteModuleId]?: Partial<AdapterChoice<M> & SiteModuleOptions<M>>
}
/** Every site module with its choice and options filled in (defaults from the schema). */
export type ResolvedModules = {
  [M in SiteModuleId]: AdapterChoice<M> & SiteModuleOptions<M>
}

/** The `i18n` block (P2d): which languages the site offers and which one lives at `/`. */
export interface I18nConfig {
  /** Language of the root path `/` (lectures under `docs/<group dir>/`). Default 'zh-CN'. */
  root?: LangCode
  /** Enabled languages. Default ['zh-CN', 'en']; must include `root`. Duplicates are removed. */
  locales?: LangCode[]
}

/** The `home` block (P4a/P4b): default home map mode and how far the overview map is expanded by default. */
export type HomeMapMode = (typeof SITE_BLOCKS.home.fields.map.values)[number]
export type AtlasExpandChoice = (typeof SITE_BLOCKS.home.fields.atlasExpand.values)[number]
export interface HomeConfig {
  /** Default mode of the home map (`atlas` overview or `graph` dependency canvas). Default 'atlas'. */
  map?: HomeMapMode
  /** Default expansion of the overview map; a reader's own choice (kept in the browser) wins. Default 'reading'. */
  atlasExpand?: AtlasExpandChoice
}

export interface LectureConfig {
  /** Default theme of the site (first paint, readers without a stored choice). */
  theme: ThemeId
  /**
   * Themes readers may switch to (settings panel, P6). The default theme is always enabled;
   * `reader` is always compiled as the inheritance base for omitted shared tokens.
   * Default: only `theme`.
   */
  themes?: ThemeId[]
  /**
   * Third-party theme packs (P2e): folders relative to `site/`, each holding a `theme.json`
   * (docs-dev/SLOTS.md). A pack's id must differ from the built-in themes; once registered it can be named in
   * `theme` / `themes`. A pack with `components` is code: it runs in the build and in readers' browsers.
   */
  themePacks?: string[]
  /** Deployer overrides per theme (second layer: pack → deployer → reader). */
  themeOverrides?: Record<string, ThemeLayer | undefined>
  /** Site modules (progress, companion, graph, contentSync, auth); omitted modules use the schema default. */
  modules?: ModulesConfig
  /** Languages (P2d). Omitted = root 'zh-CN', locales ['zh-CN', 'en']. */
  i18n?: I18nConfig
  /**
   * Access tiers (P3b, docs-dev/ACCESS.md): who may read which course group. Omitted = everything public, no gateway.
   * `groups` keys are the ids of docs/.vitepress/groups.mts; they are checked against that list at build time.
   */
  access?: AccessConfig
  /** Home page settings (P4a): the default expansion of the overview map. */
  home?: HomeConfig
}

export class LectureConfigError extends Error {
  override name = 'LectureConfigError'
}

/**
 * Check the config against the schema; throws a LectureConfigError naming the bad key and the allowed values.
 * `options.groupIds`: the course group ids of groups.mts; when given, `access.groups` keys are checked against them
 * (the build always passes them, `defineLectureConfig` cannot know them).
 */
export function validateLectureConfig(config: LectureConfig, options: { groupIds?: readonly string[] } = {}): LectureConfig {
  validateI18n(config.i18n)
  validateHome(config.home)
  validateThemePacks(config.themePacks)
  try {
    validateAccessConfig(config.access, options.groupIds)
  } catch (e) {
    if (e instanceof AccessConfigError) throw new LectureConfigError(e.message)
    throw e
  }
  const mods = (config.modules ?? {}) as Record<string, unknown>
  for (const [name, value] of Object.entries(mods)) {
    const spec = (SITE_MODULES as Record<string, { field: string; values: readonly string[] }>)[name]
    if (!spec) throw new LectureConfigError(`lecture.config.ts: unknown module "${name}" (known: ${Object.keys(SITE_MODULES).join(', ')})`)
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null) throw new LectureConfigError(`lecture.config.ts: modules.${name} must be an object like { ${spec.field}: '${spec.values[0]}' }`)
    const options = optionsOf(name as SiteModuleId)
    const known = [spec.field, ...options.map(([n]) => n)]
    for (const [field, given] of Object.entries(value)) {
      const where = `lecture.config.ts: modules.${name}.${field}`
      if (field === spec.field) {
        if (!spec.values.includes(given as string)) {
          throw new LectureConfigError(`${where} = ${JSON.stringify(given)} is not one of ${spec.values.join(' | ')}`)
        }
        continue
      }
      const option = options.find(([n]) => n === field)?.[1]
      if (!option) throw new LectureConfigError(`${where} is not a setting (expected ${known.join(', ')})`)
      if (option.type === 'bool' && typeof given !== 'boolean') {
        throw new LectureConfigError(`${where} = ${JSON.stringify(given)} must be true or false`)
      }
      if (option.type === 'path' && !(typeof given === 'string' && /^\/\S*$/.test(given))) {
        throw new LectureConfigError(`${where} = ${JSON.stringify(given)} must be a path starting with "/" and without spaces, e.g. ${JSON.stringify(option.default)}`)
      }
    }
  }
  return config
}

function validateHome(home: unknown): void {
  if (home === undefined) return
  const fields = SITE_BLOCKS.home.fields
  if (typeof home !== 'object' || home === null || Array.isArray(home)) {
    throw new LectureConfigError(`lecture.config.ts: home must be an object like { map: '${fields.map.default}', atlasExpand: '${fields.atlasExpand.default}' }`)
  }
  const known = Object.keys(fields)
  for (const [key, value] of Object.entries(home)) {
    if (!(key in fields)) {
      throw new LectureConfigError(`lecture.config.ts: home.${key} is not a setting (expected ${known.join(', ')})`)
    }
    const spec = fields[key as keyof typeof fields]
    if (value !== undefined && !(spec.values as readonly string[]).includes(value as string)) {
      throw new LectureConfigError(`lecture.config.ts: home.${key} = ${JSON.stringify(value)} is not one of ${spec.values.join(' | ')}`)
    }
  }
}

function validateThemePacks(packs: unknown): void {
  if (packs === undefined) return
  const hint = `lecture.config.ts: themePacks must be an array of folders relative to site/, e.g. ['themes/my-pack']`
  if (!Array.isArray(packs)) throw new LectureConfigError(hint)
  const seen = new Set<string>()
  packs.forEach((p, i) => {
    if (typeof p !== 'string' || p.trim() === '') throw new LectureConfigError(`lecture.config.ts: themePacks[${i}] = ${JSON.stringify(p)} must be a non-empty folder path`)
    if (/^[a-zA-Z]:|^[\\/]/.test(p)) throw new LectureConfigError(`lecture.config.ts: themePacks[${i}] = ${JSON.stringify(p)} must be relative to site/, not absolute`)
    const key = p.replace(/\\/g, '/').replace(/\/+$/, '')
    if (seen.has(key)) throw new LectureConfigError(`lecture.config.ts: themePacks lists ${JSON.stringify(p)} twice`)
    seen.add(key)
  })
}

function validateI18n(i18n: I18nConfig | undefined): void {
  if (i18n === undefined) return
  const allowed = LANG_CODES.join(', ')
  const check = (where: string, value: unknown): void => {
    if (!isLangCode(value)) {
      throw new LectureConfigError(`lecture.config.ts: ${where} = ${JSON.stringify(value)} is not a supported language (allowed: ${allowed})`)
    }
  }
  if (typeof i18n !== 'object' || i18n === null) throw new LectureConfigError(`lecture.config.ts: i18n must be an object like { root: 'zh-CN', locales: ['zh-CN', 'en'] }`)
  if (i18n.root !== undefined) check('i18n.root', i18n.root)
  if (i18n.locales !== undefined) {
    if (!Array.isArray(i18n.locales) || i18n.locales.length === 0) {
      throw new LectureConfigError(`lecture.config.ts: i18n.locales must be a non-empty array of languages (allowed: ${allowed})`)
    }
    i18n.locales.forEach((l, i) => check(`i18n.locales[${i}]`, l))
    const root = i18n.root ?? DEFAULT_ROOT_LANG
    if (!i18n.locales.includes(root)) {
      throw new LectureConfigError(`lecture.config.ts: i18n.root "${root}" must be one of i18n.locales (${i18n.locales.join(', ')})`)
    }
  }
}

export function defineLectureConfig(config: LectureConfig): LectureConfig {
  return validateLectureConfig(config)
}

/** Enabled theme ids, default first, de-duplicated. */
export function enabledThemes(config: LectureConfig): string[] {
  return [...new Set<string>([config.theme, ...(config.themes ?? [])])]
}

/** The modules block with every module present and defaults from the schema filled in. */
export function resolveModules(config: LectureConfig): ResolvedModules {
  const out: Record<string, Record<string, string | boolean>> = {}
  for (const name of Object.keys(SITE_MODULES) as SiteModuleId[]) {
    const spec = SITE_MODULES[name]
    const given = (config.modules?.[name] ?? {}) as Record<string, string | boolean | undefined>
    // the adapter choice stays first: consumers read `Object.values(module)[0]` as "the adapter"
    const resolved: Record<string, string | boolean> = { [spec.field]: given[spec.field] ?? spec.default }
    for (const [option, o] of optionsOf(name)) resolved[option] = given[option] ?? o.default
    out[name] = resolved
  }
  return out as ResolvedModules
}

/** The i18n block with defaults filled in: root first, then the other locales in declared order, no duplicates. */
export function resolveI18n(config: LectureConfig): { root: LangCode; locales: LangCode[] } {
  const root = config.i18n?.root ?? DEFAULT_ROOT_LANG
  const declared = config.i18n?.locales ?? ([...LANG_CODES] as LangCode[])
  return { root, locales: [...new Set<LangCode>([root, ...declared])] }
}

/** The home block with defaults filled in. */
export function resolveHome(config: LectureConfig): { map: HomeMapMode; atlasExpand: AtlasExpandChoice } {
  return {
    map: config.home?.map ?? SITE_BLOCKS.home.fields.map.default,
    atlasExpand: config.home?.atlasExpand ?? SITE_BLOCKS.home.fields.atlasExpand.default,
  }
}
