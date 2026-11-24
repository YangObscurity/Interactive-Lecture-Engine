import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import { SERVICE_NAME, SERVICE_VERSION } from '../../src/routes/health.js'

function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: 'pglite:memory',
    databaseUrlDirect: null,
    host: '127.0.0.1',
    port: 8100,
    authAdapter: 'none',
    authHeaderPreset: 'authelia',
    authHeaderUser: 'Remote-User',
    authHeaderGroups: 'Remote-Groups',
    authHeaderEmail: 'Remote-Email',
    authHeaderName: 'Remote-Name',
    authGroupSeparator: ',',
    authRoleMap: {},
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
    aiUpstreamTimeoutMs: 60000,
    aiUploadMaxBytes: 52428800,
    aiAllowAnonymous: false,
    aiRatePerMinute: 20,
    aiMaxConcurrent: 2,
    aiDailyLimit: 300,
    writeRatePerMinute: 120,
    aiQueryMaxBytes: 8192,
    aiInputsMaxBytes: 32768,
    aiStreamMaxMs: 300000,
    aiAccessLog: false,
    aiPromptsFile: null,
    siteDistDir: null,
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
    ...overrides,
  }
}

describe('GET /api/health integration tests', () => {
  let db: Db

  beforeAll(async () => {
    db = await createDb('pglite:memory')
    await runMigrations(db)
  })

  afterAll(async () => {
    await db.close()
  })

  it('returns 200 ok when db is healthy and no notion probe configured', async () => {
    const config = makeTestConfig()
    const app = createApp(config, db)

    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('date')).toBeTruthy()
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      checks: {
        db: 'ok',
        ai: 'off',
        notion: 'off',
      },
      time: expect.any(String),
    })
    expect(Number.isNaN(Date.parse(body.time))).toBe(false)
  })

  it('reports checks.db = down and ok = false if pending migrations exist', async () => {
    // Fresh DB without migrations applied
    const emptyDb = await createDb('pglite:memory')
    try {
      const config = makeTestConfig()
      const app = createApp(config, emptyDb)

      const res = await app.request('/api/health')
      expect(res.status).toBe(200)

      const body = await res.json()
      expect(body.ok).toBe(false)
      expect(body.checks.db).toBe('down')
      expect(body.checks.ai).toBe('off')
      expect(body.checks.notion).toBe('off')
    } finally {
      await emptyDb.close()
    }
  })

  it('reports checks.db = degraded and ok = true when db response exceeds 1500ms', async () => {
    const config = makeTestConfig()
    const slowDb: Db = {
      kind: 'pglite',
      async query<T = unknown>(sql: string, params?: readonly unknown[]) {
        if (sql === 'SELECT 1') {
          // Simulate slow query
          await new Promise((r) => setTimeout(r, 1550))
        }
        return db.query<T>(sql, params ? [...params] : undefined)
      },
      exec(sql: string) {
        return db.exec(sql)
      },
      tx(fn) {
        return db.tx(fn)
      },
      close() {
        return Promise.resolve()
      },
    }

    const app = createApp(config, slowDb)
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.checks.db).toBe('degraded')
    expect(body.ok).toBe(true) // degraded does not fail overall health check
  }, 10000)

  it('probes notion health url when configured: 200 ok', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      return new Response('{"status":"ok"}', { status: 200 })
    })

    const config = makeTestConfig({ notionHealthUrl: 'http://notion-mock.internal/health' })
    const app = createApp(config, db)

    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.checks.notion).toBe('ok')
    expect(body.ok).toBe(true)

    fetchMock.mockRestore()
  })

  it('probes notion health url when configured: error -> down and ok = false', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      return new Response('{"error":"fail"}', { status: 500 })
    })

    const config = makeTestConfig({ notionHealthUrl: 'http://notion-mock.internal/health' })
    const app = createApp(config, db)

    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.checks.notion).toBe('down')
    expect(body.ok).toBe(false)

    fetchMock.mockRestore()
  })

  it('probes notion health url timeout -> down and ok = false', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      throw new Error('Connection timeout')
    })

    const config = makeTestConfig({ notionHealthUrl: 'http://notion-mock.internal/health' })
    const app = createApp(config, db)

    const res = await app.request('/api/health')
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.checks.notion).toBe('down')
    expect(body.ok).toBe(false)

    fetchMock.mockRestore()
  })
})
