import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import {
  hashPassword,
  PasswordValidationError,
  validatePasswordStrength,
} from '../../auth/password.js'
import type { Role } from '../../config/schema.js'
import type { Db, DbClient } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'

const VALID_ROLES = new Set<Role>(['reader', 'author', 'admin'])
const ADMIN_LOCK_KEY = 4928174

function parseStoredRoles(raw: unknown): Role[] {
  let roles: Role[]
  if (Array.isArray(raw)) {
    roles = raw.filter((r): r is Role => typeof r === 'string' && VALID_ROLES.has(r as Role))
  } else if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      roles = Array.isArray(parsed)
        ? parsed.filter((r): r is Role => typeof r === 'string' && VALID_ROLES.has(r as Role))
        : ['reader']
    } catch {
      roles = ['reader']
    }
  } else {
    roles = ['reader']
  }
  if (!roles.includes('reader')) {
    roles = ['reader', ...roles]
  }
  return [...new Set(roles)]
}

function parseRequestedRoles(raw: unknown): { ok: true; roles: Role[] } | { ok: false; message: string } {
  if (raw === undefined) {
    return { ok: true, roles: ['reader'] }
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: 'roles must be an array' }
  }
  const normalized: Role[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !VALID_ROLES.has(item as Role)) {
      return { ok: false, message: `Unsupported role value: ${String(item)}` }
    }
    normalized.push(item as Role)
  }
  if (!normalized.includes('reader')) {
    normalized.unshift('reader')
  }
  return { ok: true, roles: [...new Set(normalized)] }
}

function isPgUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === '23505') return true
  if (typeof e.message === 'string' && /duplicate key|unique constraint/i.test(e.message)) {
    return true
  }
  return false
}

async function countActiveAdmins(client: DbClient): Promise<number> {
  const res = await client.query<{ count: string | number }>(
    `SELECT COUNT(*)::int AS count FROM auth_users
     WHERE disabled = FALSE AND roles @> '["admin"]'::jsonb`,
  )
  return Number(res.rows[0]?.count ?? 0)
}

