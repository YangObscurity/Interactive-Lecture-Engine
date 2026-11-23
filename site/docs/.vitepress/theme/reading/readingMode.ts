/**
 * reading/readingMode.ts — immersive reading class on <html> (V1 reading-mode.ts as a PageFeature).
 *
 * The class `html.reading-mode` is driven by localStorage `lecture-reading-mode` === '1' and is
 * never set on the home page. First paint is handled by the inline <head> script in config.mts
 * (`head`, "reading-mode first paint") so there is no flash; this feature keeps the class correct on
 * every page visit. The toggle button is components/ReadingModeToggle.vue.
 */
import type { PageFeature } from '../core/types'
import { isHome } from '../core/route'
import { getLocaleKeys } from '../core/locales'
import { getFlag } from '../core/storage'

/** Floating button of an old V1 version; removed if a stale DOM still has it. */
const LEGACY_BTN_ID = 'lecture-reading-btn'

export const READING_MODE_CLASS = 'reading-mode'

/** Apply the class for `path`. Returns the resulting state. */
export function applyReadingMode(path: string): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  if (isHome(path, '/', getLocaleKeys())) {
    root.classList.remove(READING_MODE_CLASS)
    return false
  }
  // `|| has class`: same rule as the V1 toggle — keeps a choice made while storage is unavailable
  const on = getFlag('readingMode') || root.classList.contains(READING_MODE_CLASS)
  if (root.classList.contains(READING_MODE_CLASS) !== on) root.classList.toggle(READING_MODE_CLASS, on)
  return on
}

export const readingModeFeature: PageFeature = {
  id: 'reading-mode',
  mount(ctx) {
    document.getElementById(LEGACY_BTN_ID)?.remove()
    applyReadingMode(ctx.path)
  },
}
