/**
 * reading/mathCopy.ts — click a rendered formula (`span.math-node[data-tex]`, emitted by
 * math.mts) to copy its LaTeX source. Clipboard API with a hidden-textarea fallback, plus a
 * small toast. One delegated click handler for the whole app lifetime.
 */
import type { AppFeature } from '../core/types'
import { currentLang, translate } from '../../i18n/index.ts'

const TOAST_MS = 1400
const COPIED_MS = 600

export const mathCopyFeature: AppFeature = {
  id: 'math-copy',
  install(signal) {
    let tip: HTMLDivElement | null = null
    let timer = 0
    const toast = (msg: string) => {
      if (!tip) {
        tip = document.createElement('div')
        tip.className = 'math-copy-toast'
        document.body.appendChild(tip)
      }
      tip.textContent = msg
      tip.classList.add('show')
      window.clearTimeout(timer)
      timer = window.setTimeout(() => tip?.classList.remove('show'), TOAST_MS)
    }
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        tip?.remove()
        tip = null
      },
      { once: true }
    )

    document.body.addEventListener(
      'click',
      async (e) => {
        const el = (e.target as HTMLElement | null)?.closest?.('.math-node') as HTMLElement | null
        if (!el) return
        const tex = (el.dataset.tex || '').trim()
        if (!tex) return
        e.preventDefault()
        try {
          await navigator.clipboard.writeText(tex)
        } catch {
          // fallback: insecure context / permission denied
          const ta = document.createElement('textarea')
          ta.value = tex
          ta.style.position = 'fixed'
          ta.style.opacity = '0'
          document.body.appendChild(ta)
          ta.select()
          try {
            document.execCommand('copy')
          } catch {
            /* ignore */
          }
          document.body.removeChild(ta)
        }
        el.classList.add('copied')
        window.setTimeout(() => el.classList.remove('copied'), COPIED_MS)
        toast(translate(currentLang(), 'reading.math.copied'))
      },
      { signal }
    )
  },
}
