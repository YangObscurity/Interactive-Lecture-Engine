/**
 * i18n/langs.ts - the language list, with NO imports on purpose: lecture-config.mts (loaded by plain
 * `node` scripts such as setup/doctor) needs it, so this file must stay loadable by Node's type
 * stripping (erasable syntax only, explicit extensions).
 */

/** Languages with a built-in dictionary. Order = default `locales` order after the root. */
export const LANG_CODES = ['zh-CN', 'en'] as const
export type LangCode = (typeof LANG_CODES)[number]

/** Root language when `lecture.config.ts` has no `i18n` block. */
export const DEFAULT_ROOT_LANG: LangCode = 'zh-CN'

export function isLangCode(value: unknown): value is LangCode {
  return typeof value === 'string' && (LANG_CODES as readonly string[]).includes(value)
}

const LOCALE_KEYS: Record<LangCode, string> = { 'zh-CN': 'zh', en: 'en' }

/** Route prefix of a non-root language: `en` -> `en`, `zh-CN` -> `zh`. */
export function localeKeyOf(lang: LangCode): string {
  return LOCALE_KEYS[lang]
}
