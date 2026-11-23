import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as mod from '../../docs/.vitepress/plugins/apiModePlugin.mjs'
import type { ApiHandler, ApiHandlerOptions } from '../../docs/.vitepress/plugins/apiModePlugin.mjs'

type Handler = ApiHandler

interface Started {
  url: string
  close: () => Promise<void>
  logs: string[]
  handler: Handler
}

async function start(opts: { mode: ApiHandlerOptions["mode"] } & Partial<ApiHandlerOptions>): Promise<Started> {
  const logs: string[] = []
  const handler = mod.createApiHandler({ sseFrameDelayMs: 0, slowMs: 50, log: (l: string) => logs.push(l), ...opts })
  const server = http.createServer((req, res) => {
    handler(req, res, () => {
      res.writeHead(299, { 'content-type': 'text/plain' })
      res.end('next')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    handler,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

const json = { 'content-type': 'application/json' }

describe('resolveApiMode', () => {
  it('defaults to off and rejects typos', () => {
    expect(mod.resolveApiMode({})).toBe('off')
    expect(mod.resolveApiMode({ LECTURE_API_MODE: 'MOCK' })).toBe('mock')
    expect(() => mod.resolveApiMode({ LECTURE_API_MODE: 'mok' })).toThrow(/invalid/)
  })

  it('plugin is dev-only', () => {
    const p = mod.apiModePlugin({ env: {} })
    expect(p.apply).toBe('serve')
    expect(p.name).toBe('lecture-api-mode')
  })
})

describe('off mode', () => {
  it('passes everything through', async () => {
    const s = await start({ mode: 'off' })
    const r = await fetch(`${s.url}/api/db/progress`)
    expect(r.status).toBe(299)
    await s.close()
  })
})

describe('mock mode', () => {
  let s: Started
  beforeAll(async () => {
    s = await start({ mode: 'mock' })
  })
  afterAll(async () => {
    await s.close()
  })
  afterEach(() => s.handler.reset())

  it('ignores non-/api paths and the export plugin path', async () => {
    expect((await fetch(`${s.url}/g01/L01`)).status).toBe(299)
    expect((await fetch(`${s.url}/api/generate-export?group=g01`)).status).toBe(299)
  })

  it('serves health and logs one line per request', async () => {
    const r = await fetch(`${s.url}/api/health`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; mode: string }
    expect(body).toMatchObject({ ok: true, mode: 'mock' })
    expect(s.logs.at(-1)).toMatch(/^\[api:mock\] GET \/api\/health 200 \d+ms scenario=default$/)
  })

  it('PATCH progress is reflected by GET progress', async () => {
    const before = await fetch(`${s.url}/api/db/progress?lecture_id=G01-L03`)
    expect(((await before.json()) as { status: string }).status).toBe('未开始')

    const patch = await fetch(`${s.url}/api/db/progress/g01-l03`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: '已完成', group_id: 'g01' }),
    })
    expect(patch.status).toBe(200)
    const patched = (await patch.json()) as { status: string; completed_at: string | null }
    expect(patched.status).toBe('已完成')
    expect(patched.completed_at).toBeTruthy()

    const after = await fetch(`${s.url}/api/db/progress?lecture_id=g01-l03`)
    expect(((await after.json()) as { status: string }).status).toBe('已完成')
    const group = (await (await fetch(`${s.url}/api/db/progress?group_id=g01`)).json()) as unknown[]
    expect(group).toHaveLength(3)
    expect(s.logs.some((l) => /PATCH \/api\/db\/progress\/g01-l03 200/.test(l))).toBe(true)
  })

  it('rejects invalid status with 400', async () => {
    const r = await fetch(`${s.url}/api/db/progress/g01-l01`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 'done' }),
    })
    expect(r.status).toBe(400)
  })

  it('batch upsert + reset restores fixtures', async () => {
    const r = await fetch(`${s.url}/api/db/progress/batch`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ items: [{ lecture_id: 'xr-l01', status: '学习中', group_id: 'xr' }] }),
    })
    expect(r.status).toBe(200)
    const state = (await (await fetch(`${s.url}/__debug/api/state`)).json()) as {
      mode: string
      state: { progress: Record<string, unknown> }
    }
    expect(state.mode).toBe('mock')
    expect(state.state.progress['xr-l01']).toBeTruthy()

    const reset = await fetch(`${s.url}/__debug/api/reset`, { method: 'POST' })
    expect(reset.status).toBe(200)
    const again = (await (await fetch(`${s.url}/__debug/api/state`)).json()) as {
      state: { progress: Record<string, unknown> }
    }
    expect(again.state.progress['xr-l01']).toBeUndefined()
  })

  it('sessions + messages CRUD', async () => {
    const list = (await (await fetch(`${s.url}/api/db/sessions?lecture_id=g01-l01`)).json()) as unknown[]
    expect(list).toHaveLength(2)
    const created = await fetch(`${s.url}/api/db/sessions`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: 'sess_new', lecture_id: 'g01-l01', group_id: 'g01', title: 't' }),
    })
    expect(created.status).toBe(201)
    await fetch(`${s.url}/api/db/messages`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ session_id: 'sess_new', role: 'user', content: 'hi' }),
    })
    const msgs = (await (await fetch(`${s.url}/api/db/messages?session_id=sess_new`)).json()) as unknown[]
    expect(msgs).toHaveLength(1)
    const del = await fetch(`${s.url}/api/db/sessions/sess_new`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    const msgsAfter = (await (await fetch(`${s.url}/api/db/messages?session_id=sess_new`)).json()) as unknown[]
    expect(msgsAfter).toHaveLength(0)
  })

  it('checklist is served under both /review-checklists and /checklist', async () => {
    const a = (await (await fetch(`${s.url}/api/db/review-checklists?lecture_id=g01-l01`)).json()) as unknown[]
    const b = (await (await fetch(`${s.url}/api/db/checklist?lecture_id=g01-l01`)).json()) as unknown[]
    expect(a).toHaveLength(2)
    expect(b).toEqual(a)
  })

  it('streams Dify-style SSE for /api/ai/chat', async () => {
    const r = await fetch(`${s.url}/api/ai/chat`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ inputs: {}, query: 'say "hi"', response_mode: 'streaming', conversation_id: '', user: 'u' }),
    })
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/)
    const text = await r.text()
    const frames = text.split('\n\n').filter(Boolean)
    const events = frames
      .map((f) => f.split('\n').find((l) => l.startsWith('data:')))
      .filter((l): l is string => !!l)
      .map((l) => JSON.parse(l.slice(5)) as { event: string; answer?: string; conversation_id?: string })
    expect(events.map((e) => e.event)).toContain('agent_thought')
    expect(events.at(-1)?.event).toBe('message_end')
    expect(events.find((e) => e.answer)?.answer).toContain('say "hi"')
    expect(events.at(-1)?.conversation_id).toMatch(/^conv_mock_/)
  })

  it('scenario=sse-error streams an error event', async () => {
    const r = await fetch(`${s.url}/api/ai/chat`, {
      method: 'POST',
      headers: { ...json, 'x-lecture-scenario': 'sse-error' },
      body: JSON.stringify({ query: 'x' }),
    })
    const text = await r.text()
    expect(text).toContain('"event":"error"')
    expect(text).not.toContain('message_end')
  })

  it('scenarios: offline / error / slow / empty via header, query and cookie', async () => {
    const off = await fetch(`${s.url}/api/db/progress?__scenario=offline`)
    expect(off.status).toBe(503)
    const err = await fetch(`${s.url}/api/db/progress`, { headers: { 'x-lecture-scenario': 'error' } })
    expect(err.status).toBe(500)
    const t0 = Date.now()
    const slow = await fetch(`${s.url}/api/health`, { headers: { cookie: 'a=1; lecture-scenario=slow' } })
    expect(slow.status).toBe(200)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
    const empty = (await (await fetch(`${s.url}/api/db/progress?__scenario=empty`)).json()) as unknown[]
    expect(empty).toEqual([])
    expect(s.logs.some((l) => l.endsWith('scenario=offline'))).toBe(true)
  })

  it('notion sync: primary, fallback scenario, upload', async () => {
    const body = JSON.stringify({ lecture_id: 'g01-l01', status: '已完成' })
    const ok = await fetch(`${s.url}/api/progress/notion-sync`, { method: 'POST', headers: json, body })
    expect(ok.status).toBe(200)
    const nf = await fetch(`${s.url}/api/progress/notion-sync?__scenario=notion-fallback`, { method: 'POST', headers: json, body })
    expect(nf.status).toBe(404)
    const fb = await fetch(`${s.url}/api/notion/sync-status`, { method: 'PATCH', headers: json, body })
    expect(fb.status).toBe(200)

    const form = new FormData()
    form.append('file', new Blob(['fake pptx bytes']), 'a.pptx')
    form.append('user', 'u')
    const up = await fetch(`${s.url}/api/ai/upload`, { method: 'POST', body: form })
    expect(up.status).toBe(200)
    const file = (await up.json()) as { id: string; extension: string }
    expect(file.id).toMatch(/^file_mock_/)
    expect(file.extension).toBe('pptx')
  })

  it('unknown /api route -> 404 json', async () => {
    const r = await fetch(`${s.url}/api/nope`)
    expect(r.status).toBe(404)
  })
})

