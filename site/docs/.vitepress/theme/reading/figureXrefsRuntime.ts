/**
 * Client-side interaction for `[](fig:id)` / `[](tab:id)` cross-references (WP-F8):
 * - Desktop hover/focus preview popover (reads embedded per-link metadata)
 * - Click smooth-scrolls to `#fig-<id>`, plays one-time highlight animation, shows floating "回到正文 / Back to text"
 * - Caption back-links (`a.lec-fig-backlink`) scroll smoothly back to the prose citation anchor
 */
import { withBase } from 'vitepress'
import type { FigureHoverPreviewPayload } from '../../figures/types.ts'
import { currentLang, translate } from '../../i18n/index.ts'

function decodeMeta(raw: string | undefined): FigureHoverPreviewPayload | null {
  if (!raw) return null
  try {
    return JSON.parse(decodeURIComponent(raw)) as FigureHoverPreviewPayload
  } catch {
    return null
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function triggerHighlight(target: HTMLElement): void {
  target.classList.remove('lec-fig--highlight')
  // Force reflow only when re-arming a freshly clicked link.
  void target.offsetWidth
  target.classList.add('lec-fig--highlight')
  const clear = () => target.classList.remove('lec-fig--highlight')
  target.addEventListener('animationend', clear, { once: true })
  window.setTimeout(clear, 1600)
}

export function installFigureXrefs(root: HTMLElement, signal: AbortSignal): void {
  if (typeof document === 'undefined' || signal.aborted) return

  let peekEl: HTMLElement | null = null
  let backBtn: HTMLButtonElement | null = null
  let savedScrollY: number | null = null
  let hidePeekTimer: number | null = null

  const removePeek = () => {
    if (hidePeekTimer !== null) {
      window.clearTimeout(hidePeekTimer)
      hidePeekTimer = null
    }
    if (peekEl) {
      peekEl.remove()
      peekEl = null
    }
  }

  const removeBackBtn = () => {
    if (backBtn) {
      backBtn.remove()
      backBtn = null
    }
    savedScrollY = null
  }

  const showPeek = (anchor: HTMLElement) => {
    if (typeof window !== 'undefined' && window.matchMedia && !window.matchMedia('(hover: hover)').matches) {
      return
    }
    const meta = decodeMeta(anchor.dataset.xrefMeta)
    if (!meta) return
    removePeek()

    const card = document.createElement('div')
    card.className = 'lec-xref-peek'
    card.setAttribute('role', 'tooltip')

    const thumbWrap = document.createElement('div')
    thumbWrap.className = 'lec-xref-peek__thumb'
    thumbWrap.style.aspectRatio = `${meta.width} / ${meta.height}`
    const img = document.createElement('img')
    img.src = withBase(meta.src)
    img.alt = meta.caption
    img.width = meta.width
    img.height = meta.height
    thumbWrap.appendChild(img)

    const body = document.createElement('div')
    body.className = 'lec-xref-peek__body'
    const titleEl = document.createElement('div')
    titleEl.className = 'lec-xref-peek__title'
    titleEl.textContent = meta.title
    const capEl = document.createElement('div')
    capEl.className = 'lec-xref-peek__cap'
    capEl.textContent = meta.caption
    const srcEl = document.createElement('div')
    srcEl.className = 'lec-xref-peek__src'
    srcEl.textContent = meta.sourceText
    body.append(titleEl, capEl, srcEl)

    card.append(thumbWrap, body)
    document.body.appendChild(card)
    peekEl = card

    const rect = anchor.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()
    const margin = 10
    const left = Math.max(margin, Math.min(window.innerWidth - cardRect.width - margin, rect.left))
    const fitsAbove = rect.top - cardRect.height - margin >= margin
    const top = fitsAbove ? rect.top - cardRect.height - 8 : Math.min(window.innerHeight - cardRect.height - margin, rect.bottom + 8)
    card.style.left = `${Math.round(left)}px`
    card.style.top = `${Math.round(top)}px`
  }

  const showBackButton = (returnY: number) => {
    removeBackBtn()
    savedScrollY = returnY
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'lec-xref-backbtn'
    btn.textContent = `↩ ${translate(currentLang(), 'lecture.fig.backToText')}`
    btn.addEventListener(
      'click',
      () => {
        const y = savedScrollY
        removeBackBtn()
        if (y !== null) {
          window.scrollTo({
            top: y,
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
          })
        }
      },
      { signal },
    )
    document.body.appendChild(btn)
    backBtn = btn
  }

  root.addEventListener(
    'mouseenter',
    (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.('.lec-xref') as HTMLElement | null
      if (!link) return
      if (hidePeekTimer !== null) {
        window.clearTimeout(hidePeekTimer)
        hidePeekTimer = null
      }
      showPeek(link)
    },
    { capture: true, signal },
  )

  root.addEventListener(
    'mouseleave',
    (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.('.lec-xref') as HTMLElement | null
      if (!link) return
      hidePeekTimer = window.setTimeout(removePeek, 90)
    },
    { capture: true, signal },
  )

  root.addEventListener(
    'focusin',
    (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.('.lec-xref') as HTMLElement | null
      if (link) showPeek(link)
    },
    { signal },
  )

  root.addEventListener(
    'focusout',
    (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.('.lec-xref') as HTMLElement | null
      if (link) removePeek()
    },
    { signal },
  )

  root.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement | null
      if (!target) return

      const xref = target.closest('.lec-xref') as HTMLAnchorElement | null
      if (xref) {
        const figId = xref.dataset.xrefId
        const dest = figId ? document.getElementById(`fig-${figId}`) : null
        if (!dest) return
        e.preventDefault()
        removePeek()
        const originY = window.scrollY
        dest.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })
        triggerHighlight(dest)
        showBackButton(originY)
        return
      }

      const backlink = target.closest('.lec-fig-backlink') as HTMLAnchorElement | null
      if (backlink) {
        const aid = backlink.dataset.backlinkTarget
        const dest = aid ? document.getElementById(aid) : null
        if (!dest) return
        e.preventDefault()
        removeBackBtn()
        dest.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' })
        triggerHighlight(dest)
      }
    },
    { signal },
  )

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        removePeek()
        removeBackBtn()
      }
    },
    { signal },
  )

  signal.addEventListener(
    'abort',
    () => {
      removePeek()
      removeBackBtn()
    },
    { once: true },
  )
}
