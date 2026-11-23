import { describe, expect, it } from 'vitest'
import {
  BOX_PAD,
  DEFAULT_INSETS,
  KEEP_PX,
  LADDER_STEPS,
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_STEP,
  boxTransform,
  centerOn,
  clampTransform,
  clampZoom,
  cssTransform,
  easeOutCubic,
  fitTransform,
  isDrag,
  keyAction,
  ladder,
  ladderDown,
  lerpTransform,
  panToTarget,
  wheelFactor,
  wheelZooms,
  zoomAbout,
  type Transform,
} from '../../docs/.vitepress/theme/map/geometry'

const view = { width: 1000, height: 600 }
const content = { width: 4000, height: 2000 }
const screenOf = (t: Transform, cx: number, cy: number): [number, number] => [t.x + cx * t.k, t.y + cy * t.k]

describe('zoom about a point', () => {
  it('keeps the canvas point under the pointer where it was', () => {
    const t: Transform = { k: 0.5, x: -120, y: 40 }
    const px = 430
    const py = 210
    const canvasPoint: [number, number] = [(px - t.x) / t.k, (py - t.y) / t.k]
    for (const f of [0.5, 0.8, 1.25, 1.4, 3]) {
      const z = zoomAbout(t, f, px, py)
      const [sx, sy] = screenOf(z, canvasPoint[0], canvasPoint[1])
      expect(sx).toBeCloseTo(px, 9)
      expect(sy).toBeCloseTo(py, 9)
      expect(z.k).toBeCloseTo(t.k * f, 12)
    }
  })

  it('clamps the scale to 0.05 .. 2.5 and still keeps the point fixed at the limit', () => {
    const t: Transform = { k: 2, x: 10, y: 20 }
    const z = zoomAbout(t, 10, 300, 300)
    expect(z.k).toBe(MAX_ZOOM)
    const cp: [number, number] = [(300 - t.x) / t.k, (300 - t.y) / t.k]
    expect(screenOf(z, cp[0], cp[1])[0]).toBeCloseTo(300, 9)
    const o = zoomAbout({ k: 0.06, x: 0, y: 0 }, 0.01, 0, 0)
    expect(o.k).toBe(MIN_ZOOM)
    expect(clampZoom(99)).toBe(MAX_ZOOM)
    expect(clampZoom(0)).toBe(MIN_ZOOM)
  })

  it('zooming in and out by the same factor returns to the start (away from the limits)', () => {
    const t: Transform = { k: 0.4, x: 33, y: -77 }
    const back = zoomAbout(zoomAbout(t, 1.4, 500, 300), 1 / 1.4, 500, 300)
    expect(back.k).toBeCloseTo(t.k, 12)
    expect(back.x).toBeCloseTo(t.x, 9)
    expect(back.y).toBeCloseTo(t.y, 9)
  })
})

describe('fit', () => {
  it('shows the whole content, centred, below the 56 px HUD row, at 96% of the free area', () => {
    const f = fitTransform(content, view)
    expect(f.k).toBeCloseTo(Math.min(1000 / 4000, (600 - 56) / 2000) * 0.96, 12)
    expect(f.x + (content.width * f.k) / 2).toBeCloseTo(view.width / 2, 9)
    expect(f.y + (content.height * f.k) / 2).toBeCloseTo(56 + (view.height - 56) / 2, 9)
    // the content is inside the stage on every side
    expect(f.x).toBeGreaterThanOrEqual(0)
    expect(f.y).toBeGreaterThanOrEqual(56)
    expect(f.x + content.width * f.k).toBeLessThanOrEqual(view.width)
    expect(f.y + content.height * f.k).toBeLessThanOrEqual(view.height)
  })

  it('is limited by the width for a wide content and by the height for a tall one', () => {
    expect(fitTransform({ width: 8000, height: 100 }, view).k).toBeCloseTo((1000 / 8000) * 0.96, 12)
    expect(fitTransform({ width: 100, height: 8000 }, view).k).toBeCloseTo(((600 - 56) / 8000) * 0.96, 12)
  })
})

