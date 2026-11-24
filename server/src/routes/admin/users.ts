import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import {
  createManagedUser,
  deleteManagedUser,
  parseStoredRoles,
  updateManagedUser,
  UserManagementError,
  type CreateManagedUserInput,
  type UpdateManagedUserInput,
} from '../../services/usersService.js'

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

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    try {
      const user = await createManagedUser(db, body as CreateManagedUserInput)
      serverLogBuffer.add({
        level: 'info',
        category: 'admin',
        message: `User created: ${user.username} (${user.id})`,
      })

      return c.json(
        {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          roles: user.roles,
          disabled: user.disabled,
          lastLoginAt: user.last_login_at,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
        201,
      )
    } catch (err) {
      if (err instanceof UserManagementError) {
        return c.json({ error: err.code, message: err.message }, err.status)
      }
      throw err
    }
  })

  // 3. PATCH /:id — update user
  router.patch('/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    const targetUserId = c.req.param('id')

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    try {
      const user = await updateManagedUser(db, targetUserId, body as UpdateManagedUserInput)
      serverLogBuffer.add({
        level: 'info',
        category: 'admin',
        message: `User updated: ${user.username} (${user.id})`,
      })

      return c.json(
        {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          roles: user.roles,
          disabled: user.disabled,
          lastLoginAt: user.last_login_at,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
        200,
      )
    } catch (err) {
      if (err instanceof UserManagementError) {
        return c.json({ error: err.code, message: err.message }, err.status)
      }
      throw err
    }
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
      await updateManagedUser(db, targetUserId, { password })
      return c.json({ ok: true }, 200)
    } catch (err) {
      if (err instanceof UserManagementError) {
        return c.json({ error: err.code, message: err.message }, err.status)
      }
      throw err
    }
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

    try {
      const user = await updateManagedUser(db, targetUserId, { roles: body.roles })
      return c.json({ ok: true, roles: user.roles }, 200)
    } catch (err) {
      if (err instanceof UserManagementError) {
        return c.json({ error: err.code, message: err.message }, err.status)
      }
      throw err
    }
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

    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.disabled !== 'boolean'
    ) {
      return c.json({ error: 'invalid_request', message: 'Boolean disabled flag is required' }, 400)
    }

    try {
      const user = await updateManagedUser(db, targetUserId, { disabled: body.disabled })
      return c.json({ ok: true, disabled: user.disabled }, 200)
    } catch (err) {
      if (err instanceof UserManagementError) {
        return c.json({ error: err.code, message: err.message }, err.status)
      }
      throw err
    }
  })

  // 7. DELETE /:id — delete user
  router.delete('/:id', async (c) => {
    c.header('Cache-Control', 'no-store')
    const targetUserId = c.req.param('id')

    try {
      const deleted = await deleteManagedUser(db, targetUserId)
      serverLogBuffer.add({
        level: 'info',
        category: 'admin',
        message: `User deleted: ${deleted.username} (${deleted.id})`,
      })
      return c.json({ ok: true, deleted: true }, 200)
    } catch (err) {
      if (err instanceof UserManagementError) {
        return c.json({ error: err.code, message: err.message }, err.status)
      }
      throw err
    }
  })

  return router
}
