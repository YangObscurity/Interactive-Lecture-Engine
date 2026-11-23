import { describe, expect, it } from 'vitest'
import {
  AUTO_PHASE_MIN_LECTURES,
  autoPhaseSizes,
  buildCurriculum,
  buildPhases,
  isCurriculumData,
  lectureIdOf,
  lectureOfPath,
  resolveRequire,
  stripLectureNumber,
  type BuildInput,
  type SourceGroup,
  type SourceLecture,
} from '../../docs/.vitepress/curriculum/data'
import { frontmatterBlock, parseFlowList, readLectureFrontmatter } from '../../docs/.vitepress/curriculum/frontmatter'

function lectures(dir: string, count: number, extra: (n: number) => Partial<SourceLecture> = () => ({})): SourceLecture[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    return { n, link: `/${dir}/L${String(n).padStart(2, '0')}`, title: `第${n}讲 · ${dir} title ${n}`, requires: [], phase: null, ...extra(n) }
  })
}

function group(id: string, count: number, extra: Partial<SourceGroup> = {}, lec: (n: number) => Partial<SourceLecture> = () => ({})): SourceGroup {
  const dir = id.toLowerCase()
  return { id, dir, title: `${id} 标题`, lectures: lectures(dir, count, lec), ...extra }
}

const fallbackTitle: BuildInput['fallbackTitle'] = (lang, n) => (lang === 'en' ? `Lecture ${n}` : `第 ${n} 讲`)

function input(groups: SourceGroup[], rest: Partial<BuildInput> = {}): BuildInput {
  return {
    groups,
    locales: [{ key: 'root', lang: 'zh-CN' }],
    slotOf: (id) => (id === 'A' ? 1 : 2),
    fallbackTitle,
    ...rest,
  }
}

describe('frontmatter reader', () => {
  it('reads title, phase and the three spellings of requires', () => {
    const flow = readLectureFrontmatter('---\ntitle: "第5讲 · A, B"\nrequires: [g05/L18, "g05/L19", \'g04/L02\']\nphase: 基础\n---\n# x\n')
    expect(flow).toEqual({ title: '第5讲 · A, B', requires: ['g05/L18', 'g05/L19', 'g04/L02'], phase: '基础' })
    expect(readLectureFrontmatter('---\nrequires:\n  - g05/L18\n  - g05/L19\ntitle: t\n---\n').requires).toEqual(['g05/L18', 'g05/L19'])
    expect(readLectureFrontmatter('---\nrequires: g05/L18\n---\n').requires).toEqual(['g05/L18'])
    expect(readLectureFrontmatter('---\nrequires: []\n---\n').requires).toEqual([])
  })

  it('has no fields without frontmatter, and ignores a --- later in the body', () => {
    expect(readLectureFrontmatter('# no frontmatter\n---\ntitle: x\n---\n')).toEqual({ title: null, requires: [], phase: null })
    expect(frontmatterBlock('---\ntitle: a\n---\nbody\n---\ntitle: b\n---\n')).toBe('title: a\n')
  })

  it('handles CRLF, a BOM, comments and commas inside quotes', () => {
    expect(readLectureFrontmatter('﻿---\r\ntitle: "T"\r\nphase: P # comment\r\n---\r\n')).toMatchObject({ title: 'T', phase: 'P' })
    expect(parseFlowList('["a, b", c] # note')).toEqual(['a, b', 'c'])
  })
})

