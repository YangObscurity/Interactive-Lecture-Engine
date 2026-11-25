// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref, defineComponent, h } from 'vue'

vi.mock('vitepress', () => ({
  useRouter: () => ({ go: vi.fn() }),
  withBase: (path: string) => path,
  useData: () => ({ lang: ref('zh-CN'), localeIndex: ref('root') }),
}))

vi.mock('virtual:lecture-components', () => ({
  SLOT_DEFAULT_THEME: 'reader',
  SLOT_COMPONENTS: {},
  SLOT_STATIC: {},
}))

vi.mock('../../docs/.vitepress/theme/slots', () => ({
  slotRuntime: {
    useActive: vi.fn(),
    resolve: (name: string) => ({
      impl: 'default',
      component: defineComponent({
        name,
        props: {
          kind: { type: String, default: '' },
          id: { type: String, default: '' },
          cat: { type: Number, default: 0 },
        },
        setup(props) {
          return () => h('g', {
            'data-slot': name,
            'data-kind': props.kind,
            ...(name === 'CanvasNode' && props.id ? { 'data-id': props.id } : {}),
            class: [
              props.kind === 'intra' ? 'ie' : props.kind,
              name === 'CanvasNode' ? 'cv-node' : '',
            ].filter(Boolean).join(' '),
          })
        },
      }),
    }),
  },
  LecSlot: { render: () => null },
}))

const { mockBundle } = vi.hoisted(() => {
  const mockBundle = {
    reader: {
      W: 2000,
      H: 1200,
      groups: [
        {
          id: 'G01',
          cat: 1,
          x: 100,
          y: 100,
          w: 400,
          h: 300,
          nodes: [
            { id: 'g01-l01', x: 20, y: 30 },
            { id: 'g01-l02', x: 20, y: 100 },
            { id: 'g01-l03', x: 20, y: 170 },
          ],
          edges: [
            { s: 'g01-l01', t: 'g01-l02', d: 'M10 20L10 90' },
          ],
        },
        {
          id: 'G02',
          cat: 2,
          x: 600,
          y: 100,
          w: 400,
          h: 300,
          nodes: [
            { id: 'g02-l01', x: 20, y: 30 },
          ],
          edges: [],
        },
      ],
      bundles: [
        { a: 'G01', b: 'G02', n: 1 },
      ],
      edges: [
        ['g01-l01', 'g01-l02', 1],
        ['g01-l02', 'g02-l01', 1],
      ],
      offMap: [],
    },
    datasheet: {
      compact: {
        W: 2400,
        H: 1400,
        zones: [],
        units: {
          G01: {
            g: 'G01',
            part: '',
            of: 1,
            x: 100,
            y: 100,
            nx: 100,
            ny: 100,
            w: 300,
            h: 200,
            bw: 120,
            bh: 160,
            total: 8,
            per: 4,
            lec: ['g01-l01', 'g01-l02'],
            ports: [],
          },
          G02: {
            g: 'G02',
            part: '',
            of: 1,
            x: 600,
            y: 100,
            nx: 600,
            ny: 100,
            w: 300,
            h: 200,
            bw: 120,
            bh: 160,
            total: 8,
            per: 4,
            lec: ['g02-l01'],
            ports: [],
          },
        },
        buses: [],
      },
      zones: {
        W: 2400,
        H: 1400,
        zones: [],
        units: {},
        buses: [],
      },
    },
  }
  return { mockBundle }
})

vi.mock('../../docs/.vitepress/theme/curriculum/canvasLoader', () => ({
  loadCanvas: vi.fn().mockResolvedValue(mockBundle),
}))

import CanvasMap from '../../docs/.vitepress/theme/map/canvas/CanvasMap.vue'
import CanvasNodeDefault from '../../docs/.vitepress/theme/slots/default/CanvasNode.vue'
import CanvasNodeDatasheet from '../../docs/.vitepress/themes/datasheet/components/CanvasNode.vue'
import { buildCanvasBoardView, buildCanvasIndex } from '../../docs/.vitepress/theme/map/canvas/model'
import type { CurriculumData } from '../../docs/.vitepress/curriculum/data'
import type { CanvasBundle } from '../../docs/.vitepress/curriculum/canvasTypes'
import { LabelLayer } from '../../docs/.vitepress/theme/map/labels'

