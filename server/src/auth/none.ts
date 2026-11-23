import { ANONYMOUS_SESSION, type AuthAdapter, type AuthResult } from './types.js'

/**
 * Anonymous auth adapter when AUTH_ADAPTER=none.
 *
 * Every request is assigned effectiveUserId = 'anonymous', while
 * the session returns the anonymous shape with authenticated = false.
 */
export function createNoneAuthAdapter(): AuthAdapter {
  return {
    authenticate(): AuthResult {
      return {
        session: ANONYMOUS_SESSION,
        effectiveUserId: 'anonymous',
      }
    },
  }
}
