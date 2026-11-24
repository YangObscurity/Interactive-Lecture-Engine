import { type Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import {
  defaultAuthRegistry,
  type AuthProviderRegistry,
} from '../auth/providers/registry.js'
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '../auth/providers/passkey.js'
import {
  createSessionRow,
  isSecureConnection,
  revokeSessionById,
  serializeClearSessionCookie,
  serializeSessionCookie,
} from '../auth/sessions.js'
import {
  dummyVerifyPassword,
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../auth/password.js'
import type { AppConfig, Role } from '../config/schema.js'
import type { Db } from '../db/types.js'
import { randomUUID } from 'node:crypto'

export function computeVisibleSections(roles: readonly Role[]): string[] {
  if (roles.includes('admin')) {
    return [
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
    ]
  }
  if (roles.includes('author')) {
    return [
      'my-learning',
      'account',
      'overview',
      'checks',
      'figures',
      'texts',
      'companion',
    ]
  }
  return ['my-learning', 'account']
}

function getRequestContext(c: Context<AppEnv>) {
  return {
    host: c.req.header('host'),
    url: c.req.url,
    headers: (name: string) => c.req.header(name),
  }
}

export function createAuthRouter(
  config: AppConfig,
  db: Db,
  registry: AuthProviderRegistry = defaultAuthRegistry,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // 1. GET /status — extended session status
  router.get('/status', async (c) => {
    c.header('Cache-Control', 'no-store')
    const session = c.get('session')
    const auth = c.get('auth')

    const userCountRes = await db.query<{ count: string | number }>(
      'SELECT COUNT(*)::int AS count FROM auth_users',
    )
    const totalUsers = Number(userCountRes.rows[0]?.count ?? 0)
    const needsBootstrap = totalUsers === 0

    const roles = session?.roles ?? ['reader']
    const visibleSections = computeVisibleSections(roles)

    return c.json(
      {
        authAdapter: config.authAdapter,
        authenticated: session?.authenticated ?? false,
        needsBootstrap,
        authSource: auth?.authSource ?? 'none',
        authMethod: auth?.authMethod ?? 'anonymous',
        rememberMe: auth?.rememberMe ?? false,
        user: session?.user ?? null,
        roles,
        groups: session?.groups ?? [],
        canAccessAdmin: auth?.canAccessAdmin ?? false,
        canAccessAuthor: auth?.canAccessAuthor ?? false,
        visibleSections,
      },
      200,
    )
  })

  // 2. GET /methods — registered and extensible auth methods
  router.get('/methods', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ ok: true, methods: registry.list(config) }, 200)
  })

  // 3. POST /bootstrap — first-time admin registration
  router.post('/bootstrap', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!registry.get('password')?.isEnabled(config)) {
      return c.json(
        { error: 'auth_method_disabled', message: 'Password bootstrap is disabled for current auth configuration' },
        403,
      )
    }

    let body: {
      username?: unknown
      password?: unknown
      displayName?: unknown
      email?: unknown
      rememberMe?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid payload' }, 400)
    }

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    if (!username || username.length < 3 || username.length > 64) {
      return c.json(
        { error: 'invalid_username', message: 'Username must be between 3 and 64 characters' },
        400,
      )
    }

    const password = typeof body.password === 'string' ? body.password : ''
    try {
      validatePasswordStrength(password)
    } catch (err) {
      return c.json(
        { error: 'invalid_password', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }

    const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim() : username
    const rememberMe = Boolean(body.rememberMe)

    const passwordHash = await hashPassword(password)
    let createdUserId: string | null = null
    let rawToken: string | null = null

    try {
      await db.tx(async (txClient) => {
        if (db.kind === 'pg') {
          await txClient.query('SELECT pg_advisory_xact_lock(4928173)')
        }
        const countRes = await txClient.query<{ count: string | number }>(
          'SELECT COUNT(*)::int AS count FROM auth_users',
        )
        const count = Number(countRes.rows[0]?.count ?? 0)
        if (count > 0) {
          throw new Error('already_initialized')
        }

        createdUserId = randomUUID()

        await txClient.query(
          `INSERT INTO auth_users (id, username, email, display_name, password_hash, roles, disabled, last_login_at)
           VALUES ($1, $2, $3, $4, $5, '["reader", "author", "admin"]'::jsonb, FALSE, NOW())`,
          [createdUserId, username, email, displayName, passwordHash],
        )

        const sess = await createSessionRow(txClient, {
          userId: createdUserId,
          authMethod: 'password',
          rememberMe,
          userAgent: c.req.header('user-agent'),
          ipAddress: c.req.header('x-forwarded-for') || '',
          sessionTtlHours: config.sessionTtlHours,
          rememberMeDays: config.rememberMeDays,
        })
        rawToken = sess.rawToken
      })
    } catch (err) {
      if (err instanceof Error && err.message === 'already_initialized') {
        return c.json(
          { error: 'already_bootstrapped', message: 'System has already been bootstrapped' },
          409,
        )
      }
      return c.json({ error: 'bootstrap_failed', message: 'Failed to bootstrap admin' }, 500)
    }

    if (rawToken) {
      const secure = isSecureConnection(config.authCookieSecure, c.req.url, (n) => c.req.header(n))
      const cookie = serializeSessionCookie(config.authCookieName, rawToken, {
        rememberMe,
        rememberMeDays: config.rememberMeDays,
        secure,
      })
      c.header('Set-Cookie', cookie)
    }

    return c.json(
      {
        ok: true,
        authenticated: true,
        user: {
          id: createdUserId,
          username,
          name: displayName,
          email,
        },
        roles: ['reader', 'author', 'admin'] as Role[],
        groups: [],
        canAccessAdmin: true,
        canAccessAuthor: true,
      },
      201,
    )
  })

  // 4. POST /login — local username & password login
  router.post('/login', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!registry.get('password')?.isEnabled(config)) {
      return c.json(
        { error: 'auth_method_disabled', message: 'Password login is disabled for current auth configuration' },
        403,
      )
    }

    let body: { username?: unknown; password?: unknown; rememberMe?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const rememberMe = Boolean(body.rememberMe)

    if (!username || !password || password.length > 256) {
      await dummyVerifyPassword()
      return c.json(
        { error: 'invalid_credentials', message: 'Username and password are required' },
        401,
      )
    }

    const userRes = await db.query<{
      id: string
      username: string
      email: string | null
      display_name: string
      password_hash: string
      roles: Role[] | string
      disabled: boolean
    }>(
      `SELECT id, username, email, display_name, password_hash, roles, disabled
       FROM auth_users
       WHERE username = $1 OR email = $1
       ORDER BY (username = $1) DESC
       LIMIT 1`,
      [username],
    )

    if (userRes.rowCount === 0 || !userRes.rows[0]) {
      await dummyVerifyPassword()
      return c.json(
        { error: 'invalid_credentials', message: 'Invalid username or password' },
        401,
      )
    }

    const user = userRes.rows[0]
    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) {
      return c.json(
        { error: 'invalid_credentials', message: 'Invalid username or password' },
        401,
      )
    }

    if (user.disabled) {
      return c.json({ error: 'account_disabled', message: 'Account has been disabled' }, 403)
    }

    await db.query(`UPDATE auth_users SET last_login_at = NOW() WHERE id = $1`, [user.id])

    const sess = await createSessionRow(db, {
      userId: user.id,
      authMethod: 'password',
      rememberMe,
      userAgent: c.req.header('user-agent'),
      ipAddress: c.req.header('x-forwarded-for') || '',
      sessionTtlHours: config.sessionTtlHours,
      rememberMeDays: config.rememberMeDays,
    })

    const secure = isSecureConnection(config.authCookieSecure, c.req.url, (n) => c.req.header(n))
    const cookie = serializeSessionCookie(config.authCookieName, sess.rawToken, {
      rememberMe,
      rememberMeDays: config.rememberMeDays,
      secure,
    })
    c.header('Set-Cookie', cookie)

    let roles: Role[]
    if (Array.isArray(user.roles)) {
      roles = user.roles as Role[]
    } else if (typeof user.roles === 'string') {
      try {
        roles = JSON.parse(user.roles) as Role[]
      } catch {
        roles = ['reader']
      }
    } else {
      roles = ['reader']
    }
    if (!roles.includes('reader')) {
      roles = ['reader', ...roles]
    }

    const canAccessAdmin = roles.includes('admin')
    const canAccessAuthor = canAccessAdmin || roles.includes('author')

    return c.json(
      {
        ok: true,
        authenticated: true,
        user: {
          id: user.id,
          username: user.username,
          name: user.display_name || user.username,
          email: user.email,
        },
        roles,
        groups: [],
        canAccessAdmin,
        canAccessAuthor,
      },
      200,
    )
  })

  // 5. POST /logout — revoke session & clear cookie
  router.post('/logout', async (c) => {
    c.header('Cache-Control', 'no-store')
    const sessionId = c.get('sessionId')
    if (sessionId) {
      await revokeSessionById(db, sessionId)
    }

    const secure = isSecureConnection(config.authCookieSecure, c.req.url, (n) => c.req.header(n))
    const clearCookie = serializeClearSessionCookie(config.authCookieName, secure)
    c.header('Set-Cookie', clearCookie)

    return c.json(
      {
        ok: true,
        logoutUrl: config.logoutUrl ?? null,
      },
      200,
    )
  })

  // 6. Passkey endpoints
  // Register start
  const handlePasskeyRegisterStart = async (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'no-store')
    if (!registry.get('passkey')?.isEnabled(config)) {
      return c.json({ error: 'auth_method_disabled', message: 'Passkey method is disabled' }, 403)
    }
    const effectiveUserId = c.get('effectiveUserId')
    const authSource = c.get('authSource')
    if (!effectiveUserId || effectiveUserId === 'anonymous' || authSource === 'none') {
      return c.json({ error: 'unauthenticated' }, 401)
    }

    const userRes = await db.query<{ id: string; username: string; display_name: string }>(
      'SELECT id, username, display_name FROM auth_users WHERE id = $1',
      [effectiveUserId],
    )
    if (userRes.rowCount === 0 || !userRes.rows[0]) {
      return c.json(
        {
          error: 'gateway_managed_account',
          message: 'Passkey registration requires a persistent local user record',
        },
        400,
      )
    }
    const u = userRes.rows[0]

    const reqCtx = getRequestContext(c)
    try {
      const options = await createRegistrationOptions(db, config, reqCtx, {
        id: u.id,
        username: u.username,
        displayName: u.display_name || u.username,
      })
      return c.json(options, 200)
    } catch (err) {
      return c.json(
        { error: 'passkey_error', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }
  }

  router.post('/methods/passkey/register/start', handlePasskeyRegisterStart)
  router.post('/methods/passkey/register/options', handlePasskeyRegisterStart)

  // Register finish
  const handlePasskeyRegisterFinish = async (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'no-store')
    if (!registry.get('passkey')?.isEnabled(config)) {
      return c.json({ error: 'auth_method_disabled', message: 'Passkey method is disabled' }, 403)
    }
    const effectiveUserId = c.get('effectiveUserId')
    const authSource = c.get('authSource')
    if (!effectiveUserId || effectiveUserId === 'anonymous' || authSource === 'none') {
      return c.json({ error: 'unauthenticated' }, 401)
    }

    const userRes = await db.query<{ id: string; username: string }>(
      'SELECT id, username FROM auth_users WHERE id = $1',
      [effectiveUserId],
    )
    if (userRes.rowCount === 0 || !userRes.rows[0]) {
      return c.json(
        {
          error: 'gateway_managed_account',
          message: 'Passkey registration requires a persistent local user record',
        },
        400,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    const reqCtx = getRequestContext(c)
    try {
      const result = await verifyRegistrationResponse(
        db,
        config,
        reqCtx,
        { id: effectiveUserId, username: userRes.rows[0].username },
        body as Parameters<typeof verifyRegistrationResponse>[4],
      )
      return c.json(result, 201)
    } catch (err) {
      return c.json(
        { error: 'passkey_verification_failed', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }
  }

  router.post('/methods/passkey/register/finish', handlePasskeyRegisterFinish)
  router.post('/methods/passkey/register/verify', handlePasskeyRegisterFinish)

  // Login start
  const handlePasskeyLoginStart = async (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'no-store')
    if (!registry.get('passkey')?.isEnabled(config)) {
      return c.json({ error: 'auth_method_disabled', message: 'Passkey login is disabled' }, 403)
    }
    let body: { username?: unknown } = {}
    try {
      const parsed: unknown = await c.req.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as { username?: unknown }
      }
    } catch {
      // optional body
    }

    const username = typeof body.username === 'string' ? body.username : undefined
    const reqCtx = getRequestContext(c)
    try {
      const options = await createAuthenticationOptions(db, config, reqCtx, username)
      return c.json(options, 200)
    } catch (err) {
      return c.json(
        { error: 'passkey_error', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }
  }

  router.post('/methods/passkey/login/start', handlePasskeyLoginStart)
  router.post('/methods/passkey/auth/options', handlePasskeyLoginStart)

  // Login finish
  const handlePasskeyLoginFinish = async (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'no-store')
    if (!registry.get('passkey')?.isEnabled(config)) {
      return c.json({ error: 'auth_method_disabled', message: 'Passkey login is disabled' }, 403)
    }
    let body: {
      id?: string
      rawId?: string
      response?: {
        clientDataJSON: string
        authenticatorData: string
        signature: string
      }
      rememberMe?: boolean
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body?.response?.clientDataJSON || !body?.response?.authenticatorData || !body?.response?.signature) {
      return c.json({ error: 'invalid_request', message: 'Missing passkey authentication response' }, 400)
    }

    const reqCtx = getRequestContext(c)
    let authUser: { id: string; username: string; email: string | null; displayName: string; roles: Role[] }
    try {
      const result = await verifyAuthenticationResponse(
        db,
        config,
        reqCtx,
        body as Parameters<typeof verifyAuthenticationResponse>[3],
      )
      authUser = result.user
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'credential_not_found') {
        return c.json({ error: 'invalid_credentials', message: 'Passkey not recognized' }, 401)
      }
      if (msg === 'account_disabled') {
        return c.json({ error: 'account_disabled', message: 'Account is disabled' }, 403)
      }
      if (msg === 'sign_count_regression' || msg === 'sign_count_anti_replay') {
        return c.json({ error: 'sign_count_regression', message: 'Potential replay attack detected' }, 400)
      }
      return c.json({ error: 'passkey_auth_failed', message: msg }, 401)
    }

    const rememberMe = Boolean(body.rememberMe)
    const sess = await createSessionRow(db, {
      userId: authUser.id,
      authMethod: 'passkey',
      rememberMe,
      userAgent: c.req.header('user-agent'),
      ipAddress: c.req.header('x-forwarded-for') || '',
      sessionTtlHours: config.sessionTtlHours,
      rememberMeDays: config.rememberMeDays,
    })

    const secure = isSecureConnection(config.authCookieSecure, c.req.url, (n) => c.req.header(n))
    const cookie = serializeSessionCookie(config.authCookieName, sess.rawToken, {
      rememberMe,
      rememberMeDays: config.rememberMeDays,
      secure,
    })
    c.header('Set-Cookie', cookie)

    const canAccessAdmin = authUser.roles.includes('admin')
    const canAccessAuthor = canAccessAdmin || authUser.roles.includes('author')

    return c.json(
      {
        ok: true,
        authenticated: true,
        user: {
          id: authUser.id,
          username: authUser.username,
          name: authUser.displayName || authUser.username,
          email: authUser.email,
        },
        roles: authUser.roles,
        groups: [],
        canAccessAdmin,
        canAccessAuthor,
      },
      200,
    )
  }

  router.post('/methods/passkey/login/finish', handlePasskeyLoginFinish)
  router.post('/methods/passkey/auth/verify', handlePasskeyLoginFinish)

  return router
}
