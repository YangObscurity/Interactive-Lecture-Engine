import type { MiddlewareHandler } from 'hono'
import type { AppConfig } from '../config/schema.js'
import { createNoneAuthAdapter } from './none.js'
import { createTrustedHeaderAuthAdapter } from './trustedHeader.js'
import type { AuthAdapter, HeaderGetter } from './types.js'

export * from './types.js'
export { resolveRoles } from './roles.js'
export { createNoneAuthAdapter } from './none.js'
export {
  createTrustedHeaderAuthAdapter,
  resolveTrustedHeaderAuth,
} from './trustedHeader.js'

export function createAuthAdapter(config: AppConfig): AuthAdapter {
  if (config.authAdapter === 'trusted-header') {
    return createTrustedHeaderAuthAdapter(config)
  }
  return createNoneAuthAdapter()
}

/**
 * Creates Hono middleware that evaluates authentication and populates context variables:
 * - c.set('auth', authResult)
 * - c.set('session', authResult.session)
 * - c.set('effectiveUserId', authResult.effectiveUserId)
 * - c.set('userId', authResult.effectiveUserId)
 * - c.set('user', authResult.session.user)
 */
export function createAuthMiddleware(
  config: AppConfig,
): MiddlewareHandler {
  const adapter = createAuthAdapter(config)

  return async (c, next) => {
    const getHeader: HeaderGetter = (name: string) => c.req.header(name)
    const auth = adapter.authenticate(getHeader)

    c.set('auth', auth)
    c.set('session', auth.session)
    c.set('effectiveUserId', auth.effectiveUserId)
    c.set('userId', auth.effectiveUserId)
    c.set('user', auth.session.user)

    await next()
  }
}
