/**
 * access/paths.ts - where the chart sidecars and export files of a page live (docs-dev/ACCESS.md).
 *
 * In a production build a lecture of a restricted tier keeps its charts and exports under `/_access/<tier>/`; every
 * other lecture, and every lecture in dev (the dev server serves the source files), uses the plain paths. The tier of a
 * page is `frontmatter.accessTier` (written by the build only when a restricted tier exists).
 */
import { tierBasePath } from '../../access/tiers'

/** `''` or `/_access/<tier>`: the prefix to put in front of `/charts/...` and `/exports/...` for a page of `pageTier`. */
export function tierAssetPrefix(pageTier: unknown, restrictedTiers: readonly string[] | undefined, dev: boolean): string {
  if (dev || typeof pageTier !== 'string' || !restrictedTiers || !restrictedTiers.includes(pageTier)) return ''
  return tierBasePath(pageTier)
}

let currentPageTier: string | null = null

/** The theme tells the client code which tier the page on screen belongs to (null: none / not a group page). */
export function setPageTier(tier: unknown): void {
  currentPageTier = typeof tier === 'string' && tier ? tier : null
}

export function getPageTier(): string | null {
  return currentPageTier
}
