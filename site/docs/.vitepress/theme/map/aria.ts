/**
 * map/aria.ts - the accessible description of a map (P4a WP-H1, docs-dev/MAP.md).
 * The map container carries it: group and lecture counts and how to operate the map. The group cards and the group
 * pages outside the map are the linear path to the same content.
 */
import { translate } from '../../i18n/index.ts'
import type { LangCode } from '../../i18n/langs.ts'

export interface MapAriaInput {
  groups: number
  lectures: number
  /** Prerequisite edges; only the dependency map (`graph`) mentions them. */
  edges?: number
}

/** The `aria-label` of the stage in `lang`: the overview (`atlas`, default) or the dependency map (`graph`, when `edges` is given). */
export function mapAriaLabel(lang: LangCode, input: MapAriaInput): string {
  if (input.edges === undefined) return translate(lang, 'map.aria.atlas', { groups: input.groups, lectures: input.lectures })
  return translate(lang, 'map.aria.graph', { groups: input.groups, lectures: input.lectures, edges: input.edges })
}

/** Short name for the svg itself. */
export function mapSvgLabel(lang: LangCode): string {
  return translate(lang, 'map.aria.short')
}
