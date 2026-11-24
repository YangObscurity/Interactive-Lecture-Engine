/**
 * S6Y audit-home #2: the reader canvas routes every group bundle through the gaps between the groups. Each bundle has
 * its own ports, no two bundles run along the same stretch (so each one can be hovered and clicked), and no bundle
 * enters a group box other than its two ends. The layouts are the group boxes of the demo builds (dumped from the
 * built canvas): the 4-group demo of v2-fix1 and the 9-group demo of s6x-demo, plus an irregular packing.
 */
import { describe, expect, it } from 'vitest'
import { routeReaderBundles, roundedRoutePath, type RouteBox } from '../../docs/.vitepress/theme/map/canvas/model'

type Box = RouteBox & { id: string }

const box = (id: string, x: number, y: number, w: number, h: number): Box => ({ id, x, y, w, h })

/** 4-group demo (v2-fix1): 2 x 2, boxes of different heights. */
const FOUR = {
  W: 1194,
  H: 788,
  boxes: [box('MEA', 642, 48, 504, 350), box('LOG', 48, 48, 504, 252), box('PLN', 642, 488, 504, 252), box('DAT', 48, 488, 504, 154)],
  bundles: ['DAT>PLN', 'LOG>PLN', 'MEA>DAT', 'MEA>PLN'],
}

/** 9-group demo (s6x-demo): 3 x 3. Before the fix MEA>PRB and MEA>PLN were one vertical line and MEA>PLN crossed PRB. */
const NINE = {
  W: 1788,
  H: 1326,
  boxes: [
    box('MEA', 642, 48, 504, 350),
    box('LOG', 48, 48, 504, 350),
    box('PRB', 642, 488, 504, 350),
    box('GEO', 48, 488, 504, 350),
    box('PLN', 642, 928, 504, 350),
    box('DAT', 1236, 48, 504, 350),
    box('VIS', 48, 928, 504, 350),
    box('EXP', 1236, 488, 504, 350),
    box('WRT', 1236, 928, 504, 252),
  ],
  bundles: [
    'DAT>PLN', 'DAT>VIS', 'DAT>EXP', 'EXP>PLN', 'LOG>EXP', 'LOG>PLN', 'LOG>PRB', 'MEA>GEO',
    'MEA>PRB', 'MEA>DAT', 'MEA>PLN', 'MEA>VIS', 'PRB>VIS', 'PRB>EXP', 'VIS>WRT',
  ],
}

/** Irregular rows (rect packing with gap 90), every group linked to several others. */
const IRREGULAR = {
  W: 2100,
  H: 1100,
  boxes: [
    box('A', 48, 48, 504, 154),
    box('B', 642, 48, 300, 400),
    box('C', 1032, 48, 700, 252),
    box('D', 48, 292, 504, 350),
    box('E', 1032, 390, 400, 154),
    box('F', 642, 538, 300, 200),
    box('G', 1522, 390, 504, 600),
    box('H', 48, 732, 900, 252),
  ],
  bundles: ['A>B', 'A>C', 'A>E', 'A>G', 'B>F', 'D>C', 'D>G', 'H>C', 'H>E', 'F>G', 'E>B', 'D>B', 'H>A', 'F>C'],
}

function route(L: { W: number; H: number; boxes: Box[]; bundles: string[] }) {
  const idx = new Map(L.boxes.map((b, i) => [b.id, i]))
  const pairs = L.bundles.map((s) => s.split('>').map((id) => idx.get(id)!) as [number, number])
  return { pairs, routes: routeReaderBundles(L.boxes, pairs, { gap: 90, width: L.W, height: L.H }) }
}

interface Seg { vert: boolean; c: number; lo: number; hi: number }
const segsOf = (pts: ReadonlyArray<readonly [number, number]>): Seg[] =>
  pts.slice(1).map((q, i) => {
    const p = pts[i]!
    const vert = Math.abs(p[0] - q[0]) < 0.01
    return vert ? { vert, c: p[0], lo: Math.min(p[1], q[1]), hi: Math.max(p[1], q[1]) } : { vert, c: p[1], lo: Math.min(p[0], q[0]), hi: Math.max(p[0], q[0]) }
  })

/** Strictly inside the box (touching its edge is fine: that is where a port sits). */
function segEntersBox(s: Seg, b: RouteBox): boolean {
  const [b0, b1, p0, p1] = s.vert ? [b.y, b.y + b.h, b.x, b.x + b.w] : [b.x, b.x + b.w, b.y, b.y + b.h]
  return s.c > p0 + 0.01 && s.c < p1 - 0.01 && s.hi > b0 + 0.01 && s.lo < b1 - 0.01
}

