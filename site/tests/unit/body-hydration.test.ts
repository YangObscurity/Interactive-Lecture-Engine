// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBodyHydrationForTests,
  beginBodyHydration,
  endBodyHydration,
  waitForBodyHydration,
} from '../../docs/.vitepress/theme/core/bodyHydration'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  __resetBodyHydrationForTests()
})

describe('bodyHydration coordinator', () => {
  it('resolves without warning when pending bodies end before timeout', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginBodyHydration()
    const waiting = waitForBodyHydration(200)
    endBodyHydration()
    await waiting
    expect(warn).not.toHaveBeenCalled()
  })

  it('times out with a console warning when an async body fails before mounting', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    beginBodyHydration()
    let resolved = false
    const p = waitForBodyHydration(250).then(() => {
      resolved = true
    })
    await vi.advanceTimersByTimeAsync(249)
    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(resolved).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/timed out/i)
    // Subsequent calls resolve immediately once timed out
    await waitForBodyHydration(50)
  })
})