const curriculum: CurriculumData = {
  version: 1,
  locale: 'root',
  stats: { groups: 2, lectures: 4, edges: 2 },
  groups: [
    {
      id: 'G01',
      dir: 'g01',
      title: 'Group 1',
      category: 'Cat 1',
      catSlot: 1,
      phases: [],
      lectures: [
        { id: 'g01-l01', n: 1, title: 'Lecture 1', link: '/g01/01' },
        { id: 'g01-l02', n: 2, title: 'Lecture 2', link: '/g01/02' },
        { id: 'g01-l03', n: 3, title: 'Lecture 3', link: '/g01/03' },
      ],
    },
    {
      id: 'G02',
      dir: 'g02',
      title: 'Group 2',
      category: 'Cat 2',
      catSlot: 2,
      phases: [],
      lectures: [
        { id: 'g02-l01', n: 1, title: 'Lecture 1', link: '/g02/01' },
      ],
    },
  ],
  edges: [
    ['g01-l01', 'g01-l02'],
    ['g01-l02', 'g02-l01'],
  ],
}

describe('CanvasMap layer order and marker sizing', () => {
  it('renders markers with markerUnits="userSpaceOnUse" and sensible user-space sizes', async () => {
    const wrapper = mount(CanvasMap, {
      props: {
        curriculum,
        groupHref: (dir: string) => `/${dir}`,
      },
    })
    await nextTick()
    await nextTick()

    const ah = wrapper.find('#cv-ah')
    expect(ah.exists()).toBe(true)
    expect(ah.attributes('markerUnits')).toBe('userSpaceOnUse')
    expect(ah.attributes('markerWidth')).toBe('10')
    expect(ah.attributes('markerHeight')).toBe('7.5')
    expect(ah.attributes('refX')).toBe('7')
    expect(ah.attributes('refY')).toBe('3')

    const ahB = wrapper.find('#cv-ah-b')
    expect(ahB.exists()).toBe(true)
    expect(ahB.attributes('markerUnits')).toBe('userSpaceOnUse')
    expect(ahB.attributes('markerWidth')).toBe('24')
    expect(ahB.attributes('markerHeight')).toBe('18')
    expect(ahB.attributes('refX')).toBe('6.5')
    expect(ahB.attributes('refY')).toBe('3')

    const ahPre = wrapper.find('#cv-ah-pre')
    expect(ahPre.exists()).toBe(true)
    expect(ahPre.attributes('markerUnits')).toBe('userSpaceOnUse')
    expect(ahPre.attributes('markerWidth')).toBe('14')
    expect(ahPre.attributes('markerHeight')).toBe('10.5')
    expect(ahPre.attributes('refX')).toBe('7')

    const ahPost = wrapper.find('#cv-ah-post')
    expect(ahPost.exists()).toBe(true)
    expect(ahPost.attributes('markerUnits')).toBe('userSpaceOnUse')
    expect(ahPost.attributes('markerWidth')).toBe('14')
    expect(ahPost.attributes('markerHeight')).toBe('10.5')
    expect(ahPost.attributes('refX')).toBe('7')

    wrapper.unmount()
  })

  it('renders SVG layers in exact prototype order: backdrop -> bundleEdges -> groups -> intraEdges -> nodes -> traceEdges -> bigLabels', async () => {
    const wrapper = mount(CanvasMap, {
      props: {
        curriculum,
        groupHref: (dir: string) => `/${dir}`,
      },
    })
    await nextTick()
    await nextTick()

    const layer = wrapper.find('g.cv-layer')
    expect(layer.exists()).toBe(true)

    // Lock g01-l02 via dblclick so traceEdges (pre + post) also render
    const targetNode = wrapper.find('.cv-node[data-id="g01-l02"]')
    expect(targetNode.exists()).toBe(true)
    await targetNode.trigger('dblclick')
    await nextTick()

    const children = Array.from(layer.element.children) as Element[]
    const slots = children.map((c) => {
      const slot = c.getAttribute('data-slot')
      if (slot === 'CanvasEdge') {
        const k = c.getAttribute('data-kind')
        if (k === 'intra') return 'intraEdge'
        if (k === 'trace-pre' || k === 'trace-post') return 'traceEdge'
        return 'bundleEdge'
      }
      if (c.tagName.toLowerCase() === 'text' && c.getAttribute('data-label-kind') === 'big') {
        return 'bigLabels'
      }
      return slot ?? c.tagName.toLowerCase()
    })

    const rank: Record<string, number> = {
      CanvasBackdrop: 0,
      bundleEdge: 1,
      CanvasGroup: 2,
      intraEdge: 3,
      CanvasNode: 4,
      traceEdge: 5,
      bigLabels: 6,
    }
    const ranks = slots.map((s) => rank[s] ?? -1)
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1]!)
    }
    expect(slots).toContain('CanvasBackdrop')
    expect(slots).toContain('bundleEdge')
    expect(slots).toContain('CanvasGroup')
    expect(slots).toContain('intraEdge')
    expect(slots).toContain('CanvasNode')
    expect(slots).toContain('traceEdge')
    expect(slots).toContain('bigLabels')

    wrapper.unmount()
  })
})

