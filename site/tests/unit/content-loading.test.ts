import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveContent, watchExistingFrom, watchGlobFrom } from '../../docs/.vitepress/content/paths.mts'
import { loadLectureConfig, loadLectureConfigInfo, resolveSiteConfigFile } from '../../docs/.vitepress/content/config.mts'
import { LectureConfigError } from '../../docs/.vitepress/lecture-config.mts'
import { GROUPS_CANDIDATES, resolveGroups } from '../../docs/.vitepress/groups-source.mts'
import { ContentSyncError, cleanSyncedContent, syncContent, validateRelativePath } from '../../scripts/content/sync.mts'
import { formatDoctorText, runDoctor } from '../../scripts/config/doctor.mts'
import { SETTINGS } from '../../config/schema.ts'

const SITE_DIR = path.resolve(__dirname, '../..')
const REPO_ROOT = path.resolve(SITE_DIR, '..')
const FIXTURE_DEMO_DIR = path.resolve(__dirname, '../fixtures/content-demo')

const tempRoots: string[] = []

function makeTempRepo(options: { withContentDir?: boolean; withLegacyDocsOnly?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's1-content-test-'))
  tempRoots.push(root)

  const siteRoot = path.join(root, 'site')
  const docsRoot = path.join(siteRoot, 'docs')
  const vpRoot = path.join(docsRoot, '.vitepress')
  fs.mkdirSync(vpRoot, { recursive: true })
  fs.mkdirSync(path.join(docsRoot, 'public'), { recursive: true })
  fs.writeFileSync(path.join(docsRoot, 'index.md'), '# Home\n', 'utf8')
  fs.writeFileSync(path.join(docsRoot, 'dashboard.md'), '# Dashboard\n', 'utf8')

  fs.writeFileSync(
    path.join(siteRoot, 'lecture.config.ts'),
    `export default {
  theme: 'datasheet',
  themes: ['reader'],
  modules: { progress: { adapter: 'rest', notionSync: true }, auth: { adapter: 'trusted-header' } },
  access: { default: 'authenticated', enforcement: 'gateway' },
}\n`,
    'utf8',
  )

  if (options.withContentDir) {
    fs.mkdirSync(path.join(root, 'content', 'lectures'), { recursive: true })
    fs.writeFileSync(path.join(root, 'content', 'groups.ts'), 'export const GROUPS = []\n', 'utf8')
  } else if (options.withLegacyDocsOnly) {
    fs.mkdirSync(path.join(root, 'content', 'lectures'), { recursive: true })
    fs.writeFileSync(path.join(root, 'content', 'README.md'), '# Notes, not a content root\n', 'utf8')
  }

  return root
}