describe('bounds: the content keeps at least 80 px inside the stage', () => {
  it('uses 80 px', () => expect(KEEP_PX).toBe(80))

  it('pushes a view that went too far right / down back so that 80 px of the content remain', () => {
    const c = clampTransform({ k: 1, x: 5000, y: 5000 }, content, view)
    expect(c).toEqual({ k: 1, x: view.width - 80, y: view.height - 80 })
  })

  it('pushes a view that went too far left / up back so that 80 px of the content remain', () => {
    const c = clampTransform({ k: 0.5, x: -99999, y: -99999 }, content, view)
    expect(c.x).toBe(80 - content.width * 0.5)
    expect(c.y).toBe(80 - content.height * 0.5)
    // the right edge of the content is exactly 80 px inside
    expect(c.x + content.width * c.k).toBe(80)
  })

  it('does not touch a view that is inside, nor the scale', () => {
    const t: Transform = { k: 0.37, x: 100, y: 50 }
    expect(clampTransform(t, content, view)).toEqual(t)
  })

  it('clamps an axis independently of the other', () => {
    const c = clampTransform({ k: 1, x: 100, y: 99999 }, content, view)
    expect(c.x).toBe(100)
    expect(c.y).toBe(view.height - 80)
  })

  it('accepts another keep distance', () => {
    expect(clampTransform({ k: 1, x: 5000, y: 0 }, content, view, 10).x).toBe(990)
  })
})

describe('the 2^(1/4) ladder', () => {
  it('has four steps per octave', () => expect(LADDER_STEPS).toBe(4))

  it('snaps to the nearest 2^(n/4)', () => {
    expect(ladder(1)).toBe(1)
    expect(ladder(2)).toBeCloseTo(2, 12)
    expect(ladder(0.5)).toBeCloseTo(0.5, 12)
    expect(ladder(Math.pow(2, 0.25))).toBeCloseTo(Math.pow(2, 0.25), 12)
    // log2(1.1) * 4 = 0.55 rounds to 1, so 1.1 snaps up to the step 2^(1/4); log2(1.05) * 4 = 0.28 rounds to 0
    expect(ladder(1.1)).toBeCloseTo(Math.pow(2, 0.25), 12)
    expect(ladder(1.05)).toBe(1)
  })

  it('is idempotent and monotone, and every result is a ladder step', () => {
    let prev = 0
    for (let k = 0.05; k <= 2.5; k *= 1.013) {
      const l = ladder(k)
      expect(ladder(l)).toBeCloseTo(l, 12)
      expect(l).toBeGreaterThanOrEqual(prev)
      prev = l
      const n = Math.log2(l) * 4
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9)
      // never more than half a step (a factor 2^(1/8)) away
      expect(Math.abs(Math.log2(l / k))).toBeLessThanOrEqual(1 / 8 + 1e-12)
    }
  })

  it('ladderDown never rounds up, and keeps a value that is already a step', () => {
    expect(ladderDown(1)).toBe(1)
    expect(ladderDown(1.18)).toBeCloseTo(1, 12) // 2^(1/4) = 1.189
    expect(ladderDown(1.19)).toBeCloseTo(Math.pow(2, 0.25), 12)
    expect(ladderDown(Math.pow(2, 0.75))).toBeCloseTo(Math.pow(2, 0.75), 12)
    for (let k = 0.05; k <= 2.5; k *= 1.017) {
      const d = ladderDown(k)
      expect(d).toBeLessThanOrEqual(k * (1 + 1e-9))
      expect(d).toBeGreaterThan(k / Math.pow(2, 0.25) - 1e-9)
    }
  })
})

describe('jump targets', () => {
  it('centerOn puts the canvas point in the middle of the stage', () => {
    const t = centerOn(700, 300, view, 0.8)
    expect(screenOf(t, 700, 300)).toEqual([500, 300])
  })

  it('panToTarget centres the point at a ladder scale of at least 0.7', () => {
    const near = panToTarget({ k: 1.3, x: 0, y: 0 }, 100, 100, view)
    expect(near.k).toBe(ladder(1.3))
    const far = panToTarget({ k: 0.1, x: 0, y: 0 }, 100, 100, view)
    expect(far.k).toBe(ladder(0.7))
    expect(far.k).toBeGreaterThan(0.6)
    expect(screenOf(far, 100, 100)).toEqual([500, 300])
  })

  it('boxTransform fits the whole box with padding inside the free area, at a ladder scale', () => {
    const box = { x: 1000, y: 400, w: 800, h: 300 }
    const t = boxTransform(box, view)
    const free = { w: view.width - DEFAULT_INSETS.left - DEFAULT_INSETS.right, h: view.height - DEFAULT_INSETS.top - DEFAULT_INSETS.bottom }
    expect(t.k).toBeLessThanOrEqual(Math.min(free.w / (box.w + 2 * BOX_PAD), free.h / (box.h + 2 * BOX_PAD)) + 1e-12)
    const n = Math.log2(t.k) * 4
    expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9)
    // the box is fully visible, clear of the HUD insets
    const [x0, y0] = screenOf(t, box.x, box.y)
    const [x1, y1] = screenOf(t, box.x + box.w, box.y + box.h)
    expect(x0).toBeGreaterThanOrEqual(DEFAULT_INSETS.left)
    expect(y0).toBeGreaterThanOrEqual(DEFAULT_INSETS.top)
    expect(x1).toBeLessThanOrEqual(view.width - DEFAULT_INSETS.right)
    expect(y1).toBeLessThanOrEqual(view.height - DEFAULT_INSETS.bottom)
    // and centred in the free area
    expect((x0 + x1) / 2).toBeCloseTo(DEFAULT_INSETS.left + free.w / 2, 9)
    expect((y0 + y1) / 2).toBeCloseTo(DEFAULT_INSETS.top + free.h / 2, 9)
  })

  it('boxTransform keeps the box clear of a side panel and stays within the zoom limits', () => {
    const t = boxTransform({ x: 0, y: 0, w: 100, h: 100 }, view, { top: 56, bottom: 48, left: 400, right: 16 })
    const [x0] = screenOf(t, 0, 0)
    expect(x0).toBeGreaterThanOrEqual(400)
    expect(t.k).toBeLessThanOrEqual(MAX_ZOOM)
    expect(boxTransform({ x: 0, y: 0, w: 1e7, h: 1e7 }, view).k).toBeGreaterThanOrEqual(ladderDown(MIN_ZOOM) - 1e-12)
  })
})

