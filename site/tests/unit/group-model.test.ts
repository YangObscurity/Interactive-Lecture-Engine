import { describe, expect, it } from 'vitest'
import {
  anchor,
  byOrder,
  closure,
  edgePath,
  edgeStyleOf,
  groupLinks,
  indexCurriculum,
  isReady,
  lanesOf,
  lecStatusOf,
  newlyReady,
  parseTrackHash,
  pinCount,
  progressOf,
  readySet,
  rolesOf,
  trackHash,
  type LecStatus,
} from '../../docs/.vitepress/theme/group/model'
import type { CurriculumData, CurriculumGroup } from '../../docs/.vitepress/curriculum/data'
import { checkLayoutDeclaration } from '../../docs/.vitepress/theme/slots/contract'
import { parseThemePack } from '../../docs/.vitepress/theme/tokens/pack'

function group(id: string, n: number, cat: (i: number) => string | undefined = () => undefined): CurriculumGroup {
  const dir = id.toLowerCase()
  return {
    id,
    dir,
    title: `${id} title`,
    category: '',
    catSlot: 1,
    phases: [],
    lectures: Array.from({ length: n }, (_, i) => ({ id: `${dir}-l${String(i + 1).padStart(2, '0')}`, n: i + 1, title: `t${i + 1}`, link: `/${dir}/L${i + 1}`, ...(cat(i + 1) ? { category: cat(i + 1) as string } : {}) })),
  }
}

// a1 -> a2 -> a3 -> a4, a2 -> a5, b1 -> a3 (cross group), a4 -> b2; c has no relations
function data(): CurriculumData {
  const groups = [group('A', 5, (i) => (i < 3 ? 'one' : 'two')), group('B', 2), group('C', 3)]
  const e: Array<[string, string]> = [
    ['a-l01', 'a-l02'],
    ['a-l02', 'a-l03'],
    ['a-l03', 'a-l04'],
    ['a-l02', 'a-l05'],
    ['b-l01', 'a-l03'],
    ['a-l04', 'b-l02'],
  ]
  return { version: 1, locale: 'root', groups, edges: e, stats: { groups: 3, lectures: 10, edges: e.length } }
}

const idx = indexCurriculum(data())
const allRead = (s: Record<string, LecStatus>) => (id: string): LecStatus => s[id] ?? 'unread'

describe('statuses', () => {
  it('maps the store values both ways', () => {
    expect(lecStatusOf('completed')).toBe('read')
    expect(lecStatusOf('in_progress')).toBe('reading')
    expect(lecStatusOf('not_started')).toBe('unread')
    expect(progressOf('read')).toBe('completed')
    expect(progressOf('reading')).toBe('in_progress')
    expect(progressOf('unread')).toBe('not_started')
  })
})

describe('index and readiness', () => {
  it('knows which groups have relation data', () => {
    expect([...idx.graphGroups].sort()).toEqual(['A', 'B'])
  })
  it('ready = unread, group with relations, every prerequisite read (also across groups)', () => {
    const s = allRead({ 'a-l01': 'read' })
    expect(isReady('a-l02', idx, s)).toBe(true)
    expect(isReady('a-l03', idx, s)).toBe(false)
    expect(isReady('a-l03', idx, allRead({ 'a-l01': 'read', 'a-l02': 'read' }))).toBe(false) // b-l01 (other group) is not read
    expect(isReady('a-l03', idx, allRead({ 'a-l02': 'read', 'b-l01': 'read' }))).toBe(true)
    expect(isReady('a-l01', idx, allRead({}))).toBe(true) // no prerequisite at all
    expect(isReady('a-l01', idx, allRead({ 'a-l01': 'reading' }))).toBe(false) // only unread lectures
    expect(isReady('c-l01', idx, allRead({}))).toBe(false) // group without relation data
    expect(isReady('zz-l01', idx, allRead({}))).toBe(false)
  })
  it('readySet and newlyReady see what a write changes', () => {
    const ids = ['a-l01', 'a-l02', 'a-l03', 'a-l05']
    const before = readySet(ids, idx, allRead({ 'a-l01': 'read' }))
    const after = readySet(ids, idx, allRead({ 'a-l01': 'read', 'a-l02': 'read', 'b-l01': 'read' }))
    expect([...before]).toEqual(['a-l02'])
    expect(newlyReady(before, after).sort()).toEqual(['a-l03', 'a-l05'])
  })
})

