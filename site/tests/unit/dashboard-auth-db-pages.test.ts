// @vitest-environment happy-dom
/**
 * Unit tests for WP-4:
 * - api/auth.ts (base64url helpers, bootstrap, password login, passkey login/register, /api/me/*)
 * - DashboardLogin.vue (bootstrap vs login, 30d remember-me cookie hint, passkey, extensible slots)
 * - PageMyLearning.vue (KPIs, export JSON, delete AI session)
 * - PageAccount.vue (change password, bind/delete passkey + 400 guard, revoke session)
 * - PageUsers.vue (list, create with roles, 409 cannot_remove_last_admin)
 * - PageDatabase.vue (Neon/PGlite presets, test connection, dry-run SQL, transfer preview, 6-table CRUD)
 */
import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockLang = ref('zh-CN')
vi.mock('vitepress', () => ({
  useData: () => ({ lang: mockLang, theme: ref({}), site: ref({ base: '/' }) }),
  withBase: (p: string) => p,
}))

import {
  ApiHttpError,
  base64urlToUint8Array,
  bootstrapAdmin,
  bufferToBase64url,
  deleteMyCredential,
  fetchMyOverview,
  loginWithPasskey,
  loginWithPassword,
  registerPasskey,
  type AuthMethodInfo,
  type AuthStatus,
} from '../../docs/.vitepress/theme/api/auth'
import {
  isAdminError,
  isAdminOk,
  isDbSwitchDryRun,
  isDbTransferDryRun,
  testDbConnection,
} from '../../docs/.vitepress/theme/api/admin'
import DashboardLogin from '../../docs/.vitepress/theme/dashboard/DashboardLogin.vue'
import PageMyLearning from '../../docs/.vitepress/theme/dashboard/pages/PageMyLearning.vue'
import PageAccount from '../../docs/.vitepress/theme/dashboard/pages/PageAccount.vue'
import PageUsers from '../../docs/.vitepress/theme/dashboard/pages/PageUsers.vue'
import PageDatabase from '../../docs/.vitepress/theme/dashboard/pages/PageDatabase.vue'
import { dashboardZhCN } from '../../docs/.vitepress/i18n/dashboard.zh-CN.ts'

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function emptyRes(status = 204): Response {
  return new Response(null, { status })
}

function bytesOf(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer
}

function stubWebAuthn(opts: {
  getCred?: unknown
  createCred?: unknown
} = {}): void {
  vi.stubGlobal('PublicKeyCredential', function MockPublicKeyCredential() {})
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      get: vi.fn(async () => opts.getCred ?? null),
      create: vi.fn(async () => opts.createCred ?? null),
    },
  })
}

describe('WP-4 api/auth.ts', () => {
  beforeEach(() => {
    mockLang.value = 'zh-CN'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('round-trips base64url <-> Uint8Array accurately', () => {
    const raw = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63])
    const encoded = bufferToBase64url(raw)
    expect(encoded).not.toMatch(/[+/=]/)
    const decoded = base64urlToUint8Array(encoded)
    expect(Array.from(decoded)).toEqual(Array.from(raw))
  })

  it('calls bootstrapAdmin and loginWithPassword with credentials: include and rememberMe', async () => {
    const calls: Array<{ url: string; method: string; body: unknown; credentials: RequestCredentials | undefined }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        calls.push({
          url,
          method: init?.method ?? 'GET',
          body: init?.body ? JSON.parse(String(init.body)) : null,
          credentials: init?.credentials,
        })
        if (url === '/api/auth/bootstrap') {
          return jsonRes(
            {
              ok: true,
              authenticated: true,
              user: { id: 'u1', username: 'admin', name: 'Admin', email: null },
              roles: ['reader', 'author', 'admin'],
              groups: [],
              canAccessAdmin: true,
              canAccessAuthor: true,
            },
            201,
          )
        }
        return jsonRes({
          ok: true,
          authenticated: true,
          user: { id: 'u2', username: 'alice', name: 'Alice', email: 'a@example.com' },
          roles: ['reader'],
          groups: [],
          canAccessAdmin: false,
          canAccessAuthor: false,
        })
      }),
    )

    const boot = await bootstrapAdmin({
      username: 'admin',
      password: 'Password123!',
      rememberMe: true,
    })
    expect(boot.canAccessAdmin).toBe(true)

    const login30d = await loginWithPassword({
      username: 'alice',
      password: 'Password123!',
      rememberMe: true,
    })
    expect(login30d.authenticated).toBe(true)

    await loginWithPassword({
      username: 'alice',
      password: 'Password123!',
      rememberMe: false,
    })

    expect(calls[0]).toMatchObject({
      url: '/api/auth/bootstrap',
      method: 'POST',
      credentials: 'include',
      body: { username: 'admin', password: 'Password123!', rememberMe: true },
    })
    expect(calls[1]).toMatchObject({
      url: '/api/auth/login',
      credentials: 'include',
      body: { username: 'alice', password: 'Password123!', rememberMe: true },
    })
    expect(calls[2]).toMatchObject({
      url: '/api/auth/login',
      credentials: 'include',
      body: { username: 'alice', password: 'Password123!', rememberMe: false },
    })
  })

  it('performs WebAuthn loginWithPasskey and registerPasskey with base64url serialization', async () => {
    const challengeBytes = new Uint8Array([10, 20, 30, 40])
    const challengeB64 = bufferToBase64url(challengeBytes)
    const credIdB64 = bufferToBase64url(new Uint8Array([1, 2, 3, 4]))

    stubWebAuthn({
      getCred: {
        id: credIdB64,
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        response: {
          clientDataJSON: bytesOf('{"type":"webauthn.get"}'),
          authenticatorData: bytesOf('authdata'),
          signature: bytesOf('sig'),
          userHandle: bytesOf('u1'),
        },
      },
      createCred: {
        id: credIdB64,
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        response: {
          clientDataJSON: bytesOf('{"type":"webauthn.create"}'),
          attestationObject: bytesOf('attestation'),
          getTransports: () => ['internal', 'hybrid'],
        },
      },
    })

    const postedBodies: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        postedBodies[url] = init?.body ? JSON.parse(String(init.body)) : null
        if (url === '/api/auth/methods/passkey/login/start') {
          return jsonRes({
            challenge: challengeB64,
            rpId: 'localhost',
            timeout: 60000,
            userVerification: 'preferred',
            allowCredentials: [{ id: credIdB64, type: 'public-key', transports: ['internal'] }],
          })
        }
        if (url === '/api/auth/methods/passkey/login/finish') {
          return jsonRes({
            ok: true,
            authenticated: true,
            user: { id: 'u1', username: 'alice', name: 'Alice', email: null },
            roles: ['reader'],
            groups: [],
            canAccessAdmin: false,
            canAccessAuthor: false,
          })
        }
        if (url === '/api/me/passkeys/register/start') {
          return jsonRes({
            challenge: challengeB64,
            rp: { id: 'localhost', name: 'Lecture Engine' },
            user: { id: bufferToBase64url(bytesOf('u1')), name: 'alice', displayName: 'Alice' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            excludeCredentials: [],
          })
        }
        if (url === '/api/me/passkeys/register/finish') {
          return jsonRes({ ok: true, credentialId: credIdB64, label: 'Laptop Touch ID' }, 201)
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const loginRes = await loginWithPasskey({ username: 'alice', rememberMe: true })
    expect(loginRes.authenticated).toBe(true)
    expect(postedBodies['/api/auth/methods/passkey/login/finish']).toMatchObject({
      id: credIdB64,
      rememberMe: true,
      response: {
        clientDataJSON: bufferToBase64url(bytesOf('{"type":"webauthn.get"}')),
        authenticatorData: bufferToBase64url(bytesOf('authdata')),
        signature: bufferToBase64url(bytesOf('sig')),
      },
    })

    const regRes = await registerPasskey({ label: 'Laptop Touch ID' })
    expect(regRes).toMatchObject({ ok: true, label: 'Laptop Touch ID' })
    expect(postedBodies['/api/me/passkeys/register/finish']).toMatchObject({
      id: credIdB64,
      label: 'Laptop Touch ID',
      response: {
        transports: ['internal', 'hybrid'],
      },
    })
  })

  it('fetches overview and throws typed ApiHttpError on deleteMyCredential 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/me/overview') {
          return jsonRes({
            user: { id: 'u1', username: 'alice', displayName: 'Alice', email: null },
            progress: { total: 4, completed: 2, in_progress: 1 },
            recentSessions: [],
            checklists: { total: 3, completed: 1 },
            passkeyCount: 1,
            currentSessionId: 's1',
            authMethod: 'passkey',
            rememberMe: true,
          })
        }
        if (url === '/api/me/credentials/c1' && init?.method === 'DELETE') {
          return jsonRes(
            {
              error: 'cannot_remove_last_login_method',
              message: 'Cannot remove last login method without a password set',
            },
            400,
          )
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const ov = await fetchMyOverview()
    expect(ov.progress.completed).toBe(2)

    await expect(deleteMyCredential('c1')).rejects.toMatchObject({
      name: 'ApiHttpError',
      status: 400,
      error: 'cannot_remove_last_login_method',
    })
    try {
      await deleteMyCredential('c1')
    } catch (e) {
      expect(e).toBeInstanceOf(ApiHttpError)
    }
  })

  it('rejects malformed base64url, handles DataView slice byteOffset, rejects redirects, and wraps DOMException', async () => {
    expect(() => base64urlToUint8Array('abc!')).toThrow('invalid_base64url')
    expect(() => base64urlToUint8Array('a')).toThrow('invalid_base64url')

    const backing = new Uint8Array([99, 1, 2, 3, 88])
    const sub = backing.subarray(1, 4)
    expect(bufferToBase64url(sub)).toBe(bufferToBase64url(new Uint8Array([1, 2, 3])))

    // Gateway 302 / opaqueredirect throws auth_redirect on auth.ts and returns auth_redirect on admin.ts
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://auth.example.com' } })),
    )
    await expect(fetchMyOverview()).rejects.toMatchObject({
      name: 'ApiHttpError',
      error: 'auth_redirect',
    })
    const adminRedirect = await testDbConnection({ targetUrl: 'pglite:./data/pglite' })
    expect(isAdminError(adminRedirect)).toBe(true)
    if (isAdminError(adminRedirect)) {
      expect(adminRedirect.error.code).toBe('auth_redirect')
    }

    // Empty ArrayBuffer userHandle is omitted; NotAllowedError DOMException is wrapped as passkey_cancelled
    const credIdB64 = bufferToBase64url(new Uint8Array([1, 2, 3]))
    const challengeB64 = bufferToBase64url(new Uint8Array([9, 8, 7]))
    let loginFinishBody: Record<string, unknown> | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/auth/methods/passkey/login/start') {
          return jsonRes({ challenge: challengeB64, allowCredentials: [] })
        }
        if (url === '/api/auth/methods/passkey/login/finish') {
          loginFinishBody = JSON.parse(String(init?.body ?? '{}'))
          return jsonRes({
            ok: true,
            authenticated: true,
            user: { id: 'u1', username: 'a', name: 'A', email: null },
            roles: ['reader'],
            groups: [],
            canAccessAdmin: false,
            canAccessAuthor: false,
          })
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )
    stubWebAuthn({
      getCred: {
        id: credIdB64,
        rawId: new Uint8Array([1, 2, 3]).buffer,
        response: {
          clientDataJSON: bytesOf('{}'),
          authenticatorData: bytesOf('ad'),
          signature: bytesOf('sig'),
          userHandle: new ArrayBuffer(0),
        },
      },
    })
    await loginWithPasskey()
    expect((loginFinishBody as unknown as { response: Record<string, unknown> }).response).not.toHaveProperty('userHandle')

    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        get: vi.fn(async () => {
          throw new DOMException('User cancelled', 'NotAllowedError')
        }),
        create: vi.fn(async () => null),
      },
    })
    await expect(loginWithPasskey()).rejects.toMatchObject({
      name: 'ApiHttpError',
      error: 'passkey_cancelled',
    })

    // Type guards narrow DbSwitchResponse and DbTransferResponse cleanly
    expect(isAdminOk({ ok: true, data: 1 })).toBe(true)
    expect(
      isDbSwitchDryRun({
        ok: true,
        dryRun: true,
        sameTarget: false,
        previousKind: 'pglite',
        targetKind: 'pg',
        migrationsApplied: 3,
        migrationsPending: [],
        dryRunSql: '',
        envWritable: true,
        databaseUrl: null,
      }),
    ).toBe(true)
    expect(
      isDbTransferDryRun({
        ok: true,
        dryRun: false,
        direction: 'push',
        conflictStrategy: 'upsert',
        results: [],
      }),
    ).toBe(false)
  })
})