describe('ids, titles, requires references', () => {
  it('uses the lower-case core/route lecture id', () => {
    expect(lectureIdOf('g05', 19)).toBe('g05-l19')
    expect(lectureIdOf('G05', 3)).toBe('g05-l03')
    expect(lectureIdOf('examples/g01', 1)).toBe('g01-l01')
    expect(lectureIdOf('lr', 100)).toBe('lr-l100')
    expect(lectureOfPath('/g01/L13')).toEqual({ id: 'g01-l13', group: 'g01' })
    expect(lectureOfPath('/g01/')).toBeNull()
  })

  it('strips the "Lecture N" prefix in both languages and keeps a title that is only the prefix', () => {
    expect(stripLectureNumber('第5讲 · 电阻')).toBe('电阻')
    expect(stripLectureNumber('第01讲 · HearthNet：面向智能家居')).toBe('HearthNet：面向智能家居')
    expect(stripLectureNumber('Example Lecture 1 · Understanding Ohm\'s Law')).toBe("Understanding Ohm's Law")
    expect(stripLectureNumber('Lecture 12: Queues')).toBe('Queues')
    expect(stripLectureNumber('没有前缀')).toBe('没有前缀')
    expect(stripLectureNumber('第 5 讲')).toBe('第 5 讲')
  })

  it('resolves g05/L18, /g05/L18, L18 (same group) and g05-L18', () => {
    expect(resolveRequire('g05/L18', 'g06')).toEqual({ id: 'g05-l18', group: 'g05' })
    expect(resolveRequire('/g05/L18', 'g06')).toEqual({ id: 'g05-l18', group: 'g05' })
    expect(resolveRequire('g05/L18.md', 'g06')).toEqual({ id: 'g05-l18', group: 'g05' })
    expect(resolveRequire('L3', 'examples/g01')).toEqual({ id: 'g01-l03', group: 'g01' })
    expect(resolveRequire('g05-L18', 'g06')).toEqual({ id: 'g05-l18', group: 'g05' })
    expect(resolveRequire('somewhere else', 'g06')).toBeNull()
    expect(resolveRequire('', 'g06')).toBeNull()
  })
})

describe('phases', () => {
  const plain = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, phase: null }))

  it('does not cut a group of 8 lectures or fewer', () => {
    for (const n of [0, 1, 4, AUTO_PHASE_MIN_LECTURES]) expect(buildPhases(plain(n))).toEqual([])
  })

  it('cuts a bigger group the way the prototype did: ceil(n/4) phases, the first n % phases one bigger', () => {
    expect(autoPhaseSizes(9)).toEqual([3, 3, 3])
    expect(autoPhaseSizes(10)).toEqual([4, 3, 3])
    expect(autoPhaseSizes(13)).toEqual([4, 3, 3, 3])
    expect(autoPhaseSizes(31)).toEqual([4, 4, 4, 4, 4, 4, 4, 3])
    for (let n = 9; n <= 120; n++) {
      const sizes = autoPhaseSizes(n)
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(n)
      expect(sizes.length).toBe(Math.ceil(n / 4))
      expect(Math.max(...sizes)).toBeLessThanOrEqual(4)
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
    }
    expect(buildPhases(plain(10))).toEqual([
      { name: '1–4', from: 1, to: 4 },
      { name: '5–7', from: 5, to: 7 },
      { name: '8–10', from: 8, to: 10 },
    ])
  })

  it('names the range with the lecture numbers, also when numbering does not start at 1', () => {
    const ls = Array.from({ length: 9 }, (_, i) => ({ n: i + 10, phase: null }))
    expect(buildPhases(ls)[0]).toEqual({ name: '10–12', from: 10, to: 12 })
  })

  it('uses frontmatter phases when any lecture names one: consecutive same names are one phase', () => {
    const ls = [
      { n: 1, phase: 'Basics' },
      { n: 2, phase: 'Basics' },
      { n: 3, phase: 'Wiring' },
      { n: 4, phase: 'Basics' },
    ]
    expect(buildPhases(ls)).toEqual([
      { name: 'Basics', from: 1, to: 2 },
      { name: 'Wiring', from: 3, to: 3 },
      { name: 'Basics', from: 4, to: 4 },
    ])
  })

  it('frontmatter wins even in a small group; a lecture without a name joins the phase before it', () => {
    const ls = [
      { n: 1, phase: 'A' },
      { n: 2, phase: null },
      { n: 3, phase: 'B' },
      { n: 5, phase: null },
    ]
    expect(buildPhases(ls)).toEqual([
      { name: 'A', from: 1, to: 2 },
      { name: 'B', from: 3, to: 5 },
    ])
  })

  it('names leading lectures without a phase by their range', () => {
    expect(buildPhases([{ n: 1, phase: null }, { n: 2, phase: null }, { n: 3, phase: 'Late' }])).toEqual([
      { name: '1–2', from: 1, to: 2 },
      { name: 'Late', from: 3, to: 3 },
    ])
  })

  it('does not depend on the order the lectures are given in', () => {
    expect(buildPhases([{ n: 3, phase: 'B' }, { n: 1, phase: 'A' }, { n: 2, phase: 'A' }])).toEqual([
      { name: 'A', from: 1, to: 2 },
      { name: 'B', from: 3, to: 3 },
    ])
  })
})