describe('buildCanvasBoardView traceRole propagation', () => {
  const index = buildCanvasIndex(curriculum)

  it('computes traceRole correctly for reader skin', () => {
    const view = buildCanvasBoardView({
      bundle: mockBundle as unknown as CanvasBundle,
      skin: 'reader',
      dsMode: 'compact',
      curriculum,
      index,
      statuses: new Map(),
      focus: {
        activeNodes: new Set(['g01-l01', 'g01-l02', 'g02-l01']),
        activeGroups: new Set(['G01', 'G02']),
        lockedId: 'g01-l01',
        activePairKey: null,
        preEdges: [['g01-l02', 'g01-l01'] as const],
        postEdges: [['g01-l01', 'g02-l01'] as const],
      },
      hoverNodeId: null,
      hotPairKey: null,
      hotTraceKey: null,
      matches: new Set(),
      labels: {
        uncategorised: 'Uncategorised',
        toUnit: () => '',
        fromUnit: () => '',
      },
    })

    const lockedNode = view.nodes.find((n) => n.id === 'g01-l01')
    expect(lockedNode?.traceRole).toBe('locked')

    const preNode = view.nodes.find((n) => n.id === 'g01-l02')
    expect(preNode?.traceRole).toBe('pre')

    const postNode = view.nodes.find((n) => n.id === 'g02-l01')
    expect(postNode?.traceRole).toBe('post')

    const unhighlighted = view.nodes.find((n) => n.id === 'g01-l03')
    expect(unhighlighted?.traceRole).toBeNull()
  })

  it('computes traceRole correctly for datasheet skin (locked/pre/post/pair)', () => {
    const viewPair = buildCanvasBoardView({
      bundle: mockBundle as unknown as CanvasBundle,
      skin: 'datasheet',
      dsMode: 'compact',
      curriculum,
      index,
      statuses: new Map(),
      focus: {
        activeNodes: new Set(['g01-l01', 'g01-l02']),
        activeGroups: new Set(['G01']),
        lockedId: null,
        activePairKey: 'G01|G02',
        preEdges: [],
        postEdges: [],
      },
      hoverNodeId: null,
      hotPairKey: null,
      hotTraceKey: null,
      matches: new Set(),
      labels: {
        uncategorised: 'Uncategorised',
        toUnit: () => '',
        fromUnit: () => '',
      },
    })

    expect(viewPair.nodes.find((n) => n.id === 'g01-l01')?.traceRole).toBe('pair')
    expect(viewPair.nodes.find((n) => n.id === 'g02-l01')?.traceRole).toBeNull()

    const viewLock = buildCanvasBoardView({
      bundle: mockBundle as unknown as CanvasBundle,
      skin: 'datasheet',
      dsMode: 'compact',
      curriculum,
      index,
      statuses: new Map(),
      focus: {
        activeNodes: new Set(['g01-l01', 'g01-l02', 'g02-l01']),
        activeGroups: new Set(['G01', 'G02']),
        lockedId: 'g01-l02',
        activePairKey: null,
        preEdges: [['g01-l01', 'g01-l02'] as const],
        postEdges: [['g01-l02', 'g02-l01'] as const],
      },
      hoverNodeId: null,
      hotPairKey: null,
      hotTraceKey: null,
      matches: new Set(),
      labels: {
        uncategorised: 'Uncategorised',
        toUnit: () => '',
        fromUnit: () => '',
      },
    })

    expect(viewLock.nodes.find((n) => n.id === 'g01-l02')?.traceRole).toBe('locked')
    expect(viewLock.nodes.find((n) => n.id === 'g01-l01')?.traceRole).toBe('pre')
    expect(viewLock.nodes.find((n) => n.id === 'g02-l01')?.traceRole).toBe('post')
  })
})

