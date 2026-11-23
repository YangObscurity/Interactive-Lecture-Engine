/**
 * reading/readingProgress.ts — per-lecture scroll position memory (V1 reading-progress.ts, as a
 * PageFeature).
 *
 *   1. Every lecture remembers its scroll position (pixels + fraction); entering it again scrolls
 *      back there and shows a short hint toast.
 *   2. Data source for the home page "continue reading" list and the group page resume button.
 *
 * Storage format is unchanged from V1 — key `lecture-read-pos`,
 *   { '/g01/L01': { y, pct, title, group, ts }, … }  (at most 30 entries, oldest dropped).
 *
 * Kept V1 lessons:
 *   - VitePress scrolls to the top on SPA navigation, which fires `scroll`. Only REAL gestures
 *     (wheel / touchstart / keydown / mousedown) count as "user took over".
 *   - Lecture height grows while charts render, so restore by fraction, more than once.
 *     V2: one attempt right after the navigation scroll, one when the charts feature dispatches
 *     `lecture:charts-settled` for this page, and a 4000 ms fallback (V1's last retry) in case the
 *     event never arrives. The restore window closes after that.
 *
 * V2 lifecycle: listeners are bound per visit with `{ signal }`; a pending debounced save is
 * flushed for the OLD path when the page is left (V1 lost it, or wrote it under the new path).
 */
import type { PageFeature } from '../core/types'
import { parseLecture } from '../core/route'
import { getLocaleKeys } from '../core/locales'
import { getJson, setJson, remove } from '../core/storage'
import { CHARTS_SETTLED_EVENT, type ChartsSettledDetail } from '../core/lifecycle'
import { registerDebugPanel } from '../debug/registry'
import { currentLang, translate } from '../../i18n/index.ts'
import { hasPendingConceptReturn } from './concepts'

export type ReadEntry = {
  y: number
  pct: number
  title: string
  group: string
  ts: number
}

type Store = Record<string, ReadEntry>

const MAX_ENTRIES = 30
const SAVE_DEBOUNCE = 500
const RESTORE_FALLBACK_MS = 4000

function isStore(v: unknown): v is Store {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readStore(): Store {
  return getJson<Store>('readingProgress', {}, isStore)
}

function writeStore(s: Store) {
  setJson('readingProgress', s)
}

/** Most recently read lectures (newest first, only partially read ones). */
export function recentReads(limit = 6): Array<ReadEntry & { path: string }> {
  const s = readStore()
  return Object.keys(s)
    .map((path) => ({ path, ...(s[path] as ReadEntry) }))
    .filter((e) => e.pct > 0.02 && e.pct < 0.97)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

/**
 * The lecture of a course group that was read last — for the group page "continue" button.
 * `dir` is the directory name (g01 / g02 …). Returns null when nothing is resumable.
 */
export function groupResume(dir: string): (ReadEntry & { path: string }) | null {
  if (!dir) return null
  const prefix = '/' + dir.toLowerCase() + '/'
  const s = readStore()
  const cands = Object.keys(s)
    .filter((p) => {
      const e = s[p] as ReadEntry
      return p.toLowerCase().startsWith(prefix) && e.pct > 0.02 && e.pct < 0.97
    })
    .map((p) => ({ path: p, ...(s[p] as ReadEntry) }))
    .sort((a, b) => b.ts - a.ts)
  return cands[0] || null
}

export function clearRead(path?: string) {
  if (!path) {
    // all candidate keys (incl. legacy aliases), so nothing is "revived" later
    remove('readingProgress')
    return
  }
  const s = readStore()
  delete s[path]
  writeStore(s)
}

/** Pure store update (exported for tests): upsert + keep the newest MAX_ENTRIES. */
export function upsertEntry(s: Store, path: string, e: Omit<ReadEntry, 'title'> & { title: string }): Store {
  s[path] = { y: e.y, pct: e.pct, title: s[path]?.title || e.title, group: e.group, ts: e.ts }
  const keys = Object.keys(s)
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (s[a] as ReadEntry).ts - (s[b] as ReadEntry).ts)
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete s[k])
  }
  return s
}

function pageTitle(): string {
  const h1 = document.querySelector('.vp-doc h1')
  // drop the zero-width space of VitePress header anchors
  const t = (h1?.textContent || document.title || '').replace(/\u200b/g, '').trim()
  return t.replace(/\s*\|\s*.*$/, '')
}

function maxScroll(): number {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight)
}

// hint toast timing: fade in → short hold → fade out, whole thing < 2 s
const HINT_HOLD = 1100
const HINT_OUT = 240

/** Live per-visit bindings — debug / e2e hook for "no duplicate listeners". */
let activeBindings = 0
let lastVisit: { path: string; restored: string; settledBy: string } | null = null

if (typeof window !== 'undefined') {
  registerDebugPanel('reading-progress', {
    describe: () => ({ activeBindings, lastVisit, entries: Object.keys(readStore()).length }),
    actions: { clear: (p?: unknown) => clearRead(typeof p === 'string' ? p : undefined) },
  })
}

