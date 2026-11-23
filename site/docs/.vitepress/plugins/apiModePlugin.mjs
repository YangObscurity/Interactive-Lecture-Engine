/**
 * site/docs/.vitepress/plugins/apiModePlugin.mjs
 *
 * Dev-server only API mode switch: lets the front end be debugged without writing
 * new backend endpoints.
 *
 *   LECTURE_API_MODE=off    (default) no interception, behaviour identical to V1.
 *   LECTURE_API_MODE=mock   serve /api/** from fixtures in site/tests/fixtures/api/,
 *                           with in-memory state (reset on restart or POST /__debug/api/reset).
 *   LECTURE_API_MODE=proxy  forward /api/** to LECTURE_API_ORIGIN (required), SSE-safe.
 *
 * Mock behaviour follows docs/backend-handoff/API_CONTRACT.md: every response carries a `Date` header, progress writes
 * get a server `updated_at`, `Idempotency-Key` replays the first response, `POST /progress/batch` is atomic and
 * `GET /api/auth/session` answers per scenario (anonymous, `user-alice`, `user-bob`, 404 for `legacy-backend`).
 *
 * Scenario switching (mock and proxy): query `?__scenario=<name>` > header
 * `x-lecture-scenario` > cookie `lecture-scenario` > env LECTURE_API_SCENARIO > `default`.
 *
 * Security: request bodies, cookies and auth headers are never logged. Only one line
 * per request: `[api:mock] PATCH /api/db/progress/g01-l01 200 12ms scenario=default`.
 *
 * The request handler is a pure factory (`createApiHandler`) so it can be unit-tested
 * with plain node:http without starting Vite.
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** site/tests/fixtures/api (this file lives in site/docs/.vitepress/plugins/) */
export const DEFAULT_FIXTURES_DIR = path.resolve(__dirname, '../../../tests/fixtures/api')

export const API_MODES = /** @type {const} */ (['off', 'mock', 'proxy'])

/** Scenario name -> human description (served by GET /__debug/api/scenarios). */
export const SCENARIOS = Object.freeze({
  default: 'normal fixture responses',
  slow: 'add 2000ms latency before every response',
  offline: 'every /api/** request returns 503 (backend unreachable)',
  error: 'every /api/** request returns 500',
  'sse-error': 'POST /api/ai/chat streams an `event: error` frame mid-answer (mock only)',
  empty: 'all /api/db GET lists return [] and single lookups 404 (mock only)',
  'notion-fallback': 'POST /api/progress/notion-sync returns 404 so the PATCH fallback is exercised (mock only)',
  'legacy-backend': 'a pre-contract backend: unfiltered GET /api/db/progress -> 400, GET /api/auth/session -> 404, Idempotency-Key ignored (mock only)',
  'reject-writes': 'PATCH /api/db/progress/<id> and POST /api/db/progress/batch return 422 (mock only)',
  'user-alice': 'GET /api/auth/session answers as authenticated user alice, roles reader+admin (mock only)',
  'user-bob': 'GET /api/auth/session answers as authenticated user bob, role reader (mock only)',
})

/** Identities served by GET /api/auth/session for the user-* scenarios (shape: API_CONTRACT.md section 1.1). */
const MOCK_USERS = Object.freeze({
  'user-alice': {
    authenticated: true,
    user: { id: 'alice', name: 'Alice', email: 'alice@example.com' },
    roles: ['reader', 'admin'],
    groups: ['admins', 'students-2026'],
    logoutUrl: 'https://auth.example.com/logout',
  },
  'user-bob': {
    authenticated: true,
    user: { id: 'bob', name: 'Bob', email: 'bob@example.com' },
    roles: ['reader'],
    groups: ['students-2026'],
    logoutUrl: 'https://auth.example.com/logout',
  },
})
const ANONYMOUS_SESSION = Object.freeze({ authenticated: false, user: null, roles: ['reader'], groups: [], logoutUrl: null })

/** API_CONTRACT.md section 2.3: a key is remembered for 24 hours. */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000
const IDEMPOTENCY_MAX_ENTRIES = 1000
/** API_CONTRACT.md section 2.4: at most 200 items per batch. */
const MAX_BATCH_ITEMS = 200

/** Paths owned by other dev plugins; never intercepted. */
const PASSTHROUGH_PREFIXES = ['/api/generate-export']

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

