/**
 * reading/cites.ts — clicks on inline citation chips (`.cite`) open the source in a new tab.
 *
 * Lecture bodies contain no links (blue underlines break reading); inline links and bare URLs
 * are compiled to `<span class="cite" data-cite="url">short name</span>`. One delegated click
 * handler for the whole app lifetime.
 */
import type { AppFeature } from '../core/types'

export const citesFeature: AppFeature = {
  id: 'cites',
  install(signal) {
    document.body.addEventListener(
      'click',
      (e) => {
        const el = (e.target as HTMLElement | null)?.closest?.('.cite') as HTMLElement | null
        if (!el) return
        const url = (el.dataset.cite || el.getAttribute('title') || '').trim()
        if (!url) return
        e.preventDefault()
        window.open(url, '_blank', 'noopener,noreferrer')
      },
      { signal }
    )
  },
}
