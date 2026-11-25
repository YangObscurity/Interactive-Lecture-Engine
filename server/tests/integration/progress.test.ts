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
    authRoleMap: { admins: ['admin'] },
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
    authBootstrapToken: null,
    ...overrides,
  }
}

describe('Progress API Integration Tests', () => {
  let db: Db
  let config: AppConfig
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    db = await createDb('pglite:memory')
    await runMigrations(db)
    config = makeTestConfig()
    app = createApp(config, db)
  })

  afterAll(async () => {
    await db.close()
  })

  describe('Authentication & Mounting', () => {
    it('requires authentication under trusted-header mode', async () => {
      const res = await app.request('/api/db/progress')
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthenticated' })
    })

    it('accessible at both /api/db/progress and /api/progress', async () => {
      const res1 = await app.request('/api/db/progress', {
        headers: { 'Remote-User': 'alice' },
      })
      const res2 = await app.request('/api/progress', {
        headers: { 'Remote-User': 'alice' },
      })
      expect(res1.status).toBe(200)
      expect(res2.status).toBe(200)
      expect(await res1.json()).toEqual(await res2.json())
    })
  })

  describe('GET Progress', () => {
    it('returns empty array when user has no records', async () => {
      const res = await app.request('/api/progress', {
        headers: { 'Remote-User': 'new-user' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('date')).toBeTruthy()
      expect(await res.json()).toEqual([])
    })

    it('returns 404 when querying non-existent lecture_id', async () => {
      const res = await app.request('/api/progress?lecture_id=g01-l01', {
        headers: { 'Remote-User': 'alice' },
      })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'not_found' })

      const resParam = await app.request('/api/progress/g01-l01', {
        headers: { 'Remote-User': 'alice' },
      })
      expect(resParam.status).toBe(404)
      expect(await resParam.json()).toEqual({ error: 'not_found' })
    })

    it('returns 400 invalid_lecture_id on malformed lecture_id parameter', async () => {
      const res1 = await app.request('/api/progress?lecture_id=invalid-id', {
        headers: { 'Remote-User': 'alice' },
      })
      expect(res1.status).toBe(400)
      expect(await res1.json()).toEqual({ error: 'invalid_lecture_id' })

      const res2 = await app.request('/api/progress/not-a-lecture', {
        headers: { 'Remote-User': 'alice' },
      })
      expect(res2.status).toBe(400)
      expect(await res2.json()).toEqual({ error: 'invalid_lecture_id' })
    })
  })

  describe('PATCH Progress (single upsert)', () => {
    it('upserts a lecture with normalized ID and derived group_id', async () => {
      const res = await app.request('/api/progress/G01-L01', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: '学习中',
          notion_node_id: 'node-1',
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toMatchObject({
        lecture_id: 'g01-l01',
        group_id: 'g01',
        status: '学习中',
        completed_at: null,
        notion_node_id: 'node-1',
        notion_page_id: null,
      })
      expect(data.updated_at).toBeTruthy()
    })

    it('rejects invalid status with 400 invalid_status', async () => {
      const res = await app.request('/api/progress/g01-l02', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'done' }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_status' })
    })

    it('rejects missing or invalid lecture_id with 400 invalid_lecture_id', async () => {
      const res = await app.request('/api/progress', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: '学习中' }), // no lecture_id in path, query, or body
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_lecture_id' })
    })

    it('ignores client-supplied updated_at and completed_at', async () => {
      const spoofTime = '1999-01-01T00:00:00.000Z'
      const res = await app.request('/api/progress/g01-l03', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: '未开始',
          updated_at: spoofTime,
          completed_at: spoofTime,
        }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.updated_at).not.toBe(spoofTime)
      expect(data.completed_at).toBeNull() // because status is '未开始'
    })

    it('manages completed_at lifecycle accurately', async () => {
      // 1. Enter 已完成 -> completed_at set
      const res1 = await app.request('/api/progress/g01-l04', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: '已完成' }),
      })
      expect(res1.status).toBe(200)
      const data1 = await res1.json()
      expect(data1.status).toBe('已完成')
      expect(data1.completed_at).toBeTruthy()
      const initialCompletedAt = data1.completed_at

      // 2. Remain in 已完成 -> completed_at preserved
      const res2 = await app.request('/api/progress/g01-l04', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: '已完成', notion_page_id: 'page-4' }),
      })
      expect(res2.status).toBe(200)
      const data2 = await res2.json()
      expect(data2.completed_at).toBe(initialCompletedAt)
      expect(data2.notion_page_id).toBe('page-4')

      // 3. Move to 学习中 -> completed_at cleared to null
      const res3 = await app.request('/api/progress/g01-l04', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: '学习中' }),
      })
      expect(res3.status).toBe(200)
      const data3 = await res3.json()
      expect(data3.status).toBe('学习中')
      expect(data3.completed_at).toBeNull()
    })

    it('preserves explicit group_id when omitted on subsequent updates', async () => {
      // First upsert with explicit custom group_id
      const res1 = await app.request('/api/progress/customgroup-l01', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: '学习中', group_id: 'my-custom-group' }),
      })
      expect(res1.status).toBe(200)
      expect((await res1.json()).group_id).toBe('my-custom-group')

      // Subsequent update without group_id
      const res2 = await app.request('/api/progress/customgroup-l01', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'alice',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: '已完成' }),
      })
      expect(res2.status).toBe(200)
      expect((await res2.json()).group_id).toBe('my-custom-group')
    })
  })

  describe('GET with filters', () => {
    it('supports ?group_id= and ?lecture_id=', async () => {
      // Create records in g02 and g03
      await app.request('/api/progress/g02-l01', {
        method: 'PATCH',
        headers: { 'Remote-User': 'filter-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '学习中' }),
      })
      await app.request('/api/progress/g02-l02', {
        method: 'PATCH',
        headers: { 'Remote-User': 'filter-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '已完成' }),
      })
      await app.request('/api/progress/g03-l01', {
        method: 'PATCH',
        headers: { 'Remote-User': 'filter-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '未开始' }),
      })

      // Query group_id=g02
      const groupRes = await app.request('/api/progress?group_id=g02', {
        headers: { 'Remote-User': 'filter-user' },
      })
      expect(groupRes.status).toBe(200)
      const groupRows = await groupRes.json()
      expect(groupRows.length).toBe(2)
      expect(groupRows.map((r: { lecture_id: string }) => r.lecture_id)).toEqual(['g02-l01', 'g02-l02'])

      // Query single lecture_id=g02-l01
      const singleRes = await app.request('/api/progress?lecture_id=g02-l01', {
        headers: { 'Remote-User': 'filter-user' },
      })
      expect(singleRes.status).toBe(200)
      const singleRow = await singleRes.json()
      expect(singleRow.lecture_id).toBe('g02-l01')

      // Query all
      const allRes = await app.request('/api/progress', {
        headers: { 'Remote-User': 'filter-user' },
      })
      expect(allRes.status).toBe(200)
      expect((await allRes.json()).length).toBe(3)
    })
  })

  describe('POST /batch (atomic upsert)', () => {
    it('upserts up to 200 items in input order', async () => {
      const items = [
        { lecture_id: 'batch-l01', status: '未开始' },
        { lecture_id: 'batch-l02', status: '学习中' },
        { lecture_id: 'batch-l03', status: '已完成' },
      ]

      const res = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: {
          'Remote-User': 'batch-user',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items }),
      })

      expect(res.status).toBe(200)
      const rows = await res.json()
      expect(rows.length).toBe(3)
      expect(rows[0].lecture_id).toBe('batch-l01')
      expect(rows[1].lecture_id).toBe('batch-l02')
      expect(rows[2].lecture_id).toBe('batch-l03')
      expect(rows[2].completed_at).toBeTruthy()
    })

    it('rejects batch exceeding 200 items with 400 too_many_items', async () => {
      const items = Array.from({ length: 201 }, (_, i) => ({
        lecture_id: `g01-l${String(i + 1).padStart(2, '0')}`,
        status: '未开始',
      }))

      const res = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: {
          'Remote-User': 'batch-user',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items }),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'too_many_items' })
    })

    it('is strictly atomic: if 1 item fails validation, 0 rows are written', async () => {
      const items = [
        { lecture_id: 'atomic-l01', status: '未开始' },
        { lecture_id: 'atomic-l02', status: 'invalid-status' }, // Invalid!
        { lecture_id: 'atomic-l03', status: '已完成' },
      ]

      const res = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: {
          'Remote-User': 'atomic-user',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items }),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_status' })

      // Verify that NO rows were written for atomic-user
      const checkRes = await app.request('/api/progress', {
        headers: { 'Remote-User': 'atomic-user' },
      })
      expect(await checkRes.json()).toEqual([])
    })

    it('rejects batch with malformed body or non-object item', async () => {
      // Missing items
      const res1 = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: { 'Remote-User': 'batch-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ not_items: [] }),
      })
      expect(res1.status).toBe(400)
      expect(await res1.json()).toEqual({ error: 'invalid_request' })

      // Item not an object
      const res2 = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: { 'Remote-User': 'batch-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['not-an-object'] }),
      })
      expect(res2.status).toBe(400)
      expect(await res2.json()).toEqual({ error: 'invalid_lecture_id' })

      // Item with invalid lecture_id type
      const res3 = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: { 'Remote-User': 'batch-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ lecture_id: 123, status: '学习中' }] }),
      })
      expect(res3.status).toBe(400)
      expect(await res3.json()).toEqual({ error: 'invalid_lecture_id' })

      // Item with invalid lecture_id format
      const res4 = await app.request('/api/progress/batch', {
        method: 'POST',
        headers: { 'Remote-User': 'batch-user', 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ lecture_id: 'bad_format', status: '学习中' }] }),
      })
      expect(res4.status).toBe(400)
      expect(await res4.json()).toEqual({ error: 'invalid_lecture_id' })
    })
  })

  describe('Transactional Idempotency on Progress API', () => {
    it('replays identical response and sets Idempotency-Replayed: true', async () => {
      const key = 'idem-progress-key-1'
      const payload = { status: '学习中' }

      const res1 = await app.request('/api/progress/idem-l01', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'idem-user',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      })

      expect(res1.status).toBe(200)
      expect(res1.headers.get('idempotency-replayed')).toBeNull()
      const data1 = await res1.json()

      // Replay with identical key and payload
      const res2 = await app.request('/api/progress/idem-l01', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'idem-user',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(payload),
      })

      expect(res2.status).toBe(200)
      expect(res2.headers.get('idempotency-replayed')).toBe('true')
      const data2 = await res2.json()
      expect(data2).toEqual(data1)
    })

    it('returns 422 idempotency_key_reused if same key used for different payload', async () => {
      const key = 'idem-progress-key-2'

      const res1 = await app.request('/api/progress/idem-l02', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'idem-user',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ status: '未开始' }),
      })
      expect(res1.status).toBe(200)

      // Reuse same key with different payload
      const res2 = await app.request('/api/progress/idem-l02', {
        method: 'PATCH',
        headers: {
          'Remote-User': 'idem-user',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ status: '已完成' }),
      })

      expect(res2.status).toBe(422)
      expect(await res2.json()).toEqual({
        error: 'idempotency_key_reused',
        message: 'this Idempotency-Key was used for a different request',
      })
    })

    it('handles concurrent identical requests safely without conflict', async () => {
      const key = 'idem-progress-concurrent-1'
      const payload = JSON.stringify({ status: '已完成' })

      const promises = Array.from({ length: 5 }, () =>
        app.request('/api/progress/idem-l03', {
          method: 'PATCH',
          headers: {
            'Remote-User': 'idem-concurrent-user',
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: payload,
        }),
      )

      const results = await Promise.all(promises)
      for (const res of results) {
        expect(res.status).toBe(200)
      }

      const replayedCounts = results.filter(
        (r) => r.headers.get('idempotency-replayed') === 'true',
      ).length
      // At least 4 should be replays
      expect(replayedCounts).toBeGreaterThanOrEqual(4)
    })
  })

  describe('Per-User Isolation', () => {
    it('isolates progress records strictly between users', async () => {
      await app.request('/api/progress/iso-l01', {
        method: 'PATCH',
        headers: { 'Remote-User': 'alice', 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '已完成' }),
      })

      // Bob queries same lecture
      const bobRes = await app.request('/api/progress/iso-l01', {
        headers: { 'Remote-User': 'bob' },
      })
      expect(bobRes.status).toBe(404) // Bob has no record for this lecture
    })
  })
})
