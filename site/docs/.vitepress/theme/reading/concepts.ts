/**
 * reading/concepts.ts - On-demand hover preview & exact-position round-trip return for Concept Pages.
 *
 * Design (§5.2.5 - §5.2.6):
 *   1. Hover summaries are NEVER bundled into JS chunks and NEVER fetched until the first hover/focus on `.lec-term`.
 *   2. Respects access tiers: loads public `/concepts-hover.json` plus any readable `/_access/<tier>/concepts-hover.json`.
 *   3. The card (`role="tooltip"`) opens on hover / focus of the word; the pointer can move onto it to use its "打开概念页 →"
 *      link (same target as the word, out of the Tab order: keyboard users press Enter on the word). Spec board 11.1.
 *   4. Round-trip return: records exact `window.scrollY` in capture phase before leaving a lecture, uses `history.back()`
 *      when the previous entry is that lecture, and restores exact `scrollY` (<= 2 px) in one post-layout pass.
 */
import type { PageFeature } from '../core/types'
import { CHARTS_SETTLED_EVENT, type ChartsSettledDetail } from '../core/lifecycle'
import { normalisePath } from '../core/route'
import { getAccess, lectureAccessOf } from '../access/store'
import { tierBasePath } from '../../access/tiers'
import { currentLang, translate } from '../../i18n/index.ts'
import type { ConceptHoverEntry, ConceptHoverPayload } from '../../concepts/frontmatter'

export const CONCEPT_RETURN_STORAGE_KEY = 'lec:concept-return'

export interface ConceptReturnState {
  fromPath: string
  fromTitle: string
  conceptPath: string
  scrollY: number
  ts: number
  restoring: boolean
}

interface HoverRuntimeOptions {
  base: string
  siteData: () => unknown
}

let runtimeOpts: HoverRuntimeOptions = { base: '/', siteData: () => ({}) }
let hoverCache: Record<string, ConceptHoverEntry> | null = null
let hoverPromise: Promise<Record<string, ConceptHoverEntry>> | null = null
let lastVisitedPath: string | null = null
let currentActivePath: string | null = null

export function configureConceptsRuntime(opts: HoverRuntimeOptions): void {
  runtimeOpts = opts
}

export function resetConceptRuntimeForTest(): void {
  hoverCache = null
  hoverPromise = null
  lastVisitedPath = null
  currentActivePath = null
}

function isConceptUrlPath(p: string): boolean {
  const norm = normalisePath(p)
  return (
    norm.startsWith('/concepts/') ||
    /^\/[a-z]{2}(?:-[a-z]{2})?\/concepts\//i.test(norm) ||
    /^\/_access\/[^/]+\/concepts\//i.test(norm)
  )
}

function readReturnState(): ConceptReturnState | null {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(CONCEPT_RETURN_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ConceptReturnState>
    if (
      !parsed ||
      typeof parsed.fromPath !== 'string' ||
      typeof parsed.conceptPath !== 'string' ||
      typeof parsed.scrollY !== 'number'
    ) {
      return null
    }
    return {
      fromPath: normalisePath(parsed.fromPath),
      fromTitle: typeof parsed.fromTitle === 'string' ? parsed.fromTitle : '',
      conceptPath: normalisePath(parsed.conceptPath),
      scrollY: parsed.scrollY,
      ts: typeof parsed.ts === 'number' ? parsed.ts : Date.now(),
      restoring: parsed.restoring === true,
    }
  } catch {
    return null
  }
}

