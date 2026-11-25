// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHARTS_SETTLED_EVENT, PageCharts, __resetPageStateForTests } from '../../docs/.vitepress/theme/charts/page'
import type { ChartsDeps, ChartsSettledDetail } from '../../docs/.vitepress/theme/charts/page'
import { __resetLiveCountsForTests, liveCounts } from '../../docs/.vitepress/theme/charts/registry'
import type { Renderer } from '../../docs/.vitepress/theme/charts/renderers/types'
import type { SidecarData } from '../../docs/.vitepress/theme/charts/sidecar'
import { waitForChartFonts } from '../../docs/.vitepress/theme/charts/fonts'

const SIDECAR: SidecarData = {
  c1: { type: 'echarts', code: '{}' },
  c2: { type: 'mermaid', code: 'graph TD; A-->B' },
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** Fake renderer: draws a marker, returns a counted disposer. Optional gate to hold it mid-render. */
function fakeRenderer(kind: string, log: string[], gate?: Promise<void>): Renderer {
  return async (fig, _code, env) => {
    if (gate) await gate
    if (env.signal.aborted) return null
    const body = fig.querySelector('.chart-body') as HTMLElement
    body.innerHTML = `<svg data-kind="${kind}"></svg>`
    log.push(`render:${kind}:${fig.dataset.id}`)
    return () => log.push(`dispose:${kind}:${fig.dataset.id}`)
  }
}

function makeDeps(log: string[], over: Partial<ChartsDeps> = {}): ChartsDeps {
  return {
    loadSidecar: async () => SIDECAR,
    waitFonts: async () => 'loaded',
    renderers: { echarts: fakeRenderer('echarts', log), mermaid: fakeRenderer('mermaid', log) },
    ...over,
  }
}

const PAGE = `
  <figure class="chart" data-lecture="G01-L01" data-id="c1"></figure>
  <figure class="chart" data-lecture="G01-L01" data-id="c2"></figure>
  <div class="language-mermaid"><pre><code><span class="line">graph TD; X--&gt;Y</span></code></pre></div>`

describe('charts/page lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML = PAGE
    __resetPageStateForTests()
    __resetLiveCountsForTests()
    delete window.__CHARTS_DONE__
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders every figure, sets status ok, __CHARTS_DONE__ and dispatches settled', async () => {
    const log: string[] = []
    const ctl = new AbortController()
    const events: ChartsSettledDetail[] = []
    const onSettle = (e: Event) => events.push((e as CustomEvent<ChartsSettledDetail>).detail)
    window.addEventListener(CHARTS_SETTLED_EVENT, onSettle)
    const page = new PageCharts('/g01/L01', ctl.signal, makeDeps(log))
    const done = page.run()
    // claimed synchronously, before any await
    expect(document.querySelectorAll('figure.chart:not([data-rendered])')).toHaveLength(0)
    expect(document.querySelector('figure.inline-mermaid')).not.toBeNull()
    expect(window.__CHARTS_DONE__).toBe(false)
    await done
    window.removeEventListener(CHARTS_SETTLED_EVENT, onSettle)

    const figs = [...document.querySelectorAll<HTMLElement>('figure.chart')]
    expect(figs).toHaveLength(3)
    for (const f of figs) {
      expect(f.dataset.chartStatus).toBe('ok')
      expect(f.querySelector('.chart-body svg')).not.toBeNull()
      expect(f.querySelector('button.chart-enlarge[data-act="expand"]')).not.toBeNull()
      expect(f.querySelector('.chart-tools, .chart-tag')).toBeNull()
    }
    const inline = document.querySelector<HTMLElement>('figure.inline-mermaid')!
    expect(inline.hasAttribute('data-lecture')).toBe(false)
    expect(inline.dataset.source).toBe('inline-mermaid')
    expect(inline.querySelector('details.chart-code')).not.toBeNull()
    expect(document.querySelector<HTMLElement>('div.language-mermaid')!.style.display).toBe('none')
    expect(window.__CHARTS_DONE__).toBe(true)
    expect(events).toEqual([expect.objectContaining({ path: '/g01/L01', count: 3 })])
    expect(liveCounts()).toMatchObject({ echarts: 1, mermaid: 2 })

    page.destroy()
    expect(liveCounts().echarts ?? 0).toBe(0)
    expect(liveCounts().mermaid ?? 0).toBe(0)
    expect(log.filter((l) => l.startsWith('dispose'))).toHaveLength(3)
  })

  it('a page without charts settles immediately with __CHARTS_DONE__ = true', async () => {
    document.body.innerHTML = '<p>no charts</p>'
    const page = new PageCharts('/', new AbortController().signal, makeDeps([]))
    await page.run()
    expect(window.__CHARTS_DONE__).toBe(true)
  })

  it('leaving mid-render never blocks the next page and leaks nothing', async () => {
    const log: string[] = []
    const gate = deferred<void>()
    const ctl1 = new AbortController()
    const slow = makeDeps(log, {
      renderers: {
        echarts: fakeRenderer('echarts', log, gate.promise),
        mermaid: fakeRenderer('mermaid', log, gate.promise),
      },
    })
    const page1 = new PageCharts('/a', ctl1.signal, slow)
    const run1 = page1.run()
    expect(window.__CHARTS_DONE__).toBe(false)

    // SPA navigation: old ctx aborted + disposed, new DOM, new mount — while page1 is still in flight
    ctl1.abort()
    page1.destroy()
    document.body.innerHTML = PAGE.replace(/G01-L01/g, 'G01-L02')
    const ctl2 = new AbortController()
    const page2 = new PageCharts('/b', ctl2.signal, makeDeps(log))
    await page2.run()
    expect(window.__CHARTS_DONE__).toBe(true)
    for (const f of document.querySelectorAll<HTMLElement>('figure.chart')) expect(f.dataset.chartStatus).toBe('ok')

    // the stale run wakes up afterwards: it must not render, register, or flip the flag
    gate.resolve()
    await run1
    expect(window.__CHARTS_DONE__).toBe(true)
    expect(liveCounts()).toMatchObject({ echarts: 1, mermaid: 2 })
    page2.destroy()
    expect(liveCounts().echarts ?? 0).toBe(0)
  })

  it('a render that resolves after abort is disposed immediately (late instance)', async () => {
    const log: string[] = []
    const gate = deferred<void>()
    const ctl = new AbortController()
    // renderer ignores the signal and creates an instance anyway
    const stubborn: Renderer = async (fig) => {
      await gate.promise
      log.push('created')
      return () => log.push(`disposed:${fig.dataset.id}`)
    }
    const page = new PageCharts('/a', ctl.signal, makeDeps(log, { renderers: { echarts: stubborn, mermaid: stubborn } }))
    const run = page.run()
    await Promise.resolve()
    ctl.abort()
    page.destroy()
    gate.resolve()
    await run
    const created = log.filter((l) => l === 'created').length
    const disposed = log.filter((l) => l.startsWith('disposed')).length
    expect(created).toBe(disposed)
    expect(liveCounts()).toEqual({})
  })

  it('re-entry on the same DOM re-renders stale figures (no double inline figure)', async () => {
    const log: string[] = []
    const ctl1 = new AbortController()
    const page1 = new PageCharts('/a', ctl1.signal, makeDeps(log))
    await page1.run()
    ctl1.abort()
    page1.destroy()

    const page2 = new PageCharts('/a', new AbortController().signal, makeDeps(log))
    await page2.run()
    expect(document.querySelectorAll('figure.inline-mermaid')).toHaveLength(1)
    expect(document.querySelectorAll('figure.chart')).toHaveLength(3)
    expect(log.filter((l) => l.startsWith('render'))).toHaveLength(6)
    expect(liveCounts()).toMatchObject({ echarts: 1, mermaid: 2 })
    page2.destroy()
  })

  it('rerender() disposes before drawing again (instance count constant)', async () => {
    const log: string[] = []
    const page = new PageCharts('/a', new AbortController().signal, makeDeps(log))
    await page.run()
    await page.rerender()
    await page.rerender()
    expect(liveCounts()).toMatchObject({ echarts: 1, mermaid: 2 })
    expect(document.querySelectorAll('figure.chart')).toHaveLength(3)
    page.destroy()
    expect(liveCounts()).toEqual({})
  })

  it('missing sidecar keys and unknown types get their V1 statuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    document.body.innerHTML = `
      <figure class="chart" data-lecture="L" data-id="nope"></figure>
      <figure class="chart" data-lecture="L" data-id="odd"></figure>`
    const page = new PageCharts(
      '/a',
      new AbortController().signal,
      makeDeps([], { loadSidecar: async () => ({ odd: { type: 'plantuml', code: 'x' } }) }),
    )
    await page.run()
    const [a, b] = [...document.querySelectorAll<HTMLElement>('figure.chart')]
    expect(a!.dataset.chartStatus).toBe('missing')
    expect(a!.querySelector('.chart-error')!.textContent).toContain('L#nope')
    expect(b!.dataset.chartStatus).toBe('unknown-type')
    expect(window.__CHARTS_DONE__).toBe(true)
    page.destroy()
  })

  it('preserves build-time inline mermaid numbers across PageCharts runs and re-entry', async () => {
    document.body.innerHTML = `
      <span class="lec-mermaid-num" data-fig-no="1" data-fig-lec="30" data-fig-label="图 30-1" hidden></span>
      <div class="language-mermaid"><pre><code>flowchart TD; A--&gt;B</code></pre></div>
      <figure class="chart" data-lecture="G01-L30" data-id="c1" data-fig-no="3" data-fig-lec="30" data-fig-label="图 30-3"></figure>`
    const ctl1 = new AbortController()
    const p1 = new PageCharts('/g01/L30', ctl1.signal, makeDeps([]))
    await p1.run()
    expect(document.querySelector('.lec-mermaid-num')).toBeNull()
    const inline1 = document.querySelector<HTMLElement>('figure.inline-mermaid')!
    expect(inline1.dataset.figNo).toBe('1')
    expect(inline1.dataset.figLec).toBe('30')
    expect(inline1.dataset.figLabel).toBe('图 30-1')
    ctl1.abort()
    p1.destroy()

    const p2 = new PageCharts('/g01/L30', new AbortController().signal, makeDeps([]))
    await p2.run()
    const inline2 = document.querySelector<HTMLElement>('figure.inline-mermaid')!
    expect(inline2.dataset.figNo).toBe('1')
    expect(inline2.dataset.figLabel).toBe('图 30-1')
    p2.destroy()
  })
})

describe('charts/fonts', () => {
  it('resolves loaded / timeout / aborted', async () => {
    const fast = { load: vi.fn(async () => []) }
    expect(await waitForChartFonts(new AbortController().signal, '中文', { fonts: fast as never })).toBe('loaded')
    expect(fast.load).toHaveBeenCalledWith("14px 'Noto Sans SC'", expect.stringContaining('中'))

    const never = { load: () => new Promise<FontFace[]>(() => {}) }
    expect(await waitForChartFonts(new AbortController().signal, 'x', { fonts: never as never, timeoutMs: 10 })).toBe(
      'timeout',
    )

    const ctl = new AbortController()
    const p = waitForChartFonts(ctl.signal, 'x', { fonts: never as never, timeoutMs: 10_000 })
    ctl.abort()
    expect(await p).toBe('aborted')
    expect(await waitForChartFonts(new AbortController().signal, 'x', { fonts: null })).toBe('unsupported')
  })
})
