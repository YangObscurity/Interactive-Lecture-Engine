// @vitest-environment happy-dom
import { createSSRApp, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vitepress', () => ({ useData: () => ({ lang: ref('zh-CN'), localeIndex: ref('root') }) }))

import MapStage from '../../docs/.vitepress/theme/map/MapStage.vue'
import MapInfoPanel from '../../docs/.vitepress/theme/map/MapInfoPanel.vue'
import MapControls from '../../docs/.vitepress/theme/map/MapControls.vue'
import { mapAriaLabel, mapSvgLabel } from '../../docs/.vitepress/theme/map/aria'
import { useInfoPanel } from '../../docs/.vitepress/theme/map/useInfoPanel'

const RECT = { width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }
const wrappers: Array<{ unmount(): void }> = []
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
  document.body.innerHTML = ''
})

// the stage has no layout in happy-dom: give every element the stage size
const realRect = Element.prototype.getBoundingClientRect
function stubLayout(): void {
  Element.prototype.getBoundingClientRect = function () {
    return RECT as DOMRect
  }
}
afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect
})

describe('MapStage', () => {
  it('renders the stage, the svg with its content, the label canvas, the buttons and the hint', () => {
    const w = mount(MapStage, {
      props: { width: 4000, height: 2000, ariaLabel: 'a map', svgLabel: 'the svg' },
      slots: { default: '<rect class="node" width="10" height="10" />', hud: '<input class="search" />', overlay: '<div class="mine lec-map-panel" />' },
      attachTo: document.body,
    })
    wrappers.push(w)
    const stage = w.find('section.lec-map')
    expect(stage.attributes('aria-label')).toBe('a map')
    expect(stage.attributes('tabindex')).toBe('0')
    expect(w.find('svg.lec-map-svg').attributes('aria-label')).toBe('the svg')
    expect(w.find('svg.lec-map-svg rect.node').exists()).toBe(true)
    expect(w.find('canvas.lec-map-labels').exists()).toBe(true)
    expect(w.find('.lec-map-hud-tl input.search').exists()).toBe(true)
    expect(w.findAll('.lec-map-controls button')).toHaveLength(3)
    expect(w.find('.lec-map-hint').text()).toContain('Ctrl')
    expect(w.find('.mine').exists()).toBe(true)
  })

  it('has no built-in buttons or hint when bare', () => {
    const w = mount(MapStage, { props: { width: 100, height: 100, ariaLabel: 'x', bare: true } })
    wrappers.push(w)
    expect(w.find('.lec-map-controls').exists()).toBe(false)
    expect(w.find('.lec-map-hint').exists()).toBe(false)
  })

  it('fits the content on mount, zooms with the buttons, and draws the labels of the svg', async () => {
    stubLayout()
    const w = mount(MapStage, {
      props: { width: 4000, height: 2000, ariaLabel: 'a map' },
      slots: { default: '<text x="100" y="100" style="font-size: 40px">Hello</text>' },
      attachTo: document.body,
    })
    wrappers.push(w)
    await nextTick()
    const svg = w.find('svg').element as SVGSVGElement
    const fitK = Math.min(1000 / 4000, (600 - 56) / 2000) * 0.96
    expect(svg.style.transform).toContain(`scale(${fitK})`)
    const exposed = w.vm as unknown as { viewport: { viewport: { value: { view: { k: number } } }; transform: { value: { k: number } } }; labels: { layer: { value: { labels: Array<{ text: string }> } } } }
    expect(exposed.labels.layer.value.labels.map((l) => l.text)).toEqual(['Hello'])
    expect(exposed.viewport.transform.value.k).toBeCloseTo(fitK, 12)

    const buttons = w.findAll('.lec-map-controls button')
    await buttons[0]?.trigger('click') // +
    expect(exposed.viewport.viewport.value.view.k).toBeCloseTo(fitK * 1.4, 12)
    await buttons[1]?.trigger('click') // -
    expect(exposed.viewport.viewport.value.view.k).toBeCloseTo(fitK, 12)
    await buttons[1]?.trigger('click')
    await buttons[2]?.trigger('click') // fit
    expect(exposed.viewport.viewport.value.view.k).toBeCloseTo(fitK, 12)
  })

  it('emits commit with the settled view', async () => {
    stubLayout()
    const w = mount(MapStage, { props: { width: 4000, height: 2000, ariaLabel: 'a' }, attachTo: document.body })
    wrappers.push(w)
    await nextTick()
    expect(w.emitted('commit')?.length).toBeGreaterThan(0)
    const first = w.emitted('commit')?.[0]?.[0] as { k: number }
    expect(first.k).toBeGreaterThan(0)
  })

  it('renders on the server without touching the DOM, and the hint is not hidden in the server markup', async () => {
    const app = createSSRApp({ render: () => h(MapStage, { width: 100, height: 100, ariaLabel: 'ssr map' }, { default: () => h('rect') }) })
    const html = await renderToString(app)
    expect(html).toContain('aria-label="ssr map"')
    expect(html).toContain('<canvas')
    expect(html).not.toContain('lec-map-hint-off')
    expect(html).not.toContain('style="transform')
  })
})

