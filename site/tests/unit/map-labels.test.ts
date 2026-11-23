// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CULL_X,
  CULL_Y,
  FONT_GIVE_UP_MS,
  LabelLayer,
  type LabelLayerOptions,
  fontsCover,
  MIN_LABEL_PX,
  MOVING_CLASS,
  labelHitBox,
  labelOnScreen,
  labelPixelSize,
  labelVisibleAt,
  readLabelGeometry,
  type LabelView,
} from '../../docs/.vitepress/theme/map/labels'
import { ladder } from '../../docs/.vitepress/theme/map/geometry'

interface Drawn {
  text: string
  font: string
  x: number
  y: number
  alpha: number
  rot: number
}

/** A recording stand-in for a 2D context: tracks translate / rotate / globalAlpha for every `fillText`. */
function fakeContext() {
  const drawn: Drawn[] = []
  const calls: string[] = []
  let tx = 0
  let ty = 0
  let rot = 0
  const stack: Array<[number, number, number]> = []
  const ctx = {
    font: '',
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 0,
    lineJoin: '',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    setTransform: () => calls.push('setTransform'),
    clearRect: () => {
      calls.push('clearRect')
      drawn.length = 0
    },
    save: () => stack.push([tx, ty, rot]),
    restore: () => {
      const s = stack.pop()
      if (s) [tx, ty, rot] = s
    },
    translate: (x: number, y: number) => {
      tx += x
      ty += y
    },
    rotate: (a: number) => {
      rot += a
    },
    fillText: (text: string, x = 0, y = 0) => {
      calls.push('fillText')
      drawn.push({ text, font: ctx.font, x: tx + x, y: ty + y, alpha: ctx.globalAlpha, rot })
    },
    strokeText: () => calls.push('strokeText'),
    fillRect: () => calls.push('fillRect'),
    measureText: (t: string) => ({ width: t.length * 7 }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn, calls }
}

const NS = 'http://www.w3.org/2000/svg'

interface Rig {
  stage: HTMLElement
  svg: SVGSVGElement
  layer: LabelLayer
  drawn: Drawn[]
  calls: string[]
  /** Run the queued animation frames (class changes request one) and idle callbacks (the unread rest is styled in them). */
  flush(): void
  add(parent: Element, attrs: Record<string, string>, text: string): SVGTextElement
}

function rig(opts: { width?: number; height?: number; layer?: Partial<LabelLayerOptions> } = {}): Rig {
  const width = opts.width ?? 1000
  const height = opts.height ?? 600
  document.head.innerHTML = '<style>.hot { font-weight: 700 } .dim { opacity: 0.5 }</style>'
  document.body.innerHTML = '<section id="stage"><svg id="svg"><g id="grp"></g></svg></section>'
  const stage = document.getElementById('stage') as HTMLElement
  const svg = document.getElementById('svg') as unknown as SVGSVGElement
  stage.getBoundingClientRect = () => ({ width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) })
  const frames: Array<() => void> = []
  const idles: Array<() => void> = []
  const { ctx, drawn, calls } = fakeContext()
  const layer = new LabelLayer({
    stage,
    svg,
    getContext: () => ctx,
    devicePixelRatio: () => 2,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: (id) => void frames.splice(id - 1, 1, () => undefined),
    requestIdle: (cb) => void idles.push(cb),
    ...opts.layer,
  })
  return {
    stage,
    svg,
    layer,
    drawn,
    calls,
    flush() {
      while (frames.length || idles.length) {
        while (frames.length) frames.shift()?.()
        while (idles.length) idles.shift()?.()
      }
    },
    add(parent, attrs, text) {
      const t = document.createElementNS(NS, 'text') as SVGTextElement
      for (const [k, v] of Object.entries(attrs)) t.setAttribute(k, v)
      t.textContent = text
      parent.appendChild(t)
      return t
    },
  }
}

const view = (k: number, x = 0, y = 0, onLadder = false): LabelView => ({ transform: { k, x, y }, ladder: onLadder })
const flushMutations = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

let live: Rig | null = null
beforeEach(() => {
  live = null
})
afterEach(() => live?.layer.destroy())
const make = (o: { width?: number; height?: number; layer?: Partial<LabelLayerOptions> } = {}): Rig => (live = rig(o))

