/**
 * S4a: templates/content, `npm run init`, `new:group`, `new:lecture`, and translation trees in `content:sync`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveContent, translationDirOf } from '../../docs/.vitepress/content/paths.mts'
import { loadTsModule } from '../../docs/.vitepress/content/ts-loader.mts'
import {
  appendGroupEntry,
  findGroupsArrayEnd,
  initContent,
  newGroup,
  newLecture,
  renderGroupEntry,
  ScaffoldError,
} from '../../scripts/content/scaffold.mts'
import { syncContent } from '../../scripts/content/sync.mts'

const SITE_DIR = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(SITE_DIR, '..')
const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'content')

const tempRoots: string[] = []
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(d)
  return d
}
afterEach(() => {
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop() as string, { recursive: true, force: true })
})

/** A repo skeleton whose `templates/content` is a copy of the real template. */
function repoWithTemplate(): string {
  const root = tmp('s4-repo-')
  fs.mkdirSync(path.join(root, 'site', 'docs', '.vitepress'), { recursive: true })
  fs.cpSync(TEMPLATE_DIR, path.join(root, 'templates', 'content'), { recursive: true })
  return root
}

describe('paths for authoring', () => {
  it('names the init target, the template, check.config.json and translation folders', () => {
    const repo = repoWithTemplate()
    const inPlace = resolveContent({ repoRoot: repo, env: {} })
    expect(inPlace.mode).toBe('in-place')
    expect(inPlace.initTarget).toBe(path.join(repo, 'content'))
    expect(inPlace.templateDir).toBe(path.join(repo, 'templates', 'content'))
    const custom = path.join(repo, 'my-content')
    const viaEnv = resolveContent({ repoRoot: repo, env: { LECTURE_CONTENT_DIR: custom } })
    expect(viaEnv.initTarget).toBe(custom)
    expect(viaEnv.checkConfig).toBe(path.join(custom, 'check.config.json'))
    expect(viaEnv.authoringLocal).toBe(path.join(custom, 'AUTHORING.local.md'))
    expect(translationDirOf(viaEnv, 'en', 'g01')).toBe(path.join(custom, 'lectures', 'en', 'g01'))
  })
})

describe('templates/content', () => {
  it('ships the engine defaults with every site text empty and no groups', async () => {
    const example = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'site-texts.example.json'), 'utf8'))
    const texts = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'site-texts.json'), 'utf8'))
    expect(texts).toEqual(example)
    for (const block of Object.values(texts) as Record<string, string>[]) for (const v of Object.values(block)) expect(v).toBe('')
    expect(fs.readFileSync(path.join(TEMPLATE_DIR, 'prompts', 'companion.json'), 'utf8')).toBe(
      fs.readFileSync(path.join(SITE_DIR, 'prompts', 'companion.example.json'), 'utf8'),
    )
    const groups = await loadTsModule<{ GROUPS: unknown[] }>(path.join(TEMPLATE_DIR, 'groups.ts'))
    expect(groups.GROUPS).toEqual([])
    const config = await loadTsModule<{ default: Record<string, unknown> }>(path.join(TEMPLATE_DIR, 'site.config.ts'))
    expect(config.default).toMatchObject({ theme: 'datasheet' })
    expect(config.default.access).toBeUndefined()
    expect(JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'check.config.json'), 'utf8'))).toEqual({ requiredHeadings: [] })
    expect(fs.readFileSync(path.join(TEMPLATE_DIR, '.gitignore'), 'utf8')).toMatch(/^\.env$/m)
  })

  it('holds none of the owner content (group titles of the active content folder)', async () => {
    const active = resolveContent()
    if (active.mode !== 'content' || !fs.existsSync(active.groups)) return
    const own = await loadTsModule<{ GROUPS: { title: string; tagline: string }[] }>(active.groups)
    const texts = fs.readdirSync(TEMPLATE_DIR, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
      .join('\n')
    for (const g of own.GROUPS) {
      expect(texts.includes(g.title)).toBe(false)
      if (g.tagline) expect(texts.includes(g.tagline)).toBe(false)
    }
  })
})

