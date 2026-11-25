import type { AppConfig } from '../config/schema.js'
import type { Db } from '../db/types.js'
import { getSessionByRawToken, parseCookies } from './sessions.js'
import {
  ANONYMOUS_AUTH_RESULT,
  type AsyncAuthAdapter,
  type AuthResult,
  type HeaderGetter,
} from './types.js'

export function createLocalAuthAdapter(config: AppConfig, db: Db): AsyncAuthAdapter {
  return {
    async authenticate(getHeader: HeaderGetter): Promise<AuthResult> {
      const cookieHeader = getHeader('cookie')
      if (!cookieHeader) {
        return ANONYMOUS_AUTH_RESULT
      }

      const cookies = parseCookies(cookieHeader)
      const rawToken = cookies[config.authCookieName]
      if (!rawToken) {
        return ANONYMOUS_AUTH_RESULT
      }

      const activeSession = await getSessionByRawToken(db, rawToken)
      if (!activeSession) {
        return ANONYMOUS_AUTH_RESULT
      }

      const user = activeSession.user
      const roles = user.roles
      const canAccessAdmin = roles.includes('admin')
      const canAccessAuthor = canAccessAdmin || roles.includes('author')

      return {
        session: {
          authenticated: true,
          user: {
            id: user.id,
            name: user.displayName || user.username,
            email: user.email,
          },
          roles,
          groups: [],
          logoutUrl: config.logoutUrl ?? null,
        },
        effectiveUserId: user.id,
        authSource: 'cookie',
        authMethod: activeSession.authMethod,
        sessionId: activeSession.id,
        rememberMe: activeSession.rememberMe,
        canAccessAdmin,
        canAccessAuthor,
      }
    },
  }
}
