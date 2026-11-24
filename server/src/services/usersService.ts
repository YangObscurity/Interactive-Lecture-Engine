import { randomUUID } from 'node:crypto'
import {
  hashPassword,
  PasswordValidationError,
  validatePasswordStrength,
} from '../auth/password.js'
import type { Role } from '../config/schema.js'
import type { Db, DbClient } from '../db/types.js'

export const VALID_ROLES = new Set<Role>(['reader', 'author', 'admin'])
export const ADMIN_LOCK_KEY = 4928174

export class UserManagementError extends Error {
  readonly code: string
  readonly status: 400 | 401 | 403 | 404 | 409

  constructor(code: string, message: string, status: 400 | 401 | 403 | 404 | 409 = 400) {
    super(message)
    this.name = 'UserManagementError'
    this.code = code
    this.status = status
  }
}

export function parseStoredRoles(raw: unknown): Role[] {
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

export function parseRequestedRoles(
  raw: unknown,
): { ok: true; roles: Role[] } | { ok: false; message: string } {
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

export function isPgUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; message?: unknown }
  if (e.code === '23505') return true
  if (typeof e.message === 'string' && /duplicate key|unique constraint/i.test(e.message)) {
    return true
  }
  return false
}

export async function countActiveAdmins(client: DbClient): Promise<number> {
  const res = await client.query<{ count: string | number }>(
    `SELECT COUNT(*)::int AS count FROM auth_users
     WHERE disabled = FALSE AND roles @> '["admin"]'::jsonb`,
  )
  return Number(res.rows[0]?.count ?? 0)
}

export interface ManagedUserRow {
  id: string
  username: string
  email: string | null
  display_name: string
  roles: Role[]
  disabled: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
  password_hash: string
}

export interface CreateManagedUserInput {
  id?: string | null
  username?: unknown
  password?: unknown
  displayName?: unknown
  display_name?: unknown
  email?: unknown
  roles?: unknown
  disabled?: unknown
  last_login_at?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export async function createManagedUser(
  db: Db,
  input: CreateManagedUserInput,
): Promise<ManagedUserRow> {
  const rawUsername = typeof input.username === 'string' ? input.username.trim() : ''
  if (!rawUsername || rawUsername.length < 3 || rawUsername.length > 64) {
    throw new UserManagementError(
      'invalid_username',
      'Username must be between 3 and 64 characters',
      400,
    )
  }

  let passwordHash = ''
  if (input.password === null || input.password === '') {
    passwordHash = ''
  } else if (typeof input.password === 'string') {
    try {
      validatePasswordStrength(input.password)
    } catch (err) {
      throw new UserManagementError(
        'invalid_password',
        err instanceof PasswordValidationError || err instanceof Error
          ? err.message
          : String(err),
        400,
      )
    }
    passwordHash = await hashPassword(input.password)
  } else if (input.password !== undefined) {
    throw new UserManagementError('invalid_password', 'Password must be at least 8 characters', 400)
  }

  const rolesParsed = parseRequestedRoles(input.roles)
  if (!rolesParsed.ok) {
    throw new UserManagementError('invalid_roles', rolesParsed.message, 400)
  }

  const id =
    typeof input.id === 'string' && input.id.trim() !== '' ? input.id.trim() : randomUUID()
  const email =
    typeof input.email === 'string' && input.email.trim() ? input.email.trim() : null
  const rawDisplayName = input.displayName ?? input.display_name
  const displayName =
    typeof rawDisplayName === 'string' && rawDisplayName.trim()
      ? rawDisplayName.trim()
      : rawUsername
  const disabled = typeof input.disabled === 'boolean' ? input.disabled : false

  try {
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
      password_hash: string
    }>(
      `INSERT INTO auth_users (id, username, email, display_name, password_hash, roles, disabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, username, email, display_name, roles, disabled, last_login_at, created_at, updated_at, password_hash`,
      [id, rawUsername, email, displayName, passwordHash, JSON.stringify(rolesParsed.roles), disabled],
    )
    const row = res.rows[0]!
    return {
      ...row,
      roles: parseStoredRoles(row.roles),
    }
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new UserManagementError(
        'username_or_email_exists',
        'Username or email is already taken',
        409,
      )
    }
    throw err
  }
}

export interface UpdateManagedUserInput {
  username?: unknown
  displayName?: unknown
  display_name?: unknown
  email?: unknown
  roles?: unknown
  disabled?: unknown
  password?: unknown
}