describe('label geometry and pure rules', () => {
  it('reads x, y, the translate of the transform, the rotation and the anchor', () => {
    document.body.innerHTML = '<svg><text id="a" x="10" y="20" transform="translate(5 7) rotate(-90)" text-anchor="end">x</text><text id="b">y</text></svg>'
    expect(readLabelGeometry(document.getElementById('a') as Element)).toEqual({ x: 15, y: 27, rot: -90, align: 'right' })
    expect(readLabelGeometry(document.getElementById('b') as Element)).toEqual({ x: 0, y: 0, rot: 0, align: 'left' })
  })

  it('draws at the exact size, or at the ladder size during an animated zoom', () => {
    expect(labelPixelSize(13, 0.8, false)).toBeCloseTo(10.4, 12)
    expect(labelPixelSize(13, 0.8, true)).toBeCloseTo(13 * ladder(0.8), 12)
  })

  it('culls labels more than 600 px left / right or 60 px above / below the stage', () => {
    expect(labelOnScreen(-CULL_X, 0, 1000, 600)).toBe(true)
    expect(labelOnScreen(-CULL_X - 1, 0, 1000, 600)).toBe(false)
    expect(labelOnScreen(1000 + CULL_X, 0, 1000, 600)).toBe(true)
    expect(labelOnScreen(1000 + CULL_X + 1, 0, 1000, 600)).toBe(false)
    expect(labelOnScreen(0, -CULL_Y - 1, 1000, 600)).toBe(false)
    expect(labelOnScreen(0, 600 + CULL_Y + 1, 1000, 600)).toBe(false)
    expect(MIN_LABEL_PX).toBe(4)
  })

  it('a label is visible inside its own zoom range', () => {
    expect(labelVisibleAt({ minK: 0.22, maxK: Infinity }, 0.3)).toBe(true)
    expect(labelVisibleAt({ minK: 0.22, maxK: Infinity }, 0.21)).toBe(false)
    expect(labelVisibleAt({ minK: 0, maxK: 0.22 }, 0.22)).toBe(false)
  })

  it('hit boxes follow the text anchor', () => {
    expect(labelHitBox(100, 50, 40, 10, 'start', 0)).toEqual({ x: 100, y: 41.5, w: 40, h: 12 })
    expect(labelHitBox(100, 50, 40, 10, 'end', 0).x).toBe(60)
    expect(labelHitBox(100, 50, 40, 10, 'middle', 0).x).toBe(80)
    expect(labelHitBox(100, 50, 40, 10, 'start', 3)).toEqual({ x: 97, y: 38.5, w: 46, h: 18 })
  })
})

describe('the canvas', () => {
  it('sits over the stage at the stage size times the device pixel ratio', () => {
    const r = make({ width: 800, height: 500 })
    expect(r.layer.canvas.parentElement).toBe(r.stage)
    expect(r.layer.canvas.previousElementSibling).toBe(r.svg)
    expect(r.layer.canvas.width).toBe(1600)
    expect(r.layer.canvas.height).toBe(1000)
    expect(r.layer.canvas.style.width).toBe('800px')
    expect(r.layer.canvas.getAttribute('aria-hidden')).toBe('true')
  })

  it('uses a canvas the component rendered, and leaves it in place on destroy', () => {
    document.body.innerHTML = '<section id="stage"><svg id="svg"></svg><canvas id="c"></canvas></section>'
    const stage = document.getElementById('stage') as HTMLElement
    stage.getBoundingClientRect = () => ({ width: 100, height: 100, left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) })
    const canvas = document.getElementById('c') as HTMLCanvasElement
    const layer = new LabelLayer({ stage, svg: document.getElementById('svg') as unknown as SVGSVGElement, canvas, getContext: () => fakeContext().ctx })
    expect(layer.canvas).toBe(canvas)
    expect(canvas.classList.contains('lec-map-labels')).toBe(true)
    layer.destroy()
    expect(document.getElementById('c')).toBe(canvas)
  })
})

