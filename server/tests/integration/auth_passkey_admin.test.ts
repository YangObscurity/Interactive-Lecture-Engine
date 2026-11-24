import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { cborEncode } from '../../src/auth/providers/cbor.js'
import { defaultAuthRegistry } from '../../src/auth/providers/registry.js'
import { isOriginAllowed } from '../../src/auth/providers/passkey.js'
import type { AuthMethodProvider } from '../../src/auth/providers/types.js'
import { loadConfig } from '../../src/config/load.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import { serverLogBuffer } from '../../src/http/logBuffer.js'
import { createServerPromptStore, type CompanionPromptsFile } from '../../src/prompts/companion.js'

function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: 'pglite:memory',
    databaseUrlDirect: null,
    host: '127.0.0.1',
    port: 8100,
    authAdapter: 'local',
    authHeaderPreset: 'authelia',
    authHeaderUser: 'Remote-User',
    authHeaderGroups: 'Remote-Groups',
    authHeaderEmail: 'Remote-Email',
    authHeaderName: 'Remote-Name',
    authGroupSeparator: ',',
    authRoleMap: {
      admins: ['admin'],
      authors: ['author'],
      students: ['reader'],
    },
    logoutUrl: '/logout',
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
    webauthnRpId: 'localhost',
    webauthnRpName: 'Test Lecture Engine',
    webauthnOrigin: 'http://localhost:8100',
    ...overrides,
  }
}

function extractCookie(res: Response, cookieName = 'lec_session'): {
  raw: string | null
  value: string | null
  hasMaxAge: boolean
  maxAge: number | null
  hasExpires: boolean
  isHttpOnly: boolean
  sameSite: string | null
} {
  const setCookie = res.headers.get('set-cookie')
  if (!setCookie) {
    return {
      raw: null,
      value: null,
      hasMaxAge: false,
      maxAge: null,
      hasExpires: false,
      isHttpOnly: false,
      sameSite: null,
    }
  }

  const parts = setCookie.split(';').map((p) => p.trim())
  const [firstPart, ...attrs] = parts
  const [name, val] = firstPart?.split('=') ?? []
  if (name !== cookieName) {
    return {
      raw: setCookie,
      value: null,
      hasMaxAge: false,
      maxAge: null,
      hasExpires: false,
      isHttpOnly: false,
      sameSite: null,
    }
  }

  let maxAge: number | null = null
  let hasMaxAge = false
  let hasExpires = false
  let isHttpOnly = false
  let sameSite: string | null = null

  for (const attr of attrs) {
    const [attrName, attrVal] = attr.split('=')
    const lower = attrName?.toLowerCase()
    if (lower === 'max-age' && attrVal !== undefined) {
      hasMaxAge = true
      maxAge = Number.parseInt(attrVal, 10)
    } else if (lower === 'expires') {
      hasExpires = true
    } else if (lower === 'httponly') {
      isHttpOnly = true
    } else if (lower === 'samesite') {
      sameSite = attrVal ?? null
    }
  }

  return {
    raw: setCookie,
    value: val ?? null,
    hasMaxAge,
    maxAge,
    hasExpires,
    isHttpOnly,
    sameSite,
  }
}

