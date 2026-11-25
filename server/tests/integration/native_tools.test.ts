import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createMcpHonoApp } from '@modelcontextprotocol/hono'
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import type { Context } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeAppResources, createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'

const V1_PROMPTS_FILE = fileURLToPath(new URL('../fixtures/companion-v1.json', import.meta.url))
const FIXTURE_DIST = fileURLToPath(new URL('../fixtures/tools', import.meta.url))

const USAGE_OK: LanguageModelV4Usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: 'pglite:memory',
    databaseUrlDirect: null,
    host: '127.0.0.1',
    port: 8100,
    authAdapter: 'trusted-header',
    authHeaderPreset: 'authelia',
    authHeaderUser: 'Remote-User',
    authHeaderGroups: 'Remote-Groups',
    authHeaderEmail: 'Remote-Email',
    authHeaderName: 'Remote-Name',
    authGroupSeparator: ',',
    authRoleMap: { admins: ['admin'], staff: ['author'] },
    logoutUrl: null,
    dbAutoMigrate: false,
    notionHealthUrl: null,
    allowNonLoopback: false,
    logLevel: 'info',
    aiProvider: 'openai',
    difyApiBase: 'https://api.dify.ai/v1',
    difyApiKey: null,
    openaiApiBase: 'https://api.openai.com/v1',
    openaiApiKey: 'test-openai-key',
    openaiModel: 'gpt-4o-mini',
    aiUpstreamTimeoutMs: 5000,
    aiUploadMaxBytes: 1024 * 1024,
    aiAllowAnonymous: false,
    aiRatePerMinute: 100,
    aiMaxConcurrent: 10,
    aiDailyLimit: 1000,
    writeRatePerMinute: 6000,
    aiQueryMaxBytes: 8192,
    aiInputsMaxBytes: 32768,
    aiStreamMaxMs: 30000,
    aiAccessLog: false,
    aiPromptsFile: V1_PROMPTS_FILE,
    siteDistDir: FIXTURE_DIST,
    aiToolsFile: null,
    aiToolTimeoutMs: 8000,
    aiToolMaxResultBytes: 24000,
    aiToolMaxSteps: 5,
    aiMcpToken: null,
    aiMcpTicketSecret: null,
    authCookieName: 'lec_session',
    authCookieSecure: 'auto',
    sessionTtlHours: 12,
    rememberMeDays: 30,
    authMethodsEnabled: 'password,passkey,gateway',
    webauthnRpId: '',
    webauthnRpName: 'Interactive Lecture Engine',
    webauthnOrigin: '',
    authBootstrapToken: null,
    ...overrides,
  }
}

