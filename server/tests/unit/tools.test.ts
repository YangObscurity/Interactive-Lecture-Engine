import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ToolEngine,
  ToolTimeoutError,
  aiToolsFileSchema,
  mintToolTicket,
  normalizeSearchText,
  resolveAiToolsFilePath,
  resolveReadableTiers,
  verifyToolTicket,
} from '../../src/tools/index.js'
import { ExternalMcpManager } from '../../src/tools/mcpClients.js'
import type { MCPClient } from '@ai-sdk/mcp'
import type {
  ConceptGraphResult,
  ConceptRecord,
  ConceptSearchHit,
  LectureSearchHit,
  LectureSummaryResult,
  ToolCallLogLine,
} from '../../src/tools/types.js'

const FIXTURE_DIST = fileURLToPath(new URL('../fixtures/tools', import.meta.url))

describe('Tools engine module (WP-K2 Item 1)', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeEngine(opts?: {
    distDir?: string
    timeoutMs?: number
    maxResultBytes?: number
    now?: () => number
    logs?: ToolCallLogLine[]
  }) {
    const logs = opts?.logs ?? []
    return new ToolEngine(
      {
        siteDistDir: opts?.distDir ?? FIXTURE_DIST,
        aiToolTimeoutMs: opts?.timeoutMs ?? 8000,
        aiToolMaxResultBytes: opts?.maxResultBytes ?? 24000,
      },
      {
        now: opts?.now ?? (() => 1_763_800_000_000),
        logger: (line) => logs.push(line),
      },
    )
  }

  it('normalizes NFKC, case, spaces, and punctuation', () => {
    expect(normalizeSearchText('  ＴＣＰ ／ ＩＰ  (v2) ')).toBe('tcpip(v2)'.replace(/[()]/g, ''))
    expect(normalizeSearchText('Ｔhree-Way   Handshake！')).toBe('threewayhandshake')
  })

  it('orders concept search matches: exact > alias > english > fuzzy with NFKC/case normalization', async () => {
    const logs: ToolCallLogLine[] = []
    const engine = makeEngine({ logs })

    const exact = (await engine.execute(
      'search_concepts',
      { query: '  ｔｃｐ  三次握手 ' },
      { readableTiers: ['public'], channel: 'internal', userId: 'alice' },
    )) as ConceptSearchHit[]
    expect(exact[0]?.slug).toBe('tcp-handshake')
    expect(exact[0]?.match).toBe('exact')

    const alias = (await engine.execute(
      'search_concepts',
      { query: 'ｏｃｃ' },
      { readableTiers: ['public'], channel: 'internal', userId: 'alice' },
    )) as ConceptSearchHit[]
    expect(alias[0]?.slug).toBe('optimistic-lock')
    expect(alias[0]?.match).toBe('alias')

    const english = (await engine.execute(
      'search_concepts',
      { query: 'sliding   window' },
      { readableTiers: ['public'], channel: 'internal', userId: 'alice' },
    )) as ConceptSearchHit[]
    expect(english[0]?.slug).toBe('sliding-window')
    expect(english[0]?.match).toBe('english')

    const fuzzy = (await engine.execute(
      'search_concepts',
      { query: '并发事务控制' },
      { readableTiers: ['public'], channel: 'internal', userId: 'alice' },
    )) as ConceptSearchHit[]
    expect(fuzzy.length).toBeGreaterThan(0)
    expect(fuzzy[0]?.slug).toBe('optimistic-lock')
    expect(fuzzy[0]?.match).toBe('fuzzy')

    // Every call logged one structured line without query or result content
    expect(logs).toHaveLength(4)
    expect(logs[0]).toMatchObject({
      evt: 'ai_tool_call',
      tool: 'search_concepts',
      channel: 'internal',
      ok: true,
    })
    expect(typeof logs[0]?.uh).toBe('string')
    expect(logs[0]?.bytes).toBeGreaterThan(0)
    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('三次握手')
    expect(serialized).not.toContain('滑动窗口')
  })

  it('resolves caller tiers from tiers.json and isolates staff content from public callers', async () => {
    const engine = makeEngine()
    const tiers = engine.store.loadTiers()

    expect(resolveReadableTiers({ authenticated: false, roles: ['reader'], groups: [] }, tiers)).toEqual(['public'])
    expect(resolveReadableTiers({ authenticated: true, roles: ['reader'], groups: ['students'] }, tiers)).toEqual([
      'public',
    ])
    expect(resolveReadableTiers({ authenticated: true, roles: ['author'], groups: ['staff'] }, tiers)).toEqual([
      'public',
      'staff',
    ])

    // Public caller must NEVER see staff concept or lecture, not even through links/backlinks/graph/lectures
    const pubConceptSearch = (await engine.execute(
      'search_concepts',
      { query: '教研内部评分策略' },
      { readableTiers: ['public'], channel: 'rest', userId: 'anon' },
    )) as ConceptSearchHit[]
    expect(pubConceptSearch.some((c) => c.slug === 'staff-secret-algo')).toBe(false)

    const pubDirectStaffConcept = (await engine.execute(
      'get_concept',
      { slug: 'staff-secret-algo' },
      { readableTiers: ['public'], channel: 'rest', userId: 'anon' },
    )) as { error?: string }
    expect(pubDirectStaffConcept.error).toBe('not_found')

    const pubTcp = (await engine.execute(
      'get_concept',
      { slug: 'tcp-handshake' },
      { readableTiers: ['public'], channel: 'rest', userId: 'anon' },
    )) as ConceptRecord
    expect(pubTcp.links).toEqual(['sliding-window'])
    expect(pubTcp.backlinks).toEqual(['sliding-window'])
    expect(pubTcp.related.map((r) => r.slug)).toEqual(['sliding-window'])
    expect(pubTcp.lectures.map((l) => l.id)).toEqual(['G01-L01'])

    const pubGraph = (await engine.execute(
      'get_concept_graph',
      { slug: 'tcp-handshake', depth: 2 },
      { readableTiers: ['public'], channel: 'rest', userId: 'anon' },
    )) as ConceptGraphResult
    expect(pubGraph.nodes.map((n) => n.slug)).toEqual(['sliding-window', 'tcp-handshake'])
    expect(pubGraph.edges.some((e) => e.from === 'staff-secret-algo' || e.to === 'staff-secret-algo')).toBe(false)

    const pubLecSearch = (await engine.execute(
      'search_lectures',
      { query: '99123' },
      { readableTiers: ['public'], channel: 'rest', userId: 'anon' },
    )) as LectureSearchHit[]
    expect(pubLecSearch).toEqual([])

    const pubLecSummary = (await engine.execute(
      'get_lecture_summary',
      { lecture: 'STF-L99' },
      { readableTiers: ['public'], channel: 'rest', userId: 'anon' },
    )) as { error?: string }
    expect(pubLecSummary.error).toBe('not_found')

    // Staff caller CAN see both public and staff concepts, edges, and lectures
    const staffGraph = (await engine.execute(
      'get_concept_graph',
      { slug: 'tcp-handshake', depth: 1 },
      { readableTiers: ['public', 'staff'], channel: 'rest', userId: 'prof' },
    )) as ConceptGraphResult
    expect(staffGraph.nodes.map((n) => n.slug)).toContain('staff-secret-algo')
    expect(staffGraph.edges.some((e) => e.rel === 'link' && e.to === 'sliding-window')).toBe(true)

    const staffLecSummary = (await engine.execute(
      'get_lecture_summary',
      { lecture: '/staff/L99', heading: '保密校准基准' },
      { readableTiers: ['public', 'staff'], channel: 'rest', userId: 'prof' },
    )) as LectureSummaryResult
    expect(staffLecSummary.id).toBe('STF-L99')
    expect(staffLecSummary.sections).toHaveLength(1)
    expect(staffLecSummary.sections[0]?.text).toContain('99123')
  })

  it('filters search_lectures by group and handles missing dist directory gracefully', async () => {
    const emptyEngine = makeEngine({ distDir: resolve(FIXTURE_DIST, 'non-existent-dist-dir') })
    expect(emptyEngine.resolveTiersForCaller({ authenticated: true, groups: ['staff'] })).toEqual(['public'])
    expect(
      await emptyEngine.execute('search_concepts', { query: 'TCP' }, { readableTiers: ['public'], channel: 'internal' }),
    ).toEqual([])

    const engine = makeEngine()
    const g02Hits = (await engine.execute(
      'search_lectures',
      { query: '控制', group: 'g02' },
      { readableTiers: ['public'], channel: 'internal' },
    )) as LectureSearchHit[]
    expect(g02Hits.length).toBeGreaterThan(0)
    expect(g02Hits.every((h) => h.id === 'G02-L01')).toBe(true)
  })

  it('private site: the inline files belong to "authenticated", so "public" (no session, bad ticket) reads nothing', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'k2-tools-private-'))
    tempDirs.push(tmpDir)
    cpSync(FIXTURE_DIST, tmpDir, { recursive: true })
    // the shape K1 writes for a private site: inline tier "authenticated" at /tools/
    const relabel = (rel: string) => {
      const f = join(tmpDir, rel)
      writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), tier: 'authenticated' }))
    }
    relabel('tools/concepts.json')
    relabel('tools/lectures.json')
    writeFileSync(
      join(tmpDir, 'tools/tiers.json'),
      JSON.stringify({
        version: 1,
        tiers: [
          { id: 'authenticated', read: 'authenticated', groups: [], path: '/tools/' },
          { id: 'staff', read: 'groups', groups: ['staff'], path: '/_access/staff/tools/' },
        ],
      }),
    )
    const engine = makeEngine({ distDir: tmpDir })
    expect(engine.resolveTiersForCaller(null)).toEqual(['public'])
    const bad = verifyToolTicket('secret-for-test', 'not-a-ticket')
    for (const tiers of [bad.tiers, engine.resolveTiersForCaller(null)]) {
      expect(await engine.execute('search_concepts', { query: 'TCP' }, { readableTiers: tiers, channel: 'internal' })).toEqual([])
      expect(await engine.execute('search_lectures', { query: 'TCP' }, { readableTiers: tiers, channel: 'internal' })).toEqual([])
    }
    const signedIn = engine.resolveTiersForCaller({ authenticated: true, groups: [] })
    expect(signedIn).toContain('authenticated')
    const hits = (await engine.execute('search_concepts', { query: 'TCP' }, { readableTiers: signedIn, channel: 'internal' })) as ConceptSearchHit[]
    expect(hits.map((h) => h.slug)).toContain('tcp-handshake')
  })

  it('a tool file that names another tier is not served, and a missing tiers.json means no tier at all', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'k2-tools-mismatch-'))
    tempDirs.push(tmpDir)
    cpSync(FIXTURE_DIST, tmpDir, { recursive: true })
    const engine = makeEngine({ distDir: tmpDir })
    const ask = async () =>
      ((await engine.execute('search_concepts', { query: 'Grading' }, { readableTiers: ['staff'], channel: 'internal' })) as ConceptSearchHit[]).map((h) => h.slug)
    expect(await ask()).toEqual(['staff-secret-algo'])
    const f = join(tmpDir, '_access/staff/tools/concepts.json')
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), tier: 'public' }))
    expect(await ask()).toEqual([])
    unlinkSync(join(tmpDir, 'tools/tiers.json'))
    expect(await engine.execute('search_concepts', { query: 'TCP' }, { readableTiers: ['public'], channel: 'internal' })).toEqual([])
  })

  it('reloads data automatically when file mtime/size changes and survives missing tier file', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'k2-tools-reload-'))
    tempDirs.push(tmpDir)
    cpSync(FIXTURE_DIST, tmpDir, { recursive: true })

    // Missing staff lectures file means empty tier, not an error
    unlinkSync(join(tmpDir, '_access/staff/tools/lectures.json'))

    const engine = makeEngine({ distDir: tmpDir })
    const initial = (await engine.execute(
      'search_concepts',
      { query: 'QUIC' },
      { readableTiers: ['public'], channel: 'internal' },
    )) as ConceptSearchHit[]
    expect(initial).toEqual([])

    const staffLec = (await engine.execute(
      'search_lectures',
      { query: '99123' },
      { readableTiers: ['public', 'staff'], channel: 'internal' },
    )) as LectureSearchHit[]
    expect(staffLec).toEqual([])

    // Update concepts.json and verify mtime reload picks it up
    const conceptsPath = join(tmpDir, 'tools/concepts.json')
    const parsed = JSON.parse(readFileSync(conceptsPath, 'utf8')) as { concepts: ConceptRecord[] }
    parsed.concepts.push({
      slug: 'quic-protocol',
      term: 'QUIC 协议',
      english: 'QUIC',
      aliases: [],
      field: '网络',
      groups: ['G01'],
      summary: '基于 UDP 的多路复用安全传输协议。',
      url: '/concepts/quic-protocol',
      related: [],
      links: [],
      backlinks: [],
      lectures: [],
      markdown: '# QUIC 协议\n\n减少建链时延并避免队头阻塞。',
    })
    writeFileSync(conceptsPath, JSON.stringify(parsed, null, 2), 'utf8')

    const reloaded = (await engine.execute(
      'search_concepts',
      { query: 'QUIC' },
      { readableTiers: ['public'], channel: 'internal' },
    )) as ConceptSearchHit[]
    expect(reloaded[0]?.slug).toBe('quic-protocol')
    expect(reloaded[0]?.match).toBe('english')
  })

  it('enforces AI_TOOL_MAX_RESULT_BYTES and AI_TOOL_TIMEOUT_MS caps', async () => {
    const logs: ToolCallLogLine[] = []
    const tmpDir = mkdtempSync(join(tmpdir(), 'k2-tools-cap-'))
    tempDirs.push(tmpDir)
    cpSync(FIXTURE_DIST, tmpDir, { recursive: true })

    const conceptsPath = join(tmpDir, 'tools/concepts.json')
    const parsed = JSON.parse(readFileSync(conceptsPath, 'utf8')) as { concepts: ConceptRecord[] }
    parsed.concepts[0]!.markdown = '长内容测试：'.repeat(300)
    writeFileSync(conceptsPath, JSON.stringify(parsed, null, 2), 'utf8')

    const engine = makeEngine({ distDir: tmpDir, maxResultBytes: 600, timeoutMs: 80, logs })
    const capped = (await engine.execute(
      'get_concept',
      { slug: 'tcp-handshake' },
      { readableTiers: ['public'], channel: 'internal', userId: 'alice' },
    )) as ConceptRecord
    expect(Buffer.byteLength(JSON.stringify(capped), 'utf8')).toBeLessThanOrEqual(600)
    expect(capped.markdown).toContain('...[truncated]')

    await expect(
      engine.execute(
        'get_concept',
        { slug: 'tcp-handshake' },
        { readableTiers: ['public'], channel: 'internal', userId: 'alice', testDelayMs: 200 },
      ),
    ).rejects.toThrow(ToolTimeoutError)
    expect(logs[logs.length - 1]).toMatchObject({ tool: 'get_concept', ok: false, bytes: 0 })
  })

  it('mints and verifies HMAC tool tickets, falling back to public tier on bad/expired/missing secret', () => {
    let clock = 1_763_800_000_000
    const secret = 'ticket-secret-unit-test'
    const ticket = mintToolTicket(secret, { tiers: ['public', 'staff'], uh: 'abc12345' }, () => clock)

    expect(verifyToolTicket(secret, ticket, () => clock)).toEqual({
      valid: true,
      tiers: ['public', 'staff'],
      uh: 'abc12345',
    })

    // Forged signature or tampered payload
    const [payloadB64, sigB64] = ticket.split('.')
    const flipped = `${payloadB64}.${sigB64!.slice(0, -1)}${sigB64!.endsWith('a') ? 'b' : 'a'}`
    expect(verifyToolTicket(secret, flipped, () => clock)).toEqual({ valid: false, tiers: ['public'], uh: null })
    expect(verifyToolTicket(null, ticket, () => clock)).toEqual({ valid: false, tiers: ['public'], uh: null })
    expect(verifyToolTicket(secret, 'not-a-ticket', () => clock)).toEqual({
      valid: false,
      tiers: ['public'],
      uh: null,
    })

    // Expired after 10 minutes
    clock += 10 * 60 * 1000 + 1
    expect(verifyToolTicket(secret, ticket, () => clock)).toEqual({ valid: false, tiers: ['public'], uh: null })
  })

  it('validates site/ai-tools.example.json (all servers disabled) and resolves ai-tools.json path', async () => {
    const examplePath = resolve(FIXTURE_DIST, '../../../../site/ai-tools.example.json')
    const rawExample = JSON.parse(readFileSync(examplePath, 'utf8')) as unknown
    const parsed = aiToolsFileSchema.parse(rawExample)
    expect(parsed.mcpServers.length).toBeGreaterThan(0)
    expect(parsed.mcpServers.every((s) => s.enabled === false)).toBe(true)

    const resolvedViaContent = await resolveAiToolsFilePath(null)
    expect(resolvedViaContent).toBeTruthy()
    expect(resolvedViaContent!).toMatch(/ai-tools\.json$/)

    const explicit = await resolveAiToolsFilePath('/tmp/custom-ai-tools.json')
    expect(explicit).toBe('/tmp/custom-ai-tools.json')
  })

  it('guards ExternalMcpManager against stale DB loads and mismatched in-flight connections on reload', async () => {
    const engine = makeEngine()
    const makeCfg = (url: string, enabled: boolean) => ({
      version: 1 as const,
      engineTools: {},
      mcpServers: [
        {
          id: 'srv1',
          name: 'Server 1',
          enabled,
          transport: 'http' as const,
          url,
          headerEnv: {},
          tools: { ping: { enabled: true } },
        },
      ],
    })

    let releaseOldConnect!: () => void
    const closedUrls: string[] = []
    const connectCalls: string[] = []

    const mgr = new ExternalMcpManager(
      { aiToolsFile: null, aiToolTimeoutMs: 5000 },
      engine,
      {
        createClient: async (srv) => {
          connectCalls.push(srv.url)
          if (srv.url === 'https://old.example.com/mcp') {
            await new Promise<void>((r) => {
              releaseOldConnect = r
            })
          }
          return {
            tools: async () => ({
              ping: {
                description: `ping from ${srv.url}`,
                parameters: {},
                execute: async () => ({ ok: true, from: srv.url }),
              },
            }),
            close: async () => {
              closedUrls.push(srv.url)
            },
          } as unknown as MCPClient
        },
      },
    )

    // 1. Stale DB load cannot overwrite a newer explicit config override
    let releaseStaleDb!: (cfg: ReturnType<typeof makeCfg> | null) => void
    mgr.setDbConfigLoader(
      () =>
        new Promise((resolve) => {
          releaseStaleDb = resolve
        }),
    )
    const pendingDbLoad = mgr.loadConfig()
    await mgr.applyConfigOverride(makeCfg('https://fresh.example.com/mcp', false))
    releaseStaleDb(makeCfg('https://old.example.com/mcp', true))
    const resolvedCfg = await pendingDbLoad
    expect(resolvedCfg.mcpServers[0]?.enabled).toBe(false)
    expect(resolvedCfg.mcpServers[0]?.url).toBe('https://fresh.example.com/mcp')

    // 2. Signature mismatch during in-flight connection waits & never leaks old client tools
    await mgr.applyConfigOverride(makeCfg('https://old.example.com/mcp', true))
    const oldToolsPromise = mgr.getEnabledSdkTools('u1', 'native')
    await new Promise((r) => setTimeout(r, 10))
    expect(connectCalls).toEqual(['https://old.example.com/mcp'])

    await mgr.applyConfigOverride(makeCfg('https://new.example.com/mcp', true))
    const newToolsPromise = mgr.getEnabledSdkTools('u1', 'native')
    releaseOldConnect()

    const [oldTools, newTools] = await Promise.all([oldToolsPromise, newToolsPromise])
    expect(Object.keys(oldTools)).toEqual([])
    expect(Object.keys(newTools)).toEqual(['ping'])
    expect(newTools.ping?.description).toBe('ping from https://new.example.com/mcp')
    expect(closedUrls).toContain('https://old.example.com/mcp')
    await mgr.closeAll()
  })
})