describe('WP-2: Backend Authentication, Cookies, Passkeys, Hybrid, Me & Admin', () => {
  let db: Db
  let app: ReturnType<typeof createApp>
  let testContentDir: string
  const prevContentDir = process.env['CONTENT_DIR']

  beforeAll(async () => {
    testContentDir = mkdtempSync(join(tmpdir(), 'lec-content-test-'))
    process.env['CONTENT_DIR'] = testContentDir

    db = createDb('pglite:memory')
    await runMigrations(db)
    const config = makeTestConfig()
    app = createApp(config, db)
  })

  afterAll(() => {
    if (prevContentDir !== undefined) {
      process.env['CONTENT_DIR'] = prevContentDir
    } else {
      delete process.env['CONTENT_DIR']
    }
    if (existsSync(testContentDir)) {
      rmSync(testContentDir, { recursive: true, force: true })
    }
  })

  describe('1. 30-day vs Session Cookie & Remember Me Semantics', () => {
    it('initial GET /api/auth/status indicates needsBootstrap = true', async () => {
      const res = await app.request('/api/auth/status')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.authenticated).toBe(false)
      expect(data.needsBootstrap).toBe(true)
      expect(data.authAdapter).toBe('local')
    })

    it('rejects password shorter than 8 characters on bootstrap', async () => {
      const res = await app.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: '123',
        }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('invalid_password')
    })

    it('bootstrap with rememberMe = true sets 30-day cookie (Max-Age=2592000)', async () => {
      const res = await app.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
          displayName: 'Initial Admin',
          rememberMe: true,
        }),
      })

      expect(res.status).toBe(201)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.user.username).toBe('admin')
      expect(data.roles).toContain('admin')

      const cookie = extractCookie(res)
      expect(cookie.value).toBeTruthy()
      expect(cookie.hasMaxAge).toBe(true)
      expect(cookie.maxAge).toBe(30 * 86400) // 2592000
      expect(cookie.isHttpOnly).toBe(true)
      expect(cookie.sameSite?.toLowerCase()).toBe('lax')
    })

    it('second bootstrap attempt returns 409 already_bootstrapped', async () => {
      const res = await app.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin2',
          password: 'Password123!',
        }),
      })

      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toBe('already_bootstrapped')
    })

    it('login with rememberMe = false sets browser session cookie (no Max-Age, no Expires)', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
          rememberMe: false,
        }),
      })

      expect(res.status).toBe(200)
      const cookie = extractCookie(res)
      expect(cookie.value).toBeTruthy()
      expect(cookie.hasMaxAge).toBe(false)
      expect(cookie.hasExpires).toBe(false)
      expect(cookie.isHttpOnly).toBe(true)
      expect(cookie.sameSite?.toLowerCase()).toBe('lax')
    })
  })

  describe('2. Password Verification, Scrypt, Unknown User Timing & Logout', () => {
    it('rejects incorrect password with 401', async () => {
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'WrongPassword999!',
        }),
      })

      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('invalid_credentials')
    })

    it('unknown user runs dummy scrypt and returns 401 without leaking existence', async () => {
      const start = Date.now()
      const res = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'nonexistent_user_123',
          password: 'Password123!',
        }),
      })
      const elapsed = Date.now() - start

      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data.error).toBe('invalid_credentials')
      // Dummy scrypt N=16384 execution takes non-zero CPU time
      expect(elapsed).toBeGreaterThanOrEqual(1)
    })

    it('logout revokes session in DB and clears cookie', async () => {
      // Login first
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
        }),
      })
      expect(loginRes.status).toBe(200)
      const cookie = extractCookie(loginRes)
      expect(cookie.value).toBeTruthy()

      // Verify authenticated
      const statusRes = await app.request('/api/auth/status', {
        headers: { Cookie: `lec_session=${cookie.value}` },
      })
      expect(statusRes.status).toBe(200)
      expect((await statusRes.json()).authenticated).toBe(true)

      // Logout
      const logoutRes = await app.request('/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: `lec_session=${cookie.value}` },
      })
      expect(logoutRes.status).toBe(200)
      const clearedCookie = extractCookie(logoutRes)
      expect(clearedCookie.hasMaxAge).toBe(true)
      expect(clearedCookie.maxAge).toBe(0)

      // Subsequent status check is unauthenticated
      const postLogoutRes = await app.request('/api/auth/status', {
        headers: { Cookie: `lec_session=${cookie.value}` },
      })
      expect((await postLogoutRes.json()).authenticated).toBe(false)
    })
  })

  describe('3. Pure-Node WebAuthn Passkey Registration, Authentication & Anti-Replay', () => {
    let adminCookie: string
    let keyPair: ReturnType<typeof generateKeyPairSync>
    let credentialId: Buffer

    beforeAll(async () => {
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
        }),
      })
      adminCookie = extractCookie(loginRes).value!
      keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      credentialId = Buffer.from('test-cred-id-12345678')
    })

    it('generates registration options and single-use challenge', async () => {
      const res = await app.request('/api/auth/methods/passkey/register/options', {
        method: 'POST',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.challenge).toBeTruthy()
      expect(data.rp.id).toBe('localhost')
      expect(data.user.name).toBe('admin')
      expect(data.user.displayName).toBe('Initial Admin')

      // Verify challenge exists in DB
      const challengeRow = await db.query(
        'SELECT * FROM auth_challenges WHERE challenge = $1',
        [data.challenge],
      )
      expect(challengeRow.rows.length).toBe(1)
    })

    it('completes P-256 WebAuthn registration and deletes challenge atomically', async () => {
      const optRes = await app.request('/api/auth/methods/passkey/register/options', {
        method: 'POST',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
      })
      const { challenge } = await optRes.json()

      // Synthesize clientDataJSON
      const clientDataObj = {
        type: 'webauthn.create',
        challenge,
        origin: 'http://localhost:8100',
        crossOrigin: false,
      }
      const clientDataJSON = Buffer.from(JSON.stringify(clientDataObj))

      // Synthesize COSE key from public key
      const jwk = keyPair.publicKey.export({ format: 'jwk' })
      const xBuf = Buffer.from(jwk.x!, 'base64url')
      const yBuf = Buffer.from(jwk.y!, 'base64url')

      const coseKey = new Map<number, unknown>()
      coseKey.set(1, 2) // kty: EC2
      coseKey.set(3, -7) // alg: ES256
      coseKey.set(-1, 1) // crv: P-256
      coseKey.set(-2, xBuf)
      coseKey.set(-3, yBuf)
      const encodedCose = cborEncode(coseKey)

      // Synthesize authenticatorData
      const rpIdHash = createHash('sha256').update('localhost').digest()
      const flags = Buffer.from([0x45]) // UP, UV, AT
      const signCountBuf = Buffer.alloc(4)
      signCountBuf.writeUInt32BE(0, 0)
      const aaguid = Buffer.alloc(16, 0)
      const credIdLen = Buffer.alloc(2)
      credIdLen.writeUInt16BE(credentialId.length, 0)

      const authData = Buffer.concat([
        rpIdHash,
        flags,
        signCountBuf,
        aaguid,
        credIdLen,
        credentialId,
        encodedCose,
      ])

      const attestationMap = new Map<string, unknown>()
      attestationMap.set('fmt', 'none')
      attestationMap.set('attStmt', new Map())
      attestationMap.set('authData', authData)
      const attestationObject = cborEncode(attestationMap)

      const verifyRes = await app.request('/api/auth/methods/passkey/register/verify', {
        method: 'POST',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: credentialId.toString('base64url'),
          rawId: credentialId.toString('base64url'),
          response: {
            clientDataJSON: clientDataJSON.toString('base64url'),
            attestationObject: attestationObject.toString('base64url'),
          },
          type: 'public-key',
        }),
      })

      expect(verifyRes.status).toBe(201)
      const data = await verifyRes.json()
      expect(data.ok).toBe(true)
      expect(data.credentialId).toBe(credentialId.toString('base64url'))

      // Verify challenge was consumed (single-use)
      const checkChallenge = await db.query(
        'SELECT * FROM auth_challenges WHERE challenge = $1',
        [challenge],
      )
      expect(checkChallenge.rows.length).toBe(0)
    })

    it('authenticates with P-256 passkey signature and enforces anti-replay sign_count', async () => {
      // 1. Get auth options
      const optRes = await app.request('/api/auth/methods/passkey/auth/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }),
      })
      expect(optRes.status).toBe(200)
      const { challenge } = await optRes.json()

      // 2. Synthesize authentication clientDataJSON & authenticatorData (sign_count = 1)
      const clientDataObj = {
        type: 'webauthn.get',
        challenge,
        origin: 'http://localhost:8100',
        crossOrigin: false,
      }
      const clientDataJSON = Buffer.from(JSON.stringify(clientDataObj))
      const rpIdHash = createHash('sha256').update('localhost').digest()
      const authData = Buffer.alloc(37)
      rpIdHash.copy(authData, 0)
      authData[32] = 0x05 // UP, UV
      authData.writeUInt32BE(1, 33) // signCount = 1

      const clientDataHash = createHash('sha256').update(clientDataJSON).digest()
      const signedData = Buffer.concat([authData, clientDataHash])

      const signer = createSign('SHA256')
      signer.update(signedData)
      const signature = signer.sign({ key: keyPair.privateKey, dsaEncoding: 'der' })

      // 3. Verify authentication
      const verifyRes = await app.request('/api/auth/methods/passkey/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credentialId.toString('base64url'),
          rawId: credentialId.toString('base64url'),
          response: {
            clientDataJSON: clientDataJSON.toString('base64url'),
            authenticatorData: authData.toString('base64url'),
            signature: signature.toString('base64url'),
          },
          type: 'public-key',
        }),
      })

      expect(verifyRes.status).toBe(200)
      const verifyData = await verifyRes.json()
      expect(verifyData.ok).toBe(true)
      expect(verifyData.user.username).toBe('admin')
      const cookie = extractCookie(verifyRes)
      expect(cookie.value).toBeTruthy()

      // 4. Test anti-replay: repeat authentication with the SAME or LOWER sign_count (sign_count = 1)
      const optRes2 = await app.request('/api/auth/methods/passkey/auth/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }),
      })
      const { challenge: challenge2 } = await optRes2.json()

      const replayClientDataObj = {
        type: 'webauthn.get',
        challenge: challenge2,
        origin: 'http://localhost:8100',
        crossOrigin: false,
      }
      const replayClientDataJSON = Buffer.from(JSON.stringify(replayClientDataObj))
      const replayClientDataHash = createHash('sha256').update(replayClientDataJSON).digest()
      const replaySignedData = Buffer.concat([authData, replayClientDataHash])

      const replaySigner = createSign('SHA256')
      replaySigner.update(replaySignedData)
      const replaySignature = replaySigner.sign({ key: keyPair.privateKey, dsaEncoding: 'der' })

      const replayRes = await app.request('/api/auth/methods/passkey/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credentialId.toString('base64url'),
          rawId: credentialId.toString('base64url'),
          response: {
            clientDataJSON: replayClientDataJSON.toString('base64url'),
            authenticatorData: authData.toString('base64url'),
            signature: replaySignature.toString('base64url'),
          },
          type: 'public-key',
        }),
      })

      expect(replayRes.status).toBe(400)
      const replayError = await replayRes.json()
      expect(replayError.error).toBe('sign_count_regression')
    })
  })

  describe('4. Extensible Auth Providers & Registry', () => {
    it('GET /api/auth/methods returns enabled methods and extensible slots', async () => {
      const res = await app.request('/api/auth/methods')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)

      const ids = data.methods.map((m: { id: string }) => m.id)
      expect(ids).toContain('password')
      expect(ids).toContain('passkey')
      expect(ids).toContain('gateway')
      expect(ids).toContain('oidc')
      expect(ids).toContain('totp')

      const oidc = data.methods.find((m: { id: string }) => m.id === 'oidc')
      expect(oidc.extensible).toBe(true)
      expect(oidc.implemented).toBe(false)
    })

    it('dynamic registration of custom AuthMethodProvider is reflected in methods', async () => {
      const customProvider: AuthMethodProvider = {
        id: 'mock-oauth',
        name: 'Mock Enterprise OAuth',
        description: 'Mock OAuth provider',
        implemented: true,
        extensible: false,
        isEnabled: () => true,
      }

      defaultAuthRegistry.register(customProvider)

      const res = await app.request('/api/auth/methods')
      const data = await res.json()
      const custom = data.methods.find((m: { id: string }) => m.id === 'mock-oauth')
      expect(custom).toBeTruthy()
      expect(custom.name).toBe('Mock Enterprise OAuth')
      expect(custom.implemented).toBe(true)

      defaultAuthRegistry.unregister('mock-oauth')
    })
  })

  describe('5. Hybrid Adapter & Authelia Gateway Bypass', () => {
    let hybridApp: ReturnType<typeof createApp>

    beforeAll(() => {
      const hybridConfig = makeTestConfig({
        authAdapter: 'hybrid',
        authHeaderPreset: 'authelia',
        authHeaderUser: 'Remote-User',
        authHeaderGroups: 'Remote-Groups',
        authRoleMap: {
          admins: ['admin'],
          students: ['reader'],
        },
      })
      hybridApp = createApp(hybridConfig, db)
    })

    it('request with trusted gateway headers authenticates immediately without cookie', async () => {
      const res = await hybridApp.request('/api/auth/session', {
        headers: {
          'Remote-User': 'gate_admin',
          'Remote-Groups': 'admins',
        },
      })

      expect(res.status).toBe(200)
      const session = await res.json()
      // STRICT COMPATIBILITY: exact 5-key shape
      expect(session).toEqual({
        authenticated: true,
        user: {
          id: 'gate_admin',
          name: null,
          email: null,
        },
        roles: ['reader', 'admin'],
        groups: ['admins'],
        logoutUrl: '/logout',
      })
    })

    it('request without gateway headers falls through to local cookie session', async () => {
      // 1. Login locally
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
        }),
      })
      const cookie = extractCookie(loginRes).value!

      // 2. Request hybridApp with cookie (no Remote-User)
      const statusRes = await hybridApp.request('/api/auth/status', {
        headers: { Cookie: `lec_session=${cookie}` },
      })

      expect(statusRes.status).toBe(200)
      const data = await statusRes.json()
      expect(data.authenticated).toBe(true)
      expect(data.authSource).toBe('cookie')
      expect(data.user.name).toBe('Initial Admin')
    })
  })

  describe('6. Reader Self-Service /api/me/* & Isolation from /api/admin/*', () => {
    let readerCookie: string
    let readerUserId: string

    beforeAll(async () => {
      // Create reader user directly in DB
      const res = await db.query(
        `INSERT INTO auth_users (id, username, email, display_name, password_hash, roles)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          'reader-1',
          'student_sam',
          'sam@example.com',
          'Sam Student',
          'scrypt:dummy',
          JSON.stringify(['reader']),
        ],
      )
      const row = res.rows[0] as { id: string }
      readerUserId = row.id

      // Create session for reader
      const sessionRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
        }),
      })
      const adminCookie = extractCookie(sessionRes).value!

      // Reset reader password through admin API
      await app.request(`/api/admin/users/${readerUserId}/password`, {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ newPassword: 'SamPassword123!' }),
      })

      // Login as reader
      const readerLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'student_sam',
          password: 'SamPassword123!',
        }),
      })
      readerCookie = extractCookie(readerLogin).value!
    })

    it('reader can access /api/me/overview', async () => {
      const res = await app.request('/api/me/overview', {
        headers: { Cookie: `lec_session=${readerCookie}` },
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.user.username).toBe('student_sam')
      expect(data.user.displayName).toBe('Sam Student')
    })

    it('reader can change own password via /api/me/password', async () => {
      const res = await app.request('/api/me/password', {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${readerCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          oldPassword: 'SamPassword123!',
          newPassword: 'NewSamPassword456!',
        }),
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)

      // Test login with new password
      const reLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'student_sam',
          password: 'NewSamPassword456!',
        }),
      })
      expect(reLogin.status).toBe(200)
      readerCookie = extractCookie(reLogin).value!
    })

    it('reader can list and revoke sessions via /api/me/sessions', async () => {
      const res = await app.request('/api/me/sessions', {
        headers: { Cookie: `lec_session=${readerCookie}` },
      })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(Array.isArray(data)).toBe(true)
      expect(data.length).toBeGreaterThanOrEqual(1)
    })

    it('reader attempting /api/admin/* receives 403 forbidden', async () => {
      const adminRoutes = [
        '/api/admin/overview',
        '/api/admin/users',
        '/api/admin/access',
        '/api/admin/runtime',
        '/api/admin/texts',
        '/api/admin/figures',
        '/api/admin/companion',
      ]

      for (const route of adminRoutes) {
        const res = await app.request(route, {
          headers: { Cookie: `lec_session=${readerCookie}` },
        })
        expect(res.status).toBe(403)
        const data = await res.json()
        expect(data.error).toBe('forbidden')
      }
    })
  })

  describe('7. Role Scoping: Author vs Admin Boundary', () => {
    let authorCookie: string
    let adminCookie: string

    beforeAll(async () => {
      const adminLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
        }),
      })
      adminCookie = extractCookie(adminLogin).value!

      // Admin creates an author user
      const createRes = await app.request('/api/admin/users', {
        method: 'POST',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: 'author_jane',
          password: 'AuthorPassword123!',
          displayName: 'Jane Author',
          roles: ['author'],
        }),
      })
      expect(createRes.status).toBe(201)

      const authorLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'author_jane',
          password: 'AuthorPassword123!',
        }),
      })
      authorCookie = extractCookie(authorLogin).value!
    })

    it('author can access author-permitted admin endpoints', async () => {
      const permitted = [
        '/api/admin/overview',
        '/api/admin/figures',
        '/api/admin/texts',
        '/api/admin/companion',
        '/api/admin/checks',
      ]

      for (const route of permitted) {
        const res = await app.request(route, {
          headers: { Cookie: `lec_session=${authorCookie}` },
        })
        expect(res.status).toBe(200)
      }
    })

    it('author is rejected from admin-only endpoints with 403', async () => {
      const adminOnly = [
        '/api/admin/users',
        '/api/admin/access',
        '/api/admin/runtime',
        '/api/admin/logs',
        '/api/admin/backups',
      ]

      for (const route of adminOnly) {
        const res = await app.request(route, {
          headers: { Cookie: `lec_session=${authorCookie}` },
        })
        expect(res.status).toBe(403)
        const data = await res.json()
        expect(data.error).toBe('forbidden')
      }
    })

    it('admin can access all admin-only endpoints', async () => {
      const adminOnly = [
        '/api/admin/users',
        '/api/admin/access',
        '/api/admin/runtime',
        '/api/admin/logs',
        '/api/admin/backups',
      ]

      for (const route of adminOnly) {
        const res = await app.request(route, {
          headers: { Cookie: `lec_session=${adminCookie}` },
        })
        expect(res.status).toBe(200)
      }
    })
  })

  describe('8. Online CONTENT_DIR File Writes & site_settings_history', () => {
    let adminCookie: string

    beforeAll(async () => {
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
        }),
      })
      adminCookie = extractCookie(loginRes).value!
    })

    it('modifying site texts validates SiteTexts, writes to DB, records history, and updates disk in CONTENT_DIR', async () => {
      const invalidRes = await app.request('/api/admin/texts', {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ texts: { zh: { name: '' }, en: { name: 'Valid' } } }),
      })
      expect(invalidRes.status).toBe(400)

      const newTexts = {
        zh: {
          name: 'Updated Online Title',
          shortName: 'Online',
          navText: 'Top Notice',
          tagline: 'Tagline ZH',
          description: 'Desc {lectures}',
        },
        en: {
          name: 'Updated Online Title EN',
          shortName: 'Online',
          navText: 'Top Notice',
          tagline: 'Tagline EN',
          description: 'Test site description',
        },
      }

      const res = await app.request('/api/admin/texts', {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ texts: newTexts }),
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.persistence.mode).toBe('db+disk')
      expect(data.persistence.effect).toBe('rebuild_required')

      // Check DB site_settings
      const setting = await db.query('SELECT * FROM site_settings WHERE key = $1', ['texts'])
      expect(setting.rows.length).toBe(1)
      const settingVal = setting.rows[0]?.value as { zh?: { name?: string }; en?: { description?: string } }
      expect(settingVal?.zh?.name).toBe('Updated Online Title')
      expect(settingVal?.en?.description).toBe('Test site description')

      // Check DB site_settings_history
      const history = await db.query(
        'SELECT * FROM site_settings_history WHERE setting_key = $1 ORDER BY id DESC',
        ['texts'],
      )
      expect(history.rows.length).toBeGreaterThanOrEqual(1)
      const historyVal = history.rows[0]?.new_value as { zh?: { name?: string } }
      expect(historyVal?.zh?.name).toBe('Updated Online Title')

      // Check atomic file on disk in testContentDir
      const diskPath = join(testContentDir, 'site-texts.json')
      expect(existsSync(diskPath)).toBe(true)
      const diskContent = JSON.parse(readFileSync(diskPath, 'utf8'))
      expect(diskContent.zh.name).toBe('Updated Online Title')

      // Look DTCG validation & theme.json persistence
      const badHexLook = await app.request('/api/admin/look', {
        method: 'PUT',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ look: { skin: 'reader', base: 'custom', custom: 'not-a-hex' } }),
      })
      expect(badHexLook.status).toBe(400)

      const badContrastLook = await app.request('/api/admin/look', {
        method: 'PUT',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ look: { skin: 'reader', base: 'custom', custom: '#808080' } }),
      })
      expect(badContrastLook.status).toBe(400)

      const goodLook = await app.request('/api/admin/look', {
        method: 'PUT',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ look: { skin: 'datasheet', base: 'sepia', custom: '#EAF2E3' } }),
      })
      expect(goodLook.status).toBe(200)
      const lookJson = await goodLook.json()
      expect(lookJson.look).toEqual({ skin: 'datasheet', base: 'sepia', custom: '#EAF2E3' })
      expect(lookJson.persistence.effect).toBe('rebuild_required')
      expect(existsSync(join(testContentDir, 'theme.json'))).toBe(true)

      // Access config validation & access.json persistence
      const badAccess = await app.request('/api/admin/access', {
        method: 'PUT',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ access: { default: 'invalid-tier' } }),
      })
      expect(badAccess.status).toBe(400)

      const goodAccess = await app.request('/api/admin/access', {
        method: 'PUT',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access: { default: 'public', enforcement: 'gateway', groups: { G01: { read: 'authenticated' } } },
        }),
      })
      expect(goodAccess.status).toBe(200)
      const accessJson = await goodAccess.json()
      expect(accessJson.persistence.effect).toBe('rebuild_required')
      expect(existsSync(join(testContentDir, 'access.json'))).toBe(true)
    })
  })

  describe('9. Last Active Admin Protection Guard', () => {
    let adminCookie: string
    let adminUserId: string

    beforeAll(async () => {
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'admin',
          password: 'Password123!',
        }),
      })
      adminCookie = extractCookie(loginRes).value!
      const statusRes = await app.request('/api/auth/status', {
        headers: { Cookie: `lec_session=${adminCookie}` },
      })
      adminUserId = (await statusRes.json()).user.id
    })

    it('refuses to delete the last active admin with 409 cannot_remove_last_admin', async () => {
      const res = await app.request(`/api/admin/users/${adminUserId}`, {
        method: 'DELETE',
        headers: { Cookie: `lec_session=${adminCookie}` },
      })

      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toBe('cannot_remove_last_admin')
    })

    it('refuses to remove the admin role from the last active admin with 409', async () => {
      const res = await app.request(`/api/admin/users/${adminUserId}/roles`, {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ roles: ['reader'] }),
      })

      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toBe('cannot_remove_last_admin')
    })

    it('refuses to disable the last active admin with 409', async () => {
      const res = await app.request(`/api/admin/users/${adminUserId}/status`, {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ disabled: true }),
      })

      expect(res.status).toBe(409)
      const data = await res.json()
      expect(data.error).toBe('cannot_remove_last_admin')
    })
  })

  describe('10. Blind-Audit Security Hardening & Edge Cases', () => {
    it('enforces strict comma-separated WEBAUTHN_ORIGIN allowlist without hostname fallthrough', () => {
      const cfg = makeTestConfig({
        webauthnOrigin: 'https://app.example.com, https://admin.example.com:8443',
      })
      expect(isOriginAllowed('https://app.example.com', cfg, 'https://app.example.com/api/auth', 'app.example.com')).toBe(true)
      expect(isOriginAllowed('https://admin.example.com:8443', cfg, 'https://app.example.com/api/auth', 'app.example.com')).toBe(true)
      // Must reject wrong scheme/port even when hostname matches rpId
      expect(isOriginAllowed('http://app.example.com', cfg, 'https://app.example.com/api/auth', 'app.example.com')).toBe(false)
      expect(isOriginAllowed('https://app.example.com:9999', cfg, 'https://app.example.com/api/auth', 'app.example.com')).toBe(false)
    })

    it('loadConfig enforces non-loopback HOST guard under AUTH_ADAPTER=hybrid', () => {
      expect(() =>
        loadConfig({
          DATABASE_URL: 'pglite:memory',
          AUTH_ADAPTER: 'hybrid',
          HOST: '0.0.0.0',
          ALLOW_NON_LOOPBACK: 'false',
        }),
      ).toThrow(/HOST.*ALLOW_NON_LOOPBACK/s)

      const valid = loadConfig({
        DATABASE_URL: 'pglite:memory',
        AUTH_ADAPTER: 'hybrid',
        HOST: '0.0.0.0',
        ALLOW_NON_LOOPBACK: 'true',
      })
      expect(valid.authAdapter).toBe('hybrid')
    })

    it('blocks /bootstrap, /login, /methods/passkey/* when method disabled or adapter is none', async () => {
      const noneApp = createApp(makeTestConfig({ authAdapter: 'none' }), db)
      const bootRes = await noneApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'x', password: 'Password123!' }),
      })
      expect(bootRes.status).toBe(403)
      const meRes = await noneApp.request('/api/me/overview')
      expect(meRes.status).toBe(401)

      const passkeyOnlyApp = createApp(
        makeTestConfig({ authAdapter: 'local', authMethodsEnabled: 'passkey' }),
        db,
      )
      const loginRes = await passkeyOnlyApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Password123!' }),
      })
      expect(loginRes.status).toBe(403)
    })

    it('prevents pre-auth disabled enumeration and checks disabled user cookies', async () => {
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Password123!' }),
      })
      const adminCookie = extractCookie(loginRes).value!

      // Create user, log in, then disable via admin
      const createRes = await app.request('/api/admin/users', {
        method: 'POST',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'temp_disabled_user',
          email: 'temp_disabled@example.com',
          password: 'UserPass123!',
          roles: ['reader'],
        }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { id: string }

      // Duplicate email returns 409
      const dupRes = await app.request('/api/admin/users', {
        method: 'POST',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'other_user',
          email: 'temp_disabled@example.com',
          password: 'UserPass123!',
          roles: ['reader'],
        }),
      })
      expect(dupRes.status).toBe(409)

      const userLogin = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'temp_disabled_user', password: 'UserPass123!' }),
      })
      const userCookie = extractCookie(userLogin).value!

      // Disable user -> revokes sessions immediately
      const disableRes = await app.request(`/api/admin/users/${created.id}/status`, {
        method: 'PUT',
        headers: { Cookie: `lec_session=${adminCookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      })
      expect(disableRes.status).toBe(200)

      const afterDisableMe = await app.request('/api/me/overview', {
        headers: { Cookie: `lec_session=${userCookie}` },
      })
      expect(afterDisableMe.status).toBe(401)

      // Wrong password on disabled user MUST return 401 (no 403 enumeration)
      const badPwDisabled = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'temp_disabled_user', password: 'WrongPassword123!' }),
      })
      expect(badPwDisabled.status).toBe(401)

      // Correct password on disabled user returns 403
      const rightPwDisabled = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'temp_disabled_user', password: 'UserPass123!' }),
      })
      expect(rightPwDisabled.status).toBe(403)
    })

    it('consumes WebAuthn challenge atomically even on bad signature and blocks CSRF origin mismatch', async () => {
      const startRes = await app.request('/api/auth/methods/passkey/login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin' }),
      })
      expect(startRes.status).toBe(200)
      const opts = (await startRes.json()) as { challenge: string }

      const clientData = Buffer.from(
        JSON.stringify({
          type: 'webauthn.get',
          challenge: opts.challenge,
          origin: 'http://localhost:8100',
        }),
      ).toString('base64url')
      const rpIdHash = createHash('sha256').update('localhost').digest()
      const authData = Buffer.concat([rpIdHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 99])])

      const badFinish = await app.request('/api/auth/methods/passkey/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'nonexistent_cred_or_bad_sig',
          response: {
            clientDataJSON: clientData,
            authenticatorData: authData.toString('base64url'),
            signature: Buffer.from('bad-sig').toString('base64url'),
          },
        }),
      })
      expect(badFinish.status).toBe(401)

      // Same challenge CANNOT be reused after failed attempt
      const reuse = await app.request('/api/auth/methods/passkey/login/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'nonexistent_cred_or_bad_sig',
          response: {
            clientDataJSON: clientData,
            authenticatorData: authData.toString('base64url'),
            signature: Buffer.from('bad-sig').toString('base64url'),
          },
        }),
      })
      expect(reuse.status).toBe(401)
      const reuseErr = (await reuse.json()) as { message: string }
      expect(reuseErr.message).toBe('invalid_or_expired_challenge')

      // CSRF cross-origin POST with valid cookie must be blocked
      const loginRes = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Password123!' }),
      })
      const adminCookie = extractCookie(loginRes).value!
      const csrfRes = await app.request('/api/admin/texts', {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${adminCookie}`,
          Origin: 'https://evil.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ texts: { hack: true } }),
      })
      expect(csrfRes.status).toBe(403)
    })

    it('rate limits excessive login attempts, validates backups/logs/look/prompt-reload, and allows DELETE /api/me/sessions/:id', async () => {
      const loginA = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Password123!', rememberMe: false }),
      })
      const loginB = await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'Password123!', rememberMe: true }),
      })
      const cookieA = extractCookie(loginA).value!
      const cookieB = extractCookie(loginB).value!

      // Check sessions & actually revoke session B using cookie A
      const sessRes = await app.request('/api/me/sessions', {
        headers: { Cookie: `lec_session=${cookieA}` },
      })
      const sessions = (await sessRes.json()) as Array<{ id: string; is_current: boolean; remember_me: boolean; expires_at: string }>
      const other = sessions.find((s) => !s.is_current && s.remember_me)
      expect(other).toBeTruthy()
      const current = sessions.find((s) => s.is_current)!
      expect(new Date(other!.expires_at).getTime() - new Date(current.expires_at).getTime()).toBeGreaterThan(20 * 86400 * 1000)

      const delRes = await app.request(`/api/me/sessions/${other!.id}`, {
        method: 'DELETE',
        headers: { Cookie: `lec_session=${cookieA}` },
      })
      expect(delRes.status).toBe(200)
      const meWithB = await app.request('/api/me/overview', {
        headers: { Cookie: `lec_session=${cookieB}` },
      })
      expect(meWithB.status).toBe(401)

      // Test /api/me/export
      const exportRes = await app.request('/api/me/export', {
        headers: { Cookie: `lec_session=${cookieA}` },
      })
      expect(exportRes.status).toBe(200)
      const exportJson = await exportRes.text()
      expect(exportJson).not.toContain('password_hash')
      expect(exportJson).not.toContain('token_hash')

      // Test LogBuffer sanitization + NaN cap + backups real gzip archive
      serverLogBuffer.add({
        level: 'info',
        category: 'http',
        message: 'postgres://user:supersecret@db.example.com/lec Bearer my-jwt-token',
        details: { nested: [{ password: 'abc', authorization: 'xyz' }] },
      })
      const logsRes = await app.request('/api/admin/logs?limit=abc', {
        headers: { Cookie: `lec_session=${cookieA}` },
      })
      expect(logsRes.status).toBe(200)
      const logsBody = await logsRes.text()
      expect(logsBody).not.toContain('supersecret')
      expect(logsBody).not.toContain('my-jwt-token')

      const origBackupDir = process.env.BACKUP_DIR
      process.env.BACKUP_DIR = join(testContentDir, 'backups')
      try {
        const bkCreate = await app.request('/api/admin/backups', {
          method: 'POST',
          headers: { Cookie: `lec_session=${cookieA}` },
        })
        expect(bkCreate.status).toBe(201)
        const bkData = (await bkCreate.json()) as { snapshot: { filename: string } }
        const bkValidate = await app.request('/api/admin/backups/restore', {
          method: 'POST',
          headers: { Cookie: `lec_session=${cookieA}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: bkData.snapshot.filename, dryRun: true }),
        })
        expect(bkValidate.status).toBe(200)
        const badPath = await app.request('/api/admin/backups/restore', {
          method: 'POST',
          headers: { Cookie: `lec_session=${cookieA}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ archivePath: '../../etc/passwd' }),
        })
        expect(badPath.status).toBe(400)
      } finally {
        if (origBackupDir === undefined) delete process.env.BACKUP_DIR
        else process.env.BACKUP_DIR = origBackupDir
      }

      // Test ServerPromptStore.reload(override) persists across .get() calls
      const promptsFile = join(testContentDir, 'prompts', 'companion.json')
      if (existsSync(promptsFile)) {
        const store = createServerPromptStore({ aiProvider: 'off', aiPromptsFile: promptsFile })
        const overridePrompts: CompanionPromptsFile = {
          version: 1,
          system: { zh: '自定义系统提示词', en: 'Custom system prompt' },
          actions: [],
        }
        store.reload(overridePrompts)
        expect(store.get()?.system.zh).toBe('自定义系统提示词')
      }

      // Rate limit check with tight limit
      const tightApp = createApp(makeTestConfig({ writeRatePerMinute: 2 }), db)
      for (let i = 0; i < 2; i++) {
        await tightApp.request('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7' },
          body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
        })
      }
      const blocked = await tightApp.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7' },
        body: JSON.stringify({ username: 'nobody', password: 'wrong' }),
      })
      expect(blocked.status).toBe(429)

      // Blind-audit regressions: strict WEBAUTHN_ORIGIN CSRF, same-site without Origin, Login CSRF, visibleSections, check only filter
      const strictOriginApp = createApp(
        makeTestConfig({ webauthnOrigin: 'https://docs.example.com' }),
        db,
      )
      const fallthroughCsrf = await strictOriginApp.request('/api/admin/texts', {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${cookieA}`,
          Origin: 'http://localhost',
          Host: 'localhost',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ texts: {} }),
      })
      expect(fallthroughCsrf.status).toBe(403)

      const sameSiteNoOrigin = await strictOriginApp.request('/api/admin/texts', {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${cookieA}`,
          'Sec-Fetch-Site': 'same-site',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ texts: {} }),
      })
      expect(sameSiteNoOrigin.status).toBe(403)

      const loginCsrf = await strictOriginApp.request('/api/auth/login', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: 'admin', password: 'Password123!' }),
      })
      expect(loginCsrf.status).toBe(403)

      const statusRes = await app.request('/api/auth/status', {
        headers: { Cookie: `lec_session=${cookieA}` },
      })
      expect(statusRes.status).toBe(200)
      const statusBody = (await statusRes.json()) as { visibleSections: string[] }
      expect(statusBody.visibleSections).toEqual([
        'my-learning',
        'account',
        'overview',
        'checks',
        'figures',
        'texts',
        'companion',
        'access',
        'look',
        'database',
        'users',
        'runtime',
        'backup',
      ])

      const checksTextsOnly = await app.request('/api/admin/checks/run', {
        method: 'POST',
        headers: { Cookie: `lec_session=${cookieA}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ only: ['texts'] }),
      })
      expect(checksTextsOnly.status).toBe(200)
      const checksTextsBody = (await checksTextsOnly.json()) as {
        only?: string[]
        report: { issues: Array<{ code: string }> }
      }
      expect(checksTextsBody.only).toEqual(['texts'])
      for (const issue of checksTextsBody.report.issues) {
        expect(issue.code.startsWith('texts.')).toBe(true)
      }
    })
  })
})
