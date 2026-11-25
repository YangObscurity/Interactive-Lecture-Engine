import type { AppConfig } from '../config/schema.js'
import { defaultAuthRegistry } from './providers/registry.js'
import { resolveRoles } from './roles.js'
import {
  ANONYMOUS_AUTH_RESULT,
  type AuthResult,
  type HeaderGetter,
  type SyncAuthAdapter,
} from './types.js'

// ASCII control characters (0x00-0x1F and 0x7F DEL)
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/

function getCaseInsensitive(getHeader: HeaderGetter, name: string): string | undefined {
  const direct = getHeader(name)
  if (direct !== undefined) {
    return direct
  }
  return getHeader(name.toLowerCase())
}

/**
 * Resolves authentication from trusted gateway headers according to API Contract §1.2.
 */
export function resolveTrustedHeaderAuth(
  getHeader: HeaderGetter,
  config: AppConfig,
): AuthResult {
  const gatewayMethod = defaultAuthRegistry.get('gateway')
  if (gatewayMethod && !gatewayMethod.isEnabled(config)) {
    return ANONYMOUS_AUTH_RESULT
  }

  const userHeader = config.authHeaderUser
  if (!userHeader) {
    return ANONYMOUS_AUTH_RESULT
  }

  const rawUser = getCaseInsensitive(getHeader, userHeader)
  const rawGroups = config.authHeaderGroups
    ? getCaseInsensitive(getHeader, config.authHeaderGroups)
    : undefined
  const rawEmail = config.authHeaderEmail
    ? getCaseInsensitive(getHeader, config.authHeaderEmail)
    : undefined
  const rawName = config.authHeaderName
    ? getCaseInsensitive(getHeader, config.authHeaderName)
    : undefined

  const candidates = [rawUser, rawGroups, rawEmail, rawName]

  // Sanitization: Any present header with control characters or length > 256 rejects entire identity
  for (const val of candidates) {
    if (val !== undefined && val !== null) {
      if (val.length > 256 || val.trim().length > 256 || CONTROL_CHAR_RE.test(val)) {
        return ANONYMOUS_AUTH_RESULT
      }
    }
  }

  // Missing or whitespace-only user header means no identity
  if (rawUser === undefined || rawUser === null) {
    return ANONYMOUS_AUTH_RESULT
  }

  const user = rawUser.trim()
  if (user.length === 0) {
    return ANONYMOUS_AUTH_RESULT
  }

  // Parse and deduplicate groups preserving encounter order
  const groups: string[] = []
  if (rawGroups !== undefined && rawGroups !== null) {
    const sep = config.authGroupSeparator || ','
    const seen = new Set<string>()
    for (const part of rawGroups.split(sep)) {
      const trimmed = part.trim()
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed)
        groups.push(trimmed)
      }
    }
  }

  const roles = resolveRoles(groups, config.authRoleMap)
  const canAccessAdmin = roles.includes('admin')
  const canAccessAuthor = canAccessAdmin || roles.includes('author')

  const email =
    rawEmail !== undefined && rawEmail !== null && rawEmail.trim().length > 0
      ? rawEmail.trim()
      : null

  const name =
    rawName !== undefined && rawName !== null && rawName.trim().length > 0
      ? rawName.trim()
      : null

  return {
    session: {
      authenticated: true,
      user: {
        id: user,
        name,
        email,
      },
      roles,
      groups,
      logoutUrl: config.logoutUrl ?? null,
    },
    effectiveUserId: user,
    authSource: 'gateway',
    authMethod: 'gateway',
    sessionId: null,
    rememberMe: false,
    canAccessAdmin,
    canAccessAuthor,
  }
}

export function createTrustedHeaderAuthAdapter(config: AppConfig): SyncAuthAdapter {
  return {
    authenticate(getHeader: HeaderGetter): AuthResult {
      return resolveTrustedHeaderAuth(getHeader, config)
    },
  }
}
