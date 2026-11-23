import { describe, expect, it, vi } from 'vitest'
import { createLifecycle } from '../../docs/.vitepress/theme/core/lifecycle'
import type { AppFeature, PageContext, PageFeature } from '../../docs/.vitepress/theme/core/types'

function deferred<T = void>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const silent = { onError: () => {} }

describe('createLifecycle', () => {
  it('normalises the path and mounts every feature', async () => {
    const seen: string[] = []
    const f: PageFeature = { id: 'a', mount: (ctx) => void seen.push(ctx.path) }
    const lc = createLifecycle([f], [], silent)
    await lc.enter('/g05/L19.html')
    expect(seen).toEqual(['/g05/L19'])
    expect(lc.state()).toMatchObject({ path: '/g05/L19', generation: 1, mounted: ['a'] })
  })

  it('aborts the signal and runs disposers LIFO on leave, isolating disposer errors', async () => {
    const order: string[] = []
    const errors: string[] = []
    let signal: AbortSignal | undefined
    const f: PageFeature = {
      id: 'a',
      mount(ctx) {
        signal = ctx.signal
        ctx.defer(() => order.push('1'))
        ctx.defer(() => {
          order.push('2')
          throw new Error('boom')
        })
        ctx.defer(() => order.push('3'))
      },
    }
    const lc = createLifecycle([f], [], { onError: (_id, e) => errors.push(String(e)) })
    await lc.enter('/a')
    expect(signal?.aborted).toBe(false)
    expect(lc.state().pendingDisposers).toBe(3)
    lc.leave()
    expect(signal?.aborted).toBe(true)
    expect(order).toEqual(['3', '2', '1'])
    expect(errors).toHaveLength(1)
    expect(lc.state().path).toBeNull()
  })

  it('entering a new page leaves the previous one first', async () => {
    const log: string[] = []
    const f: PageFeature = {
      id: 'a',
      mount(ctx) {
        log.push('mount ' + ctx.path)
        ctx.defer(() => log.push('dispose ' + ctx.path))
      },
    }
    const lc = createLifecycle([f], [], silent)
    await lc.enter('/x')
    await lc.enter('/y')
    expect(log).toEqual(['mount /x', 'dispose /x', 'mount /y'])
    expect(lc.state().generation).toBe(2)
  })

  it('isolates failing features (sync throw and rejection)', async () => {
    const errors: string[] = []
    const ok = vi.fn()
    const lc = createLifecycle(
      [
        { id: 'sync', mount: () => { throw new Error('s') } },
        { id: 'async', mount: async () => { throw new Error('a') } },
        { id: 'ok', mount: ok },
      ],
      [],
      { onError: (id) => errors.push(id) }
    )
    await expect(lc.enter('/p')).resolves.toBeUndefined()
    expect(ok).toHaveBeenCalledOnce()
    expect(errors.sort()).toEqual(['async', 'sync'])
    const st = lc.state()
    expect(st.mounted).toEqual(['ok'])
    expect(st.timings.filter((t) => t.status === 'failed').map((t) => t.id).sort()).toEqual(['async', 'sync'])
  })

  it('when-filter skips features (and a throwing when is treated as false)', async () => {
    const a = vi.fn()
    const b = vi.fn()
    const lc = createLifecycle(
      [
        { id: 'lectures', when: (p) => /\/L\d+$/.test(p), mount: a },
        { id: 'bad', when: () => { throw new Error('x') }, mount: b },
      ],
      [],
      silent
    )
    await lc.enter('/g01/')
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    await lc.enter('/g01/L01')
    expect(a).toHaveBeenCalledOnce()
    expect(lc.state().timings.find((t) => t.id === 'bad')?.status).toBe('skipped')
  })

  it('stale generation: a late async mount of the old page cannot touch the new page', async () => {
    const gate = deferred()
    const late = vi.fn()
    let oldCtx: PageContext | undefined
    const slow: PageFeature = {
      id: 'slow',
      async mount(ctx) {
        if (ctx.path !== '/old') return
        oldCtx = ctx
        await gate.promise
        if (ctx.signal.aborted) return
        late()
      },
    }
    const lc = createLifecycle([slow], [], silent)
    const first = lc.enter('/old')
    await lc.enter('/new')
    const disposer = vi.fn()
    gate.resolve()
    await first
    expect(late).not.toHaveBeenCalled()
    // a disposer registered by the stale visit runs immediately, never on the new visit
    oldCtx?.defer(disposer)
    expect(disposer).toHaveBeenCalledOnce()
    expect(lc.state()).toMatchObject({ path: '/new', generation: 2, pendingDisposers: 0 })
    expect(lc.state().mounted).toEqual(['slow'])
  })

  it('stale mount resolving after leave is recorded as stale, not mounted', async () => {
    const gate = deferred()
    const lc = createLifecycle([{ id: 'slow', mount: () => gate.promise }], [], silent)
    const p = lc.enter('/a')
    lc.leave()
    gate.resolve()
    await p
    expect(lc.state().mounted).toEqual([])
  })

  it('app features install once, with a signal aborted on destroy', async () => {
    let sig: AbortSignal | undefined
    const install = vi.fn((s: AbortSignal) => {
      sig = s
    })
    const app: AppFeature = { id: 'cites', install }
    const broken: AppFeature = { id: 'broken', install: () => { throw new Error('x') } }
    const lc = createLifecycle([], [broken, app], silent)
    await lc.enter('/a')
    await lc.enter('/b')
    await lc.enter('/c')
    expect(install).toHaveBeenCalledOnce()
    expect(lc.state().appFeatures).toEqual(['cites'])
    lc.destroy()
    expect(sig?.aborted).toBe(true)
  })
})