describe('chains and roles', () => {
  const groupOf = (id: string) => idx.lec.get(id)?.groupId
  it('closure walks one group only, nearest first, without the start', () => {
    expect(closure('a-l04', idx.rel.pre, groupOf, 'A')).toEqual(['a-l03', 'a-l02', 'a-l01'])
    expect(closure('a-l01', idx.rel.post, groupOf, 'A')).toEqual(['a-l02', 'a-l03', 'a-l05', 'a-l04'])
  })
  it('roles: direct first, indirect after, cross-group lectures are not coloured', () => {
    const r = rolesOf('a-l03', idx, 'A')
    expect(r.get('a-l03')).toBe('self')
    expect(r.get('a-l02')).toBe('pre')
    expect(r.get('a-l01')).toBe('pre2')
    expect(r.get('a-l04')).toBe('post')
    expect(r.has('b-l01')).toBe(false)
    expect(r.has('a-l05')).toBe(false)
  })
  it('byOrder sorts by group then number', () => {
    expect(['b-l01', 'a-l05', 'a-l02'].sort(byOrder(idx))).toEqual(['a-l02', 'a-l05', 'b-l01'])
  })
})

describe('lanes and group links', () => {
  it('lanes in order of first appearance, lectures without a category together', () => {
    const lanes = lanesOf([{ category: 'x', n: 1 }, { category: '', n: 2 }, { category: 'x', n: 3 }, { category: 'y', n: 4 }])
    expect(lanes.map((l) => [l.category, l.lectures.map((x) => x.n)])).toEqual([['x', [1, 3]], ['', [2]], ['y', [4]]])
  })
  it('counts cross-group edges per group, most first', () => {
    expect(groupLinks('A', idx)).toEqual({
      pre: [{ id: 'B', dir: 'b', title: 'B title', count: 1 }],
      post: [{ id: 'B', dir: 'b', title: 'B title', count: 1 }],
    })
    expect(groupLinks('C', idx)).toEqual({ pre: [], post: [] })
  })
  it('package pins make the count even', () => {
    expect([pinCount(5), pinCount(6)]).toEqual([6, 6])
  })
})

describe('edges', () => {
  const a = { x: 0, y: 0, w: 100, h: 30 }
  it('anchors on the side when the boxes share a row, else top / bottom', () => {
    expect(anchor(a, { x: 200, y: 4, w: 100, h: 30 })).toEqual([100, 15, 1, 0])
    expect(anchor(a, { x: 200, y: 100, w: 100, h: 30 })).toEqual([50, 30, 0, 1])
    expect(anchor(a, { x: 0, y: -100, w: 100, h: 30 })).toEqual([50, 0, 0, -1])
  })
  it('curve and orthogonal paths start and end on the anchors', () => {
    const b = { x: 200, y: 100, w: 100, h: 30 }
    expect(edgePath(a, b, 'curve')).toMatch(/^M50 30C/)
    const o = edgePath(a, b, 'orthogonal')
    expect(o.startsWith('M50 30L50 40L')).toBe(true)
    expect(o.endsWith('L250 100')).toBe(true)
    expect(o).not.toContain('C')
  })
})

describe('track anchor and layout field', () => {
  it('round-trips', () => {
    expect(trackHash('g06-l03')).toBe('#track-g06-l03')
    expect(parseTrackHash('#track-G06-L03')).toBe('g06-l03')
    expect(parseTrackHash('#track-')).toBeNull()
    expect(parseTrackHash('#other')).toBeNull()
  })
  it('layout.edges: curve and orthogonal only, unknown fields and shapes are reported', () => {
    expect(checkLayoutDeclaration({})).toEqual([])
    expect(checkLayoutDeclaration({ layout: { edges: 'orthogonal' } })).toEqual([])
    expect(checkLayoutDeclaration({ layout: { edges: 'curve' } })).toEqual([])
    expect(checkLayoutDeclaration({ layout: { edges: 'zigzag' } })[0]?.code).toBe('layout-edges')
    expect(checkLayoutDeclaration({ layout: { gap: 1 } })[0]?.code).toBe('layout-unknown-field')
    expect(checkLayoutDeclaration({ layout: [] })[0]?.code).toBe('layout-shape')
  })
  it('the theme parser reads it and rejects a bad value', () => {
    const base = { $extensions: { 'org.lecture-engine': { id: 'x', label: 'x', contract: 1, layout: { edges: 'orthogonal' } } }, modes: {} }
    expect(parseThemePack(base, 'x').value.edges).toBe('orthogonal')
    const bad = { $extensions: { 'org.lecture-engine': { id: 'x', label: 'x', contract: 1, layout: { edges: 'zigzag' } } }, modes: {} }
    const r = parseThemePack(bad, 'x')
    expect(r.value.edges).toBeNull()
    expect(r.issues.some((i) => i.message.includes('layout.edges'))).toBe(true)
  })
  it('edgeStyleOf reads the table', () => {
    expect(edgeStyleOf({ datasheet: { edges: 'orthogonal' } }, 'datasheet')).toBe('orthogonal')
    expect(edgeStyleOf({ datasheet: { edges: 'x' } }, 'datasheet')).toBeNull()
    expect(edgeStyleOf({}, 'reader')).toBeNull()
  })
})
