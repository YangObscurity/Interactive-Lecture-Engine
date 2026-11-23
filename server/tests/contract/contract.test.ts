import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type AuthMode,
  detectAuthMode,
  type ServerHarness,
  spawnTestServer,
  waitForHealth,
} from './harness.js'
import {
  isWireAiMessage,
  isWireAiReviewChecklist,
  isWireAiSession,
  isWireProgress,
  isWireSession,
} from './wireValidators.js'

// Top-level determination of target server mode (if external CONTRACT_BASE_URL is provided)
const rawBaseUrl = process.env.CONTRACT_BASE_URL?.trim()
const externalBaseUrl = rawBaseUrl ? rawBaseUrl.replace(/\/+$/, '') : null

let detectedExternalMode: AuthMode | null = null
if (externalBaseUrl) {
  await waitForHealth(externalBaseUrl)
  detectedExternalMode = await detectAuthMode(externalBaseUrl)
}

const shouldRunNone = !externalBaseUrl || detectedExternalMode === 'none'
const shouldRunTrustedHeader = !externalBaseUrl || detectedExternalMode === 'trusted-header'

const descNone = shouldRunNone ? describe : describe.skip
const descTrustedHeader = shouldRunTrustedHeader ? describe : describe.skip

interface TestContext {
  baseUrl: string
  authMode: AuthMode
  getAuthHeaders: (user?: string, groups?: string[]) => Record<string, string>
}

/**
 * Shared contract test suite executed against any running server instance.
 */