function writeReturnState(state: ConceptReturnState | null): void {
  if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') return
  try {
    if (!state) sessionStorage.removeItem(CONCEPT_RETURN_STORAGE_KEY)
    else sessionStorage.setItem(CONCEPT_RETURN_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore storage errors
  }
}

export function getActiveConceptReturn(conceptPath?: string): ConceptReturnState | null {
  const st = readReturnState()
  if (!st || st.restoring) return null
  if (conceptPath) {
    const cleanTarget = normalisePath(conceptPath.split('#', 1)[0] ?? conceptPath)
    if (st.conceptPath !== cleanTarget && !cleanTarget.endsWith(`/_drafts/${st.conceptPath.split('/').pop() ?? ''}`)) {
      return null
    }
  }
  return st
}

export function consumePendingConceptReturn(routePath: string): { scrollY: number; fromPath: string } | null {
  const st = readReturnState()
  if (!st || !st.restoring) return null
  const current = normalisePath(routePath)
  if (current !== st.fromPath) return null
  return { scrollY: st.scrollY, fromPath: st.fromPath }
}

export function hasPendingConceptReturn(routePath: string): boolean {
  const st = readReturnState()
  if (!st || !st.restoring) return false
  return normalisePath(routePath) === st.fromPath
}

export function returnToSourceLecture(navigate: (href: string) => void | Promise<void>, fallbackHref?: string): void {
  const st = readReturnState()
  const target = st?.fromPath || (fallbackHref ? normalisePath(fallbackHref) : '/')
  if (st) {
    writeReturnState({ ...st, restoring: true })
  }
  const canHistoryBack =
    typeof window !== 'undefined' &&
    st !== null &&
    lastVisitedPath === st.fromPath &&
    window.history.length > 1

  if (canHistoryBack) {
    window.history.back()
    return
  }
  void navigate(target)
}

function withBaseUrl(relPath: string): string {
  const base = (runtimeOpts.base || '/').replace(/\/$/, '')
  const clean = relPath.startsWith('/') ? relPath : `/${relPath}`
  return `${base}${clean}`
}

async function fetchJsonSafe(url: string, credentials: RequestCredentials = 'same-origin'): Promise<ConceptHoverPayload | null> {
  try {
    const res = await fetch(url, { credentials, redirect: 'manual' })
    if (res.status !== 200) return null
    const json = (await res.json()) as Partial<ConceptHoverPayload> | null
    if (!json || typeof json !== 'object' || !json.items || typeof json.items !== 'object') return null
    return { v: 1, tier: String(json.tier ?? 'public'), items: json.items }
  } catch {
    return null
  }
}

export async function ensureHoverSummariesLoaded(): Promise<Record<string, ConceptHoverEntry>> {
  if (hoverCache) return hoverCache
  if (hoverPromise) return hoverPromise

  hoverPromise = (async () => {
    const merged: Record<string, ConceptHoverEntry> = {}

    if (import.meta.env.DEV) {
      const devBase = ['/__lecture', '/api'].join('')
      const devPayload = await fetchJsonSafe(`${devBase}/concepts/hover`, 'same-origin')
      if (devPayload) {
        Object.assign(merged, devPayload.items)
        hoverCache = merged
        return merged
      }
    }

    const pubPayload = await fetchJsonSafe(withBaseUrl('/concepts-hover.json'), 'omit')
    if (pubPayload) Object.assign(merged, pubPayload.items)

    const accessCfg = lectureAccessOf(runtimeOpts.siteData())
    if (accessCfg && accessCfg.tiers.length > 0) {
      const access = await getAccess().catch(() => null)
      const tierResults = await Promise.all(
        (access?.tiers ?? []).map((t) => fetchJsonSafe(withBaseUrl(`${tierBasePath(t.id)}/concepts-hover.json`), 'same-origin')),
      )
      for (const payload of tierResults) {
        if (payload) Object.assign(merged, payload.items)
      }
    }

    hoverCache = merged
    return merged
  })()

  try {
    return await hoverPromise
  } catch {
    hoverPromise = null
    return {}
  }
}

function positionTooltipCard(card: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const margin = 10
  card.style.left = '0px'
  card.style.top = '0px'
  card.style.visibility = 'hidden'
  card.hidden = false

  const cw = card.offsetWidth || 320
  const ch = card.offsetHeight || 120

  let left = rect.left + rect.width / 2 - cw / 2
  left = Math.max(margin, Math.min(window.innerWidth - cw - margin, left))

  let top = rect.bottom + 8
  if (top + ch > window.innerHeight - margin && rect.top - ch - 8 >= margin) {
    top = rect.top - ch - 8
  }

  card.style.left = `${Math.round(left)}px`
  card.style.top = `${Math.round(top)}px`
  card.style.visibility = 'visible'
}

function restoreScrollOnce(targetY: number, path: string, signal: AbortSignal): void {
  const applyScroll = () => {
    if (signal.aborted) return
    window.scrollTo({ top: targetY, behavior: 'instant' as ScrollBehavior })
    writeReturnState(null)
  }

  const hasCharts = Boolean(document.querySelector('.vp-doc figure.chart'))
  if (!hasCharts) {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(applyScroll)
    })
    return
  }

  let done = false
  const finish = () => {
    if (done || signal.aborted) return
    done = true
    window.clearTimeout(fallbackTimer)
    window.requestAnimationFrame(applyScroll)
  }

  window.addEventListener(
    CHARTS_SETTLED_EVENT,
    (ev) => {
      const detail = (ev as CustomEvent<ChartsSettledDetail | undefined>).detail
      if (detail?.path && normalisePath(detail.path) !== path) return
      finish()
    },
    { signal, once: true },
  )
  const fallbackTimer = window.setTimeout(finish, 1500)
  signal.addEventListener('abort', () => {
    window.clearTimeout(fallbackTimer)
  }, { once: true })
}

