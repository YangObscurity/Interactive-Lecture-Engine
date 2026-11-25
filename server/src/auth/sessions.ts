import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AuthCookieSecure, Role } from '../config/schema.js'
import type { DbClient } from '../db/types.js'
import { parseStoredRoles } from '../services/usersService.js'

export interface ActiveSessionUser {
  id: string
  username: string
  email: string | null
  displayName: string
  roles: Role[]
  disabled: boolean
}

export interface ActiveSession {
  id: string
  userId: string
  authMethod: string
  rememberMe: boolean
  expiresAt: string
  createdAt: string
  lastSeenAt: string
  user: ActiveSessionUser
}

export function serializeSessionCookie(
  name: string,
  token: string,
  options: {
    rememberMe: boolean
    rememberMeDays: number
    secure: boolean
  },
): string {
  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (options.rememberMe) {
    const maxAgeSeconds = Math.max(1, Math.floor(options.rememberMeDays * 86400))
    parts.push(`Max-Age=${maxAgeSeconds}`)
  }
  if (options.secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

export function serializeClearSessionCookie(name: string, secure: boolean): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies = Object.create(null) as Record<string, string>
  if (!cookieHeader) return cookies
  const pairs = cookieHeader.split(';')
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=')
    if (eqIdx !== -1) {
      const key = pair.slice(0, eqIdx).trim()
      const val = pair.slice(eqIdx + 1).trim()
      if (key) {
        cookies[key] = val
      }
    }
  }
  return cookies
}

export function isSecureConnection(
  policy: AuthCookieSecure,
  reqUrl: string,
  getHeader: (name: string) => string | undefined,
): boolean {
  if (policy === 'true') return true
  if (policy === 'false') return false
  if (reqUrl.startsWith('https://')) return true
  const rawProto = getHeader('x-forwarded-proto')
  if (rawProto) {
    const firstProto = rawProto.split(',')[0]?.trim().toLowerCase()
    if (firstProto === 'https') return true
  }
  return false
}

export interface CreateSessionOptions {
  userId: string
  authMethod: string
  rememberMe: boolean
  userAgent?: string
  ipAddress?: string
  sessionTtlHours: number
  rememberMeDays: number
}

export async function createSessionRow(
  db: DbClient,
  opts: CreateSessionOptions,
): Promise<{ id: string; rawToken: string; expiresAt: Date; rememberMe: boolean }> {
  await db.query('DELETE FROM auth_sessions WHERE expires_at < NOW()')

  const rawToken = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  const id = randomUUID()
  const durationSec = opts.rememberMe ? opts.rememberMeDays * 86400 : opts.sessionTtlHours * 3600
  const expiresAt = new Date(Date.now() + durationSec * 1000)

  await db.query(
    `INSERT INTO auth_sessions (id, user_id, token_hash, auth_method, remember_me, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      id,
      opts.userId,
      tokenHash,
      opts.authMethod,
      opts.rememberMe,
      opts.userAgent ?? '',
      opts.ipAddress ?? '',
      expiresAt.toISOString(),
    ],
  )

  return { id, rawToken, expiresAt, rememberMe: opts.rememberMe }
}

export async function getSessionByRawToken(
  db: DbClient,
  rawToken: string,
): Promise<ActiveSession | null> {
  if (!rawToken || typeof rawToken !== 'string') return null
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')

  const res = await db.query<{
    id: string
    user_id: string
    auth_method: string
    remember_me: boolean
    expires_at: string
    created_at: string
    last_seen_at: string
    u_id: string
    u_username: string
    u_email: string | null
    u_display_name: string
    u_roles: Role[] | string
    u_disabled: boolean
  }>(
    `SELECT
       s.id, s.user_id, s.auth_method, s.remember_me, s.expires_at, s.created_at, s.last_seen_at,
       u.id as u_id, u.username as u_username, u.email as u_email, u.display_name as u_display_name,
       u.roles as u_roles, u.disabled as u_disabled
     FROM auth_sessions s
     JOIN auth_users u ON s.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash],
  )

  if (res.rowCount === 0 || !res.rows[0]) return null
  const row = res.rows[0]
  if (row.u_disabled) return null

  const roles = parseStoredRoles(row.u_roles)

  // Update last_seen_at
  db.query(`UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1`, [row.id]).catch(() => {})

  return {
    id: row.id,
    userId: row.user_id,
    authMethod: row.auth_method,
    rememberMe: row.remember_me,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    user: {
      id: row.u_id,
      username: row.u_username,
      email: row.u_email,
      displayName: row.u_display_name,
      roles,
      disabled: row.u_disabled,
    },
  }
}

export async function revokeSessionByRawToken(db: DbClient, rawToken: string): Promise<void> {
  if (!rawToken || typeof rawToken !== 'string') return
  const tokenHash = createHash('sha256').update(rawToken).digest('hex')
  await db.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [tokenHash])
}

export async function revokeSessionById(
  db: DbClient,
  id: string,
  userId?: string,
): Promise<boolean> {
  const sql = userId
    ? `DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2`
    : `DELETE FROM auth_sessions WHERE id = $1`
  const params = userId ? [id, userId] : [id]
  const res = await db.query(sql, params)
  return res.rowCount > 0
}

export async function revokeOtherSessions(
  db: DbClient,
  userId: string,
  keepSessionId?: string,
): Promise<void> {
  if (keepSessionId) {
    await db.query(`DELETE FROM auth_sessions WHERE user_id = $1 AND id <> $2`, [
      userId,
      keepSessionId,
    ])
  } else {
    await db.query(`DELETE FROM auth_sessions WHERE user_id = $1`, [userId])
  }
}