function runSharedContractSuite(getCtx: () => TestContext) {
  describe('Public Endpoints', () => {
    it('GET /api/health returns 200 with complete health report and no secrets leaked', async () => {
      const { baseUrl } = getCtx()
      const res = await fetch(`${baseUrl}/api/health`)
      expect(res.status).toBe(200)

      // HTTP standards
      const dateHeader = res.headers.get('date')
      expect(dateHeader).toBeTruthy()
      expect(Number.isNaN(Date.parse(dateHeader!))).toBe(false)

      const cacheControl = res.headers.get('cache-control')
      expect(cacheControl).toContain('no-store')

      const body = (await res.json()) as Record<string, unknown>
      expect(body['ok']).toBe(true)
      expect(body['service']).toBe('lecture-api')
      expect(body['version']).toBe('2026.11.21')
      expect(body['checks']).toEqual({
        db: 'ok',
        ai: 'off',
        notion: 'off',
      })
      expect(typeof body['time']).toBe('string')
      expect(Number.isNaN(Date.parse(body['time'] as string))).toBe(false)

      // Leak check
      const rawText = JSON.stringify(body)
      expect(rawText).not.toContain('pglite')
      expect(rawText).not.toContain('postgres://')
      expect(rawText).not.toContain('password')
    })

    it('GET /api/auth/session rejects non-GET methods with 405 and Allow: GET header', async () => {
      const { baseUrl } = getCtx()
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const res = await fetch(`${baseUrl}/api/auth/session`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        expect(res.status).toBe(405)
        expect(res.headers.get('allow')).toBe('GET')
        expect(res.headers.get('cache-control')).toContain('no-store')
        expect(res.headers.get('date')).toBeTruthy()

        const body = (await res.json()) as Record<string, unknown>
        expect(body).toEqual({ error: 'method_not_allowed' })
      }
    })

    it('GET /api/auth/session without credentials returns valid anonymous wire session shape', async () => {
      const { baseUrl } = getCtx()
      const res = await fetch(`${baseUrl}/api/auth/session`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('no-store')
      expect(res.headers.get('date')).toBeTruthy()

      const body = await res.json()
      expect(isWireSession(body)).toBe(true)
      expect(body).toEqual({
        authenticated: false,
        user: null,
        roles: ['reader'],
        groups: [],
        logoutUrl: null,
      })
    })
  })

  describe('Cross-Cutting HTTP Standards', () => {
    it('every response carries a valid Date header', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const endpoints = [
        { path: '/api/health', method: 'GET', expected: 200 },
        { path: '/api/auth/session', method: 'GET', expected: 200 },
        { path: '/api/not_found_endpoint', method: 'GET', expected: 404 },
      ]

      for (const ep of endpoints) {
        const res = await fetch(`${baseUrl}${ep.path}`, {
          method: ep.method,
          headers: getAuthHeaders('test-date-user'),
        })
        expect(res.status).toBe(ep.expected)
        const dateHeader = res.headers.get('date')
        expect(dateHeader).toBeTruthy()
        const parsed = Date.parse(dateHeader!)
        expect(Number.isNaN(parsed)).toBe(false)
        expect(Math.abs(Date.now() - parsed)).toBeLessThan(120_000)
      }
    })

    it('all read (GET) endpoints carry Cache-Control: no-store', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const getPaths = ['/api/health', '/api/auth/session', '/api/progress', '/api/db/progress']

      for (const p of getPaths) {
        const res = await fetch(`${baseUrl}${p}`, {
          headers: getAuthHeaders('test-cache-user'),
        })
        expect(res.headers.get('cache-control')).toContain('no-store')
      }
    })

    it('rejects payloads exceeding 256 KB with 413 payload_too_large and Date header', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const oversizedPayload = JSON.stringify({
        status: '学习中',
        padding: 'A'.repeat(270 * 1024),
      })

      const res = await fetch(`${baseUrl}/api/progress/oversize-l01`, {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders('test-size-user'),
          'Content-Type': 'application/json',
        },
        body: oversizedPayload,
      })

      expect(res.status).toBe(413)
      expect(res.headers.get('date')).toBeTruthy()
      const body = (await res.json()) as Record<string, unknown>
      expect(body).toEqual({ error: 'payload_too_large' })
    })

    it('error responses do not echo sensitive request body or passwords', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const sensitivePassword = 'super-secret-password-xyz-987'
      const res = await fetch(`${baseUrl}/api/progress/leak-l01`, {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders('test-leak-user'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'invalid_status_value',
          password: sensitivePassword,
        }),
      })

      expect(res.status).toBe(400)
      const text = await res.text()
      expect(text).not.toContain(sensitivePassword)
      const body = JSON.parse(text) as Record<string, unknown>
      expect(body['error']).toBe('invalid_status')
    })
  })

  describe('Progress API: Single Item CRUD', () => {
    it('returns empty array initially and 404 for non-existent lecture', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-1')

      const listRes = await fetch(`${baseUrl}/api/progress`, { headers })
      expect(listRes.status).toBe(200)
      const list = await listRes.json()
      expect(Array.isArray(list)).toBe(true)

      const getRes = await fetch(`${baseUrl}/api/progress/nonexistent-l99`, { headers })
      expect(getRes.status).toBe(404)
      expect(await getRes.json()).toEqual({ error: 'not_found' })

      const getQueryRes = await fetch(`${baseUrl}/api/progress?lecture_id=nonexistent-l99`, {
        headers,
      })
      expect(getQueryRes.status).toBe(404)
      expect(await getQueryRes.json()).toEqual({ error: 'not_found' })
    })

    it('upserts progress record with derived group_id, server clock updated_at, and satisfies isWireProgress', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-crud')

      const beforeTime = Date.now()
      const patchRes = await fetch(`${baseUrl}/api/progress/sec01-l01`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: '学习中',
          updated_at: '1999-01-01T00:00:00.000Z', // Client updated_at must be ignored
        }),
      })

      expect(patchRes.status).toBe(200)
      const item = (await patchRes.json()) as Record<string, unknown>
      expect(isWireProgress(item)).toBe(true)
      expect(item['lecture_id']).toBe('sec01-l01')
      expect(item['group_id']).toBe('sec01') // Derived from lastIndexOf('-')
      expect(item['status']).toBe('学习中')
      expect(item['completed_at']).toBeNull()

      const serverUpdatedAt = Date.parse(item['updated_at'] as string)
      expect(Number.isNaN(serverUpdatedAt)).toBe(false)
      expect(serverUpdatedAt).toBeGreaterThanOrEqual(beforeTime - 2000)
      expect(item['updated_at']).not.toBe('1999-01-01T00:00:00.000Z')
    })

    it('normalizes uppercase lecture IDs to lowercase', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-case')

      const patchRes = await fetch(`${baseUrl}/api/progress/SEC02-L05`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: '学习中' }),
      })

      expect(patchRes.status).toBe(200)
      const body = (await patchRes.json()) as Record<string, unknown>
      expect(body['lecture_id']).toBe('sec02-l05')
      expect(isWireProgress(body)).toBe(true)

      // Querying with uppercase or lowercase succeeds
      const getRes = await fetch(`${baseUrl}/api/progress/SEC02-L05`, { headers })
      expect(getRes.status).toBe(200)
      const fetched = (await getRes.json()) as Record<string, unknown>
      expect(fetched['lecture_id']).toBe('sec02-l05')
    })

    it('handles completed_at lifecycle: sets on entering 已完成, preserves on metadata update, clears on exit', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-lifecycle')
      const lectureId = 'life-l01'

      // 1. Initial creation as 学习中 -> completed_at is null
      const res1 = await fetch(`${baseUrl}/api/progress/${lectureId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '学习中' }),
      })
      expect(res1.status).toBe(200)
      const b1 = (await res1.json()) as Record<string, unknown>
      expect(b1['completed_at']).toBeNull()

      // 2. Transition to 已完成 -> completed_at is populated
      const res2 = await fetch(`${baseUrl}/api/progress/${lectureId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '已完成' }),
      })
      expect(res2.status).toBe(200)
      const b2 = (await res2.json()) as Record<string, unknown>
      expect(b2['status']).toBe('已完成')
      const completedAtTimestamp = b2['completed_at'] as string
      expect(typeof completedAtTimestamp).toBe('string')
      expect(Number.isNaN(Date.parse(completedAtTimestamp))).toBe(false)

      // 3. Update metadata while keeping 已完成 -> completed_at stays unchanged
      const res3 = await fetch(`${baseUrl}/api/progress/${lectureId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '已完成', notion_node_id: 'node-sync-42' }),
      })
      expect(res3.status).toBe(200)
      const b3 = (await res3.json()) as Record<string, unknown>
      expect(b3['completed_at']).toBe(completedAtTimestamp)
      expect(b3['notion_node_id']).toBe('node-sync-42')

      // 4. Transition back to 学习中 -> completed_at cleared to null
      const res4 = await fetch(`${baseUrl}/api/progress/${lectureId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '学习中' }),
      })
      expect(res4.status).toBe(200)
      const b4 = (await res4.json()) as Record<string, unknown>
      expect(b4['status']).toBe('学习中')
      expect(b4['completed_at']).toBeNull()
    })

    it('respects explicit group_id on insert and preserves existing group_id on update when omitted', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-grp')
      const lectureId = 'customgroup-l10'

      // Insert with explicit group_id override
      const res1 = await fetch(`${baseUrl}/api/progress/${lectureId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '学习中', group_id: 'my-custom-group' }),
      })
      expect(res1.status).toBe(200)
      const b1 = (await res1.json()) as Record<string, unknown>
      expect(b1['group_id']).toBe('my-custom-group')

      // Update without group_id -> retains my-custom-group (does not revert to derived 'customgroup')
      const res2 = await fetch(`${baseUrl}/api/progress/${lectureId}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '已完成' }),
      })
      expect(res2.status).toBe(200)
      const b2 = (await res2.json()) as Record<string, unknown>
      expect(b2['group_id']).toBe('my-custom-group')
    })

    it('supports query filtering by group_id and lecture_id via both /api/progress and /api/db/progress', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-filter')

      // Insert two items in g01 and one in g02
      for (const lec of ['g01-l01', 'g01-l02']) {
        await fetch(`${baseUrl}/api/progress/${lec}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: '已完成' }),
        })
      }
      await fetch(`${baseUrl}/api/progress/g02-l01`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '学习中' }),
      })

      // Test ?group_id=g01
      const g01Res = await fetch(`${baseUrl}/api/progress?group_id=g01`, { headers })
      expect(g01Res.status).toBe(200)
      const g01List = (await g01Res.json()) as Array<Record<string, unknown>>
      expect(g01List.length).toBe(2)
      for (const it of g01List) {
        expect(it['group_id']).toBe('g01')
        expect(isWireProgress(it)).toBe(true)
      }

      // Test ?lecture_id=g01-l01
      const singleRes = await fetch(`${baseUrl}/api/db/progress?lecture_id=g01-l01`, { headers })
      expect(singleRes.status).toBe(200)
      const singleItem = (await singleRes.json()) as Record<string, unknown>
      expect(singleItem['lecture_id']).toBe('g01-l01')
      expect(isWireProgress(singleItem)).toBe(true)
    })

    it('validates lecture_id, status, and JSON payload format, returning 400', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-val')

      // Invalid lecture_id format
      const resBadId1 = await fetch(`${baseUrl}/api/progress/invalidid`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '学习中' }),
      })
      expect(resBadId1.status).toBe(400)
      expect(await resBadId1.json()).toEqual({ error: 'invalid_lecture_id' })

      const resBadId2 = await fetch(`${baseUrl}/api/progress/g01-l1`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: '学习中' }),
      })
      expect(resBadId2.status).toBe(400)
      expect(await resBadId2.json()).toEqual({ error: 'invalid_lecture_id' })

      // Invalid status value
      const resBadStatus = await fetch(`${baseUrl}/api/progress/g01-l10`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'not_a_valid_status' }),
      })
      expect(resBadStatus.status).toBe(400)
      expect(await resBadStatus.json()).toEqual({ error: 'invalid_status' })

      // Invalid non-JSON body
      const resBadJson = await fetch(`${baseUrl}/api/progress/g01-l10`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: 'invalid-json{{{',
      })
      expect(resBadJson.status).toBe(400)
      expect(await resBadJson.json()).toEqual({ error: 'invalid_request' })
    })
  })

  describe('Progress API: Batch Operations', () => {
    it('POST /api/progress/batch upserts up to 200 items in input order and satisfies isWireProgress', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-batch')

      const items = [
        { lecture_id: 'btc-l01', status: '未开始' },
        { lecture_id: 'btc-l02', status: '学习中' },
        { lecture_id: 'btc-l03', status: '已完成' },
      ]

      const res = await fetch(`${baseUrl}/api/progress/batch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })

      expect(res.status).toBe(200)
      const resBody = (await res.json()) as Array<Record<string, unknown>>
      expect(Array.isArray(resBody)).toBe(true)
      expect(resBody.length).toBe(3)

      for (let i = 0; i < items.length; i++) {
        const item = items[i]!
        const resItem = resBody[i]!
        expect(resItem['lecture_id']).toBe(item.lecture_id)
        expect(resItem['status']).toBe(item.status)
        expect(isWireProgress(resItem)).toBe(true)
      }
    })

    it('POST /api/progress/batch rolls back atomically on any invalid item', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-batch-rollback')

      const batchWithBadItem = [
        { lecture_id: 'roll-l01', status: '学习中' },
        { lecture_id: 'roll-l02', status: 'illegal_status_string' },
      ]

      const res = await fetch(`${baseUrl}/api/progress/batch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: batchWithBadItem }),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_status' })

      // Verify roll-l01 was not persisted
      const checkRes = await fetch(`${baseUrl}/api/progress/roll-l01`, { headers })
      expect(checkRes.status).toBe(404)
    })

    it('POST /api/progress/batch rejects batches with >200 items with 400 too_many_items', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-batch-limit')

      const overLimitItems = Array.from({ length: 201 }, (_, i) => ({
        lecture_id: `lim-l${String(i).padStart(3, '0')}`,
        status: '未开始',
      }))

      const res = await fetch(`${baseUrl}/api/progress/batch`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: overLimitItems }),
      })

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'too_many_items' })
    })
  })

  describe('Idempotency-Key Semantics', () => {
    it('replays identical response with Idempotency-Replayed: true and rejects conflicting payloads with 422', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-idem')
      const idempotencyKey = randomUUID()

      // 1. Initial execution
      const res1 = await fetch(`${baseUrl}/api/progress/idem-l01`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ status: '学习中' }),
      })

      expect(res1.status).toBe(200)
      expect(res1.headers.get('idempotency-replayed')).toBeNull()
      const body1 = (await res1.json()) as Record<string, unknown>
      expect(body1['status']).toBe('学习中')

      // 2. Replay with identical payload within 24h
      const res2 = await fetch(`${baseUrl}/api/progress/idem-l01`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ status: '学习中' }),
      })

      expect(res2.status).toBe(200)
      expect(res2.headers.get('idempotency-replayed')).toBe('true')
      const body2 = (await res2.json()) as Record<string, unknown>
      expect(body2).toEqual(body1)
      expect(body2['updated_at']).toBe(body1['updated_at'])

      // 3. Reuse key with different payload -> 422 idempotency_key_reused
      const res3 = await fetch(`${baseUrl}/api/progress/idem-l01`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ status: '已完成' }),
      })

      expect(res3.status).toBe(422)
      const body3 = (await res3.json()) as Record<string, unknown>
      expect(body3['error']).toBe('idempotency_key_reused')
    })

    it('does not store non-2xx responses in idempotency cache', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-idem-err')
      const errKey = randomUUID()

      // 1. Request with invalid status -> 400
      const res1 = await fetch(`${baseUrl}/api/progress/idemerr-l01`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': errKey,
        },
        body: JSON.stringify({ status: 'bad_status' }),
      })
      expect(res1.status).toBe(400)

      // 2. Subsequent valid request using the same key succeeds (not 422!)
      const res2 = await fetch(`${baseUrl}/api/progress/idemerr-l01`, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': errKey,
        },
        body: JSON.stringify({ status: '学习中' }),
      })
      expect(res2.status).toBe(200)
      const body2 = (await res2.json()) as Record<string, unknown>
      expect(body2['status']).toBe('学习中')
    })

    it('supports Idempotency-Key on POST /api/progress/batch', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = getAuthHeaders('p-user-batch-idem')
      const batchKey = randomUUID()

      const batchPayload = {
        items: [{ lecture_id: 'bidem-l01', status: '学习中' }],
      }

      // First batch execution
      const res1 = await fetch(`${baseUrl}/api/progress/batch`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': batchKey,
        },
        body: JSON.stringify(batchPayload),
      })
      expect(res1.status).toBe(200)
      expect(res1.headers.get('idempotency-replayed')).toBeNull()
      const b1 = await res1.json()

      // Replay batch execution
      const res2 = await fetch(`${baseUrl}/api/progress/batch`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': batchKey,
        },
        body: JSON.stringify(batchPayload),
      })
      expect(res2.status).toBe(200)
      expect(res2.headers.get('idempotency-replayed')).toBe('true')
      expect(await res2.json()).toEqual(b1)

      // Conflicting batch payload with same key -> 422
      const res3 = await fetch(`${baseUrl}/api/progress/batch`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Idempotency-Key': batchKey,
        },
        body: JSON.stringify({
          items: [{ lecture_id: 'bidem-l01', status: '已完成' }],
        }),
      })
      expect(res3.status).toBe(422)
      expect((await res3.json())['error']).toBe('idempotency_key_reused')
    })
  })

  describe('AI Sessions Contract Tests', () => {
    it('handles sessions lifecycle: create, list, get, patch, delete', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = { ...getAuthHeaders('session-user'), 'Content-Type': 'application/json' }

      // 1. Initial list is empty
      const listRes0 = await fetch(`${baseUrl}/api/db/sessions?lecture_id=g01-l01`, { headers })
      expect(listRes0.status).toBe(200)
      expect(listRes0.headers.get('cache-control')).toContain('no-store')
      expect(listRes0.headers.get('date')).toBeTruthy()
      expect(await listRes0.json()).toEqual([])

      // 2. Create session with lecture_id
      const createRes = await fetch(`${baseUrl}/api/db/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          lecture_id: 'g01-l01',
          title: '第一次答疑会话',
        }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as Record<string, unknown>
      expect(isWireAiSession(created)).toBe(true)
      expect(created['title']).toBe('第一次答疑会话')
      expect(created['lecture_id']).toBe('g01-l01')
      expect(created['group_id']).toBe('g01')
      expect(created['is_archived']).toBe(false)
      const sessionId = created['id'] as string

      // 3. Create session with lecture_id='global'
      const globalRes = await fetch(`${baseUrl}/api/db/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          lecture_id: 'global',
          title: '全站通用会话',
        }),
      })
      expect(globalRes.status).toBe(201)
      const globalCreated = (await globalRes.json()) as Record<string, unknown>
      expect(isWireAiSession(globalCreated)).toBe(true)
      expect(globalCreated['lecture_id']).toBe('global')
      expect(globalCreated['group_id']).toBe('global')

      // 4. Invalid lecture_id -> 400 invalid_lecture_id
      const badLecRes = await fetch(`${baseUrl}/api/db/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ lecture_id: 'invalid-id' }),
      })
      expect(badLecRes.status).toBe(400)
      expect((await badLecRes.json())['error']).toBe('invalid_lecture_id')

      // 5. GET /api/db/sessions/:id
      const getRes = await fetch(`${baseUrl}/api/db/sessions/${sessionId}`, { headers })
      expect(getRes.status).toBe(200)
      const fetched = await getRes.json()
      expect(isWireAiSession(fetched)).toBe(true)
      expect(fetched['id']).toBe(sessionId)

      // 6. PATCH /api/db/sessions/:id
      const patchRes = await fetch(`${baseUrl}/api/db/sessions/${sessionId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ title: '已重命名会话', is_archived: true }),
      })
      expect(patchRes.status).toBe(200)
      const patched = await patchRes.json()
      expect(patched['title']).toBe('已重命名会话')
      expect(patched['is_archived']).toBe(true)

      // 7. DELETE /api/db/sessions/:id -> 204
      const delRes = await fetch(`${baseUrl}/api/db/sessions/${sessionId}`, {
        method: 'DELETE',
        headers,
      })
      expect(delRes.status).toBe(204)

      // 8. GET deleted session -> 404
      const getDeleted = await fetch(`${baseUrl}/api/db/sessions/${sessionId}`, { headers })
      expect(getDeleted.status).toBe(404)

      // 9. DELETE /api/db/sessions?lecture_id=global -> 204
      const delLecRes = await fetch(`${baseUrl}/api/db/sessions?lecture_id=global`, {
        method: 'DELETE',
        headers,
      })
      expect(delLecRes.status).toBe(204)
    })
  })

  describe('AI Messages Contract Tests', () => {
    it('handles messages lifecycle: append to session, list, patch, delete', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = { ...getAuthHeaders('msg-user'), 'Content-Type': 'application/json' }

      // 1. Create parent session
      const sessionRes = await fetch(`${baseUrl}/api/db/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ lecture_id: 'g02-l01', title: '会话' }),
      })
      expect(sessionRes.status).toBe(201)
      const session = (await sessionRes.json()) as Record<string, unknown>
      const sessionId = session['id'] as string

      // 2. Append message
      const postMsgRes = await fetch(`${baseUrl}/api/db/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: sessionId,
          role: 'user',
          content: '请解释第一节课的核心内容',
          model: 'gpt-4o',
          prompt_tokens: 15,
          completion_tokens: 0,
        }),
      })
      expect(postMsgRes.status).toBe(201)
      const msg = (await postMsgRes.json()) as Record<string, unknown>
      expect(isWireAiMessage(msg)).toBe(true)
      expect(msg['role']).toBe('user')
      expect(msg['content']).toBe('请解释第一节课的核心内容')
      expect(msg['session_id']).toBe(sessionId)
      const msgId = msg['id'] as string

      // 3. Post to non-existent session -> 404
      const badSessionRes = await fetch(`${baseUrl}/api/db/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: 'non-existent-session-id',
          role: 'user',
          content: 'test',
        }),
      })
      expect(badSessionRes.status).toBe(404)

      // 4. GET /api/db/messages?session_id=
      const listRes = await fetch(`${baseUrl}/api/db/messages?session_id=${sessionId}`, { headers })
      expect(listRes.status).toBe(200)
      expect(listRes.headers.get('cache-control')).toContain('no-store')
      const msgList = (await listRes.json()) as unknown[]
      expect(Array.isArray(msgList)).toBe(true)
      expect(msgList.length).toBe(1)
      expect(isWireAiMessage(msgList[0])).toBe(true)

      // 5. PATCH /api/db/messages/:id
      const patchRes = await fetch(`${baseUrl}/api/db/messages/${msgId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ content: '修改后的问题内容', completion_tokens: 25 }),
      })
      expect(patchRes.status).toBe(200)
      const patchedMsg = await patchRes.json()
      expect(patchedMsg['content']).toBe('修改后的问题内容')
      expect(patchedMsg['completion_tokens']).toBe(25)

      // 6. DELETE /api/db/messages/:id -> 204
      const delMsgRes = await fetch(`${baseUrl}/api/db/messages/${msgId}`, {
        method: 'DELETE',
        headers,
      })
      expect(delMsgRes.status).toBe(204)

      // 7. DELETE /api/db/messages?session_id= -> 204
      const delSessionMsgs = await fetch(`${baseUrl}/api/db/messages?session_id=${sessionId}`, {
        method: 'DELETE',
        headers,
      })
      expect(delSessionMsgs.status).toBe(204)
    })
  })

  describe('AI Review Checklists Contract Tests', () => {
    it('handles review checklists batch creation, retrieval (via both paths), patch, and delete', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = { ...getAuthHeaders('chk-user'), 'Content-Type': 'application/json' }

      // 1. Batch create
      const postRes = await fetch(`${baseUrl}/api/db/review-checklists`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          items: [
            {
              lecture_id: 'g03-l01',
              topic_title: '考点一：基本概念',
              priority: 2,
            },
            {
              lecture_id: 'g03-l01',
              topic_title: '考点二：定理推导',
              priority: 1,
            },
          ],
        }),
      })
      expect(postRes.status).toBe(201)
      const createdItems = (await postRes.json()) as unknown[]
      expect(Array.isArray(createdItems)).toBe(true)
      expect(createdItems.length).toBe(2)
      expect(isWireAiReviewChecklist(createdItems[0])).toBe(true)
      expect(isWireAiReviewChecklist(createdItems[1])).toBe(true)
      const firstItemId = (createdItems[0] as Record<string, unknown>)['id'] as string

      // 2. GET /api/db/review-checklists
      const getRes1 = await fetch(`${baseUrl}/api/db/review-checklists?lecture_id=g03-l01`, { headers })
      expect(getRes1.status).toBe(200)
      expect(getRes1.headers.get('cache-control')).toContain('no-store')
      const items1 = await getRes1.json()
      expect(Array.isArray(items1)).toBe(true)
      expect(items1.length).toBe(2)

      // 3. GET alias /api/db/checklist
      const getRes2 = await fetch(`${baseUrl}/api/db/checklist?lecture_id=g03-l01`, { headers })
      expect(getRes2.status).toBe(200)
      const items2 = await getRes2.json()
      expect(Array.isArray(items2)).toBe(true)
      expect(items2.length).toBe(2)

      // 4. PATCH /api/db/review-checklists/:id
      const patchRes = await fetch(`${baseUrl}/api/db/review-checklists/${firstItemId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ is_completed: true }),
      })
      expect(patchRes.status).toBe(200)
      const patched = await patchRes.json()
      expect(patched['is_completed']).toBe(true)

      // 5. DELETE /api/db/review-checklists/:id -> 204
      const delRes = await fetch(`${baseUrl}/api/db/review-checklists/${firstItemId}`, {
        method: 'DELETE',
        headers,
      })
      expect(delRes.status).toBe(204)
    })
  })

  describe('AI Proxy Contract Tests (AI_PROVIDER=off)', () => {
    it('POST /api/ai/chat returns 503 ai_not_configured with Date header', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const headers = { ...getAuthHeaders('ai-user'), 'Content-Type': 'application/json' }
      const res = await fetch(`${baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: 'hello' }),
      })
      expect(res.status).toBe(503)
      expect(res.headers.get('date')).toBeTruthy()
      expect(await res.json()).toEqual({ error: 'ai_not_configured' })
    })

    it('POST /api/ai/upload returns 503 ai_not_configured with Date header', async () => {
      const { baseUrl, getAuthHeaders } = getCtx()
      const formData = new FormData()
      formData.append('file', new Blob(['test content'], { type: 'application/pdf' }), 'test.pdf')
      const headers = getAuthHeaders('ai-user')
      const res = await fetch(`${baseUrl}/api/ai/upload`, {
        method: 'POST',
        headers,
        body: formData,
      })
      expect(res.status).toBe(503)
      expect(res.headers.get('date')).toBeTruthy()
      expect(await res.json()).toEqual({ error: 'ai_not_configured' })
    })
  })
}

// ============================================================================
// SUITE 1: AUTH_ADAPTER = none
// ============================================================================
descNone('Contract Tests: AUTH_ADAPTER=none', () => {
  let harness: ServerHarness | null = null
  let activeBaseUrl = ''

  beforeAll(async () => {
    if (externalBaseUrl) {
      activeBaseUrl = externalBaseUrl
    } else {
      harness = await spawnTestServer({ authAdapter: 'none' })
      activeBaseUrl = harness.baseUrl
    }
  })

  afterAll(async () => {
    if (harness) {
      await harness.stop()
    }
  })

  const getCtx = (): TestContext => ({
    baseUrl: activeBaseUrl,
    authMode: 'none',
    getAuthHeaders: () => ({}),
  })

  // Run shared contract tests
  runSharedContractSuite(getCtx)

  describe('AUTH_ADAPTER=none specific behaviors', () => {
    it('GET /api/auth/session returns anonymous shape even when gateway headers are passed', async () => {
      const res = await fetch(`${activeBaseUrl}/api/auth/session`, {
        headers: {
          'Remote-User': 'alice',
          'Remote-Groups': 'admins',
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(isWireSession(body)).toBe(true)
      expect(body).toEqual({
        authenticated: false,
        user: null,
        roles: ['reader'],
        groups: [],
        logoutUrl: null,
      })
    })

    it('unauthenticated requests succeed as anonymous user', async () => {
      const res = await fetch(`${activeBaseUrl}/api/progress`)
      expect(res.status).toBe(200)
      const items = await res.json()
      expect(Array.isArray(items)).toBe(true)
    })

    it('admin routes return 403 forbidden because anonymous only possesses reader role', async () => {
      const res = await fetch(`${activeBaseUrl}/api/admin/overview`)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'forbidden' })
    })

    it('AI routes return 503 ai_not_configured because provider is off', async () => {
      const res = await fetch(`${activeBaseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'hello' }),
      })
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'ai_not_configured' })
    })
  })
})

