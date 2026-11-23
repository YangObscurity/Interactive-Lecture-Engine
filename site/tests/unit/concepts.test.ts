/**
 * tests/unit/concepts.test.ts - Unit tests for stand-alone concept pages (WP-F9):
 *   - Syntax `[text](concept:slug)` in tables / emphasis / inline code; unknown slug fails build
 *   - Access tier inheritance (strictest tier, any public group -> public, build guard)
 *   - Per-tier hover JSON separation & per-tier split search (CONCEPT badge, aliases field, 1 result per page)
 *   - AST occurrence locator (`mdast-util-from-markdown`), `diff` patches, unlinking, & dev API lifecycle
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import MarkdownIt from 'markdown-it'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBuildAccess } from '../../docs/.vitepress/access/build.mts'
import { resolveConceptTier, canReaderTierReadConcept, conceptTierChunkPattern } from '../../docs/.vitepress/concepts/access.ts'
import {
  draftPayloadToConceptMarkdown,
  hasUnverifiedMarkers,
  parseConceptMarkdown,
} from '../../docs/.vitepress/concepts/frontmatter.ts'
import {
  buildMountConceptDiff,
  findAllConceptLinksInMarkdown,
  locateOccurrencesInLecture,
  unlinkConceptInMarkdown,
} from '../../docs/.vitepress/concepts/sourceRewriter.ts'
import { conceptLinkPlugin } from '../../docs/.vitepress/plugins/conceptLinkPlugin.mts'
import { buildConceptDistAssets } from '../../docs/.vitepress/plugins/conceptsPlugin.mts'
import { createDashboardDevHandler } from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'
import { buildSearchArtifacts, writeSearchArtifacts } from '../../docs/.vitepress/search/indexBuilder.ts'
import type { SearchManifestFile, ShardPayload, TitleIndexFile } from '../../docs/.vitepress/search/format.ts'
import { LectureSearchEngine } from '../../docs/.vitepress/theme/search/engine.ts'
import { migrateLegacyConceptLinks } from '../../scripts/migrate_concept_links.mjs'
import { contentForDocsRoot } from '../../docs/.vitepress/concepts/node.mts'
import { assertWritableTarget, atomicWriteFile } from '../../docs/.vitepress/concepts/safeWrite.mts'

const tempRoots: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as IncomingMessage & EventEmitter
    req.method = opts.method ?? 'GET'
    req.url = opts.url
    req.headers = { host: '127.0.0.1:5174', ...opts.headers }
    req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']
    let raw = ''
    let statusCode = 200
    let headersSent = false
    const headers: Record<string, string> = {}
    const res = {
      get statusCode() {
        return statusCode
      },
      set statusCode(v: number) {
        statusCode = v
      },
      get headersSent() {
        return headersSent
      },
      writeHead(code: number, hdrs?: Record<string, string>) {
        statusCode = code
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v
        }
      },
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v
      },
      end(chunk?: string | Buffer) {
        headersSent = true
        if (chunk) raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        resolve({ status: statusCode, json: JSON.parse(raw || '{}') as Record<string, unknown> })
      },
    } as unknown as ServerResponse
    void handler(req, res, () => resolve({ status: 404, json: {} }))
    if (opts.body !== undefined) {
      queueMicrotask(() => {
        req.emit('data', Buffer.from(JSON.stringify(opts.body), 'utf8'))
        req.emit('end')
      })
    } else {
      queueMicrotask(() => req.emit('end'))
    }
  })
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const d = tempRoots.pop()!
    fs.rmSync(d, { recursive: true, force: true })
  }
})

const GROUPS = [
  { id: 'G06', dir: 'g06', title: '公开课程', catSlot: 1 },
  { id: 'G09', dir: 'g09', title: '登录课程', catSlot: 2 },
  { id: 'G12', dir: 'g12', title: '教研课程', catSlot: 3 },
]

function samplePlan() {
  return resolveBuildAccess(
    {
      default: 'public',
      enforcement: 'gateway',
      groups: {
        G09: { read: 'authenticated' },
        G12: { read: ['staff'] },
      },
    },
    GROUPS,
  )
}

describe('concept syntax, table/emphasis rendering, build checks, and legacy migration', () => {
  it('renders [text](concept:slug) inside tables & emphasis, leaves code untouched, fails on unknown or restricted leak', () => {
    const plan = samplePlan()
    const g12Tier = plan.tierOfGroup.G12!
    const md = new MarkdownIt()
    md.use(conceptLinkPlugin, {
      isBuild: true,
      accessPlan: plan,
      resolveConcept: (slug) => {
        if (slug === 'pub-term') return { slug, tier: 'public', isDraft: false }
        if (slug === 'staff-term') return { slug, tier: g12Tier, isDraft: false }
        return null
      },
      tierOfPage: (rel) => {
        if (rel.startsWith('g12/')) return g12Tier
        if (rel.startsWith('g09/')) return 'authenticated'
        return 'public'
      },
    })

    const tableAndEmph = [
      '| 指标 | 说明 |',
      '| --- | --- |',
      '| **A** | 支持 [带有*斜体*与 **粗体** 的概念](concept:pub-term) 且不拆分列 |',
      '',
      '代码块里的 `[不要转换](concept:missing)` 与围栏保持原样：',
      '```md',
      '[示例](concept:missing)',
      '```',
    ].join('\n')

    const html = md.render(tableAndEmph, { relativePath: 'g06/L01.md' })
    expect(html).toContain('<table>')
    expect(html).toContain('href="/concepts/pub-term"')
    expect(html).toContain('class="lec-term"')
    expect(html).toContain('data-concept="pub-term"')
    expect(html).toContain('带有<em>斜体</em>与 <strong>粗体</strong> 的概念</a>')
    expect(html).toContain('<code>[不要转换](concept:missing)</code>')

    // Unknown slug fails build
    expect(() => md.render('[未知](concept:does-not-exist)', { relativePath: 'g06/L01.md' })).toThrow(/Unknown or unpublished concept/)

    // Access violation: public lecture citing staff-only concept fails build
    expect(() => md.render('[机密概念](concept:staff-term)', { relativePath: 'g06/L01.md' })).toThrow(/Access mismatch/)

    // Restricted lecture citing its own restricted concept resolves to /_access/<tier>/concepts/slug
    const staffHtml = md.render('[机密概念](concept:staff-term)', { relativePath: 'g12/L01.md' })
    expect(staffHtml).toContain(`href="/_access/${g12Tier}/concepts/staff-term"`)
  })

  it('migrates legacy [[concept:...]] syntax safely outside code and math', () => {
    const input = [
      '正文中的 [[concept:actuation-lease]] 与 [[concept:occ|乐观控制]]。',
      '保留 `$[[concept:ignore-me]]$` 与 \\( [[concept:math-skip]] \\) 及 `[[concept:inline]]`。',
      '```md',
      '[[concept:fence-skip]]',
      '```',
    ].join('\n')

    const { nextMarkdown, replacements } = migrateLegacyConceptLinks(input, (slug) =>
      slug === 'actuation-lease' ? '执行租约' : undefined,
    )
    expect(replacements).toBe(2)
    expect(nextMarkdown).toContain('[执行租约](concept:actuation-lease)')
    expect(nextMarkdown).toContain('[乐观控制](concept:occ)')
    expect(nextMarkdown).toContain('[[concept:fence-skip]]')
    expect(nextMarkdown).toContain('[[concept:inline]]')
    expect(nextMarkdown).toContain('[[concept:math-skip]]')
  })
})

describe('concept access tier inheritance, hover JSON split & split search index', () => {
  it('lists the page chunks of restricted concept pages in the gateway manifest pattern (names as rollup emits them)', () => {
    const re = new RegExp(conceptTierChunkPattern('grp-675ca4d1', ['en']))
    for (const name of [
      'access_grp-675ca4d1_concepts_staff-c.md.Buf7aki2.js',
      'access_grp-675ca4d1_concepts_staff-c.md.Buf7aki2.lean.js',
      'en_access_grp-675ca4d1_concepts_staff-c.md.x.js',
      'en__access_grp-675ca4d1_concepts_staff-c.md.x.js',
      '_access_grp-675ca4d1_concepts_staff-c.md.x.js',
    ]) {
      expect(re.test(`/assets/${name}`), name).toBe(true)
    }
    expect(re.test('/assets/access_authenticated_concepts_x.md.js')).toBe(false)
    expect(re.test('/assets/concepts_pub-c.md.kWEzONmt.js')).toBe(false)
  })

  it('inherits strictest restricted tier while letting any public group make it public', () => {
    const plan = samplePlan()
    const g12Tier = plan.tierOfGroup.G12!
    const built = new Set(['G06', 'G09', 'G12'])

    expect(resolveConceptTier(['G06'], plan, built)).toEqual({ tier: 'public', drop: false })
    expect(resolveConceptTier(['G09'], plan, built)).toEqual({ tier: 'authenticated', drop: false })
    expect(resolveConceptTier(['G12'], plan, built)).toEqual({ tier: g12Tier, drop: false })
    // Any public group -> public
    expect(resolveConceptTier(['G06', 'G12'], plan, built)).toEqual({ tier: 'public', drop: false })
    // Multiple restricted groups -> strictest (`grp-*` > `authenticated`)
    expect(resolveConceptTier(['G09', 'G12'], plan, built)).toEqual({ tier: g12Tier, drop: false })
    // Outside built subset -> drop
    expect(resolveConceptTier(['LR'], plan, built)).toEqual({ tier: 'public', drop: true })

    expect(canReaderTierReadConcept('public', 'public')).toBe(true)
    expect(canReaderTierReadConcept('public', 'authenticated')).toBe(false)
    expect(canReaderTierReadConcept(g12Tier, 'authenticated')).toBe(true)
    expect(canReaderTierReadConcept('authenticated', g12Tier)).toBe(false)
  })

  it('isolates hover summaries and split search per tier, indexes aliases separately, and returns 1 hit per concept', async () => {
    const plan = samplePlan()
    const docs = makeTempDir('concepts-search-docs-')
    writeFile(docs, 'g06/L01.md', '---\ntitle: "第1讲 · 公开基础"\n---\n\n# 公开\n\n使用 [公开术语](concept:public-term)。\n')
    writeFile(docs, 'g09/L01.md', '---\ntitle: "第1讲 · 登录认证"\n---\n\n# 认证\n\n使用 [内部术语](concept:auth-term)。\n')
    writeFile(docs, 'en/examples/g01/L01.md', '---\ntitle: "Example Lecture 1 · Demo"\n---\n\n# Demo\n\nEnglish text only.\n')

    writeFile(
      docs,
      'concepts/public-term.md',
      [
        '---',
        'title: "公开术语"',
        'term: "公开术语"',
        'english: "Public Concept"',
        'aliases: ["PUB-ALIAS-XYZ", "共享别名"]',
        'field: "基础"',
        'groups: ["G06"]',
        'summary: "这是一个公开概念摘要。"',
        'status: published',
        '---',
        '',
        '# 公开术语',
        '',
        '## 第一节',
        '',
        '公开概念的正文同样讨论 PUB 主题。',
        '',
        '## 第二节',
        '',
        '公开概念第二节重复出现 公开术语 与 PUB 关键字。',
      ].join('\n'),
    )

    writeFile(
      docs,
      'concepts/auth-term.md',
      [
        '---',
        'title: "内部认证术语SECRET_TITLE"',
        'term: "内部认证术语SECRET_TITLE"',
        'english: "Auth Restricted Concept"',
        'aliases: ["SECRET_ALIAS_ONLY_99"]',
        'field: "认证域"',
        'groups: ["G09"]',
        'summary: "RESTRICTED_HOVER_SUMMARY_XYZ 仅登录可见。"',
        'status: published',
        '---',
        '',
        '# 内部认证术语SECRET_TITLE',
        '',
        '限制级别正文 SECRET_CONCEPT_BODY_404。',
      ].join('\n'),
    )

    // Draft must never leak anywhere into hover or search!
    writeFile(
      docs,
      'concepts/_drafts/draft-only.md',
      '---\ntitle: "DRAFT_LEAK_TOKEN"\nterm: "DRAFT_LEAK_TOKEN"\nenglish: "Draft"\naliases: []\nfield: "x"\ngroups: ["G06"]\nsummary: "DRAFT_SUMMARY"\nstatus: draft\n---\n\n# Draft\n',
    )

    const content = contentForDocsRoot(docs)
    const hoverAssets = buildConceptDistAssets({ docsRoot: docs, allGroups: GROUPS, localeKeys: ['en'], accessPlan: plan }, content)
    const pubHover = hoverAssets.get('concepts-hover.json') ?? ''
    const authHover = hoverAssets.get('_access/authenticated/concepts-hover.json') ?? ''
    expect(pubHover).toContain('public-term')
    expect(pubHover).not.toContain('RESTRICTED_HOVER_SUMMARY_XYZ')
    expect(pubHover).not.toContain('DRAFT_LEAK_TOKEN')
    expect(authHover).toContain('RESTRICTED_HOVER_SUMMARY_XYZ')

    const built = buildSearchArtifacts({ docsRoot: docs, allGroups: GROUPS, localeKeys: ['en'], accessPlan: plan })
    const dist = makeTempDir('concepts-search-dist-')
    writeSearchArtifacts(dist, built)

    const pubTitlesRaw = fs.readFileSync(path.join(dist, 'search/root/titles.json'), 'utf8')
    expect(pubTitlesRaw).toContain('PUB-ALIAS-XYZ')
    expect(pubTitlesRaw).not.toContain('SECRET_ALIAS_ONLY_99')
    expect(pubTitlesRaw).not.toContain('SECRET_TITLE')
    expect(pubTitlesRaw).not.toContain('DRAFT_LEAK_TOKEN')

    // Aliases must NOT be stuffed into concept shard body
    const pubManifest = JSON.parse(fs.readFileSync(path.join(dist, 'search/root/manifest.json'), 'utf8')) as SearchManifestFile
    const conceptsShardMeta = pubManifest.shards.find((s) => s.groupId === 'CONCEPTS')!
    expect(conceptsShardMeta).toBeDefined()
    const conceptsShard = JSON.parse(
      zlib.inflateRawSync(fs.readFileSync(path.join(dist, 'search/root', conceptsShardMeta.url))).toString('utf8'),
    ) as ShardPayload
    expect(JSON.stringify(conceptsShard)).not.toContain('PUB-ALIAS-XYZ')

    // English search index contains ZERO CJK characters even with root concepts present
    const enTitles = fs.readFileSync(path.join(dist, 'search/en/titles.json'), 'utf8')
    expect(enTitles).not.toMatch(/[㐀-鿿]/)

    // Restricted search index stays under _access/authenticated/search/root/
    const authTitles = JSON.parse(
      fs.readFileSync(path.join(dist, '_access/authenticated/search/root/titles.json'), 'utf8'),
    ) as TitleIndexFile
    expect(authTitles.pages.some((p) => p[3] === '/_access/authenticated/concepts/auth-term')).toBe(true)

    // Client LectureSearchEngine searches alias field cleanly & returns strictly ONE result per concept page
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      const clean = url.replace(/^\/+/, '')
      const abs = path.join(dist, clean)
      if (!fs.existsSync(abs)) return new Response('404', { status: 404 })
      return new Response(new Uint8Array(fs.readFileSync(abs)), { status: 200 })
    }
    const engine = new LectureSearchEngine({
      base: '/',
      localeKeys: ['en'],
      siteData: () => ({ themeConfig: { lectureAccess: { inlineTier: 'public', tiers: [] } } }),
      statusOf: () => 'not_started',
      labels: {
        lectureNo: (n) => `第${n}讲`,
        groupCount: (n) => `${n}`,
        groupExamples: '示例',
        groupSite: '概览',
        groupConcepts: '概念',
        conceptBadge: '概念',
        loadingBar: (l, t) => `${l}/${t}`,
        loadingIdle: (l, t) => `${l}/${t}`,
        statusLabel: (s) => s,
      },
      fetchFn: mockFetch,
    })
    await engine.ensureLoaded('root', null)
    const aliasHits = engine.query('root', 'PUB-ALIAS-XYZ', 'all', null)
    expect(aliasHits.totalHits).toBe(1)
    expect(aliasHits.groups[0]?.items[0]?.noLabel).toBe('概念')

    // Even when multiple headings/body sections match "公开概念", ONLY ONE result represents the concept page
    await vi.waitFor(() => {
      expect(engine.getLoadState('root', true).loading).toBe(false)
    }, { timeout: 3_000 })
    const multiSectionHits = engine.query('root', '公开概念', 'all', null)
    const conceptHits = multiSectionHits.groups.find((g) => g.groupId === 'CONCEPTS')?.items ?? []
    expect(conceptHits).toHaveLength(1)
  })
})

describe('AST source rewriter & dev middleware lifecycle (create -> preview -> confirm -> delete)', () => {
  it('locates unique, ambiguous, and zero occurrences accurately and unlinks cleanly with jsdiff', () => {
    const md = [
      '---',
      'title: "第1讲 · 示例"',
      '---',
      '',
      '## 第一节',
      '',
      '第一处提到 `行内跳过` 与 执行租约 在普通段落。',
      '',
      '$$ \\text{执行租约} = 1 $$',
      '',
      '## 第二节',
      '',
      '第二处是 **执行租约** 在另一节。',
    ].join('\n')

    const all = locateOccurrencesInLecture({ markdown: md, selectedText: '执行租约' })
    expect(all.status).toBe('needs_choice')
    expect(all.candidates).toHaveLength(2)

    const narrowed = locateOccurrencesInLecture({
      markdown: md,
      selectedText: '执行租约',
      sectionHeading: '第二节',
      beforeContext: '第二处是 ',
      afterContext: ' 在另一节',
    })
    expect(narrowed.status).toBe('unique')
    expect(narrowed.recommendedIndex).toBe(1)

    const chosen = narrowed.candidates[narrowed.recommendedIndex!]!
    const mounted = buildMountConceptDiff(md, 'actuation-lease', [{ start: chosen.startOffset, end: chosen.endOffset }])
    expect(mounted.nextMarkdown).toContain('**[执行租约](concept:actuation-lease)**')
    expect(mounted.nextMarkdown).toContain('第一处提到 `行内跳过` 与 执行租约')
    expect(mounted.patch).toContain('+第二处是 **[执行租约](concept:actuation-lease)** 在另一节。')

    const unlinked = unlinkConceptInMarkdown(mounted.nextMarkdown, 'actuation-lease')
    expect(unlinked.removedCount).toBe(1)
    expect(unlinked.nextMarkdown).toBe(md)
    expect(findAllConceptLinksInMarkdown(mounted.nextMarkdown)).toHaveLength(1)
  })

  it('blocks confirming drafts with 待核实, allows resolve, writes exact diff, and deletes with impact preview', async () => {
    const tmpDocs = makeTempDir('f9-dev-lifecycle-')
    writeFile(
      tmpDocs,
      'g06/L01.md',
      '---\ntitle: "第1讲 · 示例"\norder: 1\n---\n\n# 第1讲\n\n## 控制权\n\n此处讲解 控制租约 的概念。\n',
    )
    const conceptsDir = path.join(tmpDocs, 'concepts')
    const handler = createDashboardDevHandler({
      token: 'tok-life-123',
      docsRoot: tmpDocs,
      conceptsDir,
    })

    // Create draft carrying 待核实
    const draftWithUnverif = draftPayloadToConceptMarkdown(
      {
        slug: 'control-lease',
        term: '控制租约',
        english: 'Control Lease',
        aliases: ['Lease'],
        field: '控制',
        groups: ['G06'],
        summary: '用于并发控制的有期限凭证。',
        paragraphs: [
          {
            heading: '定义',
            body: '包含控制期限字段，但具体时钟误差边界 待核实。',
            sources: ['G06-L01 · 控制权'],
            verified: false,
            unverifiedReason: '讲义未提及具体时钟容差数值',
          },
        ],
      },
      { selectionSource: 'G06-L01 · 控制权' },
    )
    expect(hasUnverifiedMarkers(draftWithUnverif).hasUnverified).toBe(true)

    // Save draft via dev API (simulating validated BYOK payload with unverified flag)
    const saveRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/draft',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: {
        mode: 'create',
        lecturePath: '/g06/L01',
        selectedText: '控制租约',
        draftPayload: {
          slug: 'control-lease',
          term: '控制租约',
          english: 'Control Lease',
          aliases: ['Lease'],
          field: '控制',
          groups: ['G06'],
          summary: '用于并发控制的有期限凭证。',
          related: [],
          paragraphs: [
            {
              heading: '定义',
              body: '包含控制期限字段，但具体时钟误差边界 待核实。',
              sources: ['G06-L01 · 控制权'],
              verified: false,
              unverifiedReason: '讲义未提及具体时钟容差数值',
            },
          ],
        },
      },
    })
    expect(saveRes.status).toBe(200)
    expect(fs.existsSync(path.join(conceptsDir, '_drafts', 'control-lease.md'))).toBe(true)

    // Confirming while 待核实 exists must fail/block!
    const blockedPreview = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/preview-confirm',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: { slug: 'control-lease' },
    })
    expect(blockedPreview.json.blockedByUnverified).toBe(true)
    expect(blockedPreview.json.canConfirm).toBe(false)

    const blockedConfirm = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/confirm',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: { slug: 'control-lease' },
    })
    expect(blockedConfirm.status).toBe(400)

    // Resolve 待核实 by editing draft
    const cleanDraftMd = draftPayloadToConceptMarkdown(
      {
        slug: 'control-lease',
        term: '控制租约',
        english: 'Control Lease',
        aliases: ['Lease'],
        field: '控制',
        groups: ['G06'],
        summary: '用于并发控制的有期限凭证。',
        paragraphs: [
          {
            heading: '定义',
            body: '包含控制期限字段与到期失效边界。',
            sources: ['G06-L01 · 控制权'],
            verified: true,
          },
        ],
      },
      { selectionSource: 'G06-L01 · 控制权' },
    )
    const updateRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/draft',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: { mode: 'edit', targetSlug: 'control-lease', markdownOverride: cleanDraftMd },
    })
    expect(updateRes.status).toBe(200)

    // Preview confirm shows unique hit + diff
    const readyPreview = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/preview-confirm',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: { slug: 'control-lease' },
    })
    expect(readyPreview.json.canConfirm).toBe(true)
    expect(readyPreview.json.mountStatus).toBe('ready')
    expect(readyPreview.json.lecturePatch).toContain('+此处讲解 [控制租约](concept:control-lease) 的概念。')

    // Execute confirm -> moves draft to published with reviewedAt & rewrites lecture
    const confirmed = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/confirm',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: { slug: 'control-lease' },
    })
    expect(confirmed.status).toBe(200)
    expect(fs.existsSync(path.join(conceptsDir, '_drafts', 'control-lease.md'))).toBe(false)
    const pubContent = fs.readFileSync(path.join(conceptsDir, 'control-lease.md'), 'utf8')
    const parsedPub = parseConceptMarkdown(pubContent, 'control-lease')
    expect(parsedPub.meta.status).toBe('published')
    expect(parsedPub.meta.reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(fs.readFileSync(path.join(tmpDocs, 'g06/L01.md'), 'utf8')).toContain('[控制租约](concept:control-lease)')

    // Preview delete -> impact report -> execute delete
    const delPreview = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/preview-delete',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: { slug: 'control-lease' },
    })
    expect(delPreview.json.totalLectures).toBe(1)
    expect(delPreview.json.totalOccurrences).toBe(1)

    const delExec = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/delete',
      headers: { 'x-lecture-dev-token': 'tok-life-123' },
      body: { slug: 'control-lease' },
    })
    expect(delExec.status).toBe(200)
    expect(fs.existsSync(path.join(conceptsDir, 'control-lease.md'))).toBe(false)
    expect(fs.readFileSync(path.join(tmpDocs, 'g06/L01.md'), 'utf8')).toContain('此处讲解 控制租约 的概念。')
  })
})

describe('local author write path: token, loopback, slug confinement, stale preview, atomic and confined writes', () => {
  const setup = () => {
    const tmpDocs = makeTempDir('f9-dev-safety-')
    writeFile(tmpDocs, 'g06/L01.md', '---\ntitle: "第1讲 · 示例"\norder: 1\n---\n\n# 第1讲\n\n## 控制权\n\n此处讲解 控制租约 的概念。\n')
    const conceptsDir = path.join(tmpDocs, 'concepts')
    writeFile(
      tmpDocs,
      'concepts/control-lease.md',
      draftPayloadToConceptMarkdown(
        { slug: 'control-lease', term: '控制租约', english: 'Control Lease', aliases: [], field: '控制', groups: ['G06'], summary: '摘要。', paragraphs: [{ heading: '定义', body: '正文。', sources: ['G06-L01 · 控制权'], verified: true }] },
        { selectionSource: 'G06-L01' },
      ),
    )
    const handler = createDashboardDevHandler({ token: 'tok-safe', docsRoot: tmpDocs, conceptsDir })
    return { tmpDocs, conceptsDir, handler }
  }
  const post = (handler: ReturnType<typeof setup>['handler'], sub: string, body: unknown, headers: Record<string, string> = { 'x-lecture-dev-token': 'tok-safe' }) =>
    invokeHandler(handler, { method: 'POST', url: `/__lecture/api/concepts/${sub}`, headers, body })

  it('refuses every write endpoint without the dev token, from a foreign origin, or from a foreign host', async () => {
    const { handler, tmpDocs } = setup()
    const before = fs.readFileSync(path.join(tmpDocs, 'g06/L01.md'), 'utf8')
    for (const sub of ['draft', 'confirm', 'discard', 'delete', 'preview-delete', 'preview-confirm', 'context']) {
      expect((await post(handler, sub, { slug: 'control-lease' }, {})).status, `${sub} without token`).toBe(403)
      expect((await post(handler, sub, { slug: 'control-lease' }, { 'x-lecture-dev-token': 'wrong' })).status, `${sub} wrong token`).toBe(403)
      expect((await post(handler, sub, { slug: 'control-lease' }, { 'x-lecture-dev-token': 'tok-safe', origin: 'https://evil.example' })).status, `${sub} foreign origin`).toBe(403)
      expect((await post(handler, sub, { slug: 'control-lease' }, { 'x-lecture-dev-token': 'tok-safe', host: 'evil.example' })).status, `${sub} foreign host`).toBe(403)
    }
    expect(fs.readFileSync(path.join(tmpDocs, 'g06/L01.md'), 'utf8')).toBe(before)
    expect(fs.existsSync(path.join(tmpDocs, 'concepts/control-lease.md'))).toBe(true)
  })

  it('rejects slugs with separators, traversal, drive letters and encoded traversal without touching anything', async () => {
    const { handler, tmpDocs } = setup()
    const outside = path.join(tmpDocs, 'outside.md')
    fs.writeFileSync(outside, 'keep', 'utf8')
    const bad = ['../outside', '..\\outside', 'a/b', 'a\\b', 'C:\\x', 'C:/x', '%2e%2e/outside', '..%2foutside', '.', '..', '', 'UPPER', 'a b', '_drafts/x']
    for (const slug of bad) {
      for (const sub of ['discard', 'delete', 'preview-delete', 'confirm', 'preview-confirm']) {
        const r = await post(handler, sub, { slug })
        expect(r.status, `${sub} ${JSON.stringify(slug)}`).toBe(400)
      }
      const r = await post(handler, 'draft', { mode: 'edit', targetSlug: slug, markdownOverride: '---\nterm: x\n---\n', selectedText: 'x' })
      expect(r.status, `draft ${JSON.stringify(slug)}`).toBe(400)
    }
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
    expect(fs.existsSync(path.join(tmpDocs, 'concepts/control-lease.md'))).toBe(true)
  })

  it('refuses a confirm or delete whose preview is stale, and writes nothing then', async () => {
    const { handler, tmpDocs, conceptsDir } = setup()
    const lecture = path.join(tmpDocs, 'g06/L01.md')
    const draft = await post(handler, 'draft', { mode: 'edit', targetSlug: 'control-lease', markdownOverride: fs.readFileSync(path.join(conceptsDir, 'control-lease.md'), 'utf8') })
    expect(draft.status).toBe(200)
    const preview = await post(handler, 'preview-confirm', { slug: 'control-lease', lecturePath: '/g06/L01', selectedText: '控制租约' })
    expect(preview.json.mountStatus).toBe('ready')
    const token = String(preview.json.previewToken)
    expect(token).toMatch(/^[0-9a-f]{32}$/)

    // the lecture changes after the diff was shown
    fs.appendFileSync(lecture, '\n后来补写的一段，与概念无关。\n', 'utf8')
    const changed = fs.readFileSync(lecture, 'utf8')
    const stale = await post(handler, 'confirm', { slug: 'control-lease', lecturePath: '/g06/L01', selectedText: '控制租约', expectedPreviewToken: token })
    expect(stale.status).toBe(400)
    expect(String(stale.json.error)).toContain('STALE_PREVIEW')
    expect(fs.readFileSync(lecture, 'utf8')).toBe(changed)
    expect(fs.existsSync(path.join(conceptsDir, '_drafts', 'control-lease.md'))).toBe(true)

    // a fresh preview and its token write exactly the diff shown
    fs.appendFileSync(lecture, '\n另一处也讲 控制租约 了。\n', 'utf8')
    const changed2 = fs.readFileSync(lecture, 'utf8')
    const fresh = await post(handler, 'preview-confirm', { slug: 'control-lease', lecturePath: '/g06/L01', selectedText: '控制租约', allOccurrences: true })
    const ok = await post(handler, 'confirm', { slug: 'control-lease', lecturePath: '/g06/L01', selectedText: '控制租约', allOccurrences: true, expectedPreviewToken: String(fresh.json.previewToken) })
    expect(ok.status).toBe(200)
    expect(String(fresh.json.lecturePatch)).toContain('+此处讲解 [控制租约](concept:control-lease) 的概念。')
    expect(fs.readFileSync(lecture, 'utf8')).toBe(changed2.replace(/控制租约/g, '[控制租约](concept:control-lease)'))

    // delete: the same guard
    const impact = await post(handler, 'preview-delete', { slug: 'control-lease' })
    expect(impact.json.totalOccurrences).toBe(2)
    fs.appendFileSync(lecture, '\n再来一处 [控制租约](concept:control-lease)。\n', 'utf8')
    const staleDelete = await post(handler, 'delete', { slug: 'control-lease', expectedPreviewToken: String(impact.json.previewToken) })
    expect(staleDelete.status).toBe(409)
    expect(fs.existsSync(path.join(conceptsDir, 'control-lease.md'))).toBe(true)
  })

  it('writes atomically (no temp files left) and only inside the allowed folders, never through links', () => {
    const root = makeTempDir('f9-safe-write-')
    const inside = path.join(root, 'concepts')
    const outside = makeTempDir('f9-safe-outside-')
    fs.mkdirSync(inside, { recursive: true })

    atomicWriteFile(path.join(inside, 'a.md'), 'one', [inside])
    atomicWriteFile(path.join(inside, 'a.md'), 'two', [inside])
    expect(fs.readFileSync(path.join(inside, 'a.md'), 'utf8')).toBe('two')
    expect(fs.readdirSync(inside)).toEqual(['a.md'])

    expect(() => assertWritableTarget(path.join(outside, 'x.md'), [inside])).toThrow(/outside/)
    expect(() => assertWritableTarget(path.join(inside, '..', 'x.md'), [inside])).toThrow(/outside/)

    // a junction (directory link) inside the folder that leads out is refused by real path
    const link = path.join(inside, 'escape')
    fs.symlinkSync(outside, link, 'junction')
    expect(() => atomicWriteFile(path.join(link, 'x.md'), 'leak', [inside])).toThrow(/outside/)
    expect(fs.readdirSync(outside)).toEqual([])
    fs.rmSync(link, { recursive: false, force: true })

    // a file symlink is refused where the platform lets the test create one
    const target = path.join(outside, 'secret.md')
    fs.writeFileSync(target, 'secret', 'utf8')
    let fileLinked = false
    try {
      fs.symlinkSync(target, path.join(inside, 'link.md'), 'file')
      fileLinked = true
    } catch {
      fileLinked = false
    }
    if (fileLinked) {
      expect(() => atomicWriteFile(path.join(inside, 'link.md'), 'leak', [inside])).toThrow(/symbolic link/)
      expect(fs.readFileSync(target, 'utf8')).toBe('secret')
    }
  })
})

describe('WP-K3 concept drafting v2: lookup before writing, duplicate stop, occurrences, neighbours, 24k cap & supplement mode', () => {
  it('stops duplicates across published + drafts in create mode, returns multiple matches, and builds ordered bounded context (<= 24k)', async () => {
    const { buildLectureContextForDraft, listAllConceptsDev } = await import('../../docs/.vitepress/concepts/devWorkflow.mts')
    const tmpDocs = makeTempDir('k3-lookup-')
    fs.mkdirSync(path.join(tmpDocs, 'concepts', '_drafts'), { recursive: true })
    fs.mkdirSync(path.join(tmpDocs, 'en', 'g06'), { recursive: true })
    fs.mkdirSync(path.join(tmpDocs, 'g06'), { recursive: true })
    fs.mkdirSync(path.join(tmpDocs, 'g01'), { recursive: true })

    // Published concept + alias + another draft sharing the same alias + neighbour concept
    writeFile(
      tmpDocs,
      'concepts/peer-alpha.md',
      [
        '---',
        'title: "脉冲同步"',
        'term: "脉冲同步"',
        'english: "Pulse Sync"',
        'aliases: ["Pulse-Sync", "时钟对齐"]',
        'field: "时序"',
        'groups: ["G06"]',
        'summary: "基于脉冲边沿对齐多节点采样节拍。"',
        'status: published',
        'reviewedAt: "2026-11-20"',
        'generatedBy: "seed"',
        'related: []',
        '---',
        '',
        '# 脉冲同步',
        '',
        '## 说明',
        '',
        '脉冲同步依赖时钟对齐。',
        '',
        '（出处：G06-L01）',
      ].join('\n'),
    )
    writeFile(
      tmpDocs,
      'concepts/_drafts/draft-beta.md',
      [
        '---',
        'title: "时间片同步"',
        'term: "时间片同步"',
        'english: "Slot Sync"',
        'aliases: ["时钟对齐"]',
        'field: "时序"',
        'groups: ["G06"]',
        'summary: "草稿概念。"',
        'status: draft',
        'generatedBy: "seed"',
        'related: []',
        '---',
        '',
        '# 时间片同步',
        '',
        '草稿正文。',
      ].join('\n'),
    )
    writeFile(
      tmpDocs,
      'concepts/neighbour-sync.md',
      [
        '---',
        'title: "锁相环"',
        'term: "锁相环"',
        'english: "PLL"',
        'aliases: []',
        'field: "时钟"',
        'groups: ["G06"]',
        'summary: "闭环追踪参考频率与相位。"',
        'status: published',
        'reviewedAt: "2026-11-20"',
        'generatedBy: "seed"',
        'related:',
        '  - { slug: peer-alpha, rel: applied-in }',
        '---',
        '',
        '# 锁相环',
        '',
        '配合[脉冲同步](concept:peer-alpha)工作。',
        '',
        '（出处：G06-L02）',
      ].join('\n'),
    )

    // Lectures across two groups + en/ translation (must be ignored by occurrences)
    const longFiller = '背景说明文本。'.repeat(400) // > 2000 chars per section to test 1500 truncation & 24k cap
    writeFile(
      tmpDocs,
      'g06/L01.md',
      [
        '---',
        'title: "第1讲 · 采样基础"',
        'order: 1',
        '---',
        '',
        '# 第1讲 · 采样基础',
        '',
        '## 节一 选文节',
        '',
        `本节只提一次 新目标词，同时也讨论 锁相环。${longFiller}`,
        '',
        '## 节二 补充节',
        '',
        '新目标词 在这一节也会配合 锁相环 出现。',
      ].join('\n'),
    )
    const manySections = Array.from({ length: 12 }, (_, idx) => [
      `## 章节 ${idx + 1}`,
      '',
      `${'新目标词 '.repeat(idx + 2)}${longFiller}`,
    ]).flat()
    writeFile(
      tmpDocs,
      'g01/L02.md',
      ['---', 'title: "第2讲 · 深度展开"', 'order: 2', '---', '', '# 第2讲 · 深度展开', ...manySections].join('\n'),
    )
    writeFile(
      tmpDocs,
      'en/g06/L01.md',
      '---\ntitle: "Lecture 1 · Translated"\norder: 1\n---\n\n# Translated\n\n## Translated Sec\n\n新目标词 新目标词 新目标词 新目标词 新目标词。\n',
    )

    const paths = {
      ...contentForDocsRoot(tmpDocs),
    }

    // 1. Single match on published alias with punctuation variation (NFKC/case/hyphen folded)
    const dupSingle = await buildLectureContextForDraft(paths, {
      mode: 'create',
      lecturePath: '/g06/L01',
      selectedText: 'pulse sync',
    })
    expect(dupSingle.ok).toBe(false)
    if (!dupSingle.ok) {
      expect(dupSingle.errorCode).toBe('DUPLICATE')
      expect(dupSingle.existing).toMatchObject({
        slug: 'peer-alpha',
        term: '脉冲同步',
        url: '/concepts/peer-alpha',
        status: 'published',
      })
    }

    // 2. Draft match + multiple matches sharing normalized alias "时钟对齐"
    const dupMulti = await buildLectureContextForDraft(paths, {
      mode: 'create',
      lecturePath: '/g06/L01',
      selectedText: '时钟 对齐',
    })
    expect(dupMulti.ok).toBe(false)
    if (!dupMulti.ok) {
      expect(dupMulti.errorCode).toBe('DUPLICATE')
      expect(dupMulti.matches.map((m) => m.slug).sort()).toEqual(['draft-beta', 'peer-alpha'])
    }

    // 3. Clean term -> occurrences ordered (selected lecture first, then mention count), <= 10, <= 1500 chars/section,
    //    no en/ localized lecture included, neighbours with summary & related, existingConcepts has summary, <= 24,000 total chars
    const built = await buildLectureContextForDraft(paths, {
      mode: 'create',
      lecturePath: '/g06/L01',
      selectedText: '新目标词',
      sectionHeading: '节一 选文节',
    })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.contextChars).toBeLessThanOrEqual(24_000)
      const occ = built.context.occurrences as Array<{
        lectureCode: string
        lecturePath: string
        title: string
        heading: string
        anchor: string
        link: string
        mentions: number
        text: string
      }>
      expect(occ.length).toBeGreaterThan(0)
      expect(occ.length).toBeLessThanOrEqual(10)
      expect(occ[0]!.lecturePath).toBe('/g06/L01')
      expect(occ.some((o) => o.lecturePath.startsWith('/en/'))).toBe(false)
      for (const s of occ) {
        expect(s.text.length).toBeLessThanOrEqual(1500)
        expect(s.anchor.length).toBeGreaterThan(0)
        expect(s.link).toBe(`${s.lecturePath}#${s.anchor}`)
      }
      const g01Occ = occ.filter((o) => o.lecturePath === '/g01/L02')
      for (let i = 1; i < g01Occ.length; i++) {
        expect(g01Occ[i - 1]!.mentions).toBeGreaterThanOrEqual(g01Occ[i]!.mentions)
      }

      const neighbours = built.context.neighbours as Array<{
        slug: string
        term: string
        aliases: string[]
        summary: string
        related: unknown[]
      }>
      expect(neighbours.length).toBeLessThanOrEqual(15)
      expect(neighbours.find((n) => n.slug === 'neighbour-sync')).toMatchObject({
        slug: 'neighbour-sync',
        term: '锁相环',
        summary: '闭环追踪参考频率与相位。',
        related: [{ slug: 'peer-alpha', rel: 'applied-in' }],
      })

      const existing = built.context.existingConcepts as Array<{ slug: string; summary?: string }>
      expect(existing.every((e) => typeof e.summary === 'string' && e.summary.length > 0)).toBe(true)

      const list = await listAllConceptsDev(paths)
      expect(list.some((item) => item.slug === 'draft-beta' && item.status === 'draft' && !item.isRevision)).toBe(true)
    }
  })

  it('supports supplement mode lifecycle: passes currentConcept, creates pending revision with diff, preserves URL/status & sets reviewedAt on confirm', async () => {
    const tmpDocs = makeTempDir('k3-supplement-')
    writeFile(tmpDocs, 'g06/L01.md', '---\ntitle: "第1讲 · 测试"\norder: 1\n---\n\n# 第1讲\n\n## 新应用场景\n\n这里进一步补充 [核心租约](concept:core-lease) 的失效恢复机制。\n')
    writeFile(
      tmpDocs,
      'concepts/core-lease.md',
      [
        '---',
        'title: "核心租约"',
        'term: "核心租约"',
        'english: "Core Lease"',
        'aliases: ["租约核心"]',
        'field: "并发控制"',
        'groups: ["G06"]',
        'summary: "旧版摘要。"',
        'status: published',
        'reviewedAt: "2025-01-01"',
        'selectionSource: "G06-L01"',
        'generatedBy: "seed"',
        'related: []',
        '---',
        '',
        '# 核心租约',
        '',
        '## 基本原理',
        '',
        '原有已确认内容，保留旧出处。',
        '',
        '（出处：G06-L01 · 第 1 节）',
        '',
      ].join('\n'),
    )

    const conceptsDir = path.join(tmpDocs, 'concepts')
    const handler = createDashboardDevHandler({ token: 'tok-supp', docsRoot: tmpDocs, conceptsDir })

    // 1. Supplement mode loads currentConcept (published page)
    const ctxRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/context',
      headers: { 'x-lecture-dev-token': 'tok-supp' },
      body: { mode: 'supplement', targetSlug: 'core-lease', lecturePath: '/g06/L01', selectedText: '核心租约' },
    })
    expect(ctxRes.status).toBe(200)
    expect((ctxRes.json.context as { currentConcept?: { slug: string } }).currentConcept?.slug).toBe('core-lease')

    // 2. Write revised draft via supplement + draftPayload
    const draftRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/draft',
      headers: { 'x-lecture-dev-token': 'tok-supp' },
      body: {
        mode: 'supplement',
        targetSlug: 'core-lease',
        lecturePath: '/g06/L01',
        selectedText: '核心租约',
        draftPayload: {
          slug: 'core-lease',
          term: '核心租约',
          english: 'Core Lease',
          aliases: ['租约核心'],
          field: '并发控制',
          groups: ['G06'],
          summary: '包含失效恢复细节的新版全貌摘要。',
          related: [],
          paragraphs: [
            {
              heading: '基本原理',
              body: '原有已确认内容，保留旧出处。',
              sources: ['[G06-L01](/g06/L01) · 第 1 节'],
              verified: true,
            },
            {
              heading: '失效恢复',
              body: '补充新讲义增加的失效恢复路径。',
              sources: ['[G06-L01](/g06/L01#新应用场景)'],
              verified: true,
            },
          ],
        },
      },
    })
    expect(draftRes.status).toBe(200)
    const item = draftRes.json.item as { status: string; isRevision?: boolean }
    expect(item.status).toBe('draft')
    expect(item.isRevision).toBe(true)

    // Dashboard concepts list flags both revision draft and published item
    const listRes = await invokeHandler(handler, { method: 'GET', url: '/__lecture/api/concepts' })
    const items = listRes.json.items as Array<{ slug: string; status: string; isRevision?: boolean; hasDraftRevision?: boolean }>
    expect(items.find((i) => i.slug === 'core-lease' && i.status === 'draft')?.isRevision).toBe(true)
    expect(items.find((i) => i.slug === 'core-lease' && i.status === 'published')?.hasDraftRevision).toBe(true)

    // 3. Preview confirm shows diff against published page (`conceptPatch`) with previewToken
    const prevRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/preview-confirm',
      headers: { 'x-lecture-dev-token': 'tok-supp' },
      body: { slug: 'core-lease' },
    })
    expect(prevRes.status).toBe(200)
    expect(prevRes.json.canConfirm).toBe(true)
    expect(String(prevRes.json.conceptPatch)).toContain('-summary: "旧版摘要。"')
    expect(String(prevRes.json.conceptPatch)).toContain('+summary: "包含失效恢复细节的新版全貌摘要。"')
    expect(String(prevRes.json.conceptPatch)).toContain('+补充新讲义增加的失效恢复路径。')

    // 4. Stale check catches concurrent edit to published file too
    const pubPath = path.join(conceptsDir, 'core-lease.md')
    const savedPub = fs.readFileSync(pubPath, 'utf8')
    fs.writeFileSync(pubPath, savedPub + '\n<!-- concurrent edit -->\n', 'utf8')
    const staleConfirm = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/confirm',
      headers: { 'x-lecture-dev-token': 'tok-supp' },
      body: { slug: 'core-lease', expectedPreviewToken: String(prevRes.json.previewToken) },
    })
    expect(staleConfirm.status).toBe(400)
    expect(String(staleConfirm.json.error)).toContain('STALE_PREVIEW')

    // Refresh preview & confirm -> replaces published page, sets reviewedAt today, keeps URL, deletes draft
    const freshPrev = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/preview-confirm',
      headers: { 'x-lecture-dev-token': 'tok-supp' },
      body: { slug: 'core-lease' },
    })
    const okConfirm = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/confirm',
      headers: { 'x-lecture-dev-token': 'tok-supp' },
      body: { slug: 'core-lease', expectedPreviewToken: String(freshPrev.json.previewToken) },
    })
    expect(okConfirm.status).toBe(200)
    expect(okConfirm.json.url).toBe('/concepts/core-lease')
    expect(fs.existsSync(path.join(conceptsDir, '_drafts', 'core-lease.md'))).toBe(false)
    const updatedPub = parseConceptMarkdown(fs.readFileSync(pubPath, 'utf8'), 'core-lease')
    expect(updatedPub.meta.status).toBe('published')
    expect(updatedPub.meta.reviewedAt).toBe(new Date().toISOString().slice(0, 10))
    expect(updatedPub.body).toContain('原有已确认内容，保留旧出处')
    expect(updatedPub.body).toContain('补充新讲义增加的失效恢复路径')
  })

  it('measures real repository selection context size for 执行租约 in /lr/L01 under 24,000 chars', async () => {
    const { buildLectureContextForDraft } = await import('../../docs/.vitepress/concepts/devWorkflow.mts')
    const { resolveContent } = await import('../../docs/.vitepress/content/paths.mts')
    const realContent = resolveContent()
    const dupCheck = await buildLectureContextForDraft(realContent, {
      mode: 'create',
      lecturePath: '/lr/L01',
      selectedText: '执行租约',
    })
    expect(dupCheck.ok).toBe(false)
    if (!dupCheck.ok) {
      expect(dupCheck.errorCode).toBe('DUPLICATE')
      expect(dupCheck.existing.slug).toBe('actuation-lease')
    }

    const suppCtx = await buildLectureContextForDraft(realContent, {
      mode: 'supplement',
      targetSlug: 'actuation-lease',
      lecturePath: '/lr/L01',
      selectedText: '执行租约',
    })
    expect(suppCtx.ok).toBe(true)
    if (suppCtx.ok) {
      expect(suppCtx.contextChars).toBeLessThanOrEqual(24_000)
      const occ = suppCtx.context.occurrences as Array<{ lectureCode: string; link: string }>
      const nb = suppCtx.context.neighbours as Array<{ slug: string }>
      expect(occ[0]?.lectureCode).toBe('LR-L01')
      expect(suppCtx.contextChars).toBeGreaterThan(500)
      console.warn(
        `[k3-measure] selection="执行租约" lecture="/lr/L01" contextChars=${suppCtx.contextChars} occurrences=${occ.length} neighbours=${nb.length}`,
      )
    }
  })
})