export const readingProgressFeature: PageFeature = {
  id: 'reading-progress',
  when: (path) => parseLecture(path, '/', getLocaleKeys()) !== null,
  mount(ctx) {
    const lecture = parseLecture(ctx.path, '/', getLocaleKeys())
    if (!lecture) return
    const path = lecture.path
    const { signal } = ctx
    const timers = new Set<number>()
    const later = (fn: () => void, ms: number) => {
      const t = window.setTimeout(() => {
        timers.delete(t)
        fn()
      }, ms)
      timers.add(t)
      return t
    }

    let pendingRestore = false
    let userTookOver = false
    let saveTimer: number | undefined
    /** Scroll snapshot taken at scroll time: on leave, the DOM already shows the next page. */
    let pending: { y: number; pct: number } | null = null
    const title = pageTitle()
    const visitInfo = { path, restored: 'none', settledBy: 'n/a' }
    lastVisit = visitInfo

    activeBindings++
    ctx.defer(() => {
      activeBindings--
    })

    const cancelRestore = () => {
      pendingRestore = false
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }

    const save = () => {
      window.clearTimeout(saveTimer)
      saveTimer = undefined
      const snap = pending
      pending = null
      if (!snap) return
      // no interaction and still near the top: the navigation's scroll-to-top, keep the old record
      if (!userTookOver && snap.y < 40) return
      writeStore(
        upsertEntry(readStore(), path, {
          y: snap.y,
          pct: snap.pct,
          title,
          group: lecture.topSegment,
          ts: Date.now(),
        })
      )
    }

    const snapshot = () => {
      const y = Math.round(window.scrollY)
      pending = { y, pct: Math.min(1, y / maxScroll()) }
    }

    // only real gestures mean "the user took over" (programmatic scrolls do not)
    const gestures: Array<keyof WindowEventMap> = ['wheel', 'touchstart', 'keydown', 'mousedown']
    for (const ev of gestures) {
      window.addEventListener(
        ev,
        () => {
          userTookOver = true
          cancelRestore()
        },
        { passive: true, signal }
      )
    }
    window.addEventListener(
      'scroll',
      () => {
        if (pendingRestore) return // restore-window scrolls (incl. navigation scroll-to-top) are not saved
        snapshot()
        window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(save, SAVE_DEBOUNCE)
      },
      { passive: true, signal }
    )
    window.addEventListener(
      'beforeunload',
      () => {
        if (!pendingRestore) snapshot()
        save()
      },
      { signal }
    )

    // leaving: flush the debounced save for THIS (old) path, drop timers and the hint
    ctx.defer(() => {
      cancelRestore()
      if (saveTimer !== undefined) save()
      document.getElementById('lecture-resume-hint')?.remove()
    })

    if (hasPendingConceptReturn(path)) return

    const e = readStore()[path]
    if (!e || e.pct <= 0.03 || e.pct >= 0.97) return

    pendingRestore = true
    const tryRestore = () => {
      if (signal.aborted || userTookOver || !pendingRestore) return
      const target = Math.round(e.pct * maxScroll())
      if (Math.abs(window.scrollY - target) > 40) window.scrollTo(0, target)
      visitInfo.restored = String(target)
    }
    const finish = (by: string) => {
      if (!pendingRestore) return
      tryRestore()
      visitInfo.settledBy = by
      cancelRestore() // restore window over; normal saving from now on
    }

    showRestoreHint(e.pct, signal, () => {
      userTookOver = true
      cancelRestore()
      window.scrollTo({ top: 0, behavior: 'smooth' })
      clearRead(path)
    })

    // after VitePress' own scroll-to-top (it runs in nextTick after the route change)
    later(tryRestore, 0)
    window.addEventListener(
      CHARTS_SETTLED_EVENT,
      (ev) => {
        const detail = (ev as CustomEvent<ChartsSettledDetail | undefined>).detail
        if (detail?.path && detail.path !== path) return
        // one frame for the last layout change
        window.requestAnimationFrame(() => finish('charts-settled'))
      },
      { signal }
    )
    later(() => finish('timeout'), RESTORE_FALLBACK_MS)
  },
}

function showRestoreHint(pct: number, signal: AbortSignal, onTop: () => void) {
  document.getElementById('lecture-resume-hint')?.remove()
  const el = document.createElement('div')
  el.id = 'lecture-resume-hint'
  const lang = currentLang()
  el.innerHTML =
    '<span>' +
    translate(lang, 'reading.resume.hint', { pct: Math.round(pct * 100) }) +
    '</span>' +
    '<button type="button" data-act="top">' + translate(lang, 'reading.resume.top') + '</button>' +
    '<button type="button" data-act="close" aria-label="' + translate(lang, 'reading.resume.close') + '">✕</button>'

  let fadeTimer: number | undefined
  let killTimer: number | undefined
  const stop = () => {
    window.clearTimeout(fadeTimer)
    window.clearTimeout(killTimer)
  }
  const dismiss = () => {
    stop()
    el.classList.remove('is-in') // back to base state = fade out
    killTimer = window.setTimeout(() => el.remove(), HINT_OUT + 60)
  }
  const schedule = () => {
    stop()
    fadeTimer = window.setTimeout(dismiss, HINT_HOLD)
  }
  signal.addEventListener('abort', stop, { once: true })

  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement | null)?.getAttribute?.('data-act')
    if (act === 'top') {
      onTop()
      dismiss()
    } else if (act === 'close') {
      dismiss()
    }
  })
  // hovering pauses the auto-dismiss so the buttons can be clicked
  el.addEventListener('mouseenter', stop)
  el.addEventListener('mouseleave', schedule)

  document.body.appendChild(el)
  window.requestAnimationFrame(() => {
    if (signal.aborted) return
    el.classList.add('is-in')
    schedule()
  })
}