describe('npm run init', () => {
  it('copies the template, creates the content folders and refuses a second run', () => {
    const repo = repoWithTemplate()
    const paths = resolveContent({ repoRoot: repo, env: {} })
    const res = initContent({ paths })
    expect(res.root).toBe(path.join(repo, 'content'))
    expect(res.files).toEqual(expect.arrayContaining(['site.config.ts', 'site-texts.json', 'groups.ts', 'prompts/companion.json', 'AUTHORING.local.md', '.gitignore']))
    for (const d of ['lectures', 'charts', 'figures', 'concepts', 'graph']) expect(fs.statSync(path.join(repo, 'content', d)).isDirectory()).toBe(true)
    // the folder is now a content root
    expect(resolveContent({ repoRoot: repo, env: {} }).mode).toBe('content')
    expect(() => initContent({ paths })).toThrow(ScaffoldError)
  })

  it('accepts an empty existing folder and refuses one that holds anything', () => {
    const repo = repoWithTemplate()
    const target = path.join(repo, 'elsewhere')
    fs.mkdirSync(target)
    expect(initContent({ paths: resolveContent({ repoRoot: repo, env: { LECTURE_CONTENT_DIR: target } }) }).root).toBe(target)
    const busy = path.join(repo, 'busy')
    fs.mkdirSync(busy)
    fs.writeFileSync(path.join(busy, 'notes.txt'), 'x')
    expect(() => initContent({ paths: resolveContent({ repoRoot: repo, env: { LECTURE_CONTENT_DIR: busy } }) })).toThrow(/not empty/)
    expect(fs.readdirSync(busy)).toEqual(['notes.txt'])
  })
})

