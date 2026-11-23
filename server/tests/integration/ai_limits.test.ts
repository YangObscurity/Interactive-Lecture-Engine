import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import { AiRequestLimiter, ConcurrencyGate, TokenBucket } from '../../src/http/rateLimit.js'

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
    authRoleMap: { admins: ['admin'] },
    logoutUrl: null,
    dbAutoMigrate: false,
    notionHealthUrl: null,
    allowNonLoopback: false,
    logLevel: 'info',
    aiProvider: 'dify',
    difyApiBase: 'http://127.0.0.1:1',
    difyApiKey: 'dify-key',
    openaiApiBase: 'http://127.0.0.1:1',
    openaiApiKey: 'openai-key',
    openaiModel: 'gpt-4o-mini',
    aiUpstreamTimeoutMs: 5000,
    aiUploadMaxBytes: 1024 * 1024,
    aiAllowAnonymous: false,
    aiRatePerMinute: 600,
    aiMaxConcurrent: 20,
    aiDailyLimit: 100000,
    writeRatePerMinute: 6000,
    aiQueryMaxBytes: 8192,
    aiInputsMaxBytes: 32768,
    aiStreamMaxMs: 300000,
    aiAccessLog: false,
    aiPromptsFile: fileURLToPath(new URL('../fixtures/companion-v1.json', import.meta.url)),
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

type Behavior = 'ok' | 'midfail' | 'late_second' | 'hold' | 'hang' | 'upload'

