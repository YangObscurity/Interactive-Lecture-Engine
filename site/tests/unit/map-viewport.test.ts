// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MapViewport, STAGE_ACTIVE_CLASS, STAGE_DRAGGING_CLASS, STAGE_MOVED_CLASS } from '../../docs/.vitepress/theme/map/viewport'
import { MOVING_CLASS } from '../../docs/.vitepress/theme/map/labels'
import { ladder, type Transform } from '../../docs/.vitepress/theme/map/geometry'
import type { LabelView } from '../../docs/.vitepress/theme/map/labels'

const CONTENT = { width: 4000, height: 2000 }

interface Rig {
  stage: HTMLElement
  svg: SVGSVGElement
  hud: HTMLElement
  input: HTMLInputElement
  vp: MapViewport
  places: LabelView[]
  commits: Transform[]
  frames: Array<(t: number) => void>
  clock: { t: number }
  /** Run animation frames until none is pending (each step advances 16 ms). */
  runFrames(max?: number): number
  onEscape: ReturnType<typeof vi.fn>
}

function rig(opts: { reducedMotion?: boolean } = {}): Rig {
  document.body.innerHTML =
    '<section id="stage" tabindex="0"><div class="hud"><button id="b">zoom</button></div><input id="q" /><svg id="svg"></svg></section><div id="outside"></div>'
  const stage = document.getElementById('stage') as HTMLElement
  const svg = document.getElementById('svg') as unknown as SVGSVGElement
  stage.getBoundingClientRect = () => ({ width: 1000, height: 600, left: 0, top: 0, right: 1000, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
  const frames: Array<(t: number) => void> = []
  const clock = { t: 0 }
  const onEscape = vi.fn(() => false)
  const vp = new MapViewport({
    stage,
    svg,
    content: () => CONTENT,
    ignore: '.hud',
    reducedMotion: () => opts.reducedMotion === true,
    onEscape,
    now: () => clock.t,
    requestFrame: (cb) => frames.push(cb),
  })
  const places: LabelView[] = []
  const commits: Transform[] = []
  vp.on('place', (v) => places.push(v))
  vp.on('commit', (t) => commits.push(t))
  return {
    stage,
    svg,
    hud: stage.querySelector('.hud') as HTMLElement,
    input: document.getElementById('q') as HTMLInputElement,
    vp,
    places,
    commits,
    frames,
    clock,
    onEscape,
    runFrames(max = 200) {
      let n = 0
      while (frames.length && n < max) {
        clock.t += 16
        frames.shift()?.(clock.t)
        n++
      }
      return n
    },
  }
}

const mouse = (type: string, x: number, y: number, extra: MouseEventInit = {}): MouseEvent => new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, ...extra })
const wheel = (target: EventTarget, deltaY: number, x = 500, y = 300, extra: WheelEventInit = {}): WheelEvent => {
  const ev = new WheelEvent('wheel', { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true, ...extra })
  // happy-dom's WheelEvent does not carry the position and modifier keys of its init: set them
  Object.defineProperty(ev, 'clientX', { value: x })
  Object.defineProperty(ev, 'clientY', { value: y })
  Object.defineProperty(ev, 'ctrlKey', { value: extra.ctrlKey === true })
  Object.defineProperty(ev, 'metaKey', { value: extra.metaKey === true })
  target.dispatchEvent(ev)
  return ev
}
const key = (target: EventTarget, k: string): KeyboardEvent => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  target.dispatchEvent(ev)
  return ev
}
const press = (r: Rig, x: number, y: number, to?: [number, number]): void => {
  r.stage.dispatchEvent(mouse('pointerdown', x, y))
  if (to) window.dispatchEvent(mouse('pointermove', to[0], to[1]))
  window.dispatchEvent(mouse('pointerup', to ? to[0] : x, to ? to[1] : y))
}

let live: Rig | null = null
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  live?.vp.destroy()
  live = null
  vi.useRealTimers()
})
const make = (o: { reducedMotion?: boolean } = {}): Rig => (live = rig(o))