describe('animation helpers', () => {
  it('lerp and ease run from the start to the target', () => {
    const a: Transform = { k: 1, x: 0, y: 0 }
    const b: Transform = { k: 2, x: 100, y: -50 }
    expect(lerpTransform(a, b, easeOutCubic(0))).toEqual(a)
    expect(lerpTransform(a, b, easeOutCubic(1))).toEqual(b)
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5) // ease-out: fast start
    let prev = -1
    for (let u = 0; u <= 1; u += 0.1) {
      expect(easeOutCubic(u)).toBeGreaterThan(prev)
      prev = easeOutCubic(u)
    }
  })

  it('writes the css transform the svg carries', () => {
    expect(cssTransform({ k: 0.5, x: 10, y: -20 })).toBe('translate(10px,-20px) scale(0.5)')
  })
})

describe('input rules', () => {
  it('wheel: the page scrolls unless the map is active or Ctrl / Cmd is held', () => {
    expect(wheelZooms({ active: false, ctrlKey: false, metaKey: false })).toBe(false)
    expect(wheelZooms({ active: true, ctrlKey: false, metaKey: false })).toBe(true)
    expect(wheelZooms({ active: false, ctrlKey: true, metaKey: false })).toBe(true)
    expect(wheelZooms({ active: false, ctrlKey: false, metaKey: true })).toBe(true)
  })

  it('wheel factor: exp(-deltaY * 0.0015); up zooms in, down zooms out', () => {
    expect(wheelFactor(0)).toBe(1)
    expect(wheelFactor(-100)).toBeCloseTo(Math.exp(0.15), 12)
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(100) * wheelFactor(-100)).toBeCloseTo(1, 12)
  })

  it('keys: + / = / - zoom, arrows pan by 80 px (the content follows the arrow), Esc leaves, others are not ours', () => {
    expect(keyAction('+')).toEqual({ type: 'zoom', factor: 1.25 })
    expect(keyAction('=')).toEqual({ type: 'zoom', factor: 1.25 })
    expect(keyAction('-')).toEqual({ type: 'zoom', factor: 1 / 1.25 })
    expect(keyAction('ArrowLeft')).toEqual({ type: 'pan', dx: PAN_STEP, dy: 0 })
    expect(keyAction('ArrowRight')).toEqual({ type: 'pan', dx: -PAN_STEP, dy: 0 })
    expect(keyAction('ArrowUp')).toEqual({ type: 'pan', dx: 0, dy: PAN_STEP })
    expect(keyAction('ArrowDown')).toEqual({ type: 'pan', dx: 0, dy: -PAN_STEP })
    expect(keyAction('Escape')).toEqual({ type: 'escape' })
    expect(keyAction('a')).toBeNull()
    expect(keyAction('Enter')).toBeNull()
    expect(PAN_STEP).toBe(80)
  })

  it('a press becomes a drag after more than 4 px of travel', () => {
    expect(isDrag(3, 0)).toBe(false)
    expect(isDrag(4, 0)).toBe(false)
    expect(isDrag(3, 3)).toBe(true)
    expect(isDrag(0, 5)).toBe(true)
  })
})
