/**
 * concepts/access.ts - Access tier inheritance & compatibility rules for stand-alone concept pages.
 *
 * Rule (§5.2.2 / §7.4):
 *   - A concept page inherits the strictest tier among its `groups` (`grp-*` > `authenticated`).
 *   - Any `public` group among `concept.groups` makes the concept `public`.
 *   - A lecture may only link to concepts readable by that lecture's audience.
 */
import { TIER_PUBLIC, lookupTier, tierBasePath, tierRank, type AccessPlan } from '../access/tiers.ts'

export interface ConceptTierResolution {
  tier: string
  drop: boolean
}

export function resolveConceptTier(
  conceptGroups: readonly string[],
  plan: AccessPlan,
  builtGroupIds?: ReadonlySet<string>,
): ConceptTierResolution {
  const normalized = conceptGroups.map((g) => g.trim().toUpperCase()).filter(Boolean)
  const relevant = builtGroupIds
    ? normalized.filter((g) => builtGroupIds.has(g))
    : normalized

  if (normalized.length > 0 && builtGroupIds && relevant.length === 0) {
    return { tier: plan.inlineTier, drop: true }
  }

  if (relevant.length === 0) {
    return { tier: plan.inlineTier, drop: false }
  }

  const tiers = relevant
    .map((g) => lookupTier(plan, g))
    .filter((t): t is string => t !== null)
  if (tiers.length === 0) {
    return { tier: plan.inlineTier, drop: true }
  }
  if (tiers.includes(TIER_PUBLIC)) {
    return { tier: TIER_PUBLIC, drop: false }
  }

  let strictest = tiers[0] as string
  for (const tier of tiers.slice(1)) {
    const diff = tierRank(tier) - tierRank(strictest)
    if (diff > 0 || (diff === 0 && tier < strictest)) {
      strictest = tier
    }
  }
  return { tier: strictest, drop: false }
}

/**
 * Check whether readers who have access ONLY to `readerTier` (a lecture's tier)
 * are allowed by gateway/auth rules to read a concept of tier `conceptTier`.
 */
export function canReaderTierReadConcept(readerTier: string, conceptTier: string): boolean {
  if (conceptTier === TIER_PUBLIC) return true
  if (readerTier === TIER_PUBLIC) return false
  if (conceptTier === 'authenticated') {
    return tierRank(readerTier) >= 1
  }
  // Specific group tier `grp-*`: only that exact group tier guarantees access
  return readerTier === conceptTier
}

/**
 * `pageChunkPatterns` entry for the concept pages of a restricted tier. They are mounted under `_access/<tier>/concepts/`
 * and rollup names their page chunks `access_<tier>_concepts_<slug>.md.<hash>[.lean].js` (the leading underscore is dropped;
 * a language adds `en_` or `en__`). Without this entry the gateway would serve those chunks, which carry the concept text, to everyone.
 */
export function conceptTierChunkPattern(tierId: string, localeKeys: readonly string[]): string {
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const locales = localeKeys.length > 0 ? `(?:(?:${localeKeys.map(esc).join('|')})_)?` : ''
  return `^/assets/${locales}_{0,2}access_${esc(tierId)}_`
}

export function conceptHoverUrl(tier: string, inlineTier: string, withBase: (p: string) => string): string {
  if (tier === inlineTier || tier === TIER_PUBLIC) {
    return withBase('/concepts-hover.json')
  }
  return withBase(`${tierBasePath(tier)}/concepts-hover.json`)
}

export function conceptBacklinksUrl(tier: string, withBase: (p: string) => string): string {
  return withBase(`${tierBasePath(tier)}/concepts-backlinks.json`)
}

export function conceptPageUrl(
  slug: string,
  conceptTier: string,
  inlineTier: string,
  isDev = false,
): string {
  if (isDev || conceptTier === inlineTier || conceptTier === TIER_PUBLIC) {
    return `/concepts/${slug}`
  }
  return `${tierBasePath(conceptTier)}/concepts/${slug}`
}

export function conceptDraftPreviewUrl(slug: string): string {
  return `/concepts/_drafts/${slug}`
}
