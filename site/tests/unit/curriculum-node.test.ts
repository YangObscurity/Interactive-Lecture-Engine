import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildCurriculumFromDisk, curriculumLog, readGraphFile, scanSourceLectures } from '../../docs/.vitepress/curriculum/node.mts'
import { resolveGroups } from '../../docs/.vitepress/groups-source.mts'
import type { GroupMetaLike } from '../../docs/.vitepress/groups-source.mts'
import { DEMO_ENV, demoContentPaths, setEnv, syncDemoDocs } from './demo-content'

const tmp: string[] = []
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true })
})

/** A throwaway docs folder: `files` maps `<dir>/L<n>.md` to its frontmatter + body. */
function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-test-'))
  tmp.push(root)
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), src)
  }
  return root
}

const md = (title: string, extra = ''): string => `---\ntitle: "${title}"\n${extra}---\n\n# ${title}\n`
const grp = (id: string, extra: Partial<GroupMetaLike> = {}): GroupMetaLike => ({ id, dir: id.toLowerCase(), title: `${id} title`, tagline: '', summary: '', accent: '#000000', tags: [], ...extra })

describe('curriculum from a temporary docs folder', () => {
  it('reads titles, requires and phase from the frontmatter and sorts lectures by number', () => {
    const root = fixture({
      'a/L10.md': md('第10讲 · Ten'),
      'a/L02.md': md('第2讲 · Two', 'requires: [a/L10]\nphase: Early\n'),
      'a/L03.md': md('第3讲 · Three', 'requires:\n  - a/L02\n  - b/L01\nphase: Early\n'),
      'a/README.md': '# not a lecture',
      'b/L01.md': md('第1讲 · B one'),
    })
    expect(scanSourceLectures(root, 'a').map((l) => [l.n, l.link, l.title, [...l.requires], l.phase])).toEqual([
      [2, '/a/L02', '第2讲 · Two', ['a/L10'], 'Early'],
      [3, '/a/L03', '第3讲 · Three', ['a/L02', 'b/L01'], 'Early'],
      [10, '/a/L10', '第10讲 · Ten', [], null],
    ])
    expect(scanSourceLectures(root, 'missing')).toEqual([])

    const build = buildCurriculumFromDisk({ docsRoot: root, graphFile: path.join(root, 'no-graph.json'), allGroups: [grp('A'), grp('B')], keptGroupIds: ['A', 'B'], rootLang: 'zh-CN', otherLangs: ['en'] })
    const a = build.byLocale.root?.groups[0]
    expect(a?.lectures.map((l) => [l.id, l.title])).toEqual([['a-l02', 'Two'], ['a-l03', 'Three'], ['a-l10', 'Ten']])
    expect(a?.phases).toEqual([{ name: 'Early', from: 2, to: 10 }]) // lecture 10 names no phase: it stays in the one before
    expect(build.byLocale.root?.edges).toEqual([
      ['a-l02', 'a-l03'],
      ['a-l10', 'a-l02'],
      ['b-l01', 'a-l03'],
    ])
    // no English files: every lecture is untranslated and links to the root page
    expect(build.byLocale.en?.groups[0]?.lectures.every((l) => l.untranslated === true && l.link.startsWith('/a/'))).toBe(true)
  })

  it('finds translations in docs/<locale>/ and uses their titles', () => {
    const root = fixture({ 'a/L01.md': md('第1讲 · 一'), 'a/L02.md': md('第2讲 · 二'), 'en/a/L01.md': md('Lecture 1 · One') })
    const build = buildCurriculumFromDisk({ docsRoot: root, graphFile: path.join(root, 'none.json'), allGroups: [grp('A')], keptGroupIds: ['A'], rootLang: 'zh-CN', otherLangs: ['en'] })
    expect(build.byLocale.en?.groups[0]?.lectures).toEqual([
      { id: 'a-l01', n: 1, title: 'One', link: '/en/a/L01' },
      { id: 'a-l02', n: 2, title: '二', link: '/a/L02', untranslated: true },
    ])
  })

  it('leaves groups that are not built out, keeps their colour slot, and does not warn about edges into them', () => {
    const root = fixture({ 'a/L01.md': md('A1', 'requires: [b/L01]\n'), 'b/L01.md': md('B1') })
    const all = [grp('A', { category: 'x' }), grp('B', { category: 'y' }), grp('C', { category: 'y' })]
    const build = buildCurriculumFromDisk({ docsRoot: root, graphFile: path.join(root, 'none.json'), allGroups: all, keptGroupIds: ['A', 'C'], rootLang: 'zh-CN', otherLangs: [] })
    expect(build.byLocale.root?.groups.map((g) => [g.id, g.catSlot])).toEqual([['A', 1], ['C', 2]])
    expect(build.warnings).toEqual([])
    expect(build.dropped.map((d) => d.reason)).toEqual(['not-built'])
  })

  it('puts temporary groups last, like config.mts', () => {
    const root = fixture({ 'a/L01.md': md('A1'), 'b/L01.md': md('B1') })
    const build = buildCurriculumFromDisk({ docsRoot: root, graphFile: path.join(root, 'none.json'), allGroups: [grp('A', { temp: true }), grp('B')], keptGroupIds: ['A', 'B'], rootLang: 'zh-CN', otherLangs: [] })
    expect(build.byLocale.root?.groups.map((g) => g.id)).toEqual(['B', 'A'])
  })

  it('readGraphFile gives null for a missing or foreign file', () => {
    const root = fixture({ 'g.json': '{"nodes":[]}', 'ok.json': '{"nodes":[],"edges":[]}', 'bad.json': 'not json' })
    expect(readGraphFile(path.join(root, 'g.json'))).toBeNull()
    expect(readGraphFile(path.join(root, 'bad.json'))).toBeNull()
    expect(readGraphFile(path.join(root, 'nope.json'))).toBeNull()
    expect(readGraphFile(path.join(root, 'ok.json'))).not.toBeNull()
  })

  it('curriculumLog summarises counts and caps the warnings', () => {
    const root = fixture({ 'a/L01.md': md('A1', 'requires: [a/L90, a/L91, a/L92]\n') })
    const build = buildCurriculumFromDisk({ docsRoot: root, graphFile: path.join(root, 'none.json'), allGroups: [grp('A')], keptGroupIds: ['A'], rootLang: 'zh-CN', otherLangs: [] })
    const log = curriculumLog(build, 2)
    expect(log.stats).toContain('1 groups, 1 lectures, 0 prerequisite edges')
    expect(log.stats).toContain('dropped 3 (missing lecture 3')
    expect(log.warnings).toHaveLength(3)
    expect(log.warnings[2]).toBe('... and 1 more')
  })
})