function collectFilesRecursive(dir: string, exts: readonly string[]): string[] {
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const curr = stack.pop()!
    for (const entry of fs.readdirSync(curr, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'cache') continue
      const abs = path.join(curr, entry.name)
      if (entry.isDirectory()) {
        stack.push(abs)
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        out.push(abs)
      }
    }
  }
  return out.sort()
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('V/content/paths.mts root resolution', () => {
  it('resolves priority env > <repo>/content > in-place and computes all contract fields', () => {
    const repo = makeTempRepo({ withContentDir: true })
    const customDir = path.join(repo, 'external-content')
    fs.mkdirSync(customDir, { recursive: true })

    // 1. Relative LECTURE_CONTENT_DIR resolves against repoRoot and overrides <repo>/content
    const fromRelEnv = resolveContent({ repoRoot: repo, env: { LECTURE_CONTENT_DIR: 'external-content' } })
    expect(fromRelEnv.mode).toBe('content')
    expect(fromRelEnv.root).toBe(customDir)
    expect(fromRelEnv.siteConfig).toBe(path.join(customDir, 'site.config.ts'))
    expect(fromRelEnv.siteTexts).toBe(path.join(customDir, 'site-texts.json'))
    expect(fromRelEnv.groups).toBe(path.join(customDir, 'groups.ts'))
    expect(fromRelEnv.lecturesDir).toBe(path.join(customDir, 'lectures'))
    expect(fromRelEnv.chartsDir).toBe(path.join(customDir, 'charts'))
    expect(fromRelEnv.figuresDir).toBe(path.join(customDir, 'figures'))
    expect(fromRelEnv.conceptsDir).toBe(path.join(customDir, 'concepts'))
    expect(fromRelEnv.promptsFile).toBe(path.join(customDir, 'prompts', 'companion.json'))
    expect(fromRelEnv.promptsExample).toBe(path.join(repo, 'site', 'prompts', 'companion.example.json'))
    expect(fromRelEnv.siteTextsExample).toBe(path.join(repo, 'site', 'site-texts.example.json'))
    expect(fromRelEnv.ignoredContentDir).toBeNull()
    expect(fromRelEnv.themeDir).toBe(path.join(customDir, 'theme'))
    expect(fromRelEnv.publicDir).toBe(path.join(customDir, 'public'))
    expect(fromRelEnv.graphDir).toEqual({
      dir: path.join(customDir, 'graph'),
      graph: path.join(customDir, 'graph', 'graph.json'),
      graphNotion: path.join(customDir, 'graph', 'graph-notion.json'),
      graphBindings: path.join(customDir, 'graph', 'graph-bindings.json'),
      notionKnowledgeGraph: path.join(customDir, 'graph', 'notion_knowledge_graph.json'),
    })

    // 2. Absolute LECTURE_CONTENT_DIR
    const absOther = path.join(repo, 'abs-content')
    const fromAbsEnv = resolveContent({ repoRoot: repo, env: { LECTURE_CONTENT_DIR: absOther } })
    expect(fromAbsEnv.mode).toBe('content')
    expect(fromAbsEnv.root).toBe(absOther)

    // 3. No env -> <repo>/content when V2 markers exist
    const fromRepoContent = resolveContent({ repoRoot: repo, env: {} })
    expect(fromRepoContent.mode).toBe('content')
    expect(fromRepoContent.root).toBe(path.join(repo, 'content'))

    // 3b. content/ with only site.config.ts also counts
    const repoCfg = makeTempRepo()
    fs.mkdirSync(path.join(repoCfg, 'content'))
    fs.writeFileSync(path.join(repoCfg, 'content', 'site.config.ts'), 'export default {}\n', 'utf8')
    expect(resolveContent({ repoRoot: repoCfg, env: {} }).mode).toBe('content')

    // 4. In-place mode when neither env nor a real <repo>/content exists (a content/ without site.config.ts and
    // groups.ts is not a content root and is reported through ignoredContentDir)
    const repoInPlace = makeTempRepo({ withLegacyDocsOnly: true })
    const inPlace = resolveContent({ repoRoot: repoInPlace, env: {} })
    expect(inPlace.mode).toBe('in-place')
    expect(inPlace.root).toBe(repoInPlace)
    expect(inPlace.ignoredContentDir).toBe(path.join(repoInPlace, 'content'))
    expect(inPlace.siteTexts).toBe(path.join(repoInPlace, 'site', 'site-texts.json'))
    expect(inPlace.siteTextsExample).toBe(path.join(repoInPlace, 'site', 'site-texts.example.json'))
    expect(inPlace.promptsFile).toBe(path.join(repoInPlace, 'site', 'prompts', 'companion.json'))
    expect(inPlace.promptsExample).toBe(path.join(repoInPlace, 'site', 'prompts', 'companion.example.json'))
    expect(inPlace.siteConfig).toBe(path.join(repoInPlace, 'site', 'lecture.config.ts'))
    expect(inPlace.groups).toBe(path.join(repoInPlace, 'site', 'docs', '.vitepress', 'groups.mts'))
    expect(inPlace.lecturesDir).toBe(path.join(repoInPlace, 'site', 'docs'))
    expect(inPlace.chartsDir).toBe(path.join(repoInPlace, 'site', 'docs', 'public', 'charts'))
    expect(inPlace.figuresDir).toBe(path.join(repoInPlace, 'site', 'docs', 'public', 'figures'))
    expect(inPlace.conceptsDir).toBe(path.join(repoInPlace, 'site', 'docs', 'concepts'))
    expect(inPlace.themeDir).toBe(path.join(repoInPlace, 'site', 'docs', '.vitepress', 'themes'))
    expect(inPlace.publicDir).toBe(path.join(repoInPlace, 'site', 'docs', 'public'))
    expect(inPlace.graphDir).toEqual({
      dir: path.join(repoInPlace, 'site', 'data'),
      graph: path.join(repoInPlace, 'site', 'data', 'graph.json'),
      graphNotion: path.join(repoInPlace, 'site', 'data', 'graph-notion.json'),
      graphBindings: path.join(repoInPlace, 'site', 'data', 'graph-bindings.json'),
      notionKnowledgeGraph: path.join(repoInPlace, 'site', 'docs', 'public', 'notion_knowledge_graph.json'),
    })

    // 5. S6: no env, no content root, but the engine's demo content -> content mode on it (demo: true); init still
    // targets <repo>/content, a content/ that is not a content root is still reported; LECTURE_DEMO=0 keeps in-place
    const demoDir = path.join(repoInPlace, 'templates', 'demo-content')
    fs.mkdirSync(demoDir, { recursive: true })
    fs.writeFileSync(path.join(demoDir, 'groups.ts'), 'export const GROUPS = []\n', 'utf8')
    const demo = resolveContent({ repoRoot: repoInPlace, env: {} })
    expect(demo.mode).toBe('content')
    expect(demo.demo).toBe(true)
    expect(demo.root).toBe(demoDir)
    expect(demo.lecturesDir).toBe(path.join(demoDir, 'lectures'))
    expect(demo.initTarget).toBe(path.join(repoInPlace, 'content'))
    expect(demo.ignoredContentDir).toBe(path.join(repoInPlace, 'content'))
    expect(resolveContent({ repoRoot: repoInPlace, env: { LECTURE_DEMO: '0' } }).mode).toBe('in-place')
    // a real content root and LECTURE_CONTENT_DIR both win over the demo
    expect(resolveContent({ repoRoot: repoInPlace, env: { LECTURE_CONTENT_DIR: 'elsewhere' } }).demo).toBeUndefined()
    fs.writeFileSync(path.join(repoInPlace, 'content', 'groups.ts'), 'export const GROUPS = []\n', 'utf8')
    const own = resolveContent({ repoRoot: repoInPlace, env: {} })
    expect(own.root).toBe(path.join(repoInPlace, 'content'))
    expect(own.demo).toBeUndefined()
  })

  it('current repository resolves by its own layout (content mode once content/ is a content root, S2)', () => {
    const paths = resolveContent({ env: {} })
    const contentDir = path.join(REPO_ROOT, 'content')
    const isContent = ['site.config.ts', 'groups.ts'].some((m) => fs.existsSync(path.join(contentDir, m)))
    // S6: without content of its own the repository shows the engine's demo content (templates/demo-content)
    const demoDir = path.join(REPO_ROOT, 'templates', 'demo-content')
    const isDemo = !isContent && fs.existsSync(path.join(demoDir, 'groups.ts'))
    expect(paths.mode).toBe(isContent || isDemo ? 'content' : 'in-place')
    expect(paths.repoRoot).toBe(REPO_ROOT)
    expect(paths.ignoredContentDir).toBeNull()
    const base = isContent ? contentDir : isDemo ? demoDir : SITE_DIR
    expect(paths.siteTexts).toBe(path.join(base, 'site-texts.json'))
    expect(paths.promptsFile).toBe(path.join(base, 'prompts', 'companion.json'))
  })

  it('watchGlobFrom and watchExistingFrom format relative in-place paths and skip missing content paths', () => {
    const fromDir = path.join(SITE_DIR, 'docs', '.vitepress', 'theme', 'progress')
    const rel = watchGlobFrom(fromDir, path.join(SITE_DIR, 'docs', 'public', 'notion_knowledge_graph.json'), 'in-place')
    expect(rel).toBe('../../../public/notion_knowledge_graph.json')
    const missing = path.join(FIXTURE_DEMO_DIR, 'graph', 'graph.json')
    const abs = watchGlobFrom(fromDir, missing, 'content')
    expect(path.isAbsolute(abs)).toBe(true)
    expect(abs).not.toContain('\\')
    expect(watchExistingFrom(fromDir, [missing, path.join(FIXTURE_DEMO_DIR, 'groups.ts')], 'content')).toEqual([
      path.join(FIXTURE_DEMO_DIR, 'groups.ts').replace(/\\/g, '/'),
    ])
  })
})

