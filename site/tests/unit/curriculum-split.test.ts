import { describe, expect, it } from 'vitest'
import { statsOf, type CurriculumData, type CurriculumGroup } from '../../docs/.vitepress/curriculum/data'
import { isCurriculumSlice, mergeCurriculum, splitCurriculum, type CurriculumSlice } from '../../docs/.vitepress/curriculum/split'
import { curriculumSliceOf } from '../../docs/.vitepress/access/build.mts'
import { resolveAccess } from '../../docs/.vitepress/access/tiers'
import { loadCurriculumWith, slicesOf, type CurriculumDeps } from '../../docs/.vitepress/theme/curriculum/loader'
import type { AccessResult } from '../../docs/.vitepress/theme/access/resolve'
import type { AccessDeps } from '../../docs/.vitepress/theme/access/resolve'

/** Small deterministic PRNG (mulberry32), as in access-site-data.test.ts. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeGroup(id: string, lectureCount: number): CurriculumGroup {
  const dir = id.toLowerCase()
  return {
    id,
    dir,
    title: `Title of ${id}`,
    category: 'Cat',
    catSlot: 1,
    lectures: Array.from({ length: lectureCount }, (_, i) => ({ id: `${dir}-l${String(i + 1).padStart(2, '0')}`, n: i + 1, title: `${id} lecture ${i + 1}`, link: `/${dir}/L${i + 1}` })),
    phases: [],
  }
}

function makeData(ids: string[], rand: () => number, edgeCount: number): CurriculumData {
  const groups = ids.map((id) => makeGroup(id, 1 + Math.floor(rand() * 4)))
  const all = groups.flatMap((g) => g.lectures.map((l) => l.id))
  const set = new Set<string>()
  for (let i = 0; i < edgeCount && all.length > 1; i++) {
    const a = all[Math.floor(rand() * all.length)] as string
    const b = all[Math.floor(rand() * all.length)] as string
    if (a !== b) set.add(`${a}\u0000${b}`)
  }
  const edges = [...set].map((k) => k.split('\u0000') as [string, string]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0))
  return { version: 1, locale: 'root', groups, edges, stats: statsOf(groups, edges) }
}

const INLINE = 'public'

describe('splitCurriculum', () => {
  const data = makeData(['G01', 'G02', 'G03', 'G04'], rng(1), 30)
  const tierOfGroup = (id: string): string => ({ G01: INLINE, G02: 'authenticated', G03: 'grp-aa', G04: INLINE })[id] ?? INLINE
  const split = splitCurriculum(data, { tierOfGroup, inlineTier: INLINE })

  it('keeps the inline groups and only the edges with both ends inline in the inline part', () => {
    expect(split.inline.groups.map((g) => g.id)).toEqual(['G01', 'G04'])
    const inlineLectures = new Set(split.inline.groups.flatMap((g) => g.lectures.map((l) => l.id)))
    expect(split.inline.edges.length).toBeGreaterThan(0)
    for (const [a, b] of split.inline.edges) {
      expect(inlineLectures.has(a)).toBe(true)
      expect(inlineLectures.has(b)).toBe(true)
    }
    expect(split.inline.stats).toEqual(statsOf(split.inline.groups, split.inline.edges))
  })

  it('puts the groups of a restricted tier and every edge touching it in that tier slice', () => {
    expect(Object.keys(split.slices).sort()).toEqual(['authenticated', 'grp-aa'])
    const g2 = new Set((data.groups.find((g) => g.id === 'G02') as CurriculumGroup).lectures.map((l) => l.id))
    const slice = split.slices.authenticated as CurriculumSlice
    expect(slice.groups.map((p) => p.value.id)).toEqual(['G02'])
    expect(slice.edges).toEqual(data.edges.filter(([a, b]) => g2.has(a) || g2.has(b)))
    expect(slice.tier).toBe('authenticated')
    expect(slice.locale).toBe('root')
    expect(isCurriculumSlice(JSON.parse(JSON.stringify(slice)))).toBe(true)
  })

  it('writes no slice for a tier without groups, and keeps everything inline without restricted tiers', () => {
    const none = splitCurriculum(data, { tierOfGroup: () => INLINE, inlineTier: INLINE })
    expect(none.slices).toEqual({})
    expect(none.inline).toEqual(data)
  })

  it('the inline part does not contain a restricted group or a lecture id of one', () => {
    const text = JSON.stringify(split.inline)
    for (const g of data.groups.filter((x) => tierOfGroup(x.id) !== INLINE)) {
      expect(text).not.toContain(g.title)
      for (const l of g.lectures) expect(text).not.toContain(l.id)
    }
  })

  it('an edge between two restricted tiers is in both slices; one between a restricted tier and an inline group only in the restricted one', () => {
    const g = (id: string) => (data.groups.find((x) => x.id === id) as CurriculumGroup).lectures[0]?.id as string
    const d: CurriculumData = { ...data, edges: [[g('G02'), g('G03')], [g('G01'), g('G02')]] }
    const s = splitCurriculum(d, { tierOfGroup, inlineTier: INLINE })
    expect(s.slices.authenticated?.edges).toHaveLength(2)
    expect(s.slices['grp-aa']?.edges).toEqual([[g('G02'), g('G03')]])
    expect(s.inline.edges).toEqual([])
  })
})

describe('mergeCurriculum', () => {
  it('is the inverse of splitCurriculum: all slices give back the original, for random data and tier assignments', () => {
    const rand = rng(7)
    for (let round = 0; round < 60; round++) {
      const n = 1 + Math.floor(rand() * 7)
      const ids = Array.from({ length: n }, (_, i) => `G${String(i + 1).padStart(2, '0')}`)
      const data = makeData(ids, rand, Math.floor(rand() * 40))
      const tiers = [INLINE, 'authenticated', 'grp-aa', 'grp-bb']
      const assigned = Object.fromEntries(ids.map((id) => [id, tiers[Math.floor(rand() * tiers.length)] as string]))
      const split = splitCurriculum(data, { tierOfGroup: (id) => assigned[id] ?? INLINE, inlineTier: INLINE })
      const slices = Object.values(split.slices)
      // any order of the slices
      for (let i = slices.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1))
        ;[slices[i], slices[j]] = [slices[j] as CurriculumSlice, slices[i] as CurriculumSlice]
      }
      expect(mergeCurriculum(split.inline, slices)).toEqual(data)
    }
  })

  it('with only some slices gives the original minus the other tiers and every edge that touches them', () => {
    const rand = rng(11)
    for (let round = 0; round < 60; round++) {
      const ids = Array.from({ length: 6 }, (_, i) => `G${i + 1}`)
      const data = makeData(ids, rand, 40)
      const tiers = [INLINE, 'authenticated', 'grp-aa']
      const assigned = Object.fromEntries(ids.map((id) => [id, tiers[Math.floor(rand() * tiers.length)] as string]))
      const split = splitCurriculum(data, { tierOfGroup: (id) => assigned[id] ?? INLINE, inlineTier: INLINE })
      const readable = tiers.slice(1).filter(() => rand() < 0.5)
      const merged = mergeCurriculum(split.inline, readable.map((t) => split.slices[t]).filter((s): s is CurriculumSlice => s !== undefined))
      const keptGroups = data.groups.filter((g) => [INLINE, ...readable].includes(assigned[g.id] as string))
      const kept = new Set(keptGroups.flatMap((g) => g.lectures.map((l) => l.id)))
      const edges = data.edges.filter(([a, b]) => kept.has(a) && kept.has(b))
      expect(merged).toEqual({ version: 1, locale: 'root', groups: keptGroups, edges, stats: statsOf(keptGroups, edges) })
    }
  })

  it('returns the inline data itself when there is nothing to merge', () => {
    const data = makeData(['G01'], rng(3), 0)
    expect(mergeCurriculum(data, [])).toBe(data)
  })

  it('does not mutate its inputs and does not list an edge twice', () => {
    const data = makeData(['G01', 'G02', 'G03'], rng(5), 30)
    const tierOfGroup = (id: string): string => (id === 'G01' ? INLINE : id === 'G02' ? 'authenticated' : 'grp-aa')
    const split = splitCurriculum(data, { tierOfGroup, inlineTier: INLINE })
    const before = JSON.stringify(split)
    const merged = mergeCurriculum(split.inline, Object.values(split.slices))
    expect(JSON.stringify(split)).toBe(before)
    expect(new Set(merged.edges.map((e) => e.join('\u0000'))).size).toBe(merged.edges.length)
  })
})

describe('curriculumSliceOf (what finalizeDist writes)', () => {
  const plan = resolveAccess({
    access: { default: 'public', enforcement: 'gateway', groups: { G02: { read: 'authenticated' } } },
    groupIds: ['G01', 'G02'],
  })
  const data = makeData(['G01', 'G02'], rng(9), 10)
  const build = { byLocale: { root: data, en: { ...data, locale: 'en' } }, dropped: [], warnings: [], edgeSources: { graph: 0, requires: 0, both: 0, union: 0 } }

  it('is the slice of the tier, per locale bucket; an empty slice for a tier without groups; undefined for an unknown locale', () => {
    const s = curriculumSliceOf(build, plan, 'authenticated', 'en')
    expect(s?.locale).toBe('en')
    expect(s?.groups.map((p) => p.value.id)).toEqual(['G02'])
    expect(curriculumSliceOf(build, plan, 'grp-zz', 'root')).toEqual({ version: 1, tier: 'grp-zz', locale: 'root', groups: [], edges: [] })
    expect(curriculumSliceOf(build, plan, 'authenticated', 'fr')).toBeUndefined()
  })
})

describe('client loader: inline part + readable tiers', () => {
  const data = makeData(['G01', 'G02', 'G03'], rng(13), 20)
  const tierOfGroup = (id: string): string => (id === 'G01' ? INLINE : id === 'G02' ? 'authenticated' : 'grp-aa')
  const split = splitCurriculum(data, { tierOfGroup, inlineTier: INLINE })

  function deps(readable: string[], served: Record<string, unknown>) {
    const calls: string[] = []
    const access: AccessResult = { tiers: readable.map((id) => ({ id, slice: { version: 1, tier: id, groups: [], totals: { lectures: 0, charts: 0 }, locales: {} } })) }
    const http: AccessDeps = {
      withBase: (p) => p,
      fetch: (async (url: string) => {
        calls.push(url)
        return url in served ? ({ status: 200, json: async () => served[url] } as Response) : ({ status: 403, json: async () => ({}) } as Response)
      }) as typeof fetch,
    }
    const d: CurriculumDeps = { inline: async () => ({ root: split.inline }), access: async () => access, http: () => http }
    return { d, calls }
  }

  it('makes no request at all when no restricted tier is readable', async () => {
    const { d, calls } = deps([], {})
    expect(await loadCurriculumWith(d, 'root')).toBe(split.inline)
    expect(calls).toEqual([])
  })

  it('fetches curriculum.<locale>.json of each readable tier and merges it', async () => {
    const served = {
      '/_access/authenticated/curriculum.root.json': split.slices.authenticated,
      '/_access/grp-aa/curriculum.root.json': split.slices['grp-aa'],
    }
    const { d, calls } = deps(['authenticated', 'grp-aa'], served)
    expect(await loadCurriculumWith(d, 'root')).toEqual(data)
    expect(calls.sort()).toEqual(['/_access/authenticated/curriculum.root.json', '/_access/grp-aa/curriculum.root.json'])
  })

  it('merges only what arrived: a denied tier, a slice of another tier and a malformed file add nothing', async () => {
    const served = { '/_access/authenticated/curriculum.root.json': split.slices.authenticated, '/_access/grp-aa/curriculum.root.json': { ...split.slices['grp-aa'], tier: 'authenticated' }, '/_access/grp-bb/curriculum.root.json': { nope: true } }
    const { d } = deps(['authenticated', 'grp-aa', 'grp-bb', 'grp-cc'], served)
    const got = await loadCurriculumWith(d, 'root')
    expect(got.groups.map((g) => g.id)).toEqual(['G01', 'G02'])
    expect((await slicesOf(d, 'root')).map((s) => s.tier)).toEqual(['authenticated'])
  })

  it('asks for the locale it was given, and falls back to the root inline data for an unknown locale', async () => {
    const { d, calls } = deps(['authenticated'], { '/_access/authenticated/curriculum.en.json': { ...split.slices.authenticated, locale: 'en' } })
    const got = await loadCurriculumWith(d, 'en')
    expect(calls).toEqual(['/_access/authenticated/curriculum.en.json'])
    expect(got.groups.map((g) => g.id)).toEqual(['G01', 'G02'])
  })

  it('is empty (not a crash) when the inline chunk fails to load', async () => {
    const { d } = deps([], {})
    const broken: CurriculumDeps = { ...d, inline: async () => Promise.reject(new Error('chunk')) }
    expect(await loadCurriculumWith(broken, 'root')).toEqual({ version: 1, locale: 'root', groups: [], edges: [], stats: { groups: 0, lectures: 0, edges: 0 } })
  })
})