describe('drawing: only labels that are on screen, at screen-pixel size', () => {
  it('draws the text at stage position, with the screen font size, from the computed style', () => {
    const r = make()
    r.add(r.svg, { x: '100', y: '50', style: 'font-size: 20px; font-family: Georgia; font-weight: 700; fill: rgb(1, 2, 3)' }, 'Alpha')
    r.layer.collect()
    r.layer.draw(view(0.5, 30, 40))
    expect(r.drawn).toHaveLength(1)
    const d = r.drawn[0] as Drawn
    expect(d.text).toBe('Alpha')
    expect(d.x).toBeCloseTo(30 + 100 * 0.5, 9)
    expect(d.y).toBeCloseTo(40 + 50 * 0.5, 9)
    expect(d.font).toContain('10px') // 20px * 0.5
    expect(d.font).toContain('Georgia')
    expect(d.font).toContain('700')
    expect(r.layer.stats).toEqual({ drawn: 1, styled: 1 })
  })

  it('does not draw labels under 4 px, labels far off screen, or labels outside their zoom range', () => {
    const r = make()
    r.add(r.svg, { x: '0', y: '0', style: 'font-size: 12px' }, 'tiny') // 12 * 0.3 = 3.6 px
    r.add(r.svg, { x: '5000', y: '0', style: 'font-size: 12px' }, 'far right')
    r.add(r.svg, { x: '0', y: '5000', style: 'font-size: 12px' }, 'far below')
    r.add(r.svg, { x: '0', y: '10', style: 'font-size: 40px', 'data-min-zoom': '0.5' }, 'only zoomed in')
    r.add(r.svg, { x: '0', y: '10', style: 'font-size: 40px', 'data-max-zoom': '0.5' }, 'only zoomed out')
    r.add(r.svg, { x: '0', y: '20', style: 'font-size: 40px' }, 'always')
    r.layer.collect()
    r.layer.draw(view(0.3))
    expect(r.drawn.map((d) => d.text).sort()).toEqual(['always', 'only zoomed out'])
    r.layer.draw(view(1))
    expect(r.drawn.map((d) => d.text).sort()).toEqual(['always', 'only zoomed in', 'tiny'])
  })

  it('inherits a zoom range from a parent group', () => {
    const r = make()
    const g = document.getElementById('grp') as Element
    g.setAttribute('data-min-zoom', '0.45')
    r.add(g, { x: '0', y: '20', style: 'font-size: 40px' }, 'in group')
    r.layer.collect()
    r.layer.draw(view(0.4))
    expect(r.drawn).toHaveLength(0)
    r.layer.draw(view(0.5))
    expect(r.drawn).toHaveLength(1)
  })

  it('skips labels that are transparent (own opacity times the opacity of every ancestor)', () => {
    const r = make()
    const g = document.getElementById('grp') as HTMLElement
    r.add(g, { x: '0', y: '20', style: 'font-size: 20px' }, 'shown')
    g.style.opacity = '0.5'
    r.add(r.svg, { x: '0', y: '20', style: 'font-size: 20px; opacity: 0' }, 'hidden')
    r.layer.collect()
    r.layer.draw(view(1))
    expect(r.drawn.map((d) => d.text)).toEqual(['shown'])
    expect(r.drawn[0]?.alpha).toBeCloseTo(0.5, 9)
  })

  it('rotates a rotated label', () => {
    const r = make()
    r.add(r.svg, { x: '0', y: '0', transform: 'translate(200 200) rotate(-90)', style: 'font-size: 20px' }, 'turned')
    r.layer.collect()
    r.layer.draw(view(1))
    expect(r.drawn[0]?.rot).toBeCloseTo(-Math.PI / 2, 9)
    expect(r.drawn[0]?.x).toBe(200)
  })

  it('sizes: exact during drag and wheel, ladder-snapped during an animated zoom', () => {
    const r = make()
    r.add(r.svg, { x: '0', y: '20', style: 'font-size: 14px' }, 'name')
    r.layer.collect()
    const k = 0.83
    r.layer.draw(view(k, 0, 0, false))
    expect(r.drawn[0]?.font).toContain(`${14 * k}px`)
    r.layer.draw(view(k, 0, 0, true))
    expect(r.drawn[0]?.font).toContain(`${14 * ladder(k)}px`)
    expect(14 * ladder(k)).not.toBe(14 * k)
    // the position is exact in both cases
    expect(r.drawn[0]?.y).toBeCloseTo(20 * k, 9)
  })

  it('a draw replaces the previous frame (the canvas is cleared)', () => {
    const r = make()
    r.add(r.svg, { x: '0', y: '20', style: 'font-size: 20px' }, 'once')
    r.layer.collect()
    r.layer.draw(view(1))
    r.layer.draw(view(1))
    expect(r.drawn).toHaveLength(1)
    expect(r.calls.filter((c) => c === 'clearRect')).toHaveLength(2)
  })
})