describe('WP-4 DashboardLogin.vue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const methodsFixture: AuthMethodInfo[] = [
    { id: 'password', name: 'Password', description: 'Local password', enabled: true, implemented: true, extensible: false },
    { id: 'passkey', name: 'Passkey', description: 'WebAuthn', enabled: true, implemented: true, extensible: false },
    { id: 'gateway', name: 'Gateway Header', description: 'Authelia', enabled: true, implemented: true, extensible: false },
    { id: 'oidc', name: 'OpenID Connect', description: 'SSO slot', enabled: false, implemented: false, extensible: true },
    { id: 'totp', name: 'TOTP 2FA', description: '2FA slot', enabled: false, implemented: false, extensible: true },
  ]

  it('renders bootstrap form when needsBootstrap is true and emits authenticated on submit', async () => {
    const authStatus: AuthStatus = {
      authAdapter: 'local',
      authenticated: false,
      needsBootstrap: true,
      authSource: 'none',
      authMethod: 'anonymous',
      rememberMe: false,
      user: null,
      roles: ['reader'],
      groups: [],
      canAccessAdmin: false,
      canAccessAuthor: false,
      visibleSections: ['my-learning', 'account'],
    }
    let bootPayload: unknown = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/auth/bootstrap') {
          bootPayload = JSON.parse(String(init?.body ?? '{}'))
          return jsonRes(
            {
              ok: true,
              authenticated: true,
              user: { id: 'u1', username: 'rootadmin', name: 'Root Admin', email: null },
              roles: ['reader', 'author', 'admin'],
              groups: [],
              canAccessAdmin: true,
              canAccessAuthor: true,
            },
            201,
          )
        }
        return jsonRes({ ok: true })
      }),
    )

    const wrapper = mount(DashboardLogin, {
      props: { authStatus, methods: methodsFixture },
    })
    await flushPromises()
    expect(wrapper.text()).toContain(dashboardZhCN['dsh.login.bootstrapTitle'])
    expect(wrapper.find('[data-login-passkey]').exists()).toBe(false)

    await wrapper.get('[data-login-username]').setValue('rootadmin')
    await wrapper.get('[data-login-displayname]').setValue('Root Admin')
    await wrapper.get('[data-login-password]').setValue('StrongPass123!')
    await wrapper.get('[data-login-confirm]').setValue('StrongPass123!')
    await wrapper.get('[data-login-form]').trigger('submit')
    await flushPromises()

    expect(bootPayload).toMatchObject({
      username: 'rootadmin',
      displayName: 'Root Admin',
      rememberMe: true,
    })
    expect(wrapper.emitted('authenticated')).toHaveLength(1)
    wrapper.unmount()
  })

  it('toggles 30-day cookie hint, supports passkey login, and renders extensible slots', async () => {
    const challengeB64 = bufferToBase64url(new Uint8Array([9, 8, 7]))
    const credIdB64 = bufferToBase64url(new Uint8Array([4, 5, 6]))
    stubWebAuthn({
      getCred: {
        id: credIdB64,
        rawId: new Uint8Array([4, 5, 6]).buffer,
        response: {
          clientDataJSON: bytesOf('{}'),
          authenticatorData: bytesOf('ad'),
          signature: bytesOf('sig'),
        },
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/auth/methods/passkey/login/start') {
          return jsonRes({ challenge: challengeB64, allowCredentials: [] })
        }
        if (url === '/api/auth/methods/passkey/login/finish') {
          return jsonRes({
            ok: true,
            authenticated: true,
            user: { id: 'u2', username: 'bob', name: 'Bob', email: null },
            roles: ['reader'],
            groups: [],
            canAccessAdmin: false,
            canAccessAuthor: false,
          })
        }
        return jsonRes({ ok: true })
      }),
    )

    const authStatus: AuthStatus = {
      authAdapter: 'hybrid',
      authenticated: false,
      needsBootstrap: false,
      authSource: 'none',
      authMethod: 'anonymous',
      rememberMe: false,
      user: null,
      roles: ['reader'],
      groups: [],
      canAccessAdmin: false,
      canAccessAuthor: false,
      visibleSections: ['my-learning', 'account'],
    }

    const wrapper = mount(DashboardLogin, {
      props: { authStatus, methods: methodsFixture, gatewayLoginUrl: 'https://auth.example.com' },
    })
    await flushPromises()

    expect(wrapper.get('[data-login-cookie-hint]').text()).toBe(dashboardZhCN['dsh.login.cookie30d'])
    await wrapper.get('[data-login-remember]').setValue(false)
    expect(wrapper.get('[data-login-cookie-hint]').text()).toBe(dashboardZhCN['dsh.login.cookieSession'])

    expect(wrapper.find('[data-login-gateway]').exists()).toBe(true)
    expect(wrapper.get('[data-login-gateway-link]').attributes('href')).toBe('https://auth.example.com')
    expect(wrapper.find('[data-login-extensible="oidc"]').exists()).toBe(true)
    expect(wrapper.find('[data-login-extensible="totp"]').exists()).toBe(true)

    await wrapper.get('[data-login-passkey]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('authenticated')).toHaveLength(1)
    wrapper.unmount()
  })

  it('hides password form when password method disabled, substitutes {rd}, and rejects javascript: URLs', async () => {
    const authStatus: AuthStatus = {
      authAdapter: 'hybrid',
      authenticated: false,
      needsBootstrap: false,
      authSource: 'none',
      authMethod: 'anonymous',
      rememberMe: false,
      user: null,
      roles: ['reader'],
      groups: [],
      canAccessAdmin: false,
      canAccessAuthor: false,
      visibleSections: ['my-learning', 'account'],
    }
    const noPwMethods: AuthMethodInfo[] = [
      { id: 'password', name: 'Password', description: 'Local', enabled: false, implemented: true, extensible: false },
      { id: 'passkey', name: 'Passkey', description: 'WebAuthn', enabled: true, implemented: true, extensible: false },
      { id: 'gateway', name: 'Gateway', description: 'Authelia', enabled: true, implemented: true, extensible: false },
    ]

    const w1 = mount(DashboardLogin, {
      props: {
        authStatus,
        methods: noPwMethods,
        gatewayLoginUrl: 'https://sso.example.com/?rd={rd}',
      },
    })
    await flushPromises()
    expect(w1.find('[data-login-password]').exists()).toBe(false)
    expect(w1.find('[data-login-password-disabled]').exists()).toBe(true)
    expect(w1.find('[data-login-passkey]').exists()).toBe(true)
    expect(w1.get('[data-login-gateway-link]').attributes('href')).toContain('https://sso.example.com/?rd=http')
    w1.unmount()

    const w2 = mount(DashboardLogin, {
      props: {
        authStatus,
        methods: noPwMethods,
        gatewayLoginUrl: 'javascript:alert(1)',
      },
    })
    await flushPromises()
    expect(w2.find('[data-login-gateway-link]').exists()).toBe(false)
    w2.unmount()
  })
})

