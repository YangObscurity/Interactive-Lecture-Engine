// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installAutoScrollbar, SCROLLBAR_ATTR, HIDE_DELAY_MS } from '../../docs/.vitepress/theme/core/scrollbar'

describe('core/scrollbar installAutoScrollbar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.documentElement.removeAttribute(SCROLLBAR_ATTR)
    document.documentElement.className = ''
    document.body.style.overflow = ''
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('activates on scroll, wheel, navigation keys and hides after idle delay', () => {
    const stop = installAutoScrollbar(window)

    window.dispatchEvent(new Event('wheel'))
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBe('on')
    vi.advanceTimersByTime(HIDE_DELAY_MS + 10)
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }))
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBe('on')
    vi.advanceTimersByTime(HIDE_DELAY_MS + 10)
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBeNull()

    // Typing Space inside an input must not toggle scrollbar state unnecessarily
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBeNull()
    input.remove()

    stop()
  })

  it('keeps scrollbar visible when pointerleave occurs over the right scrollbar gutter', () => {
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1200, configurable: true })
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true })
    Object.defineProperty(window, 'innerWidth', { value: 1208, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })

    const stop = installAutoScrollbar(window)

    const leaveOnScrollbarTrack = new Event('pointerleave')
    Object.defineProperty(leaveOnScrollbarTrack, 'clientX', { value: 1204 })
    Object.defineProperty(leaveOnScrollbarTrack, 'clientY', { value: 250 })
    document.dispatchEvent(leaveOnScrollbarTrack)
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBe('on')

    vi.advanceTimersByTime(HIDE_DELAY_MS + 100)
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBe('on')

    // Leaving window via blur hides after delay
    window.dispatchEvent(new Event('blur'))
    vi.advanceTimersByTime(HIDE_DELAY_MS + 10)
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBeNull()

    // Touch pointerleave after a tap near the right edge must not stay stuck open
    const touchLeave = new Event('pointerleave')
    Object.defineProperty(touchLeave, 'pointerType', { value: 'touch' })
    Object.defineProperty(touchLeave, 'clientX', { value: 1204 })
    Object.defineProperty(touchLeave, 'clientY', { value: 250 })
    window.dispatchEvent(new Event('scroll'))
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBe('on')
    document.dispatchEvent(touchLeave)
    vi.advanceTimersByTime(HIDE_DELAY_MS + 10)
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBeNull()

    stop()
  })

  it('wakes scrollbar and releases orphaned body overflow lock after chart-modal-open closes', async () => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true })
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true })

    const stop = installAutoScrollbar(window)
    document.documentElement.classList.add('chart-modal-open')
    await Promise.resolve()

    document.body.style.overflow = 'hidden'
    document.documentElement.classList.remove('chart-modal-open')
    await Promise.resolve()

    expect(document.body.style.overflow).toBe('')
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBe('on')

    vi.advanceTimersByTime(HIDE_DELAY_MS + 10)
    expect(document.documentElement.getAttribute(SCROLLBAR_ATTR)).toBeNull()
    stop()
  })
})