describe('buildCurriculum: edges', () => {
  const graph = {
    nodes: [
      { id: 'n_a1', lecture: '/a/L01' },
      { id: 'n_a2', lecture: '/a/L02' },
      { id: 'n_b1', lecture: '/b/L01' },
      { id: 'n_ghost', lecture: '/a/L99' },
      { id: 'n_off', lecture: '/off/L01' },
      { id: 'n_nolec' },
    ],
    edges: [
      ['n_a1', 'n_a2'],
      ['n_a1', 'n_a2'], // duplicate
      ['n_a2', 'n_b1'],
      ['n_a1', 'n_ghost'], // lecture does not exist
      ['n_off', 'n_a1'], // group not built
      ['n_a1', 'n_unknown'], // node does not exist
      ['n_a2', 'n_nolec'], // node without a lecture
      ['n_a1', 'n_a1'], // self
    ],
  }

  it('maps graph edges to lectures, merges duplicates, drops the rest and says why', () => {
    const r = buildCurriculum(input([group('A', 3), group('B', 2)], { graph, notBuiltDirs: ['off'] }))
    expect(r.byLocale.root?.edges).toEqual([
      ['a-l01', 'a-l02'],
      ['a-l02', 'b-l01'],
    ])
    expect(r.dropped.map((d) => `${d.source}:${d.reason}`).sort()).toEqual([
      'graph:missing-lecture',
      'graph:missing-node',
      'graph:missing-node',
      'graph:not-built',
      'graph:self',
    ])
    // not-built and self are quiet; the others warn, naming the edge
    expect(r.warnings).toHaveLength(3)
    expect(r.warnings.join('\n')).toContain('n_a1 -> n_ghost')
    expect(r.warnings.join('\n')).toContain('a-l99')
  })

  it('takes requires from the frontmatter and unions them with the graph (an edge in both counts once)', () => {
    const groups = [
      group('A', 3, {}, (n) => (n === 3 ? { requires: ['a/L01', 'b/L02', 'a/L02'] } : n === 2 ? { requires: ['a/L01'] } : {})), // a-l01 -> a-l02 is also in the graph
      group('B', 2, {}, (n) => (n === 1 ? { requires: ['L02'] } : {})),
    ]
    const r = buildCurriculum(input(groups, { graph }))
    expect(r.byLocale.root?.edges).toEqual([
      ['a-l01', 'a-l02'],
      ['a-l01', 'a-l03'],
      ['a-l02', 'a-l03'],
      ['a-l02', 'b-l01'],
      ['b-l02', 'a-l03'],
      ['b-l02', 'b-l01'],
    ])
    expect(r.edgeSources).toEqual({ graph: 2, requires: 5, both: 1, union: 6 })
    expect(r.byLocale.root?.stats).toEqual({ groups: 2, lectures: 5, edges: 6 })
  })

  it('warns about requires that point nowhere and about entries that are not references; drops a requires on itself quietly', () => {
    const groups = [group('A', 2, {}, (n) => (n === 2 ? { requires: ['a/L77', 'a/L02', 'nonsense here', 'off/L01'] } : {}))]
    const r = buildCurriculum(input(groups, { notBuiltDirs: ['off'] }))
    expect(r.byLocale.root?.edges).toEqual([])
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings[0]).toContain('a-l77')
    expect(r.warnings[1]).toContain('nonsense here')
    expect(r.dropped.map((d) => d.reason).sort()).toEqual(['missing-lecture', 'missing-lecture', 'not-built', 'self'])
  })

  it('works without prerequisite data: no graph, no requires, no edges', () => {
    const r = buildCurriculum(input([group('A', 2)], { graph: null }))
    expect(r.byLocale.root?.edges).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.dropped).toEqual([])
  })

  it('gives every locale the same edges', () => {
    const r = buildCurriculum(
      input([group('A', 3), group('B', 2)], {
        graph,
        notBuiltDirs: ['off'],
        locales: [{ key: 'root', lang: 'zh-CN' }, { key: 'en', lang: 'en', translations: {} }],
      }),
    )
    expect(r.byLocale.en?.edges).toEqual(r.byLocale.root?.edges)
  })
})

