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
}

export type HeaderGetter = (name: string) => string | undefined

export interface AuthAdapter {
  authenticate(getHeader: HeaderGetter): AuthResult
}

export const ANONYMOUS_SESSION: WireSession = Object.freeze({
  authenticated: false,
  user: null,
  roles: ['reader'] as Role[],
  groups: [],
  logoutUrl: null,
})
