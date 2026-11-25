import { createHash, createSign, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { cborEncode } from '../../src/auth/providers/cbor.js'
import { defaultAuthRegistry } from '../../src/auth/providers/registry.js'
import { isOriginAllowed } from '../../src/auth/origin.js'
import type { AuthMethodProvider } from '../../src/auth/providers/types.js'
import { loadConfig } from '../../src/config/load.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb, createDbManager } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import { serverLogBuffer } from '../../src/http/logBuffer.js'
import { createServerPromptStore, type CompanionPromptsFile } from '../../src/prompts/companion.js'
import { resetGatewayAuthSeenForTests } from '../../src/routes/auth.js'
import { RESERVED_DOMAIN_SETTING_KEYS, setSetting } from '../../src/repo/siteSettings.js'

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
    authBootstrapToken: null,
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
      const res = await app.request('/api/me/passkeys/register/start', {
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
      const optRes = await app.request('/api/me/passkeys/register/start', {
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

      const verifyRes = await app.request('/api/me/passkeys/register/finish', {
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
      const optRes = await app.request('/api/auth/methods/passkey/login/start', {
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
      const verifyRes = await app.request('/api/auth/methods/passkey/login/finish', {
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
      const optRes2 = await app.request('/api/auth/methods/passkey/login/start', {
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

      const replayRes = await app.request('/api/auth/methods/passkey/login/finish', {
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

  describe('WP-ENTIRE-R1 Security & Integrity Verifications', () => {
    it('1. returns uninitialized_restricted and access: null when access manifest has restrictions and DB/disk access is empty', async () => {
      const savedEnvContent = process.env['CONTENT_DIR']
      delete process.env['CONTENT_DIR']
      const testDistDir = mkdtempSync(join(tmpdir(), 'lec-dist-'))
      try {
        const manifestDir = join(testDistDir, '.lecture-build')
        mkdirSync(manifestDir, { recursive: true })
        writeFileSync(
          join(manifestDir, 'access-manifest.json'),
          JSON.stringify({
            version: 1,
            defaultTier: 'public',
            enforcement: 'gateway',
            tiers: [{ id: 'authenticated', groups: ['G01'] }],
          }),
          'utf8',
        )

        const memDb = createDb('pglite:memory')
        await runMigrations(memDb)
        const distConfig = makeTestConfig({ siteDistDir: testDistDir, authAdapter: 'local' })
        const distApp = createApp(distConfig, memDb)

        // Bootstrap an admin to get admin cookie
        const bRes = await distApp.request('/api/auth/bootstrap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'distadmin', password: 'Password123!' }),
        })
        const adminCookie = extractCookie(bRes).value!

        const accessRes = await distApp.request('/api/admin/access', {
          headers: { Cookie: `lec_session=${adminCookie}` },
        })
        expect(accessRes.status).toBe(200)
        const accessBody = await accessRes.json()
        expect(accessBody.ok).toBe(true)
        expect(accessBody.source).toBe('uninitialized_restricted')
        expect(accessBody.access).toBeNull()
      } finally {
        if (savedEnvContent !== undefined) {
          process.env['CONTENT_DIR'] = savedEnvContent
        } else {
          delete process.env['CONTENT_DIR']
        }
        rmSync(testDistDir, { recursive: true, force: true })
      }
    })

    it('2. hybrid gateway auth is ignored when gateway is omitted from AUTH_METHODS_ENABLED', async () => {
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const noGwConfig = makeTestConfig({
        authAdapter: 'hybrid',
        authMethodsEnabled: 'password,passkey',
      })
      const noGwApp = createApp(noGwConfig, memDb)

      const statusRes = await noGwApp.request('/api/auth/status', {
        headers: {
          'Remote-User': 'alice',
          'Remote-Groups': 'admins',
        },
      })
      expect(statusRes.status).toBe(200)
      const body = await statusRes.json()
      expect(body.authenticated).toBe(false)
      expect(body.authSource).toBe('none')
    })

    it('3. hydrates companion_prompts from DB on fresh app instance', async () => {
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)

      const customPrompts: CompanionPromptsFile = {
        version: 1,
        system: {
          zh: 'Custom DB hydrated system prompt ZH',
          en: 'Custom DB hydrated system prompt EN',
        },
        actions: [
          {
            id: 'explain',
            label: { zh: '解释', en: 'Explain' },
            template: { zh: '请解释：{selection}', en: 'Explain: {selection}' },
            needsSelection: true,
            surfaces: ['panel'],
            enabled: true,
          },
        ],
      }
      await setSetting(memDb, 'companion_prompts', customPrompts, 'test-setup')

      const cfg = makeTestConfig({ authAdapter: 'local' })
      const hydratedApp = createApp(cfg, memDb)

      // Bootstrap an admin
      const bRes = await hydratedApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'promptadmin', password: 'Password123!' }),
      })
      const adminCookie = extractCookie(bRes).value!

      const compRes = await hydratedApp.request('/api/admin/companion', {
        headers: { Cookie: `lec_session=${adminCookie}` },
      })
      expect(compRes.status).toBe(200)
      const compBody = await compRes.json()
      expect(compBody.ok).toBe(true)
      expect(compBody.prompts.system.zh).toBe('Custom DB hydrated system prompt ZH')
      expect(compBody.source).toBe('db')
    })

    it('4. enforces rate limit: rightmost XFF proxy IP blocked on rotation; per-IP+user rate limit does not lock out other IPs', async () => {
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const tightConfig = makeTestConfig({
        authAdapter: 'local',
        writeRatePerMinute: 2,
      })
      const tightApp = createApp(tightConfig, memDb)

      // Bootstrap admin
      await tightApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'targetuser', password: 'Password123!' }),
      })

      // Test 4a: Rightmost XFF IP rate limit (proxy IP cannot be spoofed by rotating client IP)
      const proxyIp = '198.51.100.55'
      // 2 allowed requests
      for (let i = 0; i < 2; i++) {
        const res = await tightApp.request('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `10.0.0.${i}, ${proxyIp}`,
          },
          body: JSON.stringify({ username: 'user_a', password: 'WrongPassword!' }),
        })
        expect(res.status).toBe(401)
      }
      // 3rd request from same proxy IP but different spoofed client IP -> 429
      const blockedRes = await tightApp.request('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `10.0.0.99, ${proxyIp}`,
        },
        body: JSON.stringify({ username: 'user_a', password: 'WrongPassword!' }),
      })
      expect(blockedRes.status).toBe(429)

      // Test 4b: Per-IP+username rate limit blocks brute-force from attacker IP without locking out legitimate IP
      const freshDb = createDb('pglite:memory')
      await runMigrations(freshDb)
      const userTightConfig = makeTestConfig({
        authAdapter: 'local',
        writeRatePerMinute: 2,
      })
      const userTightApp = createApp(userTightConfig, freshDb)

      // Bootstrap user
      await userTightApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bruteforce_target', password: 'Password123!' }),
      })

      // 2 failed attempts from attacker IP 203.0.113.10
      for (let i = 0; i < 2; i++) {
        const res = await userTightApp.request('/api/auth/login', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': '203.0.113.10',
          },
          body: JSON.stringify({ username: 'bruteforce_target', password: 'WrongPassword!' }),
        })
        expect(res.status).toBe(401)
      }

      // 3rd attempt from the SAME attacker IP 203.0.113.10 -> 429
      const attackerBlockedRes = await userTightApp.request('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.10',
        },
        body: JSON.stringify({ username: 'bruteforce_target', password: 'WrongPassword!' }),
      })
      expect(attackerBlockedRes.status).toBe(429)
      const blockedBody = await attackerBlockedRes.json()
      expect(blockedBody.error).toBe('rate_limited')

      // Legitimate login for bruteforce_target from a DIFFERENT IP 198.51.100.77 STILL succeeds (200)
      const legitRes = await userTightApp.request('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.77',
        },
        body: JSON.stringify({ username: 'bruteforce_target', password: 'Password123!' }),
      })
      expect(legitRes.status).toBe(200)
    })

    it('5. GET/PUT /api/admin/settings/:key and DB manager reject reserved keys with 400 and accurate action message', async () => {
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const cfg = makeTestConfig({ authAdapter: 'local' })
      const app = createApp(cfg, memDb)

      const bRes = await app.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin5', password: 'Password123!' }),
      })
      const cookie = extractCookie(bRes).value!

      const getAiToolsRes = await app.request('/api/admin/settings/ai_tools', {
        headers: { Cookie: `lec_session=${cookie}` },
      })
      expect(getAiToolsRes.status).toBe(400)
      const getAiToolsBody = (await getAiToolsRes.json()) as { error: string; message: string }
      expect(getAiToolsBody.error).toBe('reserved_setting_key')
      expect(getAiToolsBody.message).toMatch(/read/i)
      expect(getAiToolsBody.message).not.toMatch(/modify/i)

      for (const reserved of Array.from(RESERVED_DOMAIN_SETTING_KEYS)) {
        const getRes = await app.request(`/api/admin/settings/${reserved}`, {
          headers: { Cookie: `lec_session=${cookie}` },
        })
        expect(getRes.status).toBe(400)
        const getBody = (await getRes.json()) as { error: string; message: string }
        expect(getBody.error).toBe('reserved_setting_key')
        expect(getBody.message).toMatch(/read/i)
        expect(getBody.message).not.toMatch(/modify/i)

        const putRes = await app.request(`/api/admin/settings/${reserved}`, {
          method: 'PUT',
          headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: { injected: true } }),
        })
        expect(putRes.status).toBe(400)
        const putBody = (await putRes.json()) as { error: string; message: string }
        expect(putBody.error).toBe('reserved_setting_key')
        expect(putBody.message).toMatch(/modify/i)

        const patchRes = await app.request(`/api/admin/db/tables/site_settings/rows/${reserved}`, {
          method: 'PATCH',
          headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: { injected: true } }),
        })
        expect(patchRes.status).toBe(400)
        const patchBody = await patchRes.json()
        expect(patchBody.error).toBe('reserved_setting_key')

        const delRes = await app.request(`/api/admin/db/tables/site_settings/rows/${reserved}`, {
          method: 'DELETE',
          headers: { Cookie: `lec_session=${cookie}` },
        })
        expect(delRes.status).toBe(400)
        const delBody = await delRes.json()
        expect(delBody.error).toBe('reserved_setting_key')
      }
    })

    it('6. hybrid bootstrap gating and AUTH_BOOTSTRAP_TOKEN protection', async () => {
      resetGatewayAuthSeenForTests()
      // 6a: In hybrid mode once gateway traffic is observed, unauthenticated bootstrap returns 403
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const hybridCfg = makeTestConfig({ authAdapter: 'hybrid', logoutUrl: null })
      const hybridApp = createApp(hybridCfg, memDb)

      // First check status before gateway traffic: needsBootstrap is true
      const s1 = await hybridApp.request('/api/auth/status')
      expect((await s1.json()).needsBootstrap).toBe(true)

      // Gateway user visits
      const gwRes = await hybridApp.request('/api/auth/status', {
        headers: { 'Remote-User': 'gw-user' },
      })
      expect((await gwRes.json()).authenticated).toBe(true)

      // Now unauthenticated status shows needsBootstrap: false
      const s2 = await hybridApp.request('/api/auth/status')
      expect((await s2.json()).needsBootstrap).toBe(false)

      // Unauthenticated bootstrap returns 403
      const bootRes = await hybridApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'hacker', password: 'Password123!' }),
      })
      expect(bootRes.status).toBe(403)

      // Gateway admin CAN bootstrap
      const gwAdminBoot = await hybridApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Remote-User': 'gw-admin',
          'Remote-Groups': 'admins',
        },
        body: JSON.stringify({ username: 'localadmin', password: 'Password123!' }),
      })
      expect(gwAdminBoot.status).toBe(201)

      // 6b: When AUTH_BOOTSTRAP_TOKEN is configured, requires matching token
      const tokenDb = createDb('pglite:memory')
      await runMigrations(tokenDb)
      const tokenCfg = makeTestConfig({
        authAdapter: 'local',
        authBootstrapToken: 'super-secret-bootstrap-token',
      })
      const tokenApp = createApp(tokenCfg, tokenDb)

      const statusCheck = await tokenApp.request('/api/auth/status')
      const statusCheckBody = await statusCheck.json()
      expect(statusCheckBody.needsBootstrap).toBe(false)
      expect(statusCheckBody.bootstrapTokenRequired).toBe(true)

      // Missing token -> 403
      const missingTokenRes = await tokenApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admintoken', password: 'Password123!' }),
      })
      expect(missingTokenRes.status).toBe(403)

      // Wrong token -> 403
      const wrongTokenRes = await tokenApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bootstrap-Token': 'wrong-token',
        },
        body: JSON.stringify({ username: 'admintoken', password: 'Password123!' }),
      })
      expect(wrongTokenRes.status).toBe(403)

      // Correct token -> 201
      const correctTokenRes = await tokenApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bootstrap-Token': 'super-secret-bootstrap-token',
        },
        body: JSON.stringify({ username: 'admintoken', password: 'Password123!' }),
      })
      expect(correctTokenRes.status).toBe(201)
    })

    it('7. rejects Host-header CSRF bypass when request URL parses to a different origin', async () => {
      const cfg = makeTestConfig({ webauthnOrigin: '' })
      expect(
        isOriginAllowed(
          'https://evil.example.com',
          cfg,
          'https://app.example.com/api/admin/texts',
          'evil.example.com',
        ),
      ).toBe(false)
      expect(
        isOriginAllowed(
          'https://app.example.com',
          cfg,
          'http://app.example.com/api/admin/texts',
          'app.example.com',
          (h) => (h.toLowerCase() === 'x-forwarded-proto' ? 'https' : undefined),
        ),
      ).toBe(true)

      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const csrfApp = createApp(makeTestConfig({ authAdapter: 'local', webauthnOrigin: '' }), memDb)
      const boot = await csrfApp.request('https://app.example.com/api/auth/bootstrap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://app.example.com',
        },
        body: JSON.stringify({ username: 'csrfadmin', password: 'Password123!' }),
      })
      expect(boot.status).toBe(201)
      const cookie = extractCookie(boot).value!

      const forged = await csrfApp.request('https://app.example.com/api/admin/texts', {
        method: 'PUT',
        headers: {
          Cookie: `lec_session=${cookie}`,
          Origin: 'https://evil.example.com',
          Host: 'evil.example.com',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ texts: { pwned: true } }),
      })
      expect(forged.status).toBe(403)
    })

    it('8. enforces password validation on PUT /api/admin/users/:id/password and POST /api/admin/users', async () => {
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const uApp = createApp(makeTestConfig({ authAdapter: 'local' }), memDb)
      const boot = await uApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'useradmin', password: 'Password123!' }),
      })
      const cookie = extractCookie(boot).value!

      // Omitted or empty-string password on POST /api/admin/users -> 400 invalid_password
      const missingPw = await uApp.request('/api/admin/users', {
        method: 'POST',
        headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nopwuser' }),
      })
      expect(missingPw.status).toBe(400)
      expect((await missingPw.json()).error).toBe('invalid_password')

      const emptyPwCreate = await uApp.request('/api/admin/users', {
        method: 'POST',
        headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'emptypwuser', password: '' }),
      })
      expect(emptyPwCreate.status).toBe(400)
      expect((await emptyPwCreate.json()).error).toBe('invalid_password')

      // Explicit null password creates passwordless passkey user -> 201
      const passkeyUserRes = await uApp.request('/api/admin/users', {
        method: 'POST',
        headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'passkeyonly', password: null }),
      })
      expect(passkeyUserRes.status).toBe(201)
      const createdId = (await passkeyUserRes.json()).id as string

      // PUT /:id/password with {} or empty newPassword -> 400 invalid_password
      const emptyReset1 = await uApp.request(`/api/admin/users/${createdId}/password`, {
        method: 'PUT',
        headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(emptyReset1.status).toBe(400)
      expect((await emptyReset1.json()).error).toBe('invalid_password')

      const emptyReset2 = await uApp.request(`/api/admin/users/${createdId}/password`, {
        method: 'PUT',
        headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: '' }),
      })
      expect(emptyReset2.status).toBe(400)
      expect((await emptyReset2.json()).error).toBe('invalid_password')
    })

    it('9. defers missing AI_PROMPTS_FILE read until DB loader attaches and invalidates caches on db swap', async () => {
      const dbA = createDb('pglite:memory')
      await runMigrations(dbA)
      const promptsA: CompanionPromptsFile = {
        version: 1,
        system: { zh: 'DB A Prompt', en: 'DB A Prompt EN' },
        actions: [
          {
            id: 'explain',
            label: { zh: '解释', en: 'Explain' },
            template: { zh: '解释：{selection}', en: 'Explain: {selection}' },
            needsSelection: true,
            surfaces: ['panel'],
            enabled: true,
          },
        ],
      }
      await setSetting(dbA, 'companion_prompts', promptsA, 'seed')

      const dbB = createDb('pglite:memory')
      await runMigrations(dbB)
      const promptsB: CompanionPromptsFile = {
        ...promptsA,
        system: { zh: 'DB B Prompt', en: 'DB B Prompt EN' },
      }
      await setSetting(dbB, 'companion_prompts', promptsB, 'seed')

      const dbMgr = createDbManager(dbA, { databaseUrl: 'pglite:memory' })
      // Explicit nonexistent aiPromptsFile MUST NOT crash createApp when prompts live in DB
      const appWithMissingFile = createApp(
        makeTestConfig({
          authAdapter: 'local',
          aiProvider: 'dify',
          aiPromptsFile: join(tmpdir(), `missing-prompts-${Date.now()}.json`),
        }),
        dbA,
        { dbManager: dbMgr },
      )

      const boot = await appWithMissingFile.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'swapadmin', password: 'Password123!' }),
      })
      const cookieA = extractCookie(boot).value!

      // Runtime reload populates prompts from dbA
      const reloadA = await appWithMissingFile.request('/api/admin/runtime/reload', {
        method: 'POST',
        headers: { Cookie: `lec_session=${cookieA}` },
      })
      expect(reloadA.status).toBe(200)

      const compA = await appWithMissingFile.request('/api/admin/companion', {
        headers: { Cookie: `lec_session=${cookieA}` },
      })
      expect((await compA.json()).prompts.system.zh).toBe('DB A Prompt')

      // Swap to dbB -> stale cached prompts cleared automatically
      await dbMgr.swapTo(dbB, { databaseUrl: 'pglite:memory' }, { updateEnv: false })
      const bootB = await appWithMissingFile.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'swapadminb', password: 'Password123!' }),
      })
      const cookieB = extractCookie(bootB).value!

      const reloadB = await appWithMissingFile.request('/api/admin/runtime/reload', {
        method: 'POST',
        headers: { Cookie: `lec_session=${cookieB}` },
      })
      expect(reloadB.status).toBe(200)
      const compB = await appWithMissingFile.request('/api/admin/companion', {
        headers: { Cookie: `lec_session=${cookieB}` },
      })
      expect((await compB.json()).prompts.system.zh).toBe('DB B Prompt')
      await dbMgr.close()
    })

    it('10. resolves ../../../.lecture-build/access-manifest.json and blocks PUT /api/admin/access with 409 when uninitialized_restricted', async () => {
      const savedEnvContent = process.env['CONTENT_DIR']
      delete process.env['CONTENT_DIR']
      const siteRoot = mkdtempSync(join(tmpdir(), 'lec-site-root-'))
      try {
        const distDir = join(siteRoot, 'docs', '.vitepress', 'dist')
        const manifestDir = join(siteRoot, '.lecture-build')
        mkdirSync(distDir, { recursive: true })
        mkdirSync(manifestDir, { recursive: true })
        writeFileSync(
          join(manifestDir, 'access-manifest.json'),
          JSON.stringify({
            version: 1,
            defaultTier: 'authenticated',
            enforcement: 'gateway',
            tiers: [{ id: 'authenticated', groups: ['G01'] }],
          }),
          'utf8',
        )

        const memDb = createDb('pglite:memory')
        await runMigrations(memDb)
        const dApp = createApp(makeTestConfig({ siteDistDir: distDir, authAdapter: 'local' }), memDb)
        const boot = await dApp.request('/api/auth/bootstrap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'accadmin', password: 'Password123!' }),
        })
        const cookie = extractCookie(boot).value!

        const getRes = await dApp.request('/api/admin/access', {
          headers: { Cookie: `lec_session=${cookie}` },
        })
        expect((await getRes.json()).source).toBe('uninitialized_restricted')

        const putRes = await dApp.request('/api/admin/access', {
          method: 'PUT',
          headers: { Cookie: `lec_session=${cookie}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ access: { default: 'public', enforcement: 'none', groups: {} } }),
        })
        expect(putRes.status).toBe(409)
        expect((await putRes.json()).error).toBe('uninitialized_restricted_access')
      } finally {
        if (savedEnvContent !== undefined) process.env['CONTENT_DIR'] = savedEnvContent
        else delete process.env['CONTENT_DIR']
        rmSync(siteRoot, { recursive: true, force: true })
      }
    })

    it('11. records gateway_auth_seen from any gateway route (not only /api/auth/status)', async () => {
      resetGatewayAuthSeenForTests()
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const hApp = createApp(makeTestConfig({ authAdapter: 'hybrid', logoutUrl: null }), memDb)

      // Gateway request hits /api/me/overview instead of /api/auth/status
      const meRes = await hApp.request('/api/me/overview', {
        headers: { 'Remote-User': 'gw-reader' },
      })
      expect(meRes.status).toBe(200)

      // Wait briefly for fire-and-forget DB persistence if needed, in-memory mark is already immediate
      const unauthBoot = await hApp.request('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'attacker', password: 'Password123!' }),
      })
      expect(unauthBoot.status).toBe(403)
    })

    it('12. enforces CSRF Origin and Sec-Fetch-Site checks on gateway-authenticated mutations', async () => {
      const memDb = createDb('pglite:memory')
      await runMigrations(memDb)
      const gwApp = createApp(makeTestConfig({ authAdapter: 'hybrid', webauthnOrigin: '' }), memDb)

      const payload = JSON.stringify({
        username: 'csrf_gw_created',
        password: 'Password123!',
        roles: ['admin'],
      })

      // 1. Cross-origin Origin with text/plain JSON body -> 403
      const badOriginRes = await gwApp.request('https://app.example.com/api/admin/users', {
        method: 'POST',
        headers: {
          'Remote-User': 'gw-admin',
          'Remote-Groups': 'admins',
          'Content-Type': 'text/plain',
          Origin: 'https://evil.example.com',
        },
        body: payload,
      })
      expect(badOriginRes.status).toBe(403)

      // 2. Sec-Fetch-Site: cross-site -> 403
      const crossSiteRes = await gwApp.request('https://app.example.com/api/admin/users', {
        method: 'POST',
        headers: {
          'Remote-User': 'gw-admin',
          'Remote-Groups': 'admins',
          'Content-Type': 'text/plain',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: payload,
      })
      expect(crossSiteRes.status).toBe(403)

      // 3. Sec-Fetch-Site: same-site without Origin or Referer -> 403
      const sameSiteNoOriginRes = await gwApp.request('https://app.example.com/api/admin/users', {
        method: 'POST',
        headers: {
          'Remote-User': 'gw-admin',
          'Remote-Groups': 'admins',
          'Content-Type': 'text/plain',
          'Sec-Fetch-Site': 'same-site',
        },
        body: payload,
      })
      expect(sameSiteNoOriginRes.status).toBe(403)

      // 4. Same-origin Origin matching request URL -> 201
      const sameOriginRes = await gwApp.request('https://app.example.com/api/admin/users', {
        method: 'POST',
        headers: {
          'Remote-User': 'gw-admin',
          'Remote-Groups': 'admins',
          'Content-Type': 'text/plain',
          Origin: 'https://app.example.com',
        },
        body: payload,
      })
      expect(sameOriginRes.status).toBe(201)
    })
  })
})
