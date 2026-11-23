import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import MarkdownIt from 'markdown-it'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAccess } from '../../docs/.vitepress/access/tiers.ts'
import { conceptLinkPlugin } from '../../docs/.vitepress/plugins/conceptLinkPlugin.mts'
import {
  collectLectureCitationsFromMarkdown,
  createFiguresMarkdownPlugin,
  decodeFigurePayload,
} from '../../docs/.vitepress/figures/markdown.ts'
import type { ResolvedFigureMountProps } from '../../docs/.vitepress/figures/types.ts'

const dirs: string[] = []
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f8-xref-'))
  dirs.push(root)
  const figuresDir = path.join(root, 'figures')
  fs.mkdirSync(path.join(figuresDir, 'g01'), { recursive: true })
  fs.mkdirSync(path.join(figuresDir, 'g09'), { recursive: true })

  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"/>')
  const sha = createHash('sha256').update(svg).digest('hex').slice(0, 12)
  fs.writeFileSync(path.join(figuresDir, 'g01/fig-a.svg'), svg)
  fs.writeFileSync(path.join(figuresDir, 'g01/tab-b.svg'), svg)
  fs.writeFileSync(path.join(figuresDir, 'g01/fig-c.svg'), svg)
  fs.writeFileSync(path.join(figuresDir, 'g09/secret-diagram.svg'), svg)

  fs.writeFileSync(
    path.join(figuresDir, 'g01/figures.json'),
    JSON.stringify({
      version: 1,
      group: 'g01',
      figures: [
        {
          id: 'alpha',
          file: 'fig-a.svg',
          kind: 'figure',
          width: 320,
          height: 180,
          caption: { zh: '第一个系统图', en: 'First system figure' },
          source: { paper: 'Paper Alpha', number: 'Fig. 1', page: 2 },
          sha256: sha,
        },
        {
          id: 'bench',
          file: 'tab-b.svg',
          kind: 'table',
          width: 320,
          height: 180,
          caption: { zh: '实验结果表', en: 'Benchmark summary table' },
          source: { paper: 'Paper Alpha', number: 'Table I', page: 4 },
          sha256: sha,
        },
        {
          id: 'beta',
          file: 'fig-c.svg',
          kind: 'figure',
          width: 320,
          height: 180,
          caption: { zh: '第二个曲线图', en: 'Second curve plot' },
          source: { paper: 'Paper Alpha', number: 'Fig. 2', page: 5 },
          sha256: sha,
        },
      ],
    }),
  )

  fs.writeFileSync(
    path.join(figuresDir, 'g09/figures.json'),
    JSON.stringify({
      version: 1,
      group: 'g09',
      figures: [
        {
          id: 'restricted-diag',
          file: 'secret-diagram.svg',
          kind: 'figure',
          width: 320,
          height: 180,
          caption: { zh: '受限课程秘密架构图', en: 'Restricted group architecture' },
          source: { paper: 'Restricted Paper 2026', number: 'Fig. 9', page: 9 },
          sha256: sha,
        },
      ],
    }),
  )

  const plan = resolveAccess({
    access: {
      default: 'public',
      enforcement: 'gateway',
      groups: { G09: { read: 'authenticated' } },
    },
    groupIds: ['G01', 'G09'],
  })

  const md = new MarkdownIt({ html: true })
  md.use(
    createFiguresMarkdownPlugin({
      paths: { figuresDir },
      groupDirs: ['g01', 'g09'],
      groupIdByDir: new Map([
        ['g01', 'G01'],
        ['g09', 'G09'],
      ]),
      localeKeys: ['en'],
      accessPlan: plan,
      isBuild: true,
    }),
  )
  return { md }
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true })
})