describe('groups.ts editing', () => {
  it('appends after existing entries, skipping brackets inside strings and comments', async () => {
    const src = [
      '// a comment with ] and [',
      'export const GROUPS: X[] = [',
      "  { id: 'A', dir: 'a', title: 'has ] inside', tagline: `t]`, summary: \"s\", accent: '#000000', tags: ['x'] }, // ] here",
      '  /* ] */',
      "  { id: 'B', dir: 'b', title: 'B', tagline: '', summary: '', accent: '#000000', tags: [] }",
      ']',
      'export const OTHER = [1]',
      '',
    ].join('\n')
    const { close } = findGroupsArrayEnd(src)
    expect(src.slice(close, close + 2)).toBe(']\n')
    const out = appendGroupEntry(src, renderGroupEntry({ id: 'C', dir: 'c', title: "it's \\ new" }))
    const dir = tmp('s4-groups-')
    const file = path.join(dir, 'groups.ts')
    fs.writeFileSync(file, out.replace('X[]', 'unknown[]'))
    const mod = await loadTsModule<{ GROUPS: { id: string; title: string }[]; OTHER: number[] }>(file)
    expect(mod.GROUPS.map((g) => g.id)).toEqual(['A', 'B', 'C'])
    expect(mod.GROUPS[2]?.title).toBe("it's \\ new")
    expect(mod.OTHER).toEqual([1])
  })

  it('appends into an empty array', () => {
    const out = appendGroupEntry('export const GROUPS = [\n]\n', renderGroupEntry({ id: 'G01', dir: 'g01', title: 'T' }))
    expect(out).toMatch(/export const GROUPS = \[\n {2}\{\n {4}id: 'G01',/)
  })

  it('refuses a file without a GROUPS array', () => {
    expect(() => findGroupsArrayEnd('export default []')).toThrow(ScaffoldError)
  })
})

async function freshContent(): Promise<{ repo: string; paths: ReturnType<typeof resolveContent> }> {
  const repo = repoWithTemplate()
  initContent({ paths: resolveContent({ repoRoot: repo, env: {} }) })
  return { repo, paths: resolveContent({ repoRoot: repo, env: {} }) }
}

describe('npm run new:group / new:lecture', () => {
  it('adds a group with its page, and refuses duplicates and engine folders', async () => {
    const { paths } = await freshContent()
    const res = await newGroup({ id: 'DC', dir: 'digital', title: '数字电路', tagline: '门电路到状态机', titleEn: 'Digital circuits' }, { paths })
    expect(res.files).toEqual(['groups.ts', 'lectures/digital/index.md'])
    const mod = await loadTsModule<{ GROUPS: Record<string, unknown>[] }>(paths.groups)
    expect(mod.GROUPS).toEqual([
      { id: 'DC', dir: 'digital', title: '数字电路', tagline: '门电路到状态机', summary: '', accent: '#3B82F6', tags: [], i18n: { en: { title: 'Digital circuits' } } },
    ])
    expect(fs.readFileSync(path.join(paths.lecturesDir, 'digital', 'index.md'), 'utf8')).toContain('<GroupIndex />')
    await expect(newGroup({ id: 'dc', dir: 'other', title: 'x' }, { paths })).rejects.toThrow(/already used/)
    await expect(newGroup({ id: 'X1', dir: 'digital', title: 'x' }, { paths })).rejects.toThrow(/already used/)
    for (const dir of ['en', 'public', 'examples/x', 'Bad Dir']) {
      await expect(newGroup({ id: 'Y1', dir, title: 'x' }, { paths })).rejects.toThrow(ScaffoldError)
    }
    await expect(newGroup({ id: 'Z1', dir: 'z', title: 'x', accent: 'red' }, { paths })).rejects.toThrow(/accent/)
  })

  it('refuses to scaffold without a content folder', async () => {
    const repo = repoWithTemplate()
    const paths = resolveContent({ repoRoot: repo, env: {} })
    await expect(newGroup({ id: 'A', dir: 'a', title: 'A' }, { paths })).rejects.toThrow(/npm run init/)
    await expect(newLecture({ group: 'A', title: 'x' }, { paths })).rejects.toThrow(/npm run init/)
  })

  it('numbers lectures, writes the translation, adds required headings, and never overwrites', async () => {
    const { paths } = await freshContent()
    fs.writeFileSync(paths.checkConfig, JSON.stringify({ requiredHeadings: [{ heading: '## 下一讲预告' }] }))
    await newGroup({ id: 'DC', dir: 'digital', title: '数字电路' }, { paths })
    const first = await newLecture({ group: 'DC', title: '门电路', node: 'dc_gates', titleEn: 'Gates' }, { paths })
    expect(first.n).toBe(1)
    expect(first.files).toEqual(['lectures/digital/L01.md', 'lectures/en/digital/L01.md'])
    const second = await newLecture({ group: 'digital', title: '化简' }, { paths })
    expect(second.files).toEqual(['lectures/digital/L02.md'])
    const tenth = await newLecture({ group: 'dc', title: '十', n: 10 }, { paths })
    expect(tenth.files).toEqual(['lectures/digital/L10.md'])
    expect((await newLecture({ group: 'DC', title: '下一个' }, { paths })).n).toBe(11)
    await expect(newLecture({ group: 'DC', title: 'dup', n: 2 }, { paths })).rejects.toThrow(/already exists/)
    await expect(newLecture({ group: 'NOPE', title: 'x' }, { paths })).rejects.toThrow(/No group/)
    await expect(newLecture({ group: 'DC', title: 'x', node: 'bad id' }, { paths })).rejects.toThrow(/node/)

    const l1 = fs.readFileSync(path.join(paths.lecturesDir, 'digital', 'L01.md'), 'utf8')
    expect(l1).toContain('title: "第1讲 · 门电路"')
    expect(l1).toContain('description: "节点 `dc_gates` ｜ 亚组: DC ｜ 难度 ★★ ｜ 预估 60min"')
    expect(l1).toContain('\n## 下一讲预告\n')
    const en = fs.readFileSync(path.join(paths.lecturesDir, 'en', 'digital', 'L01.md'), 'utf8')
    expect(en).toContain('title: "Lecture 1 · Gates"')
    expect(en).not.toContain('下一讲预告')
    // groups.ts is untouched by new:lecture (counts are derived)
    const mod = await loadTsModule<{ GROUPS: unknown[] }>(paths.groups)
    expect(mod.GROUPS).toHaveLength(1)
  })
})

describe('content:sync translation trees', () => {
  async function repoWithLectures(): Promise<{ repo: string; content: string }> {
    const { repo, paths } = await freshContent()
    fs.writeFileSync(path.join(repo, 'site', 'docs', 'index.md'), '# Home\n')
    await newGroup({ id: 'DC', dir: 'digital', title: 'D' }, { paths })
    await newLecture({ group: 'DC', title: 'a', titleEn: 'A' }, { paths })
    return { repo, content: paths.root }
  }

  it('copies lectures/en/<dir>/Lxx.md into site/docs/en/<dir>/', async () => {
    const { repo } = await repoWithLectures()
    const res = await syncContent({ repoRoot: repo, env: {}, quiet: true })
    expect(res.copied).toEqual(expect.arrayContaining(['digital/L01.md', 'digital/index.md', 'en/digital/L01.md']))
    expect(fs.readFileSync(path.join(repo, 'site', 'docs', 'en', 'digital', 'L01.md'), 'utf8')).toContain('Lecture 1 · A')
  })

  it('refuses files that would replace the engine pages of a language', async () => {
    const { repo, content } = await repoWithLectures()
    const en = path.join(content, 'lectures', 'en')
    for (const [rel, body] of [
      ['index.md', '# x'],
      ['L01.md', '# x'],
      ['digital/index.md', '# x'],
      ['[group]/index.md', '# x'],
      ['dashboard.md', '# x'],
    ] as const) {
      const file = path.join(en, ...rel.split('/'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, body)
      await expect(syncContent({ repoRoot: repo, env: {}, quiet: true }), rel).rejects.toMatchObject({ exitCode: 3 })
      fs.rmSync(file)
    }
  })
})