// ============================================================================
// SUITE 2: AUTH_ADAPTER = trusted-header
// ============================================================================
descTrustedHeader('Contract Tests: AUTH_ADAPTER=trusted-header', () => {
  let harness: ServerHarness | null = null
  let activeBaseUrl = ''

  beforeAll(async () => {
    if (externalBaseUrl) {
      activeBaseUrl = externalBaseUrl
    } else {
      harness = await spawnTestServer({
        authAdapter: 'trusted-header',
        authHeaderPreset: 'authelia',
        authRoleMap: 'admins:admin,staff:author',
      })
      activeBaseUrl = harness.baseUrl
    }
  })

  afterAll(async () => {
    if (harness) {
      await harness.stop()
    }
  })

  const getCtx = (): TestContext => ({
    baseUrl: activeBaseUrl,
    authMode: 'trusted-header',
    getAuthHeaders: (user = 'contract-alice', groups = ['staff']) => ({
      'Remote-User': user,
      'Remote-Groups': groups.join(','),
      'Remote-Email': `${user}@example.com`,
      'Remote-Name': user.toUpperCase(),
    }),
  })

  // Run shared contract tests
  runSharedContractSuite(getCtx)

  describe('AUTH_ADAPTER=trusted-header specific behaviors', () => {
    it('GET /api/auth/session returns full authenticated shape with mapped roles and groups', async () => {
      const res = await fetch(`${activeBaseUrl}/api/auth/session`, {
        headers: {
          'Remote-User': 'alice',
          'Remote-Groups': 'admins,staff',
          'Remote-Email': 'alice@example.com',
          'Remote-Name': 'Alice Smith',
        },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(isWireSession(body)).toBe(true)
      expect(body['authenticated']).toBe(true)
      expect(body['user']).toEqual({
        id: 'alice',
        name: 'Alice Smith',
        email: 'alice@example.com',
      })
      expect(body['roles']).toContain('reader')
      expect(body['roles']).toContain('admin')
      if (Array.isArray(body['roles']) && (body['roles'] as string[]).includes('author')) {
        expect(body['roles']).toContain('author')
      }
      expect(body['groups']).toEqual(['admins', 'staff'])
    })

    it('GET /api/auth/session rejects headers with length > 256 or whitespace-only and falls back to anonymous', async () => {
      // Length > 256
      const resLen = await fetch(`${activeBaseUrl}/api/auth/session`, {
        headers: { 'Remote-User': 'a'.repeat(257) },
      })
      expect(resLen.status).toBe(200)
      const bodyLen = (await resLen.json()) as Record<string, unknown>
      expect(bodyLen['authenticated']).toBe(false)
      expect(bodyLen['user']).toBeNull()

      // Whitespace only
      const resWs = await fetch(`${activeBaseUrl}/api/auth/session`, {
        headers: { 'Remote-User': '    ' },
      })
      expect(resWs.status).toBe(200)
      const bodyWs = (await resWs.json()) as Record<string, unknown>
      expect(bodyWs['authenticated']).toBe(false)
      expect(bodyWs['user']).toBeNull()

      // Exactly 256 characters accepted
      const exact256 = 'u'.repeat(256)
      const resExact = await fetch(`${activeBaseUrl}/api/auth/session`, {
        headers: { 'Remote-User': exact256 },
      })
      expect(resExact.status).toBe(200)
      const bodyExact = (await resExact.json()) as Record<string, unknown>
      expect(bodyExact['authenticated']).toBe(true)
      expect((bodyExact['user'] as { id: string }).id).toBe(exact256)
    })

    it('route tier access: unauthenticated requests to user routes return 401 unauthenticated', async () => {
      const endpoints = [
        { path: '/api/progress', method: 'GET' },
        { path: '/api/db/progress', method: 'GET' },
        { path: '/api/progress/batch', method: 'POST', body: JSON.stringify({ items: [] }) },
        { path: '/api/notion/sync', method: 'GET' },
        { path: '/api/ai/chat', method: 'POST', body: JSON.stringify({}) },
      ]

      for (const ep of endpoints) {
        const res = await fetch(`${activeBaseUrl}${ep.path}`, {
          method: ep.method,
          headers: ep.body ? { 'Content-Type': 'application/json' } : {},
          body: ep.body,
        })
        expect(res.status).toBe(401)
        expect(res.headers.get('date')).toBeTruthy()
        const body = (await res.json()) as Record<string, unknown>
        expect(body).toEqual({ error: 'unauthenticated' })
      }
    })

    it('route tier access: admin routes return 401 unauthenticated, 403 reader, and 404 admin', async () => {
      // 1. Unauthenticated -> 401
      const resUnauth = await fetch(`${activeBaseUrl}/api/admin/users`)
      expect(resUnauth.status).toBe(401)
      expect(await resUnauth.json()).toEqual({ error: 'unauthenticated' })

      // 2. Authenticated reader without admin group -> 403
      const resReader = await fetch(`${activeBaseUrl}/api/admin/users`, {
        headers: {
          'Remote-User': 'bob',
          'Remote-Groups': 'students',
        },
      })
      expect(resReader.status).toBe(403)
      expect(await resReader.json()).toEqual({ error: 'forbidden' })

      // 3. Authenticated admin -> 200 overview
      const resAdmin = await fetch(`${activeBaseUrl}/api/admin/overview`, {
        headers: {
          'Remote-User': 'alice',
          'Remote-Groups': 'admins',
        },
      })
      expect(resAdmin.status).toBe(200)
      expect(resAdmin.headers.get('cache-control')).toContain('no-store')
      const overview = (await resAdmin.json()) as Record<string, unknown>
      expect(overview['totals']).toBeDefined()
      expect(overview['byStatus']).toBeDefined()

      // 4. Authenticated admin on unmapped route -> 404
      const resAdmin404 = await fetch(`${activeBaseUrl}/api/admin/unmapped_route`, {
        headers: {
          'Remote-User': 'alice',
          'Remote-Groups': 'admins',
        },
      })
      expect(resAdmin404.status).toBe(404)
      expect(await resAdmin404.json()).toEqual({ error: 'not_found' })
    })

    it('route tier access: AI routes return 401 unauthenticated and 503 authenticated when provider is off', async () => {
      // Unauthenticated -> 401
      const resUnauth = await fetch(`${activeBaseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'hello' }),
      })
      expect(resUnauth.status).toBe(401)

      // Authenticated -> 503
      const resAuth = await fetch(`${activeBaseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Remote-User': 'alice',
        },
        body: JSON.stringify({ query: 'hello' }),
      })
      expect(resAuth.status).toBe(503)
      expect(await resAuth.json()).toEqual({ error: 'ai_not_configured' })
    })

    it('enforces multi-user isolation for progress records and idempotency keys', async () => {
      const aliceHeaders = {
        'Remote-User': 'alice-isolation',
        'Content-Type': 'application/json',
      }
      const bobHeaders = {
        'Remote-User': 'bob-isolation',
        'Content-Type': 'application/json',
      }
      const sharedKey = randomUUID()

      // Alice writes progress for iso-l01 as 学习中 with sharedKey
      const resAlice = await fetch(`${activeBaseUrl}/api/progress/iso-l01`, {
        method: 'PATCH',
        headers: { ...aliceHeaders, 'Idempotency-Key': sharedKey },
        body: JSON.stringify({ status: '学习中' }),
      })
      expect(resAlice.status).toBe(200)

      // Bob reads iso-l01 -> 404 (isolated from Alice)
      const resBobGet = await fetch(`${activeBaseUrl}/api/progress/iso-l01`, {
        headers: bobHeaders,
      })
      expect(resBobGet.status).toBe(404)

      // Bob writes progress for iso-l01 as 已完成 using the EXACT SAME Idempotency-Key
      // Must succeed with 200 (not 422 conflict) because idempotency keys are isolated per user
      const resBobWrite = await fetch(`${activeBaseUrl}/api/progress/iso-l01`, {
        method: 'PATCH',
        headers: { ...bobHeaders, 'Idempotency-Key': sharedKey },
        body: JSON.stringify({ status: '已完成' }),
      })
      expect(resBobWrite.status).toBe(200)

      // Alice still sees her own record as 学习中
      const resAliceCheck = await fetch(`${activeBaseUrl}/api/progress/iso-l01`, {
        headers: aliceHeaders,
      })
      expect(resAliceCheck.status).toBe(200)
      expect((await resAliceCheck.json())['status']).toBe('学习中')

      // Bob sees his own record as 已完成
      const resBobCheck = await fetch(`${activeBaseUrl}/api/progress/iso-l01`, {
        headers: bobHeaders,
      })
      expect(resBobCheck.status).toBe(200)
      expect((await resBobCheck.json())['status']).toBe('已完成')
    })
  })
})

const descStandaloneAi = !externalBaseUrl ? describe : describe.skip

descStandaloneAi('Contract Tests: Site-managed AI prompts & quick actions (standalone server)', () => {
  let upstreamServer: Server
  let upstreamPort = 0
  let capturedUpstreamBody: Record<string, unknown> | null = null
  let tempPromptDir = ''
  let harness: ServerHarness | null = null

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      upstreamServer = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          try {
            capturedUpstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          } catch {
            capturedUpstreamBody = null
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
          res.write('data: {"id":"cmpl-1","choices":[{"delta":{"content":"Standalone AI ok"}}]}\n\n')
          res.write('data: {"id":"cmpl-1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":3,"total_tokens":6}}\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
        })
      })
      upstreamServer.listen(0, '127.0.0.1', () => {
        const addr = upstreamServer.address()
        upstreamPort = typeof addr === 'object' && addr ? addr.port : 0
        resolve()
      })
    })

    tempPromptDir = mkdtempSync(join(tmpdir(), 'lecture-api-prompts-contract-'))
    const promptsPath = join(tempPromptDir, 'companion.json')
    writeFileSync(
      promptsPath,
      JSON.stringify({
        version: 7,
        system: {
          zh: '站内系统提示词 v7',
          en: 'Standalone contract system prompt v7',
        },
        actions: [
          {
            id: 'explain',
            label: { zh: '解释', en: 'Explain' },
            template: { zh: '解释 {lecture}: {selection}', en: 'Explain {lecture} ({group}): {selection}' },
          },
        ],
      }),
      'utf8',
    )

    harness = await spawnTestServer({
      authAdapter: 'trusted-header',
      authHeaderPreset: 'authelia',
      extraEnv: {
        AI_PROVIDER: 'openai',
        OPENAI_API_BASE: `http://127.0.0.1:${upstreamPort}/v1`,
        OPENAI_API_KEY: 'sk-contract-test-key',
        OPENAI_MODEL: 'contract-model',
        AI_PROMPTS_FILE: promptsPath,
      },
    })
  })

  afterAll(async () => {
    if (harness) await harness.stop()
    if (upstreamServer) {
      await new Promise<void>((resolve) => upstreamServer.close(() => resolve()))
    }
    if (tempPromptDir) {
      rmSync(tempPromptDir, { recursive: true, force: true })
    }
  })

  it('rejects unknown action with 400 and missing selection with 400', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'Remote-User': 'contract-reader',
    }
    const unknownRes = await fetch(`${harness!.baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'does_not_exist', query: '' }),
    })
    expect(unknownRes.status).toBe(400)
    expect(await unknownRes.json()).toMatchObject({ error: 'invalid_request', message: 'unknown_action' })

    const noSelRes = await fetch(`${harness!.baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'explain', inputs: { current_lecture: 'L1', selection: '' } }),
    })
    expect(noSelRes.status).toBe(400)
    expect(await noSelRes.json()).toMatchObject({ error: 'invalid_request', message: 'selection_required' })
  })

  it('assembles system prompt + action template from AI_PROMPTS_FILE and strips spoofed client instructions', async () => {
    capturedUpstreamBody = null
    const res = await fetch(`${harness!.baseUrl}/api/ai/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Remote-User': 'contract-reader',
      },
      body: JSON.stringify({
        action: 'explain',
        lang: 'en',
        query: '',
        system: 'CLIENT_INJECTED_SYSTEM',
        inputs: {
          current_lecture: 'G01-L02',
          group: 'G01',
          outline: 'Ohm law',
          selection: 'V = I * R',
        },
      }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    expect(sse).toContain('Standalone AI ok')
    expect(capturedUpstreamBody).not.toBeNull()
    const msgs = capturedUpstreamBody!['messages'] as Array<{ role: string; content: string }>
    expect(msgs[0]?.role).toBe('system')
    expect(msgs[0]?.content).toContain('Standalone contract system prompt v7')
    expect(msgs[0]?.content).toContain('Lecture: G01-L02')
    expect(msgs[0]?.content).not.toContain('CLIENT_INJECTED_SYSTEM')
    expect(msgs[1]).toEqual({
      role: 'user',
      content: 'Explain G01-L02 (G01): V = I * R',
    })
  })
})