for (const [name, L] of [['4-group demo', FOUR], ['9-group demo', NINE], ['irregular packing', IRREGULAR]] as const) {
  describe(`reader bundle routes: ${name}`, () => {
    const { pairs, routes } = route(L)

    it('routes every bundle, orthogonally, from a side of its first group to a side of its second', () => {
      routes.forEach((r, i) => {
        expect(r, L.bundles[i]).not.toBeNull()
        const pts = r!.pts
        expect(pts.length).toBeGreaterThanOrEqual(2)
        for (const s of segsOf(pts)) expect(s.hi - s.lo).toBeGreaterThan(0)
        for (let k = 1; k < pts.length; k++) {
          const p = pts[k - 1]!
          const q = pts[k]!
          expect(Math.abs(p[0] - q[0]) < 0.01 || Math.abs(p[1] - q[1]) < 0.01, `${L.bundles[i]} segment ${k} is not orthogonal`).toBe(true)
        }
        const onEdge = (p: readonly [number, number], b: RouteBox): boolean => {
          const inX = p[0] >= b.x - 0.01 && p[0] <= b.x + b.w + 0.01
          const inY = p[1] >= b.y - 0.01 && p[1] <= b.y + b.h + 0.01
          return (inX && (Math.abs(p[1] - b.y) < 0.01 || Math.abs(p[1] - b.y - b.h) < 0.01)) || (inY && (Math.abs(p[0] - b.x) < 0.01 || Math.abs(p[0] - b.x - b.w) < 0.01))
        }
        expect(onEdge(pts[0]!, L.boxes[pairs[i]![0]]!), `${L.bundles[i]} starts on its group`).toBe(true)
        expect(onEdge(pts[pts.length - 1]!, L.boxes[pairs[i]![1]]!), `${L.bundles[i]} ends on its group`).toBe(true)
        expect(r!.d.startsWith('M')).toBe(true)
      })
    })

    it('no bundle enters any group box (its own two only at the ports)', () => {
      routes.forEach((r, i) => {
        for (const s of segsOf(r!.pts)) {
          L.boxes.forEach((b, bi) => expect(segEntersBox(s, b), `${L.bundles[i]} enters ${b.id}${pairs[i]!.includes(bi) ? ' (own)' : ''}`).toBe(false))
        }
      })
    })

    it('no two bundles share a stretch of line or a port (each can be hovered and clicked on its own)', () => {
      for (let i = 0; i < routes.length; i++) {
        for (let j = i + 1; j < routes.length; j++) {
          const a = routes[i]!.pts
          const b = routes[j]!.pts
          for (const p of [a[0]!, a[a.length - 1]!]) for (const q of [b[0]!, b[b.length - 1]!]) expect(Math.hypot(p[0] - q[0], p[1] - q[1]), `${L.bundles[i]} / ${L.bundles[j]} ports`).toBeGreaterThan(8)
          for (const s of segsOf(a)) {
            for (const t of segsOf(b)) {
              if (s.vert !== t.vert || Math.abs(s.c - t.c) >= 6) continue
              const overlap = Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo)
              expect(overlap, `${L.bundles[i]} and ${L.bundles[j]} run together`).toBeLessThan(6)
            }
          }
        }
      }
    })

    it('is deterministic', () => {
      expect(route(L).routes.map((r) => r?.d)).toEqual(routes.map((r) => r?.d))
    })
  })
}

describe('reader bundle routes: neighbours', () => {
  it('two groups side by side or one above the other get a straight line (no small S between facing ports)', () => {
    const four = route(FOUR).routes
    expect(four[FOUR.bundles.indexOf('DAT>PLN')]!.pts).toHaveLength(2)
    expect(four[FOUR.bundles.indexOf('MEA>PLN')]!.pts).toHaveLength(2)
    const nine = route(NINE).routes
    for (const b of ['MEA>PRB', 'MEA>DAT', 'DAT>EXP', 'PRB>EXP']) expect(nine[NINE.bundles.indexOf(b)]!.pts, b).toHaveLength(2)
  })
})

describe('roundedRoutePath', () => {
  it('rounds the corners and ends on the last point with a straight piece', () => {
    const d = roundedRoutePath([[0, 0], [0, 100], [200, 100]])
    expect(d).toBe('M0 0L0 74Q0 100 26 100L200 100')
  })
  it('keeps a straight route straight', () => {
    expect(roundedRoutePath([[10, 0], [10, 90]])).toBe('M10 0L10 90')
  })
})
