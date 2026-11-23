/**
 * site/docs/.vitepress/site-texts.mts
 *
 * Node side of the site texts. The file location comes from `content/paths.mts` (`<content>/site-texts.json`, or
 * `site/site-texts.json` in-place); the template `site-texts.example.json` is read when it is missing.
 * Browser-safe schema, validation and empty-value rules are in `site-texts-schema.ts`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveContent, siteFilesIn } from './content/paths.mts'
import type { SiteMeta } from './groups-source.mts'
import {
  type SiteTexts,
  emptySiteTexts,
  formatIssue,
  normalizeSiteTexts,
  resolveLocaleTexts,
  validateSiteTexts,
} from './site-texts-schema.ts'

export * from './site-texts-schema.ts'

/** `siteDir` (tests, tools) names a folder with the in-place layout; without it the active content root decides. */
export function getSiteTextsPath(siteDir?: string): string {
  return siteDir ? siteFilesIn(siteDir).siteTexts : resolveContent().siteTexts
}

export function getExampleTextsPath(siteDir?: string): string {
  return siteDir ? siteFilesIn(siteDir).siteTextsExample : resolveContent().siteTextsExample
}

function readTextsFile(file: string): SiteTexts {
  try {
    // a byte-order mark (Windows editors) is not part of the JSON
    return normalizeSiteTexts(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
  } catch (err) {
    throw new Error(`site texts file ${file} cannot be read as JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Texts of an unnamed in-place site (`LECTURE_DEMO=0` and no content folder): used only when neither
 * `site/site-texts.json` nor a filled template names the site, so such a build still passes `assertSiteTexts`
 * and its home page says what to do. A content folder (and the demo fallback) never falls back to these:
 * its owner fills `site-texts.json` (`npm run init` leaves it empty).
 */
export const IN_PLACE_SITE_TEXTS: SiteTexts = {
  zh: { name: '交互式讲义引擎', shortName: '讲义引擎', navText: '', tagline: '原位模式：讲义放在 site/docs。运行 npm run init 创建自己的内容目录', description: '' },
  en: { name: 'Interactive Lecture Engine', shortName: 'Lecture Engine', navText: '', tagline: 'In-place mode: lectures live in site/docs. Run npm run init to create a content folder', description: '' },
}

/**
 * The texts of this site: `site-texts.json`, else the example template, else all empty.
 * Missing or non-string fields read as "". A file that exists but is not valid JSON throws (names the file).
 * In-place mode without a named site reads `IN_PLACE_SITE_TEXTS`.
 */
export function loadSiteTexts(options?: { siteDir?: string }): SiteTexts {
  let texts: SiteTexts | null = null
  for (const file of [getSiteTextsPath(options?.siteDir), getExampleTextsPath(options?.siteDir)]) {
    if (fs.existsSync(file)) {
      texts = readTextsFile(file)
      break
    }
  }
  const unnamed = !texts || (!texts.zh.name.trim() && !texts.en.name.trim())
  if (unnamed && !options?.siteDir && resolveContent().mode === 'in-place') return structuredClone(IN_PLACE_SITE_TEXTS)
  return texts ?? emptySiteTexts()
}

/** Problems that stop a production build (and are errors in `doctor`): required fields, limits, tokens. */
export function siteTextsProblems(texts: SiteTexts): string[] {
  return validateSiteTexts(texts).issues.map(formatIssue)
}

/** Throws with a message naming the field(s) and the file when the texts are not buildable. */
export function assertSiteTexts(texts: SiteTexts, siteDir?: string): void {
  const problems = siteTextsProblems(texts)
  if (problems.length === 0) return
  throw new Error(
    `[site-texts] ${getSiteTextsPath(siteDir)} cannot be built:\n  - ${problems.join('\n  - ')}\n` +
      'Fill the fields in that file (or in the Dashboard page "站点文案"). "name" is required in both locales.',
  )
}

/**
 * `SITE_META` for the config and the home page, with the empty-value rules applied:
 * short name falls back to the name (and is dropped when it equals it), description falls back to the tagline;
 * empty navText / tagline stay "" for BOTH locales (an English field never falls back to the Chinese one).
 */
export function toSiteMeta(texts: SiteTexts): SiteMeta {
  const zh = resolveLocaleTexts(texts.zh)
  const en = resolveLocaleTexts(texts.en)
  const short = (r: typeof zh) => (r.shortName === r.name ? '' : r.shortName)
  return {
    name: zh.name,
    shortName: short(zh),
    text: zh.navText,
    tagline: zh.tagline,
    description: zh.description,
    i18n: {
      en: { name: en.name, shortName: short(en), text: en.navText, tagline: en.tagline, description: en.description },
    },
  }
}

/** Atomic write (temp file in the same directory, then rename). */
export function saveSiteTexts(texts: SiteTexts, options?: { siteDir?: string; targetPath?: string }): void {
  const target = options?.targetPath ?? getSiteTextsPath(options?.siteDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmpPath = `${target}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmpPath, JSON.stringify(texts, null, 2) + '\n', 'utf8')
  fs.renameSync(tmpPath, target)
}
