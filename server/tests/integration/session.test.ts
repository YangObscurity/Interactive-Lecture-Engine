import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'

function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    authRoleMap: {
      admins: ['admin'],
      staff: ['author'],
    },
    logoutUrl: 'https://auth.example.com/logout',
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
    ...overrides,
  }
}

describe('Session & Route Tier Guards Integration Tests', () => {
  let db: Db

  beforeAll(async () => {
    db = await createDb('pglite:memory')
    await runMigrations(db)
  })

  afterAll(async () => {
    await db.close()
  })

  describe('GET /api/auth/session', () => {
    it('returns anonymous session under AUTH_ADAPTER=none', async () => {
      const config = makeTestConfig({ authAdapter: 'none' })
      const app = createApp(config, db)

      const res = await app.request('/api/auth/session')
      expect(res.status).toBe(200)
      expect(res.headers.get('date')).toBeTruthy()
      expect(res.headers.get('cache-control')).toBe('no-store')

      const body = await res.json()
      expect(body).toEqual({
        authenticated: false,
        user: null,
        roles: ['reader'],
        groups: [],
        logoutUrl: null,
      })
    })

    it('returns anonymous session under trusted-header when headers absent', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const res = await app.request('/api/auth/session')
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.authenticated).toBe(false)
      expect(body.user).toBeNull()
      expect(body.roles).toEqual(['reader'])
      expect(body.groups).toEqual([])
      expect(body.logoutUrl).toBeNull()
    })

    it('returns authenticated session when trusted headers are provided', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const res = await app.request('/api/auth/session', {
        headers: {
          'Remote-User': 'alice',
          'Remote-Groups': 'admins, staff',
          'Remote-Email': 'alice@example.com',
          'Remote-Name': 'Alice Smith',
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({
        authenticated: true,
        user: {
          id: 'alice',
          name: 'Alice Smith',
          email: 'alice@example.com',
        },
        roles: ['reader', 'admin', 'author'],
        groups: ['admins', 'staff'],
        logoutUrl: 'https://auth.example.com/logout',
      })
    })

    it('rejects non-GET methods on /api/auth/session with 405 and Allow: GET', async () => {
      const config = makeTestConfig()
      const app = createApp(config, db)

      const postRes = await app.request('/api/auth/session', { method: 'POST' })
      expect(postRes.status).toBe(405)
      expect(postRes.headers.get('allow')).toBe('GET')
      expect(postRes.headers.get('cache-control')).toBe('no-store')
      expect(await postRes.json()).toEqual({ error: 'method_not_allowed' })

      const putRes = await app.request('/api/auth/session', { method: 'PUT' })
      expect(putRes.status).toBe(405)
      expect(putRes.headers.get('allow')).toBe('GET')

      const delRes = await app.request('/api/auth/session', { method: 'DELETE' })
      expect(delRes.status).toBe(405)
      expect(delRes.headers.get('allow')).toBe('GET')
    })
  })

  describe('Route Tier Access Guards', () => {
    it('public tier endpoints allow unauthenticated requests', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const healthRes = await app.request('/api/health')
      expect(healthRes.status).toBe(200)

      const sessionRes = await app.request('/api/auth/session')
      expect(sessionRes.status).toBe(200)
    })

    it('user tier endpoints reject unauthenticated requests with 401 under trusted-header', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const dbRes = await app.request('/api/db/progress')
      expect(dbRes.status).toBe(401)
      expect(await dbRes.json()).toEqual({ error: 'unauthenticated' })

      const progRes = await app.request('/api/progress')
      expect(progRes.status).toBe(401)
      expect(await progRes.json()).toEqual({ error: 'unauthenticated' })

      const notionRes = await app.request('/api/notion/sync')
      expect(notionRes.status).toBe(401)
      expect(await notionRes.json()).toEqual({ error: 'unauthenticated' })

      const aiRes = await app.request('/api/ai/chat', { method: 'POST' })
      expect(aiRes.status).toBe(401)
      expect(await aiRes.json()).toEqual({ error: 'unauthenticated' })
    })

    it('user tier endpoints allow requests under AUTH_ADAPTER=none as anonymous', async () => {
      const config = makeTestConfig({ authAdapter: 'none' })
      const app = createApp(config, db)

      const res = await app.request('/api/progress')
      expect(res.status).toBe(200) // anonymous user's progress
    })

    it('authenticated user accessing /api/ai/* gets 404 not_found', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const res = await app.request('/api/ai/anything', {
        headers: { 'Remote-User': 'alice' },
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })

    it('admin tier: unauthenticated gets 401', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const res = await app.request('/api/admin/users')
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthenticated' })
    })

    it('admin tier: authenticated non-admin gets 403 forbidden', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const res = await app.request('/api/admin/users', {
        headers: {
          'Remote-User': 'bob',
          'Remote-Groups': 'students',
        },
      })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    })

    it('admin tier: authenticated admin passes guard and gets 404 (unimplemented)', async () => {
      const config = makeTestConfig({ authAdapter: 'trusted-header' })
      const app = createApp(config, db)

      const res = await app.request('/api/admin/users', {
        headers: {
          'Remote-User': 'alice',
          'Remote-Groups': 'admins',
        },
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })
    })
  })

  describe('Global Cross-Cutting (Date, Body Limit, Error Envelope)', () => {
    it('attaches Date header on success, 4xx, and 5xx responses', async () => {
      const config = makeTestConfig()
      const app = createApp(config, db)

      const res200 = await app.request('/api/health')
      expect(res200.headers.get('date')).toBeTruthy()

      const res401 = await app.request('/api/progress')
      expect(res401.headers.get('date')).toBeTruthy()

      const res404 = await app.request('/api/non-existent')
      expect(res404.headers.get('date')).toBeTruthy()

      const res405 = await app.request('/api/auth/session', { method: 'POST' })
      expect(res405.headers.get('date')).toBeTruthy()
    })

    it('rejects request payloads exceeding 256 KB with 413 payload_too_large', async () => {
      const config = makeTestConfig()
      const app = createApp(config, db)

      const largeBody = JSON.stringify({ data: 'x'.repeat(260 * 1024) })
      const res = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: largeBody,
      })

      expect(res.status).toBe(413)
      expect(res.headers.get('connection')).toBe('close')
      expect(await res.json()).toEqual({ error: 'payload_too_large' })
      expect(res.headers.get('date')).toBeTruthy()
    })

    it('intercepts malformed JSON body SyntaxError as 400 invalid_request', async () => {
      const config = makeTestConfig()
      const app = createApp(config, db)

      const res = await app.request('/api/progress/g01-l01', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: '{ malformed json: ',
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_request' })
    })
  })
})