describe('buildCurriculum: groups, languages', () => {
  const groups = [
    group('A', 3, { category: '硬件', i18n: { en: { title: 'Group A', category: 'Hardware' } } }),
    group('B', 2, { category: '软件' }), // no English category: falls back to the root text
    group('C', 1), // no category at all
  ]
  const locales: BuildInput['locales'] = [
    { key: 'root', lang: 'zh-CN' },
    { key: 'en', lang: 'en', translations: { '/a/L01': { link: '/en/a/L01', title: 'Lecture 1 · First' }, '/a/L02': { link: '/en/a/L02', title: '' } } },
  ]

  it('builds the root language from the frontmatter titles, with the number prefix removed', () => {
    const root = buildCurriculum(input(groups, { locales })).byLocale.root
    expect(root?.locale).toBe('root')
    expect(root?.groups.map((g) => [g.id, g.title, g.category, g.catSlot])).toEqual([
      ['A', 'A 标题', '硬件', 1],
      ['B', 'B 标题', '软件', 2],
      ['C', 'C 标题', '', 2],
    ])
    expect(root?.groups[0]?.lectures[0]).toEqual({ id: 'a-l01', n: 1, title: 'a title 1', link: '/a/L01' })
    expect(root?.groups[0]?.lectures.some((l) => 'untranslated' in l)).toBe(false)
  })

  it('uses a lecture without a title: the fallback title in the language of the data', () => {
    const g = group('A', 1, {}, () => ({ title: null }))
    expect(buildCurriculum(input([g])).byLocale.root?.groups[0]?.lectures[0]?.title).toBe('第 1 讲')
    const en = buildCurriculum(input([g], { locales: [{ key: 'root', lang: 'zh-CN' }, { key: 'en', lang: 'en', translations: { '/a/L01': { link: '/en/a/L01', title: '' } } }] })).byLocale.en
    expect(en?.groups[0]?.lectures[0]).toEqual({ id: 'a-l01', n: 1, title: 'Lecture 1', link: '/en/a/L01' })
  })

  it('English: translated lectures use the translated title and page; the rest keep the root title and link and are marked untranslated', () => {
    const en = buildCurriculum(input(groups, { locales })).byLocale.en
    expect(en?.locale).toBe('en')
    const a = en?.groups[0]
    expect(a?.title).toBe('Group A')
    expect(a?.category).toBe('Hardware')
    expect(a?.lectures).toEqual([
      { id: 'a-l01', n: 1, title: 'First', link: '/en/a/L01' },
      { id: 'a-l02', n: 2, title: 'Lecture 2', link: '/en/a/L02' },
      { id: 'a-l03', n: 3, title: 'a title 3', link: '/a/L03', untranslated: true },
    ])
    expect(en?.groups[1]?.title).toBe('B 标题')
    expect(en?.groups[1]?.category).toBe('软件')
    expect(en?.groups[1]?.lectures.every((l) => l.untranslated === true && l.link.startsWith('/b/'))).toBe(true)
    // the lecture ids, order and colour slots do not depend on the language
    expect(en?.groups.map((g) => [g.id, g.catSlot, g.lectures.map((l) => l.id)])).toEqual(buildCurriculum(input(groups, { locales })).byLocale.root?.groups.map((g) => [g.id, g.catSlot, g.lectures.map((l) => l.id)]))
  })

  it('sorts lectures by number and keeps the order of the groups', () => {
    const g = group('A', 3)
    g.lectures = [...g.lectures].reverse()
    expect(buildCurriculum(input([group('B', 1), g])).byLocale.root?.groups.map((x) => [x.id, x.lectures.map((l) => l.n)])).toEqual([['B', [1]], ['A', [1, 2, 3]]])
  })

  it('attaches phases (frontmatter and automatic) to the groups', () => {
    const big = group('A', 10)
    const small = group('B', 4, {}, (n) => ({ phase: n <= 2 ? 'One' : 'Two' }))
    const r = buildCurriculum(input([big, small])).byLocale.root
    expect(r?.groups[0]?.phases.map((p) => p.name)).toEqual(['1–4', '5–7', '8–10'])
    expect(r?.groups[1]?.phases).toEqual([{ name: 'One', from: 1, to: 2 }, { name: 'Two', from: 3, to: 4 }])
  })

  it('requires a root locale', () => {
    expect(() => buildCurriculum({ ...input([]), locales: [{ key: 'en', lang: 'en' }] })).toThrow(/root/)
  })

  it('produces data the runtime check accepts, and rejects other shapes', () => {
    const r = buildCurriculum(input(groups, { locales })).byLocale
    expect(isCurriculumData(r.root)).toBe(true)
    expect(isCurriculumData(r.en)).toBe(true)
    expect(isCurriculumData(JSON.parse(JSON.stringify(r.en)))).toBe(true)
    expect(isCurriculumData(null)).toBe(false)
    expect(isCurriculumData({ ...r.root, version: 2 })).toBe(false)
    expect(isCurriculumData({ ...r.root, edges: [['a']] })).toBe(false)
    expect(isCurriculumData({ ...r.root, groups: [{ id: 'x' }] })).toBe(false)
  })
})