describe('curriculum of the demo site (templates/demo-content synced into a temporary docs folder)', () => {
  it('lists every lecture file once and every edge between lectures that exist', async () => {
    const demo = await syncDemoDocs()
    const restore = setEnv({ ...DEMO_ENV })
    try {
      const { GROUPS } = await resolveGroups()
      const DOCS = demo.docsRoot
      const GRAPH = demoContentPaths().graphDir.graph
      const build = buildCurriculumFromDisk({ docsRoot: DOCS, graphFile: GRAPH, allGroups: GROUPS, keptGroupIds: GROUPS.map((g) => g.id), rootLang: 'zh-CN', otherLangs: ['en'] })
      const root = build.byLocale.root
      expect(root).toBeDefined()
      const ids = root?.groups.flatMap((g) => g.lectures.map((l) => l.id)) ?? []
      expect(new Set(ids).size).toBe(ids.length)
      const onDisk = GROUPS.reduce((n, g) => n + fs.readdirSync(path.join(DOCS, g.dir)).filter((f) => /^L\d+\.md$/.test(f)).length, 0)
      expect(ids.length).toBe(onDisk)
      // every lecture file of the demo source (templates/demo-content/lectures/<dir>/Lnn.md) is in the synced docs
      const inSource = GROUPS.reduce((n, g) => n + fs.readdirSync(path.join(demoContentPaths().lecturesDir, g.dir)).filter((f) => /^L\d+\.md$/.test(f)).length, 0)
      expect(onDisk).toBe(inSource)
      expect(onDisk).toBeGreaterThanOrEqual(GROUPS.length * 4)
      const known = new Set(ids)
      for (const [a, b] of root?.edges ?? []) {
        expect(known.has(a)).toBe(true)
        expect(known.has(b)).toBe(true)
        expect(a).not.toBe(b)
      }
      expect(root?.stats).toEqual({ groups: GROUPS.length, lectures: onDisk, edges: root?.edges.length })
      // the three categories of the demo, in first-appearance order, with their English names
      const cats = [...new Map((root?.groups ?? []).map((g) => [g.category, g.catSlot])).entries()]
      expect(cats).toEqual([['基础', 1], ['应用', 2], ['方法', 3]])
      expect([...new Set(build.byLocale.en?.groups.map((g) => g.category))]).toEqual(['Foundations', 'Applications', 'Methods'])
      // the lecture titles have no "第N讲" prefix left
      expect(root?.groups.flatMap((g) => g.lectures).filter((l) => /^第\s*\d+\s*讲/.test(l.title))).toEqual([])
      // MEA writes `phase:` in the frontmatter of L01 and L04: those start explicit phases running to the next one
      const mea = root?.groups.find((g) => g.dir === 'mea')
      expect(mea?.phases).toEqual([{ from: 1, to: 3, name: '读数基础' }, { from: 4, to: 6, name: '数据与图' }])
      // groups with more than 8 lectures and no phase in the frontmatter are cut into phases of at most 4
      for (const g of root?.groups ?? []) {
        if (g === mea) continue
        if (g.lectures.length > 8) {
          expect(g.phases.length).toBe(Math.ceil(g.lectures.length / 4))
          expect(g.phases.reduce((n, p) => n + g.lectures.filter((l) => l.n >= p.from && l.n <= p.to).length, 0)).toBe(g.lectures.length)
        } else expect(g.phases).toEqual([])
      }
    } finally {
      restore()
      demo.cleanup()
    }
  })
})
