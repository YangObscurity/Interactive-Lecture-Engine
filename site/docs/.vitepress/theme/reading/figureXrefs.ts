/**
 * Guarded entry for lecture figure cross-reference UX (`reading/figureXrefsRuntime.ts`).
 * Pages without `.lec-xref` / `.lec-fig-backlink` skip loading the runtime chunk completely.
 */
import type { PageContext, PageFeature } from '../core/types'

export const figureXrefsFeature: PageFeature = {
  id: 'figureXrefs',
  mount(ctx: PageContext) {
    if (typeof document === 'undefined') return
    const root = (document.querySelector('.vp-doc') as HTMLElement | null) ?? document.body
    if (!root.querySelector('.lec-xref, .lec-fig-backlink')) return
    void import('./figureXrefsRuntime').then(({ installFigureXrefs }) => {
      if (!ctx.signal.aborted) installFigureXrefs(root, ctx.signal)
    })
  },
}
