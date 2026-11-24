import type { Role } from '../config/schema.js'

export interface WireSessionUser {
  id: string
  name: string | null
  email: string | null
}

export interface WireSession {
  authenticated: boolean
  user: WireSessionUser | null
  roles: Role[]
  groups: string[]
  logoutUrl: string | null
}

export interface AuthResult {
  session: WireSession
  effectiveUserId: string | null
  authSource: 'none' | 'gateway' | 'cookie'
  authMethod: string
  sessionId: string | null
  rememberMe: boolean
  canAccessAdmin: boolean
  canAccessAuthor: boolean
}

export type HeaderGetter = (name: string) => string | undefined

export interface SyncAuthAdapter {
  authenticate(getHeader: HeaderGetter, reqUrl?: string): AuthResult
}

export interface AsyncAuthAdapter {
  authenticate(getHeader: HeaderGetter, reqUrl?: string): Promise<AuthResult>
}

export type AuthAdapter = SyncAuthAdapter | AsyncAuthAdapter

export const ANONYMOUS_SESSION: WireSession = Object.freeze({
  authenticated: false,
  user: null,
  roles: ['reader'] as Role[],
  groups: [],
  logoutUrl: null,
})

export const ANONYMOUS_AUTH_RESULT: AuthResult = Object.freeze({
  session: ANONYMOUS_SESSION,
  effectiveUserId: null,
  authSource: 'none',
  authMethod: 'anonymous',
  sessionId: null,
  rememberMe: false,
  canAccessAdmin: false,
  canAccessAuthor: false,
})
