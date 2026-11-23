/**
 * P4a WP-H2: the pure parts of the atlas: tree, expansion presets, layout (both skins, all presets), focus and search.
 */
import { describe, expect, it } from 'vitest'
import type { CurriculumData, CurriculumGroup } from '../../docs/.vitepress/curriculum/data.ts'
import { autoPhaseSizes } from '../../docs/.vitepress/curriculum/data.ts'
import { ancestorsToOpen, computeFocus, highlightOf, matchRows, searchHits, visibleRep } from '../../docs/.vitepress/theme/map/atlas/focus.ts'
import { clipEm, createAtlasText, estimateTextWidth, layoutAtlas } from '../../docs/.vitepress/theme/map/atlas/layout.ts'
import type { AtlasLabels, AtlasLayout } from '../../docs/.vitepress/theme/map/atlas/layout.ts'
import { ATLAS_PRESETS, buildAtlasTree, countStatuses, isNodeOpen, packageName, splitSides } from '../../docs/.vitepress/theme/map/atlas/model.ts'
import type { AtlasPreset, AtlasStatus } from '../../docs/.vitepress/theme/map/atlas/model.ts'
import { inAnchor, outAnchor, skinOfImpl } from '../../docs/.vitepress/theme/map/atlas/skins.ts'

function group(id: string, n: number, slot: number, category: string): CurriculumGroup {
  const dir = id.toLowerCase()
  const lectures = Array.from({ length: n }, (_, i) => ({ id: `${dir}-l${String(i + 1).padStart(2, '0')}`, n: i + 1, title: `${id} lecture ${i + 1} about things`, link: `/${dir}/L${i + 1}` }))
  const sizes = n > 8 ? autoPhaseSizes(n) : []
  let from = 1
  const phases = sizes.map((s) => {
    const p = { name: `${from}–${from + s - 1}`, from, to: from + s - 1 }
    from += s
    return p
  })
  return { id, dir, title: `Group ${id}`, category, catSlot: slot, lectures, phases }
}

function sample(): CurriculumData {
  const groups = [group('G01', 20, 1, 'Hardware'), group('G02', 5, 2, 'Languages'), group('G03', 31, 2, 'Languages'), group('G04', 12, 3, 'Network'), group('G05', 40, 4, 'Data')]
  const edges: [string, string][] = [
    ['g03-l01', 'g03-l02'],
    ['g03-l01', 'g03-l05'],
    ['g03-l03', 'g03-l05'],
    ['g02-l01', 'g03-l05'],
    ['g03-l05', 'g04-l02'],
    ['g03-l05', 'g05-l30'],
  ]
  return { version: 1, locale: 'root', groups, edges, stats: { groups: groups.length, lectures: groups.reduce((a, g) => a + g.lectures.length, 0), edges: edges.length } }
}

const labels: AtlasLabels = {
  range: (a, b) => `Lectures ${a}-${b}`,
  caption: (g, r, t) => `${g} groups ${r}/${t}`,
  trunk: (n) => `${n} lectures`,
  uncategorised: 'Uncategorised',
}
const text = createAtlasText(estimateTextWidth)

function run(skin: 'reader' | 'datasheet', preset: AtlasPreset, statuses: Map<string, AtlasStatus> = new Map(), open: Record<string, boolean> = {}): { layout: AtlasLayout; tree: ReturnType<typeof buildAtlasTree> } {
  const tree = buildAtlasTree(sample())
  const counts = countStatuses(tree, statuses)
  return { tree, layout: layoutAtlas({ tree, skin, text, counts, expansion: { preset, open }, labels }) }
}