describe('loadLectureConfig()', () => {
  it('replaces whole file without merging when content/site.config.ts exists and falls back otherwise', () => {
    const repo = makeTempRepo({ withContentDir: true })

    // No content/site.config.ts yet -> falls back to site/lecture.config.ts
    const fallback = loadLectureConfigInfo({ repoRoot: repo, env: {} })
    expect(fallback.source).toBe('default')
    expect(fallback.file).toBe(path.join(repo, 'site', 'lecture.config.ts'))
    expect(fallback.config.theme).toBe('datasheet')
    expect(fallback.config.access).toEqual({ default: 'authenticated', enforcement: 'gateway' })

    // With content/site.config.ts -> loads whole file with NO merging
    const contentConfigFile = path.join(repo, 'content', 'site.config.ts')
    fs.writeFileSync(contentConfigFile, `export default { theme: 'reader' }\n`, 'utf8')
    const loaded = loadLectureConfigInfo({ repoRoot: repo, env: {} })
    expect(loaded.source).toBe('content')
    expect(loaded.file).toBe(contentConfigFile)
    expect(loaded.config.theme).toBe('reader')
    expect(loaded.config.access).toBeUndefined()
    expect(loaded.config.modules).toBeUndefined()
    expect(loaded.config.themes).toBeUndefined()
  })

  it('preserves defineLectureConfig validation errors for invalid content/site.config.ts', () => {
    const repo = makeTempRepo({ withContentDir: true })
    fs.writeFileSync(
      path.join(repo, 'content', 'site.config.ts'),
      `export default { theme: 'reader', access: { default: 'invalid-tier' } }\n`,
      'utf8',
    )
    expect(() => loadLectureConfig({ repoRoot: repo, env: {} })).toThrow(LectureConfigError)
    expect(() => loadLectureConfig({ repoRoot: repo, env: {} })).toThrow(/lecture\.config\.ts: access\.default/)
  })

  it('reloads an edited file (no module cache) and lets a config import the engine defineLectureConfig', () => {
    const repo = makeTempRepo({ withContentDir: true })
    const file = path.join(repo, 'content', 'site.config.ts')
    const engineModule = path.join(SITE_DIR, 'docs', '.vitepress', 'lecture-config.mts').replace(/\\/g, '/')
    fs.writeFileSync(file, `import { defineLectureConfig } from '${engineModule}'\nexport default defineLectureConfig({ theme: 'reader' })\n`, 'utf8')
    expect(loadLectureConfig({ repoRoot: repo, env: {} }).theme).toBe('reader')
    fs.writeFileSync(file, `import { defineLectureConfig } from '${engineModule}'\nexport default defineLectureConfig({ theme: 'datasheet' })\n`, 'utf8')
    expect(loadLectureConfig({ repoRoot: repo, env: {} }).theme).toBe('datasheet')
    // an error raised by that imported copy still is the engine's LectureConfigError
    fs.writeFileSync(
      file,
      `import { defineLectureConfig } from '${engineModule}'\nexport default defineLectureConfig({ theme: 'reader', access: { default: 'bogus' } as never })\n`,
      'utf8',
    )
    expect(() => loadLectureConfig({ repoRoot: repo, env: {} })).toThrow(LectureConfigError)
  })

  it('reports a runtime error of the config file with the real file and line', () => {
    const repo = makeTempRepo({ withContentDir: true })
    const file = path.join(repo, 'content', 'site.config.ts')
    fs.writeFileSync(file, `const a = 1\n\nthrow new Error('boom from config')\nexport default { theme: 'reader', a }\n`, 'utf8')
    let caught: unknown
    try {
      loadLectureConfig({ repoRoot: repo, env: {} })
    } catch (err) {
      caught = err
    }
    expect((caught as Error).message).toBe('boom from config')
    expect((caught as Error).stack).toMatch(/site\.config\.ts:3:/)
  })

  it('loads the fixture demo site.config.ts when LECTURE_CONTENT_DIR points at content-demo', () => {
    const paths = resolveContent({
      repoRoot: REPO_ROOT,
      env: { LECTURE_CONTENT_DIR: 'site/tests/fixtures/content-demo' },
    })
    const info = loadLectureConfigInfo({ paths })
    expect(info.source).toBe('content')
    expect(info.file).toBe(path.join(FIXTURE_DEMO_DIR, 'site.config.ts'))
    expect(info.config.theme).toBe('reader')
    expect(info.config.access).toEqual({ default: 'public', enforcement: 'none' })
    expect(resolveSiteConfigFile(paths).file).toBe(info.file)
  })
})

