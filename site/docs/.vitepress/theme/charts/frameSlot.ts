/**
 * charts/frameSlot.ts — mounts `<LecSlot name="FigureFrame">` chrome inside `figure.chart` without disturbing
 * `.chart-body` (so switching themes at runtime keeps live ECharts / SVG charts intact).
 */
import { computed, createApp, h, type App } from 'vue'
import { currentLang, translate } from '../../i18n/index.ts'
import { LecSlot } from '../slots'
import { chartTagLabel } from './dom'
import { chartButtons } from './toolbar'

export interface FigureFrameMeta {
  type: string
  index: number
  lectureNo: number
  title: string
  caption: string
}

const mountedFrames = new WeakMap<HTMLElement, { app: App<Element>; host: HTMLElement }>()

export function mountFigureFrame(fig: HTMLElement, meta: FigureFrameMeta, signal: AbortSignal): void {
  if (signal.aborted || typeof document === 'undefined') return

  const prev = mountedFrames.get(fig)
  if (prev) {
    try {
      prev.app.unmount()
    } catch {
      /* ignore */
    }
    prev.host.remove()
    mountedFrames.delete(fig)
  }

  for (const stale of Array.from(fig.querySelectorAll(':scope > .lec-ff-host, :scope > figcaption.chart-cap'))) {
    stale.remove()
  }

  const host = document.createElement('div')
  host.className = 'lec-ff-host'
  fig.appendChild(host)

  const app = createApp({
    name: 'FigureFrameHost',
    setup() {
      const frameProps = computed(() => {
        const lang = currentLang()
        const tagLabel = chartTagLabel(meta.type) || meta.type
        const figureLabel =
          meta.lectureNo > 0
            ? translate(lang, 'lecture.fig.numbered', { lec: meta.lectureNo, i: meta.index })
            : translate(lang, 'lecture.fig.plain', { i: meta.index })
        return {
          type: meta.type,
          tagLabel,
          figureLabel,
          title: meta.title,
          caption: meta.caption,
          buttons: chartButtons(meta.type),
        }
      })
      return () => h(LecSlot, { name: 'FigureFrame', ...frameProps.value })
    },
  })

  app.mount(host)
  mountedFrames.set(fig, { app, host })

  signal.addEventListener(
    'abort',
    () => {
      const rec = mountedFrames.get(fig)
      if (!rec || rec.app !== app) return
      try {
        rec.app.unmount()
      } catch {
        /* ignore */
      }
      rec.host.remove()
      mountedFrames.delete(fig)
    },
    { once: true },
  )
}