const MAX_JSON_BODY = 1024 * 1024

/**
 * Resolve the mode from env. Unknown values throw so a typo never silently means "off".
 * @param {Record<string, string | undefined>} [env]
 * @returns {'off' | 'mock' | 'proxy'}
 */
export function resolveApiMode(env = process.env) {
  const raw = (env.LECTURE_API_MODE || 'off').trim().toLowerCase()
  if (raw === '' || raw === 'off') return 'off'
  if (raw === 'mock' || raw === 'proxy') return raw
  throw new Error(
    `[api] LECTURE_API_MODE="${raw}" is invalid; expected one of: ${API_MODES.join(' | ')}`,
  )
}

/**
 * Validate LECTURE_API_ORIGIN for proxy mode. Throws a clear message when missing/invalid.
 * @param {string | undefined} origin
 * @returns {URL}
 */
export function parseOrigin(origin) {
  if (!origin || !origin.trim()) {
    throw new Error(
      '[api:proxy] LECTURE_API_MODE=proxy requires LECTURE_API_ORIGIN, e.g. ' +
        'LECTURE_API_ORIGIN=https://staging.example.test (scheme + host, optional base path)',
    )
  }
  let url
  try {
    url = new URL(origin.trim())
  } catch {
    throw new Error(`[api:proxy] LECTURE_API_ORIGIN="${origin}" is not a valid URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`[api:proxy] LECTURE_API_ORIGIN must be http(s), got "${url.protocol}"`)
  }
  return url
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

/** @param {string} file */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** @param {unknown} v */
const clone = (v) => JSON.parse(JSON.stringify(v))

/** @param {import('node:http').IncomingMessage} req */
function headerValue(req, name) {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** @param {import('node:http').IncomingMessage} req @param {URL} url */
export function pickScenario(req, url, fallback = 'default') {
  const fromQuery = url.searchParams.get('__scenario')
  if (fromQuery) return fromQuery
  const fromHeader = headerValue(req, 'x-lecture-scenario')
  if (fromHeader) return String(fromHeader).trim()
  const cookie = headerValue(req, 'cookie')
  if (cookie) {
    const m = /(?:^|;\s*)lecture-scenario=([^;]+)/.exec(cookie)
    if (m) return decodeURIComponent(m[1])
  }
  return fallback
}

/**
 * Read the request body. JSON bodies are parsed (<= 1 MB); anything else is drained.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ json: unknown, bytes: number }>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(headerValue(req, 'content-type') || '')
    const isJson = type.includes('application/json')
    /** @type {Buffer[]} */
    const chunks = []
    let bytes = 0
    req.on('data', (c) => {
      bytes += c.length
      if (isJson && bytes <= MAX_JSON_BODY) chunks.push(c)
    })
    req.on('end', () => {
      if (!isJson || bytes === 0) return resolve({ json: undefined, bytes })
      if (bytes > MAX_JSON_BODY) return resolve({ json: undefined, bytes })
      try {
        resolve({ json: JSON.parse(Buffer.concat(chunks).toString('utf8')), bytes })
      } catch {
        resolve({ json: undefined, bytes })
      }
    })
    req.on('error', reject)
  })
}

/** @param {import('node:http').ServerResponse} res */
function sendJson(res, status, body, extraHeaders = {}) {
  if (status === 204) {
    res.writeHead(204, extraHeaders)
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(text)
}

/** Split an .sse fixture into frames (blank-line separated). */
function splitSseFrames(text) {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !f.startsWith('#'))
}

/** Escape a string so it can be spliced into a JSON string literal. */
const jsonInner = (s) => JSON.stringify(String(s)).slice(1, -1)

const PROGRESS_STATUSES = ['未开始', '学习中', '已完成']
const nowIso = () => new Date().toISOString()
const norm = (id) => String(id || '').trim().toLowerCase()
let idSeq = 0
const mockId = (prefix) => `${prefix}_mock_${Date.now().toString(36)}_${(idSeq++).toString(36)}`

// ---------------------------------------------------------------------------
// mock state
// ---------------------------------------------------------------------------

/**
 * @param {string} fixturesDir
 */
function loadSeed(fixturesDir) {
  const db = (name) => {
    const file = path.join(fixturesDir, 'db', name)
    return fs.existsSync(file) ? readJson(file) : []
  }
  return {
    sessions: db('sessions.get.json'),
    messages: db('messages.get.json'),
    progress: db('progress.get.json'),
    checklists: db('review-checklists.get.json'),
  }
}

/**
 * @param {string} fixturesDir
 */
function createMockState(fixturesDir) {
  const seed = loadSeed(fixturesDir)
  /** @type {Map<string, Record<string, unknown>>} */
  const sessions = new Map(seed.sessions.map((s) => [s.id, s]))
  /** @type {Map<string, Record<string, unknown>>} */
  const messages = new Map(seed.messages.map((m) => [m.id, m]))
  /** @type {Map<string, Record<string, unknown>>} */
  const progress = new Map(seed.progress.map((p) => [norm(p.lecture_id), p]))
  /** @type {Map<string, Record<string, unknown>>} */
  const checklists = new Map(seed.checklists.map((c) => [c.id, c]))
  /** @type {Array<{ at: string, endpoint: string, lecture_id: unknown, status: unknown }>} */
  const notionSyncs = []
  /** @type {Array<{ at: string, bytes: number, id: string }>} */
  const uploads = []
  /** @type {Array<{ at: string, conversation_id: string, scenario: string }>} */
  const chats = []
  /**
   * Idempotency-Key -> first response of the write it named (progress PATCH and batch only).
   * @type {Map<string, { fingerprint: string, status: number, body: unknown, at: number }>}
   */
  const idempotency = new Map()
  return { sessions, messages, progress, checklists, notionSyncs, uploads, chats, idempotency, startedAt: nowIso() }
}

/** @param {ReturnType<typeof createMockState>} s */
function snapshotState(s) {
  return {
    startedAt: s.startedAt,
    counts: {
      sessions: s.sessions.size,
      messages: s.messages.size,
      progress: s.progress.size,
      checklists: s.checklists.size,
      notionSyncs: s.notionSyncs.length,
      uploads: s.uploads.length,
      chats: s.chats.length,
      idempotencyKeys: s.idempotency.size,
    },
    sessions: [...s.sessions.values()],
    messages: [...s.messages.values()],
    progress: Object.fromEntries(s.progress),
    checklists: [...s.checklists.values()],
    notionSyncs: s.notionSyncs,
    uploads: s.uploads,
    chats: s.chats,
  }
}

// ---------------------------------------------------------------------------
// handler factory
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ApiHandlerOptions
 * @property {'off' | 'mock' | 'proxy'} mode
 * @property {string} [fixturesDir]      defaults to site/tests/fixtures/api
 * @property {string} [origin]           required for proxy
 * @property {string} [defaultScenario]  env LECTURE_API_SCENARIO
 * @property {number} [sseFrameDelayMs]  delay between SSE frames (default 60; tests use 0)
 * @property {number} [slowMs]           latency of the `slow` scenario (default 2000)
 * @property {() => number} [now]        clock in ms (default Date.now); drives `Date`, `updated_at` and key expiry
 * @property {(line: string) => void} [log]
 */

/**
 * Create a connect-style middleware `(req, res, next)`.
 * Extra properties: `.mode`, `.state()` (mock snapshot), `.reset()`.
 * @param {ApiHandlerOptions} options
 */
export function createApiHandler(options) {
  const mode = options.mode
  if (!API_MODES.includes(mode)) throw new Error(`[api] unknown mode "${mode}"`)
  const fixturesDir = options.fixturesDir || DEFAULT_FIXTURES_DIR
  const defaultScenario = options.defaultScenario || 'default'
  const sseFrameDelayMs = options.sseFrameDelayMs ?? 60
  const slowMs = options.slowMs ?? 2000
  const clock = options.now ?? Date.now
  const isoNow = () => new Date(clock()).toISOString()
  const log = options.log || ((line) => console.log(line))
  const target = mode === 'proxy' ? parseOrigin(options.origin) : null

  if (mode === 'mock' && !fs.existsSync(fixturesDir)) {
    throw new Error(`[api:mock] fixtures dir not found: ${fixturesDir}`)
  }

  let state = mode === 'mock' ? createMockState(fixturesDir) : null
  const fixture = (rel) => path.join(fixturesDir, rel)

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {(err?: unknown) => void} next
   */
  async function handler(req, res, next) {
    if (mode === 'off') return next()
    const url = new URL(req.url || '/', 'http://dev.local')
    const pathname = url.pathname

    if (pathname.startsWith('/__debug/api/')) {
      res.setHeader('date', new Date(clock()).toUTCString())
      return handleDebug(req, res, pathname)
    }
    if (!(pathname === '/api' || pathname.startsWith('/api/'))) return next()
    if (PASSTHROUGH_PREFIXES.some((p) => pathname.startsWith(p))) return next()
    // every response carries a Date header (API_CONTRACT.md section 0); a proxied upstream Date replaces it
    res.setHeader('date', new Date(clock()).toUTCString())

    const started = Date.now()
    const method = (req.method || 'GET').toUpperCase()
    const scenario = pickScenario(req, url, defaultScenario)
    res.on('finish', () => {
      const known = Object.prototype.hasOwnProperty.call(SCENARIOS, scenario) ? '' : ' (unknown, treated as default)'
      log(`[api:${mode}] ${method} ${pathname} ${res.statusCode} ${Date.now() - started}ms scenario=${scenario}${known}`)
    })

    try {
      // scenarios that apply to both modes
      if (scenario === 'slow') await sleep(slowMs)
      if (scenario === 'offline') {
        await drain(req)
        return sendJson(res, 503, { error: 'service_unavailable', message: `[${mode}] scenario=offline` })
      }
      if (scenario === 'error') {
        await drain(req)
        return sendJson(res, 500, { error: 'internal_error', message: `[${mode}] scenario=error` })
      }
      if (mode === 'proxy') return proxyRequest(req, res, url)
      return await handleMock(req, res, url, method, scenario)
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'mock_handler_error', message: String(err && err.message ? err.message : err) })
      } else {
        res.end()
      }
    }
  }

  /** @param {import('node:http').IncomingMessage} req */
  function drain(req) {
    return new Promise((resolve) => {
      if (req.readableEnded) return resolve(undefined)
      req.on('data', () => {})
      req.on('end', () => resolve(undefined))
      req.on('error', () => resolve(undefined))
    })
  }

  // ---- /__debug/api/* -----------------------------------------------------

  function handleDebug(req, res, pathname) {
    const method = (req.method || 'GET').toUpperCase()
    if (pathname === '/__debug/api/state' && method === 'GET') {
      return sendJson(res, 200, {
        mode,
        origin: target ? target.origin : null,
        defaultScenario,
        state: state ? snapshotState(state) : null,
      })
    }
    if (pathname === '/__debug/api/reset' && method === 'POST') {
      if (mode !== 'mock') return sendJson(res, 409, { error: 'reset is only available in mock mode', mode })
      state = createMockState(fixturesDir)
      log(`[api:mock] state reset from fixtures`)
      return sendJson(res, 200, { ok: true, counts: snapshotState(state).counts })
    }
    if (pathname === '/__debug/api/scenarios' && method === 'GET') {
      return sendJson(res, 200, { mode, defaultScenario, scenarios: SCENARIOS })
    }
    return sendJson(res, 404, { error: 'unknown debug endpoint', endpoints: ['GET /__debug/api/state', 'POST /__debug/api/reset', 'GET /__debug/api/scenarios'] })
  }

  // ---- proxy ---------------------------------------------------------------

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  function proxyRequest(req, res, url) {
    if (!target) throw new Error('unreachable: proxy without target')
    const basePath = target.pathname.replace(/\/+$/, '')
    url.searchParams.delete('__scenario')
    const search = url.searchParams.toString()
    const upstreamPath = `${basePath}${url.pathname}${search ? `?${search}` : ''}`

    /** @type {Record<string, string | string[]>} */
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_BY_HOP.has(k) || k === 'x-lecture-scenario') continue
      headers[k] = v
    }
    headers.host = target.host
    headers['x-forwarded-host'] = String(headerValue(req, 'host') || '')
    headers['x-forwarded-proto'] = 'http'

    const lib = target.protocol === 'https:' ? https : http
    return new Promise((resolve) => {
      const upstream = lib.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          method: req.method,
          path: upstreamPath,
          headers,
        },
        (up) => {
          /** @type {Record<string, string | string[]>} */
          const outHeaders = {}
          for (const [k, v] of Object.entries(up.headers)) {
            if (v === undefined || HOP_BY_HOP.has(k)) continue
            outHeaders[k] = v
          }
          const isSse = String(up.headers['content-type'] || '').includes('text/event-stream')
          if (isSse) {
            outHeaders['cache-control'] = 'no-cache, no-transform'
            outHeaders['x-accel-buffering'] = 'no'
          }
          res.writeHead(up.statusCode || 502, outHeaders)
          if (isSse) res.flushHeaders()
          up.pipe(res)
          up.on('end', () => resolve(undefined))
          up.on('error', () => {
            res.end()
            resolve(undefined)
          })
        },
      )
      upstream.on('error', (err) => {
        if (!res.headersSent) {
          sendJson(res, 502, {
            error: 'proxy_upstream_error',
            code: /** @type {NodeJS.ErrnoException} */ (err).code || 'UNKNOWN',
            origin: target.origin,
          })
        } else {
          res.end()
        }
        resolve(undefined)
      })
      // client disconnect (e.g. user aborts an SSE answer) -> abort upstream
      res.on('close', () => {
        if (!res.writableFinished) upstream.destroy()
      })
      req.pipe(upstream)
    })
  }

  // ---- mock ---------------------------------------------------------------

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   * @param {string} method
   * @param {string} scenario
   */
  async function handleMock(req, res, url, method, scenario) {
    if (!state) throw new Error('unreachable: mock without state')
    const s = state
    const p = url.pathname
    const q = url.searchParams

    // identity (API_CONTRACT.md section 1.1)
    if (p === '/api/auth/session') {
      await drain(req)
      if (scenario === 'legacy-backend') return sendJson(res, 404, { error: 'not_found', message: 'scenario=legacy-backend' })
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' })
      const who = Object.prototype.hasOwnProperty.call(MOCK_USERS, scenario) ? MOCK_USERS[/** @type {'user-alice'} */ (scenario)] : ANONYMOUS_SESSION
      return sendJson(res, 200, who)
    }

    // health
    if (p === '/api/health' && method === 'GET') {
      return sendJson(res, 200, { ...readJson(fixture('health.get.json')), mode: 'mock', scenario })
    }

    // AI chat (SSE)
    if (p === '/api/ai/chat' && method === 'POST') {
      const { json } = await readBody(req)
      const body = /** @type {Record<string, unknown>} */ (json && typeof json === 'object' ? json : {})
      const conversationId =
        typeof body.conversation_id === 'string' && body.conversation_id ? body.conversation_id : mockId('conv')
      const query = typeof body.query === 'string' ? body.query : ''
      s.chats.push({ at: nowIso(), conversation_id: conversationId, scenario })
      const file = scenario === 'sse-error' ? 'ai/chat.error.sse' : 'ai/chat.sse'
      const frames = splitSseFrames(fs.readFileSync(fixture(file), 'utf8')).map((f) =>
        f
          .replaceAll('{{conversation_id}}', jsonInner(conversationId))
          .replaceAll('{{message_id}}', jsonInner(mockId('msg')))
          .replaceAll('{{query}}', jsonInner(query.slice(0, 200))),
      )
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders()
      let closed = false
      res.on('close', () => {
        closed = true
      })
      for (const frame of frames) {
        if (closed) return
        res.write(`${frame}\n\n`)
        await sleep(sseFrameDelayMs)
      }
      return res.end()
    }

    // AI upload (multipart; drained, never stored)
    if (p === '/api/ai/upload' && method === 'POST') {
      const { bytes } = await readBody(req)
      const tpl = readJson(fixture('ai/upload.post.json'))
      const id = mockId('file')
      s.uploads.push({ at: nowIso(), bytes, id })
      return sendJson(res, 200, { ...tpl, id, size: bytes || tpl.size })
    }

    // Notion sync (primary POST / fallback PATCH)
    if (
      (p === '/api/progress/notion-sync' && method === 'POST') ||
      (p === '/api/notion/sync-status' && method === 'PATCH')
    ) {
      const { json } = await readBody(req)
      if (scenario === 'notion-fallback' && method === 'POST') {
        return sendJson(res, 404, { error: 'not_found', message: 'scenario=notion-fallback' })
      }
      const body = /** @type {Record<string, unknown>} */ (json && typeof json === 'object' ? json : {})
      if (!PROGRESS_STATUSES.includes(/** @type {string} */ (body.status))) {
        return sendJson(res, 400, { error: 'invalid_status', allowed: PROGRESS_STATUSES })
      }
      s.notionSyncs.push({ at: nowIso(), endpoint: p, lecture_id: body.lecture_id, status: body.status })
      return sendJson(res, 200, { ...readJson(fixture('notion/sync.post.json')), lecture_id: body.lecture_id, status: body.status })
    }

    if (p.startsWith('/api/db/')) return handleDb(req, res, p.slice('/api/db'.length), q, method, scenario)

    await drain(req)
    return sendJson(res, 404, { error: 'mock_not_found', message: `no mock route for ${method} ${p}` })
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} sub  path after /api/db, e.g. /progress/g01-l01
   * @param {URLSearchParams} q
   * @param {string} method
   * @param {string} scenario
   */
  async function handleDb(req, res, sub, q, method, scenario) {
    if (!state) throw new Error('unreachable')
    const s = state
    const empty = scenario === 'empty'
    const [, resource = '', rawId = ''] = sub.split('/')
    const id = decodeURIComponent(rawId)
    const { json } = method === 'GET' || method === 'DELETE' ? { json: undefined } : await readBody(req)
    if (method === 'GET' || method === 'DELETE') await drain(req)
    const body = /** @type {Record<string, unknown>} */ (json && typeof json === 'object' ? json : {})
    const ts = isoNow()

    // ---- sessions
    if (resource === 'sessions') {
      if (method === 'GET' && !id) {
        const lec = q.get('lecture_id')
        const list = [...s.sessions.values()].filter((x) => !lec || norm(x.lecture_id) === norm(lec))
        return sendJson(res, 200, empty ? [] : list)
      }
      if (method === 'GET' && id) {
        const found = s.sessions.get(id)
        return found && !empty ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'not_found' })
      }
      if (method === 'POST') {
        const rec = { id: body.id || mockId('sess'), title: '新会话', is_archived: false, created_at: ts, updated_at: ts, ...body }
        s.sessions.set(String(rec.id), rec)
        return sendJson(res, 201, rec)
      }
      if (method === 'PATCH' && id) {
        const cur = s.sessions.get(id)
        if (!cur) return sendJson(res, 404, { error: 'not_found' })
        const next = { ...cur, ...stripUndefined(body), updated_at: ts }
        s.sessions.set(id, next)
        return sendJson(res, 200, next)
      }
      if (method === 'DELETE' && id) {
        s.sessions.delete(id)
        for (const [mid, m] of s.messages) if (m.session_id === id) s.messages.delete(mid)
        return sendJson(res, 204)
      }
      if (method === 'DELETE' && q.get('lecture_id')) {
        const lec = norm(q.get('lecture_id'))
        for (const [sid, x] of s.sessions) {
          if (norm(x.lecture_id) !== lec) continue
          s.sessions.delete(sid)
          for (const [mid, m] of s.messages) if (m.session_id === sid) s.messages.delete(mid)
        }
        return sendJson(res, 204)
      }
    }

    // ---- messages
    if (resource === 'messages') {
      if (method === 'GET' && !id) {
        const sid = q.get('session_id')
        const list = [...s.messages.values()].filter((m) => !sid || m.session_id === sid)
        return sendJson(res, 200, empty ? [] : list)
      }
      if (method === 'POST') {
        const rec = {
          id: body.id || mockId('msg'),
          selected_context: null,
          model: 'mock',
          prompt_tokens: 0,
          completion_tokens: 0,
          created_at: ts,
          ...body,
        }
        s.messages.set(String(rec.id), rec)
        return sendJson(res, 201, rec)
      }
      if (method === 'PATCH' && id) {
        const cur = s.messages.get(id)
        if (!cur) return sendJson(res, 404, { error: 'not_found' })
        const next = { ...cur, ...stripUndefined(body) }
        s.messages.set(id, next)
        return sendJson(res, 200, next)
      }
      if (method === 'DELETE' && id) {
        s.messages.delete(id)
        return sendJson(res, 204)
      }
      if (method === 'DELETE' && q.get('session_id')) {
        const sid = q.get('session_id')
        for (const [mid, m] of s.messages) if (m.session_id === sid) s.messages.delete(mid)
        return sendJson(res, 204)
      }
    }

    // ---- progress (API_CONTRACT.md section 2)
    if (resource === 'progress') {
      if (id === 'batch' && method === 'POST') {
        if (scenario === 'reject-writes') return sendJson(res, 422, { error: 'write_rejected', message: 'scenario=reject-writes' })
        return idempotent(req, res, scenario, method, '/api/db/progress/batch', body, () => {
          const items = Array.isArray(body.items) ? body.items : null
          if (!items) return { status: 400, body: { error: 'items[] required' } }
          if (items.length > MAX_BATCH_ITEMS) return { status: 400, body: { error: 'too_many_items', max: MAX_BATCH_ITEMS } }
          // atomic: validate every item before writing any
          for (const it of items) {
            if (!it || typeof it !== 'object' || !it.lecture_id) return { status: 400, body: { error: 'invalid_item' } }
            if (!PROGRESS_STATUSES.includes(it.status)) return { status: 400, body: { error: 'invalid_status', allowed: PROGRESS_STATUSES } }
          }
          return { status: 200, body: items.map((it) => upsertProgress(norm(it.lecture_id), it, ts)) }
        })
      }
      if (method === 'GET' && !id) {
        const lec = q.get('lecture_id')
        if (lec) {
          const found = s.progress.get(norm(lec))
          return found && !empty ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'not_found' })
        }
        const grp = q.get('group_id')
        if (!grp && scenario === 'legacy-backend') {
          return sendJson(res, 400, { error: 'group_id_required', message: 'scenario=legacy-backend' })
        }
        const list = [...s.progress.values()].filter((x) => !grp || norm(x.group_id) === norm(grp))
        return sendJson(res, 200, empty ? [] : list)
      }
      if (method === 'GET' && id) {
        const found = s.progress.get(norm(id))
        return found && !empty ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'not_found' })
      }
      if (method === 'PATCH') {
        if (scenario === 'reject-writes') return sendJson(res, 422, { error: 'write_rejected', message: 'scenario=reject-writes' })
        return idempotent(req, res, scenario, method, `/api/db/progress/${id}`, body, () => {
          const lec = norm(id || /** @type {string} */ (body.lecture_id) || q.get('lecture_id') || '')
          if (!lec) return { status: 400, body: { error: 'lecture_id required' } }
          if (!PROGRESS_STATUSES.includes(/** @type {string} */ (body.status))) {
            return { status: 400, body: { error: 'invalid_status', allowed: PROGRESS_STATUSES } }
          }
          return { status: 200, body: upsertProgress(lec, body, ts) }
        })
      }
    }

    // ---- review checklists (DB_ROUTES.reviewChecklists; neonRepository currently calls /checklist)
    if (resource === 'review-checklists' || resource === 'checklist') {
      if (method === 'GET' && !id) {
        const lec = q.get('lecture_id')
        const list = [...s.checklists.values()].filter((x) => !lec || norm(x.lecture_id) === norm(lec))
        return sendJson(res, 200, empty ? [] : list)
      }
      if (method === 'POST') {
        const items = Array.isArray(body.items) ? body.items : [body]
        const out = items.map((it) => {
          const rec = {
            id: it.id || mockId('chk'),
            section_anchor: null,
            is_completed: false,
            pptx_source: null,
            priority: 0,
            created_at: ts,
            updated_at: ts,
            ...it,
          }
          s.checklists.set(String(rec.id), rec)
          return rec
        })
        return sendJson(res, 201, out)
      }
      if (method === 'PATCH' && id) {
        const cur = s.checklists.get(id)
        if (!cur) return sendJson(res, 404, { error: 'not_found' })
        const next = { ...cur, ...stripUndefined(body), updated_at: ts }
        s.checklists.set(id, next)
        return sendJson(res, 200, next)
      }
      if (method === 'DELETE' && id) {
        s.checklists.delete(id)
        return sendJson(res, 204)
      }
    }

    return sendJson(res, 404, { error: 'mock_not_found', message: `no mock route for ${method} /api/db${sub}` })
  }

  /**
   * Run a progress write under the Idempotency-Key rules (API_CONTRACT.md section 2.3): the same key with the same
   * request replays the first 2xx response without writing again; the same key with another request is 422.
   * The `legacy-backend` scenario does not know the header. Only 2xx responses are remembered.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} scenario
   * @param {string} method
   * @param {string} route
   * @param {Record<string, unknown>} body
   * @param {() => { status: number, body: unknown }} produce
   */
  function idempotent(req, res, scenario, method, route, body, produce) {
    if (!state) throw new Error('unreachable')
    const key = String(headerValue(req, 'idempotency-key') || '').trim()
    if (!key || scenario === 'legacy-backend') {
      const out = produce()
      return sendJson(res, out.status, out.body)
    }
    const store = state.idempotency
    const fingerprint = `${method} ${route} ${canonicalJson(body)}`
    const t = clock()
    for (const [k, v] of store) if (t - v.at > IDEMPOTENCY_TTL_MS) store.delete(k)
    const seen = store.get(key)
    if (seen) {
      if (seen.fingerprint !== fingerprint) {
        return sendJson(res, 422, { error: 'idempotency_key_reused', message: 'this Idempotency-Key was used for a different request' })
      }
      return sendJson(res, seen.status, seen.body, { 'idempotency-replayed': 'true' })
    }
    const out = produce()
    if (out.status >= 200 && out.status < 300) {
      store.set(key, { fingerprint, status: out.status, body: clone(out.body), at: t })
      while (store.size > IDEMPOTENCY_MAX_ENTRIES) store.delete(/** @type {string} */ (store.keys().next().value))
    }
    return sendJson(res, out.status, out.body)
  }

  /** @param {string} lec @param {Record<string, unknown>} patch @param {string} ts */
  function upsertProgress(lec, patch, ts) {
    if (!state) throw new Error('unreachable')
    const cur = state.progress.get(lec) || {
      lecture_id: lec,
      group_id: lec.split('-')[0],
      notion_node_id: null,
      notion_page_id: null,
      status: '未开始',
      completed_at: null,
      updated_at: ts,
    }
    const clean = stripUndefined(patch)
    const status = /** @type {string} */ (clean.status ?? cur.status)
    const next = {
      ...cur,
      ...clean,
      lecture_id: lec,
      status,
      // contract 2.1: filled by the server when it becomes completed, cleared when it leaves completed; the body value is ignored
      completed_at: status === '已完成' ? cur.completed_at || ts : null,
      // the server clock wins: whatever updated_at the request carried is ignored
      updated_at: ts,
    }
    state.progress.set(lec, next)
    return next
  }

  handler.mode = mode
  handler.state = () => (state ? clone(snapshotState(state)) : null)
  handler.reset = () => {
    if (mode === 'mock') state = createMockState(fixturesDir)
  }
  return handler
}

/** JSON with object keys sorted, so two requests with the same content compare equal whatever the key order. */
function canonicalJson(value) {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  )
}

/** @param {Record<string, unknown>} obj */
function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined))
}

/**
 * Vite plugin. Dev server only (`apply: 'serve'`); in `off` mode it registers nothing.
 * @param {{ env?: Record<string, string | undefined>, fixturesDir?: string }} [opts]
 * @returns {import('vite').Plugin}
 */
export function apiModePlugin(opts = {}) {
  const env = opts.env || process.env
  return {
    name: 'lecture-api-mode',
    apply: 'serve',
    configureServer(server) {
      const mode = resolveApiMode(env) // throws on typo -> dev server fails fast
      if (mode === 'off') return
      const handler = createApiHandler({
        mode,
        origin: env.LECTURE_API_ORIGIN,
        fixturesDir: opts.fixturesDir,
        defaultScenario: env.LECTURE_API_SCENARIO,
        log: (line) => server.config.logger.info(line, { timestamp: true }),
      })
      const where = mode === 'proxy' ? `-> ${parseOrigin(env.LECTURE_API_ORIGIN).origin}` : `fixtures ${opts.fixturesDir || DEFAULT_FIXTURES_DIR}`
      server.config.logger.info(`[api:${mode}] /api/** intercepted (${where}); debug: GET /__debug/api/state`)
      // registered directly (not in a returned post-hook) so it runs before Vite's own middlewares
      server.middlewares.use(handler)
    },
  }
}

export default apiModePlugin