describe('groups-source.mts candidate order', () => {
  it('places content/groups.ts first ahead of legacy candidates', () => {
    expect(GROUPS_CANDIDATES.map((c) => c.file)).toEqual([
      'content/groups.ts',
      'content-groups.mts',
      'groups.mts',
    ])
  })

  it('prefers content/groups.ts when resolving from a content root and includes its path in logs', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '))
    })
    const prevEnv = process.env.LECTURE_CONTENT_DIR
    try {
      process.env.LECTURE_CONTENT_DIR = FIXTURE_DEMO_DIR
      const resolved = await resolveGroups()
      expect(resolved.GROUPS.map((g) => g.id)).toEqual(['D01', 'D02'])
      expect(logs.some((line) => line.includes('content/groups.ts') && line.includes(path.join(FIXTURE_DEMO_DIR, 'groups.ts')))).toBe(true)
    } finally {
      spy.mockRestore()
      if (prevEnv === undefined) delete process.env.LECTURE_CONTENT_DIR
      else process.env.LECTURE_CONTENT_DIR = prevEnv
    }
  })
})

describe('doctor and config:check report active site config file', () => {
  it('doctor embeds active siteConfigFile in report and formatted text', async () => {
    const fakeEnv: Record<string, string> = {}
    for (const s of SETTINGS.filter((x) => x.kind === 'secret')) {
      fakeEnv[s.key] = `SENTINEL_${s.key}`
    }
    const report = await runDoctor({
      sources: { repoRoot: '/fake', env: fakeEnv, dotenv: {}, legacy: {} },
      probe: false,
      probeRunner: async () => ({ reachable: true }),
    })
    expect(report.siteConfigFile).toBe(resolveContent({ env: {} }).siteConfig)
    expect(formatDoctorText(report)).toContain(report.siteConfigFile)
  })

  it('config:check prints active site config path under LECTURE_CONTENT_DIR', () => {
    const stdout = execFileSync(process.execPath, ['scripts/config/gen.mts', '--check'], {
      cwd: SITE_DIR,
      env: { ...process.env, LECTURE_CONTENT_DIR: FIXTURE_DEMO_DIR },
      encoding: 'utf8',
    })
    expect(stdout).toContain(path.join(FIXTURE_DEMO_DIR, 'site.config.ts'))
  })
})

