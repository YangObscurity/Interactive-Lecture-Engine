import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createMCPClient } from '@ai-sdk/mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import { mintToolTicket, verifyToolTicket } from '../../src/tools/ticket.js'

const V1_PROMPTS_FILE = fileURLToPath(new URL('../fixtures/companion-v1.json', import.meta.url))
const FIXTURE_DIST = fileURLToPath(new URL('../fixtures/tools', import.meta.url))

const MCP_TOKEN = 'mcp-bearer-secret-999'
const TICKET_SECRET = 'mcp-ticket-hmac-secret-777'

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
    aiProvider: 'dify',
    difyApiBase: 'http://127.0.0.1:1',
    difyApiKey: 'dify-key',
    openaiApiBase: 'https://api.openai.com/v1',
    openaiApiKey: null,
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
    aiMcpToken: MCP_TOKEN,
    aiMcpTicketSecret: TICKET_SECRET,
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

function parseRpcPayload(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as Record<string, unknown>
  }
  const dataLine = trimmed
    .split('\n')
    .find((l) => l.startsWith('data:'))
  if (!dataLine) {
    throw new Error(`Unexpected MCP response body: ${raw}`)
  }
  return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
}

describe('Stateless MCP endpoint & Dify tool_ticket integration (WP-K2 Item 3)', () => {
  let db: Db
  let mockDifyServer: Server
  let mockDifyBase = ''
  let lastDifyBody: Record<string, unknown> | null = null
  let clock = 1_763_800_000_000

  beforeAll(async () => {
    db = createDb('pglite:memory')
    await runMigrations(db)

    await new Promise<void>((resolveListen) => {
      mockDifyServer = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          lastDifyBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write('data: {"event":"agent_message","conversation_id":"c1","answer":"ok"}\n\n')
          res.end('data: {"event":"message_end"}\n\n')
        })
      })
      mockDifyServer.listen(0, '127.0.0.1', () => {
        const addr = mockDifyServer.address() as AddressInfo
        mockDifyBase = `http://127.0.0.1:${addr.port}`
        resolveListen()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolveClose) => mockDifyServer.close(() => resolveClose()))
    await db.close()
  })

  it('disables /api/mcp when AI_MCP_TOKEN is unset and rejects bad/missing bearer tokens with 401', async () => {
    const disabledApp = createApp(makeConfig({ aiMcpToken: null }), db, { now: () => clock })
    const disabledRes = await disabledApp.request('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MCP_TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(disabledRes.status).toBe(503)

    const app = createApp(makeConfig(), db, { now: () => clock })
    const noAuth = await app.request('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(noAuth.status).toBe(401)

    const wrongAuth = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(wrongAuth.status).toBe(401)
  })

  it('serves 2025-11-25 initialize handshake clients, enforces required ticket, and blocks staff data on bad/expired tickets', async () => {
    const app = createApp(makeConfig(), db, { now: () => clock })

    const postMcp = (body: Record<string, unknown>) =>
      app.request('http://docs.example.com/api/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${MCP_TOKEN}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      })

    // 1. 2025-11-25 initialize handshake
    const initRes = await postMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'dify-legacy', version: '1.6.0' },
      },
    })
    expect(initRes.status).toBe(200)
    const initRpc = parseRpcPayload(await initRes.text()) as { result: { protocolVersion: string } }
    expect(initRpc.result.protocolVersion).toBe('2025-11-25')

    // 2. tools/list returns all 5 tools with required `ticket`
    const listRes = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    expect(listRes.status).toBe(200)
    const listRpc = parseRpcPayload(await listRes.text()) as {
      result: { tools: Array<{ name: string; inputSchema: { required?: string[] } }> }
    }
    const toolNames = listRpc.result.tools.map((t) => t.name)
    expect(toolNames).toEqual([
      'search_concepts',
      'get_concept',
      'get_concept_graph',
      'search_lectures',
      'get_lecture_summary',
    ])
    for (const t of listRpc.result.tools) {
      expect(t.inputSchema.required).toContain('ticket')
    }

    // 3. Valid staff ticket returns staff-tier concept and lecture
    const staffTicket = mintToolTicket(TICKET_SECRET, { tiers: ['public', 'staff'], uh: 'u_staff' }, () => clock)
    const staffCall = await postMcp({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_concept', arguments: { slug: 'staff-secret-algo', ticket: staffTicket } },
    })
    expect(staffCall.status).toBe(200)
    const staffRpc = parseRpcPayload(await staffCall.text()) as { result: { content: Array<{ text: string }> } }
    expect(JSON.parse(staffRpc.result.content[0]!.text)).toMatchObject({ slug: 'staff-secret-algo' })

    // 4. Forged / empty / expired ticket falls back strictly to public tier
    const forgedCall = await postMcp({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'search_lectures',
        arguments: { query: '99123', ticket: 'forged.signature' },
      },
    })
    expect(forgedCall.status).toBe(200)
    const forgedRpc = parseRpcPayload(await forgedCall.text()) as { result: { content: Array<{ text: string }> } }
    expect(JSON.parse(forgedRpc.result.content[0]!.text)).toEqual([])

    const emptyTicketCall = await postMcp({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_concept', arguments: { slug: 'staff-secret-algo', ticket: '' } },
    })
    const emptyRpc = parseRpcPayload(await emptyTicketCall.text()) as { result: { content: Array<{ text: string }> } }
    expect(JSON.parse(emptyRpc.result.content[0]!.text)).toEqual({ error: 'not_found', slug: 'staff-secret-algo' })

    // Expire the valid ticket (> 10 minutes)
    clock += 10 * 60 * 1000 + 5
    const expiredCall = await postMcp({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'get_concept', arguments: { slug: 'staff-secret-algo', ticket: staffTicket } },
    })
    const expiredRpc = parseRpcPayload(await expiredCall.text()) as { result: { content: Array<{ text: string }> } }
    expect(JSON.parse(expiredRpc.result.content[0]!.text)).toEqual({ error: 'not_found', slug: 'staff-secret-algo' })
  })

  it('a tool switched off in ai-tools.json answers tool_disabled on /api/mcp too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'k2-mcp-off-'))
    try {
      const toolsFile = join(dir, 'ai-tools.json')
      writeFileSync(
        toolsFile,
        JSON.stringify({ version: 1, engineTools: { get_concept: { enabled: false } }, mcpServers: [] }),
      )
      const app = createApp(makeConfig({ aiToolsFile: toolsFile }), db, { now: () => clock })
      const ticket = mintToolTicket(TICKET_SECRET, { tiers: ['public'], uh: 'u1' }, () => clock)
      const call = async (name: string, args: Record<string, unknown>) => {
        const res = await app.request('http://docs.example.com/api/mcp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${MCP_TOKEN}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: { ...args, ticket } } }),
        })
        expect(res.status).toBe(200)
        return parseRpcPayload(await res.text()) as { result: { isError?: boolean; content: Array<{ text: string }> } }
      }
      const off = await call('get_concept', { slug: 'tcp-handshake' })
      expect(off.result.isError).toBe(true)
      expect(off.result.content[0]?.text).toContain('tool_disabled')
      const on = await call('search_concepts', { query: 'TCP' })
      expect(on.result.isError).toBeFalsy()
      expect(on.result.content[0]?.text).toContain('tcp-handshake')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves v2 Streamable HTTP MCP clients (@ai-sdk/mcp createMCPClient) and injects/strips tool_ticket on Dify chat', async () => {
    const app = createApp(makeConfig({ difyApiBase: mockDifyBase }), db, { now: () => clock })

    // 1. Dify chat path strips client-provided tool_ticket and mints fresh HMAC ticket for caller tiers
    const fakeTicket = mintToolTicket(TICKET_SECRET, { tiers: ['public', 'staff'], uh: 'evil' }, () => clock)
    const pubChat = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Remote-User': 'student1',
        'Remote-Groups': 'students',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: '请介绍三次握手',
        inputs: {
          current_lecture: 'g01-L01',
          tool_ticket: fakeTicket,
        },
      }),
    })
    expect(pubChat.status).toBe(200)
    await pubChat.text()
    const pubInputs = lastDifyBody?.['inputs'] as Record<string, string>
    expect(pubInputs['tool_ticket']).toBeTruthy()
    expect(pubInputs['tool_ticket']).not.toBe(fakeTicket)
    expect(verifyToolTicket(TICKET_SECRET, pubInputs['tool_ticket'], () => clock)).toMatchObject({
      valid: true,
      tiers: ['public'],
    })

    const staffChat = await app.request('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Remote-User': 'prof1',
        'Remote-Groups': 'staff',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: '检查教研内部策略',
        inputs: { current_lecture: 'L99' },
      }),
    })
    expect(staffChat.status).toBe(200)
    await staffChat.text()
    const staffInputs = lastDifyBody?.['inputs'] as Record<string, string>
    const verifiedStaff = verifyToolTicket(TICKET_SECRET, staffInputs['tool_ticket'], () => clock)
    expect(verifiedStaff).toMatchObject({
      valid: true,
      tiers: ['public', 'staff'],
    })

    // 2. Modern v2 MCP client using @ai-sdk/mcp HTTP transport connected to Hono app
    const mcpClient = await createMCPClient({
      transport: {
        type: 'http',
        url: 'http://docs.example.com/api/mcp',
        headers: { Authorization: `Bearer ${MCP_TOKEN}` },
        fetch: async (input, init) => app.request(input instanceof Request ? input : new Request(input, init)),
      },
    })

    try {
      const toolSet = await mcpClient.tools()
      expect(Object.keys(toolSet).sort()).toEqual([
        'get_concept',
        'get_concept_graph',
        'get_lecture_summary',
        'search_concepts',
        'search_lectures',
      ])

      const execFn = toolSet['search_concepts']!.execute!
      const rawOut = (await execFn({ query: 'TCP 三次握手', ticket: staffInputs['tool_ticket'] }, {
        toolCallId: 'v2_c1',
        messages: [],
        context: {},
      })) as { content: Array<{ text: string }> }
      expect(JSON.parse(rawOut.content[0]!.text)[0]).toMatchObject({
        slug: 'tcp-handshake',
        match: 'exact',
      })
    } finally {
      await mcpClient.close()
    }
  })
})
