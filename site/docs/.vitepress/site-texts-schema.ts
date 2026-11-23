/**
 * site/docs/.vitepress/site-texts-schema.ts
 *
 * Browser-safe definitions, validation and empty-value rules for the site texts.
 * Pure TypeScript with ZERO Node.js runtime imports (no fs, path, url),
 * so it can be bundled into browser client code (DashboardPage.vue).
 *
 * The texts file (`site/site-texts.json`) holds the values only. A template ships every value as "":
 * the example wording lives here as `SITE_TEXT_HINTS` (shown as a grey `placeholder` in the Dashboard,
 * never a value and never rendered on the site).
 */

export type TextsLocale = 'zh' | 'en'
export const TEXTS_LOCALES: readonly TextsLocale[] = ['zh', 'en']

export const SITE_TEXT_FIELDS = ['name', 'shortName', 'navText', 'tagline', 'description'] as const
export type SiteTextField = (typeof SITE_TEXT_FIELDS)[number]

export type LocaleSiteTexts = Record<SiteTextField, string>
export type SiteTexts = Record<TextsLocale, LocaleSiteTexts>

/** Only `name` must be filled; every other field has a defined empty behaviour (see `resolveLocaleTexts`). */
export const REQUIRED_FIELDS: readonly SiteTextField[] = ['name']

export const FIELD_LIMITS: Record<SiteTextField, number> = {
  name: 60,
  shortName: 30,
  navText: 50,
  tagline: 120,
  description: 300,
}

/** Tokens a field may contain: `{lectures}` (lecture count of the build) is replaced in the home description only. */
export const FIELD_TOKENS: Record<SiteTextField, readonly string[]> = {
  name: [],
  shortName: [],
  navText: [],
  tagline: [],
  description: ['lectures'],
}

/** One hint per field and locale: example wording shown as the input's `placeholder`. */
export const SITE_TEXT_HINTS: Record<TextsLocale, Record<SiteTextField, string>> = {
  zh: {
    name: '站点名称，例如课程名',
    shortName: '手机顶栏用的短名称',
    navText: '首页顶部的一行文字',
    tagline: '一句话说明这套讲义讲什么',
    description: '首页描述，可写 {lectures} 表示讲数',
  },
  en: {
    name: 'Site name, for example the course title',
    shortName: 'Short name for the phone top bar',
    navText: 'One line shown at the top of the home page',
    tagline: 'One sentence on what these lectures cover',
    description: 'Home page description; {lectures} stands for the lecture count',
  },
}

/** A template: every value empty. */
export function emptySiteTexts(): SiteTexts {
  const block = (): LocaleSiteTexts => ({ name: '', shortName: '', navText: '', tagline: '', description: '' })
  return { zh: block(), en: block() }
}

/** Texts read from untrusted JSON: keep string fields, everything else becomes "". Never throws. */
export function normalizeSiteTexts(input: unknown): SiteTexts {
  const out = emptySiteTexts()
  if (typeof input !== 'object' || input === null) return out
  const record = input as Record<string, unknown>
  for (const loc of TEXTS_LOCALES) {
    const block = record[loc]
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    for (const field of SITE_TEXT_FIELDS) {
      const v = b[field]
      if (typeof v === 'string') out[loc][field] = v
    }
  }
  return out
}

export interface EmptyField {
  locale: TextsLocale
  field: SiteTextField
  required: boolean
}

/** Every empty field per locale (whitespace only counts as empty). */
export function listEmptyFields(texts: SiteTexts): EmptyField[] {
  const out: EmptyField[] = []
  for (const locale of TEXTS_LOCALES) {
    for (const field of SITE_TEXT_FIELDS) {
      if (texts[locale][field].trim() === '') out.push({ locale, field, required: REQUIRED_FIELDS.includes(field) })
    }
  }
  return out
}

/**
 * Apply the empty-value rules of one locale:
 *   shortName empty -> name; description empty -> tagline (both empty: '' = no meta description);
 *   navText / tagline empty stay '' and are not rendered.
 */
export function resolveLocaleTexts(block: LocaleSiteTexts): LocaleSiteTexts {
  const name = block.name.trim()
  const tagline = block.tagline.trim()
  return {
    name,
    shortName: block.shortName.trim() || name,
    navText: block.navText.trim(),
    tagline,
    description: block.description.trim() || tagline,
  }
}

/** Replace the `{lectures}` token with the lecture count of this build (left as is without a count). */
export function fillLecturesToken(text: string, lectures: number | undefined): string {
  return lectures ? text.replace(/\{lectures\}/g, String(lectures)) : text
}

export type TextIssueCode = 'required' | 'too_long' | 'unknown_token' | 'not_string' | 'bad_shape'

export interface TextIssue {
  locale?: TextsLocale
  field?: SiteTextField
  code: TextIssueCode
  /** too_long: the limit; unknown_token: the offending token. */
  detail?: string | number
}

/** Plain English line for logs, API errors and doctor (the Dashboard maps `code` to its own dictionary). */
export function formatIssue(issue: TextIssue): string {
  const where = issue.locale && issue.field ? `${issue.locale}.${issue.field}` : 'site texts'
  switch (issue.code) {
    case 'required':
      return `${where}: required, must not be empty`
    case 'too_long':
      return `${where}: longer than ${String(issue.detail)} characters`
    case 'unknown_token':
      return `${where}: unknown token ${String(issue.detail)} (allowed: ${FIELD_TOKENS[issue.field ?? 'name'].map((t) => `{${t}}`).join(', ') || 'none'})`
    case 'not_string':
      return `${where}: must be a string`
    default:
      return `${where}: expected an object with "zh" and "en" blocks`
  }
}

export interface ValidationResult {
  valid: boolean
  issues: TextIssue[]
  /** Same issues as `formatIssue` lines. */
  errors: string[]
  texts?: SiteTexts
}

function fail(issues: TextIssue[]): ValidationResult {
  return { valid: false, issues, errors: issues.map(formatIssue) }
}

/** Validate an edit (Dashboard, API): shape, required `name`, length limits, tokens. Empty optional fields are valid. */
export function validateSiteTexts(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail([{ code: 'bad_shape' }])
  const record = input as Record<string, unknown>
  const issues: TextIssue[] = []
  const texts = emptySiteTexts()

  for (const locale of TEXTS_LOCALES) {
    const block = record[locale]
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      issues.push({ locale, code: 'bad_shape' })
      continue
    }
    const b = block as Record<string, unknown>
    for (const field of SITE_TEXT_FIELDS) {
      const raw = b[field]
      if (typeof raw !== 'string') {
        issues.push({ locale, field, code: 'not_string' })
        continue
      }
      const value = raw.trim()
      texts[locale][field] = value
      if (value === '') {
        if (REQUIRED_FIELDS.includes(field)) issues.push({ locale, field, code: 'required' })
        continue
      }
      if (value.length > FIELD_LIMITS[field]) {
        issues.push({ locale, field, code: 'too_long', detail: FIELD_LIMITS[field] })
        continue
      }
      for (const m of value.matchAll(/\{([^{}]*)\}/g)) {
        if (!FIELD_TOKENS[field].includes(m[1] ?? '')) issues.push({ locale, field, code: 'unknown_token', detail: m[0] })
      }
    }
  }

  return issues.length > 0 ? fail(issues) : { valid: true, issues: [], errors: [], texts }
}
