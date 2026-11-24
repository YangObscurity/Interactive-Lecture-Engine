import { type Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import {
  createRegistrationOptions,
  verifyRegistrationResponse,
} from '../auth/providers/passkey.js'
import { defaultAuthRegistry } from '../auth/providers/registry.js'
import {
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from '../auth/password.js'
import {
  isSecureConnection,
  revokeOtherSessions,
  revokeSessionById,
  serializeClearSessionCookie,
} from '../auth/sessions.js'
import type { AppConfig, Role } from '../config/schema.js'
import type { Db } from '../db/types.js'

function getRequestUserId(c: Context<AppEnv>): string | null {
  const userId = c.get('userId') ?? c.get('effectiveUserId') ?? c.get('user')?.id
  if (typeof userId === 'string' && userId.trim() !== '') {
    return userId.trim()
  }
  return null
}

function getRequestContext(c: Context<AppEnv>) {
  return {
    host: c.req.header('host'),
    url: c.req.url,
    headers: (name: string) => c.req.header(name),
  }
}

export function createMeRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // Guard: require authenticated user (never anonymous / authAdapter=none)
  router.use('*', async (c, next) => {
    const userId = getRequestUserId(c)
    const authSource = c.get('authSource')
    if (!userId || userId === 'anonymous' || authSource === 'none') {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    await next()
  })

  // 1. GET /overview
  router.get('/overview', async (c) => {
    c.header('Cache-Control', 'no-store')
    const userId = getRequestUserId(c)!

    // Progress stats
    const progRes = await db.query<{
      total: number
      completed: number
      in_progress: number
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = '已完成')::int AS completed,
         COUNT(*) FILTER (WHERE status = '学习中')::int AS in_progress
       FROM progress
       WHERE user_id = $1`,
      [userId],
    )

    // Recent AI sessions
    const sessRes = await db.query<{
      id: string
      lecture_id: string
      group_id: string
      title: string
      is_archived: boolean
      created_at: string
      updated_at: string
    }>(
      `SELECT id, lecture_id, group_id, title, is_archived, created_at, updated_at
       FROM ai_sessions
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT 5`,
      [userId],
    )

    // Checklists stats
    const checkRes = await db.query<{
      total: number
      completed: number
    }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE is_completed = true)::int AS completed
       FROM ai_review_checklists
       WHERE user_id = $1`,
      [userId],
    )

    // Passkeys count
    const passkeyRes = await db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM auth_credentials WHERE user_id = $1 AND method = 'passkey'`,
      [userId],
    )

    // User record if in auth_users
    const userRes = await db.query<{
      id: string
      username: string
      email: string | null
      display_name: string
      roles: Role[] | string
    }>(
      `SELECT id, username, email, display_name, roles FROM auth_users WHERE id = $1`,
      [userId],
    )

    const wireUser = c.get('user')
    const user = userRes.rows[0]
      ? {
          id: userRes.rows[0].id,
          username: userRes.rows[0].username,
          displayName: userRes.rows[0].display_name,
          email: userRes.rows[0].email,
        }
      : {
          id: userId,
          username: wireUser?.name || userId,
          displayName: wireUser?.name || userId,
          email: wireUser?.email || null,
        }

    return c.json(
      {
        user,
        progress: progRes.rows[0] ?? { total: 0, completed: 0, in_progress: 0 },
        recentSessions: sessRes.rows,
        checklists: checkRes.rows[0] ?? { total: 0, completed: 0 },
        passkeyCount: Number(passkeyRes.rows[0]?.cnt ?? 0),
        currentSessionId: c.get('sessionId'),
        authMethod: c.get('authMethod'),
        rememberMe: c.get('rememberMe'),
      },
      200,
    )
  })

  // 2. GET /export
  router.get('/export', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'application/json; charset=utf-8')
    c.header('Content-Disposition', 'attachment; filename="my-learning-export.json"')

    const userId = getRequestUserId(c)!
    const userObj = c.get('user')

    const userRes = await db.query<{
      id: string
      username: string
      email: string | null
      display_name: string
      created_at: string
    }>(
      `SELECT id, username, email, display_name, created_at FROM auth_users WHERE id = $1`,
      [userId],
    )

    const profile = userRes.rows[0]
      ? {
          id: userRes.rows[0].id,
          username: userRes.rows[0].username,
          displayName: userRes.rows[0].display_name,
          email: userRes.rows[0].email,
          createdAt: userRes.rows[0].created_at,
        }
      : {
          id: userId,
          username: userObj?.name || userId,
          displayName: userObj?.name || userId,
          email: userObj?.email || null,
        }

    const progressRows = await db.query(
      `SELECT lecture_id, group_id, status, completed_at, updated_at, notion_node_id, notion_page_id
       FROM progress WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    )

    const aiSessions = await db.query(
      `SELECT id, lecture_id, group_id, title, is_archived, created_at, updated_at
       FROM ai_sessions WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    )

    const checklists = await db.query(
      `SELECT id, lecture_id, group_id, topic_title, section_anchor, is_completed, priority, created_at, updated_at
       FROM ai_review_checklists WHERE user_id = $1 ORDER BY priority DESC, created_at ASC`,
      [userId],
    )

    return c.json(
      {
        exportedAt: new Date().toISOString(),
        profile,
        progress: progressRows.rows,
        aiSessions: aiSessions.rows,
        aiReviewChecklists: checklists.rows,
      },
      200,
    )
  })

  // 3. PUT & PATCH /password
  const handlePasswordChange = async (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'no-store')
    const userId = getRequestUserId(c)!

    let body: { currentPassword?: unknown; oldPassword?: unknown; newPassword?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid payload' }, 400)
    }

    const userRes = await db.query<{ id: string; password_hash: string }>(
      `SELECT id, password_hash FROM auth_users WHERE id = $1`,
      [userId],
    )

    if (userRes.rowCount === 0 || !userRes.rows[0]) {
      return c.json(
        {
          error: 'gateway_managed_account',
          message: 'This account is managed by an external identity gateway',
        },
        400,
      )
    }

    const userRow = userRes.rows[0]
    if (userRow.password_hash !== '') {
      const currentRaw = body.currentPassword ?? body.oldPassword ?? ''
      const currentPassword = typeof currentRaw === 'string' ? currentRaw : ''
      const valid = await verifyPassword(currentPassword, userRow.password_hash)
      if (!valid) {
        return c.json(
          { error: 'invalid_current_password', message: 'Current password does not match' },
          400,
        )
      }
    }

    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
    try {
      validatePasswordStrength(newPassword)
    } catch (err) {
      return c.json(
        { error: 'invalid_new_password', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }

    const newHash = await hashPassword(newPassword)
    await db.query(
      `UPDATE auth_users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [newHash, userId],
    )

    const currentSessionId = c.get('sessionId')
    await revokeOtherSessions(db, userId, currentSessionId ?? undefined)

    return c.json({ ok: true }, 200)
  }

  router.put('/password', handlePasswordChange)
  router.patch('/password', handlePasswordChange)

  // 4. Credentials
  // GET /credentials
  router.get('/credentials', async (c) => {
    c.header('Cache-Control', 'no-store')
    const userId = getRequestUserId(c)!

    const creds = await db.query<{
      id: string
      method: string
      credential_id: string
      algorithm: number
      label: string
      aaguid: string
      last_used_at: string | null
      created_at: string
    }>(
      `SELECT id, method, credential_id, algorithm, label, aaguid, last_used_at, created_at
       FROM auth_credentials
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    )

    return c.json(creds.rows, 200)
  })

  // DELETE /credentials/:id
  router.delete('/credentials/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    const userId = getRequestUserId(c)!
    const credId = c.req.param('id')

    try {
      await db.tx(async (txClient) => {
        const userLockSql =
          db.kind === 'pg'
            ? `SELECT password_hash FROM auth_users WHERE id = $1 FOR UPDATE`
            : `SELECT password_hash FROM auth_users WHERE id = $1`
        const userRes = await txClient.query<{ password_hash: string }>(userLockSql, [userId])
        if (userRes.rowCount === 0 || !userRes.rows[0]) {
          throw new Error('gateway_managed_account')
        }

        const credRes = await txClient.query<{ id: string }>(
          `SELECT id FROM auth_credentials WHERE id = $1 AND user_id = $2`,
          [credId, userId],
        )
        if (credRes.rowCount === 0) {
          throw new Error('not_found')
        }

        const hasPassword = Boolean(userRes.rows[0].password_hash && userRes.rows[0].password_hash !== '')
        const countRes = await txClient.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM auth_credentials WHERE user_id = $1 AND method = 'passkey'`,
          [userId],
        )
        const credCount = Number(countRes.rows[0]?.count ?? 0)

        if (!hasPassword && credCount <= 1) {
          throw new Error('cannot_remove_last_login_method')
        }

        await txClient.query(`DELETE FROM auth_credentials WHERE id = $1 AND user_id = $2`, [credId, userId])
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'not_found') {
        return c.json({ error: 'not_found' }, 404)
      }
      if (msg === 'gateway_managed_account') {
        return c.json({ error: 'gateway_managed_account', message: 'External gateway accounts have no local credentials' }, 400)
      }
      if (msg === 'cannot_remove_last_login_method') {
        return c.json(
          {
            error: 'cannot_remove_last_login_method',
            message: 'Cannot remove last login method without a password set',
          },
          400,
        )
      }
      throw err
    }

    return c.json({ ok: true }, 200)
  })

  // 5. Passkey registration shortcuts on /api/me
  router.post('/passkeys/register/start', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!defaultAuthRegistry.get('passkey')?.isEnabled(config)) {
      return c.json({ error: 'auth_method_disabled', message: 'Passkey method is disabled' }, 403)
    }
    const userId = getRequestUserId(c)!
    const userRes = await db.query<{ id: string; username: string; display_name: string }>(
      'SELECT id, username, display_name FROM auth_users WHERE id = $1',
      [userId],
    )
    if (userRes.rowCount === 0 || !userRes.rows[0]) {
      return c.json(
        { error: 'gateway_managed_account', message: 'External gateway accounts have no local credentials' },
        400,
      )
    }
    const u = userRes.rows[0]

    const reqCtx = getRequestContext(c)
    try {
      const options = await createRegistrationOptions(db, config, reqCtx, {
        id: u.id,
        username: u.display_name || u.username,
        displayName: u.display_name || u.username,
      })
      return c.json(options, 200)
    } catch (err) {
      return c.json(
        { error: 'passkey_error', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }
  })

  router.post('/passkeys/register/finish', async (c) => {
    c.header('Cache-Control', 'no-store')
    if (!defaultAuthRegistry.get('passkey')?.isEnabled(config)) {
      return c.json({ error: 'auth_method_disabled', message: 'Passkey method is disabled' }, 403)
    }
    const userId = getRequestUserId(c)!
    const userRes = await db.query<{ id: string; username: string }>(
      'SELECT id, username FROM auth_users WHERE id = $1',
      [userId],
    )
    if (userRes.rowCount === 0 || !userRes.rows[0]) {
      return c.json(
        { error: 'gateway_managed_account', message: 'External gateway accounts have no local credentials' },
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
        { id: userId, username: userRes.rows[0].username },
        body as Parameters<typeof verifyRegistrationResponse>[4],
      )
      return c.json(result, 200)
    } catch (err) {
      return c.json(
        { error: 'passkey_verification_failed', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }
  })

  // 6. Sessions
  // GET /sessions
  router.get('/sessions', async (c) => {
    c.header('Cache-Control', 'no-store')
    const userId = getRequestUserId(c)!
    const currentSessionId = c.get('sessionId')

    const sessions = await db.query<{
      id: string
      auth_method: string
      remember_me: boolean
      user_agent: string
      ip_address: string
      expires_at: string
      created_at: string
      last_seen_at: string
    }>(
      `SELECT id, auth_method, remember_me, user_agent, ip_address, expires_at, created_at, last_seen_at
       FROM auth_sessions
       WHERE user_id = $1 AND expires_at > NOW()
       ORDER BY last_seen_at DESC`,
      [userId],
    )

    const list = sessions.rows.map((s) => ({
      ...s,
      is_current: s.id === currentSessionId,
    }))

    return c.json(list, 200)
  })

  // DELETE /sessions/:id
  router.delete('/sessions/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    const userId = getRequestUserId(c)!
    const targetSessionId = c.req.param('id')
    const currentSessionId = c.get('sessionId')

    const ok = await revokeSessionById(db, targetSessionId, userId)
    if (!ok) {
      return c.json({ error: 'not_found' }, 404)
    }

    if (targetSessionId === currentSessionId) {
      const secure = isSecureConnection(config.authCookieSecure, c.req.url, (n) => c.req.header(n))
      const clearCookie = serializeClearSessionCookie(config.authCookieName, secure)
      c.header('Set-Cookie', clearCookie)
    }

    return c.json({ ok: true }, 200)
  })

  return router
}