describe('fit and the svg transform', () => {
  it('puts the view on the svg as a CSS transform, settles, and tells the observers', () => {
    const r = make()
    r.vp.fit()
    const v = r.vp.view
    expect(r.svg.style.transform).toBe(`translate(${v.x}px,${v.y}px) scale(${v.k})`)
    expect(r.svg.style.getPropertyValue('--k')).toBe(String(v.k))
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(false)
    expect(r.commits).toHaveLength(1)
    expect(r.places.at(-1)).toEqual({ transform: v, ladder: false })
    // fit is not a reader movement: the hint stays
    expect(r.vp.touched).toBe(false)
    expect(r.stage.classList.contains(STAGE_MOVED_CLASS)).toBe(false)
  })

  it('clamps: after a huge pan 80 px of the content stay inside', () => {
    const r = make()
    r.vp.fit()
    r.vp.panBy(1e6, 1e6)
    expect(r.vp.view.x).toBe(1000 - 80)
    expect(r.vp.view.y).toBe(600 - 80)
    r.vp.panBy(-1e7, -1e7)
    const k = r.vp.view.k
    expect(r.vp.view.x).toBe(80 - CONTENT.width * k)
    expect(r.vp.view.y).toBe(80 - CONTENT.height * k)
  })
})

describe('the wheel needs a click first, or Ctrl / Cmd', () => {
  it('does nothing (the page scrolls) before the map is active', () => {
    const r = make()
    r.vp.fit()
    const before = r.vp.view
    const ev = wheel(r.stage, -120)
    expect(ev.defaultPrevented).toBe(false)
    expect(r.vp.view).toEqual(before)
  })

  it('zooms about the pointer with Ctrl held, live (lec-moving) and settles 140 ms after the last event', () => {
    const r = make()
    r.vp.fit()
    r.commits.length = 0
    const k0 = r.vp.view.k
    const ev = wheel(r.stage, -120, 700, 200, { ctrlKey: true })
    expect(ev.defaultPrevented).toBe(true)
    const v1 = r.vp.view
    expect(v1.k).toBeCloseTo(k0 * Math.exp(120 * 0.0015), 9)
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(true)
    expect(r.vp.touched).toBe(true)
    vi.advanceTimersByTime(100)
    wheel(r.stage, -120, 700, 200, { ctrlKey: true })
    vi.advanceTimersByTime(139)
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(true)
    expect(r.commits).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(false)
    expect(r.commits).toHaveLength(1)
  })

  it('keeps the canvas point under the pointer fixed', () => {
    const r = make()
    r.vp.fit()
    const v0 = r.vp.view
    const cx = (700 - v0.x) / v0.k
    const cy = (200 - v0.y) / v0.k
    wheel(r.stage, -240, 700, 200, { metaKey: true })
    const v1 = r.vp.view
    expect(v1.x + cx * v1.k).toBeCloseTo(700, 6)
    expect(v1.y + cy * v1.k).toBeCloseTo(200, 6)
  })

  it('never snaps label sizes to the ladder while the wheel moves the view', () => {
    const r = make()
    r.vp.fit()
    r.places.length = 0
    wheel(r.stage, -77, 400, 300, { ctrlKey: true })
    wheel(r.stage, -33, 400, 300, { ctrlKey: true })
    expect(r.places.length).toBeGreaterThanOrEqual(2)
    expect(r.places.every((p) => p.ladder === false)).toBe(true)
  })

  it('clicking the map activates it, then the plain wheel zooms; a press outside, or Esc, deactivates', () => {
    const r = make()
    r.vp.fit()
    press(r, 500, 300)
    expect(r.vp.active).toBe(true)
    expect(r.stage.classList.contains(STAGE_ACTIVE_CLASS)).toBe(true)
    const k0 = r.vp.view.k
    expect(wheel(r.stage, -100).defaultPrevented).toBe(true)
    expect(r.vp.view.k).toBeGreaterThan(k0)

    document.getElementById('outside')?.dispatchEvent(mouse('pointerdown', 5, 5))
    expect(r.vp.active).toBe(false)
    expect(r.stage.classList.contains(STAGE_ACTIVE_CLASS)).toBe(false)

    press(r, 500, 300)
    expect(r.vp.active).toBe(true)
    r.onEscape.mockReturnValueOnce(false)
    key(r.stage, 'Escape')
    expect(r.vp.active).toBe(false)
  })

  it('Esc first offers the key to onEscape (a locked selection is cleared) and stays active when it was taken', () => {
    const r = make()
    press(r, 500, 300)
    r.onEscape.mockReturnValueOnce(true)
    expect(key(r.stage, 'Escape').defaultPrevented).toBe(true)
    expect(r.onEscape).toHaveBeenCalledTimes(1)
    expect(r.vp.active).toBe(true)
  })

  it('a press or wheel on the HUD is not the map\'s', () => {
    const r = make()
    r.vp.fit()
    r.hud.dispatchEvent(mouse('pointerdown', 20, 20))
    window.dispatchEvent(mouse('pointerup', 20, 20))
    expect(r.vp.active).toBe(false)
    press(r, 500, 300)
    const before = r.vp.view
    expect(wheel(r.hud, -500).defaultPrevented).toBe(false)
    expect(r.vp.view).toEqual(before)
  })
})