describe('style refresh: only what a class change can affect', () => {
  async function ready(): Promise<{ r: Rig; a: SVGTextElement; b: SVGTextElement; c: SVGTextElement }> {
    const r = make()
    const g = document.getElementById('grp') as Element
    const a = r.add(g, { x: '0', y: '20', style: 'font-size: 20px' }, 'a')
    const b = r.add(g, { x: '0', y: '40', style: 'font-size: 20px' }, 'b')
    const c = r.add(r.svg, { x: '0', y: '60', style: 'font-size: 20px' }, 'c')
    r.layer.collect()
    r.layer.draw(view(1))
    r.flush()
    await flushMutations()
    r.flush()
    return { r, a, b, c }
  }

  it('reads every label once, and none again while nothing changed', async () => {
    const { r } = await ready()
    expect(r.layer.stats.styled).toBe(3)
    r.layer.draw(view(1.2))
    r.layer.draw(view(0.9, 10, 10))
    expect(r.layer.stats.styled).toBe(0)
  })

  it('a class change on one text re-reads that text only', async () => {
    const { r, a } = await ready()
    r.layer.draw(view(1))
    a.setAttribute('class', 'hot')
    await flushMutations()
    r.flush()
    expect(r.layer.stats.styled).toBe(1)
    expect(r.layer.labels.find((l) => l.el === a)?.font).toContain('700')
    expect(r.drawn.find((d) => d.text === 'a')?.font).toContain('700')
  })

  it('a class change on a group re-reads the texts under it, not the others', async () => {
    const { r } = await ready()
    ;(document.getElementById('grp') as Element).setAttribute('class', 'dim')
    await flushMutations()
    r.flush()
    expect(r.layer.stats.styled).toBe(2)
    expect(r.drawn.find((d) => d.text === 'a')?.alpha).toBeCloseTo(0.5, 9)
    expect(r.drawn.find((d) => d.text === 'c')?.alpha).toBe(1)
  })

  it('zoom-level classes of the svg (lec-moving, lod-*) re-read nothing; any other class of the svg re-reads all', async () => {
    const { r } = await ready()
    r.svg.classList.add(MOVING_CLASS)
    r.svg.classList.add('lod-far')
    await flushMutations()
    r.flush()
    r.layer.draw(view(1))
    expect(r.layer.stats.styled).toBe(0)
    r.svg.classList.add('searching')
    await flushMutations()
    r.flush()
    expect(r.layer.stats.styled).toBe(3)
  })

  it('a theme switch on <html> re-reads all labels', async () => {
    const { r } = await ready()
    document.documentElement.setAttribute('data-lec-theme', 'datasheet')
    await flushMutations()
    r.flush()
    expect(r.layer.stats.styled).toBe(3)
    document.documentElement.removeAttribute('data-lec-theme')
  })

  it('collect() after a re-render reads the new texts and forgets the old ones', async () => {
    const { r, a } = await ready()
    a.remove()
    r.add(r.svg, { x: '0', y: '80', style: 'font-size: 20px' }, 'd')
    r.layer.collect()
    r.layer.draw(view(1))
    expect(r.layer.labels.map((l) => l.text).sort()).toEqual(['b', 'c', 'd'])
    expect(r.layer.stats.styled).toBe(3)
  })
})

describe('destroy', () => {
  it('stops observing and removes the canvas it created', async () => {
    const r = make()
    const t = r.add(r.svg, { x: '0', y: '20', style: 'font-size: 20px' }, 'a')
    r.layer.collect()
    r.layer.draw(view(1))
    r.flush()
    r.layer.destroy()
    expect(r.stage.querySelector('canvas')).toBeNull()
    r.calls.length = 0
    t.setAttribute('class', 'hot')
    await flushMutations()
    r.flush()
    expect(r.calls).toEqual([])
  })
})

// ---- fonts (WP-F1) and the style cache --------------------------------------------------------------------------------

/** A stand-in for `document.fonts`: records `load` calls, lets a test resolve them and fire `loadingdone`. */
function fakeFonts() {
  const target = new EventTarget()
  const loads: Array<{ font: string; text: string; resolve: () => void }> = []
  const fonts = Object.assign(target, {
    ready: Promise.resolve(),
    load: (font: string, text: string): Promise<unknown[]> => new Promise((resolve) => loads.push({ font, text, resolve: () => resolve([]) })),
  })
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  return {
    loads,
    done: (): void => {
      fonts.dispatchEvent(new Event('loadingdone'))
    },
    restore: (): void => {
      Reflect.deleteProperty(document, 'fonts')
    },
  }
}

type Probe = { paints: number; fontsReady: boolean }
const probeOf = (r: Rig): Probe => (r.layer.canvas as unknown as { lecLabels: Probe }).lecLabels
const charsOf = (s: string | undefined): string => [...new Set(s)].sort().join('')

