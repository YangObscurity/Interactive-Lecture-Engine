#!/usr/bin/env node
/**
 * scripts/check_header_spoof.mjs — does the gateway let a client forge identity headers?
 *
 * Sends spoofed `Remote-User` / `Remote-Groups: admins` (plus Email/Name) to the routes that
 * matter, as an anonymous caller and, when `--cookie` is given, as a logged-in NON-admin, and
 * prints a table. Exit code 1 when any check fails, 2 on usage or network errors.
 *
 *   node scripts/check_header_spoof.mjs https://docs.example.com
 *   node scripts/check_header_spoof.mjs https://docs.example.com --cookie "authelia_session=..."
 *   node scripts/check_header_spoof.mjs --self-test      # local gateway emulation, no network
 *
 * Verdicts:
 *   - admin-only routes (/api/admin/*, /api/progress/*, /api/notion/*) must NOT answer 2xx;
 *   - /api/auth/session must not show the spoofed identity or an admin role;
 *   - /api/ai/chat and /api/db/progress must not answer 2xx to the anonymous caller
 *     (for the logged-in caller they are reported as INFO, since a real user may use them).
 * Redirects are not followed: a 3xx counts as "blocked".
 *
 * The cookie must belong to a non-admin account. Do not paste real cookies into shared logs.
 * No dependencies; Node 20+.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SPOOF = {
  'Remote-User': 'spoofed-admin',
  'Remote-Groups': 'admins',
  'Remote-Email': 'spoofed@example.invalid',
  'Remote-Name': 'Spoofed Admin',
}

const PROBES = [
  { name: '/api/admin/overview', method: 'GET', path: '/api/admin/overview', kind: 'admin' },
  { name: '/api/admin/health', method: 'GET', path: '/api/admin/health', kind: 'admin' },
  { name: '/api/progress/health', method: 'GET', path: '/api/progress/health', kind: 'admin' },
  { name: '/api/notion/sync-status', method: 'POST', path: '/api/notion/sync-status', kind: 'admin', body: '{}' },
  { name: '/api/auth/session', method: 'GET', path: '/api/auth/session', kind: 'session' },
  { name: '/api/ai/chat', method: 'POST', path: '/api/ai/chat', kind: 'user', body: '{"query":"spoof-check"}' },
  { name: '/api/db/progress', method: 'GET', path: '/api/db/progress', kind: 'user' },
]

/** Run one probe; never throws (network failures become `error`). */
async function probe(base, p, cookie) {
  const headers = { ...SPOOF, Accept: 'application/json' }
  if (p.body) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  try {
    const res = await fetch(new URL(p.path, base), {
      method: p.method,
      headers,
      body: p.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
    let json = null
    const text = await res.text().catch(() => '')
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    return { status: res.status, json }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

const is2xx = (s) => s >= 200 && s < 300

function judge(p, r, loggedIn) {
  if (r.error) return { verdict: 'ERROR', note: r.error }
  const s = r.status
  if (p.kind === 'admin') {
    return is2xx(s) ? { verdict: 'FAIL', note: 'admin-only route answered 2xx' } : { verdict: 'PASS', note: 'blocked' }
  }
  if (p.kind === 'session') {
    if (!is2xx(s)) return { verdict: 'PASS', note: 'blocked' }
    const j = r.json ?? {}
    const roles = Array.isArray(j.roles) ? j.roles : []
    const uid = j.user?.id ?? j.user?.name ?? ''
    if (roles.includes('admin')) return { verdict: 'FAIL', note: 'session shows admin role' }
    if (String(uid).includes('spoofed')) return { verdict: 'FAIL', note: 'session shows the spoofed user' }
    if (!loggedIn && j.authenticated === true) return { verdict: 'FAIL', note: 'anonymous caller is authenticated' }
    return { verdict: 'PASS', note: 'spoofed identity ignored' }
  }
  // user routes
  if (!loggedIn) {
    return is2xx(s) ? { verdict: 'FAIL', note: 'anonymous caller got 2xx' } : { verdict: 'PASS', note: 'blocked' }
  }
  return { verdict: 'INFO', note: 'logged-in caller (not an admin route)' }
}

export async function runChecks(base, cookie) {
  const callers = [{ label: 'anonymous', cookie: '' }]
  if (cookie) callers.push({ label: 'non-admin', cookie })
  const rows = []
  for (const c of callers) {
    for (const p of PROBES) {
      const r = await probe(base, p, c.cookie)
      const j = judge(p, r, c.label !== 'anonymous')
      rows.push({ caller: c.label, route: `${p.method} ${p.name}`, status: r.error ? '-' : String(r.status), ...j })
    }
  }
  return rows
}

export function formatTable(rows) {
  const cols = ['caller', 'route', 'status', 'verdict', 'note']
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)))
  const line = (r) => cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  ')
  return [line(Object.fromEntries(cols.map((c) => [c, c]))), w.map((n) => '-'.repeat(n)).join('  '), ...rows.map(line)].join('\n')
}

export function exitCodeFor(rows) {
  if (rows.some((r) => r.verdict === 'FAIL')) return 1
  if (rows.some((r) => r.verdict === 'ERROR')) return 2
  return 0
}

// ---------------------------------------------------------------------------------------------
// Self-test: a throwaway gateway that behaves like server/deploy/nginx-locations.conf (overwrites
// the identity headers from its own fake session cookie) in front of a real local lecture-api.
// The same checks are then run directly against lecture-api, which trusts client headers, and
// must FAIL there: that proves the check bites.
// ---------------------------------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.resolve(HERE, '../server')
const PORT_GATEWAY = 8181
const PORT_API = 8182
const PORT_LEGACY = 8183

function startGateway() {
  const ADMIN_ONLY = [/^\/api\/admin(\/|$)/, /^\/api\/progress(\/|$)/, /^\/api\/notion(\/|$)/]
  const PROTECTED = [/^\/api\/(db|ai|admin|progress|notion)(\/|$)/, /^\/api\/auth\/session$/]
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const cookie = String(req.headers.cookie ?? '')
    const session = /lec_session=(admin|user)/.exec(cookie)?.[1] ?? null
    const isLegacy = /^\/api\/(progress|notion)(\/|$)/.test(url.pathname)
    const toPort = isLegacy ? PORT_LEGACY : PORT_API

    // nginx: auth_request first
    const needsAuth = url.pathname !== '/api/health' && PROTECTED.some((re) => re.test(url.pathname))
    let identity = { user: '', groups: '', email: '', name: '' }
    if (needsAuth) {
      if (!session) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthenticated"}')
        req.resume()
        return
      }
      if (ADMIN_ONLY.some((re) => re.test(url.pathname)) && session !== 'admin') {
        res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"forbidden"}')
        req.resume()
        return
      }
      identity = session === 'admin'
        ? { user: 'owner', groups: 'admins', email: 'o@example.invalid', name: 'Owner' }
        : { user: 'bob', groups: 'students', email: 'b@example.invalid', name: 'Bob' }
    }
    // proxy_set_header: overwrite the four identity headers, blank the other presets
    const headers = { ...req.headers, host: `127.0.0.1:${toPort}` }
    delete headers.cookie
    for (const k of Object.keys(headers)) {
      if (/^(x-forwarded-(user|groups|email|preferred-username)|x-authentik-|x-auth-request-)/i.test(k)) delete headers[k]
    }
    headers['remote-user'] = identity.user
    headers['remote-groups'] = identity.groups
    headers['remote-email'] = identity.email
    headers['remote-name'] = identity.name
    for (const k of ['remote-user', 'remote-groups', 'remote-email', 'remote-name']) {
      if (headers[k] === '') delete headers[k]
    }
    const up = http.request(
      { host: '127.0.0.1', port: toPort, method: req.method, path: req.url, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  })
  return new Promise((resolve) => server.listen(PORT_GATEWAY, '127.0.0.1', () => resolve(server)))
}