describe('dragging', () => {
  it('moves the view live past 4 px, commits on release, and does not activate', () => {
    const r = make()
    r.vp.fit()
    r.commits.length = 0
    const v0 = r.vp.view
    r.stage.dispatchEvent(mouse('pointerdown', 300, 300))
    window.dispatchEvent(mouse('pointermove', 303, 300)) // 3 px: still a press
    expect(r.vp.view).toEqual(v0)
    window.dispatchEvent(mouse('pointermove', 340, 330))
    expect(r.stage.classList.contains(STAGE_DRAGGING_CLASS)).toBe(true)
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(true)
    expect(r.vp.view.x).toBeCloseTo(v0.x + 40, 9)
    expect(r.vp.view.y).toBeCloseTo(v0.y + 30, 9)
    expect(r.vp.touched).toBe(true)
    window.dispatchEvent(mouse('pointerup', 340, 330))
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(false)
    expect(r.stage.classList.contains(STAGE_DRAGGING_CLASS)).toBe(false)
    expect(r.commits).toHaveLength(1)
    expect(r.vp.active).toBe(false)
    // the click that follows the release is a drag, not a click, until the next task
    expect(r.vp.wasDragged).toBe(true)
    vi.advanceTimersByTime(1)
    expect(r.vp.wasDragged).toBe(false)
  })

  it('never snaps the label sizes while dragging, even right after an animated zoom was interrupted', () => {
    const r = make()
    r.vp.fit()
    r.vp.zoomToBox({ x: 100, y: 100, w: 300, h: 200 })
    r.runFrames(3)
    expect(r.places.at(-1)?.ladder).toBe(true) // mid-animation
    r.places.length = 0
    r.stage.dispatchEvent(mouse('pointerdown', 300, 300))
    window.dispatchEvent(mouse('pointermove', 360, 300))
    expect(r.places.length).toBeGreaterThan(0)
    expect(r.places.every((p) => p.ladder === false)).toBe(true)
    window.dispatchEvent(mouse('pointerup', 360, 300))
    const settled = r.vp.view
    const commits = r.commits.length
    r.runFrames() // the frame that was already queued does nothing
    expect(r.vp.view).toEqual(settled)
    expect(r.commits).toHaveLength(commits)
  })
})

describe('keys', () => {
  it('+ and - zoom about the middle of the stage by 1.25, arrows pan by 80 px, keys are prevented', () => {
    const r = make()
    r.vp.fit()
    r.vp.panBy(0, 0)
    const v0 = r.vp.view
    expect(key(r.stage, '+').defaultPrevented).toBe(true)
    const v1 = r.vp.view
    expect(v1.k).toBeCloseTo(v0.k * 1.25, 12)
    expect(v1.x + ((500 - v0.x) / v0.k) * v1.k).toBeCloseTo(500, 6)
    key(r.stage, '-')
    expect(r.vp.view.k).toBeCloseTo(v0.k, 12)
    const before = r.vp.view
    key(r.stage, 'ArrowLeft')
    expect(r.vp.view.x).toBeCloseTo(before.x + 80, 9)
    key(r.stage, 'ArrowDown')
    expect(r.vp.view.y).toBeCloseTo(before.y - 80, 9)
    key(r.stage, 'ArrowRight')
    key(r.stage, 'ArrowUp')
    expect(r.vp.view.x).toBeCloseTo(before.x, 9)
    expect(r.vp.view.y).toBeCloseTo(before.y, 9)
  })

  it('leaves other keys alone, and keys typed into an input inside the stage', () => {
    const r = make()
    r.vp.fit()
    expect(key(r.stage, 'a').defaultPrevented).toBe(false)
    expect(key(r.stage, 'Enter').defaultPrevented).toBe(false)
    const before = r.vp.view
    const typed = key(r.input, '+')
    expect(typed.defaultPrevented).toBe(false)
    expect(r.vp.view).toEqual(before)
    key(r.input, 'ArrowLeft')
    expect(r.vp.view).toEqual(before)
  })
})

