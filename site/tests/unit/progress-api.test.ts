import { describe, expect, it } from 'vitest'
import { BATCH_SIZE, batchIdempotencyKey, createLocalBackend, createRestBackend, fromWireRecord, toSendError, toWireWrite } from '../../docs/.vitepress/theme/api/progress'
import { isWireProgress, isWireSession } from '../../docs/.vitepress/theme/api/contract'
import { parseRetryAfter, parseServerDate, request } from '../../docs/.vitepress/theme/api/http'
import type { OutboxOp } from '../../docs/.vitepress/theme/progress/types'
import { PROGRESS_WIRE_STATUS } from '../../docs/.vitepress/site.config.mts'
import { fakeFetch, op } from './progress-helpers'

const W = PROGRESS_WIRE_STATUS
const wire = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ lecture_id: id, group_id: id.split('-')[0], status, completed_at: null, updated_at: '2026-11-18T08:30:00.000Z', notion_node_id: null, notion_page_id: null, ...extra })

function rest(handler: Parameters<typeof fakeFetch>[0], groups: string[] = ['g01', 'g02']) {
  const f = fakeFetch(handler)
  return { ...f, backend: createRestBackend({ endpoint: '/api/db', groupIds: () => groups, fetchImpl: f.fetch, timeoutMs: 500 }) }
}

describe('wire conversion', () => {
  it('toWireWrite speaks Chinese statuses and ISO times', () => {
    const w = toWireWrite({ lectureId: 'g05-l19', groupId: 'g05', status: 'in_progress', at: Date.parse('2026-11-18T08:30:00.000Z') })
    expect(w).toEqual({ lecture_id: 'g05-l19', group_id: 'g05', status: W.in_progress, updated_at: '2026-11-18T08:30:00.000Z' })
  })

  it('fromWireRecord maps every status back, lower-cases ids and fills missing optional fields', () => {
    expect(fromWireRecord({ lecture_id: 'G05-L19', status: W.completed, completed_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z', notion_node_id: 'n', notion_page_id: 'p' })).toEqual({
      lectureId: 'g05-l19',
      groupId: 'g05',
      status: 'completed',
      completedAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      notionNodeId: 'n',
      notionPageId: 'p',
    })
    expect(fromWireRecord({ lecture_id: 'lr-l03', group_id: 'LR', status: W.not_started })).toMatchObject({ groupId: 'lr', status: 'not_started', updatedAt: null, completedAt: null })
    expect(fromWireRecord({ lecture_id: 'x-l1', status: 'unknown' as never })).toBeNull()
  })

  it('guards accept the contract shapes and reject the rest', () => {
    expect(isWireProgress(wire('g01-l01', W.completed))).toBe(true)
    expect(isWireProgress({ lecture_id: 'g01-l01', status: W.completed })).toBe(true) // optional fields may be missing
    expect(isWireProgress(wire('g01-l01', 'done'))).toBe(false)
    expect(isWireProgress({ status: W.completed })).toBe(false)
    expect(isWireProgress(wire('g01-l01', W.completed, { updated_at: 5 }))).toBe(false)
    expect(isWireProgress(null)).toBe(false)
    const session = { authenticated: true, user: { id: 'alice', name: 'A', email: null }, roles: ['reader'], groups: [], logoutUrl: null }
    expect(isWireSession(session)).toBe(true)
    expect(isWireSession({ authenticated: false, user: null, roles: ['reader'], groups: [], logoutUrl: null })).toBe(true)
    expect(isWireSession({ ...session, user: null })).toBe(false) // authenticated needs a user
    expect(isWireSession({ ...session, roles: 'reader' })).toBe(false)
    expect(isWireSession({ ...session, user: { id: '' } })).toBe(false)
    expect(isWireSession([])).toBe(false)
  })
})

describe('local backend', () => {
  it('reads nothing and accepts every write at once, with records made from the operations', async () => {
    const b = createLocalBackend()
    expect(b.kind).toBe('local')
    expect(await b.fetchAll()).toMatchObject({ ok: true, records: [] })
    const at = Date.parse('2026-11-18T08:30:00.000Z')
    const r = await b.send([op('g01-l01', 'completed', at), op('g01-l02', 'in_progress', at)])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.records.map((x) => [x.lectureId, x.status, x.updatedAt, x.completedAt])).toEqual([
      ['g01-l01', 'completed', '2026-11-18T08:30:00.000Z', '2026-11-18T08:30:00.000Z'],
      ['g01-l02', 'in_progress', '2026-11-18T08:30:00.000Z', null],
    ])
  })
})

