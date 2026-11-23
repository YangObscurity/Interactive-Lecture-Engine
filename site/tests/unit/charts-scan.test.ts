// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { CHART_INLINE_MERMAID } from '../../docs/.vitepress/site.config.mts'
import {
  claimInlineMermaidBlocks,
  claimSidecarFigures,
  removeStaleInlineFigures,
} from '../../docs/.vitepress/theme/charts/scan'
import type { ClaimHooks } from '../../docs/.vitepress/theme/charts/scan'

function hooksWith(stale: Set<Element>): ClaimHooks & { owned: Element[] } {
  const owned: Element[] = []
  return { owned, isStale: (el) => stale.has(el), own: (el) => void owned.push(el) }
}

describe('charts/scan: synchronous claim', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('claims sidecar figures once (idempotent) and never the modal figure', () => {
    document.body.innerHTML = `
      <figure class="chart" data-lecture="G01-L01" data-id="c1"></figure>
      <figure class="chart" data-lecture="G01-L01" data-id="c2"></figure>
      <div class="chart-modal"><figure class="chart chart--modal" data-type="mermaid"></figure></div>`
    const first = claimSidecarFigures(document)
    expect(first).toHaveLength(2)
    for (const f of first) expect(f.dataset.rendered).toBe('1')
    expect(claimSidecarFigures(document)).toHaveLength(0)
    expect(document.querySelector('.chart--modal')!.hasAttribute('data-rendered')).toBe(false)
  })

  it('re-claims a figure only when its owner generation is stale', () => {
    document.body.innerHTML = `<figure class="chart" data-lecture="L" data-id="c1" data-rendered="1"></figure>`
    const fig = document.querySelector('figure')!
    expect(claimSidecarFigures(document, hooksWith(new Set()))).toHaveLength(0)
    const h = hooksWith(new Set([fig]))
    expect(claimSidecarFigures(document, h)).toEqual([fig])
    expect(h.owned).toEqual([fig])
  })

  it('config selectors cover bare ```mermaid fences (V1 behaviour) and pre.mermaid', () => {
    expect(CHART_INLINE_MERMAID.enabled).toBe(true)
    document.body.innerHTML = `
      <div class="language-mermaid vp-adaptive-theme"><pre><code>graph TD; A-->B</code></pre></div>
      <div class="language-mermaid:chart"><pre><code>graph TD; C-->D</code></pre></div>
      <pre class="mermaid">graph TD; E-->F</pre>
      <div class="language-js"><pre><code>x</code></pre></div>`
    const blocks = claimInlineMermaidBlocks(document)
    expect(blocks).toHaveLength(3)
    for (const b of blocks) expect(b.dataset.mermaidRendered).toBe('1')
    expect(claimInlineMermaidBlocks(document)).toHaveLength(0)
  })

  it('skips blocks inside a figure / chart-code and blocks already taken over', () => {
    document.body.innerHTML = `
      <figure class="chart"><div class="language-mermaid"><pre><code>a</code></pre></div></figure>
      <details class="chart-code"><div class="language-mermaid"><pre><code>b</code></pre></div></details>
      <figure class="chart inline-mermaid" data-source="inline-mermaid" data-rendered="1"></figure>
      <div id="taken" class="language-mermaid"><pre><code>c</code></pre></div>`
    expect(claimInlineMermaidBlocks(document)).toHaveLength(0)
    const taken = document.getElementById('taken')!
    expect(taken.dataset.mermaidRendered).toBe('1')
    expect(taken.style.display).toBe('none')
  })

  it('honours enabled=false', () => {
    document.body.innerHTML = `<div class="language-mermaid"><pre><code>a</code></pre></div>`
    expect(claimInlineMermaidBlocks(document, { ...CHART_INLINE_MERMAID, enabled: false })).toHaveLength(0)
    expect(document.querySelector('div')!.hasAttribute('data-mermaid-rendered')).toBe(false)
  })

  it('stale inline figures are removed and their block re-claimed', () => {
    document.body.innerHTML = `
      <figure class="chart inline-mermaid" data-source="inline-mermaid" data-rendered="1"></figure>
      <div class="language-mermaid" data-mermaid-rendered="1" style="display:none"><pre><code>a</code></pre></div>`
    const fig = document.querySelector('figure')!
    const block = document.querySelector('div')!
    const h = hooksWith(new Set([fig, block]))
    expect(removeStaleInlineFigures(document, h)).toBe(1)
    expect(claimInlineMermaidBlocks(document, CHART_INLINE_MERMAID, h)).toEqual([block])
  })
})
