// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLifecycle } from '../../docs/.vitepress/theme/core/lifecycle'
import {
  groupResume,
  readingProgressFeature,
  recentReads,
  upsertEntry,
} from '../../docs/.vitepress/theme/reading/readingProgress'

const KEY = 'lecture-read-pos'
const store = () => JSON.parse(localStorage.getItem(KEY) || '{}')

function setScroll(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.innerHTML = '<div class="vp-doc"><h1>第 19 讲 · 事务​</h1></div>'
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: 10_000, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true })
  setScroll(0)
})
afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('readingProgress feature', () => {
  it('only runs on lecture pages', () => {
    expect(readingProgressFeature.when?.('/g05/L19')).toBe(true)
    expect(readingProgressFeature.when?.('/g05/')).toBe(false)
    expect(readingProgressFeature.when?.('/')).toBe(false)
  })

  it('flushes the debounced save for the OLD path when the page is left', async () => {
    const lc = createLifecycle([readingProgressFeature], [], { onError: () => {} })
    await lc.enter('/g05/L19.html')
    window.dispatchEvent(new Event('wheel'))
    setScroll(4500)
    window.dispatchEvent(new Event('scroll'))
    // navigate before the 500 ms debounce fires
    setScroll(0)
    await lc.enter('/g05/L20')
    const s = store()
    expect(Object.keys(s)).toEqual(['/g05/L19'])
    expect(s['/g05/L19']).toMatchObject({ y: 4500, pct: 0.5, title: '第 19 讲 · 事务', group: 'g05' })
    vi.advanceTimersByTime(2000)
    // nothing written for the new page (no interaction, at top)
    expect(Object.keys(store())).toEqual(['/g05/L19'])
  })

  it('does not overwrite a record with the navigation scroll-to-top', async () => {
    localStorage.setItem(KEY, JSON.stringify({ '/g05/L19': { y: 4500, pct: 0.5, title: 't', group: 'g05', ts: 1 } }))
    const lc = createLifecycle([readingProgressFeature], [], { onError: () => {} })
    await lc.enter('/g05/L19')
    // restore window: scroll events are not saved
    window.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(4100)
    window.dispatchEvent(new Event('scroll')) // scrollY = 0, no gesture → ignored
    vi.advanceTimersByTime(600)
    expect(store()['/g05/L19'].pct).toBe(0.5)
    lc.destroy()
  })

  it('restores by fraction and closes the window on lecture:charts-settled for this page', async () => {
    localStorage.setItem(KEY, JSON.stringify({ '/g05/L19': { y: 4500, pct: 0.5, title: 't', group: 'g05', ts: 1 } }))
    const scrollTo = vi.fn((_x: number, y: number) => setScroll(y))
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const lc = createLifecycle([readingProgressFeature], [], { onError: () => {} })
    await lc.enter('/g05/L19')
    expect(document.getElementById('lecture-resume-hint')).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(scrollTo).toHaveBeenLastCalledWith(0, 4500)
    // page grew while charts rendered
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 13_000, configurable: true })
    window.dispatchEvent(new CustomEvent('lecture:charts-settled', { detail: { path: '/other/L01' } }))
    expect(scrollTo).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new CustomEvent('lecture:charts-settled', { detail: { path: '/g05/L19' } }))
    expect(scrollTo).toHaveBeenLastCalledWith(0, 6000)
    // window closed: the fallback timer does nothing more
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 20_000, configurable: true })
    vi.advanceTimersByTime(5000)
    expect(scrollTo).toHaveBeenCalledTimes(2)
    lc.leave()
    expect(document.getElementById('lecture-resume-hint')).toBeNull()
    raf.mockRestore()
  })

  it('leaving removes every listener (no duplicates across visits)', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const lc = createLifecycle([readingProgressFeature], [], { onError: () => {} })
    for (let i = 0; i < 5; i++) await lc.enter(`/g05/L${19 + (i % 2)}`)
    const signals = add.mock.calls.map((c) => (c[2] as AddEventListenerOptions | undefined)?.signal)
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true)
    expect(signals.filter((s) => !s?.aborted).length).toBe(6) // 4 gestures + scroll + beforeunload
    add.mockRestore()
    lc.destroy()
  })
})

describe('store helpers (V1 format)', () => {
  it('upsert keeps the existing title and the newest 30 entries', () => {
    const s: Record<string, { y: number; pct: number; title: string; group: string; ts: number }> = {}
    for (let i = 0; i < 35; i++) upsertEntry(s, `/g01/L${i}`, { y: i, pct: 0.5, title: 'n' + i, group: 'g01', ts: i })
    expect(Object.keys(s)).toHaveLength(30)
    expect(s['/g01/L0']).toBeUndefined()
    upsertEntry(s, '/g01/L34', { y: 1, pct: 0.6, title: 'changed', group: 'g01', ts: 99 })
    expect(s['/g01/L34']?.title).toBe('n34')
  })

  it('recentReads / groupResume read the V1 key', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        '/g01/L01': { y: 1, pct: 0.5, title: 'a', group: 'g01', ts: 1 },
        '/g01/L02': { y: 1, pct: 0.4, title: 'b', group: 'g01', ts: 2 },
        '/g02/L01': { y: 1, pct: 0.99, title: 'c', group: 'g02', ts: 3 },
      })
    )
    expect(recentReads().map((e) => e.path)).toEqual(['/g01/L02', '/g01/L01'])
    expect(groupResume('G01')?.path).toBe('/g01/L02')
    expect(groupResume('g02')).toBeNull()
  })
})