describe('rest backend: reading', () => {
  it('reads everything with one unfiltered request', async () => {
    const { backend, calls } = rest(() => ({ status: 200, body: [wire('g01-l01', W.completed), wire('g02-l01', W.in_progress), { junk: true }], headers: { date: 'Wed, 18 Nov 2026 08:30:00 GMT' } }))
    const r = await backend.fetchAll()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/db/progress'])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.records.map((x) => [x.lectureId, x.status])).toEqual([['g01-l01', 'completed'], ['g02-l01', 'in_progress']]) // the junk item is skipped
    expect(r.unfilteredGet).toBe(true)
    expect(r.serverDate).toBe(Date.parse('2026-11-18T08:30:00.000Z'))
  })

  it.each([400, 404, 422])('falls back to one request per group when the unfiltered read answers %i', async (status) => {
    const { backend, calls } = rest((req) => {
      if (req.url === '/api/db/progress') return { status }
      if (req.url.endsWith('group_id=g01')) return { status: 200, body: [wire('g01-l01', W.completed)] }
      if (req.url.endsWith('group_id=g02')) return { status: 404 } // a group the backend knows nothing about = empty
      return { status: 500 }
    })
    const r = await backend.fetchAll()
    expect(calls.map((c) => c.url)).toEqual(['/api/db/progress', '/api/db/progress?group_id=g01', '/api/db/progress?group_id=g02'])
    expect(r.ok && r.unfilteredGet).toBe(false)
    expect(r.ok && r.records.map((x) => x.lectureId)).toEqual(['g01-l01'])
  })

  it('upper-case and duplicate group ids are normalised in the fallback', async () => {
    const { backend, calls } = rest((req) => (req.url === '/api/db/progress' ? { status: 400 } : { status: 200, body: [] }), ['G01', 'g01', 'LR'])
    await backend.fetchAll()
    expect(calls.slice(1).map((c) => c.url)).toEqual(['/api/db/progress?group_id=g01', '/api/db/progress?group_id=lr'])
  })

  it('a failing group request fails the read instead of silently dropping that group', async () => {
    const { backend } = rest((req) => (req.url === '/api/db/progress' ? { status: 400 } : req.url.endsWith('g02') ? { status: 503 } : { status: 200, body: [] }))
    const r = await backend.fetchAll()
    expect(r).toEqual({ ok: false, error: { retryable: true, status: 503 } })
  })

  it('other failures are reported, not retried by falling back', async () => {
    const { backend, calls } = rest(() => ({ status: 503, headers: { 'retry-after': '3' } }))
    const r = await backend.fetchAll()
    expect(r).toEqual({ ok: false, error: { retryable: true, status: 503, retryAfterMs: 3000 } })
    expect(calls).toHaveLength(1)
  })
})