describe('AI limits, input whitelist, SSE failure semantics (WP-B1)', () => {
  let db: Db
  let mock: Server
  let base = ''
  let behavior: Behavior = 'ok'
  let lastBody: Record<string, unknown> | null = null
  const held: ServerResponse[] = []

  beforeAll(async () => {
    db = createDb('pglite:memory')
    await runMigrations(db)
    await new Promise<void>((resolve) => {
      mock = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          if (req.url?.includes('/files/upload')) {
            res.writeHead(201, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ id: 'file_1', name: 'a.pdf', size: 4, extension: 'pdf', mime_type: 'application/pdf', created_at: 1 }))
            return
          }
          try {
            lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          } catch {
            lastBody = null
          }
          if (behavior === 'hang') return
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          const frame = (answer: string) =>
            `data: {"event":"agent_message","conversation_id":"c1","answer":"${answer}"}\n\n`
          if (behavior === 'ok') {
            res.write(frame('hi'))
            res.end('data: {"event":"message_end"}\n\n')
          } else if (behavior === 'midfail') {
            res.write(frame('partial'))
            setTimeout(() => res.destroy(), 50)
          } else if (behavior === 'late_second') {
            setTimeout(() => res.write(frame('first')), 50)
            setTimeout(() => res.end(frame('second') + 'data: {"event":"message_end"}\n\n'), 400)
          } else if (behavior === 'hold') {
            held.push(res)
            res.write(frame('held'))
          }
        })
      })
      mock.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`
        resolve()
      })
    })
  })

  afterEach(() => {
    for (const r of held.splice(0)) r.destroy()
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    mock.closeAllConnections()
    await new Promise<void>((resolve) => mock.close(() => resolve()))
    await db.close()
  })

  const post = (app: ReturnType<typeof createApp>, user: string, body: unknown) =>
    app.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Remote-User': user, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('returns 429 with Retry-After per user and does not share buckets between users', async () => {
    behavior = 'ok'
    const app = createApp(makeConfig({ difyApiBase: base, aiRatePerMinute: 2 }), db)
    for (let i = 0; i < 2; i++) {
      const r = await post(app, 'alice', { query: 'q' })
      expect(r.status).toBe(200)
      await r.text()
    }
    const limited = await post(app, 'alice', { query: 'q' })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await limited.json()).toMatchObject({ error: 'rate_limited', limit: 'rate' })

    const bob = await post(app, 'bob', { query: 'q' })
    expect(bob.status).toBe(200)
    await bob.text()
  })

  it('enforces the daily cap with Retry-After until the next UTC midnight', async () => {
    behavior = 'ok'
    const app = createApp(makeConfig({ difyApiBase: base, aiDailyLimit: 1 }), db)
    const first = await post(app, 'carol', { query: 'q' })
    await first.text()
    const second = await post(app, 'carol', { query: 'q' })
    expect(second.status).toBe(429)
    expect(await second.json()).toMatchObject({ limit: 'daily' })
    expect(Number(second.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('does not hold authors and admins to the daily cap, but keeps the per-minute rate for them', async () => {
    behavior = 'ok'
    const app = createApp(
      makeConfig({ difyApiBase: base, aiDailyLimit: 1, aiRatePerMinute: 4, authRoleMap: { admins: ['admin'], writers: ['author'] } }),
      db,
    )
    const as = (user: string, groups: string) =>
      app.request('/api/ai/chat', {
        method: 'POST',
        headers: { 'Remote-User': user, 'Remote-Groups': groups, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'q' }),
      })
    // author: past the daily cap of 1
    for (let i = 0; i < 3; i++) {
      const r = await as('dora', 'writers')
      expect(r.status).toBe(200)
      await r.text()
    }
    // admin: same
    for (let i = 0; i < 3; i++) {
      const r = await as('erin', 'admins')
      expect(r.status).toBe(200)
      await r.text()
    }
    // a reader in an unmapped group is still capped
    const reader1 = await as('fred', 'students')
    await reader1.text()
    const reader2 = await as('fred', 'students')
    expect(reader2.status).toBe(429)
    expect(await reader2.json()).toMatchObject({ limit: 'daily' })
    // the per-minute bucket (4) still applies to the author
    const r4 = await as('dora', 'writers')
    expect(r4.status).toBe(200)
    await r4.text()
    const r5 = await as('dora', 'writers')
    expect(r5.status).toBe(429)
    expect(await r5.json()).toMatchObject({ limit: 'rate' })
  })

  it('keeps the daily cap for the engine tools route for readers and skips it for authors', async () => {
    const app = createApp(makeConfig({ difyApiBase: base, aiDailyLimit: 1, authRoleMap: { writers: ['author'] } }), db)
    const list = (user: string, groups: string) =>
      app.request('/api/tools', { headers: { 'Remote-User': user, 'Remote-Groups': groups } })
    expect((await list('gina', 'writers')).status).toBe(200)
    expect((await list('gina', 'writers')).status).toBe(200)
    expect((await list('hank', 'students')).status).toBe(200)
    const capped = await list('hank', 'students')
    expect(capped.status).toBe(429)
  })

  it('caps concurrent streams per user and frees the slot when the stream is cancelled', async () => {
    behavior = 'hold'
    const app = createApp(makeConfig({ difyApiBase: base, aiMaxConcurrent: 1 }), db)
    const first = await post(app, 'dave', { query: 'q' })
    expect(first.status).toBe(200)
    const second = await post(app, 'dave', { query: 'q' })
    expect(second.status).toBe(429)
    expect(await second.json()).toMatchObject({ limit: 'concurrency' })
    const other = await post(app, 'erin', { query: 'q' })
    expect(other.status).toBe(200)
    await other.body?.cancel()
    await first.body?.cancel()
    behavior = 'ok'
    const third = await post(app, 'dave', { query: 'q' })
    expect(third.status).toBe(200)
    await third.text()
  })

  it('rejects an oversize query with 413 and an oversize inputs set with 413', async () => {
    const app = createApp(makeConfig({ difyApiBase: base, aiQueryMaxBytes: 256, aiInputsMaxBytes: 1024 }), db)
    const q = await post(app, 'alice', { query: 'x'.repeat(257) })
    expect(q.status).toBe(413)
    expect(await q.json()).toMatchObject({ error: 'payload_too_large', message: 'query_too_long' })
    const i = await post(app, 'alice', { query: 'ok', inputs: { outline: 'y'.repeat(1025) } })
    expect(i.status).toBe(413)
  })

  it('whitelists inputs and files, and never forwards remote_url', async () => {
    behavior = 'ok'
    const app = createApp(makeConfig({ difyApiBase: base }), db)
    const r = await post(app, 'alice', {
      query: 'q',
      inputs: { current_lecture: 'L1', group: 'G1', outline: 'o', selection: 's', evil: 'x' },
    })
    await r.text()
    expect(lastBody?.['inputs']).toEqual({ current_lecture: 'L1', group: 'G1', outline: 'o', selection: 's' })

    const bad = await post(app, 'alice', { query: 'q', inputs: { outline: 5 } })
    expect(bad.status).toBe(400)

    const remote = await post(app, 'alice', {
      query: 'q',
      files: [{ type: 'document', transfer_method: 'remote_url', url: 'http://evil.example/x' }],
    })
    expect(remote.status).toBe(400)

    const unknown = await post(app, 'alice', {
      query: 'q',
      files: [{ type: 'document', transfer_method: 'local_file', upload_file_id: 'file_1' }],
    })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ message: 'unknown_file' })

    // Upload as alice, then the id is accepted for alice but not for bob.
    const pdf = new Blob(['%PDF-1.4 test'], { type: 'application/pdf' })
    const form = new FormData()
    form.append('file', pdf, 'a.pdf')
    const up = await app.request('/api/ai/upload', { method: 'POST', headers: { 'Remote-User': 'alice' }, body: form })
    expect(up.status).toBe(201)
    const file = { type: 'document', transfer_method: 'local_file', upload_file_id: 'file_1', extra: 1 }
    const ok = await post(app, 'alice', { query: 'q', files: [file] })
    expect(ok.status).toBe(200)
    await ok.text()
    expect(lastBody?.['files']).toEqual([{ type: 'document', transfer_method: 'local_file', upload_file_id: 'file_1' }])
    const bob = await post(app, 'bob', { query: 'q', files: [file] })
    expect(bob.status).toBe(400)
  })

  it('closes the AI routes when AUTH_ADAPTER=none unless AI_ALLOW_ANONYMOUS is set', async () => {
    behavior = 'ok'
    const closed = createApp(makeConfig({ difyApiBase: base, authAdapter: 'none' }), db)
    const r = await closed.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'q' }),
    })
    expect(r.status).toBe(403)
    const open = createApp(makeConfig({ difyApiBase: base, authAdapter: 'none', aiAllowAnonymous: true }), db)
    const r2 = await open.request('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'q' }),
    })
    expect(r2.status).toBe(200)
    await r2.text()
  })

  it('writes exactly one event: error frame when the upstream dies mid-stream (Dify)', async () => {
    behavior = 'midfail'
    const app = createApp(makeConfig({ difyApiBase: base }), db)
    const r = await post(app, 'alice', { query: 'q' })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('partial')
    expect(text.match(/event: error/g)).toHaveLength(1)
    expect(text).toContain('"event":"error"')
    expect(text).toContain('"code":"upstream_error"')
    const health = await app.request('/api/health')
    expect(((await health.json()) as { checks: { ai: string } }).checks.ai).toBe('degraded')
  })

  it('writes an event: error frame when the upstream dies mid-stream (OpenAI path)', async () => {
    behavior = 'midfail'
    const app = createApp(makeConfig({ aiProvider: 'openai', openaiApiBase: base }), db)
    const r = await post(app, 'alice', { query: 'q' })
    const text = await r.text()
    expect(text.match(/event: error/g)).toHaveLength(1)
  })

  it('clears the first-byte timeout when the first byte arrives', async () => {
    behavior = 'late_second'
    // 300 ms timeout; the second chunk only arrives at ~400 ms and must still be delivered.
    const app = createApp(makeConfig({ difyApiBase: base, aiUpstreamTimeoutMs: 300 }), db)
    const r = await post(app, 'alice', { query: 'q' })
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toContain('first')
    expect(text).toContain('second')
    expect(text).not.toContain('event: error')
  })

  it('answers a plain 502 when no byte arrives before the first-byte timeout', async () => {
    behavior = 'hang'
    const app = createApp(makeConfig({ difyApiBase: base, aiUpstreamTimeoutMs: 200 }), db)
    const r = await post(app, 'alice', { query: 'q' })
    expect(r.status).toBe(502)
    expect(await r.json()).toEqual({ error: 'ai_upstream_error' })
  })

  it('caps the whole stream and ends it with an error frame', async () => {
    behavior = 'hold'
    const app = createApp(makeConfig({ difyApiBase: base, aiStreamMaxMs: 300 }), db)
    const r = await post(app, 'alice', { query: 'q' })
    const text = await r.text()
    expect(text).toContain('"code":"stream_timeout"')
  })

  it('rejects uploads whose content does not match the extension, and limits to one concurrent upload', async () => {
    behavior = 'ok'
    const app = createApp(makeConfig({ difyApiBase: base }), db)
    const form = new FormData()
    form.append('file', new Blob(['MZ not a pdf'], { type: 'application/pdf' }), 'fake.pdf')
    const r = await app.request('/api/ai/upload', { method: 'POST', headers: { 'Remote-User': 'alice' }, body: form })
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ error: 'invalid_file_type' })

    const png = new FormData()
    png.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])]), 'p.png')
    const ok = await app.request('/api/ai/upload', { method: 'POST', headers: { 'Remote-User': 'alice' }, body: png })
    expect(ok.status).toBe(201)

    const txt = new FormData()
    txt.append('file', new Blob([new Uint8Array([0xff, 0xfe, 0x00])]), 'n.txt')
    const bad = await app.request('/api/ai/upload', { method: 'POST', headers: { 'Remote-User': 'alice' }, body: txt })
    expect(bad.status).toBe(400)
  })

  it('enforces the upload size cap with 413 and Connection: close', async () => {
    const app = createApp(makeConfig({ difyApiBase: base, aiUploadMaxBytes: 2048 }), db)
    const form = new FormData()
    form.append('file', new Blob(['%PDF' + 'x'.repeat(4096)]), 'big.pdf')
    const r = await app.request('/api/ai/upload', { method: 'POST', headers: { 'Remote-User': 'alice' }, body: form })
    expect(r.status).toBe(413)
    expect(r.headers.get('connection')).toBe('close')
  })

  it('writes one structured access-log line without prompts, keys or the raw user id', async () => {
    behavior = 'ok'
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const app = createApp(makeConfig({ difyApiBase: base, aiAccessLog: true }), db)
    const r = await post(app, 'alice', { query: 'SECRET-PROMPT-TEXT' })
    await r.text()
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"evt":"ai_call"'))
    expect(lines).toHaveLength(1)
    const line = lines[0] ?? ''
    expect(line).not.toContain('SECRET-PROMPT-TEXT')
    expect(line).not.toContain('dify-key')
    expect(line).not.toContain('alice')
    expect(JSON.parse(line)).toMatchObject({ route: 'chat', status: 200, outcome: 'ok', prompt_version: 1, limit: null })
  })

  it('caches the public health probe for 10 s', async () => {
    let selects = 0
    const counting: Db = {
      kind: db.kind,
      query: <T = unknown>(sql: string, params?: readonly unknown[]) => {
        if (sql === 'SELECT 1') selects++
        return db.query<T>(sql, params ? [...params] : undefined)
      },
      exec: (sql: string) => db.exec(sql),
      tx: (fn) => db.tx(fn),
      close: () => Promise.resolve(),
    }
    let t = 1_000_000
    const app = createApp(makeConfig({ aiProvider: 'off' }), counting, { now: () => t })
    await app.request('/api/health')
    await app.request('/api/health')
    expect(selects).toBe(1)
    t += 11_000
    await app.request('/api/health')
    expect(selects).toBe(2)
  })

  it('treats a duplicate message id as an idempotent replay (200) and a changed one as 409', async () => {
    const app = createApp(makeConfig({ aiProvider: 'off' }), db)
    const h = { 'Remote-User': 'alice', 'Content-Type': 'application/json' }
    const s = await app.request('/api/db/sessions', { method: 'POST', headers: h, body: JSON.stringify({ id: 's1', lecture_id: 'global' }) })
    expect(s.status).toBe(201)
    const msg = { id: 'm1', session_id: 's1', role: 'user', content: 'hello' }
    const a = await app.request('/api/db/messages', { method: 'POST', headers: h, body: JSON.stringify(msg) })
    expect(a.status).toBe(201)
    const b = await app.request('/api/db/messages', { method: 'POST', headers: h, body: JSON.stringify(msg) })
    expect(b.status).toBe(200)
    expect(await b.json()).toMatchObject({ id: 'm1', content: 'hello' })
    const c = await app.request('/api/db/messages', { method: 'POST', headers: h, body: JSON.stringify({ ...msg, content: 'other' }) })
    expect(c.status).toBe(409)
    const big = await app.request('/api/db/messages', { method: 'POST', headers: h, body: JSON.stringify({ ...msg, id: 'm2', prompt_tokens: 3_000_000_000 }) })
    expect(big.status).toBe(400)
    const lim = await app.request('/api/db/messages?limit=0', { headers: h })
    expect(lim.status).toBe(400)
    const list = await app.request('/api/db/messages?session_id=s1&limit=1000', { headers: h })
    expect(list.status).toBe(200)
  })

  it('limits write requests per user at /api/db/*', async () => {
    const app = createApp(makeConfig({ aiProvider: 'off', writeRatePerMinute: 2 }), db)
    const h = { 'Remote-User': 'writer', 'Content-Type': 'application/json' }
    const send = () => app.request('/api/db/sessions', { method: 'POST', headers: h, body: JSON.stringify({ lecture_id: 'global' }) })
    expect((await send()).status).toBe(201)
    expect((await send()).status).toBe(201)
    const r = await send()
    expect(r.status).toBe(429)
    expect(r.headers.get('retry-after')).toBeTruthy()
    const get = await app.request('/api/db/sessions', { headers: h })
    expect(get.status).toBe(200)
  })
})

describe('rate limit primitives', () => {
  it('refills the token bucket over time', () => {
    let t = 0
    const b = new TokenBucket(60, () => t)
    for (let i = 0; i < 60; i++) expect(b.take('u').ok).toBe(true)
    const denied = b.take('u')
    expect(denied.ok).toBe(false)
    expect(denied.retryAfterSec).toBe(1)
    t += 1000
    expect(b.take('u').ok).toBe(true)
  })

  it('resets the daily counter at the UTC day boundary', () => {
    let t = Date.UTC(2026, 10, 21, 23, 59, 0)
    const l = new AiRequestLimiter(100, 1, () => t)
    expect(l.check('u').ok).toBe(true)
    const d = l.check('u')
    expect(d).toMatchObject({ ok: false, kind: 'daily', retryAfterSec: 60 })
    t += 61_000
    expect(l.check('u').ok).toBe(true)
  })

  it('skips (and does not count) the daily cap when exemptDaily is set', () => {
    const t = Date.UTC(2026, 10, 21, 12, 0, 0)
    const l = new AiRequestLimiter(100, 1, () => t)
    for (let i = 0; i < 5; i++) expect(l.check('u', { exemptDaily: true }).ok).toBe(true)
    // exempt calls did not use up the quota of the same id
    expect(l.check('u').ok).toBe(true)
    expect(l.check('u')).toMatchObject({ ok: false, kind: 'daily' })
  })

  it('releases concurrency slots once', () => {
    const g = new ConcurrencyGate(1)
    const r = g.acquire('u')
    expect(r).not.toBeNull()
    expect(g.acquire('u')).toBeNull()
    r?.()
    r?.()
    expect(g.acquire('u')).not.toBeNull()
  })
})
