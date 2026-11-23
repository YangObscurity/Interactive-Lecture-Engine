/**
 * curriculum/loader.ts - the client loader of the curriculum (P4a WP-H1, docs-dev/MAP.md).
 *
 *   loadCurriculum(locale)          the inline curriculum merged with the slices of every tier the reader may read
 *   loadCurriculumSlices(locale)    just those slices
 *   loadInlineCurriculum(locale)    the inline part (the data loader's chunk)
 *
 * `locale` is a locale bucket: `root` or a locale key (`en`) - what VitePress `useData().localeIndex` returns.
 * The readable tiers come from the P3b access store (`getAccess`): a site with no restricted tier, and an anonymous
 * reader of a site whose tiers are all closed, make NO request; each readable tier costs one GET of
 * `/_access/<tier>/curriculum.<locale>.json`. The answer counts only for a 200 with a valid slice of that tier.
 * One resolution of the access store is merged once per locale (re-resolving after a sign-in gives a fresh merge).
 */
import { isCurriculumData, emptyCurriculum } from '../../curriculum/data'
import type { CurriculumData } from '../../curriculum/data'
import { isCurriculumSlice, mergeCurriculum } from '../../curriculum/split'
import type { CurriculumSlice } from '../../curriculum/split'
import { fetchTierJson, tierUrl } from '../access/resolve'
import type { AccessDeps, AccessResult } from '../access/resolve'
import { accessDeps, getAccess } from '../access/store'

export interface CurriculumDeps {
  /** The inline data of every locale bucket (the data loader chunk). */
  inline: () => Promise<Record<string, CurriculumData>>
  /** The readable tiers. */
  access: () => Promise<AccessResult>
  /** fetch / withBase for the tier files; null (no global fetch, store not configured) = no slice can be loaded. */
  http: () => AccessDeps | null
}

/** The inline part of `locale`; an unknown locale falls back to `root`, a missing or malformed chunk to an empty curriculum. */
export async function inlineOf(deps: Pick<CurriculumDeps, 'inline'>, locale: string): Promise<CurriculumData> {
  try {
    const all = await deps.inline()
    const hit = all[locale] ?? all.root
    return isCurriculumData(hit) ? hit : emptyCurriculum(locale)
  } catch {
    return emptyCurriculum(locale)
  }
}

export async function slicesOf(deps: Pick<CurriculumDeps, 'access' | 'http'>, locale: string): Promise<CurriculumSlice[]> {
  const access = await deps.access()
  if (access.tiers.length === 0) return []
  const http = deps.http()
  if (!http) return []
  const parts = await Promise.all(
    access.tiers.map(async (t) => {
      const json = await fetchTierJson(http, tierUrl(http, t.id, `curriculum.${locale}.json`))
      return isCurriculumSlice(json) && json.tier === t.id ? json : null
    }),
  )
  return parts.filter((s): s is CurriculumSlice => s !== null)
}

/** Inline part merged with the readable tiers' slices. Pure over `deps`; the exported loaders bind the real ones. */
export async function loadCurriculumWith(deps: CurriculumDeps, locale: string): Promise<CurriculumData> {
  const [inline, slices] = await Promise.all([inlineOf(deps, locale), slicesOf(deps, locale)])
  return mergeCurriculum(inline, slices)
}

import { data as inlineData } from './curriculum.data.mts'

const realDeps: CurriculumDeps = {
  inline: () => Promise.resolve(inlineData),
  access: () => getAccess(),
  http: () => accessDeps(),
}

export const loadInlineCurriculum = (locale: string = 'root'): Promise<CurriculumData> => inlineOf(realDeps, locale)
export const loadCurriculumSlices = (locale: string = 'root'): Promise<CurriculumSlice[]> => slicesOf(realDeps, locale)

const merged = new Map<string, { access: AccessResult; promise: Promise<CurriculumData> }>()

/** Merged curriculum of `locale` for the current access resolution (cached per resolution and locale). */
export async function loadCurriculum(locale: string = 'root'): Promise<CurriculumData> {
  const access = await getAccess()
  const hit = merged.get(locale)
  if (hit && hit.access === access) return hit.promise
  const promise = loadCurriculumWith({ ...realDeps, access: () => Promise.resolve(access) }, locale)
  merged.set(locale, { access, promise })
  return promise
}