describe('MapInfoPanel and useInfoPanel', () => {
  it('shows title, lines and sections, and fades by class', async () => {
    const w = mount(MapInfoPanel, {
      props: {
        open: true,
        content: { title: 'G05 L18', lines: ['read'], sections: [{ heading: 'Prerequisites', tone: 'pre', items: ['a', 'b'] }, { heading: 'Next', tone: 'post', items: ['c'] }, { text: 'note' }] },
      },
    })
    wrappers.push(w)
    expect(w.classes()).toContain('lec-map-info-on')
    expect(w.attributes('aria-live')).toBe('polite')
    expect(w.find('b').text()).toBe('G05 L18')
    expect(w.findAll('li').map((l) => l.text())).toEqual(['a', 'b', 'c'])
    expect(w.find('.lec-map-info-pre').text()).toBe('Prerequisites')
    expect(w.find('.lec-map-info-post').text()).toBe('Next')
    await w.setProps({ open: false })
    expect(w.classes()).not.toContain('lec-map-info-on')
  })

  it('useInfoPanel keeps the panel open for 140 ms after hide(), and show() cancels a pending hide', () => {
    vi.useFakeTimers()
    try {
      const p = useInfoPanel()
      p.show({ title: 'x' })
      expect(p.open.value).toBe(true)
      p.hide()
      vi.advanceTimersByTime(139)
      expect(p.open.value).toBe(true)
      vi.advanceTimersByTime(1)
      expect(p.open.value).toBe(false)
      expect(p.content.value).toEqual({ title: 'x' }) // the text stays for the fade-out
      p.show({ title: 'y' })
      p.hide()
      vi.advanceTimersByTime(100)
      p.show({ title: 'z' })
      vi.advanceTimersByTime(1000)
      expect(p.open.value).toBe(true)
      expect(p.content.value).toEqual({ title: 'z' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('MapControls and the aria text', () => {
  it('emits zoom-in, zoom-out and fit', async () => {
    const w = mount(MapControls)
    wrappers.push(w)
    const b = w.findAll('button')
    await b[0]?.trigger('click')
    await b[1]?.trigger('click')
    await b[2]?.trigger('click')
    expect(Object.keys(w.emitted()).filter((k) => ['zoom-in', 'zoom-out', 'fit'].includes(k))).toEqual(['zoom-in', 'zoom-out', 'fit'])
    expect(w.attributes('role')).toBe('group')
  })

  it('describes the map: counts and how to operate it, in both languages', () => {
    const zh = mapAriaLabel('zh-CN', { groups: 15, lectures: 377 })
    expect(zh).toContain('15')
    expect(zh).toContain('377')
    expect(zh).toContain('Esc')
    const en = mapAriaLabel('en', { groups: 15, lectures: 377 })
    expect(en).toContain('15 course groups')
    expect(en).toContain('377 lectures')
    expect(en).toContain('Esc')
    expect(mapAriaLabel('en', { groups: 2, lectures: 5, edges: 7 })).toContain('7 prerequisite links')
    expect(mapSvgLabel('en')).toBe('Course map')
  })
})