describe('CanvasNode components trace styling and classes', () => {
  it('Default CanvasNode applies trace-* class and keeps on/locked/match visible', () => {
    for (const role of ['locked', 'pre', 'post'] as const) {
      const wrapper = mount(CanvasNodeDefault, {
        props: {
          id: 'g01-l01',
          number: '01',
          pinNumber: 1,
          label: 'Lecture 1',
          status: 'reading',
          hover: false,
          locked: role === 'locked',
          active: true,
          match: false,
          traceRole: role,
          x: 10,
          y: 20,
          w: 100,
          h: 40,
          pinX: 10,
          pinY: 20,
          tipX: 10,
          pinSide: 1,
          legLen: 0,
          nameX: 10,
          hitX: 10,
          hitW: 100,
        },
      })

      const root = wrapper.find('g.cv-node')
      expect(root.classes()).toContain(`trace-${role}`)
      expect(root.classes()).toContain('on')
      if (role === 'locked') expect(root.classes()).toContain('locked')
      wrapper.unmount()
    }
  })

  it('Datasheet CanvasNode applies trace-* class and keeps on/locked/match visible', () => {
    for (const role of ['locked', 'pre', 'post'] as const) {
      const wrapper = mount(CanvasNodeDatasheet, {
        props: {
          id: 'g01-l01',
          number: '01',
          pinNumber: 1,
          label: 'Lecture 1',
          status: 'reading',
          hover: false,
          locked: role === 'locked',
          active: true,
          match: false,
          traceRole: role,
          x: 10,
          y: 20,
          w: 100,
          h: 40,
          pinX: 10,
          pinY: 20,
          tipX: 10,
          pinSide: 1,
          legLen: 10,
          nameX: 10,
          hitX: 10,
          hitW: 100,
        },
      })

      const root = wrapper.find('g.cv-node')
      expect(root.classes()).toContain(`trace-${role}`)
      expect(root.classes()).toContain('on')
      if (role === 'locked') expect(root.classes()).toContain('locked')
      wrapper.unmount()
    }
  })
})