describe('WP-4 PageMyLearning.vue & PageAccount.vue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('PageMyLearning renders stats, deletes AI session with reload, and exports JSON with delayed revoke', async () => {
    vi.useFakeTimers()
    const createObjectUrlSpy = vi.fn(() => 'blob:mock-export')
    const revokeObjectUrlSpy = vi.fn()
    const origCreateUrl = URL.createObjectURL
    const origRevokeUrl = URL.revokeObjectURL
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrlSpy })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrlSpy })

    let deletedSessionUrl = ''
    let sessionsState = [
      {
        id: 'sess-1',
        lecture_id: 'g01/L01',
        group_id: 'G01',
        title: 'Ohm Law Discussion',
        is_archived: false,
        created_at: '2026-11-24T08:00:00Z',
        updated_at: '2026-11-24T09:00:00Z',
      },
      {
        id: 'sess-2',
        lecture_id: 'g01/L02',
        group_id: 'G01',
        title: 'Kirchhoff Follow-up',
        is_archived: false,
        created_at: '2026-11-24T07:00:00Z',
        updated_at: '2026-11-24T08:00:00Z',
      },
    ]
    let overviewCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/me/overview') {
          overviewCalls += 1
          return jsonRes({
            user: { id: 'u1', username: 'reader1', displayName: 'Reader One', email: 'r@example.com' },
            progress: { total: 8, completed: 5, in_progress: 2 },
            recentSessions: sessionsState,
            checklists: { total: 4, completed: 3 },
            passkeyCount: 2,
            currentSessionId: 'auth-s1',
            authMethod: 'password',
            rememberMe: true,
          })
        }
        if (url === '/api/db/sessions/sess-1' && init?.method === 'DELETE') {
          deletedSessionUrl = url
          sessionsState = sessionsState.filter((s) => s.id !== 'sess-1')
          return emptyRes(204)
        }
        if (url === '/api/me/export') {
          return jsonRes(
            {
              exportedAt: '2026-11-24T10:00:00Z',
              profile: { id: 'u1', username: 'reader1', displayName: 'Reader One', email: null },
              progress: [],
              aiSessions: [],
              aiReviewChecklists: [],
            },
            200,
            { 'content-disposition': 'attachment; filename="my-learning-export.json"' },
          )
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    try {
      const wrapper = mount(PageMyLearning, { attachTo: document.body })
      await flushPromises()

      expect(wrapper.get('[data-me-kpis]').text()).toContain('5')
      expect(wrapper.get('[data-me-auth-method]').text()).toBe(dashboardZhCN['dsh.me.methodPassword'])
      expect(wrapper.get('[data-me-cookie-badge]').text()).toBe(dashboardZhCN['dsh.me.cookie30dBadge'])
      expect(wrapper.find('[data-me-session-row="sess-1"]').exists()).toBe(true)

      await wrapper.get('[data-me-export]').trigger('click')
      await flushPromises()
      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1)
      expect(revokeObjectUrlSpy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:mock-export')
      expect(wrapper.get('[data-me-status]').text()).toContain('my-learning-export.json')

      await wrapper.get('[data-me-delete-session="sess-1"]').trigger('click')
      await wrapper.get('[data-me-confirm-delete="sess-1"]').trigger('click')
      await flushPromises()
      expect(deletedSessionUrl).toBe('/api/db/sessions/sess-1')
      expect(overviewCalls).toBe(2)
      expect(wrapper.find('[data-me-session-row="sess-1"]').exists()).toBe(false)
      expect(wrapper.find('[data-me-session-row="sess-2"]').exists()).toBe(true)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: origCreateUrl })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: origRevokeUrl })
    }
  })

  it('PageAccount changes password, binds passkey, surfaces 400 error, and revokes session', async () => {
    const challengeB64 = bufferToBase64url(new Uint8Array([1, 2, 3]))
    const credIdB64 = bufferToBase64url(new Uint8Array([7, 8, 9]))
    stubWebAuthn({
      createCred: {
        id: credIdB64,
        rawId: new Uint8Array([7, 8, 9]).buffer,
        response: {
          clientDataJSON: bytesOf('{}'),
          attestationObject: bytesOf('att'),
          getTransports: () => ['internal'],
        },
      },
    })

    let credsList = [
      {
        id: 'cred-1',
        method: 'passkey',
        credential_id: 'abc',
        algorithm: -7,
        label: 'YubiKey',
        aaguid: '0000',
        last_used_at: null,
        created_at: '2026-11-24T08:00:00Z',
      },
    ]
    let sessionsList = [
      {
        id: 's-cur',
        auth_method: 'password',
        remember_me: true,
        user_agent: 'Mozilla/5.0',
        ip_address: '127.0.0.1',
        expires_at: '2026-12-24T08:00:00Z',
        created_at: '2026-11-24T08:00:00Z',
        last_seen_at: '2026-11-24T09:00:00Z',
        is_current: true,
      },
      {
        id: 's-other',
        auth_method: 'passkey',
        remember_me: false,
        user_agent: 'Safari',
        ip_address: '127.0.0.2',
        expires_at: '2026-11-24T20:00:00Z',
        created_at: '2026-11-24T08:00:00Z',
        last_seen_at: '2026-11-24T08:30:00Z',
        is_current: false,
      },
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (url === '/api/auth/status' && method === 'GET') {
          return jsonRes({
            authAdapter: 'local',
            authenticated: true,
            needsBootstrap: false,
            authSource: 'session',
            authMethod: 'password',
            rememberMe: true,
            user: { id: 'u1', username: 'alice', name: 'Alice', email: null },
            roles: ['reader'],
            groups: [],
            canAccessAdmin: false,
            canAccessAuthor: false,
            visibleSections: ['my-learning', 'account'],
          })
        }
        if (url === '/api/me/credentials' && method === 'GET') return jsonRes(credsList)
        if (url === '/api/me/sessions' && method === 'GET') return jsonRes(sessionsList)
        if (url === '/api/me/password' && method === 'PUT') {
          sessionsList = sessionsList.filter((s) => s.is_current)
          return jsonRes({ ok: true })
        }
        if (url === '/api/me/passkeys/register/start') {
          return jsonRes({
            challenge: challengeB64,
            rp: { id: 'localhost', name: 'Lecture Engine' },
            user: { id: challengeB64, name: 'alice', displayName: 'Alice' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          })
        }
        if (url === '/api/me/passkeys/register/finish') {
          credsList = [
            ...credsList,
            {
              id: 'cred-2',
              method: 'passkey',
              credential_id: credIdB64,
              algorithm: -7,
              label: 'Office Key',
              aaguid: '0000',
              last_used_at: null,
              created_at: '2026-11-24T10:00:00Z',
            },
          ]
          return jsonRes({ ok: true, credentialId: credIdB64, label: 'Office Key' })
        }
        if (url === '/api/me/credentials/cred-1' && method === 'DELETE') {
          return jsonRes({ error: 'cannot_remove_last_login_method', message: 'Last method' }, 400)
        }
        if (url === '/api/me/sessions/s-other' && method === 'DELETE') {
          sessionsList = sessionsList.filter((s) => s.id !== 's-other')
          return jsonRes({ ok: true })
        }
        if (url === '/api/me/sessions/s-cur' && method === 'DELETE') {
          sessionsList = sessionsList.filter((s) => s.id !== 's-cur')
          return jsonRes({ ok: true })
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const wrapper = mount(PageAccount)
    await flushPromises()

    expect(wrapper.find('[data-acct-cred="cred-1"]').exists()).toBe(true)
    expect(wrapper.find('[data-acct-session="s-other"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-acct-cred="cred-1"] td.db-nw').length).toBe(2)
    expect(wrapper.findAll('[data-acct-session="s-other"] td.db-nw').length).toBe(2)
    expect(wrapper.findAll('[data-acct-sessions-panel] thead th.db-nw').length).toBe(2)

    // 2-step session revoke with cancel & confirm
    await wrapper.get('[data-acct-revoke-session="s-other"]').trigger('click')
    expect(wrapper.find('[data-acct-confirm-revoke-session="s-other"]').exists()).toBe(true)
    await wrapper.get('[data-acct-cancel-revoke-session="s-other"]').trigger('click')
    expect(wrapper.find('[data-acct-session="s-other"]').exists()).toBe(true)
    await wrapper.get('[data-acct-revoke-session="s-other"]').trigger('click')
    await wrapper.get('[data-acct-confirm-revoke-session="s-other"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-acct-session="s-other"]').exists()).toBe(false)

    // 2-step credential deletion surfacing 400 guard
    await wrapper.get('[data-acct-delete-cred="cred-1"]').trigger('click')
    await wrapper.get('[data-acct-confirm-delete-cred="cred-1"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-acct-error]').text()).toBe(dashboardZhCN['dsh.acct.errLastLoginMethod'])

    await wrapper.get('[data-acct-passkey-label]').setValue('Office Key')
    await wrapper.get('[data-acct-bind-passkey]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-acct-cred="cred-2"]').exists()).toBe(true)

    await wrapper.get('[data-acct-current-pw]').setValue('OldPass123!')
    await wrapper.get('[data-acct-new-pw]').setValue('NewStrongPass123!')
    await wrapper.get('[data-acct-confirm-pw]').setValue('NewStrongPass123!')
    await wrapper.get('[data-acct-password-panel] form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-acct-status]').text()).toBe(dashboardZhCN['dsh.acct.pwChanged'])

    // Revoking current session emits loggedOut
    await wrapper.get('[data-acct-revoke-session="s-cur"]').trigger('click')
    await wrapper.get('[data-acct-confirm-revoke-session="s-cur"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('loggedOut')).toHaveLength(1)
    wrapper.unmount()
  })

  it('PageAccount displays gateway notice and maps gateway_managed_account on Passkey bind', async () => {
    stubWebAuthn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/auth/status') {
          return jsonRes({
            authAdapter: 'hybrid',
            authenticated: true,
            needsBootstrap: false,
            authSource: 'gateway',
            authMethod: 'gateway',
            rememberMe: false,
            user: { id: 'gw1', username: 'gw', name: 'Gateway User', email: null },
            roles: ['reader'],
            groups: ['users'],
            canAccessAdmin: false,
            canAccessAuthor: false,
            visibleSections: ['my-learning', 'account'],
          })
        }
        if (url === '/api/me/credentials' || url === '/api/me/sessions') return jsonRes([])
        if (url === '/api/me/passkeys/register/start') {
          return jsonRes({ error: 'gateway_managed_account', message: 'External gateway' }, 400)
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const wrapper = mount(PageAccount)
    await flushPromises()
    expect(wrapper.find('[data-acct-gateway-banner]').exists()).toBe(true)

    await wrapper.get('[data-acct-bind-passkey]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-acct-error]').text()).toBe(dashboardZhCN['dsh.acct.passkeyGatewayMsg'])
    wrapper.unmount()
  })
})

