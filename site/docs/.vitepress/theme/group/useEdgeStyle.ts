/**
 * group/useEdgeStyle.ts - the line style of the lecture map for the theme that is active now (P4a WP-H3): `layout.edges` of the
 * theme's `theme.json` (`curve` when it declares none), through `virtual:lecture-components` `THEME_LAYOUT`. It follows the
 * `<html data-lec-theme>` attribute the slot runtime watches, so a reader who switches theme gets the other style at once.
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { SLOT_DEFAULT_THEME, THEME_LAYOUT } from 'virtual:lecture-components'
import { slotRuntime } from '../slots'
import { DEFAULT_EDGE_STYLE, edgeStyleOf } from './model'
import type { EdgeStyle } from './model'

export function useEdgeStyle(): ComputedRef<EdgeStyle> {
  return computed(() => {
    const active = slotRuntime.activeTheme.value ?? (typeof document !== 'undefined' ? document.documentElement.getAttribute('data-lec-theme') : null)
    return edgeStyleOf(THEME_LAYOUT, active ?? SLOT_DEFAULT_THEME) ?? DEFAULT_EDGE_STYLE
  })
}
