import { ANONYMOUS_SESSION, type AuthResult, type SyncAuthAdapter } from './types.js'

/**
 * Anonymous auth adapter when AUTH_ADAPTER=none.
 *
 * Every request is assigned effectiveUserId = 'anonymous', while
 * the session returns the anonymous shape with authenticated = false.
 */
export function createNoneAuthAdapter(): SyncAuthAdapter {
  return {
    authenticate(): AuthResult {
      return {
        session: ANONYMOUS_SESSION,
        effectiveUserId: 'anonymous',
        authSource: 'none',
        authMethod: 'anonymous',
        sessionId: null,
        rememberMe: false,
        canAccessAdmin: false,
        canAccessAuthor: false,
      }
    },
  }
}
