/**
 * tests/unit/search-index.test.ts - Unit tests for WP-F3 search indexing, pruning,
 * locale/group/access splitting, size budgets, and client incremental search engine.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveGroups } from '../../docs/.vitepress/groups-source.mts'
import { resolveBuildAccess } from '../../docs/.vitepress/access/build.mts'
import { checkDistSearchBudgets, inflateShardJson } from '../../docs/.vitepress/search/budget.ts'
import {
  SHARDS_TOTAL_MAX_BYTES,
  TITLE_INDEX_MAX_BYTES,
  inflateTitleHeadings,
  slugifyHeading,
  type SearchManifestFile,
  type ShardPayload,
  type TitleIndexFile,
} from '../../docs/.vitepress/search/format.ts'
import { buildSearchArtifacts, SearchBudgetError, writeSearchArtifacts } from '../../docs/.vitepress/search/indexBuilder.ts'
import { extractSearchablePage } from '../../docs/.vitepress/search/markdown.ts'
import { configureAccess } from '../../docs/.vitepress/theme/access/store.ts'
import { LectureSearchEngine, buildSnippet, splitHighlightParts } from '../../docs/.vitepress/theme/search/engine.ts'

const tmpDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function writeMd(root: string, rel: string, content: string): void {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf8')
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('search markdown pruner', () => {
  it('drops frontmatter, code blocks, chart fences, math, HTML comments and tags while keeping headings path and prose', () => {
    const md = [
      '---',
      'title: "第5讲 · SPI 总线时序"',
      'order: 5',
      'description: "SECRET_FRONTMATTER_SHOULD_DROP"',
      '---',
      '',
      '# 第5讲 · SPI 总线时序',
      '',
      '> 节点 `spi_bus_timing` ｜ 亚组: G01',
      '',
      '<!-- COMMENT_SECRET_TOKEN -->',
      '',
      '开篇讲述主从通信里的 `gpio_set_level` 时钟极性 CPOL 与相位 CPHA。',
      '',
      '$$ f_{sck} = \\dfrac{f_{apb}}{2} $$',
      '',
      '行内公式 \\( V = I \\cdot R \\) 后继续讲解 <span class="cite" data-cite="https://example.org/spec" title="https://example.org/spec">官方参考手册</span> 的要求。',
      '',
      '```c',
      'int CODE_SECRET_VAR = 42;',
      '```',
      '',
      '```mermaid:chart',
      'flowchart LR',
      '  MERMAID_SECRET_NODE --> B',
      '```',
      '',
      '```echarts',
      '{"ECHART_SECRET_KEY": [1, 2, 3]}',
      '```',
      '',
      '```wavedrom',
      '{"signal": [{"name": "WAVEDROM_SECRET"}]}',
      '```',
      '',
      '## 1. 时钟模式与采样沿',
      '',
      '### 1.1 CPOL = 0 的上升沿采样',
      '',
      '<figure class="chart" data-lecture="G01-L05" data-id="c1" data-type="wavedrom"><svg>SVG_SECRET_TEXT</svg></figure>',
      '',
      '在模式 0 下，第一个时钟边沿完成数据锁存。',
      '',
      '## 1. 时钟模式与采样沿',
      '',
      '重复标题用于校验锚点去重。',
    ].join('\n')

    const page = extractSearchablePage(md, 'fallback')
    expect(page.skipped).toBe(false)
    expect(page.title).toBe('第5讲 · SPI 总线时序')

    const allBody = page.sections.map((s) => s.text).join('\n')
    expect(allBody).toContain('gpio_set_level')
    expect(allBody).toContain('官方参考手册')
    expect(allBody).toContain('在模式 0 下，第一个时钟边沿完成数据锁存')
    for (const dropped of [
      'SECRET_FRONTMATTER_SHOULD_DROP',
      'COMMENT_SECRET_TOKEN',
      'f_{sck}',
      'I \\cdot R',
      'https://example.org/spec',
      'CODE_SECRET_VAR',
      'MERMAID_SECRET_NODE',
      'ECHART_SECRET_KEY',
      'WAVEDROM_SECRET',
      'SVG_SECRET_TEXT',
      'spi_bus_timing',
    ]) {
      expect(allBody).not.toContain(dropped)
    }

    expect(page.headings.map((h) => ({ level: h.level, text: h.text, path: h.path }))).toEqual([
      { level: 2, text: '1. 时钟模式与采样沿', path: [] },
      { level: 3, text: '1.1 CPOL = 0 的上升沿采样', path: ['1. 时钟模式与采样沿'] },
      { level: 2, text: '1. 时钟模式与采样沿', path: [] },
    ])
    expect(page.headings[0]?.slug).toBe(slugifyHeading('1. 时钟模式与采样沿'))
    expect(page.headings[2]?.slug).toBe(`${slugifyHeading('1. 时钟模式与采样沿')}-1`)
  })

  it('skips pages marked search: false', () => {
    const page = extractSearchablePage('---\ntitle: "Dashboard"\nsearch: false\n---\n\nHidden body text', 'Dashboard')
    expect(page.skipped).toBe(true)
    expect(page.sections).toEqual([])
  })
})

describe('search index builder, access split & budget gates', () => {
  const sampleGroups = [
    { id: 'G01', dir: 'g01', title: '基础电路', catSlot: 1 },
    { id: 'G04', dir: 'g04', title: '表格与关系数据', catSlot: 2 },
    { id: 'G09', dir: 'g09', title: '云网络与 VPC', catSlot: 3 },
  ]

  function makeCorpus(): string {
    const docs = makeTempDir('search-corpus-')
    writeMd(docs, 'index.md', '# 总览\n\n首页导读正文。')
    writeMd(docs, 'g01/L01.md', '---\ntitle: "第1讲 · 电阻与分压"\n---\n\n# 第1讲 · 电阻\n\n## 欧姆定律\n\n电阻把电压降到 LED 安全工作区间。')
    writeMd(docs, 'g04/L07.md', '---\ntitle: "第7讲 · 外键连接"\n---\n\n# 第7讲 · 外键\n\n## 外键约束\n\n### 外键只「连」不「合」\n\n数据库通过 FOREIGN KEY 维持参照完整性。')
    writeMd(docs, 'g09/L03.md', '---\ntitle: "第3讲 · VPC 虚拟私有云与混合网络"\n---\n\n# VPC\n\n## 私有子网\n\nSECRET_VPC_BODY_TEXT_4481 只给认证用户阅读。')
    writeMd(docs, 'en/courses/g01/L01.md', '---\ntitle: "Example Lecture 1 · Ohm Law"\n---\n\n# Ohm Law\n\n## Limiting Resistor\n\nKeep current safely below LED limits.')
    return docs
  }

  it('splits into title index and per-group shards per locale and isolates restricted tiers', () => {
    const docs = makeCorpus()
    const plan = resolveBuildAccess(
      { default: 'public', enforcement: 'gateway', groups: { G09: { read: 'authenticated' } } },
      sampleGroups,
    )
    const built = buildSearchArtifacts({
      docsRoot: docs,
      allGroups: sampleGroups,
      localeKeys: ['en'],
      accessPlan: plan,
    })

    const outDir = makeTempDir('search-dist-')
    write(outDir, 'index.html', '<html></html>')
    writeSearchArtifacts(outDir, built)

    // Public artifacts must have G01 & G04, never G09 titles/paths/body text
    const pubTitles = JSON.parse(fs.readFileSync(path.join(outDir, 'search/root/titles.json'), 'utf8')) as TitleIndexFile
    expect(pubTitles.groups.map((g) => g.id)).not.toContain('G09')
    expect(JSON.stringify(pubTitles)).not.toContain('VPC')
    expect(JSON.stringify(pubTitles)).not.toContain('/g09/')

    const pubMan = JSON.parse(fs.readFileSync(path.join(outDir, 'search/root/manifest.json'), 'utf8')) as SearchManifestFile
    expect(pubMan.shards.map((s) => s.groupId)).not.toContain('G09')
    for (const s of pubMan.shards) {
      const payload = inflateShardJson<ShardPayload>(fs.readFileSync(path.join(outDir, 'search/root', s.url)))
      expect(JSON.stringify(payload)).not.toContain('SECRET_VPC_BODY_TEXT_4481')
    }

    // G04 headings inflate cleanly with parent breadcrumb
    const g04Page = pubTitles.pages.find((p) => p[3] === '/g04/L07')
    expect(g04Page).toBeDefined()
    const g04Headings = inflateTitleHeadings(g04Page![5])
    expect(g04Headings.map((h) => ({ text: h.text, path: h.path }))).toEqual([
      { text: '外键约束', path: [] },
      { text: '外键只「连」不「合」', path: ['外键约束'] },
    ])

    // Restricted tier lives exclusively under _access/authenticated/search/
    const authTitles = JSON.parse(fs.readFileSync(path.join(outDir, '_access/authenticated/search/root/titles.json'), 'utf8')) as TitleIndexFile
    expect(authTitles.pages.map((p) => p[2])).toEqual(['G09-L03'])
    const authMan = JSON.parse(fs.readFileSync(path.join(outDir, '_access/authenticated/search/root/manifest.json'), 'utf8')) as SearchManifestFile
    const g09Shard = inflateShardJson<ShardPayload>(fs.readFileSync(path.join(outDir, '_access/authenticated/search/root', authMan.shards[0]!.url)))
    expect(JSON.stringify(g09Shard)).toContain('SECRET_VPC_BODY_TEXT_4481')

    // Non-root English locale contains only English example pages, 0 CJK
    const enTitles = JSON.parse(fs.readFileSync(path.join(outDir, 'search/en/titles.json'), 'utf8')) as TitleIndexFile
    expect(enTitles.pages.map((p) => p[3])).toEqual(['/en/courses/g01/L01'])
    expect(JSON.stringify(enTitles)).not.toMatch(/[㐀-鿿]/)
  })

  it('fails build and post-dist checks when title index or shards exceed byte budgets or legacy chunk appears', () => {
    const docs = makeCorpus()
    expect(() =>
      buildSearchArtifacts({ docsRoot: docs, allGroups: sampleGroups, localeKeys: ['en'], maxTitleBytes: 50 }),
    ).toThrow(SearchBudgetError)
    expect(() =>
      buildSearchArtifacts({ docsRoot: docs, allGroups: sampleGroups, localeKeys: ['en'], maxShardBytes: 20 }),
    ).toThrow(SearchBudgetError)

    const built = buildSearchArtifacts({ docsRoot: docs, allGroups: sampleGroups, localeKeys: ['en'] })
    const outDir = makeTempDir('search-budget-dist-')
    writeSearchArtifacts(outDir, built)
    expect(checkDistSearchBudgets(outDir).ok).toBe(true)

    expect(checkDistSearchBudgets(outDir, { maxTitleBytes: 50 }).failures.join('\n')).toMatch(/titles\.json.*bytes > max/)
    expect(checkDistSearchBudgets(outDir, { maxShardBytes: 10 }).failures.join('\n')).toMatch(/shards total.*bytes > max/)

    write(outDir, 'assets/chunks/@localSearchIndexroot.ABCD1234.js', 'export default "{}"')
    expect(checkDistSearchBudgets(outDir).failures.join('\n')).toMatch(/search-legacy/)
  })

  it('real site/docs corpus meets <= 1 MiB title index and <= 8 MiB compressed root shards budgets', async () => {
    const docsRoot = path.resolve(__dirname, '../../docs')
    const { GROUPS } = await resolveGroups()
    const built = buildSearchArtifacts({
      docsRoot,
      allGroups: GROUPS,
      localeKeys: ['en'],
      excludes: ['dashboard.md', 'en/dashboard.md'],
    })
    expect(built.rootStats.titleBytes).toBeGreaterThan(0)
    expect(built.rootStats.titleBytes).toBeLessThanOrEqual(TITLE_INDEX_MAX_BYTES)
    expect(built.rootStats.shardBytes).toBeGreaterThan(0)
    expect(built.rootStats.shardBytes).toBeLessThanOrEqual(SHARDS_TOTAL_MAX_BYTES)
    expect(built.statsByLocale.en?.pageCount).toBeGreaterThan(0)
  }, 60_000)
})

function write(root: string, rel: string, content: string): void {
  const f = path.join(root, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content, 'utf8')
}

describe('client LectureSearchEngine: instant title results, progress, scope and access isolation', () => {
  it('returns title/heading hits before delayed shards finish, tracks byte progress, highlights and scopes accurately', async () => {
    const titlePayload: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [
        { id: 'G01', dir: 'g01', title: '电子基础', catSlot: 1 },
        { id: 'G04', dir: 'g04', title: '表格与关系数据', catSlot: 2 },
      ],
      pages: [
        [0, 1, 'G01-L01', '/g01/L01', '第1讲 · 分压电阻', [[2, '欧姆定律应用']]],
        [1, 7, 'G04-L07', '/g04/L07', '第7讲 · 外键设计', [[2, '外键只连不合']]],
      ],
    }

    const g04ShardRaw = Buffer.from(
      JSON.stringify({
        v: 1,
        shardId: 'g04',
        groupId: 'G04',
        pages: ['/g04/L07'],
        sections: [[0, 's1', ['外键只连不合'], '在关系数据库设计里通过 FOREIGN KEY 连接两张表，实现外键约束。']],
      }),
      'utf8',
    )
    const g04Compressed = zlib.deflateRawSync(g04ShardRaw, { level: 9 })

    const g01ShardRaw = Buffer.from(
      JSON.stringify({
        v: 1,
        shardId: 'g01',
        groupId: 'G01',
        pages: ['/g01/L01'],
        sections: [[0, 's1', ['欧姆定律应用'], '串并联分压电阻控制 LED 电流。']],
      }),
      'utf8',
    )
    const g01Compressed = zlib.deflateRawSync(g01ShardRaw, { level: 9 })

    const manifestPayload: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: Buffer.byteLength(JSON.stringify(titlePayload)),
      totalShardBytes: g01Compressed.byteLength + g04Compressed.byteLength,
      totalRawShardBytes: g01ShardRaw.byteLength + g04ShardRaw.byteLength,
      shards: [
        { shardId: 'g01', groupId: 'G01', url: 'shards/g01.sz', bytes: g01Compressed.byteLength, rawBytes: g01ShardRaw.byteLength, pageCount: 1 },
        { shardId: 'g04', groupId: 'G04', url: 'shards/g04.sz', bytes: g04Compressed.byteLength, rawBytes: g04ShardRaw.byteLength, pageCount: 1 },
      ],
    }

    let releaseG04!: () => void
    const g04Gate = new Promise<void>((r) => {
      releaseG04 = r
    })
    const fetchedUrls: string[] = []

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      fetchedUrls.push(url)
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(manifestPayload), { status: 200 })
      if (url.endsWith('/titles.json')) return new Response(JSON.stringify(titlePayload), { status: 200 })
      if (url.endsWith('/shards/g01.sz')) return new Response(new Uint8Array(g01Compressed), { status: 200 })
      if (url.endsWith('/shards/g04.sz')) {
        await g04Gate
        return new Response(new Uint8Array(g04Compressed), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }

    let changes = 0
    const engine = new LectureSearchEngine({
      base: '/',
      localeKeys: ['en'],
      siteData: () => ({ themeConfig: { lectureAccess: { inlineTier: 'public', tiers: [] } } }),
      statusOf: (id) => (id === 'g04-L07' ? 'in_progress' : 'completed'),
      labels: {
        lectureNo: (n) => `第${n}讲`,
        groupCount: (n) => `${n} 条`,
        groupSite: '概览',
        loadingBar: (l, t) => `loading ${l}/${t}`,
        loadingIdle: (l, t) => `idle ${l}/${t}`,
        statusLabel: (s) => s,
      },
      fetchFn: mockFetch,
      onStateChange: () => {
        changes++
      },
    })

    // Open while preferring G04: title phase finishes immediately; G04 shard blocks until gate opens
    await engine.ensureLoaded('root', 'G04')
    expect(fetchedUrls.some((u) => u.includes('/_access/'))).toBe(false)

    const earlyState = engine.getLoadState('root', true)
    expect(earlyState.loading).toBe(true)

    const earlyHits = engine.query('root', '外键', 'all', 'G04')
    expect(earlyHits.totalHits).toBeGreaterThan(0)
    expect(earlyHits.elapsedMs).toBeLessThan(100)
    expect(earlyHits.groups[0]?.items[0]?.status).toBe('in_progress')

    // Before shard finishes, body-only query misses
    expect(engine.query('root', 'FOREIGN KEY', 'all', 'G04').totalHits).toBe(0)

    releaseG04()
    // Allow shard worker to decompress & commit (wait for the state, not for a fixed time: a busy machine needs longer)
    await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })

    expect(engine.getLoadState('root', true).loading).toBe(false)
    const bodyHits = engine.query('root', 'FOREIGN KEY', 'all', 'G04')
    expect(bodyHits.totalHits).toBe(1)
    const item = bodyHits.groups[0]?.items[0]
    expect(item?.code).toBe('G04-L07')
    expect(item?.snippetParts.some((p) => p.hit && p.text.toLowerCase() === 'foreign key')).toBe(true)

    // Scope filter restricts hits to active group
    expect(engine.query('root', '电阻', 'all', 'G04').totalHits).toBeGreaterThanOrEqual(1)
    expect(engine.query('root', '电阻', 'group', 'G04').totalHits).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  it('extracts concise two-line snippet and highlight tokens safely', () => {
    const text = 'A'.repeat(60) + ' middle keyword ' + 'B'.repeat(90)
    const snip = buildSnippet(text, ['keyword'], 60)
    expect(snip.startsWith('…')).toBe(true)
    expect(snip).toContain('keyword')
    const parts = splitHighlightParts(snip, ['keyword'])
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['keyword'])
  })

  // spec board 04.2 "右侧显示结果数与用时"; S6Y audit-spec #17: the panel said "6 条" over 5 rows because the count was taken
  // before the 3-per-lecture cap
  it('the result count is the number of rows the panel lists (after the per-lecture cap)', async () => {
    const titlePayload: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [{ id: 'G01', dir: 'g01', title: '电子基础', catSlot: 1 }],
      pages: [[0, 1, 'G01-L01', '/g01/L01', '第1讲 · 分压电阻', [[2, '分压一']]]],
    }
    const shardRaw = Buffer.from(
      JSON.stringify({
        v: 1,
        shardId: 'g01',
        groupId: 'G01',
        pages: ['/g01/L01'],
        sections: [1, 2, 3, 4, 5].map((i) => [0, `s${i}`, [`分压${i}`], `第 ${i} 段讲分压电阻的取值。`]),
      }),
      'utf8',
    )
    const shard = zlib.deflateRawSync(shardRaw, { level: 9 })
    const manifestPayload: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: Buffer.byteLength(JSON.stringify(titlePayload)),
      totalShardBytes: shard.byteLength,
      totalRawShardBytes: shardRaw.byteLength,
      shards: [{ shardId: 'g01', groupId: 'G01', url: 'shards/g01.sz', bytes: shard.byteLength, rawBytes: shardRaw.byteLength, pageCount: 1 }],
    }
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(manifestPayload), { status: 200 })
      if (url.endsWith('/titles.json')) return new Response(JSON.stringify(titlePayload), { status: 200 })
      if (url.endsWith('/shards/g01.sz')) return new Response(new Uint8Array(shard), { status: 200 })
      return new Response('not found', { status: 404 })
    }
    const engine = new LectureSearchEngine({
      base: '/',
      localeKeys: ['en'],
      siteData: () => ({ themeConfig: { lectureAccess: { inlineTier: 'public', tiers: [] } } }),
      statusOf: () => 'not_started',
      labels: {
        lectureNo: (n) => `第${n}讲`,
        groupCount: (n) => `${n} 条`,
        groupSite: '概览',
        loadingBar: (l, t) => `loading ${l}/${t}`,
        loadingIdle: (l, t) => `idle ${l}/${t}`,
        statusLabel: (s) => s,
      },
      fetchFn,
    })
    await engine.ensureLoaded('root', 'G01')
    await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
    const res = engine.query('root', '分压', 'all', 'G01')
    const rows = res.groups.reduce((n, g) => n + g.items.length, 0)
    expect(rows).toBeGreaterThan(0)
    expect(rows).toBeLessThan(5) // five matching sections, capped per lecture
    expect(res.totalHits).toBe(rows)
  })

  it('sends same-origin credentials for gateway auth, enters error state on redirect/non-200 instead of false empty results, and recovers on retry', async () => {
    const titlePayload: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [{ id: 'LR', dir: 'lr', title: '文献精读', catSlot: 1 }],
      pages: [[0, 6, 'LR-L06', '/lr/L06', '第6讲 · TEEN 协议解析', [[2, '协议核心思想']]]],
    }
    const shardRaw = Buffer.from(
      JSON.stringify({
        v: 1,
        shardId: 'lr',
        groupId: 'LR',
        pages: ['/lr/L06'],
        sections: [[0, 's1', ['协议核心思想'], '协议采用双阈值节能机制。']],
      }),
      'utf8',
    )
    const shard = zlib.deflateRawSync(shardRaw, { level: 9 })
    const manifestPayload: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: Buffer.byteLength(JSON.stringify(titlePayload)),
      totalShardBytes: shard.byteLength,
      totalRawShardBytes: shardRaw.byteLength,
      shards: [{ shardId: 'lr', groupId: 'LR', url: 'shards/lr.sz', bytes: shard.byteLength, rawBytes: shardRaw.byteLength, pageCount: 1 }],
    }

    let authed = false
    const seenInits: Array<{ url: string; credentials?: RequestCredentials; redirect?: RequestRedirect }> = []
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      seenInits.push({ url, credentials: init?.credentials, redirect: init?.redirect })
      if (!authed) {
        return { status: 0, ok: false, type: 'opaqueredirect' } as unknown as Response
      }
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(manifestPayload), { status: 200 })
      if (url.endsWith('/titles.json')) return new Response(JSON.stringify(titlePayload), { status: 200 })
      if (url.endsWith('/shards/lr.sz')) return new Response(new Uint8Array(shard), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    const engine = new LectureSearchEngine({
      base: '/',
      localeKeys: ['en'],
      siteData: () => ({ themeConfig: { lectureAccess: { inlineTier: 'public', tiers: [] } } }),
      statusOf: () => 'not_started',
      labels: {
        lectureNo: (n) => `第${n}讲`,
        groupCount: (n) => `${n} 条`,
        groupSite: '站点页面',
        loadingBar: (l, t) => `loading ${l}/${t}`,
        loadingIdle: (l, t) => `idle ${l}/${t}`,
        loadingTitles: 'loading titles',
        loadError: 'index load failed',
        statusLabel: (s) => s,
      },
      fetchFn,
    })

    await expect(engine.ensureLoaded('root', 'LR')).rejects.toThrow()
    expect(seenInits.every((r) => r.credentials === 'same-origin' && r.redirect === 'manual')).toBe(true)
    expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, error: true, phase: 'error', label: 'index load failed' })
    expect(engine.query('root', '协议', 'all', 'LR').totalHits).toBe(0)

    // Without forceRetry, typing doesn't spam requests; reopening with forceRetry recovers cleanly
    await engine.ensureLoaded('root', 'LR')
    expect(engine.getLoadState('root', true).phase).toBe('error')

    authed = true
    await engine.ensureLoaded('root', 'LR', { forceRetry: true })
    await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
    expect(seenInits.every((r) => r.credentials === 'same-origin' && r.redirect === 'manual')).toBe(true)
    expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, phase: 'ready', percent: 100 })
    expect(engine.query('root', '协议', 'all', 'LR').totalHits).toBeGreaterThan(0)
  })

  it('keeps title search usable if manifest.json fails, evaluates dynamic locale labels lazily, and recovers manifest on forceRetry', async () => {
    const titlePayload: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [{ id: 'LR', dir: 'lr', title: '文献精读', catSlot: 1 }],
      pages: [[0, 6, 'LR-L06', '/lr/L06', '第6讲 · TEEN 协议解析', [[2, '协议核心思想']]]],
    }
    const shardRaw = Buffer.from(
      JSON.stringify({
        v: 1,
        shardId: 'lr',
        groupId: 'LR',
        pages: ['/lr/L06'],
        sections: [[0, 's1', ['协议核心思想'], '协议采用双阈值节能机制。']],
      }),
      'utf8',
    )
    const shard = zlib.deflateRawSync(shardRaw, { level: 9 })
    const manifestPayload: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: Buffer.byteLength(JSON.stringify(titlePayload)),
      totalShardBytes: shard.byteLength,
      totalRawShardBytes: shardRaw.byteLength,
      shards: [{ shardId: 'lr', groupId: 'LR', url: 'shards/lr.sz', bytes: shard.byteLength, rawBytes: shardRaw.byteLength, pageCount: 1 }],
    }

    let manifestOk = false
    let currentLang = 'zh'
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/titles.json')) return new Response(JSON.stringify(titlePayload), { status: 200 })
      if (url.endsWith('/manifest.json')) {
        return manifestOk ? new Response(JSON.stringify(manifestPayload), { status: 200 }) : new Response('err', { status: 500 })
      }
      if (url.endsWith('/shards/lr.sz')) return new Response(new Uint8Array(shard), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    const engine = new LectureSearchEngine({
      base: '/',
      localeKeys: ['en'],
      siteData: () => ({ themeConfig: { lectureAccess: { inlineTier: 'public', tiers: [] } } }),
      statusOf: () => 'not_started',
      labels: {
        lectureNo: (n) => `第${n}讲`,
        groupCount: (n) => `${n} 条`,
        groupSite: '站点页面',
        loadingBar: (l, t) => `loading ${l}/${t}`,
        loadingIdle: (l, t) => `idle ${l}/${t}`,
        loadingTitles: () => (currentLang === 'zh' ? '正在加载' : 'Loading index'),
        loadError: () => (currentLang === 'zh' ? '加载失败' : 'Index failed'),
        statusLabel: (s) => s,
      },
      fetchFn,
    })

    // Manifest 500 must NOT block title search
    await engine.ensureLoaded('root', 'LR')
    expect(engine.query('root', '协议', 'all', 'LR').totalHits).toBeGreaterThan(0)
    expect(engine.query('root', '双阈值', 'all', 'LR').totalHits).toBe(0)
    expect(engine.getLoadState('root', true)).toMatchObject({
      loading: false,
      error: true,
      phase: 'partial-error',
      label: '加载失败',
    })

    // Runtime locale switch reflects in getLoadState without reconstructing engine
    currentLang = 'en'
    expect(engine.getLoadState('root', true).label).toBe('Index failed')

    // Non-retry query calls don't spam failed manifest, forceRetry recovers shards
    await engine.ensureLoaded('root', 'LR')
    expect(engine.getLoadState('root', true).phase).toBe('partial-error')

    manifestOk = true
    await engine.ensureLoaded('root', 'LR', { forceRetry: true })
    await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
    expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, phase: 'ready', percent: 100 })
    expect(engine.query('root', '双阈值', 'all', 'LR').totalHits).toBe(1)
  })

  it('tracks authorized restricted tier failures and retries only missing tier metadata on forceRetry', async () => {
    const publicTitles: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [{ id: 'G01', dir: 'g01', title: '公开组', catSlot: 1 }],
      pages: [[0, 1, 'G01-L01', '/g01/L01', '第1讲 · 公开导论', [[2, '公开概述']]]],
    }
    const vipTitles: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [{ id: 'VIP', dir: 'vip', title: '进阶组', catSlot: 2 }],
      pages: [[0, 1, 'VIP-L01', '/vip/L01', '第1讲 · VIP 专题', [[2, '高阶技巧']]]],
    }
    const pubShardRaw = Buffer.from(JSON.stringify({ v: 1, shardId: 'g01', groupId: 'G01', pages: ['/g01/L01'], sections: [] }), 'utf8')
    const pubShard = zlib.deflateRawSync(pubShardRaw, { level: 9 })
    const vipShardRaw = Buffer.from(
      JSON.stringify({
        v: 1,
        shardId: 'vip',
        groupId: 'VIP',
        pages: ['/vip/L01'],
        sections: [[0, 's1', ['高阶技巧'], '隐藏正文关键字只存在于 VIP 分片。']],
      }),
      'utf8',
    )
    const vipShard = zlib.deflateRawSync(vipShardRaw, { level: 9 })

    const pubManifest: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: 10,
      totalShardBytes: pubShard.byteLength,
      totalRawShardBytes: pubShardRaw.byteLength,
      shards: [{ shardId: 'g01', groupId: 'G01', url: 'shards/g01.sz', bytes: pubShard.byteLength, rawBytes: pubShardRaw.byteLength, pageCount: 1 }],
    }
    const vipManifest: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: 10,
      totalShardBytes: vipShard.byteLength,
      totalRawShardBytes: vipShardRaw.byteLength,
      shards: [{ shardId: 'vip', groupId: 'VIP', url: 'shards/vip.sz', bytes: vipShard.byteLength, rawBytes: vipShardRaw.byteLength, pageCount: 1 }],
    }

    let vipSearchOk = false
    let vipRequests = 0
    const siteObj = { themeConfig: { lectureAccess: { inlineTier: 'public', tiers: ['vip'] } } }
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/_access/vip/site-data.json')) {
        return new Response(
          JSON.stringify({ version: 1, tier: 'vip', groups: [], totals: { lectures: 1, charts: 0 }, locales: {} }),
          { status: 200 },
        )
      }
      if (url.includes('/_access/vip/search/')) {
        vipRequests++
        if (!vipSearchOk) return new Response('unavailable', { status: 503 })
        if (url.endsWith('/titles.json')) return new Response(JSON.stringify(vipTitles), { status: 200 })
        if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(vipManifest), { status: 200 })
        if (url.endsWith('/shards/vip.sz')) return new Response(new Uint8Array(vipShard), { status: 200 })
      }
      if (url.endsWith('/search/root/titles.json')) return new Response(JSON.stringify(publicTitles), { status: 200 })
      if (url.endsWith('/search/root/manifest.json')) return new Response(JSON.stringify(pubManifest), { status: 200 })
      if (url.endsWith('/shards/g01.sz')) return new Response(new Uint8Array(pubShard), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    configureAccess({ siteData: { value: siteObj }, withBase: (p) => p, fetch: fetchFn })
    try {
      const engine = new LectureSearchEngine({
        base: '/',
        localeKeys: ['en'],
        siteData: () => siteObj,
        statusOf: () => 'not_started',
        labels: {
          lectureNo: (n) => `第${n}讲`,
          groupCount: (n) => `${n} 条`,
          groupSite: '概览',
          loadingBar: (l, t) => `loading ${l}/${t}`,
          loadingIdle: (l, t) => `idle ${l}/${t}`,
          loadError: '部分索引加载失败',
          statusLabel: (s) => s,
        },
        fetchFn,
      })

      await engine.ensureLoaded('root', null)
      await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
      expect(engine.query('root', '公开导论', 'all', null).totalHits).toBe(1)
      expect(engine.query('root', 'VIP', 'all', null).totalHits).toBe(0)
      expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, error: true, phase: 'partial-error' })

      const callsAfterFail = vipRequests
      // Typing / normal ensureLoaded does not spam failed tier
      await engine.ensureLoaded('root', null)
      expect(vipRequests).toBe(callsAfterFail)

      vipSearchOk = true
      await engine.ensureLoaded('root', null, { forceRetry: true })
      await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
      expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, phase: 'ready', percent: 100 })
      expect(engine.query('root', '高阶技巧', 'all', null).totalHits).toBeGreaterThanOrEqual(1)
      expect(engine.query('root', '隐藏正文关键字', 'all', null).totalHits).toBe(1)
    } finally {
      configureAccess({ siteData: { value: {} }, withBase: (p) => p })
    }
  })

  it('defers tier shards when tier titles fail, clears stale tier errors on downgrade, and retries site-data 503 via forceRetry', async () => {
    const publicTitles: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [{ id: 'G01', dir: 'g01', title: '公开组', catSlot: 1 }],
      pages: [[0, 1, 'G01-L01', '/g01/L01', '第1讲 · 公开导论', [[2, '公开概述']]]],
    }
    const vipTitles: TitleIndexFile = {
      v: 1,
      locale: 'root',
      groups: [{ id: 'VIP', dir: 'vip', title: '进阶组', catSlot: 2 }],
      pages: [[0, 1, 'VIP-L01', '/vip/L01', '第1讲 · VIP 专题', [[2, '高阶技巧']]]],
    }
    const pubShardRaw = Buffer.from(JSON.stringify({ v: 1, shardId: 'g01', groupId: 'G01', pages: ['/g01/L01'], sections: [] }), 'utf8')
    const pubShard = zlib.deflateRawSync(pubShardRaw, { level: 9 })
    const vipShardRaw = Buffer.from(
      JSON.stringify({
        v: 1,
        shardId: 'vip',
        groupId: 'VIP',
        pages: ['/vip/L01'],
        sections: [[0, 's1', ['高阶技巧'], '仅 VIP 分片独有正文字段。']],
      }),
      'utf8',
    )
    const vipShard = zlib.deflateRawSync(vipShardRaw, { level: 9 })

    const pubManifest: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: 10,
      totalShardBytes: pubShard.byteLength,
      totalRawShardBytes: pubShardRaw.byteLength,
      shards: [{ shardId: 'g01', groupId: 'G01', url: 'shards/g01.sz', bytes: pubShard.byteLength, rawBytes: pubShardRaw.byteLength, pageCount: 1 }],
    }
    const vipManifest: SearchManifestFile = {
      v: 1,
      locale: 'root',
      titleFile: 'titles.json',
      titleBytes: 10,
      totalShardBytes: vipShard.byteLength,
      totalRawShardBytes: vipShardRaw.byteLength,
      shards: [{ shardId: 'vip', groupId: 'VIP', url: 'shards/vip.sz', bytes: vipShard.byteLength, rawBytes: vipShardRaw.byteLength, pageCount: 1 }],
    }

    let siteDataStatus = 503
    let vipTitlesStatus = 503
    const siteObj = { themeConfig: { lectureAccess: { inlineTier: 'public', tiers: ['vip'] } } }
    const fetchFn: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/_access/vip/site-data.json')) {
        if (siteDataStatus !== 200) return new Response('err', { status: siteDataStatus })
        return new Response(JSON.stringify({ version: 1, tier: 'vip', groups: [], totals: { lectures: 1, charts: 0 }, locales: {} }), { status: 200 })
      }
      if (url.endsWith('/_access/vip/search/root/titles.json')) {
        return vipTitlesStatus === 200 ? new Response(JSON.stringify(vipTitles), { status: 200 }) : new Response('err', { status: vipTitlesStatus })
      }
      if (url.endsWith('/_access/vip/search/root/manifest.json')) return new Response(JSON.stringify(vipManifest), { status: 200 })
      if (url.endsWith('/_access/vip/search/root/shards/vip.sz')) return new Response(new Uint8Array(vipShard), { status: 200 })
      if (url.endsWith('/search/root/titles.json')) return new Response(JSON.stringify(publicTitles), { status: 200 })
      if (url.endsWith('/search/root/manifest.json')) return new Response(JSON.stringify(pubManifest), { status: 200 })
      if (url.endsWith('/shards/g01.sz')) return new Response(new Uint8Array(pubShard), { status: 200 })
      return new Response('not found', { status: 404 })
    }

    configureAccess({ siteData: { value: siteObj }, withBase: (p) => p, fetch: fetchFn })
    try {
      const engine = new LectureSearchEngine({
        base: '/',
        localeKeys: ['en'],
        siteData: () => siteObj,
        statusOf: () => 'not_started',
        labels: {
          lectureNo: (n) => `第${n}讲`,
          groupCount: (n) => `${n} 条`,
          groupSite: '概览',
          loadingBar: (l, t) => `loading ${l}/${t}`,
          loadingIdle: (l, t) => `idle ${l}/${t}`,
          loadError: '部分索引加载失败',
          statusLabel: (s) => s,
        },
        fetchFn,
      })

      // 1. Transient 503 on site-data.json must surface partial-error (not ready)
      await engine.ensureLoaded('root', null)
      await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
      expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, error: true, phase: 'partial-error' })

      // 2. Retry resolves site-data.json -> 200, while vip titles.json still 503 & manifest 200:
      //    shards must NOT be consumed/marked loaded without titles!
      siteDataStatus = 200
      await engine.ensureLoaded('root', null, { forceRetry: true })
      await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
      expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, error: true, phase: 'partial-error' })
      expect(engine.query('root', '独有正文字段', 'all', null).totalHits).toBe(0)

      // 3. When vip titles.json recovers -> deferred manifest & shards enqueue and index vip body cleanly!
      vipTitlesStatus = 200
      await engine.ensureLoaded('root', null, { forceRetry: true })
      await vi.waitFor(() => expect(engine.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
      expect(engine.getLoadState('root', true)).toMatchObject({ loading: false, phase: 'ready', percent: 100 })
      expect(engine.query('root', '独有正文字段', 'all', null).totalHits).toBe(1)

      // 4. Separate instance: already-loaded tier titles must be evicted and access cache re-validated when
      //    user later loses access (403) without manual invalidateAccess().
      vipTitlesStatus = 200
      let vipManifestStatus = 503
      siteDataStatus = 200
      const fetchFnRevoke: typeof fetch = async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        if (url.endsWith('/_access/vip/search/root/manifest.json') && vipManifestStatus !== 200) {
          return new Response('err', { status: vipManifestStatus })
        }
        return fetchFn(input)
      }
      configureAccess({ siteData: { value: siteObj }, withBase: (p) => p, fetch: fetchFnRevoke })
      const engine2 = new LectureSearchEngine({
        base: '/',
        localeKeys: ['en'],
        siteData: () => siteObj,
        statusOf: () => 'not_started',
        labels: {
          lectureNo: (n) => `第${n}讲`,
          groupCount: (n) => `${n} 条`,
          groupSite: '概览',
          loadingBar: (l, t) => `loading ${l}/${t}`,
          loadingIdle: (l, t) => `idle ${l}/${t}`,
          loadError: '部分索引加载失败',
          statusLabel: (s) => s,
        },
        fetchFn: fetchFnRevoke,
      })
      await engine2.ensureLoaded('root', null)
      await vi.waitFor(() => expect(engine2.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
      expect(engine2.getLoadState('root', true)).toMatchObject({ loading: false, error: true, phase: 'partial-error' })
      expect(engine2.query('root', 'VIP', 'all', null).totalHits).toBe(1)

      // Gateway now denies vip (403); forceRetry automatically invalidates cached access, clears error, AND evicts cached vip titles!
      siteDataStatus = 403
      vipManifestStatus = 403
      await engine2.ensureLoaded('root', null, { forceRetry: true })
      await vi.waitFor(() => expect(engine2.getLoadState('root', true).loading).toBe(false), { timeout: 10_000, interval: 10 })
      expect(engine2.getLoadState('root', true)).toMatchObject({ loading: false, phase: 'ready', percent: 100 })
      expect(engine2.query('root', 'VIP', 'all', null).totalHits).toBe(0)
      expect(engine2.query('root', '公开导论', 'all', null).totalHits).toBe(1)
    } finally {
      configureAccess({ siteData: { value: {} }, withBase: (p) => p })
    }
  })
})