describe('scripts/content/sync.mts', () => {
  let repo: string
  let contentRoot: string
  let docsRoot: string
  let manifestFile: string

  beforeEach(() => {
    repo = makeTempRepo({ withContentDir: true })
    contentRoot = path.join(repo, 'content')
    docsRoot = path.join(repo, 'site', 'docs')
    manifestFile = path.join(repo, 'site', '.lecture-build', 'content-sync.json')
    fs.mkdirSync(path.join(contentRoot, 'lectures', 'demo-a'), { recursive: true })
    fs.mkdirSync(path.join(contentRoot, 'charts'), { recursive: true })
    fs.mkdirSync(path.join(contentRoot, 'figures', 'demo-a'), { recursive: true })
    fs.mkdirSync(path.join(contentRoot, 'graph'), { recursive: true })
    fs.mkdirSync(path.join(contentRoot, 'public'), { recursive: true })
    fs.writeFileSync(path.join(contentRoot, 'groups.ts'), `export const GROUPS = [{ id: 'D01', dir: 'demo-a' }]\n`, 'utf8')
    fs.writeFileSync(path.join(contentRoot, 'lectures', 'demo-a', 'L01.md'), '# L01 v1\n', 'utf8')
    fs.writeFileSync(path.join(contentRoot, 'charts', 'D01-L01.json'), '{"c1":{"type":"echarts"}}\n', 'utf8')
    fs.writeFileSync(path.join(contentRoot, 'figures', 'demo-a', 'fig1.svg'), '<svg/>\n', 'utf8')
    fs.writeFileSync(path.join(contentRoot, 'graph', 'notion_knowledge_graph.json'), '[]\n', 'utf8')
    fs.writeFileSync(path.join(contentRoot, 'public', 'lecture_catalog.json'), '[]\n', 'utf8')
  })

  it('does nothing and writes no manifest in in-place mode', async () => {
    const emptyRepo = makeTempRepo()
    const res = await syncContent({ repoRoot: emptyRepo, env: {}, quiet: true })
    expect(res.mode).toBe('in-place')
    expect(res.copied).toEqual([])
    expect(fs.existsSync(res.manifestFile)).toBe(false)
  })

  it('copies lectures, charts, figures and public JSONs, records SHA-256 manifest, and prunes only stale manifest entries', async () => {
    // Untracked engine file must survive every sync & --clean
    const engineUntracked = path.join(docsRoot, 'engine-keep.md')
    fs.writeFileSync(engineUntracked, 'keep me\n', 'utf8')

    // Add L02, run initial sync
    fs.writeFileSync(path.join(contentRoot, 'lectures', 'demo-a', 'L02.md'), '# L02\n', 'utf8')
    const r1 = await syncContent({ repoRoot: repo, env: {}, quiet: true })
    expect(r1.mode).toBe('content')
    expect(r1.copied).toEqual(
      expect.arrayContaining([
        'demo-a/L01.md',
        'demo-a/L02.md',
        'public/charts/D01-L01.json',
        'public/figures/demo-a/fig1.svg',
        'public/notion_knowledge_graph.json',
        'public/lecture_catalog.json',
      ]),
    )
    expect(fs.existsSync(manifestFile)).toBe(true)
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      files: Record<string, { sha256: string }>
    }
    expect(manifest.files['demo-a/L01.md']?.sha256).toMatch(/^[0-9a-f]{64}$/)

    // Remove L02 from content and update L01 -> stale L02 deleted, engine-keep.md untouched
    fs.rmSync(path.join(contentRoot, 'lectures', 'demo-a', 'L02.md'))
    fs.writeFileSync(path.join(contentRoot, 'lectures', 'demo-a', 'L01.md'), '# L01 v2\n', 'utf8')
    const r2 = await syncContent({ repoRoot: repo, env: {}, quiet: true })
    expect(r2.deleted).toEqual(['demo-a/L02.md'])
    expect(r2.updated).toEqual(['demo-a/L01.md'])
    expect(fs.existsSync(path.join(docsRoot, 'demo-a', 'L02.md'))).toBe(false)
    expect(fs.readFileSync(path.join(docsRoot, 'demo-a', 'L01.md'), 'utf8')).toBe('# L01 v2\n')
    expect(fs.existsSync(engineUntracked)).toBe(true)

    // --clean deletes manifest files, empty created dirs, and manifest itself; preserves engine files
    const cleaned = cleanSyncedContent({ repoRoot: repo, env: {}, quiet: true })
    expect(cleaned.cleaned.length).toBeGreaterThanOrEqual(5)
    expect(fs.existsSync(manifestFile)).toBe(false)
    expect(fs.existsSync(path.join(docsRoot, 'demo-a'))).toBe(false)
    expect(fs.existsSync(path.join(docsRoot, 'public', 'charts'))).toBe(false)
    expect(fs.existsSync(path.join(docsRoot, 'public', 'figures'))).toBe(false)
    expect(fs.existsSync(engineUntracked)).toBe(true)
    expect(fs.existsSync(path.join(docsRoot, 'index.md'))).toBe(true)
  })

  it('mounts published concepts always and concept drafts only with drafts: true (dev), and prunes them again for a build', async () => {
    fs.mkdirSync(path.join(contentRoot, 'concepts', '_drafts'), { recursive: true })
    fs.writeFileSync(path.join(contentRoot, 'concepts', 'pub-one.md'), '# pub\n', 'utf8')
    fs.writeFileSync(path.join(contentRoot, 'concepts', '_drafts', 'draft-one.md'), '# draft\n', 'utf8')
    fs.writeFileSync(path.join(contentRoot, 'concepts', '_drafts', 'draft-one.ctx.json'), '{}', 'utf8')

    const build = await syncContent({ repoRoot: repo, env: {}, quiet: true })
    expect(build.copied).toContain('concepts/pub-one.md')
    expect(fs.existsSync(path.join(docsRoot, 'concepts', '_drafts'))).toBe(false)

    const dev = await syncContent({ repoRoot: repo, env: {}, quiet: true, drafts: true })
    expect(dev.copied).toContain('concepts/_drafts/draft-one.md')
    expect(fs.readFileSync(path.join(docsRoot, 'concepts', '_drafts', 'draft-one.md'), 'utf8')).toBe('# draft\n')
    expect(fs.existsSync(path.join(docsRoot, 'concepts', '_drafts', 'draft-one.ctx.json'))).toBe(false)

    const again = await syncContent({ repoRoot: repo, env: {}, quiet: true })
    expect(again.deleted).toContain('concepts/_drafts/draft-one.md')
    expect(fs.existsSync(path.join(docsRoot, 'concepts', '_drafts', 'draft-one.md'))).toBe(false)
  })

  it('never overwrites or cleans a file that content:sync did not write', async () => {
    const mine = path.join(docsRoot, 'demo-a', 'L01.md')
    fs.mkdirSync(path.dirname(mine), { recursive: true })
    fs.writeFileSync(mine, '# my own lecture\n', 'utf8')
    await expect(syncContent({ repoRoot: repo, env: {}, quiet: true })).rejects.toMatchObject({ exitCode: 3 })
    expect(fs.readFileSync(mine, 'utf8')).toBe('# my own lecture\n')

    // an identical file is left unmanaged: it survives --clean
    fs.writeFileSync(mine, '# L01 v1\n', 'utf8')
    await syncContent({ repoRoot: repo, env: {}, quiet: true })
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { files: Record<string, unknown> }
    expect(Object.keys(manifest.files)).not.toContain('demo-a/L01.md')
    cleanSyncedContent({ repoRoot: repo, env: {}, quiet: true })
    expect(fs.existsSync(mine)).toBe(true)
  })

  it('refuses to overwrite a copy modified in place (exitCode 3) unless --force is passed', async () => {
    await syncContent({ repoRoot: repo, env: {}, quiet: true })
    const syncedCopy = path.join(docsRoot, 'demo-a', 'L01.md')
    fs.writeFileSync(syncedCopy, '# EDITED IN DOCS\n', 'utf8')

    let caught: unknown
    try {
      await syncContent({ repoRoot: repo, env: {}, quiet: true })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ContentSyncError)
    expect((caught as ContentSyncError).exitCode).toBe(3)
    expect((caught as ContentSyncError).message).toContain('content/')

    const forced = await syncContent({ repoRoot: repo, env: {}, force: true, quiet: true })
    expect(forced.updated).toContain('demo-a/L01.md')
    expect(fs.readFileSync(syncedCopy, 'utf8')).toBe('# L01 v1\n')
  })

  it('accepts a copy that a dev tool wrote together with its source (copy equals the current source)', async () => {
    await syncContent({ repoRoot: repo, env: {}, quiet: true })
    const source = path.join(contentRoot, 'lectures', 'demo-a', 'L01.md')
    const syncedCopy = path.join(docsRoot, 'demo-a', 'L01.md')
    fs.writeFileSync(source, '# L01 v2 written by a dev tool\n', 'utf8')
    fs.writeFileSync(syncedCopy, '# L01 v2 written by a dev tool\n', 'utf8')

    const again = await syncContent({ repoRoot: repo, env: {}, quiet: true })
    expect(again.skipped).toContain('demo-a/L01.md')
    expect(fs.readFileSync(syncedCopy, 'utf8')).toBe('# L01 v2 written by a dev tool\n')
    // the manifest now records the new hash, so a later edit of the copy alone is refused again
    fs.writeFileSync(syncedCopy, '# EDITED IN DOCS\n', 'utf8')
    await expect(syncContent({ repoRoot: repo, env: {}, quiet: true })).rejects.toMatchObject({ exitCode: 3 })
  })

  it('refuses path traversal, absolute paths, targets outside site/docs/, symlinks, and engine collisions with exitCode 3', async () => {
    // Path validation helpers
    for (const bad of ['../escape.md', 'a/../b', '/etc/passwd', 'C:\\temp\\x']) {
      let caught: unknown
      try {
        validateRelativePath(bad, 'test')
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(ContentSyncError)
      expect((caught as ContentSyncError).exitCode).toBe(3)
    }

    // Symlink inside content directory
    // (a file symlink needs a privilege on Windows: use a directory junction, which lstat reports as a link as well)
    const outsideDir = path.join(repo, 'outside')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret\n', 'utf8')
    const linkPath = path.join(contentRoot, 'lectures', 'demo-a', 'link')
    fs.symlinkSync(outsideDir, linkPath, 'junction')
    await expect(syncContent({ repoRoot: repo, env: {}, quiet: true })).rejects.toMatchObject({ exitCode: 3 })
    // removes the link itself on both platforms (`rmdirSync` fails with ENOTDIR on a Linux symlink); never the target
    fs.rmSync(linkPath, { force: true })
    expect(fs.existsSync(linkPath)).toBe(false)
    expect(fs.existsSync(path.join(outsideDir, 'secret.md'))).toBe(true)

    // Engine top-level collision in lectures/ (`en` is a translation tree, tested in content-authoring.test.ts;
    // a file directly under it is refused like a collision)
    for (const reserved of ['index.md', 'dashboard.md', 'en', 'concepts', 'public', '.vitepress']) {
      const target = path.join(contentRoot, 'lectures', reserved)
      if (reserved.endsWith('.md')) {
        fs.writeFileSync(target, 'clash\n', 'utf8')
      } else {
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, 'L01.md'), 'clash\n', 'utf8')
      }
      await expect(syncContent({ repoRoot: repo, env: {}, quiet: true })).rejects.toMatchObject({ exitCode: 3 })
      fs.rmSync(target, { recursive: true, force: true })
    }

    // Colliding dir declared in groups.ts
    fs.writeFileSync(path.join(contentRoot, 'groups.ts'), `export const GROUPS = [{ id: 'X', dir: 'en/demo' }]\n`, 'utf8')
    await expect(syncContent({ repoRoot: repo, env: {}, quiet: true })).rejects.toMatchObject({ exitCode: 3 })
  })
})