describe('WP-4 PageUsers.vue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders user list, creates user with roles, and displays 409 cannot_remove_last_admin', async () => {
    const users = [
      {
        id: 'u-admin',
        username: 'admin1',
        email: 'admin@example.com',
        displayName: 'Admin One',
        roles: ['reader', 'author', 'admin'],
        disabled: false,
        lastLoginAt: '2026-11-24T09:00:00Z',
        createdAt: '2026-11-20T09:00:00Z',
        updatedAt: '2026-11-24T09:00:00Z',
      },
    ]
    let createdBody: unknown = null

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (url === '/api/admin/users' && method === 'GET') return jsonRes(users)
        if (url === '/api/admin/users' && method === 'POST') {
          createdBody = JSON.parse(String(init?.body ?? '{}'))
          return jsonRes(
            {
              id: 'u-author',
              username: 'author1',
              email: 'author@example.com',
              displayName: 'Author One',
              roles: ['reader', 'author'],
              disabled: false,
              lastLoginAt: null,
              createdAt: '2026-11-24T10:00:00Z',
              updatedAt: '2026-11-24T10:00:00Z',
            },
            201,
          )
        }
        if (url.endsWith('/u-admin/status') && method === 'PUT') {
          return jsonRes(
            {
              error: 'cannot_remove_last_admin',
              message: 'Cannot disable the last active administrator',
            },
            409,
          )
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const wrapper = mount(PageUsers)
    await flushPromises()

    expect(wrapper.find('[data-user-row="u-admin"]').exists()).toBe(true)

    await wrapper.get('[data-users-open-create]').trigger('click')
    await wrapper.get('[data-usr-create-username]').setValue('author1')
    await wrapper.get('[data-usr-create-displayname]').setValue('Author One')
    await wrapper.get('[data-usr-create-email]').setValue('author@example.com')
    await wrapper.get('[data-usr-create-password]').setValue('AuthorPass123!')
    await wrapper.get('[data-usr-create-role-author]').setValue(true)
    await wrapper.get('[data-users-create-panel] form').trigger('submit')
    await flushPromises()

    expect(createdBody).toMatchObject({
      username: 'author1',
      roles: ['reader', 'author'],
    })
    expect(wrapper.find('[data-user-row="u-author"]').exists()).toBe(true)

    await wrapper.get('[data-user-toggle-status="u-admin"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-users-error]').text()).toBe(dashboardZhCN['dsh.usr.errLastAdmin'])
    wrapper.unmount()
  })

  it('requires initial password on user creation, supports inline role edit 409, and password reset', async () => {
    const requests: Array<{ url: string; method: string; body: unknown }> = []
    const users = [
      {
        id: 'u-admin',
        username: 'admin1',
        email: null,
        displayName: 'Admin One',
        roles: ['reader', 'author', 'admin'],
        disabled: false,
        lastLoginAt: null,
        createdAt: '2026-11-20T09:00:00Z',
        updatedAt: '2026-11-24T09:00:00Z',
      },
      {
        id: 'u-passkey',
        username: 'pk1',
        email: null,
        displayName: 'Passkey User',
        roles: ['reader'],
        disabled: false,
        lastLoginAt: null,
        createdAt: '2026-11-21T09:00:00Z',
        updatedAt: '2026-11-24T09:00:00Z',
      },
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : null
        requests.push({ url, method, body })

        if (url === '/api/admin/users' && method === 'GET') return jsonRes(users)
        if (url === '/api/admin/users' && method === 'POST') {
          return jsonRes(
            {
              id: 'u-new-pk',
              username: 'pk2',
              email: null,
              displayName: 'pk2',
              roles: ['reader'],
              disabled: false,
              lastLoginAt: null,
              createdAt: '2026-11-24T10:00:00Z',
              updatedAt: '2026-11-24T10:00:00Z',
            },
            201,
          )
        }
        if (url.endsWith('/u-admin/roles') && method === 'PUT') {
          return jsonRes({ error: 'cannot_remove_last_admin', message: 'Last admin' }, 409)
        }
        if (url.endsWith('/u-passkey/password') && method === 'PUT') {
          return jsonRes({ ok: true })
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const wrapper = mount(PageUsers)
    await flushPromises()

    await wrapper.get('[data-users-open-create]').trigger('click')
    expect(wrapper.find('[data-usr-create-passwordless]').exists()).toBe(false)
    await wrapper.get('[data-usr-create-username]').setValue('pk2')
    await wrapper.get('[data-usr-create-password]').setValue('short')
    await wrapper.get('[data-users-create-panel] form').trigger('submit')
    await flushPromises()
    expect(wrapper.get('[data-users-error]').text()).toBe(dashboardZhCN['dsh.login.errPasswordShort'])

    await wrapper.get('[data-usr-create-password]').setValue('Password123!')
    await wrapper.get('[data-users-create-panel] form').trigger('submit')
    await flushPromises()
    expect(requests.find((r) => r.url === '/api/admin/users' && r.method === 'POST')?.body).toMatchObject({
      username: 'pk2',
      password: 'Password123!',
    })

    await wrapper.get('[data-user-edit-roles="u-admin"]').trigger('click')
    await wrapper.get('[data-role-admin="u-admin"]').setValue(false)
    await wrapper.get('[data-save-roles="u-admin"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-users-error]').text()).toBe(dashboardZhCN['dsh.usr.errLastAdmin'])

    await wrapper.get('[data-user-reset-pw="u-passkey"]').trigger('click')
    await wrapper.get('[data-reset-pw-input="u-passkey"]').setValue('ResetStrong123!')
    await wrapper.get('[data-confirm-reset-pw="u-passkey"]').trigger('click')
    await flushPromises()
    expect(requests.find((r) => r.url.endsWith('/u-passkey/password'))?.body).toEqual({
      newPassword: 'ResetStrong123!',
    })
    expect(wrapper.get('[data-users-status]').text()).toContain('pk1')
    wrapper.unmount()
  })
})