describe('Native AI SDK v7 channel & External MCP integration (WP-K2 Items 2 & 5)', () => {
  let db: Db
  let extMcpServer: Server
  let extMcpUrl = ''
  let lastExtAuthHeader = ''
  let extSlowMs = 0
  let suiteContentDir = ''
  const prevContentDir = process.env['CONTENT_DIR']
  const tempDirs: string[] = []
  const appsToClose: Array<ReturnType<typeof createApp>> = []

  beforeAll(async () => {
    suiteContentDir = mkdtempSync(join(tmpdir(), 'k2-content-'))
    process.env['CONTENT_DIR'] = suiteContentDir
    db = createDb('pglite:memory')
    await runMigrations(db)

    const mcpApp = createMcpHonoApp({ host: 'proxy' })
    mcpApp.use('*', async (c, next) => {
      lastExtAuthHeader = c.req.header('authorization') ?? ''
      if (lastExtAuthHeader !== 'Bearer ext-secret-token-xyz') {
        return c.json({ error: 'unauthorized' }, 401)
      }
      return await next()
    })

    const handler = createMcpHandler(
      () => {
        const s = new McpServer({ name: 'ext-docs', version: '1.0.0' })
        s.registerTool(
          'ext_lookup',
          {
            description: 'External enabled lookup tool',
            inputSchema: z.object({ topic: z.string() }),
          },
          async ({ topic }) => {
            if (extSlowMs > 0) {
              await new Promise((r) => setTimeout(r, extSlowMs))
            }
            return {
              content: [{ type: 'text' as const, text: `external-doc-for:${topic}` }],
            }
          },
        )
        s.registerTool(
          'ext_disabled_tool',
          {
            description: 'External tool that stays disabled by config',
            inputSchema: z.object({ q: z.string() }),
          },
          async ({ q }) => ({
            content: [{ type: 'text' as const, text: `should-never-run:${q}` }],
          }),
        )
        return s
      },
      { legacy: 'stateless', responseMode: 'auto' },
    )
    mcpApp.all('/', (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }))
    mcpApp.all('*', (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }))

    extMcpServer = serve({
      fetch: mcpApp.fetch,
      hostname: '127.0.0.1',
      port: 0,
    }) as Server
    await new Promise<void>((resolveListen) => {
      if (extMcpServer.listening) {
        resolveListen()
      } else {
        extMcpServer.once('listening', () => resolveListen())
      }
    })
    const addr = extMcpServer.address() as AddressInfo
    extMcpUrl = `http://127.0.0.1:${addr.port}/mcp`
  })

  afterEach(async () => {
    extSlowMs = 0
    delete process.env['TEST_EXT_MCP_AUTH']
    for (const app of appsToClose.splice(0)) {
      await closeAppResources(app)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolveClose) => extMcpServer.close(() => resolveClose()))
    await db.close()
    if (prevContentDir !== undefined) {
      process.env['CONTENT_DIR'] = prevContentDir
    } else {
      delete process.env['CONTENT_DIR']
    }
    if (suiteContentDir) {
      rmSync(suiteContentDir, { recursive: true, force: true })
    }
  })

  function writeTempAiTools(content: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'k2-ai-tools-'))
    tempDirs.push(dir)
    const p = join(dir, 'ai-tools.json')
    writeFileSync(p, JSON.stringify(content, null, 2), 'utf8')
    return p
  }

  function makeChunkStream(chunks: LanguageModelV4StreamPart[]) {
    return {
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [{ type: 'stream-start', warnings: [] }, ...chunks],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }
  }

  it('streams plain text cleanly and keeps prompt assembly identical with MockLanguageModelV4', async () => {
    const mockModel = new MockLanguageModelV4({
      doStream: async () =>
        makeChunkStream([
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Hello ' },
          { type: 'text-delta', id: 't1', delta: 'world!' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE_OK },
        ]),
    })

    const app = createApp(makeConfig(), db, { modelFactory: () => mockModel })
    appsToClose.push(app)

    const res = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'summarize',
        lang: 'en',
        inputs: { current_lecture: 'L01', group: 'G01', outline: 'TCP Handshake' },
      }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"event":"agent_message"')
    expect(text).toContain('"answer":"Hello "')
    expect(text).toContain('"answer":"world!"')
    expect(text).toContain('"event":"message_end"')
    expect(text).toContain('"total_tokens":15')
    expect(text).not.toContain('"event":"tool_call"')

    expect(mockModel.doStreamCalls).toHaveLength(1)
    const promptSent = mockModel.doStreamCalls[0]!.prompt
    expect(promptSent[0]).toMatchObject({ role: 'system' })
    expect(String(promptSent[0]?.content)).toContain('technical reading companion')
  })

  it('runs a multi-step tool call round trip, emits tool_call events without args/results, and isolates tiers', async () => {
    let step = 0
    const mockModel = new MockLanguageModelV4({
      doStream: async () => {
        step++
        if (step === 1) {
          return makeChunkStream([
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'search_concepts',
              input: JSON.stringify({ query: '三次握手' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE_OK },
          ])
        }
        return makeChunkStream([
          { type: 'text-start', id: 't2' },
          { type: 'text-delta', id: 't2', delta: '查到了 TCP 三次握手。' },
          { type: 'text-end', id: 't2' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE_OK },
        ])
      },
    })

    const app = createApp(makeConfig(), db, { modelFactory: () => mockModel })
    appsToClose.push(app)

    const res = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '解释三次握手' }),
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(mockModel.doStreamCalls).toHaveLength(2)

    // Tool result in step 2 prompt includes public concept
    const secondCallJson = JSON.stringify(mockModel.doStreamCalls[1]!.prompt)
    expect(secondCallJson).toContain('tcp-handshake')

    // SSE has tool_call start & end with ok + ms, and NO arguments/results
    expect(body).toContain('"event":"tool_call","name":"search_concepts","state":"start"')
    expect(body).toMatch(/"event":"tool_call","name":"search_concepts","state":"end","ok":true,"ms":\d+/)
    expect(body).not.toContain('tcp-handshake')
    expect(body).not.toContain('SYN/ACK')
    expect(body).toContain('查到了 TCP 三次握手。')
    expect(body).toContain('"event":"message_end"')
  })

  it('enforces AI_TOOL_MAX_STEPS step cap cleanly', async () => {
    const mockModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const stepNo = prompt.length
        return makeChunkStream([
          {
            type: 'tool-call',
            toolCallId: `loop_${stepNo}`,
            toolName: 'search_concepts',
            input: JSON.stringify({ query: 'TCP' }),
          },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE_OK },
        ])
      },
    })

    const app = createApp(makeConfig({ aiToolMaxSteps: 2 }), db, { modelFactory: () => mockModel })
    appsToClose.push(app)

    const res = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '无限调用' }),
    })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(mockModel.doStreamCalls).toHaveLength(2)
    expect(text).toContain('"event":"message_end"')
  })

  it('connects enabled external MCP server with env headers, omits disabled tools, handles tool timeout, and skips unreachable servers', async () => {
    process.env['TEST_EXT_MCP_AUTH'] = 'Bearer ext-secret-token-xyz'
    const aiToolsPath = writeTempAiTools({
      version: 1,
      engineTools: {
        search_concepts: { enabled: true },
        get_concept: { enabled: true },
        get_concept_graph: { enabled: true },
        search_lectures: { enabled: true },
        get_lecture_summary: { enabled: true },
      },
      mcpServers: [
        {
          id: 'ext-docs',
          name: 'Docs MCP',
          url: extMcpUrl,
          headerEnv: { Authorization: 'TEST_EXT_MCP_AUTH' },
          enabled: true,
          tools: {
            ext_lookup: { enabled: true },
            ext_disabled_tool: { enabled: false },
          },
          timeoutMs: 120,
        },
        {
          id: 'dead-mcp',
          name: 'Dead MCP',
          url: 'http://127.0.0.1:1/unreachable-mcp',
          headerEnv: {},
          enabled: true,
          tools: { whatever: { enabled: true } },
          timeoutMs: 150,
        },
      ],
    })

    let turn = 0
    const mockModel = new MockLanguageModelV4({
      doStream: async () => {
        turn++
        if (turn === 1) {
          return makeChunkStream([
            {
              type: 'tool-call',
              toolCallId: 'ext_1',
              toolName: 'ext_lookup',
              input: JSON.stringify({ topic: 'bbr' }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE_OK },
          ])
        }
        return makeChunkStream([
          { type: 'text-start', id: 't_ext' },
          { type: 'text-delta', id: 't_ext', delta: '外部结果已使用。' },
          { type: 'text-end', id: 't_ext' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE_OK },
        ])
      },
    })

    const app = createApp(makeConfig({ aiToolsFile: aiToolsPath, aiToolTimeoutMs: 120 }), db, {
      modelFactory: () => mockModel,
    })
    appsToClose.push(app)

    // 1. Enabled external tool executes and disabled external tool is NOT offered to model
    const res1 = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '查 bbr' }),
    })
    expect(res1.status).toBe(200)
    const sse1 = await res1.text()
    expect(lastExtAuthHeader).toBe('Bearer ext-secret-token-xyz')
    expect(sse1).toContain('"event":"tool_call","name":"ext_lookup","state":"start"')
    expect(sse1).toMatch(/"event":"tool_call","name":"ext_lookup","state":"end","ok":true,"ms":\d+/)
    expect(sse1).toContain('外部结果已使用。')

    const offeredTools = mockModel.doStreamCalls[0]!.tools?.map((t) => t.name) ?? []
    expect(offeredTools).toContain('ext_lookup')
    expect(offeredTools).toContain('search_concepts')
    expect(offeredTools).not.toContain('ext_disabled_tool')
    expect(JSON.stringify(mockModel.doStreamCalls[1]!.prompt)).toContain('external-doc-for:bbr')

    // 2. Slow external tool hits timeout cleanly and reports ok:false in tool_call SSE event
    turn = 0
    extSlowMs = 300
    const res2 = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '超时测试' }),
    })
    expect(res2.status).toBe(200)
    const sse2 = await res2.text()
    expect(sse2).toMatch(/"event":"tool_call","name":"ext_lookup","state":"end","ok":false,"ms":\d+/)
    expect(sse2).toContain('"event":"message_end"')

    // 3. Admin endpoint GET /api/admin/ai-tools enforces admin and returns sanitized status + 7d counts
    const nonAdmin = await app.request('/api/admin/ai-tools', {
      headers: { 'Remote-User': 'alice', 'Remote-Groups': 'students' },
    })
    expect(nonAdmin.status).toBe(403)

    const adminRes = await app.request('/api/admin/ai-tools', {
      headers: { 'Remote-User': 'rootadmin', 'Remote-Groups': 'admins' },
    })
    expect(adminRes.status).toBe(200)
    const adminBody = (await adminRes.json()) as {
      mcpEndpoint: { enabled: boolean; path: string }
      engineTools: Array<{ name: string; enabled: boolean; calls7d: number; errors7d: number }>
      mcpServers: Array<{
        id: string
        name: string
        host: string
        enabled: boolean
        connectionState: string
        tools: Array<{ name: string; enabled: boolean; calls7d: number; errors7d: number }>
      }>
      settings?: {
        provider: string
        maxSteps: number
        timeoutMs: number
        maxResultBytes: number
        mcpTokenSet: boolean
        ticketSecretSet: boolean
        source: string
      }
      statsSource: string
      toolCallCounts7d: Record<string, { calls: number; errors: number; totalMs: number }>
    }

    expect(adminBody.statsSource).toBe('memory')
    expect(adminBody.mcpEndpoint).toEqual({ enabled: false, path: '/api/mcp' })
    expect(adminBody.settings?.maxSteps).toBe(5)
    expect(adminBody.settings?.timeoutMs).toBe(120)
    expect(adminBody.engineTools.map((t) => t.name)).toContain('search_concepts')

    const docsStatus = adminBody.mcpServers.find((s) => s.id === 'ext-docs')!
    expect(docsStatus.host).toBe(new URL(extMcpUrl).host)
    expect(JSON.stringify(docsStatus)).not.toContain('/mcp')
    expect(JSON.stringify(adminBody)).not.toContain('ext-secret-token-xyz')
    expect(docsStatus.connectionState).toBe('connected')
    expect(docsStatus.tools).toEqual([
      { name: 'ext_disabled_tool', enabled: false, calls7d: 0, errors7d: 0 },
      { name: 'ext_lookup', enabled: true, calls7d: 2, errors7d: 1 },
    ])

    const deadStatus = adminBody.mcpServers.find((s) => s.id === 'dead-mcp')!
    expect(deadStatus.connectionState).toBe('error')

    // 4. PUT /api/admin/ai-tools validates & persists switches without exposing or clobbering secret URLs
    const putBad = await app.request('/api/admin/ai-tools', {
      method: 'PUT',
      headers: { 'Remote-User': 'rootadmin', 'Remote-Groups': 'admins', 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: { nonexistent_tool: true } }),
    })
    expect(putBad.status).toBe(400)

    const putOk = await app.request('/api/admin/ai-tools', {
      method: 'PUT',
      headers: { 'Remote-User': 'rootadmin', 'Remote-Groups': 'admins', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine: { search_concepts: false },
        servers: [{ id: 'ext-docs', enabled: true, tools: { ext_disabled_tool: true } }],
      }),
    })
    expect(putOk.status).toBe(200)
    const putBody = (await putOk.json()) as {
      ok: boolean
      engineTools: Array<{ name: string; enabled: boolean }>
      mcpServers: Array<{ id: string; tools: Array<{ name: string; enabled: boolean }> }>
    }
    expect(putBody.ok).toBe(true)
    expect(putBody.engineTools.find((t) => t.name === 'search_concepts')?.enabled).toBe(false)
    expect(
      putBody.mcpServers
        .find((s) => s.id === 'ext-docs')
        ?.tools.find((tl) => tl.name === 'ext_disabled_tool')?.enabled,
    ).toBe(true)
    // Verify hidden URL/path was NOT overwritten when toggling switch
    expect(JSON.stringify(putBody.mcpServers)).not.toContain('/mcp')

    // 5. Disabling the server reports effective tools[].enabled=false while preserving configuredTools flags
    const disableSrvRes = await app.request('/api/admin/ai-tools', {
      method: 'PUT',
      headers: { 'Remote-User': 'rootadmin', 'Remote-Groups': 'admins', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        servers: [{ id: 'ext-docs', enabled: false }],
      }),
    })
    expect(disableSrvRes.status).toBe(200)
    const disabledBody = (await disableSrvRes.json()) as {
      mcpServers: Array<{
        id: string
        enabled: boolean
        configuredTools?: Record<string, boolean>
        tools: Array<{ name: string; enabled: boolean }>
      }>
    }
    const disabledDocs = disabledBody.mcpServers.find((s) => s.id === 'ext-docs')!
    expect(disabledDocs.enabled).toBe(false)
    expect(disabledDocs.tools.every((tl) => tl.enabled === false)).toBe(true)
    expect(disabledDocs.configuredTools).toEqual({
      ext_disabled_tool: true,
      ext_lookup: true,
    })
  })
})
