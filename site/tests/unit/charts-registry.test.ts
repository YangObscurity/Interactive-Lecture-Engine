import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChartRegistry, __resetLiveCountsForTests, liveCounts } from '../../docs/.vitepress/theme/charts/registry'

describe('charts/registry', () => {
  beforeEach(() => {
    __resetLiveCountsForTests()
    vi.restoreAllMocks()
  })

  it('disposes LIFO and tracks live counts by kind', () => {
    const r = new ChartRegistry()
    const order: string[] = []
    r.add('echarts', () => order.push('a'))
    r.add('mermaid', () => order.push('b'))
    r.add('echarts', () => order.push('c'))
    expect(r.size).toBe(3)
    expect(r.counts()).toEqual({ echarts: 2, mermaid: 1 })
    expect(liveCounts()).toEqual({ echarts: 2, mermaid: 1 })
    r.disposeAll()
    expect(order).toEqual(['c', 'b', 'a'])
    expect(r.size).toBe(0)
    expect(liveCounts()).toEqual({})
  })

  it('isolates errors per disposer', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = new ChartRegistry()
    const ran: number[] = []
    r.add('x', () => ran.push(1))
    r.add('x', () => {
      throw new Error('boom')
    })
    r.add('x', () => ran.push(3))
    const errors = r.disposeAll()
    expect(ran).toEqual([3, 1])
    expect(errors).toHaveLength(1)
    expect(err).toHaveBeenCalled()
    expect(liveCounts()).toEqual({})
  })

  it('release() disposes one handle once; disposeAll does not run it again', () => {
    const r = new ChartRegistry()
    const fn = vi.fn()
    const release = r.add('mermaid', fn)
    release()
    release()
    r.disposeAll()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(liveCounts()).toEqual({})
  })

  it('a disposer registered after close() runs immediately and is never counted', () => {
    const r = new ChartRegistry()
    r.close()
    const fn = vi.fn()
    r.add('echarts', fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(r.size).toBe(0)
    expect(liveCounts()).toEqual({})
  })

  it('disposeAll keeps the registry usable, close() does not', () => {
    const r = new ChartRegistry()
    r.add('a', () => {})
    r.disposeAll()
    r.add('a', () => {})
    expect(r.size).toBe(1)
    r.close()
    expect(r.closed).toBe(true)
    expect(liveCounts()).toEqual({})
  })
})