export async function updateManagedUser(
  db: Db,
  targetUserId: string,
  input: UpdateManagedUserInput,
): Promise<ManagedUserRow> {
  let parsedNewRoles: Role[] | undefined
  if (input.roles !== undefined) {
    const check = parseRequestedRoles(input.roles)
    if (!check.ok) {
      throw new UserManagementError('invalid_roles', check.message, 400)
    }
    parsedNewRoles = check.roles
  }

  if (input.disabled !== undefined && typeof input.disabled !== 'boolean') {
    throw new UserManagementError('invalid_request', 'disabled must be boolean', 400)
  }

  let passwordHashUpdate: string | null = null
  if (input.password !== undefined && input.password !== null) {
    if (typeof input.password !== 'string') {
      throw new UserManagementError('invalid_password', 'Password must be a string', 400)
    }
    if (input.password.length > 0) {
      try {
        validatePasswordStrength(input.password)
      } catch (err) {
        throw new UserManagementError(
          'invalid_password',
          err instanceof PasswordValidationError || err instanceof Error
            ? err.message
            : String(err),
          400,
        )
      }
      passwordHashUpdate = await hashPassword(input.password)
    }
  }

  try {
    return await db.tx(async (txClient) => {
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
        throw new UserManagementError('not_found', 'User not found', 404)
      }

      const targetUser = userRes.rows[0]
      const currentRoles = parseStoredRoles(targetUser.roles)
      const isTargetActiveAdmin = !targetUser.disabled && currentRoles.includes('admin')
      const nextRoles = parsedNewRoles ?? currentRoles
      const nextDisabled =
        input.disabled !== undefined ? Boolean(input.disabled) : targetUser.disabled

      if (isTargetActiveAdmin && (nextDisabled || !nextRoles.includes('admin'))) {
        const activeAdminCount = await countActiveAdmins(txClient)
        if (activeAdminCount <= 1) {
          throw new UserManagementError(
            'cannot_remove_last_admin',
            'Cannot remove or disable the last active administrator',
            409,
          )
        }
      }

      const params: unknown[] = [targetUserId]
      const updates: string[] = ['updated_at = NOW()']

      if (input.username !== undefined) {
        const cleanUsername = typeof input.username === 'string' ? input.username.trim() : ''
        if (!cleanUsername || cleanUsername.length < 3 || cleanUsername.length > 64) {
          throw new UserManagementError(
            'invalid_username',
            'Username must be between 3 and 64 characters',
            400,
          )
        }
        params.push(cleanUsername)
        updates.push(`username = $${params.length}`)
      }

      const rawDisplayName = input.displayName ?? input.display_name
      if (rawDisplayName !== undefined) {
        if (typeof rawDisplayName !== 'string') {
          throw new UserManagementError('invalid_display_name', 'Display name must be string', 400)
        }
        params.push(rawDisplayName.trim())
        updates.push(`display_name = $${params.length}`)
      }
      if (input.email !== undefined) {
        if (input.email !== null && typeof input.email !== 'string') {
          throw new UserManagementError('invalid_email', 'Email must be string or null', 400)
        }
        params.push(
          typeof input.email === 'string' && input.email.trim() ? input.email.trim() : null,
        )
        updates.push(`email = $${params.length}`)
      }
      if (parsedNewRoles !== undefined) {
        params.push(JSON.stringify(parsedNewRoles))
        updates.push(`roles = $${params.length}`)
      }
      if (input.disabled !== undefined) {
        params.push(nextDisabled)
        updates.push(`disabled = $${params.length}`)
      }
      if (passwordHashUpdate !== null) {
        params.push(passwordHashUpdate)
        updates.push(`password_hash = $${params.length}`)
      }

      const res = await txClient.query<{
        id: string
        username: string
        email: string | null
        display_name: string
        roles: unknown
        disabled: boolean
        last_login_at: string | null
        created_at: string
        updated_at: string
        password_hash: string
      }>(
        `UPDATE auth_users
         SET ${updates.join(', ')}
         WHERE id = $1
         RETURNING id, username, email, display_name, roles, disabled, last_login_at, created_at, updated_at, password_hash`,
        params,
      )

      if (nextDisabled || passwordHashUpdate !== null) {
        await txClient.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetUserId])
      }

      const updated = res.rows[0]!
      return {
        ...updated,
        roles: parseStoredRoles(updated.roles),
      }
    })
  } catch (err) {
    if (err instanceof UserManagementError) throw err
    if (isPgUniqueViolation(err)) {
      throw new UserManagementError(
        'username_or_email_exists',
        'Username or email is already taken',
        409,
      )
    }
    throw err
  }
}

export async function deleteManagedUser(
  db: Db,
  targetUserId: string,
): Promise<{ id: string; username: string }> {
  try {
    return await db.tx(async (txClient) => {
      if (db.kind === 'pg') {
        await txClient.query(`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`)
      }

      const userRes = await txClient.query<{
        id: string
        username: string
        roles: unknown
        disabled: boolean
      }>('SELECT id, username, roles, disabled FROM auth_users WHERE id = $1', [targetUserId])

      if (userRes.rowCount === 0 || !userRes.rows[0]) {
        throw new UserManagementError('not_found', 'User not found', 404)
      }

      const user = userRes.rows[0]
      const currentRoles = parseStoredRoles(user.roles)
      const isActiveAdmin = !user.disabled && currentRoles.includes('admin')

      if (isActiveAdmin) {
        const activeAdminCount = await countActiveAdmins(txClient)
        if (activeAdminCount <= 1) {
          throw new UserManagementError(
            'cannot_remove_last_admin',
            'Cannot remove the last active administrator',
            409,
          )
        }
      }

      await txClient.query('DELETE FROM auth_sessions WHERE user_id = $1', [targetUserId])
      await txClient.query('DELETE FROM auth_credentials WHERE user_id = $1', [targetUserId])
      const delRes = await txClient.query<{ id: string; username: string }>(
        'DELETE FROM auth_users WHERE id = $1 RETURNING id, username',
        [targetUserId],
      )
      return delRes.rows[0]!
    })
  } catch (err) {
    if (err instanceof UserManagementError) throw err
    throw err
  }
}