describe('web fonts: the canvas does not start the downloads and the svg text is display:none, so the layer asks for them', () => {
  let fonts: ReturnType<typeof fakeFonts>
  beforeEach(() => {
    fonts = fakeFonts()
  })
  afterEach(() => fonts.restore())

  function scene(): Rig {
    const r = make()
    r.add(r.svg, { x: '0', y: '20', style: 'font-size: 20px; font-family: Noto Sans SC' }, '你好 mono')
    r.add(r.svg, { x: '0', y: '40', style: 'font-size: 20px; font-family: Noto Sans SC' }, '世界')
    r.add(r.svg, { x: '0', y: '60', style: 'font-size: 20px; font-family: JetBrains Mono; font-weight: 700' }, 'G05')
    r.layer.collect()
    r.layer.draw(view(1))
    r.flush()
    return r
  }

  it('calls document.fonts.load once per distinct font, with the characters of its labels', () => {
    scene()
    expect(fonts.loads).toHaveLength(2)
    const sans = fonts.loads.find((l) => l.font.includes('Noto Sans SC'))
    const mono = fonts.loads.find((l) => l.font.includes('JetBrains Mono'))
    expect(sans?.font).toMatch(/^normal \S+ 16px /)
    expect(charsOf(sans?.text)).toBe(charsOf('你好mono世界'))
    expect(mono?.font).toMatch(/^normal 700 16px /)
    expect(mono?.text).toBe('G05')
  })

  it('asks again only for characters it has not asked for', () => {
    const r = scene()
    const n = fonts.loads.length
    r.layer.markAllDirty()
    r.flush()
    r.layer.draw(view(1))
    expect(fonts.loads.length).toBe(n)
    r.add(r.svg, { x: '0', y: '80', style: 'font-size: 20px; font-family: Noto Sans SC' }, '世界新')
    r.layer.collect()
    r.layer.draw(view(1))
    r.flush()
    expect(fonts.loads.length).toBe(n + 1)
    expect(fonts.loads[n]?.text).toBe('新')
  })

  it('repaints when a font load resolves, and reports the fonts ready only with that paint', async () => {
    const r = scene()
    expect(probeOf(r).fontsReady).toBe(false)
    const before = probeOf(r).paints
    for (const l of fonts.loads) l.resolve()
    await Promise.resolve()
    await Promise.resolve()
    r.flush()
    expect(probeOf(r).paints).toBeGreaterThan(before)
    expect(probeOf(r).fontsReady).toBe(true)
    expect(r.drawn.map((d) => d.text).sort()).toEqual(['G05', '你好 mono', '世界'].sort())
  })

  it('repaints on loadingdone (a slice that came in for any reason), and not after destroy', () => {
    const r = scene()
    for (const l of fonts.loads) l.resolve()
    r.flush()
    r.calls.length = 0
    fonts.done()
    r.flush()
    expect(r.calls).toContain('fillText')
    r.layer.destroy()
    r.calls.length = 0
    fonts.done()
    r.flush()
    expect(r.calls).toEqual([])
  })
})

describe('style reads are kept across frames', () => {
  function spyStyle(): { calls: () => number; restore: () => void } {
    let n = 0
    const orig = window.getComputedStyle.bind(window)
    window.getComputedStyle = ((...a: Parameters<typeof orig>) => {
      n++
      return orig(...a)
    }) as typeof window.getComputedStyle
    return { calls: () => n, restore: () => void (window.getComputedStyle = orig) }
  }

  it('after the first frame and the idle pass no pan, drag or zoom frame calls getComputedStyle, also for labels that were off screen', () => {
    const r = make({ width: 1000, height: 600 })
    for (let i = 0; i < 40; i++) r.add(r.svg, { x: String(i * 300), y: '30', style: 'font-size: 16px' }, `n${i}`)
    r.layer.collect()
    r.layer.draw(view(1))
    // the first frame reads only what is on screen (the stage plus the culling margin)
    expect(r.layer.stats.styled).toBeLessThan(40)
    r.flush()
    const spy = spyStyle()
    try {
      for (let i = 0; i < 40; i++) r.layer.draw(view(1, -i * 300, 0))
      for (let i = 0; i < 10; i++) r.layer.draw(view(1 + i * 0.1, -3000, 0, true))
      expect(spy.calls()).toBe(0)
      expect(r.layer.stats.drawn).toBeGreaterThan(0)
    } finally {
      spy.restore()
    }
  })

  it('a class change and a theme switch still re-read (the restyle keeps working)', async () => {
    const r = make()
    const a = r.add(r.svg, { x: '0', y: '20', style: 'font-size: 20px' }, 'a')
    r.layer.collect()
    r.layer.draw(view(1))
    r.flush()
    const spy = spyStyle()
    try {
      a.setAttribute('class', 'hot')
      await flushMutations()
      r.flush()
      expect(spy.calls()).toBeGreaterThan(0)
      expect(r.drawn.find((d) => d.text === 'a')?.font).toContain('700')
      const n = spy.calls()
      document.documentElement.setAttribute('data-lec-theme', 'datasheet')
      await flushMutations()
      r.flush()
      expect(spy.calls()).toBeGreaterThan(n)
      document.documentElement.removeAttribute('data-lec-theme')
    } finally {
      spy.restore()
    }
  })
})

