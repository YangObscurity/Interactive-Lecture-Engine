/**
 * access/searchRuntime.ts - what the generated `@localSearchIndex` module calls (see `accessSearchPlugin`). Kept apart
 * from `store.ts` so MiniSearch is only loaded together with the search box.
 */
import { buildSearchIndex } from './searchIndex'
import { accessDeps, getAccess, inlineSiteData } from './store'

/** The search index of `locale` as the search box loads it: the built-in index plus the readable tiers' documents. */
export async function searchIndexFor(locale: string, loadBuiltin: () => Promise<{ default: string }>): Promise<{ default: string }> {
  const deps = accessDeps()
  if (!deps) return loadBuiltin()
  return buildSearchIndex(loadBuiltin, { access: await getAccess(), locale, deps, site: inlineSiteData() })
}
