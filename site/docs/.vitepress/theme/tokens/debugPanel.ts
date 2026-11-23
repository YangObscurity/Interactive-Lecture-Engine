/**
 * theme/tokens/debugPanel.ts — `__LECTURE_DEBUG__` panel "theme" (test hook; the reader settings
 * panel UI is P6).
 *
 *   __LECTURE_DEBUG__.panel('theme')                       attrs, stored prefs, enabled themes
 *   __LECTURE_DEBUG__.run('theme', 'theme', 'reader')       switch theme (persisted)
 *   __LECTURE_DEBUG__.run('theme', 'tint', 'sepia')         tint preset; 'light' / 'dark' drive
 *                                                          VitePress' own appearance
 *   __LECTURE_DEBUG__.run('theme', 'size', 18)              16 / 17 / 18 / 20
 *   __LECTURE_DEBUG__.run('theme', 'font', 'serif')         serif / sans / null
 *   __LECTURE_DEBUG__.run('theme', 'reset')                 clear reader prefs
 */
import { registerDebugPanel } from '../debug/registry'
import { applyPrefs, readPrefs, writePrefs, type ThemeRuntime } from './prefs'

const ATTRS = ['data-lec-theme', 'data-lec-tint', 'data-lec-size', 'data-lec-font'] as const

export function registerThemeDebugPanel(rt: ThemeRuntime, setDark: (dark: boolean) => void): () => void {
  const root = (): HTMLElement => document.documentElement
  const apply = (patch: Parameters<typeof writePrefs>[0]) => applyPrefs(root(), writePrefs(patch), rt)
  return registerDebugPanel('theme', {
    describe: () => ({
      attrs: Object.fromEntries(ATTRS.map((a) => [a, typeof document === 'undefined' ? null : root().getAttribute(a)])),
      dark: typeof document === 'undefined' ? null : root().classList.contains('dark'),
      prefs: readPrefs(),
      runtime: rt,
    }),
    actions: {
      theme: (id: unknown) => apply({ theme: typeof id === 'string' ? id : undefined }),
      tint: (name: unknown) => {
        if (name === 'dark' || name === 'light') {
          setDark(name === 'dark')
          return apply({ tint: undefined })
        }
        return apply({ tint: typeof name === 'string' ? name : undefined })
      },
      size: (px: unknown) => apply({ fontSize: typeof px === 'number' ? px : undefined }),
      font: (f: unknown) => apply({ bodyFont: f === 'serif' || f === 'sans' ? f : undefined }),
      reset: () => apply({ theme: undefined, tint: undefined, fontSize: undefined, bodyFont: undefined }),
    },
  })
}
