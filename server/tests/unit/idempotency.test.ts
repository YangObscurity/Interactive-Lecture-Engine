import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import {
  badRequest,
  forbidden,
  handleAppError,
  HttpError,
  idempotencyKeyReused,
  internalError,
  methodNotAllowed,
  notFound,
  payloadTooLarge,
  unauthenticated,
} from '../../src/http/errors.js'
import {
  canonicalJson,
  computeFingerprint,
  executeIdempotent,
} from '../../src/http/idempotency.js'

describe('http/idempotency canonicalJson & computeFingerprint', () => {
  it('canonicalJson sorts keys recursively while preserving array order', () => {
    const a = { b: 1, a: 2, c: { z: 'foo', y: 'bar' }, list: [3, 1, 2] }
    const b = { c: { y: 'bar', z: 'foo' }, a: 2, list: [3, 1, 2], b: 1 }

    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe(
      '{"a":2,"b":1,"c":{"y":"bar","z":"foo"},"list":[3,1,2]}',
    )
  })

  it('canonicalJson handles primitives and null', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(123)).toBe('123')
    expect(canonicalJson('hello')).toBe('"hello"')
  })

  it('computeFingerprint normalizes method and trailing slash', () => {
    const fp1 = computeFingerprint('post', '/api/progress/', { a: 1, b: 2 })
    const fp2 = computeFingerprint('POST', '/api/progress', { b: 2, a: 1 })
    expect(fp1).toBe(fp2)
    expect(fp1).toBe('POST /api/progress {"a":1,"b":2}')
  })

  it('computeFingerprint handles root path', () => {
    const fp = computeFingerprint('get', '/', null)
    expect(fp).toBe('GET / {}')
  })
})