describe('mock mode: backend contract (P3)', () => {
  let s: Started
  let clockMs = Date.parse('2026-11-18T08:30:00.000Z')
  const iso = (): string => new Date(clockMs).toISOString()
  beforeAll(async () => {
    s = await start({ mode: 'mock', now: () => clockMs })
  })
  afterAll(async () => {
    await s.close()
  })
  afterEach(() => {
    s.handler.reset()
    clockMs = Date.parse('2026-11-18T08:30:00.000Z')
  })

  const patch = (id: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${s.url}/api/db/progress/${id}`, { method: 'PATCH', headers: { ...json, ...headers }, body: JSON.stringify(body) })
  const batch = (items: unknown, headers: Record<string, string> = {}) =>
    fetch(`${s.url}/api/db/progress/batch`, { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify({ items }) })
  const progressOf = async (id: string) => (await (await fetch(`${s.url}/api/db/progress?lecture_id=${id}`)).json()) as Record<string, unknown>
  const progressCount = async () => ((await (await fetch(`${s.url}/__debug/api/state`)).json()) as { state: { counts: { progress: number; idempotencyKeys: number } } }).state.counts

  it('every response carries a Date header (the mock clock), including errors and debug endpoints', async () => {
    const expected = new Date(clockMs).toUTCString()
    for (const url of ['/api/health', '/api/nope', '/api/db/progress', '/__debug/api/state', '/api/auth/session']) {
      const r = await fetch(`${s.url}${url}`)
      expect(r.headers.get('date'), url).toBe(expected)
    }
    const sse = await fetch(`${s.url}/api/ai/chat`, { method: 'POST', headers: json, body: '{}' })
    expect(sse.headers.get('date')).toBe(expected)
    await sse.text()
  })

  it('the server sets updated_at and completed_at; values in the request body are ignored', async () => {
    const r = await patch('g01-l03', { status: '已完成', group_id: 'g01', updated_at: '2001-01-01T00:00:00.000Z', completed_at: '2002-02-02T00:00:00.000Z' })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ lecture_id: 'g01-l03', status: '已完成', updated_at: iso(), completed_at: iso() })

    clockMs += 60_000
    const again = (await (await patch('g01-l03', { status: '已完成' })).json()) as Record<string, unknown>
    expect(again.completed_at).toBe('2026-11-18T08:30:00.000Z') // stays: it was already completed
    expect(again.updated_at).toBe(iso())

    const left = (await (await patch('g01-l03', { status: '学习中' })).json()) as Record<string, unknown>
    expect(left.completed_at).toBeNull()
  })

  it('PATCH needs a valid status', async () => {
    expect((await patch('g01-l03', { group_id: 'g01' })).status).toBe(400)
    expect((await patch('g01-l03', { status: 'done' })).status).toBe(400)
  })

  it('Idempotency-Key: the same key and request replays the first response and writes once', async () => {
    const first = await patch('g01-l03', { status: '学习中', group_id: 'g01' }, { 'idempotency-key': 'k-1' })
    const firstBody = (await first.json()) as Record<string, unknown>
    expect(first.status).toBe(200)
    expect(first.headers.get('idempotency-replayed')).toBeNull()

    clockMs += 5000
    const second = await patch('g01-l03', { group_id: 'g01', status: '学习中' }, { 'idempotency-key': 'k-1' }) // same content, other key order
    expect(second.status).toBe(200)
    expect(second.headers.get('idempotency-replayed')).toBe('true')
    expect(await second.json()).toEqual(firstBody) // identical, including the first updated_at
    expect((await progressOf('g01-l03')).updated_at).toBe(firstBody.updated_at)
    expect((await progressCount()).idempotencyKeys).toBe(1)
  })

  it('the same key with another request is 422 idempotency_key_reused and changes nothing', async () => {
    await patch('g01-l03', { status: '学习中' }, { 'idempotency-key': 'k-2' })
    const reused = await patch('g01-l03', { status: '已完成' }, { 'idempotency-key': 'k-2' })
    expect(reused.status).toBe(422)
    expect(((await reused.json()) as { error: string }).error).toBe('idempotency_key_reused')
    expect((await progressOf('g01-l03')).status).toBe('学习中')
    // another lecture under the same key is a different request too
    expect((await patch('g01-l02', { status: '学习中' }, { 'idempotency-key': 'k-2' })).status).toBe(422)
  })

  it('a key is forgotten after 24 hours', async () => {
    await patch('g01-l03', { status: '学习中' }, { 'idempotency-key': 'k-3' })
    clockMs += 25 * 60 * 60 * 1000
    const later = await patch('g01-l03', { status: '已完成' }, { 'idempotency-key': 'k-3' })
    expect(later.status).toBe(200)
    expect(later.headers.get('idempotency-replayed')).toBeNull()
    expect((await progressOf('g01-l03')).status).toBe('已完成')
  })

  it('only successful responses are remembered', async () => {
    expect((await patch('g01-l03', { status: 'bogus' }, { 'idempotency-key': 'k-4' })).status).toBe(400)
    const retry = await patch('g01-l03', { status: '学习中' }, { 'idempotency-key': 'k-4' })
    expect(retry.status).toBe(200)
  })

  it('batch is atomic: one invalid item writes nothing', async () => {
    const before = await progressCount()
    const r = await batch([
      { lecture_id: 'xr-l01', status: '已完成', group_id: 'xr' },
      { lecture_id: 'xr-l02', status: 'not-a-status', group_id: 'xr' },
    ])
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('invalid_status')
    expect((await progressCount()).progress).toBe(before.progress)
    expect((await fetch(`${s.url}/api/db/progress?lecture_id=xr-l01`)).status).toBe(404)
    expect((await batch([{ status: '已完成' }])).status).toBe(400) // item without lecture_id
    expect((await batch('nope')).status).toBe(400)
  })

  it('batch accepts at most 200 items and answers in request order', async () => {
    const many = Array.from({ length: 201 }, (_v, i) => ({ lecture_id: `x-l${i}`, status: '学习中', group_id: 'x' }))
    expect((await batch(many)).status).toBe(400)
    const r = await batch(many.slice(0, 200).reverse())
    expect(r.status).toBe(200)
    const out = (await r.json()) as Array<{ lecture_id: string; updated_at: string }>
    expect(out).toHaveLength(200)
    expect(out[0]?.lecture_id).toBe('x-l199')
    expect(out.every((o) => o.updated_at === iso())).toBe(true)
  })

  it('batch honours Idempotency-Key like PATCH', async () => {
    const items = [{ lecture_id: 'xr-l01', status: '已完成', group_id: 'xr' }]
    const first = await batch(items, { 'idempotency-key': 'b-1' })
    const body = await first.json()
    clockMs += 1000
    const replay = await batch(items, { 'idempotency-key': 'b-1' })
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(await replay.json()).toEqual(body)
    expect((await batch([{ lecture_id: 'xr-l01', status: '学习中', group_id: 'xr' }], { 'idempotency-key': 'b-1' })).status).toBe(422)
  })

  it('scenario legacy-backend: unfiltered GET is 400, filtered reads work, session is 404, Idempotency-Key is ignored', async () => {
    const h = { 'x-lecture-scenario': 'legacy-backend' }
    const all = await fetch(`${s.url}/api/db/progress`, { headers: h })
    expect(all.status).toBe(400)
    const group = await fetch(`${s.url}/api/db/progress?group_id=g01`, { headers: h })
    expect(group.status).toBe(200)
    expect(((await group.json()) as unknown[]).length).toBe(3)
    expect((await fetch(`${s.url}/api/auth/session`, { headers: h })).status).toBe(404)

    const a = await patch('g01-l03', { status: '学习中' }, { ...h, 'idempotency-key': 'legacy' })
    const b = await patch('g01-l03', { status: '已完成' }, { ...h, 'idempotency-key': 'legacy' })
    expect([a.status, b.status]).toEqual([200, 200])
    expect(b.headers.get('idempotency-replayed')).toBeNull()
    expect((await progressOf('g01-l03')).status).toBe('已完成')
  })

  it('scenario reject-writes: progress writes are 422, reads are unaffected', async () => {
    const h = { 'x-lecture-scenario': 'reject-writes' }
    expect((await patch('g01-l03', { status: '已完成' }, h)).status).toBe(422)
    expect((await batch([{ lecture_id: 'xr-l01', status: '已完成' }], h)).status).toBe(422)
    expect((await fetch(`${s.url}/api/db/progress`, { headers: h })).status).toBe(200)
    expect((await progressOf('g01-l03')).status).toBe('未开始')
  })

  it('GET /api/auth/session: anonymous by default, alice and bob by scenario, GET only', async () => {
    const anon = await fetch(`${s.url}/api/auth/session`)
    expect(anon.status).toBe(200)
    expect(anon.headers.get('cache-control')).toBe('no-store')
    expect(await anon.json()).toEqual({ authenticated: false, user: null, roles: ['reader'], groups: [], logoutUrl: null })

    const alice = (await (await fetch(`${s.url}/api/auth/session?__scenario=user-alice`)).json()) as { authenticated: boolean; user: { id: string }; roles: string[]; groups: string[] }
    const bob = (await (await fetch(`${s.url}/api/auth/session`, { headers: { 'x-lecture-scenario': 'user-bob' } })).json()) as typeof alice
    expect(alice).toMatchObject({ authenticated: true, user: { id: 'alice' }, roles: ['reader', 'admin'] })
    expect(bob).toMatchObject({ authenticated: true, user: { id: 'bob' }, roles: ['reader'] })
    expect(alice.user.id).not.toBe(bob.user.id)

    expect((await fetch(`${s.url}/api/auth/session`, { method: 'POST' })).status).toBe(405)
  })

  it('the new scenarios are listed, and reset clears the remembered keys', async () => {
    const list = (await (await fetch(`${s.url}/__debug/api/scenarios`)).json()) as { scenarios: Record<string, string> }
    for (const name of ['legacy-backend', 'reject-writes', 'user-alice', 'user-bob']) expect(list.scenarios[name], name).toBeTruthy()
    await patch('g01-l03', { status: '学习中' }, { 'idempotency-key': 'k-9' })
    expect((await progressCount()).idempotencyKeys).toBe(1)
    await fetch(`${s.url}/__debug/api/reset`, { method: 'POST' })
    expect((await progressCount()).idempotencyKeys).toBe(0)
  })
})

describe('proxy mode', () => {
  it('fails fast without LECTURE_API_ORIGIN', () => {
    expect(() => mod.createApiHandler({ mode: 'proxy' })).toThrow(/LECTURE_API_ORIGIN/)
    expect(() => mod.createApiHandler({ mode: 'proxy', origin: 'ftp://x' })).toThrow(/http/)
  })

  it('forwards requests (incl. SSE), strips scenario header, never logs bodies', async () => {
    const seen: Array<{ url: string; scenario: unknown; auth: unknown; body: string }> = []
    const upstream = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString()))
      req.on('end', () => {
        seen.push({ url: req.url || '', scenario: req.headers['x-lecture-scenario'], auth: req.headers.authorization, body })
        if (req.url?.startsWith('/base/api/ai/chat')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write('data: {"event":"message","answer":"a"}\n\n')
          setTimeout(() => {
            res.write('data: {"event":"message_end"}\n\n')
            res.end()
          }, 20)
          return
        }
        res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': '1' })
        res.end('{"ok":true}')
      })
    })
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    const { port } = upstream.address() as AddressInfo
    const s = await start({ mode: 'proxy', origin: `http://127.0.0.1:${port}/base/` })

    const r = await fetch(`${s.url}/api/db/progress/g01-l01?x=1&__scenario=default`, {
      method: 'PATCH',
      headers: { ...json, authorization: 'Bearer SECRET_TOKEN', 'x-lecture-scenario': 'default' },
      body: JSON.stringify({ status: '已完成', secret: 'BODY_SECRET' }),
    })
    expect(r.status).toBe(201)
    expect(r.headers.get('x-upstream')).toBe('1')
    const first = seen[0]
    if (!first) throw new Error('upstream received no request')
    expect(first.url).toBe('/base/api/db/progress/g01-l01?x=1')
    expect(first.scenario).toBeUndefined()
    expect(first.auth).toBe('Bearer SECRET_TOKEN')
    expect(first.body).toContain('BODY_SECRET')

    const sse = await fetch(`${s.url}/api/ai/chat`, { method: 'POST', headers: json, body: '{}' })
    expect(sse.headers.get('content-type')).toMatch(/event-stream/)
    expect(await sse.text()).toContain('message_end')

    const offline = await fetch(`${s.url}/api/db/progress?__scenario=offline`)
    expect(offline.status).toBe(503)
    expect(seen).toHaveLength(2) // offline short-circuits locally

    const joined = s.logs.join('\n')
    expect(joined).toMatch(/\[api:proxy\] PATCH \/api\/db\/progress\/g01-l01 201 \d+ms scenario=default/)
    expect(joined).not.toContain('SECRET')
    await s.close()
    await new Promise<void>((r2) => upstream.close(() => r2()))
  })

  it('returns 502 when upstream is unreachable', async () => {
    const s = await start({ mode: 'proxy', origin: 'http://127.0.0.1:1' })
    const r = await fetch(`${s.url}/api/health`)
    expect(r.status).toBe(502)
    expect(((await r.json()) as { error: string }).error).toBe('proxy_upstream_error')
    await s.close()
  })
})