function startLegacyStub() {
  const server = http.createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true,"service":"legacy-stub"}')
  })
  return new Promise((resolve) => server.listen(PORT_LEGACY, '127.0.0.1', () => resolve(server)))
}

async function waitFor(url, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timeout waiting for ${url}`)
}

async function selfTest() {
  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'dist/index.js')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT_API),
      DATABASE_URL: 'pglite:memory',
      DB_AUTO_MIGRATE: 'true',
      AUTH_ADAPTER: 'trusted-header',
      AUTH_HEADER_PRESET: 'authelia',
      AUTH_ROLE_MAP: 'admins:admin',
      AI_PROVIDER: 'off',
      AI_ACCESS_LOG: 'false',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  const gateway = await startGateway()
  const legacy = await startLegacyStub()
  const closeAll = async () => {
    child.kill()
    await new Promise((r) => gateway.close(r))
    await new Promise((r) => legacy.close(r))
  }
  try {
    await waitFor(`http://127.0.0.1:${PORT_API}/api/health`)
    console.log('Self-test 1/2: behind a gateway that overwrites identity headers (must PASS)')
    const good = await runChecks(`http://127.0.0.1:${PORT_GATEWAY}`, 'lec_session=user')
    console.log(formatTable(good))
    console.log('\nSelf-test 2/2: directly against lecture-api, which trusts client headers (must FAIL)')
    const bad = await runChecks(`http://127.0.0.1:${PORT_API}`, '')
    console.log(formatTable(bad))
    const goodOk = exitCodeFor(good) === 0
    const badFails = exitCodeFor(bad) === 1
    console.log(`\ngateway run passed: ${goodOk}; trusting-server run failed as expected: ${badFails}`)
    return goodOk && badFails ? 0 : 1
  } finally {
    await closeAll()
  }
}

function usage() {
  return 'Usage: node scripts/check_header_spoof.mjs <baseUrl> [--cookie "name=value"]\n       node scripts/check_header_spoof.mjs --self-test'
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage())
    return 0
  }
  if (args.includes('--self-test')) return selfTest()
  const base = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--cookie')
  const ci = args.indexOf('--cookie')
  const cookie = ci >= 0 ? (args[ci + 1] ?? '') : ''
  if (!base) {
    console.error(usage())
    return 2
  }
  try {
    new URL(base)
  } catch {
    console.error(`Invalid base URL: ${base}`)
    return 2
  }
  const rows = await runChecks(base, cookie)
  console.log(formatTable(rows))
  const code = exitCodeFor(rows)
  console.log(code === 0 ? '\nOK: spoofed identity headers had no effect.' : code === 1 ? '\nFAIL: see FAIL rows above.' : '\nERROR: some probes could not be completed.')
  return code
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(2)
    },
  )
}