describe('rest backend: writing', () => {
  it('one operation is a PATCH with the operation id as Idempotency-Key and a Chinese status', async () => {
    const o = op('g05-l19', 'completed', Date.parse('2026-11-18T08:30:00.000Z'), { id: 'op-uuid-1' })
    const { backend, calls } = rest(() => ({ status: 200, body: wire('g05-l19', W.completed, { completed_at: '2026-11-18T08:31:00.000Z', updated_at: '2026-11-18T08:31:00.000Z' }), headers: { date: 'Wed, 18 Nov 2026 08:31:05 GMT' } }))
    const r = await backend.send([o])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: '/api/db/progress/g05-l19', headers: { 'idempotency-key': 'op-uuid-1', 'content-type': 'application/json' } })
    expect(calls[0]?.body).toEqual({ lecture_id: 'g05-l19', group_id: 'g05', status: W.completed, updated_at: '2026-11-18T08:30:00.000Z' })
    expect(r.ok && r.records[0]).toMatchObject({ lectureId: 'g05-l19', status: 'completed', updatedAt: '2026-11-18T08:31:00.000Z' })
    expect(r.ok && r.serverDate).toBe(Date.parse('2026-11-18T08:31:05.000Z'))
  })

  it('the single-operation key stays the same across retries', async () => {
    const o = op('g01-l01', 'completed', 1, { id: 'stable-id' })
    let n = 0
    const { backend, calls } = rest(() => (++n < 3 ? { status: 503 } : { status: 200, body: wire('g01-l01', W.completed) }))
    expect((await backend.send([o])).ok).toBe(false)
    expect((await backend.send([o])).ok).toBe(false)
    expect((await backend.send([o])).ok).toBe(true)
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['stable-id', 'stable-id', 'stable-id'])
  })

  it('two or more operations are one POST /batch; the key is stable across retries and independent of order', async () => {
    const ops = [op('g01-l01', 'completed', 1, { id: 'a' }), op('g01-l02', 'completed', 1, { id: 'b' }), op('g01-l03', 'in_progress', 1, { id: 'c' })]
    let n = 0
    const { backend, calls } = rest((req) => {
      if (++n === 1) return { status: 502 }
      const items = (req.body as { items: Array<{ lecture_id: string; status: string }> }).items
      return { status: 200, body: items.map((i) => wire(i.lecture_id, i.status)) }
    })
    expect((await backend.send(ops)).ok).toBe(false)
    const second = await backend.send([...ops].reverse())
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST /api/db/progress/batch', 'POST /api/db/progress/batch'])
    const keys = calls.map((c) => c.headers['idempotency-key'])
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toMatch(/^batch-[0-9a-f]{8}$/)
    expect((calls[0]?.body as { items: unknown[] }).items).toHaveLength(3)
    expect(second.ok && second.records.map((r) => r.lectureId)).toEqual(['g01-l03', 'g01-l02', 'g01-l01']) // same order as sent
    expect(batchIdempotencyKey(ops.slice(0, 2))).not.toBe(batchIdempotencyKey(ops))
  })

  it('cuts a large batch into requests of 200, each with its own stable key', async () => {
    const ops: OutboxOp[] = Array.from({ length: 450 }, (_v, i) => op(`g01-l${String(i + 1).padStart(3, '0')}`, 'completed', i, { id: `id-${i}` }))
    const run = async () => {
      const { backend, calls } = rest((req) => {
        const items = (req.body as { items: Array<{ lecture_id: string; status: string }> }).items
        return { status: 200, body: items.map((i) => wire(i.lecture_id, i.status)) }
      })
      const r = await backend.send(ops)
      return { r, calls }
    }
    const first = await run()
    expect(BATCH_SIZE).toBe(200)
    expect(first.calls.map((c) => (c.body as { items: unknown[] }).items.length)).toEqual([200, 200, 50])
    expect(first.r.ok && first.r.records).toHaveLength(450)
    const second = await run()
    expect(second.calls.map((c) => c.headers['idempotency-key'])).toEqual(first.calls.map((c) => c.headers['idempotency-key']))
    expect(new Set(first.calls.map((c) => c.headers['idempotency-key'])).size).toBe(3)
  })

  it('a failing chunk fails the whole send', async () => {
    const ops = Array.from({ length: 250 }, (_v, i) => op(`g01-l${i}`, 'completed', i, { id: `id-${i}` }))
    let n = 0
    const { backend } = rest((req) => (++n === 2 ? { status: 429, headers: { 'retry-after': '9' } } : { status: 200, body: (req.body as { items: Array<{ lecture_id: string; status: string }> }).items.map((i) => wire(i.lecture_id, i.status)) }))
    expect(await backend.send(ops)).toEqual({ ok: false, error: { retryable: true, status: 429, retryAfterMs: 9000 } })
  })

  it('sending nothing is a success without a request', async () => {
    const { backend, calls } = rest(() => ({ status: 200 }))
    expect(await backend.send([])).toMatchObject({ ok: true, records: [] })
    expect(calls).toHaveLength(0)
  })

  it('a 2xx with JSON that is not a record, or an empty body, still counts as sent (legacy backend)', async () => {
    const o = op('g01-l01', 'completed', Date.parse('2026-11-18T08:30:00.000Z'))
    const ok = rest(() => ({ status: 200, body: { ok: true } }))
    const r1 = await ok.backend.send([o])
    expect(r1.ok && r1.records[0]).toMatchObject({ lectureId: 'g01-l01', status: 'completed', updatedAt: null })
    const empty = rest(() => ({ status: 204 }))
    expect((await empty.backend.send([o])).ok).toBe(true)
  })

  it('a 2xx that is not JSON (an HTML page from a proxy) is NOT sent: the write stays and is retried', async () => {
    const o = op('g01-l01', 'completed', Date.parse('2026-11-18T08:30:00.000Z'))
    const html = rest(() => ({ status: 200, body: '<!doctype html><title>index</title>' }))
    expect(await html.backend.send([o])).toEqual({ ok: false, error: { retryable: true, status: 200 } })
    const batch = rest(() => ({ status: 200, body: 'OK' }))
    expect(await batch.backend.send([o, op('g01-l02', 'completed', 1)])).toMatchObject({ ok: false, error: { retryable: true } })
  })

  it('an expired sign-in (the gateway redirects to its login page) is retried, never counted as sent', async () => {
    const o = op('g01-l01', 'completed', Date.parse('2026-11-18T08:30:00.000Z'))
    const login = rest(() => ({ status: 302, headers: { location: 'https://auth.example.com/?rd=x' } }))
    expect(await login.backend.send([o])).toEqual({ ok: false, error: { retryable: true, status: 0 } })
    expect(await login.backend.fetchAll()).toEqual({ ok: false, error: { retryable: true, status: 0 } })
  })

  it('encodes the lecture id in the path', async () => {
    const { backend, calls } = rest(() => ({ status: 200, body: wire('g01-l01', W.completed) }))
    await backend.send([op('g01/../x', 'completed', 1)])
    expect(calls[0]?.url).toBe('/api/db/progress/g01%2F..%2Fx')
  })

  it('honours a trailing slash and another base path', async () => {
    const f = fakeFetch(() => ({ status: 200, body: [] }))
    await createRestBackend({ endpoint: '/svc/v2/', groupIds: () => [], fetchImpl: f.fetch }).fetchAll()
    expect(f.calls[0]?.url).toBe('/svc/v2/progress')
  })
})

