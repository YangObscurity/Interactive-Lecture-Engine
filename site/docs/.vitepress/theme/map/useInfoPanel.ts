/**
 * map/useInfoPanel.ts - state of the info panel at the top right of the map (P4a WP-H1).
 *
 * The panel does not follow the pointer; hovering something calls `show(content)`, leaving it calls `hide()`, which
 * waits 140 ms so that moving between neighbouring nodes does not flicker.
 */
import { getCurrentInstance, onBeforeUnmount, shallowRef } from 'vue'
import type { Ref } from 'vue'

export interface MapInfoSection {
  /** Small heading (for example "Prerequisites"). */
  heading?: string
  /** Colours the heading: `pre` = accent, `post` = done colour. */
  tone?: 'pre' | 'post'
  /** Bulleted lines. */
  items?: readonly string[]
  /** A muted paragraph. */
  text?: string
}

export interface MapInfoContent {
  /** Bold first line. */
  title?: string
  /** Muted lines under the title. */
  lines?: readonly string[]
  sections?: readonly MapInfoSection[]
}

/** The panel stays visible this long (ms) after `hide()`. */
export const INFO_HIDE_DELAY_MS = 140

export interface UseInfoPanel {
  content: Readonly<Ref<MapInfoContent | null>>
  open: Readonly<Ref<boolean>>
  show(content: MapInfoContent): void
  hide(): void
}

export function useInfoPanel(options: { hideDelay?: number } = {}): UseInfoPanel {
  const content = shallowRef<MapInfoContent | null>(null)
  const open = shallowRef(false)
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  if (getCurrentInstance()) onBeforeUnmount(clear)
  return {
    content,
    open,
    show(c) {
      clear()
      content.value = c
      open.value = true
    },
    hide() {
      clear()
      timer = setTimeout(() => {
        timer = null
        open.value = false
      }, options.hideDelay ?? INFO_HIDE_DELAY_MS)
    },
  }
}
