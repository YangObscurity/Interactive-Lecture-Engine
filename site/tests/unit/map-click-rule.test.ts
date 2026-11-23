import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLICK_DELAY_MS, createClickRule } from '../../docs/.vitepress/theme/map/clickRule'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('click rule: a single click acts after the double-click window, a double click cancels it', () => {
  it('waits about 0.26 s', () => expect(CLICK_DELAY_MS).toBe(260))

  it('runs a single click only after the delay', () => {
    const rule = createClickRule()
    const single = vi.fn()
    rule.click(single)
    expect(rule.pending()).toBe(true)
    vi.advanceTimersByTime(CLICK_DELAY_MS - 1)
    expect(single).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(single).toHaveBeenCalledTimes(1)
    expect(rule.pending()).toBe(false)
  })

  it('a double click runs at once and the single click never happens', () => {
    const rule = createClickRule()
    const single = vi.fn()
    const double = vi.fn()
    rule.click(single)
    vi.advanceTimersByTime(100)
    rule.dblclick(double)
    expect(double).toHaveBeenCalledTimes(1)
    expect(rule.pending()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(single).not.toHaveBeenCalled()
  })

  it('the browser order click, click, dblclick gives exactly one double and no single', () => {
    const rule = createClickRule()
    const single = vi.fn()
    const double = vi.fn()
    rule.click(single)
    vi.advanceTimersByTime(80)
    rule.click(single) // the second click of the pair replaces the first
    rule.dblclick(double)
    vi.advanceTimersByTime(2000)
    expect(single).not.toHaveBeenCalled()
    expect(double).toHaveBeenCalledTimes(1)
  })

  it('two slow clicks are two single clicks', () => {
    const rule = createClickRule()
    const single = vi.fn()
    rule.click(single)
    vi.advanceTimersByTime(CLICK_DELAY_MS + 10)
    rule.click(single)
    vi.advanceTimersByTime(CLICK_DELAY_MS + 10)
    expect(single).toHaveBeenCalledTimes(2)
  })

  it('a newer click replaces the pending one (the later action wins, once)', () => {
    const rule = createClickRule()
    const a = vi.fn()
    const b = vi.fn()
    rule.click(a)
    vi.advanceTimersByTime(100)
    rule.click(b)
    vi.advanceTimersByTime(CLICK_DELAY_MS - 1)
    expect(b).not.toHaveBeenCalled() // the window restarted at the second click
    vi.advanceTimersByTime(1)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('cancel drops the pending single click; a double click with nothing pending just runs', () => {
    const rule = createClickRule()
    const single = vi.fn()
    const double = vi.fn()
    rule.click(single)
    rule.cancel()
    vi.advanceTimersByTime(1000)
    expect(single).not.toHaveBeenCalled()
    rule.dblclick(double)
    expect(double).toHaveBeenCalledTimes(1)
  })

  it('takes a delay and timer functions of its own', () => {
    const timers: Array<{ fn: () => void; ms: number; id: number }> = []
    let next = 1
    const rule = createClickRule({
      delay: 50,
      setTimer: (fn, ms) => {
        const id = next++
        timers.push({ fn, ms, id })
        return id
      },
      clearTimer: (h) => {
        const i = timers.findIndex((t) => t.id === h)
        if (i >= 0) timers.splice(i, 1)
      },
    })
    const single = vi.fn()
    rule.click(single)
    expect(timers).toHaveLength(1)
    expect(timers[0]?.ms).toBe(50)
    rule.click(single)
    expect(timers).toHaveLength(1) // the first timer was cleared
    timers[0]?.fn()
    expect(single).toHaveBeenCalledTimes(1)
  })
})
