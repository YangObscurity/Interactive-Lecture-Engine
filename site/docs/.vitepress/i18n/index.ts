/**
 * i18n/index.ts - message dictionaries, `translate`, language helpers (plan_v2_p2d_i18n.md 3.2 / 3.3).
 *
 * Layers:
 *   zh-CN.ts  key source of truth (`as const`)      en.ts  `Record<MessageKey, string>` (compile-time parity)
 *   index.ts  translate / currentLang / pickLocalized   useT.ts  Vue composable bound to `useData().lang`
 *
 * RESERVED PREFIX `theme.`: theme vocabulary (labels that change with the active theme pack) will live
 * under `theme.*` once the first consumer (P4 map skins) lands. Do not add `theme.*` keys before that:
 * loading/validating per-theme strings also has an SSR vs client hydration problem that is solved
 * together with the first real user (plan section 2).
 */
import { en } from './en.ts'
import { zhCN } from './zh-CN.ts'
import { DEFAULT_ROOT_LANG, isLangCode, LANG_CODES, localeKeyOf, type LangCode } from './langs.ts'

export { DEFAULT_ROOT_LANG, isLangCode, LANG_CODES, localeKeyOf }
export type { LangCode }

/** Every message key (zh-CN is the source of truth). */
export type MessageKey = keyof typeof zhCN
/** A complete dictionary. en.ts is typed with it, so a missing or extra key is a type error. */
export type Messages = Record<MessageKey, string>
export type MessageParams = Record<string, string | number>

export const DICTIONARIES: Record<LangCode, Messages> = { 'zh-CN': zhCN, en }

/** Key shape enforced by the unit tests: flat, dotted, lower camelCase segments. */
export const MESSAGE_KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/

// ---- root language (the language of `/`; WP-I2 passes it in from lecture.config.ts) ----------
let rootLang: LangCode = DEFAULT_ROOT_LANG

export function setRootLang(lang: LangCode): void {
  rootLang = lang
}

export function getRootLang(): LangCode {
  return rootLang
}

/** Map an arbitrary `lang` attribute (`en-US`, `zh`, ...) to a supported language, or null. */
export function normalizeLang(value: string | null | undefined): LangCode | null {
  if (!value) return null
  if (isLangCode(value)) return value
  const head = value.toLowerCase().split(/[-_]/)[0]
  if (head === 'en') return 'en'
  if (head === 'zh') return 'zh-CN'
  return null
}

/**
 * Language of the page being shown, for plain TS modules (charts, reading tools) that produce text
 * outside Vue. Browser: `document.documentElement.lang`; SSR / no DOM: the root language.
 * Call it at the moment the text is produced, never at import time.
 */
export function currentLang(): LangCode {
  if (typeof document !== 'undefined') {
    const l = normalizeLang(document.documentElement?.lang)
    if (l) return l
  }
  return rootLang
}

// ---- translate -------------------------------------------------------------------------------
const warned = new Set<string>()

function isDev(): boolean {
  return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV)
}

function warnOnce(lang: LangCode, key: string): void {
  if (!isDev()) return
  const id = `${lang}\u0000${key}`
  if (warned.has(id)) return
  warned.add(id)
  console.warn(`[i18n] missing message "${key}" for "${lang}"`)
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const v = params[name]
    return v === undefined ? whole : String(v)
  })
}

/**
 * Look a message up: requested language -> root language -> zh-CN, then substitute `{name}`
 * placeholders (a missing param leaves `{name}` as is). An unknown key returns the key itself.
 */
export function translate(lang: LangCode, key: MessageKey, params?: MessageParams, root: LangCode = rootLang): string {
  const chain: LangCode[] = [lang, root, 'zh-CN']
  for (const l of chain) {
    const hit = (DICTIONARIES[l] as Partial<Record<string, string>> | undefined)?.[key]
    if (hit !== undefined) {
      if (l !== lang) warnOnce(lang, key)
      return interpolate(hit, params)
    }
  }
  warnOnce(lang, key)
  return interpolate(String(key), params)
}

/** Message key of the name of each language (in the language of the dictionary that is looked up). */
const LANG_LABEL_KEYS: Record<LangCode, MessageKey> = { 'zh-CN': 'lang.label.zhCN', en: 'lang.label.en' }

/** Name of `lang` written in `inLang` (en: "English" / "Chinese"; zh-CN: the Chinese words for them), for sentences. */
export function langLabel(inLang: LangCode, lang: LangCode): string {
  return translate(inLang, LANG_LABEL_KEYS[lang])
}

// ---- data fields (plan 3.3) --------------------------------------------------------------------
type Localizable = { i18n?: Partial<Record<LangCode, Partial<Record<string, string | undefined>>>> }

/**
 * Pick a text field of a data object (group meta, site meta, feature item) in `lang`:
 * `obj.i18n?.[lang]?.[field]` when non-empty, else the root-language `obj[field]` (else '').
 */
export function pickLocalized<F extends string>(
  obj: (Localizable & Partial<Record<F, string | undefined>>) | null | undefined,
  lang: LangCode,
  field: F,
): string {
  if (!obj) return ''
  const localized = obj.i18n?.[lang]?.[field]
  if (typeof localized === 'string' && localized !== '') return localized
  return obj[field] ?? ''
}

/**
 * Like `pickLocalized` for the site texts, where an EMPTY localized value is intentional (the owner left the
 * English tagline blank on purpose): a present `i18n[lang][field]` string wins even when '', so an empty English
 * field never falls back to the Chinese one. A field that is absent still falls back to the root language.
 */
export function pickSiteText<F extends string>(
  obj: (Localizable & Partial<Record<F, string | undefined>>) | null | undefined,
  lang: LangCode,
  field: F,
): string {
  if (!obj) return ''
  const localized = obj.i18n?.[lang]?.[field]
  if (typeof localized === 'string') return localized
  return obj[field] ?? ''
}
