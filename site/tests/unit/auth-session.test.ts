import { afterEach, describe, expect, it } from 'vitest'
import { configureSession, createSessionClient, currentSession, getSession, parseSession, publishSession, resetSession, subscribeSession } from '../../docs/.vitepress/theme/auth/session'
import type { SessionState } from '../../docs/.vitepress/theme/auth/session'
import type { HttpResult } from '../../docs/.vitepress/theme/api/http'
import { fakeFetch } from './progress-helpers'

const ok = (data: unknown): HttpResult<unknown> => ({ ok: true, status: 200, data, serverDate: null })
const fail = (kind: 'network' | 'timeout' | 'http' | 'parse', status?: number): HttpResult<unknown> => ({ ok: false, kind, ...(status !== undefined ? { status } : {}), serverDate: null })

const alice = { authenticated: true, user: { id: 'alice', name: 'Alice', email: 'alice@example.com' }, roles: ['reader', 'admin'], groups: ['admins'], logoutUrl: 'https://auth.example.com/logout' }
const anonymous = { authenticated: false, user: null, roles: ['reader'], groups: [], logoutUrl: null }

afterEach(() => {
  configureSession({ adapter: 'none' })
  resetSession()
})

describe('parseSession', () => {
  it('authenticated', () => {
    expect(parseSession(ok(alice))).toEqual({
      status: 'authenticated',
      user: { id: 'alice', name: 'Alice', email: 'alice@example.com' },
      roles: ['reader', 'admin'],
      groups: ['admins'],
      logoutUrl: 'https://auth.example.com/logout',
    })
    expect(parseSession(ok({ ...alice, user: { id: 'bob' }, logoutUrl: undefined }))).toMatchObject({ user: { id: 'bob', name: null, email: null }, logoutUrl: null })
  })

  it('anonymous from the server only when the backend says so; a 401 or a redirect is the gateway, not a sign-out', () => {
    expect(parseSession(ok(anonymous))).toEqual({ status: 'anonymous', source: 'server' })
    expect(parseSession(fail('http', 401))).toEqual({ status: 'unavailable', reason: 'unauthorized' })
    expect(parseSession({ ok: false, kind: 'redirect', serverDate: null })).toEqual({ status: 'unavailable', reason: 'unauthorized' })
  })

  it('unavailable: 404 is not_found', () => {
    expect(parseSession(fail('http', 404))).toEqual({ status: 'unavailable', reason: 'not_found' })
  })

  it('unavailable: network trouble (and any other failure status) is network', () => {
    expect(parseSession(fail('network'))).toEqual({ status: 'unavailable', reason: 'network' })
    expect(parseSession(fail('timeout'))).toEqual({ status: 'unavailable', reason: 'network' })
    expect(parseSession(fail('http', 502))).toEqual({ status: 'unavailable', reason: 'network' })
  })

  it('unavailable: a body that fails validation is invalid', () => {
    expect(parseSession(ok({ hello: 'world' }))).toEqual({ status: 'unavailable', reason: 'invalid' })
    expect(parseSession(ok(null))).toEqual({ status: 'unavailable', reason: 'invalid' })
    expect(parseSession(ok({ ...alice, user: null }))).toEqual({ status: 'unavailable', reason: 'invalid' })
    expect(parseSession(fail('parse', 200))).toEqual({ status: 'unavailable', reason: 'invalid' })
  })
})