describe('http/idempotency executeIdempotent lifecycle', () => {
  let db: Db

  beforeAll(async () => {
    db = await createDb('pglite:memory')
    await runMigrations(db)
  })

  afterAll(async () => {
    await db.close()
  })

  it('executes directly without key and does not cache', async () => {
    let callCount = 0
    const res = await executeIdempotent(
      db,
      'alice',
      undefined,
      'POST /test {}',
      new Date(),
      async () => {
        callCount++
        return { statusCode: 200, body: { success: true, count: callCount } }
      },
    )

    expect(res.replayed).toBe(false)
    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual({ success: true, count: 1 })

    const rows = await db.query('SELECT * FROM idempotency_keys WHERE user_id = $1', ['alice'])
    expect(rows.rows.length).toBe(0)
  })

  it('caches 200 response and replays on second call with same key and fingerprint', async () => {
    let callCount = 0
    const key = 'test-key-1'
    const fp = 'PATCH /api/progress {"status":"学习中"}'
    const now = new Date()

    const res1 = await executeIdempotent(
      db,
      'alice',
      key,
      fp,
      now,
      async () => {
        callCount++
        return { statusCode: 200, body: { progress: 'ok', count: callCount } }
      },
    )

    expect(res1.replayed).toBe(false)
    expect(res1.statusCode).toBe(200)
    expect(res1.body).toEqual({ progress: 'ok', count: 1 })
    expect(callCount).toBe(1)

    // Replay call with exact same key and fingerprint
    const res2 = await executeIdempotent(
      db,
      'alice',
      key,
      fp,
      now,
      async () => {
        callCount++
        return { statusCode: 200, body: { progress: 'ok', count: callCount } }
      },
    )

    expect(res2.replayed).toBe(true)
    expect(res2.statusCode).toBe(200)
    expect(res2.body).toEqual({ progress: 'ok', count: 1 })
    expect(callCount).toBe(1) // handler was NOT called again
  })

  it('first response and replay are byte-identical even when jsonb reorders keys', async () => {
    const key = 'test-key-order'
    const fp = 'PATCH /api/progress/g05-l03 {"status":"学习中"}'
    const now = new Date()
    // jsonb stores keys shorter-first (id, status, group_id); the handler builds them in another order
    const handler = async () => ({ statusCode: 200, body: { status: '学习中', id: 'g05-l03', group_id: 'g05' } })
    const res1 = await executeIdempotent(db, 'alice', key, fp, now, handler)
    const res2 = await executeIdempotent(db, 'alice', key, fp, now, handler)
    expect(res1.replayed).toBe(false)
    expect(res2.replayed).toBe(true)
    expect(JSON.stringify(res1.body)).toBe(JSON.stringify(res2.body))
  })

  it('returns 422 idempotency_key_reused when reusing key with different fingerprint', async () => {
    let callCount = 0
    const key = 'test-key-2'
    const fp1 = 'PATCH /api/progress {"status":"学习中"}'
    const fp2 = 'PATCH /api/progress {"status":"已完成"}'
    const now = new Date()

    const res1 = await executeIdempotent(
      db,
      'alice',
      key,
      fp1,
      now,
      async () => {
        callCount++
        return { statusCode: 200, body: { ok: true } }
      },
    )
    expect(res1.statusCode).toBe(200)
    expect(res1.replayed).toBe(false)

    // Replay with different fingerprint
    const res2 = await executeIdempotent(
      db,
      'alice',
      key,
      fp2,
      now,
      async () => {
        callCount++
        return { statusCode: 200, body: { ok: true } }
      },
    )

    expect(res2.statusCode).toBe(422)
    expect(res2.replayed).toBe(false)
    expect(res2.body).toEqual({
      error: 'idempotency_key_reused',
      message: 'this Idempotency-Key was used for a different request',
    })
    expect(callCount).toBe(1)
  })

  it('does NOT cache non-2xx responses and allows fresh retry with same key', async () => {
    let callCount = 0
    const key = 'test-key-3'
    const fp = 'POST /api/progress/batch {}'
    const now = new Date()

    // 1st attempt fails with 400
    const res1 = await executeIdempotent(
      db,
      'alice',
      key,
      fp,
      now,
      async () => {
        callCount++
        return { statusCode: 400, body: { error: 'invalid_status' } }
      },
    )
    expect(res1.statusCode).toBe(400)
    expect(res1.replayed).toBe(false)
    expect(callCount).toBe(1)

    // 2nd attempt with same key succeeds with 200
    const res2 = await executeIdempotent(
      db,
      'alice',
      key,
      fp,
      now,
      async () => {
        callCount++
        return { statusCode: 200, body: { ok: true } }
      },
    )
    expect(res2.statusCode).toBe(200)
    expect(res2.replayed).toBe(false)
    expect(callCount).toBe(2)
  })

  it('cleans up on exception so subsequent attempt with same key works', async () => {
    let callCount = 0
    const key = 'test-key-error'
    const fp = 'PATCH /api/progress/g01-l01'
    const now = new Date()

    await expect(
      executeIdempotent(db, 'alice', key, fp, now, async () => {
        callCount++
        throw new Error('database transient glitch')
      }),
    ).rejects.toThrow('database transient glitch')

    expect(callCount).toBe(1)

    // Subsequent call with same key should succeed
    const res = await executeIdempotent(db, 'alice', key, fp, now, async () => {
      callCount++
      return { statusCode: 200, body: { success: true } }
    })
    expect(res.statusCode).toBe(200)
    expect(res.replayed).toBe(false)
    expect(callCount).toBe(2)
  })

  it('isolates keys by user_id', async () => {
    const key = 'shared-key'
    const fp = 'PATCH /api/progress {}'
    const now = new Date()

    const resAlice = await executeIdempotent(
      db,
      'alice',
      key,
      fp,
      now,
      async () => ({ statusCode: 200, body: { user: 'alice' } }),
    )
    const resBob = await executeIdempotent(
      db,
      'bob',
      key,
      fp,
      now,
      async () => ({ statusCode: 200, body: { user: 'bob' } }),
    )

    expect(resAlice.body).toEqual({ user: 'alice' })
    expect(resBob.body).toEqual({ user: 'bob' })
    expect(resAlice.replayed).toBe(false)
    expect(resBob.replayed).toBe(false)
  })

  it('purges keys older than 24 hours on subsequent write', async () => {
    const oldKey = 'old-key'
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000) // 25 hours ago

    await executeIdempotent(
      db,
      'alice',
      oldKey,
      'POST /old {}',
      oldDate,
      async () => ({ statusCode: 200, body: { old: true } }),
    )

    // Verify it was stored
    let check = await db.query('SELECT * FROM idempotency_keys WHERE key = $1', [oldKey])
    expect(check.rows.length).toBe(1)

    // Run new request with current time
    const now = new Date()
    await executeIdempotent(
      db,
      'alice',
      'fresh-key',
      'POST /fresh {}',
      now,
      async () => ({ statusCode: 200, body: { fresh: true } }),
    )

    // Verify old key was purged
    check = await db.query('SELECT * FROM idempotency_keys WHERE key = $1', [oldKey])
    expect(check.rows.length).toBe(0)
  })
})