describe('Notion fields (P4a WP-H3)', () => {
  const graph = {
    categories: [{ id: 'cat_1', title: '数据库' }],
    nodes: [
      { id: 'n1', lecture: '/a/L01', category: 'cat_1' },
      { id: 'n2', lecture: '/a/L02', category: 'cat_x' },
    ],
    edges: [['n1', 'n2']],
  }
  const notion = { n1: { desc: ' 说明文字 ', diff: 4, min: 45, url: 'https://example.org/x' }, n2: { desc: '', diff: 9, min: -1, url: 'javascript:alert(1)' } }
  const build = (rest: Partial<BuildInput> = {}) => buildCurriculum(input([group('A', 3)], { graph, notion, ...rest })).byLocale.root as unknown as { groups: Array<{ lectures: Array<Record<string, unknown>> }> }

  it('adds node, category, desc, diff, min and url per lecture', () => {
    const l = build().groups[0]?.lectures
    expect(l?.[0]).toMatchObject({ node: 'n1', category: '数据库', desc: '说明文字', diff: 4, min: 45, url: 'https://example.org/x' })
  })
  it('leaves out malformed values, unknown categories and unsafe links', () => {
    const l = build().groups[0]?.lectures
    expect(l?.[1]).toEqual(expect.objectContaining({ node: 'n2' }))
    for (const k of ['category', 'desc', 'diff', 'min', 'url']) expect(l?.[1]).not.toHaveProperty(k)
  })
  it('a lecture without a node has no Notion fields; a missing notion file leaves node and category only', () => {
    expect(build().groups[0]?.lectures[2]).not.toHaveProperty('node')
    const l = build({ notion: null }).groups[0]?.lectures[0]
    expect(l).toMatchObject({ node: 'n1', category: '数据库' })
    expect(l).not.toHaveProperty('desc')
    expect(buildCurriculum(input([group('A', 3)])).byLocale.root?.groups[0]?.lectures[0]).not.toHaveProperty('node')
  })
  it('the same fields in every language bucket; the shape check accepts them and rejects a wrong type', () => {
    const b = buildCurriculum(input([group('A', 3)], { graph, notion, locales: [{ key: 'root', lang: 'zh-CN' }, { key: 'en', lang: 'en', translations: {} }] }))
    expect(b.byLocale.en?.groups[0]?.lectures[0]).toMatchObject({ desc: '说明文字' })
    expect(isCurriculumData(b.byLocale.en)).toBe(true)
    const broken = JSON.parse(JSON.stringify(b.byLocale.root))
    broken.groups[0].lectures[0].diff = 'x'
    expect(isCurriculumData(broken)).toBe(false)
  })
})