// ---- the labels wait for their web-font slices (2026-11-22: no paint may show tofu) -------------------------------------

/** `document.fonts` with a `check` the test controls: false until `arrive()` (a unicode-range slice still loading), like the browser's. */
function slowFonts() {
  const target = new EventTarget()
  let loaded = false
  const fonts = Object.assign(target, {
    ready: Promise.resolve(),
    load: (): Promise<unknown[]> => new Promise(() => undefined),
    check: (): boolean => loaded,
  })
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts })
  return {
    arrive: (): void => {
      loaded = true
      fonts.dispatchEvent(new Event('loadingdone'))
    },
    restore: (): void => void Reflect.deleteProperty(document, 'fonts'),
  }
}

type WaitProbe = { drawn: number; waiting: number; ready: boolean; gaveUp: boolean }
const waitProbeOf = (r: Rig): WaitProbe => (r.layer.canvas as unknown as { lecLabels: WaitProbe }).lecLabels

describe('fontsCover', () => {
  it('is document.fonts.check, and true when there is nothing to check or the font string is refused', () => {
    expect(fontsCover({ check: () => false }, 'normal 400 16px X', 'a')).toBe(false)
    expect(fontsCover({ check: () => true }, 'normal 400 16px X', 'a')).toBe(true)
    expect(fontsCover(undefined, 'x', 'a')).toBe(true)
    expect(
      fontsCover(
        {
          check: () => {
            throw new SyntaxError('bad font')
          },
        },
        'x',
        'a',
      ),
    ).toBe(true)
  })
})

describe('labels wait for their web-font slices instead of painting fallback glyphs', () => {
  let fonts: ReturnType<typeof slowFonts>
  beforeEach(() => {
    fonts = slowFonts()
  })
  afterEach(() => fonts.restore())

  function scene(layer: Partial<LabelLayerOptions> = {}): Rig {
    const r = make({ layer })
    r.add(r.svg, { x: '0', y: '20', style: 'font-size: 20px; font-family: Noto Sans SC' }, '你好')
    r.add(r.svg, { x: '0', y: '60', style: 'font-size: 20px; font-family: JetBrains Mono' }, 'G05')
    r.layer.collect()
    r.layer.draw(view(1))
    r.flush()
    return r
  }

  it('draws nothing while the slices are out, reports the waiting labels, and is not ready', () => {
    const r = scene()
    expect(r.drawn).toEqual([])
    expect(waitProbeOf(r)).toMatchObject({ drawn: 0, waiting: 2, ready: false, gaveUp: false })
  })

  it('draws every label and turns ready (once) when the slices arrive', () => {
    let ready = 0
    const r = scene({ onReady: () => ready++ })
    expect(ready).toBe(0)
    fonts.arrive()
    r.flush()
    expect(r.drawn.map((d) => d.text).sort()).toEqual(['G05', '你好'])
    expect(waitProbeOf(r)).toMatchObject({ drawn: 2, waiting: 0, ready: true })
    expect(ready).toBe(1)
    r.layer.draw(view(1.2))
    expect(ready).toBe(1)
  })

  it('gives up after the time limit and draws with what the browser has', async () => {
    expect(FONT_GIVE_UP_MS).toBe(3000)
    let ready = 0
    const r = scene({ fontGiveUpMs: 15, onReady: () => ready++ })
    expect(r.drawn).toEqual([])
    await new Promise((res) => setTimeout(res, 40))
    r.flush()
    expect(r.drawn.map((d) => d.text).sort()).toEqual(['G05', '你好'])
    expect(ready).toBe(1)
    expect(waitProbeOf(r).gaveUp).toBe(true)
  })
})