describe('engine source separation invariants (Deliverable 1)', () => {
  it('has zero static lecture.config imports and zero literal content paths outside paths.mts', () => {
    const engineRoots = [
      path.join(SITE_DIR, 'docs', '.vitepress'),
      path.join(SITE_DIR, 'docs', 'en'),
      path.join(SITE_DIR, 'scripts'),
      path.join(SITE_DIR, 'config'),
    ]
    const allFiles = engineRoots.flatMap((root) => collectFilesRecursive(root, ['.ts', '.mts', '.mjs']))

    const pathsFile = path.join(SITE_DIR, 'docs', '.vitepress', 'content', 'paths.mts')
    const staticImportOffenders: string[] = []
    const literalPathOffenders: string[] = []
    const clientImportOffenders: string[] = []

    const legacyLiteralPatterns: readonly RegExp[] = [
      /path\.(?:join|resolve)\([^)]*['"]data['"],\s*['"]graph(?:-(?:notion|bindings))?\.json['"]/,
      /['"]\.\.(?:\/\.\.)*\/data\/graph(?:-(?:notion|bindings))?\.json['"]/,
      /['"]public\/charts['"]|path\.(?:join|resolve)\([^)]*['"]public['"],\s*['"]charts['"]/,
      /['"]site-texts(?:\.example)?\.json['"]/,
      /['"]companion(?:\.example)?\.json['"]|['"]prompts\/companion(?:\.example)?\.json['"]/,
    ]

    for (const file of allFiles) {
      const raw = fs.readFileSync(file, 'utf8')
      const code = stripComments(raw)
      const rel = path.relative(SITE_DIR, file).replace(/\\/g, '/')

      // 1. Zero static imports of lecture.config(.ts) anywhere in engine code
      if (/^\s*import\s+[^;]*\bfrom\s+['"][^'"]*lecture\.config(?:\.ts)?['"]/m.test(code)) {
        staticImportOffenders.push(rel)
      }

      // 2. Zero client-side imports of docs/.vitepress/content/ outside *.data.mts Node loaders
      if (rel.startsWith('docs/.vitepress/theme/') && !rel.endsWith('.data.mts')) {
        if (/content\/(?:paths|config)\.mts/.test(code)) {
          clientImportOffenders.push(rel)
        }
      }

      // 3. No engine module outside content/paths.mts builds old literal content paths itself
      // (scripts/content/sync.mts names destination subdirs under site/docs/ when syncing, not source reads)
      if (file === pathsFile) continue
      for (const pat of legacyLiteralPatterns) {
        if (rel === 'scripts/content/sync.mts' && pat.source.includes('public')) continue
        // build-output name and an example value of a setting, not locations of content files
        if ((rel === 'docs/.vitepress/site.config.mts' || rel === 'config/schema.ts') && pat.source.includes('companion')) continue
        if (pat.test(code)) {
          literalPathOffenders.push(`${rel}: ${pat.source}`)
        }
      }
    }

    expect(staticImportOffenders).toEqual([])
    expect(literalPathOffenders).toEqual([])
    expect(clientImportOffenders).toEqual([])
  })
})
