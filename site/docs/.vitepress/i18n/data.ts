/**
 * i18n/data.ts - types of the optional `i18n` data fields (plan_v2_p2d_i18n.md 3.3).
 * Type-only: importing it costs nothing at runtime (esbuild erases `import type`).
 * A missing language or field falls back to the root-language text of the same object.
 */
import type { LangCode } from './langs.ts'

/** Course group: `title` / `tagline` / `summary` / `category` (P4a: the category name) in other languages. */
export type GroupI18n = Partial<Record<LangCode, { title?: string; tagline?: string; summary?: string; category?: string }>>

/** `SITE_META`: site name, hero title, hero tagline and description in other languages. */
export type SiteMetaI18n = Partial<Record<LangCode, { name?: string; shortName?: string; text?: string; tagline?: string; description?: string; pill?: string }>>

/**
 * `themeConfig.i18nPages` of a NON-root locale (P2d WP-I2, built in config.v2.mts): the translated lectures
 * of that language, keyed by the ROOT-language path (`/g01/L03`, no locale prefix, no `.md`). The page itself
 * is at `/<locale key>` + key. Components derive everything else (counts, links, "translated" marks) from
 * the root `themeConfig.groups` plus this map; a root path that is not a key here has no translation.
 */
export type I18nPages = Record<string, { title: string }>