describe('http/errors module', () => {
  it('constructs HttpError with custom options and extra fields', () => {
    const err = new HttpError(400, 'invalid_status', {
      message: 'status is invalid',
      headers: { 'X-Custom': 'test' },
      extra: { allowed: ['a', 'b'] },
    })
    expect(err.status).toBe(400)
    expect(err.errorKey).toBe('invalid_status')
    expect(err.message).toBe('status is invalid')
    expect(err.toResponse()).toEqual({
      error: 'invalid_status',
      message: 'status is invalid',
      allowed: ['a', 'b'],
    })
  })

  it('factory helpers return expected HttpError instances', () => {
    const br = badRequest('invalid_request', { message: 'bad request' })
    expect(br.status).toBe(400)
    expect(br.errorKey).toBe('invalid_request')

    const unauth = unauthenticated('please login')
    expect(unauth.status).toBe(401)
    expect(unauth.errorKey).toBe('unauthenticated')

    const forb = forbidden()
    expect(forb.status).toBe(403)
    expect(forb.errorKey).toBe('forbidden')

    const nf = notFound()
    expect(nf.status).toBe(404)
    expect(nf.errorKey).toBe('not_found')

    const mna = methodNotAllowed('GET, POST')
    expect(mna.status).toBe(405)
    expect(mna.headers).toEqual({ Allow: 'GET, POST' })

    const ptl = payloadTooLarge()
    expect(ptl.status).toBe(413)
    expect(ptl.errorKey).toBe('payload_too_large')

    const ikr = idempotencyKeyReused()
    expect(ikr.status).toBe(422)
    expect(ikr.errorKey).toBe('idempotency_key_reused')

    const ie = internalError()
    expect(ie.status).toBe(500)
    expect(ie.errorKey).toBe('internal_error')
  })

  it('handleAppError formats responses correctly and sets Date/Cache-Control', async () => {
    const { Hono } = await import('hono')
    const testApp = new Hono()
    testApp.get('/error-http', () => {
      throw methodNotAllowed('GET')
    })
    testApp.post('/error-syntax', () => {
      throw new SyntaxError('Unexpected token')
    })
    testApp.get('/error-unknown', () => {
      throw new Error('secret db connection string leaked')
    })
    testApp.onError(handleAppError)

    // HttpError with headers
    const res1 = await testApp.request('/error-http')
    expect(res1.status).toBe(405)
    expect(res1.headers.get('allow')).toBe('GET')
    expect(res1.headers.get('date')).toBeTruthy()
    expect(res1.headers.get('cache-control')).toBe('no-store')
    expect(await res1.json()).toEqual({ error: 'method_not_allowed' })

    // SyntaxError
    const res2 = await testApp.request('/error-syntax', { method: 'POST' })
    expect(res2.status).toBe(400)
    expect(await res2.json()).toEqual({ error: 'invalid_request' })

    // Unknown error (never leaks stack or secrets)
    const res3 = await testApp.request('/error-unknown')
    expect(res3.status).toBe(500)
    const body3 = await res3.json()
    expect(body3).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(body3)).not.toContain('secret')
  })
})
