/**
 * access/searchIndex.ts - the search index of a locale with the restricted tiers added (docs-dev/ACCESS.md
 * section 4, "Search"). The Vite plugin `accessSearchPlugin` makes `@localSearchIndex` export, per locale,
 * `() => searchIndexFor(locale, () => import('@localSearchIndex<locale>'))`.
 *
 * The built-in index (a JSON string, as VitePress writes it) is loaded with the SAME MiniSearch options the VitePress
 * search box uses, the documents of every readable tier (`/_access/<tier>/search/<locale>.json`) are added, and the
 * result is serialised again. Without a restricted tier the built-in index comes back untouched and nothing is fetched.
 */
import MiniSearch from 'minisearch'
import type { Options } from 'minisearch'
import type { SearchDocument } from '../../access/search'
import { fetchTierJson, tierUrl } from './resolve'
import type { AccessDeps, AccessResult } from './resolve'

/** The MiniSearch options of `VPLocalSearchBox.vue` (vitepress 1.6.4): `fields`, `storeFields` and `search.options.miniSearch.options`. */
export function searchIndexOptions(site: unknown): Options {
  const search = (site as { themeConfig?: { search?: { provider?: unknown; options?: { miniSearch?: { options?: Partial<Options> } } } } } | null | undefined)?.themeConfig?.search
  const extra = search?.provider === 'local' ? search.options?.miniSearch?.options : undefined
  return { fields: ['title', 'titles', 'text'], storeFields: ['title', 'titles'], ...extra }
}

function isSearchDocument(v: unknown): v is SearchDocument {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Record<string, unknown>
  return typeof d.id === 'string' && typeof d.title === 'string' && Array.isArray(d.titles) && typeof d.text === 'string'
}

/** Pure: the built-in index (JSON string) plus documents, serialised with the options the search box will load it with. */
export function mergeSearchIndex(builtin: string, documents: readonly SearchDocument[], options: Options): string {
  if (documents.length === 0) return builtin
  const index = MiniSearch.loadJSON<SearchDocument>(builtin, options)
  index.addAll(documents as SearchDocument[])
  return JSON.stringify(index)
}

/** The documents of the readable tiers for a locale. A file that does not arrive or is malformed adds nothing. */
export async function loadTierDocuments(access: AccessResult, locale: string, deps: AccessDeps): Promise<SearchDocument[]> {
  const parts = await Promise.all(
    access.tiers.map(async (t) => {
      const json = await fetchTierJson(deps, tierUrl(deps, t.id, `search/${locale}.json`))
      return Array.isArray(json) ? json.filter(isSearchDocument) : []
    }),
  )
  return parts.flat()
}

export interface SearchIndexInput {
  access: AccessResult
  locale: string
  deps: AccessDeps
  site: unknown
}

/** `{ default: <index JSON string> }` for a locale: the built-in one, with the readable tiers' documents added. */
export async function buildSearchIndex(loadBuiltin: () => Promise<{ default: string }>, input: SearchIndexInput): Promise<{ default: string }> {
  const builtin = await loadBuiltin()
  if (input.access.tiers.length === 0) return builtin
  const documents = await loadTierDocuments(input.access, input.locale, input.deps)
  return { default: mergeSearchIndex(builtin.default, documents, searchIndexOptions(input.site)) }
}
