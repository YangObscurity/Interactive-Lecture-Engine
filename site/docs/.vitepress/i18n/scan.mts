/**
 * i18n/scan.mts - which lectures exist in which non-root language (P2d, plan 3.4). Node only.
 *
 * A translation of the root-language lecture `docs/<dir>/L03.md` lives at `docs/<key>/<dir>/L03.md`
 * (`<key>` = locale key, e.g. `en`). The scan maps the ROOT path (`/<dir>/L03`, no locale prefix, no
 * `.md`) to the translated page. The result feeds the sidebar and `themeConfig.i18nPages` (config.v2.mts),
 * the cross-locale link rewrite, and the hreflang links.
 *
 * Adding a language: enable it in lecture.config.ts `i18n.locales`; its translations go to
 * `docs/<localeKeyOf(lang)>/...` and are found here with no further code.
 */
import fs from 'node:fs'
import path from 'node:path'

/** One translated lecture. */
export interface TranslatedPage {
  /** URL path of the translated page, e.g. `/en/g01/L03`. */
  link: string
  /** Title from the translated file's frontmatter ('' when it has none). */
  title: string
}

/** ROOT path (`/g01/L03`) -> translated page, for one locale. */
export type LocaleTranslations = Record<string, TranslatedPage>

/** locale key -> translations of that locale. */
export type TranslationScan = Record<string, LocaleTranslations>

const LECTURE_FILE_RE = /^L\d+\.md$/

/** `title:` of a markdown frontmatter, quotes stripped (same rule as the sidebar in config.mts). */
export function readTitle(src: string): string | null {
  const m = src.match(/^title:\s*(.+)$/m)
  if (!m) return null
  return (m[1] as string).trim().replace(/^"([\s\S]*)"$/, '$1').replace(/\\"/g, '"')
}

function walk(dir: string, rel: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, out)
    } else if (LECTURE_FILE_RE.test(entry.name)) {
      out.push(rel ? `${rel}/${entry.name}` : entry.name)
    }
  }
}

/** Scan `docs/<key>/**` of one locale. A missing folder means no translations. */
export function scanLocale(docsRoot: string, key: string): LocaleTranslations {
  const base = path.join(docsRoot, key)
  const out: LocaleTranslations = {}
  if (!fs.existsSync(base)) return out
  const files: string[] = []
  walk(base, '', files)
  for (const rel of files.sort()) {
    const noExt = rel.slice(0, -3)
    const title = readTitle(fs.readFileSync(path.join(base, rel), 'utf-8')) ?? ''
    out[`/${noExt}`] = { link: `/${key}/${noExt}`, title }
  }
  return out
}

/** Scan every given non-root locale key. */
export function scanTranslations(docsRoot: string, localeKeys: readonly string[]): TranslationScan {
  const out: TranslationScan = {}
  for (const key of localeKeys) out[key] = scanLocale(docsRoot, key)
  return out
}