describe('error classification', () => {
  const http = (status: number, extra: object = {}) => toSendError({ ok: false, kind: 'http', status, serverDate: null, ...extra })

  it('retries network, timeout, 5xx, 408 and 429', () => {
    expect(toSendError({ ok: false, kind: 'network', serverDate: null })).toEqual({ retryable: true })
    expect(toSendError({ ok: false, kind: 'timeout', serverDate: null })).toEqual({ retryable: true })
    for (const s of [500, 502, 503, 599, 408, 429]) expect(http(s).retryable, String(s)).toBe(true)
  })

  it('treats every other 4xx as a refusal', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(http(s).retryable, String(s)).toBe(false)
  })

  it('retries a 2xx that is not JSON and a redirect (the backend never saw the write)', () => {
    expect(toSendError({ ok: false, kind: 'parse', status: 200, serverDate: null })).toEqual({ retryable: true, status: 200 })
    expect(toSendError({ ok: false, kind: 'redirect', serverDate: null })).toEqual({ retryable: true, status: 0 })
  })

  it('carries the status and Retry-After', () => {
    expect(http(429, { retryAfterMs: 12_000 })).toEqual({ retryable: true, status: 429, retryAfterMs: 12_000 })
  })
})

describe('http request', () => {
  it('returns network without throwing when there is no fetch (SSR)', async () => {
    expect(await request('GET', '/api/x')).toEqual({ ok: false, kind: 'network', serverDate: null })
  })

  it('classifies a thrown fetch as network and a hung fetch as timeout', async () => {
    const down = fakeFetch(() => new Error('connection refused'))
    expect(await request('GET', '/x', { fetchImpl: down.fetch })).toMatchObject({ ok: false, kind: 'network' })
    const hung = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'))
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof fetch
    expect(await request('GET', '/x', { fetchImpl: hung, timeoutMs: 20 })).toMatchObject({ ok: false, kind: 'timeout' })
  })

  it('an aborted caller signal reads as network, not timeout', async () => {
    const hung = (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'))
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as typeof fetch
    const ctl = new AbortController()
    const p = request('GET', '/x', { fetchImpl: hung, signal: ctl.signal, timeoutMs: 5000 })
    ctl.abort()
    expect(await p).toMatchObject({ ok: false, kind: 'network' })
    expect(await request('GET', '/x', { fetchImpl: hung, signal: ctl.signal })).toMatchObject({ ok: false, kind: 'network' })
  })

  it('does not follow redirects: a 3xx, an opaque redirect or a followed one all come back as kind redirect', async () => {
    let init: RequestInit | undefined
    const capture = (async (_u: RequestInfo | URL, i?: RequestInit) => {
      init = i
      return new Response(null, { status: 302, headers: { location: '/login' } })
    }) as typeof fetch
    expect(await request('PATCH', '/x', { fetchImpl: capture, body: {} })).toEqual({ ok: false, kind: 'redirect', serverDate: null })
    expect(init?.redirect).toBe('manual')
    const opaque = (async () => ({ type: 'opaqueredirect', status: 0, ok: false, redirected: false, headers: new Headers() }) as unknown as Response) as typeof fetch
    expect(await request('GET', '/x', { fetchImpl: opaque })).toMatchObject({ ok: false, kind: 'redirect' })
    const followed = (async () => {
      const r = new Response('<html></html>', { status: 200 })
      Object.defineProperty(r, 'redirected', { value: true })
      return r
    }) as typeof fetch
    expect(await request('GET', '/x', { fetchImpl: followed })).toMatchObject({ ok: false, kind: 'redirect' })
  })

  it('a 2xx with an invalid body is a parse failure; an empty body is null data', async () => {
    const bad = fakeFetch(() => ({ status: 200, body: 'not json' }))
    expect(await request('GET', '/x', { fetchImpl: bad.fetch })).toMatchObject({ ok: false, kind: 'parse', status: 200 })
    const empty = fakeFetch(() => ({ status: 204 }))
    expect(await request('GET', '/x', { fetchImpl: empty.fetch })).toMatchObject({ ok: true, status: 204, data: null })
  })

  it('reads the Date header on success and on failure', async () => {
    const date = 'Wed, 18 Nov 2026 08:30:00 GMT'
    const ok = fakeFetch(() => ({ status: 200, body: {}, headers: { date } }))
    expect(await request('GET', '/x', { fetchImpl: ok.fetch })).toMatchObject({ ok: true, serverDate: Date.parse(date) })
    const no = fakeFetch(() => ({ status: 500, headers: { date } }))
    expect(await request('GET', '/x', { fetchImpl: no.fetch })).toMatchObject({ ok: false, kind: 'http', status: 500, serverDate: Date.parse(date) })
  })

  it('sends JSON bodies with a content type, and no body for GET', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }))
    await request('POST', '/x', { fetchImpl: f.fetch, body: { a: 1 }, headers: { 'idempotency-key': 'k' } })
    await request('GET', '/x', { fetchImpl: f.fetch })
    expect(f.calls[0]).toMatchObject({ method: 'POST', body: { a: 1 }, headers: { 'content-type': 'application/json', 'idempotency-key': 'k' } })
    expect(f.calls[1]?.headers['content-type']).toBeUndefined()
  })

  it('parses Retry-After in seconds and as an HTTP date; Date headers that are not dates are null', () => {
    expect(parseRetryAfter('7', 0)).toBe(7000)
    expect(parseRetryAfter('0', 0)).toBe(0)
    expect(parseRetryAfter('Wed, 18 Nov 2026 08:30:10 GMT', Date.parse('2026-11-18T08:30:00.000Z'))).toBe(10_000)
    expect(parseRetryAfter('Wed, 18 Nov 2026 08:29:00 GMT', Date.parse('2026-11-18T08:30:00.000Z'))).toBe(0)
    expect(parseRetryAfter('soon', 0)).toBeUndefined()
    expect(parseRetryAfter(null, 0)).toBeUndefined()
    expect(parseServerDate('garbage')).toBeNull()
    expect(parseServerDate(null)).toBeNull()
  })
})