describe('figures/markdown (build-time numbering & cross-references)', () => {
  it('numbers figures and tables separately in order of appearance, compiles empty & custom xrefs, and records backlinks', () => {
    const { md } = makeFixture()
    const src = [
      '先引用 [](fig:beta)，再看 [](tab:bench)，以及 [前文架构](fig:alpha) 和再提 [](fig:alpha)。',
      '',
      '<LectureFigure id="beta" />',
      '',
      '<LectureFigure id="bench" size="medium" float="none" />',
      '',
      '<LectureFigure id="alpha" />',
    ].join('\n')

    const html = md.render(src, { relativePath: 'g01/L01.md' })
    expect(html).toContain('>图 1</a>') // beta appeared first -> 图 1
    expect(html).toContain('>表 1</a>') // table numbered separately -> 表 1
    expect(html).toContain('>前文架构</a>') // alpha appeared second -> 图 2, custom label preserved
    expect(html).toContain('>图 2</a>')

    const mounts = [...html.matchAll(/<LectureFigure\s+encoded="([^"]+)"\s*\/>/g)].map((m) =>
      decodeFigurePayload<ResolvedFigureMountProps>(m[1] ?? ''),
    )
    expect(mounts).toHaveLength(3)
    expect(mounts[0]?.items[0]).toMatchObject({ id: 'beta', num: 1, backlinks: [{ anchorId: 'xref-beta-1', label: '↩' }] })
    expect(mounts[1]?.items[0]).toMatchObject({ id: 'bench', num: 1, kind: 'table', backlinks: [{ anchorId: 'xref-bench-1', label: '↩' }] })
    expect(mounts[2]?.items[0]).toMatchObject({
      id: 'alpha',
      num: 2,
      backlinks: [
        { anchorId: 'xref-alpha-1', label: '↩1' },
        { anchorId: 'xref-alpha-2', label: '↩2' },
      ],
    })
  })

  it('keeps [](fig:id), [](tab:id) and [text](concept:slug) working together in one paragraph, a table cell and emphasis (F8 + F9 plugins)', () => {
    const { md } = makeFixture()
    const plan = resolveAccess({ access: { default: 'public', enforcement: 'gateway' }, groupIds: ['G01', 'G09'] })
    md.use(conceptLinkPlugin, {
      isBuild: true,
      accessPlan: plan,
      resolveConcept: (slug) => (slug === 'lease' ? { slug, tier: 'public', isDraft: false } : null),
      tierOfPage: () => 'public',
    })
    const src = [
      '段落：[](fig:alpha)、[租约](concept:lease) 与 [](tab:bench) 同行，再有 *强调里的 [租约](concept:lease)* 与 [](fig:beta)。',
      '',
      '| 列 | 内容 |',
      '| --- | --- |',
      '| 1 | 见 [](fig:alpha) 与 [租约](concept:lease) 以及 **[](tab:bench)** |',
      '',
      '<LectureFigure id="alpha" />',
      '',
      '<LectureFigure id="beta" />',
      '',
      '<LectureFigure id="bench" size="medium" float="none" />',
    ].join('\n')
    const html = md.render(src, { relativePath: 'g01/L01.md' })
    expect(html).toContain('<table>')
    expect((html.match(/<a[^>]*class="lec-term"[^>]*href="\/concepts\/lease"[^>]*>租约<\/a>/g) ?? []).length + (html.match(/<a[^>]*href="\/concepts\/lease"[^>]*class="lec-term"[^>]*>租约<\/a>/g) ?? []).length).toBe(3)
    expect(html).toContain('<em>强调里的 <a')
    expect((html.match(/class="lec-xref"/g) ?? []).length).toBe(5)
    expect(html).toContain('>图 1</a>')
    expect(html).toContain('>表 1</a>')
    expect(html).toContain('<strong><a href="#fig-bench"')
    expect(html).not.toContain('concept:lease')
  })

  it('uses English Fig./Table labels and English captions under /en/ pages', () => {
    const { md } = makeFixture()
    const html = md.render('See [](fig:alpha) and [](tab:bench).\n\n<LectureFigure id="alpha" />\n', {
      relativePath: 'en/g01/L01.md',
    })
    expect(html).toContain('>Fig. 1</a>')
    expect(html).toContain('>Table 1</a>')
    const enc = /encoded="([^"]+)"/.exec(html)?.[1] ?? ''
    const props = decodeFigurePayload<ResolvedFigureMountProps>(enc)
    expect(props?.items[0]?.caption).toBe('First system figure')
    expect(html).not.toMatch(/[\u4e00-\u9fff]/)
  })

  it('ignores code blocks and inline code, but throws on unknown id, kind mismatch, or cross-tier citations', () => {
    const { md } = makeFixture()
    const safeDoc = '示例语法：`[](fig:missing)` 与\n\n```md\n<LectureFigure id="missing" />\n```\n'
    expect(() => md.render(safeDoc, { relativePath: 'g01/L01.md' })).not.toThrow()

    expect(() => md.render('Bad [](fig:nope)', { relativePath: 'g01/L01.md' })).toThrow(/unknown figure/i)
    expect(() => md.render('Bad [](fig:bench)', { relativePath: 'g01/L01.md' })).toThrow(/expects kind="figure"/i)
    expect(() => md.render('Bad [](tab:alpha)', { relativePath: 'g01/L01.md' })).toThrow(/expects kind="table"/i)
    expect(() => md.render('Leak [](fig:g09/restricted-diag)', { relativePath: 'g01/L01.md' })).toThrow(/restricted/i)
    expect(() => md.render('<LectureFigure id="alpha" size="huge" />', { relativePath: 'g01/L01.md' })).toThrow(/invalid/i)
  })

  it('collects AST citations cleanly while skipping fenced code and inline code', () => {
    const src = [
      'Text `[](fig:fake)` and [](fig:alpha) and [t](tab:bench).',
      '```markdown',
      '<LectureFigure id="ignored" />',
      '```',
      '<LectureFigure :ids="[\'alpha\', \'beta\']" />',
    ].join('\n')
    const refs = collectLectureCitationsFromMarkdown(src, 'g01')
    expect(refs).toEqual([
      { kind: 'figure', targetGroup: 'g01', id: 'alpha' },
      { kind: 'table', targetGroup: 'g01', id: 'bench' },
      { kind: 'mount', targetGroup: 'g01', id: 'alpha' },
      { kind: 'mount', targetGroup: 'g01', id: 'beta' },
    ])
  })
})