export function createAdminUsersRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // 1. GET / — list users
  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const res = await db.query<{
      id: string
      username: string
      email: string | null
      display_name: string
      roles: unknown
      disabled: boolean
      last_login_at: string | null
      created_at: string
      updated_at: string
    }>(
      `SELECT id, username, email, display_name, roles, disabled, last_login_at, created_at, updated_at
       FROM auth_users
       ORDER BY created_at ASC`,
    )

    const users = res.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      displayName: row.display_name,
      roles: parseStoredRoles(row.roles),
      disabled: row.disabled,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))

    return c.json(users, 200)
  })

  // 2. POST / — create user
  router.post('/', async (c) => {
    c.header('Cache-Control', 'no-store')

    let body: {
      username?: unknown
      password?: unknown
      displayName?: unknown
      email?: unknown
      roles?: unknown
      disabled?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    const username = typeof body.username === 'string' ? body.username.trim() : ''
    if (!username || username.length < 3 || username.length > 64) {
      return c.json(
        { error: 'invalid_username', message: 'Username must be between 3 and 64 characters' },
        400,
      )
    }

    let passwordHash = ''
    if (body.password === null) {
      // Explicit passwordless user (Passkey onboarding)
      passwordHash = ''
    } else if (typeof body.password === 'string') {
      try {
        validatePasswordStrength(body.password)
      } catch (err) {
        return c.json(
          { error: 'invalid_password', message: err instanceof Error ? err.message : String(err) },
          400,
        )
      }
      passwordHash = await hashPassword(body.password)
    } else {
      return c.json(
        { error: 'invalid_password', message: 'Password must be at least 8 characters' },
        400,
      )
    }

    const rolesParsed = parseRequestedRoles(body.roles)
    if (!rolesParsed.ok) {
      return c.json({ error: 'invalid_roles', message: rolesParsed.message }, 400)
    }

    const id = randomUUID()
    const email =
      typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null
    const displayName =
      typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim()
        : username
    const disabled = typeof body.disabled === 'boolean' ? body.disabled : false

    try {
      await db.query(
        `INSERT INTO auth_users (id, username, email, display_name, password_hash, roles, disabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, username, email, displayName, passwordHash, JSON.stringify(rolesParsed.roles), disabled],
      )
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        return c.json(
          { error: 'username_or_email_exists', message: 'Username or email is already taken' },
          409,
        )
      }
      throw err
    }

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `User created: ${username} (${id})`,
    })

    return c.json(
      {
        id,
        username,
        email,
        displayName,
        roles: rolesParsed.roles,
        disabled,
        lastLoginAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      201,
    )
  })

  // 3. PATCH /:id — update user
  router.patch('/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    const targetUserId = c.req.param('id')

    let body: {
      displayName?: unknown
      email?: unknown
      roles?: unknown
      disabled?: unknown
      password?: unknown
    }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    let parsedNewRoles: Role[] | undefined
    if (body.roles !== undefined) {
      const check = parseRequestedRoles(body.roles)
      if (!check.ok) {
        return c.json({ error: 'invalid_roles', message: check.message }, 400)
      }
      parsedNewRoles = check.roles
    }

    if (body.disabled !== undefined && typeof body.disabled !== 'boolean') {
      return c.json({ error: 'invalid_request', message: 'disabled must be boolean' }, 400)
    }

    let passwordHashUpdate: string | null = null
    if (body.password !== undefined) {
      if (typeof body.password !== 'string') {
        return c.json({ error: 'invalid_password', message: 'Password must be a string' }, 400)
      }
      if (body.password.length > 0) {
        try {
          validatePasswordStrength(body.password)
        } catch (err) {
          return c.json(
            {
              error: 'invalid_password',
              message: err instanceof PasswordValidationError || err instanceof Error ? err.message : String(err),
            },
            400,
          )
        }
        passwordHashUpdate = await hashPassword(body.password)
      }
    }

    let updatedRow: {
      id: string
      username: string
      email: string | null
      display_name: string
      roles: unknown
      disabled: boolean
      last_login_at: string | null
      created_at: string
      updated_at: string
    } | null = null

    try {
      await db.tx(async (txClient) => {
        if (db.kind === 'pg') {
          await txClient.query(`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`)
        }

        const userRes = await txClient.query<{
          id: string
          username: string
          roles: unknown
          disabled: boolean
        }>(
          `SELECT id, username, roles, disabled FROM auth_users WHERE id = $1`,
          [targetUserId],
        )

        if (userRes.rowCount === 0 || !userRes.rows[0]) {
          throw new Error('not_found')
        }

        const targetUser = userRes.rows[0]
        const currentRoles = parseStoredRoles(targetUser.roles)
        const isTargetActiveAdmin = !targetUser.disabled && currentRoles.includes('admin')
        const nextRoles = parsedNewRoles ?? currentRoles
        const nextDisabled = body.disabled !== undefined ? Boolean(body.disabled) : targetUser.disabled

        if (isTargetActiveAdmin && (nextDisabled || !nextRoles.includes('admin'))) {
          const activeAdminCount = await countActiveAdmins(txClient)
          if (activeAdminCount <= 1) {
            throw new Error('cannot_remove_last_admin')
          }
        }

        const params: unknown[] = [targetUserId]
        const updates: string[] = ['updated_at = NOW()']

        if (body.displayName !== undefined) {
          if (typeof body.displayName !== 'string') throw new Error('invalid_display_name')
          params.push(body.displayName.trim())
          updates.push(`display_name = $${params.length}`)
        }
        if (body.email !== undefined) {
          if (body.email !== null && typeof body.email !== 'string') throw new Error('invalid_email')
          params.push(typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null)
          updates.push(`email = $${params.length}`)
        }
        if (parsedNewRoles !== undefined) {
          params.push(JSON.stringify(parsedNewRoles))
          updates.push(`roles = $${params.length}`)
        }
        if (body.disabled !== undefined) {
          params.push(nextDisabled)
          updates.push(`disabled = $${params.length}`)
        }
        if (passwordHashUpdate !== null) {
          params.push(passwordHashUpdate)
          updates.push(`password_hash = $${params.length}`)
        }

        await txClient.query(`UPDATE auth_users SET ${updates.join(', ')} WHERE id = $1`, params)

        if (nextDisabled || passwordHashUpdate !== null) {
          await txClient.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [targetUserId])
        }

        const afterRes = await txClient.query<NonNullable<typeof updatedRow>>(
          `SELECT id, username, email, display_name, roles, disabled, last_login_at, created_at, updated_at
           FROM auth_users WHERE id = $1`,
          [targetUserId],
        )
        updatedRow = afterRes.rows[0] ?? null
      })
    } catch (err) {
      if (isPgUniqueViolation(err)) {
        return c.json(
          { error: 'username_or_email_exists', message: 'Email or username is already in use' },
          409,
        )
      }
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'not_found') {
        return c.json({ error: 'not_found', message: 'User not found' }, 404)
      }
      if (msg === 'cannot_remove_last_admin') {
        return c.json(
          {
            error: 'cannot_remove_last_admin',
            message: 'Cannot disable or remove admin role from the last active administrator',
          },
          409,
        )
      }
      if (msg === 'invalid_display_name' || msg === 'invalid_email') {
        return c.json({ error: 'invalid_request', message: msg }, 400)
      }
      throw err
    }

    const updated = updatedRow!
    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `User updated: ${updated.username} (${updated.id})`,
    })

    return c.json(
      {
        id: updated.id,
        username: updated.username,
        email: updated.email,
        displayName: updated.display_name,
        roles: parseStoredRoles(updated.roles),
        disabled: updated.disabled,
        lastLoginAt: updated.last_login_at,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
      200,
    )
  })

  // 4. PUT /:id/password — reset user password and revoke active sessions
  router.put('/:id/password', async (c) => {
    c.header('Cache-Control', 'no-store')
    const targetUserId = c.req.param('id')

    let body: { newPassword?: unknown; password?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    const password =
      typeof body.newPassword === 'string'
        ? body.newPassword
        : typeof body.password === 'string'
          ? body.password
          : ''
    try {
      validatePasswordStrength(password)
    } catch (err) {
      return c.json(
        { error: 'invalid_password', message: err instanceof Error ? err.message : String(err) },
        400,
      )
    }

    const passwordHash = await hashPassword(password)
    const found = await db.tx(async (txClient) => {
      const res = await txClient.query(
        'UPDATE auth_users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [passwordHash, targetUserId],
      )
      if (res.rowCount === 0) return false
      await txClient.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetUserId])
      return true
    })

    if (!found) {
      return c.json({ error: 'not_found', message: 'User not found' }, 404)
    }
    return c.json({ ok: true }, 200)
  })

  // 5. PUT /:id/roles — update user roles
  router.put('/:id/roles', async (c) => {
    c.header('Cache-Control', 'no-store')
    const targetUserId = c.req.param('id')

    let body: { roles?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body) || body.roles === undefined) {
      return c.json({ error: 'invalid_roles', message: 'roles array is required' }, 400)
    }

    const rolesParsed = parseRequestedRoles(body.roles)
    if (!rolesParsed.ok) {
      return c.json({ error: 'invalid_roles', message: rolesParsed.message }, 400)
    }

    try {
      await db.tx(async (txClient) => {
        if (db.kind === 'pg') {
          await txClient.query(`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`)
        }
        const userRes = await txClient.query<{ id: string; roles: unknown; disabled: boolean }>(
          'SELECT id, roles, disabled FROM auth_users WHERE id = $1',
          [targetUserId],
        )
        if (userRes.rowCount === 0 || !userRes.rows[0]) {
          throw new Error('not_found')
        }
        const targetUser = userRes.rows[0]
        const currentRoles = parseStoredRoles(targetUser.roles)
        const isTargetActiveAdmin = !targetUser.disabled && currentRoles.includes('admin')

        if (isTargetActiveAdmin && !rolesParsed.roles.includes('admin')) {
          const activeAdminCount = await countActiveAdmins(txClient)
          if (activeAdminCount <= 1) {
            throw new Error('cannot_remove_last_admin')
          }
        }

        await txClient.query(
          'UPDATE auth_users SET roles = $1, updated_at = NOW() WHERE id = $2',
          [JSON.stringify(rolesParsed.roles), targetUserId],
        )
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'not_found') {
        return c.json({ error: 'not_found', message: 'User not found' }, 404)
      }
      if (msg === 'cannot_remove_last_admin') {
        return c.json(
          {
            error: 'cannot_remove_last_admin',
            message: 'Cannot remove admin role from the last active administrator',
          },
          409,
        )
      }
      throw err
    }

    return c.json({ ok: true, roles: rolesParsed.roles }, 200)
  })

  // 6. PUT /:id/status — update user status (enable/disable) and revoke sessions on disable
  router.put('/:id/status', async (c) => {
    c.header('Cache-Control', 'no-store')
    const targetUserId = c.req.param('id')

    let body: { disabled?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.disabled !== 'boolean') {
      return c.json({ error: 'invalid_request', message: 'Boolean disabled flag is required' }, 400)
    }
    const disabled = body.disabled

    try {
      await db.tx(async (txClient) => {
        if (db.kind === 'pg') {
          await txClient.query(`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`)
        }
        const userRes = await txClient.query<{ id: string; roles: unknown; disabled: boolean }>(
          'SELECT id, roles, disabled FROM auth_users WHERE id = $1',
          [targetUserId],
        )
        if (userRes.rowCount === 0 || !userRes.rows[0]) {
          throw new Error('not_found')
        }
        const targetUser = userRes.rows[0]
        const currentRoles = parseStoredRoles(targetUser.roles)
        const isTargetActiveAdmin = !targetUser.disabled && currentRoles.includes('admin')

        if (isTargetActiveAdmin && disabled) {
          const activeAdminCount = await countActiveAdmins(txClient)
          if (activeAdminCount <= 1) {
            throw new Error('cannot_remove_last_admin')
          }
        }

        await txClient.query(
          'UPDATE auth_users SET disabled = $1, updated_at = NOW() WHERE id = $2',
          [disabled, targetUserId],
        )
        if (disabled) {
          await txClient.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetUserId])
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'not_found') {
        return c.json({ error: 'not_found', message: 'User not found' }, 404)
      }
      if (msg === 'cannot_remove_last_admin') {
        return c.json(
          {
            error: 'cannot_remove_last_admin',
            message: 'Cannot disable the last active administrator',
          },
          409,
        )
      }
      throw err
    }

    return c.json({ ok: true, disabled }, 200)
  })

  // 7. DELETE /:id — delete user
  router.delete('/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    const targetUserId = c.req.param('id')

    let deletedUsername = ''
    try {
      await db.tx(async (txClient) => {
        if (db.kind === 'pg') {
          await txClient.query(`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`)
        }
        const userRes = await txClient.query<{
          id: string
          username: string
          roles: unknown
          disabled: boolean
        }>(
          `SELECT id, username, roles, disabled FROM auth_users WHERE id = $1`,
          [targetUserId],
        )

        if (userRes.rowCount === 0 || !userRes.rows[0]) {
          throw new Error('not_found')
        }

        const targetUser = userRes.rows[0]
        deletedUsername = targetUser.username
        const currentRoles = parseStoredRoles(targetUser.roles)
        const isTargetActiveAdmin = !targetUser.disabled && currentRoles.includes('admin')

        if (isTargetActiveAdmin) {
          const activeAdminCount = await countActiveAdmins(txClient)
          if (activeAdminCount <= 1) {
            throw new Error('cannot_remove_last_admin')
          }
        }

        await txClient.query(`DELETE FROM auth_users WHERE id = $1`, [targetUserId])
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'not_found') {
        return c.json({ error: 'not_found', message: 'User not found' }, 404)
      }
      if (msg === 'cannot_remove_last_admin') {
        return c.json(
          {
            error: 'cannot_remove_last_admin',
            message: 'Cannot delete the last active administrator',
          },
          409,
        )
      }
      throw err
    }

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `User deleted: ${deletedUsername} (${targetUserId})`,
    })

    return c.json({ ok: true }, 200)
  })

  return router
}
