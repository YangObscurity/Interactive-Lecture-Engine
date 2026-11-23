/**
 * curriculum/split.ts - splitting the curriculum into the inline part and one slice per restricted access tier, and
 * merging slices back (P4a WP-H1, docs-dev/MAP.md; the same model as access/siteData.ts). Pure.
 *
 *   inline          the groups of the inline tier and the edges whose two ends are both in them
 *                   (this is what the VitePress data loader `curriculum.data.mts` ships in the page bundle)
 *   slice of T      the groups of tier T and every edge with at least one end in T, written to
 *                   `/_access/T/curriculum.<locale>.json`
 *
 * `splitCurriculum` and `mergeCurriculum` are inverse: merging the inline part with the slices of ALL tiers gives the
 * original; with only some slices it gives the original minus the groups of the other tiers and every edge that touches
 * one of them. Positions are kept the way `splitSiteData` keeps them (`order`, `inlineBefore`).
 */
import { insertPlaced } from '../access/siteData.ts'
import { isGroup, statsOf } from './data.ts'
import type { CurriculumData, CurriculumGroup } from './data.ts'

export interface PlacedGroup {
  /** Index of the group in the full list. */
  order: number
  /** How many inline groups come before it. */
  inlineBefore: number
  value: CurriculumGroup
}

/** The content of `/_access/<tier>/curriculum.<locale>.json`. */
export interface CurriculumSlice {
  version: 1
  tier: string
  /** Locale bucket (`root`, `en`). */
  locale: string
  groups: PlacedGroup[]
  edges: [string, string][]
}

export interface CurriculumSplitOptions {
  /** Tier of a group id; unknown groups should return the inline tier. */
  tierOfGroup: (groupId: string) => string
  inlineTier: string
}

export interface CurriculumSplit {
  inline: CurriculumData
  /** One slice per restricted tier that owns at least one group. */
  slices: Record<string, CurriculumSlice>
}

const pairKey = (e: readonly [string, string]): string => `${e[0]}\u0000${e[1]}`
const byPair = (a: readonly [string, string], b: readonly [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)

export function splitCurriculum(full: CurriculumData, options: CurriculumSplitOptions): CurriculumSplit {
  const groupOfLecture = new Map<string, string>()
  for (const g of full.groups) for (const l of g.lectures) groupOfLecture.set(l.id, g.id)
  const tierOf = (groupId: string): string => options.tierOfGroup(groupId)
  const tierOfLecture = (id: string): string => {
    const g = groupOfLecture.get(id)
    return g === undefined ? options.inlineTier : tierOf(g)
  }

  const inlineGroups: CurriculumGroup[] = []
  const slices: Record<string, CurriculumSlice> = {}
  full.groups.forEach((g, order) => {
    const tier = tierOf(g.id)
    if (tier === options.inlineTier) inlineGroups.push(g)
    else (slices[tier] ??= { version: 1, tier, locale: full.locale, groups: [], edges: [] }).groups.push({ order, inlineBefore: inlineGroups.length, value: g })
  })

  const inlineEdges: [string, string][] = []
  for (const e of full.edges) {
    const ta = tierOfLecture(e[0])
    const tb = tierOfLecture(e[1])
    if (ta === options.inlineTier && tb === options.inlineTier) inlineEdges.push(e)
    for (const t of new Set([ta, tb])) if (t !== options.inlineTier) slices[t]?.edges.push(e)
  }

  return {
    inline: { version: 1, locale: full.locale, groups: inlineGroups, edges: inlineEdges, stats: statsOf(inlineGroups, inlineEdges) },
    slices,
  }
}

/** Put slices (any subset of the tiers) back into the inline part. `inline` is not mutated. */
export function mergeCurriculum(inline: CurriculumData, slices: readonly CurriculumSlice[]): CurriculumData {
  if (slices.length === 0) return inline
  const groups = insertPlaced(inline.groups, slices.flatMap((s) => s.groups)) as CurriculumGroup[]
  const present = new Set<string>()
  for (const g of groups) for (const l of g.lectures) present.add(l.id)
  const seen = new Set<string>()
  const edges: [string, string][] = []
  for (const e of [...inline.edges, ...slices.flatMap((s) => s.edges)]) {
    if (!present.has(e[0]) || !present.has(e[1])) continue
    const k = pairKey(e)
    if (seen.has(k)) continue
    seen.add(k)
    edges.push(e)
  }
  edges.sort(byPair)
  return { version: 1, locale: inline.locale, groups, edges, stats: statsOf(groups, edges) }
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Shape check of a fetched slice. */
export function isCurriculumSlice(v: unknown): v is CurriculumSlice {
  if (!isRec(v) || v.version !== 1 || typeof v.tier !== 'string' || typeof v.locale !== 'string' || !Array.isArray(v.groups) || !Array.isArray(v.edges)) return false
  const placed = (x: unknown): boolean => isRec(x) && typeof x.order === 'number' && typeof x.inlineBefore === 'number' && isGroup(x.value)
  return v.groups.every(placed) && v.edges.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'string')
}