export const conceptsFeature: PageFeature = {
  id: 'concepts',
  when: () => true,
  mount(ctx) {
    const path = ctx.path
    if (currentActivePath && currentActivePath !== path) {
      lastVisitedPath = currentActivePath
    }
    currentActivePath = path

    const { signal } = ctx

    // If user returns from concept page using browser Back, mark restoring cleanly; clear stale state on other pages.
    if (!isConceptUrlPath(path)) {
      const st = readReturnState()
      if (st) {
        if (st.restoring && st.fromPath !== path) {
          writeReturnState(null)
        } else if (!st.restoring) {
          if (st.fromPath === path && lastVisitedPath && isConceptUrlPath(lastVisitedPath)) {
            writeReturnState({ ...st, restoring: true })
          } else {
            writeReturnState(null)
          }
        }
      }
    }

    // 1. Check exact scroll-position restoration when returning to source lecture
    const pendingReturn = consumePendingConceptReturn(path)
    if (pendingReturn) {
      restoreScrollOnce(pendingReturn.scrollY, path, signal)
    }

    // 2. Capture exact scrollY when clicking any `.lec-term` link.
    // Note: VitePress router's own `window` capture listener calls `e.preventDefault()` before `document` capture
    // runs, so we must NOT bail on `e.defaultPrevented` here (check modifier keys & target instead).
    document.addEventListener(
      'click',
      (e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        const anchor = (e.target as HTMLElement | null)?.closest?.('a.lec-term, a.lec-tcard-open') as HTMLAnchorElement | null
        if (!anchor) return
        if (anchor.target && anchor.target !== '_self') return
        if (anchor.hasAttribute('download')) return
        const rawHref = anchor.getAttribute('href') || ''
        if (!rawHref) return
        const targetUrl = rawHref.startsWith('http') ? new URL(rawHref).pathname : rawHref
        const h1Text = document.querySelector('.vp-doc h1, .lec-title-block h1')?.textContent?.trim() || document.title || ''
        writeReturnState({
          fromPath: path,
          fromTitle: h1Text,
          conceptPath: normalisePath(targetUrl.split('#', 1)[0] ?? targetUrl),
          scrollY: Math.round(window.scrollY),
          ts: Date.now(),
          restoring: false,
        })
      },
      { capture: true, signal },
    )

    // 3. Lazy hover / focus preview card (loaded ONLY on first hover or focus of `.lec-term`)
    let cardEl: HTMLElement | null = null
    let activeAnchor: HTMLElement | null = null
    let hoverToken = 0

    let hideTimer = 0

    const cancelHide = () => {
      if (hideTimer) {
        window.clearTimeout(hideTimer)
        hideTimer = 0
      }
    }

    const hideCard = () => {
      cancelHide()
      hoverToken++
      activeAnchor = null
      if (cardEl) cardEl.hidden = true
    }

    // leaving the word or the card hides it after a short pause, so the pointer can cross the gap onto the card's link
    const scheduleHide = () => {
      cancelHide()
      hideTimer = window.setTimeout(() => {
        hideTimer = 0
        hideCard()
      }, 220)
    }

    const inCard = (el: Node | null | undefined): boolean => Boolean(el && cardEl && cardEl.contains(el))

    const ensureCard = (): HTMLElement => {
      if (cardEl) return cardEl
      cardEl = document.createElement('div')
      cardEl.className = 'lec-tcard'
      cardEl.setAttribute('role', 'tooltip')
      cardEl.hidden = true
      document.body.appendChild(cardEl)
      return cardEl
    }

    // spec board 11.1 `.tcard`: term with its English name, the summary, and "打开概念页 →" (S6Y audit-spec #5)
    const renderEntry = (card: HTMLElement, entry: ConceptHoverEntry, href: string): void => {
      card.textContent = ''
      const lang = currentLang()

      const head = document.createElement('div')
      head.className = 'lec-tcard-head'
      const termEl = document.createElement('strong')
      termEl.className = 'lec-tcard-term'
      termEl.textContent = entry.term
      head.appendChild(termEl)
      if (entry.english) {
        const enEl = document.createElement('span')
        enEl.className = 'lec-tcard-en'
        enEl.textContent = entry.english
        head.appendChild(enEl)
      }
      card.appendChild(head)

      const summary = document.createElement('p')
      summary.className = 'lec-tcard-summary'
      summary.textContent = entry.summary || translate(lang, 'concepts.noSummary')
      card.appendChild(summary)

      // the same target as the word itself; out of the Tab order (keyboard users press Enter on the word)
      const open = document.createElement('a')
      open.className = 'lec-tcard-open'
      open.href = href
      open.tabIndex = -1
      open.textContent = translate(lang, 'concepts.openPage')
      card.appendChild(open)
    }

    const showForAnchor = (anchor: HTMLElement) => {
      const slug = anchor.dataset.concept?.trim()
      if (!slug) return
      activeAnchor = anchor
      const token = ++hoverToken
      void ensureHoverSummariesLoaded().then((items) => {
        if (signal.aborted || token !== hoverToken || activeAnchor !== anchor) return
        const entry = items[slug]
        if (!entry) return
        const card = ensureCard()
        renderEntry(card, entry, anchor.getAttribute('href') || '')
        positionTooltipCard(card, anchor)
      })
    }

    document.addEventListener(
      'mouseover',
      (e) => {
        const target = e.target as HTMLElement | null
        if (inCard(target)) {
          cancelHide()
          return
        }
        const anchor = target?.closest?.('a.lec-term') as HTMLElement | null
        if (!anchor) return
        cancelHide()
        if (anchor === activeAnchor) return
        showForAnchor(anchor)
      },
      { signal },
    )

    document.addEventListener(
      'mouseout',
      (e) => {
        if (!activeAnchor) return
        const related = e.relatedTarget as HTMLElement | null
        if (related && (activeAnchor.contains(related) || inCard(related))) return
        const from = e.target as HTMLElement | null
        if (from?.closest?.('a.lec-term') === activeAnchor || inCard(from)) scheduleHide()
      },
      { signal },
    )

    document.addEventListener(
      'focusin',
      (e) => {
        const anchor = (e.target as HTMLElement | null)?.closest?.('a.lec-term') as HTMLElement | null
        if (anchor) {
          cancelHide()
          showForAnchor(anchor)
        }
      },
      { signal },
    )

    document.addEventListener(
      'focusout',
      (e) => {
        if (!activeAnchor) return
        const related = e.relatedTarget as HTMLElement | null
        if (related && (activeAnchor.contains(related) || inCard(related))) return
        if (inCard(e.target as Node | null) || (e.target as HTMLElement | null)?.closest?.('a.lec-term') === activeAnchor) {
          // a pointer still over the word or the card keeps it (e.g. clicking the card's link moves focus)
          try {
            if (activeAnchor.matches(':hover') || cardEl?.matches(':hover')) return
          } catch {
            // ignore selector errors
          }
        }
        hideCard()
      },
      { signal },
    )

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && activeAnchor) hideCard()
      },
      { signal },
    )

    window.addEventListener(
      'scroll',
      () => {
        if (!activeAnchor) return
        if (!cardEl || cardEl.hidden) {
          try {
            if (activeAnchor.matches(':hover') || document.activeElement === activeAnchor) return
          } catch {
            // ignore selector errors
          }
        }
        hideCard()
      },
      { passive: true, signal },
    )

    ctx.defer(() => {
      cancelHide()
      hoverToken++
      if (cardEl) {
        cardEl.remove()
        cardEl = null
      }
    })
  },
}