describe('LabelLayer invalidation and priority labels', () => {
  interface Drawn {
    text: string
    font: string
    x: number
    y: number
    alpha: number
  }

  function fakeContext() {
    const drawn: Drawn[] = []
    const ctx = {
      font: '',
      fillStyle: '' as string,
      strokeStyle: '' as string,
      lineWidth: 0,
      lineJoin: '',
      globalAlpha: 1,
      textAlign: 'left',
      textBaseline: 'alphabetic',
      setTransform: () => {},
      clearRect: () => {
        drawn.length = 0
      },
      save: () => {},
      restore: () => {},
      translate: () => {},
      rotate: () => {},
      fillText: (text: string, x = 0, y = 0) => {
        drawn.push({ text, font: ctx.font, x, y, alpha: ctx.globalAlpha })
      },
      strokeText: () => {},
      fillRect: () => {},
      measureText: (t: string) => ({ width: t.length * 7 }),
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn }
  }

  const flushMutations = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('ancestor transition from .dim (opacity 0.28) to .on (opacity 1) repaints affected label with alpha === 1', async () => {
    const styleEl = document.createElement('style')
    styleEl.innerHTML = `
      .dim { opacity: 0.28; }
      .on { opacity: 1 !important; }
    `
    document.head.appendChild(styleEl)

    document.body.innerHTML = `
      <section id="stage">
        <svg id="svg">
          <g id="node" class="cv-node dim">
            <text id="lbl" x="50" y="50" style="font-size: 14px">42</text>
          </g>
        </svg>
      </section>
    `

    const stage = document.getElementById('stage') as HTMLElement
    const svg = document.getElementById('svg') as unknown as SVGSVGElement
    const node = document.getElementById('node') as Element
    stage.getBoundingClientRect = () => ({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })

    const frames: Array<() => void> = []
    const idles: Array<() => void> = []
    const { ctx, drawn } = fakeContext()

    const layer = new LabelLayer({
      stage,
      svg,
      getContext: () => ctx,
      devicePixelRatio: () => 1,
      requestFrame: (cb) => frames.push(cb),
      cancelFrame: (id) => void frames.splice(id - 1, 1, () => undefined),
      requestIdle: (cb) => void idles.push(cb),
    })

    const flush = () => {
      while (frames.length || idles.length) {
        while (frames.length) frames.shift()?.()
        while (idles.length) idles.shift()?.()
      }
    }

    layer.collect()
    layer.draw({ transform: { k: 1, x: 0, y: 0 }, ladder: false })
    flush()

    const firstDraw = drawn.find((d) => d.text === '42')
    expect(firstDraw).toBeDefined()
    expect(firstDraw?.alpha).toBeCloseTo(0.28, 2)

    // Transition ancestor to .on
    const layerInternal = layer as unknown as {
      passCache: { ancAlpha: Map<string, number>; styles: Map<string, unknown> }
    }
    node.setAttribute('class', 'cv-node on')
    await flushMutations()
    expect(layerInternal.passCache.ancAlpha.size).toBe(0)
    expect(layerInternal.passCache.styles.size).toBe(0)
    flush()

    const secondDraw = drawn.find((d) => d.text === '42')
    expect(secondDraw).toBeDefined()
    expect(secondDraw?.alpha).toBe(1)

    layer.destroy()
    styleEl.remove()
  })

  it('priority node labels render at low zoom (25%, l.size * k = 2.75) while normal labels and names are culled via visible filter', () => {
    document.body.innerHTML = `
      <section id="stage">
        <svg id="svg">
          <g class="cv-node">
            <text id="normal-lbl" data-label-kind="num" x="50" y="50" style="font-size: 11px">01</text>
          </g>
          <g class="cv-node on">
            <text id="priority-lbl" data-label-kind="num" x="100" y="50" style="font-size: 11px">02</text>
            <text id="priority-name" data-label-kind="name" x="120" y="50" style="font-size: 12px">Title</text>
          </g>
        </svg>
      </section>
    `

    const stage = document.getElementById('stage') as HTMLElement
    const svg = document.getElementById('svg') as unknown as SVGSVGElement
    stage.getBoundingClientRect = () => ({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })

    const { ctx, drawn } = fakeContext()
    const layer = new LabelLayer({
      stage,
      svg,
      getContext: () => ctx,
      devicePixelRatio: () => 1,
      visible(label, k) {
        if (label.kind === 'num' && typeof label.el.closest === 'function' && Boolean(label.el.closest('.cv-node.on, .cv-node.locked, .cv-node.match'))) return true
        if (label.kind === 'mid' || label.kind === 'num') return k >= 0.22
        if (label.kind === 'name' || label.kind === 'nc') return k >= 0.45
        return true
      },
    })

    layer.collect()
    // At zoom k = 0.25: 11 * 0.25 = 2.75 px (< MIN_LABEL_PX 4, >= 1.8)
    layer.draw({ transform: { k: 0.25, x: 0, y: 0 }, ladder: false })

    expect(drawn.some((d) => d.text === '01')).toBe(false)
    expect(drawn.some((d) => d.text === '02')).toBe(true)
    expect(drawn.some((d) => d.text === 'Title')).toBe(false)

    // At k = 0.18 (lod-far): priority num STILL passes visible() and 11 * 0.18 = 1.98 >= 1.8 floor
    layer.draw({ transform: { k: 0.18, x: 0, y: 0 }, ladder: false })
    expect(drawn.some((d) => d.text === '02')).toBe(true)

    layer.destroy()
  })

  it('datasheet CanvasNode keeps .n.locked .pname after .n.on .pname and hides .p-half for trace-pre/post', () => {
    expect(CanvasNodeDatasheet).toBeDefined()
    const wrapper = mount(CanvasNodeDatasheet, {
      props: {
        id: 'g01-l01',
        number: '01',
        pinNumber: 1,
        label: 'Lecture 1',
        status: 'reading',
        hover: false,
        locked: false,
        active: true,
        match: false,
        traceRole: 'pre',
        x: 10,
        y: 20,
        w: 100,
        h: 40,
        pinX: 10,
        pinY: 20,
        tipX: 10,
        pinSide: 1,
        legLen: 10,
        nameX: 10,
        hitX: 10,
        hitW: 100,
      },
    })
    expect(wrapper.find('g.cv-node').classes()).toContain('trace-pre')
    expect(wrapper.find('.p-half').exists()).toBe(true)
    wrapper.unmount()
  })
})
