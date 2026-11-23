import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'

const V1_PROMPTS_FILE = fileURLToPath(new URL('../fixtures/companion-v1.json', import.meta.url))
const FIXTURE_DIST = fileURLToPath(new URL('../fixtures/tools', import.meta.url))

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
    aiProvider: 'off',
    difyApiBase: 'https://api.dify.ai/v1',
    difyApiKey: null,
    openaiApiBase: 'https://api.openai.com/v1',
    openaiApiKey: null,
    openaiModel: 'gpt-4o-mini',
    aiUpstreamTimeoutMs: 5000,
    aiUploadMaxBytes: 1024 * 1024,
    aiAllowAnonymous: false,
    aiRatePerMinute: 10,
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
    ...overrides,
  }
}

describe('REST tools mirror POST /api/tools/:name integration (WP-K2 Item 4)', () => {
  let db: Db

  beforeAll(async () => {
    db = createDb('pglite:memory')
    await runMigrations(db)
  })

  afterAll(async () => {
    await db.close()
  })

  it('requires authentication, resolves tiers from session, handles 404 unknown tool and 400 invalid input without stack traces', async () => {
    const app = createApp(makeConfig(), db)

    const unauth = await app.request('/api/tools/search_concepts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'TCP' }),
    })
    expect(unauth.status).toBe(401)

    const unknown = await app.request('/api/tools/does_not_exist', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'TCP' }),
    })
    expect(unknown.status).toBe(404)

    const badInput = await app.request('/api/tools/get_concept_graph', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: '', depth: 9 }),
    })
    expect(badInput.status).toBe(400)
    const badText = await badInput.text()
    const badJson = JSON.parse(badText) as { error: string; issues: Array<{ path: string; message: string }> }
    expect(badJson.error).toBe('invalid_input')
    expect(badJson.issues.length).toBeGreaterThanOrEqual(2)
    expect(badText).not.toContain('at ')
    expect(badText).not.toContain('stack')

    // Student sees public only, not staff lecture
    const pubLectureSearch = await app.request('/api/tools/search_lectures', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Remote-Groups': 'students', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '99123' }),
    })
    expect(pubLectureSearch.status).toBe(200)
    expect(await pubLectureSearch.json()).toEqual([])

    // Staff sees staff lecture
    const staffLectureSearch = await app.request('/api/tools/search_lectures', {
      method: 'POST',
      headers: { 'Remote-User': 'prof', 'Remote-Groups': 'staff', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '99123' }),
    })
    expect(staffLectureSearch.status).toBe(200)
    const staffHits = (await staffLectureSearch.json()) as Array<{ id: string }>
    expect(staffHits[0]?.id).toBe('STF-L99')
  })

  it('enforces per-user rate limit (429 with Retry-After) without sharing across users', async () => {
    const app = createApp(makeConfig({ aiRatePerMinute: 2 }), db)

    for (let i = 0; i < 2; i++) {
      const ok = await app.request('/api/tools/search_concepts', {
        method: 'POST',
        headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'TCP' }),
      })
      expect(ok.status).toBe(200)
    }

    const limited = await app.request('/api/tools/search_concepts', {
      method: 'POST',
      headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'TCP' }),
    })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await limited.json()).toMatchObject({ error: 'rate_limited', limit: 'rate' })

    const bob = await app.request('/api/tools/search_concepts', {
      method: 'POST',
      headers: { 'Remote-User': 'bob', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'TCP' }),
    })
    expect(bob.status).toBe(200)
  })

  it('GET /api/tools requires auth, returns maxSteps + JSON Schema parameters, omits disabled tools, and shares toolsLimiter', async () => {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')

    const app = createApp(makeConfig({ aiToolMaxSteps: 4 }), db)
    const unauth = await app.request('/api/tools', { method: 'GET' })
    expect(unauth.status).toBe(401)

    const okRes = await app.request('/api/tools', {
      method: 'GET',
      headers: { 'Remote-User': 'alice', 'Remote-Groups': 'students' },
    })
    expect(okRes.status).toBe(200)
    const body = (await okRes.json()) as {
      maxSteps: number
      tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    }
    expect(body.maxSteps).toBe(4)
    expect(body.tools.map((t) => t.name)).toEqual([
      'search_concepts',
      'get_concept',
      'get_concept_graph',
      'search_lectures',
      'get_lecture_summary',
    ])
    for (const tool of body.tools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.parameters).toMatchObject({ type: 'object', properties: expect.any(Object) })
    }

    // Disabled tool is omitted from GET /api/tools
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'k3-tools-cfg-'))
    try {
      const cfgPath = path.join(tmpDir, 'ai-tools.json')
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          engineTools: {
            get_concept_graph: { enabled: false },
          },
          externalMcpServers: [],
        }),
        'utf8',
      )
      const filteredApp = createApp(makeConfig({ aiToolsFile: cfgPath, aiRatePerMinute: 2 }), db)
      const filteredRes = await filteredApp.request('/api/tools', {
        method: 'GET',
        headers: { 'Remote-User': 'alice' },
      })
      expect(filteredRes.status).toBe(200)
      const filteredBody = (await filteredRes.json()) as { tools: Array<{ name: string }> }
      expect(filteredBody.tools.map((t) => t.name)).not.toContain('get_concept_graph')
      expect(filteredBody.tools.length).toBe(4)

      // Shares toolsLimiter with POST /api/tools/:name (1 GET + 1 POST = 2, 3rd hits 429)
      const post2 = await filteredApp.request('/api/tools/search_concepts', {
        method: 'POST',
        headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'TCP' }),
      })
      expect(post2.status).toBe(200)
      const get3 = await filteredApp.request('/api/tools', {
        method: 'GET',
        headers: { 'Remote-User': 'alice' },
      })
      expect(get3.status).toBe(429)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