describe('animated movement and prefers-reduced-motion', () => {
  it('zoomToBox animates, snaps label sizes to the ladder while it runs, and lands exactly on a ladder scale', () => {
    const r = make()
    r.vp.fit()
    r.places.length = 0
    r.commits.length = 0
    r.vp.zoomToBox({ x: 1000, y: 500, w: 600, h: 300 })
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(true)
    const frames = r.runFrames()
    expect(frames).toBeGreaterThan(10) // ~380 ms at 16 ms
    expect(r.commits).toHaveLength(1)
    const end = r.commits[0] as Transform
    expect(end.k).toBeCloseTo(ladder(end.k), 12)
    expect(r.places.slice(0, -1).every((p) => p.ladder === true)).toBe(true)
    expect(r.places.at(-1)?.ladder).toBe(false) // the settled frame is drawn at the exact scale
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(false)
    expect(r.vp.touched).toBe(true)
  })

  it('panTo centres the point at a ladder scale of at least 0.7', () => {
    const r = make()
    r.vp.fit()
    r.vp.panTo(2000, 1000)
    r.runFrames()
    const v = r.vp.view
    expect(v.k).toBeCloseTo(ladder(0.7), 12)
    expect(v.x + 2000 * v.k).toBeCloseTo(500, 6)
    expect(v.y + 1000 * v.k).toBeCloseTo(300, 6)
  })

  it('a new movement cancels the running animation', () => {
    const r = make()
    r.vp.fit()
    r.vp.panTo(2000, 1000)
    r.runFrames(2)
    r.vp.setView({ k: 0.3, x: 10, y: 10 })
    const after = r.vp.view
    const commits = r.commits.length
    r.runFrames() // the frame that was already queued does nothing
    expect(r.vp.view).toEqual(after)
    expect(r.commits).toHaveLength(commits)
  })

  it('with reduced motion the view jumps to the target in one step, without lec-moving', () => {
    const r = make({ reducedMotion: true })
    r.vp.fit()
    r.places.length = 0
    r.vp.zoomToBox({ x: 1000, y: 500, w: 600, h: 300 })
    expect(r.frames).toHaveLength(0)
    expect(r.places).toHaveLength(1)
    expect(r.places[0]?.ladder).toBe(false)
    expect(r.svg.classList.contains(MOVING_CLASS)).toBe(false)
    const k = r.vp.view.k
    expect(k).toBeCloseTo(ladder(k), 12)
  })
})

describe('window resize', () => {
  it('refits a map nobody has touched and keeps the view of one the reader moved', () => {
    const r = make()
    r.vp.fit()
    const resized = vi.fn()
    r.vp.on('resize', resized)
    r.stage.getBoundingClientRect = () => ({ width: 500, height: 400, left: 0, top: 0, right: 500, bottom: 400, x: 0, y: 0, toJSON: () => ({}) })
    window.dispatchEvent(new Event('resize'))
    expect(resized).toHaveBeenCalledTimes(1)
    expect(r.vp.view.k).toBeCloseTo(Math.min(500 / CONTENT.width, (400 - 56) / CONTENT.height) * 0.96, 12)

    r.vp.zoomBy(1.4)
    const kept = r.vp.view.k
    r.stage.getBoundingClientRect = () => ({ width: 900, height: 700, left: 0, top: 0, right: 900, bottom: 700, x: 0, y: 0, toJSON: () => ({}) })
    window.dispatchEvent(new Event('resize'))
    expect(r.vp.view.k).toBeCloseTo(kept, 12)
  })
})

describe('destroy', () => {
  it('removes every listener and clears the classes', () => {
    const r = make()
    r.vp.fit()
    press(r, 500, 300)
    r.vp.destroy()
    const before = r.vp.view
    wheel(r.stage, -500, 500, 300, { ctrlKey: true })
    key(r.stage, '+')
    window.dispatchEvent(new Event('resize'))
    expect(r.vp.view).toEqual(before)
    expect(r.stage.classList.contains(STAGE_ACTIVE_CLASS)).toBe(false)
  })
})