describe('atlas tree', () => {
  const tree = buildAtlasTree(sample())

  it('centre > category > group > phase > lecture; groups of 8 or fewer have no phases', () => {
    expect(tree.root.kids.map((c) => c.id)).toEqual(['cat-1', 'cat-2', 'cat-3', 'cat-4'])
    expect(tree.byId.get('G02')?.kids.every((k) => k.kind === 'lec')).toBe(true)
    expect(tree.byId.get('G03')?.kids.every((k) => k.kind === 'stage')).toBe(true)
    expect(tree.byId.get('G03')?.kids.map((k) => k.lec.length)).toEqual(autoPhaseSizes(31))
    expect(tree.lectures).toHaveLength(108)
  })

  it('groups of one category share it, sorted by colour slot then group id', () => {
    expect(tree.byId.get('cat-2')?.kids.map((g) => g.id)).toEqual(['G02', 'G03'])
  })

  it('both sides hold about half of the lectures and every descendant has its category side', () => {
    const sums = { '-1': 0, '1': 0 }
    for (const c of tree.root.kids) sums[String(c.side) as '-1' | '1'] += c.lec.length
    expect(Math.abs(sums['-1'] - sums['1'])).toBeLessThanOrEqual(20)
    expect(tree.byId.get('g03-l05')?.side).toBe(tree.byId.get('cat-2')?.side)
  })

  it('splitSides: the first category is left; a single category is left; many categories use the greedy fallback', () => {
    expect(splitSides([5, 5])).toEqual([-1, 1])
    expect(splitSides([7])).toEqual([-1])
    expect(splitSides([])).toEqual([])
    const many = splitSides(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(many).toHaveLength(20)
    expect(many.includes(-1) && many.includes(1)).toBe(true)
  })

  it('prerequisites and follow-ups from the edges', () => {
    expect(tree.pre.get('g03-l05')).toEqual(['g03-l01', 'g03-l03', 'g02-l01'])
    expect(tree.post.get('g03-l05')).toEqual(['g04-l02', 'g05-l30'])
  })

  it('a lecture outside every phase joins the phase before it', () => {
    const d = sample()
    const g = d.groups.find((x) => x.id === 'G03') as CurriculumGroup
    g.phases = g.phases.slice(0, 2) // phases cover lectures 1..(sizes[0]+sizes[1]) only
    const t = buildAtlasTree(d)
    expect(t.byId.get('G03')?.kids).toHaveLength(2)
    expect(t.byId.get('G03')?.kids.reduce((n, k) => n + k.lec.length, 0)).toBe(31)
  })

  it('package names: SOIC up to 8 lectures, else DIP; the lecture count made even', () => {
    expect(packageName(5)).toBe('SOIC-6')
    expect(packageName(8)).toBe('SOIC-8')
    expect(packageName(9)).toBe('DIP-10')
    expect(packageName(31)).toBe('DIP-32')
    expect(packageName(63)).toBe('DIP-64')
  })
})

describe('expansion presets', () => {
  const tree = buildAtlasTree(sample())
  const st = new Map<string, AtlasStatus>([
    ['g03-l07', 'reading'],
    ['g03-l02', 'read'],
    ['g01-l01', 'read'],
  ])
  const counts = countStatuses(tree, st)
  const open = (id: string, preset: AtlasPreset, o: Record<string, boolean> = {}): boolean => isNodeOpen(tree.byId.get(id)!, counts, { preset, open: o })

  it('reading: a group opens when something in it is being read, its phases when anything there has progress', () => {
    expect(open('G03', 'reading')).toBe(true)
    expect(open('G01', 'reading')).toBe(false) // read only, nothing in progress
    expect(open('G03/s0', 'reading')).toBe(true) // lecture 2 read
    expect(open('G03/s2', 'reading')).toBe(false)
  })
  it('progress: a read lecture is enough; all / none; the centre and categories are always open, lectures never', () => {
    expect(open('G01', 'progress')).toBe(true)
    expect(open('G05', 'progress')).toBe(false)
    expect(open('G05', 'all')).toBe(true)
    expect(open('G03', 'none')).toBe(false)
    expect(open('cat-1', 'none')).toBe(true)
    expect(open('g03-l01', 'all')).toBe(false)
  })
  it('a choice made on one node wins over the preset', () => {
    expect(open('G03', 'all', { G03: false })).toBe(false)
    expect(open('G05', 'none', { G05: true })).toBe(true)
  })
})

describe('layout', () => {
  const statuses = new Map<string, AtlasStatus>([
    ['g03-l07', 'reading'],
    ['g03-l02', 'read'],
    ['g01-l01', 'read'],
    ['g05-l11', 'reading'],
  ])

  for (const skin of ['reader', 'datasheet'] as const) {
    for (const preset of ATLAS_PRESETS) {
      it(`${skin}, ${preset}: no two rows overlap, links stay between columns, sizes fit every row`, () => {
        const { layout } = run(skin, preset, statuses)
        const rows = layout.vis.filter((n) => n.kind === 'lec' || n.kind === 'stage' || n.kind === 'group')
        // rows of one side and one column never share a vertical band
        const byCol = new Map<string, Array<[number, number]>>()
        for (const r of rows) {
          const key = `${r.side}:${r.kind}`
          const band: [number, number] = [r.y - layout.metrics.lec / 2 + 0.01, r.y + layout.metrics.lec / 2 - 0.01]
          for (const o of byCol.get(key) ?? []) expect(band[0] >= o[1] || band[1] <= o[0], `${r.id} overlaps another ${r.kind}`).toBe(true)
          byCol.set(key, [...(byCol.get(key) ?? []), band])
        }
        for (const r of layout.vis) {
          expect(r.x0).toBeGreaterThanOrEqual(0)
          expect(r.x0 + r.w).toBeLessThanOrEqual(layout.width)
          expect(r.y).toBeGreaterThanOrEqual(0)
          expect(r.y).toBeLessThanOrEqual(layout.height)
        }
        // a link runs from the parent's side to the child's side of the centre
        for (const l of layout.links) {
          if (l.side > 0) expect(l.x2).toBeGreaterThan(l.x1)
          else expect(l.x2).toBeLessThan(l.x1)
        }
      })
    }
  }

  it('column widths come from all nodes: opening a branch does not move any column', () => {
    const a = run('reader', 'none').layout
    const b = run('reader', 'all').layout
    expect(b.X).toEqual(a.X)
    const closed = a.all.get('G03') as { xi: number }
    const opened = b.all.get('G03') as { xi: number }
    expect(opened.xi - b.ox).toBeCloseTo(closed.xi - a.ox, 1)
  })

  it('the left side is the mirror of the right: same columns, opposite side of the centre', () => {
    const { layout } = run('datasheet', 'all')
    for (const n of layout.vis) {
      if (n.kind === 'root') continue
      const rel = n.xi - layout.ox
      expect(Math.sign(rel)).toBe(n.side)
      expect(Math.abs(rel)).toBeCloseTo(layout.X[n.node.depth] as number, 1)
    }
  })

  it('a parent sits midway between its first and last child', () => {
    const { layout } = run('reader', 'all')
    for (const n of layout.vis) {
      if (!n.open || n.kind === 'root' || n.kind === 'cat' || n.node.kids.length === 0) continue
      const first = layout.all.get(n.node.kids[0]!.id)!
      const last = layout.all.get(n.node.kids[n.node.kids.length - 1]!.id)!
      expect(n.y).toBeCloseTo((first.y + last.y) / 2, 1)
    }
  })

  it('status strips: a collapsed group reserves room for one mark per lecture', () => {
    const { layout } = run('reader', 'none')
    const g = layout.all.get('G05')!
    expect(g.open).toBe(false)
    const right = Math.max(...layout.vis.map((n) => (n.side > 0 ? n.xo : 0)))
    expect(layout.width).toBeGreaterThan(right)
    expect(layout.vis.some((n) => n.kind === 'lec')).toBe(false)
  })

  it('datasheet: one pad per category on its side, no two traces of a side share a lane', () => {
    const { layout, tree } = run('datasheet', 'all')
    expect(layout.center.pads).toHaveLength(tree.root.kids.length)
    for (const side of [-1, 1] as const) {
      const cats = tree.root.kids.filter((c) => c.side === side).map((c) => layout.all.get(c.id)!)
      const up = cats.filter((c) => c.y - layout.oy < c.padY).map((c) => c.lane)
      expect(new Set(up).size).toBe(up.length)
    }
  })

  it('labels: group chip names use SOIC / DIP with the even pin count; reader phase labels use the lecture range', () => {
    const { layout } = run('reader', 'all')
    expect(layout.all.get('G02')?.pkg).toBe('SOIC-6')
    expect(layout.all.get('G03')?.pkg).toBe('DIP-32')
    expect(layout.all.get('G03/s0')?.label).toBe('Lectures 1-4')
    const ds = run('datasheet', 'all').layout
    expect(ds.all.get('G03/s0')?.label).toBe('PA0–3')
    expect(ds.all.get('G03/s1')?.label.startsWith('PB0')).toBe(true)
  })

  it('anchors differ by skin: right-angle traces enter a datasheet group on its pad', () => {
    const a = { catX: 100, rootW: 200 }
    expect(inAnchor('datasheet', { kind: 'group', side: 1, xi: 300, y: 5 }, a)).toEqual([293, 5])
    expect(inAnchor('reader', { kind: 'group', side: 1, xi: 300, y: 5 }, a)).toEqual([300, 15])
    expect(outAnchor('datasheet', { kind: 'root', side: 0, xo: 0, y: 0 }, { side: -1, padY: 11 }, a)).toEqual([-110, 11])
    expect(skinOfImpl('datasheet')).toBe('datasheet')
    expect(skinOfImpl('default')).toBe('reader')
    expect(skinOfImpl('some-pack')).toBe('reader')
  })

  it('text helpers: clipEm counts full-width characters 1 and Latin 0.55; clip cuts to a width', () => {
    expect(clipEm('abc', 17)).toBe('abc')
    expect(clipEm('一'.repeat(20), 17)).toBe(`${'一'.repeat(17)}…`)
    const t = createAtlasText(estimateTextWidth)
    const font = { size: 10, weight: 400, family: 'body' as const }
    expect(t.clip('abcdefghij', 1000, font)).toBe('abcdefghij')
    expect(t.width(t.clip('abcdefghijklmnop', 40, font), font)).toBeLessThanOrEqual(40)
  })
})

describe('focus and search', () => {
  const statuses = new Map<string, AtlasStatus>()
  it('hovering a lecture lights its branch, the rows of its direct prerequisites and follow-ups', () => {
    const { tree, layout } = run('reader', 'all', statuses)
    const f = computeFocus(tree, layout, 'g03-l05')!
    expect([...f.pre].sort()).toEqual(['g02-l01', 'g03-l01', 'g03-l03'])
    expect([...f.post].sort()).toEqual(['g04-l02', 'g05-l30'])
    expect(highlightOf(f, 'g03-l05')).toBe('hover')
    expect(highlightOf(f, 'g03-l01')).toBe('pre')
    expect(highlightOf(f, 'g04-l02')).toBe('post')
    expect(highlightOf(f, 'G03')).toBe('on')
    expect(highlightOf(f, 'g01-l01')).toBe('')
    expect(f.links.has('g03-l05')).toBe(true)
  })

  it('a prerequisite inside a collapsed branch is shown on the row that holds it', () => {
    const { tree, layout } = run('reader', 'none', statuses, { G03: true, 'G03/s1': true })
    const f = computeFocus(tree, layout, 'g03-l05')!
    // G03 and its second phase are open: lectures 1 and 3 sit in the closed first phase, the other groups' lectures in closed groups
    expect(visibleRep(tree.byId.get('g03-l01')!, layout).kind).toBe('stage')
    expect(f.pre.has('G03/s0')).toBe(true)
    expect(f.post.has('G04')).toBe(true)
    expect(f.post.has('G05')).toBe(true)
  })

  it('hovering a group or phase lights everything open below it; a hidden node cannot be focused', () => {
    const { tree, layout } = run('reader', 'all', statuses)
    const f = computeFocus(tree, layout, 'G02')!
    expect(f.on.has('g02-l03')).toBe(true)
    expect(f.on.has('G03')).toBe(false)
    const closed = run('reader', 'none', statuses)
    expect(computeFocus(closed.tree, closed.layout, 'g03-l05')).toBeNull()
  })

  it('search: title or the id of the lecture; hits inside a collapsed group light the row of the group', () => {
    const { tree, layout } = run('reader', 'none', statuses)
    expect(searchHits(tree, 'lecture 3 about')).toEqual(tree.lectures.filter((l) => l.title.toLowerCase().includes('lecture 3 about')).map((l) => l.id))
    expect(searchHits(tree, 'g02-l03')).toEqual(['g02-l03'])
    expect(searchHits(tree, '')).toEqual([])
    const rows = matchRows(tree, layout, ['g02-l03', 'g03-l04'])
    expect([...rows].sort()).toEqual(['G02', 'G03'])
  })

  it('a jump opens every branch between the lecture and its category', () => {
    const { tree } = run('reader', 'none')
    expect(ancestorsToOpen(tree.byId.get('g03-l09')!)).toEqual(['G03/s2', 'G03'])
    expect(ancestorsToOpen(tree.byId.get('g02-l01')!)).toEqual(['G02'])
  })
})
