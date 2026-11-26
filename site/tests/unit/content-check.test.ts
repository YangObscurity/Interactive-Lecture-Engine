/**
 * S4a: the lecture contract behind `npm run check:content` (contract.mts) and the check end to end on a fresh content folder.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import { initContent, newGroup, newLecture, renderLecture } from '../../scripts/content/scaffold.mts'
import {
  checkConceptSource,
  checkGraph,
  checkLectureSource,
  compareTranslationCharts,
  type ContentIssue,
  type LectureContext,
} from '../../scripts/content/contract.mts'
import { CHECK_CATEGORIES, categoryOf, onlyFromArgv, parseOnly, runContentCheck } from '../../scripts/content/check.mts'

const tempRoots: string[] = []
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(d)
  return d
}
afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true })
})

const codes = (issues: readonly ContentIssue[], level?: ContentIssue['level']) =>
  issues.filter((i) => !level || i.level === level).map((i) => i.code)

function ctx(over: Partial<LectureContext> = {}): LectureContext {
  return {
    file: 'lectures/g01/L02.md',
    key: 'g01/L02',
    groupId: 'G01',
    groupDir: 'g01',
    n: 2,
    isLast: false,
    readChart: (id) => (id === 'G01-L02' ? { c1: { type: 'mermaid' }, c2: { type: 'echarts' } } : null),
    lectureExists: (dir, stem) => dir === 'g01' && ['L01', 'L02', 'index'].includes(stem),
    groupDirs: new Set(['g01', 'g02']),
    ...over,
  }
}

const GOOD = [
  '---',
  'title: "第2讲 · 示例"',
  'order: 2',
  'description: "节点 `ee_demo` ｜ 亚组: G01 ｜ 难度 ★★ ｜ 预估 60min"',
  'outline: deep',
  '---',
  '',
  '# 第2讲 · 示例',
  '',
  '## 一节',
  '',
  '见 [上一讲](./L01) 与 [组页](./index.md)，[外链](https://example.com)。',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | \\|x\\| |',
  '',
  '<figure class="chart" data-lecture="G01-L02" data-id="c1" data-type="mermaid"></figure>',
  '',
  '```c',
  'int x = 1; // <figure class="chart" data-lecture="NOPE" data-id="z" data-type="mermaid">',
  '```',
  '',
].join('\n')

describe('lecture contract', () => {
  it('passes a lecture that follows it', () => {
    expect(checkLectureSource(GOOD, ctx())).toEqual([])
  })

  it('reports frontmatter problems', () => {
    expect(codes(checkLectureSource('# no frontmatter\n', ctx()))).toContain('lecture.frontmatter_missing')
    const src = GOOD.replace('title: "第2讲 · 示例"', 'title: 第2讲').replace('order: 2', 'order: 3').replace('outline: deep\n', '')
    expect(codes(checkLectureSource(src, ctx()), 'fail')).toEqual(['lecture.title_unquoted', 'lecture.order_mismatch', 'lecture.outline_missing'])
    const noNode = GOOD.replace('节点 `ee_demo` ｜ ', '')
    expect(checkLectureSource(noNode, ctx())).toEqual([expect.objectContaining({ level: 'info', code: 'lecture.node_missing' })])
    expect(codes(checkLectureSource(GOOD.replace(/^description: .*\n/m, ''), ctx()))).toContain('lecture.description_missing')
  })

  it('checks chart placeholders against charts/<data-lecture>.json', () => {
    const add = (line: string) => GOOD.replace('<figure class="chart" data-lecture="G01-L02" data-id="c1" data-type="mermaid"></figure>', line)
    expect(codes(checkLectureSource(add('<figure class="chart" data-lecture="G01-L02" data-id="c9" data-type="mermaid"></figure>'), ctx()))).toEqual(['chart.id_missing'])
    expect(codes(checkLectureSource(add('<figure class="chart" data-lecture="G01-L02" data-id="c2" data-type="mermaid"></figure>'), ctx()))).toEqual(['chart.type_mismatch'])
    expect(codes(checkLectureSource(add('<figure class="chart" data-lecture="G01-L07" data-id="c1" data-type="mermaid"></figure>'), ctx()))).toEqual(['chart.prefix', 'chart.file_missing'])
    expect(codes(checkLectureSource(add('<figure class="chart" data-lecture="G01-L02" data-type="mermaid"></figure>'), ctx()))).toEqual(['chart.attr_missing'])
    expect(codes(checkLectureSource(add('<figure class="chart" data-lecture="G01-L02" data-id="c1" data-type="plot"></figure>'), ctx()))).toEqual(['chart.type_unknown'])
    expect(codes(checkLectureSource(GOOD, ctx({ readChart: () => 'invalid' })))).toEqual(['chart.json_invalid'])
    // an ordinary <figure> without chart attributes is not a chart
    expect(checkLectureSource(add('<figure><img src="/a.png"></figure>'), ctx())).toEqual([])
  })

  it('finds broken internal links, raw links, tables, fences and headings', () => {
    const src = GOOD.replace('[上一讲](./L01)', '[缺](./L05) [他组](../g02/L01.md) [绝对](/g02/L03#x) [概念](concept:x) [无关](/dashboard)')
    const issues = checkLectureSource(src, ctx())
    expect(issues.filter((i) => i.code === 'link.broken').map((i) => i.message.split(' points')[0])).toEqual([
      'link "./L05"',
      'link "../g02/L01.md"',
      'link "/g02/L03#x"',
    ])
    expect(issues.find((i) => i.code === 'link.broken')?.line).toBe(12)
    const more = GOOD.replace('## 一节', '## 一节\n\n#### 跳级\n\n# 第二个一级\n\n<a href="https://x.org">x</a>\n\n```\nno lang\n```').replace('| 1 | \\|x\\| |', '| 1 | 2 | 3 |')
    expect(codes(checkLectureSource(more, ctx())).sort()).toEqual(
      ['lecture.bare_link', 'lecture.fence_language', 'lecture.h1_multiple', 'lecture.heading_skip', 'lecture.table_columns'].sort(),
    )
  })

  it('asks for the required headings of check.config.json, with exemptions and the last lecture', () => {
    const rules = [{ heading: '## 下一讲预告', exceptLastLecture: true, exempt: ['g01/L09'] }]
    expect(codes(checkLectureSource(GOOD, ctx({ requiredHeadings: rules })))).toEqual(['lecture.required_heading'])
    expect(checkLectureSource(GOOD, ctx({ requiredHeadings: rules, isLast: true }))).toEqual([])
    expect(checkLectureSource(GOOD, ctx({ requiredHeadings: rules, key: 'g01/L09' }))).toEqual([])
    expect(checkLectureSource(`${GOOD}\n## 下一讲预告\n\n下一讲讲什么。\n`, ctx({ requiredHeadings: rules }))).toEqual([])
    expect(checkLectureSource(GOOD, ctx({ requiredHeadings: rules, translation: true }))).toEqual([])
  })

  it('passes the skeleton new:lecture writes', () => {
    const src = renderLecture({ lang: 'zh-CN', groupId: 'G01', n: 2, title: '骨架', node: 'g01_l02', requiredHeadings: ['## 下一讲预告'] })
    expect(checkLectureSource(src, ctx({ requiredHeadings: [{ heading: '## 下一讲预告' }] }))).toEqual([])
    expect(checkLectureSource(renderLecture({ lang: 'en', groupId: 'G01', n: 2, title: 'Skeleton' }), ctx({ translation: true }))).toEqual([])
  })

  it('compares the chart placeholders of a translation with its original', () => {
    expect(compareTranslationCharts(GOOD, GOOD, 'lectures/en/g01/L02.md')).toEqual([])
    const missing = compareTranslationCharts(GOOD, GOOD.replace(/<figure class="chart"[^\n]*\n/, ''), 'lectures/en/g01/L02.md')
    expect(missing).toEqual([expect.objectContaining({ level: 'warn', code: 'translation.charts_differ' })])
  })
})

describe('concept page rules (ported) and graph checks', () => {
  const concept = (body: string, extra = '') =>
    `---\ntitle: T\nterm: t\nenglish: e\nfield: f\ngroups: [g01]\nsummary: s\nstatus: published\n${extra}---\n\n# t\n\n${body}\n`
  it('requires fields, sources per section and no unresolved marks on published pages', () => {
    expect(checkConceptSource(concept('正文（出处：某书 §1）。'), { file: 'concepts/t.md', isDraft: false })).toEqual([])
    expect(codes(checkConceptSource(concept('正文没有出处。'), { file: 'concepts/t.md', isDraft: false }))).toEqual(['concept.source_missing'])
    expect(codes(checkConceptSource(concept('正文（出处：x）待核实'), { file: 'concepts/t.md', isDraft: false }))).toEqual(['concept.unverified'])
    expect(codes(checkConceptSource(concept('正文待核实'), { file: 'concepts/_drafts/t.md', isDraft: true }))).toEqual(['concept.unverified_draft'])
    const noField = concept('（出处：x）').replace('english: e\n', '')
    expect(codes(checkConceptSource(noField, { file: 'concepts/t.md', isDraft: false }))).toEqual(['concept.field_missing'])
    expect(codes(checkConceptSource(concept('**未闭合（出处：x）'), { file: 'c', isDraft: false }))).toEqual(['concept.bold_unbalanced'])
  })

  it('fails bindings to missing lectures and warns on graph nodes that point nowhere', () => {
    const exists = (l: string) => l === '/g01/L01'
    const issues = checkGraph({
      graph: { nodes: [{ id: 'a', lecture: '/g01/L01' }, { id: 'b', lecture: '/g01/L09' }] },
      bindings: { schema: 1, bindings: { a: '/g01/L01', b: '/g09/L01', zz: '/g01/L01' } },
      graphFile: 'graph/graph.json',
      bindingsFile: 'graph/graph-bindings.json',
      lectureLinkExists: exists,
    })
    expect(issues.map((i) => `${i.level}:${i.code}`)).toEqual(['warn:graph.lecture_missing', 'fail:graph.binding_lecture_missing', 'warn:graph.binding_node_unknown'])
    expect(checkGraph({ graph: null, bindings: null, graphFile: 'g', bindingsFile: 'b', lectureLinkExists: exists })).toEqual([])
    expect(codes(checkGraph({ graph: 'invalid', bindings: { nope: 1 }, graphFile: 'g', bindingsFile: 'b', lectureLinkExists: exists }))).toEqual(['graph.invalid', 'graph.bindings_invalid'])
  })
})

describe('npm run check:content end to end', () => {
  it('fails on an empty site name, passes once filled, and fails a broken chart', async () => {
    const target = tmp('s4-check-')
    const prev = process.env.LECTURE_CONTENT_DIR
    process.env.LECTURE_CONTENT_DIR = target
    try {
      const paths = resolveContent({ env: process.env })
      initContent({ paths })
      const empty = await runContentCheck({ paths })
      expect(empty.ok).toBe(false)
      expect(codes(empty.issues, 'fail')).toEqual(['texts.required', 'texts.required'])
      expect(codes(empty.issues, 'info')).toContain('texts.empty')

      const texts = JSON.parse(fs.readFileSync(paths.siteTexts, 'utf8'))
      texts.zh.name = '示例站'
      texts.en.name = 'Example site'
      fs.writeFileSync(paths.siteTexts, JSON.stringify(texts))
      await newGroup({ id: 'DC', dir: 'digital', title: 'D' }, { paths })
      await newLecture({ group: 'DC', title: 'a', node: 'dc_a' }, { paths })
      const ok = await runContentCheck({ paths })
      expect(ok.issues.filter((i) => i.level !== 'info')).toEqual([])
      expect(ok.ok).toBe(true)
      expect(ok.counts).toMatchObject({ groups: 1, lectures: 1 })

      fs.appendFileSync(path.join(paths.lecturesDir, 'digital', 'L01.md'), '\n<figure class="chart" data-lecture="DC-L01" data-id="c1" data-type="mermaid"></figure>\n')
      const broken = await runContentCheck({ paths })
      expect(broken.ok).toBe(false)
      expect(codes(broken.issues, 'fail')).toEqual(['chart.file_missing'])
      fs.writeFileSync(path.join(paths.chartsDir, 'DC-L01.json'), JSON.stringify({ c1: { type: 'mermaid', code: 'flowchart TB\n a-->b' } }))
      expect((await runContentCheck({ paths })).ok).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.LECTURE_CONTENT_DIR
      else process.env.LECTURE_CONTENT_DIR = prev
    }
  }, 60_000)
})

describe('check:content --only <category> (the Dashboard reruns one check)', () => {
  it('parses --only and refuses unknown categories', () => {
    expect(onlyFromArgv(['--json'])).toBeNull()
    expect(onlyFromArgv(['--only', 'chart'])).toEqual(['chart'])
    expect(onlyFromArgv(['--only=texts,chart', '--json'])).toEqual(['chart', 'texts'])
    expect(onlyFromArgv(['--only', 'chart', '--only', 'chart'])).toEqual(['chart'])
    expect(() => onlyFromArgv(['--only'])).toThrow(/needs a category/)
    expect(() => parseOnly('charts')).toThrow(/unknown check category "charts"/)
    expect(() => parseOnly('../x')).toThrow(/unknown/)
    expect(categoryOf('texts.required')).toBe('texts')
    expect([...CHECK_CATEGORIES]).toEqual(['group', 'lecture', 'link', 'chart', 'translation', 'concept', 'figure', 'graph', 'texts'])
  })

  it('reports only the asked categories, still sees charts nobody places, and skips the engine checks of the others', async () => {
    const target = tmp('s4-check-only-')
    const prev = process.env.LECTURE_CONTENT_DIR
    process.env.LECTURE_CONTENT_DIR = target
    try {
      const paths = resolveContent({ env: process.env })
      initContent({ paths })
      await newGroup({ id: 'DC', dir: 'digital', title: 'D' }, { paths })
      await newLecture({ group: 'DC', title: 'a', node: 'dc_a' }, { paths })
      fs.appendFileSync(path.join(paths.lecturesDir, 'digital', 'L01.md'), '\n<figure class="chart" data-lecture="DC-L01" data-id="c1" data-type="mermaid"></figure>\n')
      fs.writeFileSync(path.join(paths.chartsDir, 'DC-L09.json'), JSON.stringify({ c1: { type: 'mermaid', code: 'flowchart TB\n a-->b' } }))

      const full = await runContentCheck({ paths })
      expect(full.only).toBeNull()
      expect(codes(full.issues, 'fail').sort()).toEqual(['chart.file_missing', 'texts.required', 'texts.required'])

      const charts = await runContentCheck({ paths, only: ['chart'] })
      expect(charts.only).toEqual(['chart'])
      expect(new Set(charts.issues.map((i) => categoryOf(i.code)))).toEqual(new Set(['chart']))
      expect(codes(charts.issues).sort()).toEqual(['chart.file_missing', 'chart.orphan'])
      expect(charts.totals).toEqual({ fail: 1, warn: 1, info: 0 })
      expect(charts.ok).toBe(false)
      expect(charts.counts.figures).toBe(0)

      const texts = await runContentCheck({ paths, only: ['texts'] })
      expect(codes(texts.issues, 'fail')).toEqual(['texts.required', 'texts.required'])
      expect(texts.issues.every((i) => i.code.startsWith('texts.'))).toBe(true)

      const graph = await runContentCheck({ paths, only: ['graph'] })
      expect(graph.issues).toEqual([])
      expect(graph.ok).toBe(true)

      fs.writeFileSync(
        paths.groups,
        `export const GROUPS = [{ id: 'DC', dir: 'digital', title: 'D', temp: 'yes' }]\n`,
      )
      const badTemp = await runContentCheck({ paths, only: ['group'] })
      expect(badTemp.ok).toBe(false)
      expect(codes(badTemp.issues, 'fail')).toContain('group.invalid_temp')
    } finally {
      if (prev === undefined) delete process.env.LECTURE_CONTENT_DIR
      else process.env.LECTURE_CONTENT_DIR = prev
    }
  }, 60_000)
})
