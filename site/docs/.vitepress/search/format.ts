/**
 * search/format.ts - Shared binary/JSON formats, slugify rule and budget constants
 * for the pruned split lecture search index (WP-F3).
 *
 * Pure module: no Node or VitePress imports so both the build indexer and the browser
 * engine share identical schemas, limits and heading slugification.
 */

export const TITLE_INDEX_MAX_BYTES = 1024 * 1024 // 1 MiB for root locale title index
export const SHARDS_TOTAL_MAX_BYTES = 8 * 1024 * 1024 // 8 MiB across all root body shards

export interface TitleIndexGroup {
  id: string
  dir: string
  title: string
  catSlot: number
}

/**
 * Compact tuple for a section heading (`H2`..`H4`):
 * `[level, text]` when `slug === slugifyHeading(text)` without collision;
 * `[level, text, customSlug]` when disambiguated (`-1`, `-2`, ...).
 */
export type CompactHeading = readonly [number, string] | readonly [number, string, string]

/**
 * Compact tuple for one indexed page inside `titles.json`:
 * `[groupIdx, lectureNo, code, url, displayTitle, headings, aliases?, conceptGroups?]`.
 */
export type CompactTitlePage = readonly [
  number,
  number | null,
  string,
  string,
  string,
  readonly CompactHeading[],
  (readonly string[])?,
  (readonly string[])?,
]

export interface TitleIndexFile {
  v: 1
  locale: string
  groups: TitleIndexGroup[]
  pages: CompactTitlePage[]
}

export interface ShardMeta {
  shardId: string
  groupId: string
  url: string
  bytes: number
  rawBytes: number
  pageCount: number
}

export interface SearchManifestFile {
  v: 1
  locale: string
  titleFile: string
  titleBytes: number
  totalShardBytes: number
  totalRawShardBytes: number
  shards: ShardMeta[]
}

/**
 * Compressed shard payload (`*.sz` raw deflate):
 * - `pages`: page URLs belonging to this group/shard (`pIdx` index target)
 * - `sections`: `[pageIdx, anchor, pathSegments, bodyText]`
 */
export interface ShardPayload {
  v: 1
  shardId: string
  groupId: string
  pages: string[]
  sections: Array<readonly [number, string, string[], string]>
}

export interface InflatedHeading {
  level: number
  text: string
  slug: string
  path: string[]
}

const rSpecial = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g
const rCombining = /[\u0300-\u036F]/g

function stripControlChars(str: string): string {
  let out = ''
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 0x1f) out += str[i]
  }
  return out
}

/** Exact VitePress 1.6.4 / @mdit-vue/shared heading slugifier. */
export function slugifyHeading(str: string): string {
  return stripControlChars(str.normalize('NFKD').replace(rCombining, ''))
    .replace(rSpecial, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

/** Strip `"第N讲 · "` prefix when `.no` column already displays the lecture number. */
export function stripLectureTitlePrefix(title: string): string {
  return title.replace(/^\s*第\s*\d+\s*讲\s*[·:：—-]\s*/, '').trim() || title.trim()
}

/** Expand compact heading tuples back into full headings with hierarchical breadcrumb paths and resolved slugs. */
export function inflateTitleHeadings(headings: readonly CompactHeading[]): InflatedHeading[] {
  const out: InflatedHeading[] = []
  const stack: Array<{ level: number; text: string }> = []
  const seen = Object.create(null) as Record<string, true>

  for (const item of headings) {
    const level = item[0]
    const text = item[1]
    const explicitSlug = item.length > 2 ? item[2] : undefined
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
      stack.pop()
    }
    const base = slugifyHeading(text)
    let slug = explicitSlug ?? base
    if (!explicitSlug) {
      let n = 1
      while (Object.prototype.hasOwnProperty.call(seen, slug)) {
        slug = `${base}-${n++}`
      }
    }
    seen[slug] = true
    const path = stack.map((s) => s.text)
    stack.push({ level, text })
    out.push({ level, text, slug, path })
  }
  return out
}

export function formatSearchUrl(base: string, relFilePath: string, cleanUrls = true): string {
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  const joined = `${normalizedBase}${relFilePath.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/')
  return joined.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, cleanUrls ? '' : '.html')
}