describe('WP-4 PageDatabase.vue', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('switches presets, tests connection, runs SQL dry-run, previews transfer, and performs 6-table CRUD', async () => {
    let dbRows: Array<Record<string, unknown>> = [
      {
        user_id: 'u1',
        lecture_id: 'g01/L01',
        group_id: 'G01',
        status: '已完成',
        completed_at: '2026-11-24T08:00:00Z',
        updated_at: '2026-11-24T08:00:00Z',
        notion_node_id: null,
        notion_page_id: null,
      },
    ]
    let sessionRows = [
      {
        user_id: 'u1',
        id: 'sess-99',
        lecture_id: 'g01/L01',
        group_id: 'G01',
        title: 'Review Chat',
        is_archived: false,
        created_at: '2026-11-24T08:00:00Z',
        updated_at: '2026-11-24T08:00:00Z',
      },
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'

        if (url === '/api/admin/db/config') {
          return jsonRes({
            ok: true,
            kind: 'pglite',
            databaseUrl: 'pglite:./data/pglite',
            databaseUrlDirect: null,
            pgliteDir: './data/pglite',
            envFilePath: 'server/.env',
            envWritable: true,
            migrations: { applied: 4, pending: 0, total: 4 },
            tableCounts: { progress: dbRows.length, ai_sessions: sessionRows.length },
          })
        }
        if (url === '/api/admin/db/tables') {
          return jsonRes({
            ok: true,
            tables: [
              {
                name: 'progress',
                pkColumns: ['user_id', 'lecture_id'],
                columns: ['user_id', 'lecture_id', 'group_id', 'status', 'completed_at', 'updated_at', 'notion_node_id', 'notion_page_id'],
                readOnlyColumns: ['user_id', 'lecture_id', 'updated_at'],
                editableColumns: ['group_id', 'status', 'completed_at', 'notion_node_id', 'notion_page_id'],
                searchableColumns: ['user_id', 'lecture_id', 'group_id', 'status'],
                defaultSort: 'updated_at',
                rowCount: dbRows.length,
              },
              {
                name: 'ai_sessions',
                pkColumns: ['user_id', 'id'],
                columns: ['user_id', 'id', 'lecture_id', 'group_id', 'title', 'is_archived', 'created_at', 'updated_at'],
                readOnlyColumns: ['user_id', 'id', 'created_at', 'updated_at'],
                editableColumns: ['lecture_id', 'group_id', 'title', 'is_archived'],
                searchableColumns: ['user_id', 'id', 'lecture_id', 'group_id', 'title'],
                defaultSort: 'updated_at',
                rowCount: sessionRows.length,
              },
            ],
          })
        }
        if (url.startsWith('/api/admin/db/tables/progress/rows') && method === 'GET') {
          return jsonRes({
            ok: true,
            table: 'progress',
            rows: dbRows,
            total: dbRows.length,
            limit: 25,
            offset: 0,
            sort: 'updated_at',
            order: 'desc',
          })
        }
        if (url === '/api/admin/db/tables/progress/rows' && method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
          const created: Record<string, unknown> = { ...body, completed_at: null, updated_at: '2026-11-24T10:00:00Z', notion_node_id: null, notion_page_id: null }
          dbRows = [...dbRows, created]
          return jsonRes({ ok: true, table: 'progress', row: created }, 201)
        }
        if (url === '/api/admin/db/tables/progress/rows' && method === 'PATCH') {
          const body = JSON.parse(String(init?.body ?? '{}')) as { pk: { user_id: string; lecture_id: string }; data: Record<string, unknown> }
          dbRows = dbRows.map((r) =>
            r.user_id === body.pk.user_id && r.lecture_id === body.pk.lecture_id ? { ...r, ...body.data } : r,
          )
          return jsonRes({ ok: true, table: 'progress', row: dbRows[0] })
        }
        if (url.startsWith('/api/admin/db/tables/ai_sessions/rows') && method === 'GET') {
          return jsonRes({
            ok: true,
            table: 'ai_sessions',
            rows: sessionRows,
            total: sessionRows.length,
            limit: 25,
            offset: 0,
            sort: 'updated_at',
            order: 'desc',
          })
        }
        if (url === '/api/admin/db/tables/ai_sessions/rows' && method === 'DELETE') {
          sessionRows = []
          return jsonRes({ ok: true, table: 'ai_sessions', deleted: { user_id: 'u1', id: 'sess-99' } })
        }
        if (url === '/api/admin/db/test') {
          return jsonRes({
            ok: true,
            kind: 'pg',
            serverVersion: 'PostgreSQL 16.4 on Neon',
            latencyMs: 12.3,
            migrationsApplied: 4,
            migrationsPending: 0,
            targetRedacted: 'postgresql://***@ep.neon.tech/neondb',
          })
        }
        if (url === '/api/admin/db/migrate') {
          return jsonRes({
            ok: true,
            dryRun: true,
            applied: [],
            pending: ['005_extra.sql'],
            dryRunSql: 'CREATE TABLE IF NOT EXISTS demo (id text);',
          })
        }
        if (url === '/api/admin/db/transfer') {
          return jsonRes({
            ok: true,
            dryRun: true,
            direction: 'push',
            tables: [
              { table: 'auth_users', sourceCount: 2, targetCount: 0 },
              { table: 'progress', sourceCount: 1, targetCount: 0 },
            ],
          })
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const wrapper = mount(PageDatabase)
    await flushPromises()

    expect(wrapper.get('[data-db-active-kind]').text()).toBe('pglite')
    expect(wrapper.find('[data-db-row="0"]').text()).toContain('g01/L01')

    // Switch to Neon preset: keeps placeholder without live dummy credentials, test connection with real URL
    await wrapper.get('[data-db-preset-neon]').trigger('click')
    const urlInput = wrapper.get('[data-db-target-url]').element as HTMLInputElement
    expect(urlInput.value).toBe('')
    expect(urlInput.placeholder).toContain('postgresql://')
    await wrapper.get('[data-db-target-url]').setValue('postgresql://admin:secret@db.example.com/app?sslmode=require')
    await wrapper.get('[data-db-test-btn]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-db-test-meta]').text()).toContain('PostgreSQL 16.4')

    // Dry-run SQL
    await wrapper.get('[data-db-dryrun-sql-btn]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-db-dryrun-sql]').text()).toContain('CREATE TABLE IF NOT EXISTS demo')

    // Transfer dry-run (requires explicit target URL)
    await wrapper.get('[data-db-transfer-url]').setValue('postgresql://admin:secret@db.example.com/app')
    await wrapper.get('[data-db-transfer-dryrun]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-db-transfer-result]').text()).toContain('auth_users')

    // Create row on progress
    await wrapper.get('[data-db-add-row]').trigger('click')
    await wrapper.get('[data-db-field="user_id"]').setValue('u2')
    await wrapper.get('[data-db-field="lecture_id"]').setValue('g02/L01')
    await wrapper.get('[data-db-field="group_id"]').setValue('G02')
    await wrapper.get('[data-db-field="status"]').setValue('学习中')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    await flushPromises()
    expect(wrapper.findAll('[data-db-row]')).toHaveLength(2)

    // Edit row
    await wrapper.get('[data-db-edit-row="0"]').trigger('click')
    await wrapper.get('[data-db-field="group_id"]').setValue('G01-EDIT')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-db-row="0"]').text()).toContain('G01-EDIT')

    // Switch to ai_sessions tab and delete with cascade warning
    await wrapper.get('[data-db-table-tab="ai_sessions"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-db-delete-row="0"]').trigger('click')
    expect(wrapper.find('[data-db-cascade-warn]').exists()).toBe(true)
    await wrapper.get('[data-db-confirm-delete-row]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-db-row]')).toHaveLength(0)

    wrapper.unmount()
  })

  it('enforces 2-step confirm on live switch/transfer, preserves NOT NULL empty strings vs nullable cols, validates int/jsonb, and clamps pagination', async () => {
    const switchCalls: boolean[] = []
    const transferPayloads: Array<Record<string, unknown>> = []
    const patchPayloads: Array<Record<string, unknown>> = []
    const postPayloads: Array<Record<string, unknown>> = []
    const rowOffsets: number[] = []

    const tablesFixture = [
      {
        name: 'ai_messages',
        pkColumns: ['user_id', 'id'],
        columns: ['user_id', 'id', 'session_id', 'role', 'content', 'selected_context', 'model', 'prompt_tokens', 'completion_tokens', 'created_at'],
        readOnlyColumns: ['user_id', 'id', 'created_at'],
        editableColumns: ['session_id', 'role', 'content', 'selected_context', 'model', 'prompt_tokens', 'completion_tokens'],
        searchableColumns: ['user_id', 'content', 'model'],
        defaultSort: 'created_at',
        rowCount: 30,
      },
      {
        name: 'auth_users',
        pkColumns: ['id'],
        columns: ['id', 'username', 'email', 'display_name', 'roles', 'disabled', 'last_login_at', 'created_at', 'updated_at'],
        readOnlyColumns: ['id', 'last_login_at', 'created_at', 'updated_at'],
        editableColumns: ['username', 'email', 'display_name', 'roles', 'disabled', 'password'],
        searchableColumns: ['username', 'email', 'display_name'],
        defaultSort: 'created_at',
        rowCount: 1,
      },
      {
        name: 'site_settings',
        pkColumns: ['key'],
        columns: ['key', 'value', 'updated_by', 'updated_at'],
        readOnlyColumns: ['key', 'updated_at'],
        editableColumns: ['value', 'updated_by'],
        searchableColumns: ['key'],
        defaultSort: 'updated_at',
        rowCount: 1,
      },
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        const body = init?.body ? JSON.parse(String(init.body)) : null

        if (url === '/api/admin/db/config') {
          return jsonRes({
            ok: true,
            kind: 'pglite',
            databaseUrl: 'pglite:./data/pglite',
            databaseUrlDirect: null,
            pgliteDir: './data/pglite',
            envFilePath: 'server/.env',
            envWritable: true,
            migrations: { applied: 4, pending: 0, total: 4 },
            tableCounts: { ai_messages: 30, auth_users: 1, site_settings: 1 },
          })
        }
        if (url === '/api/admin/db/tables') {
          return jsonRes({ ok: true, tables: tablesFixture })
        }
        if (url.startsWith('/api/admin/db/tables/ai_messages/rows') && method === 'GET') {
          const qs = new URLSearchParams(url.split('?')[1] ?? '')
          const offset = Number(qs.get('offset') ?? '0')
          rowOffsets.push(offset)
          // Simulate shrink on offset=25 -> empty page on second call unless clamped, or return rows for 0 and 25
          const rows =
            offset >= 50
              ? []
              : [
                  {
                    user_id: 'u1',
                    id: `m-${offset}`,
                    session_id: 's1',
                    role: 'user',
                    content: 'Hello',
                    selected_context: 'ctx',
                    model: 'gpt-5',
                    prompt_tokens: 10,
                    completion_tokens: 20,
                    created_at: '2026-11-24T10:00:00Z',
                  },
                ]
          return jsonRes({
            ok: true,
            table: 'ai_messages',
            rows,
            total: offset >= 50 ? 30 : 60,
            limit: 25,
            offset,
            sort: 'created_at',
            order: 'desc',
          })
        }
        if (url === '/api/admin/db/tables/ai_messages/rows' && method === 'PATCH') {
          patchPayloads.push(body.data)
          return jsonRes({ ok: true, table: 'ai_messages', row: { id: 'm-0', ...body.data } })
        }
        if (url.startsWith('/api/admin/db/tables/auth_users/rows') && method === 'GET') {
          return jsonRes({
            ok: true,
            table: 'auth_users',
            rows: [
              {
                id: 'u1',
                username: 'alice',
                email: 'a@example.com',
                display_name: 'Alice',
                roles: ['reader'],
                disabled: false,
                last_login_at: null,
                created_at: '2026-11-24T10:00:00Z',
                updated_at: '2026-11-24T10:00:00Z',
              },
            ],
            total: 1,
            limit: 25,
            offset: 0,
            sort: 'created_at',
            order: 'desc',
          })
        }
        if (url === '/api/admin/db/tables/auth_users/rows' && method === 'PATCH') {
          patchPayloads.push(body.data)
          return jsonRes({ ok: true, table: 'auth_users', row: { id: 'u1', ...body.data } })
        }
        if (url === '/api/admin/db/tables/auth_users/rows' && method === 'POST') {
          postPayloads.push(body)
          return jsonRes({ ok: true, table: 'auth_users', row: { id: 'u2', ...body } }, 201)
        }
        if (url === '/api/admin/db/switch' && method === 'POST') {
          switchCalls.push(Boolean(body.dryRun))
          return jsonRes({
            ok: true,
            dryRun: false,
            previousKind: 'pglite',
            currentKind: 'pg',
            migrationsApplied: [],
            envUpdated: true,
            backupPath: '.env.bak',
            databaseUrl: 'postgresql://***@ep.neon.tech/neondb',
          })
        }
        if (url === '/api/admin/db/transfer' && method === 'POST') {
          transferPayloads.push(body)
          return jsonRes({
            ok: true,
            dryRun: false,
            direction: 'push',
            conflictStrategy: 'upsert',
            results: [{ table: 'auth_users', sourceCount: 1, transferredCount: 1, targetCount: 1 }],
          })
        }
        return jsonRes({ error: 'not_found' }, 404)
      }),
    )

    const wrapper = mount(PageDatabase)
    await flushPromises()

    // Initial load of ai_messages (total=30); advance 2 pages past end to test clamping when shrink returns [] at offset=50
    await wrapper.get('[data-db-next-page]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-db-next-page]').trigger('click')
    await flushPromises()
    expect(rowOffsets).toEqual([0, 25, 50, 25])

    // Live switch requires 2-step confirmation
    await wrapper.get('[data-db-preset-neon]').trigger('click')
    await wrapper.get('[data-db-target-url]').setValue('postgresql://u:p@ep.neon.tech/neondb')
    await wrapper.get('[data-db-switch-btn]').trigger('click')
    expect(switchCalls).toHaveLength(0)
    expect(wrapper.find('[data-db-switch-confirm]').exists()).toBe(true)
    await wrapper.get('[data-db-confirm-switch]').trigger('click')
    await flushPromises()
    expect(switchCalls).toEqual([false])

    // Live transfer requires 2-step confirm and forwards targetDirectUrl
    await wrapper.get('[data-db-transfer-url]').setValue('postgresql://u:p@ep.neon.tech/neondb')
    await wrapper.get('[data-db-transfer-direct]').setValue('postgresql://u:p@direct.neon.tech/neondb')
    await wrapper.get('[data-db-transfer-run]').trigger('click')
    expect(transferPayloads).toHaveLength(0)
    await wrapper.get('[data-db-confirm-transfer]').trigger('click')
    await flushPromises()
    expect(transferPayloads[0]).toMatchObject({
      dryRun: false,
      targetDirectUrl: 'postgresql://u:p@direct.neon.tech/neondb',
    })

    // INT_COLS strict validation rejects "10abc" and blank on edit
    await wrapper.get('[data-db-edit-row="0"]').trigger('click')
    await wrapper.get('[data-db-field="prompt_tokens"]').setValue('10abc')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    expect(wrapper.get('[data-db-error]').text()).toContain('prompt_tokens')
    expect(patchPayloads).toHaveLength(0)

    // Clearing nullable selected_context -> null, while clearing NOT NULL DEFAULT '' model -> ''
    await wrapper.get('[data-db-field="prompt_tokens"]').setValue('12')
    await wrapper.get('[data-db-field="selected_context"]').setValue('')
    await wrapper.get('[data-db-field="model"]').setValue('')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    await flushPromises()
    expect(patchPayloads[0]).toMatchObject({
      selected_context: null,
      model: '',
      prompt_tokens: 12,
    })

    // auth_users: invalid JSONB roles shows localized error; clearing nullable email vs NOT NULL display_name
    await wrapper.get('[data-db-table-tab="auth_users"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-db-edit-row="0"]').trigger('click')
    await wrapper.get('[data-db-field="roles"]').setValue('{bad json')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    expect(wrapper.get('[data-db-error]').text()).toContain('roles')

    await wrapper.get('[data-db-field="roles"]').setValue('["reader","author"]')
    await wrapper.get('[data-db-field="email"]').setValue('')
    await wrapper.get('[data-db-field="display_name"]').setValue('')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    await flushPromises()
    expect(patchPayloads[1]).toMatchObject({
      email: null,
      display_name: '',
      roles: ['reader', 'author'],
    })
    expect(patchPayloads[1]).not.toHaveProperty('password')

    // Inserting auth_users requires password (min 8 chars) and sends password in create payload
    await wrapper.get('[data-db-add-row]').trigger('click')
    await wrapper.get('[data-db-field="username"]').setValue('bob')
    await wrapper.get('[data-db-field="roles"]').setValue('["reader"]')
    await wrapper.get('[data-db-field="password"]').setValue('short')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    expect(wrapper.get('[data-db-error]').text()).toBe(dashboardZhCN['dsh.login.errPasswordShort'])
    expect(postPayloads).toHaveLength(0)

    await wrapper.get('[data-db-field="password"]').setValue('NewUserPass123!')
    await wrapper.get('[data-db-row-editor] form').trigger('submit')
    await flushPromises()
    expect(postPayloads[0]).toMatchObject({
      username: 'bob',
      password: 'NewUserPass123!',
      roles: ['reader'],
    })

    wrapper.unmount()
  })

  it('discards stale out-of-order fetchDbTableRows response after selectTable switches table', async () => {
    let resolveDelayedAuthUsers: ((res: Response) => void) | null = null
    const delayedAuthUsers = new Promise<Response>((resolve) => {
      resolveDelayedAuthUsers = resolve
    })

    const twoTablesFixture = [
      {
        name: 'auth_users',
        pkColumns: ['id'],
        columns: ['id', 'username', 'roles', 'created_at'],
        readOnlyColumns: ['id', 'created_at'],
        editableColumns: ['username', 'roles'],
        searchableColumns: ['username'],
        defaultSort: 'created_at',
        rowCount: 1,
      },
      {
        name: 'progress',
        pkColumns: ['user_id', 'lecture_id'],
        columns: ['user_id', 'lecture_id', 'status', 'updated_at'],
        readOnlyColumns: ['updated_at'],
        editableColumns: ['status'],
        searchableColumns: ['user_id', 'lecture_id'],
        defaultSort: 'updated_at',
        rowCount: 1,
      },
    ]

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString()
        if (url === '/api/admin/db/config') {
          return jsonRes({
            ok: true,
            kind: 'pglite',
            databaseUrl: 'pglite:./data/pglite',
            databaseUrlDirect: null,
            pgliteDir: './data/pglite',
            envFilePath: 'server/.env',
            envWritable: true,
            migrations: { applied: 3, pending: 0, total: 3 },
            tableCounts: { auth_users: 1, progress: 1 },
          })
        }
        if (url === '/api/admin/db/tables') {
          return jsonRes({ ok: true, tables: twoTablesFixture })
        }
        if (url.startsWith('/api/admin/db/tables/auth_users/rows')) {
          return delayedAuthUsers
        }
        if (url.startsWith('/api/admin/db/tables/progress/rows')) {
          return jsonRes({
            ok: true,
            table: 'progress',
            rows: [
              {
                user_id: 'prog-user',
                lecture_id: 'mea/L01',
                status: 'completed',
                updated_at: '2026-11-25T10:00:00Z',
              },
            ],
            total: 1,
            limit: 25,
            offset: 0,
            sort: 'updated_at',
            order: 'desc',
          })
        }
        return jsonRes({ ok: false, error: 'unexpected_url' }, 404)
      }),
    )

    const wrapper = mount(PageDatabase)
    await flushPromises()

    // Initial load started auth_users (still pending); user switches to progress immediately
    await wrapper.get('[data-db-table-tab="progress"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('prog-user')
    expect((wrapper.get('[data-db-sort-col]').element as HTMLSelectElement).value).toBe('updated_at')

    // Now the older slow auth_users response finally arrives — it must be ignored
    resolveDelayedAuthUsers!(
      jsonRes({
        ok: true,
        table: 'auth_users',
        rows: [
          {
            id: 'u-stale',
            username: 'stale-alice',
            roles: ['admin'],
            created_at: '2026-11-24T10:00:00Z',
          },
        ],
        total: 9,
        limit: 25,
        offset: 0,
        sort: 'created_at',
        order: 'asc',
      }),
    )
    await flushPromises()

    expect(wrapper.text()).toContain('prog-user')
    expect(wrapper.text()).not.toContain('stale-alice')
    expect((wrapper.get('[data-db-sort-col]').element as HTMLSelectElement).value).toBe('updated_at')
    expect((wrapper.get('[data-db-sort-order]').element as HTMLSelectElement).value).toBe('desc')

    wrapper.unmount()
  })

  it('refreshes current database status and warns when live switch request fails or times out', async () => {
    let configCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url === '/api/admin/db/config' && method === 'GET') {
          configCalls += 1
          return jsonRes({
            ok: true,
            kind: configCalls >= 2 ? 'pg' : 'pglite',
            databaseUrl: configCalls >= 2 ? 'postgres://user:***@db.example/prod' : 'pglite:./data/pglite',
            databaseUrlDirect: null,
            pgliteDir: './data/pglite',
            envFilePath: 'server/.env',
            envWritable: true,
            migrations: { applied: 4, pending: 0, total: 4 },
            tableCounts: { progress: configCalls >= 2 ? 12 : 3 },
          })
        }
        if (url === '/api/admin/db/tables' && method === 'GET') {
          return jsonRes({ ok: true, tables: [] })
        }
        if (url === '/api/admin/db/switch' && method === 'POST') {
          return jsonRes({ ok: false, error: 'timeout', message: 'Request timed out' }, 504)
        }
        return jsonRes({ ok: false, error: 'unexpected_url' }, 404)
      }),
    )

    const wrapper = mount(PageDatabase)
    await flushPromises()
    expect(wrapper.text()).toContain('pglite')

    await wrapper.get('[data-db-preset-neon]').trigger('click')
    await wrapper.get('[data-db-target-url]').setValue('postgres://user:pass@db.example/prod')
    await wrapper.get('[data-db-switch-btn]').trigger('click')
    await wrapper.get('[data-db-confirm-switch]').trigger('click')
    await flushPromises()

    expect(configCalls).toBe(2)
    expect(wrapper.text()).toContain('postgres://user:***@db.example/prod')
    expect(wrapper.find('[data-db-error]').exists()).toBe(true)
    expect(wrapper.get('[data-db-error]').text()).toContain('Request timed out')

    // Definite 4xx/502 server rejections report the mapped server error without claiming uncertain outcome
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url === '/api/admin/db/config' && method === 'GET') {
          configCalls += 1
          return jsonRes({
            ok: true,
            kind: 'pg',
            databaseUrl: 'postgres://user:***@db.example/prod',
            databaseUrlDirect: null,
            pgliteDir: './data/pglite',
            envFilePath: 'server/.env',
            envWritable: true,
            migrations: { applied: 4, pending: 0, total: 4 },
            tableCounts: { progress: 12 },
          })
        }
        if (url === '/api/admin/db/tables' && method === 'GET') {
          return jsonRes({ ok: true, tables: [] })
        }
        if (url === '/api/admin/db/switch' && method === 'POST') {
          return jsonRes(
            { ok: false, error: 'target_not_migrated', message: 'Target database missing migrations' },
            409,
          )
        }
        return jsonRes({ ok: false, error: 'unexpected_url' }, 404)
      }),
    )

    await wrapper.get('[data-db-switch-btn]').trigger('click')
    await wrapper.get('[data-db-confirm-switch]').trigger('click')
    await flushPromises()

    expect(configCalls).toBe(2)
    expect(wrapper.get('[data-db-error]').text()).toContain('Target database missing migrations')
    expect(wrapper.get('[data-db-error]').text()).not.toContain('重新刷新当前数据库状态')
    expect(wrapper.get('[data-db-error]').text()).not.toContain('refreshed current engine status')

    // 2xx with invalid JSON / truncated body is also ambiguous -> refresh current database status
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        if (url === '/api/admin/db/config' && method === 'GET') {
          configCalls += 1
          return jsonRes({
            ok: true,
            kind: 'pglite',
            databaseUrl: 'pglite:./data/pglite',
            databaseUrlDirect: null,
            pgliteDir: './data/pglite',
            envFilePath: 'server/.env',
            envWritable: true,
            migrations: { applied: 4, pending: 0, total: 4 },
            tableCounts: { progress: 12 },
          })
        }
        if (url === '/api/admin/db/tables' && method === 'GET') {
          return jsonRes({ ok: true, tables: [] })
        }
        if (url === '/api/admin/db/switch' && method === 'POST') {
          return new Response('<html>truncated proxy reply', { status: 200 })
        }
        return jsonRes({ ok: false, error: 'unexpected_url' }, 404)
      }),
    )

    await wrapper.get('[data-db-switch-btn]').trigger('click')
    await wrapper.get('[data-db-confirm-switch]').trigger('click')
    await flushPromises()

    expect(configCalls).toBe(3)
    expect(wrapper.get('[data-db-error]').text()).toContain('HTTP 200')

    wrapper.unmount()
  })
})
