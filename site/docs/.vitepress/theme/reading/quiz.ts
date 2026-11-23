/**
 * reading/quiz.ts — mounts `<LecSlot name="QuizHeader">` above `.vp-doc details.details.custom-block` cards (P5 WP-R1).
 *
 * CRITICAL INVARIANT (`tests/e2e/theme.spec.ts`): never insert a non-summary child inside `details.details`, so
 * `.vp-doc details.details > :not(summary)` retains the 17 px / 37.6 px prose line-height contract.
 */
import { createApp, h } from 'vue'
import type { PageContext, PageFeature } from '../core/types'
import { isLecture, parseLecture } from '../core/route'
import { getLocaleKeys } from '../core/locales'
import { currentLang, translate } from '../../i18n/index.ts'
import { LecSlot } from '../slots'
import { quizPlan } from './quizCards'

export const quizFeature: PageFeature = {
  id: 'quiz-header',
  when: isLecture,
  mount(ctx: PageContext) {
    if (typeof document === 'undefined') return
    for (const stale of Array.from(document.querySelectorAll('.vp-doc .lec-quiz-host'))) stale.remove()

    const { items, total } = quizPlan(document)
    if (items.length === 0) return

    const lec = parseLecture(ctx.path, '/', getLocaleKeys())
    const lectureNo = lec?.lectureNo ?? 0
    const lang = currentLang()
    const apps: Array<{ unmount: () => void; host: HTMLElement }> = []

    items.forEach(({ card: det, index }) => {
      const parent = det.parentNode
      if (!parent) return
      const host = document.createElement('div')
      host.className = 'lec-quiz-host'
      parent.insertBefore(host, det)

      const summaryText = det.querySelector('summary')?.textContent?.trim() ?? ''
      const badge =
        lectureNo > 0
          ? translate(lang, 'lecture.quiz.numbered', { lec: lectureNo, i: index })
          : translate(lang, 'lecture.quiz.plain', { i: index })
      const totalLabel = translate(lang, 'lecture.quiz.total', { n: total })

      const app = createApp({
        name: 'QuizHeaderHost',
        render: () =>
          h(LecSlot, {
            name: 'QuizHeader',
            index,
            total,
            lectureNo,
            badge,
            heading: summaryText,
            totalLabel,
          }),
      })
      app.mount(host)
      apps.push({ unmount: () => app.unmount(), host })
    })

    ctx.defer(() => {
      for (const item of apps) {
        try {
          item.unmount()
        } catch {
          /* ignore */
        }
        item.host.remove()
      }
    })
  },
}