describe('session client', () => {
  it('adapter none: anonymous without any request', async () => {
    const f = fakeFetch(() => ({ status: 200, body: alice }))
    const c = createSessionClient({ adapter: 'none', fetchImpl: f.fetch })
    expect(await c.getSession()).toEqual({ status: 'anonymous', source: 'none' })
    expect(f.calls).toHaveLength(0)
  })

  it('other adapters ask the configured endpoint once per page load', async () => {
    const f = fakeFetch(() => ({ status: 200, body: alice }))
    const c = createSessionClient({ adapter: 'trusted-header', endpoint: '/api/whoami', fetchImpl: f.fetch })
    const [a, b] = await Promise.all([c.getSession(), c.getSession()])
    expect(a).toBe(b)
    expect(a.status).toBe('authenticated')
    await c.getSession()
    expect(f.calls.map((x) => `${x.method} ${x.url}`)).toEqual(['GET /api/whoami'])
    c.reset()
    await c.getSession()
    expect(f.calls).toHaveLength(2)
  })

  it('defaults to /api/auth/session', async () => {
    const f = fakeFetch(() => ({ status: 200, body: anonymous }))
    await createSessionClient({ adapter: 'trusted-header', fetchImpl: f.fetch }).getSession()
    expect(f.calls[0]?.url).toBe('/api/auth/session')
  })

  it('maps each failure to its state', async () => {
    const run = async (reply: Parameters<typeof fakeFetch>[0]): Promise<SessionState> => createSessionClient({ adapter: 'oidc', fetchImpl: fakeFetch(reply).fetch }).getSession()
    expect(await run(() => ({ status: 404 }))).toEqual({ status: 'unavailable', reason: 'not_found' })
    expect(await run(() => ({ status: 401 }))).toEqual({ status: 'unavailable', reason: 'unauthorized' })
    expect(await run(() => ({ status: 302, headers: { location: '/login' } }))).toEqual({ status: 'unavailable', reason: 'unauthorized' })
    expect(await run(() => new Error('refused'))).toEqual({ status: 'unavailable', reason: 'network' })
    expect(await run(() => ({ status: 200, body: { nope: 1 } }))).toEqual({ status: 'unavailable', reason: 'invalid' })
  })
})

describe('site session (singleton)', () => {
  it('is unknown until asked, then anonymous/none for auth none, and notifies subscribers once', async () => {
    configureSession({ adapter: 'none' })
    expect(currentSession()).toEqual({ status: 'unknown' })
    const seen: SessionState[] = []
    const off = subscribeSession((s) => seen.push(s))
    expect(await getSession()).toEqual({ status: 'anonymous', source: 'none' })
    await getSession()
    expect(currentSession()).toEqual({ status: 'anonymous', source: 'none' })
    expect(seen).toHaveLength(1)
    off()
  })

  it('SSR: a configured adapter without fetch resolves to unavailable/network, never throws', async () => {
    configureSession({ adapter: 'trusted-header', sessionEndpoint: '/api/auth/session' })
    expect(await getSession()).toEqual({ status: 'unavailable', reason: 'network' })
  })

  it('ignores an in-flight getSession() response after publishSession() or resetSession()', async () => {
    let releaseFetch!: (res: Response) => void
    let fetchCount = 0
    const origFetch = globalThis.fetch
    const hadWindow = 'window' in globalThis
    const origWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = globalThis
    globalThis.fetch = (async () => {
      fetchCount += 1
      if (fetchCount === 1) {
        return new Promise<Response>((resolve) => {
          releaseFetch = resolve
        })
      }
      return new Response(JSON.stringify(anonymous), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      configureSession({ adapter: 'local', sessionEndpoint: '/api/auth/session' })
      const seen: SessionState[] = []
      const off = subscribeSession((s) => seen.push(s))

      const pendingGet = getSession()
      publishSession({ status: 'anonymous', source: 'server' })
      expect(seen).toEqual([{ status: 'anonymous', source: 'server' }])

      releaseFetch(
        new Response(JSON.stringify(alice), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const resolved = await pendingGet
      expect(resolved).toEqual({ status: 'anonymous', source: 'server' })
      expect(currentSession()).toEqual({ status: 'anonymous', source: 'server' })
      expect(seen).toEqual([{ status: 'anonymous', source: 'server' }])

      // Fresh post-logout getSession() re-fetches normally
      resetSession()
      const fresh = await getSession()
      expect(fresh).toEqual({ status: 'anonymous', source: 'server' })
      expect(fetchCount).toBe(2)
      off()
    } finally {
      globalThis.fetch = origFetch
      if (hadWindow) {
        ;(globalThis as { window?: unknown }).window = origWindow
      } else {
        delete (globalThis as { window?: unknown }).window
      }
    }
  })
})
