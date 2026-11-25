import type { MiddlewareHandler } from 'hono'
import type { AppConfig } from '../config/schema.js'
import type { Db } from '../db/types.js'
import { setSetting } from '../repo/siteSettings.js'
import { isOriginAllowed } from './origin.js'
import { createHybridAuthAdapter } from './hybrid.js'
import { createLocalAuthAdapter } from './local.js'
import { createNoneAuthAdapter } from './none.js'
import { createTrustedHeaderAuthAdapter } from './trustedHeader.js'
import type { AuthAdapter, HeaderGetter, SyncAuthAdapter } from './types.js'

export * from './types.js'
export { resolveRoles } from './roles.js'
export { createNoneAuthAdapter } from './none.js'
export {
  createTrustedHeaderAuthAdapter,
  resolveTrustedHeaderAuth,
} from './trustedHeader.js'
export { createLocalAuthAdapter } from './local.js'
export { createHybridAuthAdapter } from './hybrid.js'
export * from './password.js'
export * from './sessions.js'

let gatewaySeenGeneration = 1
const gatewaySeenGenByDb = new WeakMap<Db, number>()

export function hasSeenGatewayAuthInMemory(db: Db): boolean {
  return gatewaySeenGenByDb.get(db) === gatewaySeenGeneration
}

export function markGatewayAuthSeen(db: Db): void {
  if (gatewaySeenGenByDb.get(db) === gatewaySeenGeneration) return
  gatewaySeenGenByDb.set(db, gatewaySeenGeneration)
  void setSetting(db, 'gateway_auth_seen', { seen: true }, 'gateway').catch(() => {})
}

export function resetGatewayAuthSeen(db?: Db): void {
  if (db) {
    gatewaySeenGenByDb.delete(db)
  } else {
    gatewaySeenGeneration += 1
  }
}

export function createAuthAdapter(
  config: AppConfig & { authAdapter: 'none' | 'trusted-header' },
): SyncAuthAdapter
export function createAuthAdapter(config: AppConfig, db?: Db): AuthAdapter
export function createAuthAdapter(config: AppConfig, db?: Db): AuthAdapter {
  if (config.authAdapter === 'trusted-header') {
    return createTrustedHeaderAuthAdapter(config)
  }
  if (config.authAdapter === 'local') {
    if (!db) throw new Error('Database is required for local auth adapter')
    return createLocalAuthAdapter(config, db)
  }
  if (config.authAdapter === 'hybrid') {
    if (!db) throw new Error('Database is required for hybrid auth adapter')
    return createHybridAuthAdapter(config, db)
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
 * - c.set('authSource', authResult.authSource)
 * - c.set('authMethod', authResult.authMethod)
 * - c.set('sessionId', authResult.sessionId)
 * - c.set('rememberMe', authResult.rememberMe)
 * - c.set('canAccessAdmin', authResult.canAccessAdmin)
 * - c.set('canAccessAuthor', authResult.canAccessAuthor)
 */
export function createAuthMiddleware(
  config: AppConfig,
  db?: Db,
): MiddlewareHandler {
  const adapter = createAuthAdapter(config, db)

  return async (c, next) => {
    const getHeader: HeaderGetter = (name: string) => c.req.header(name)
    const auth = await adapter.authenticate(getHeader, c.req.url)

    // Enforce Origin / Referer / Sec-Fetch-Site CSRF validation on cookie- and gateway-authenticated
    // mutations and auth session-establishing endpoints (login / bootstrap / passkey login / logout).
    const isAuthMutationRoute = c.req.path.startsWith('/api/auth/')
    if (auth.authSource === 'cookie' || auth.authSource === 'gateway' || isAuthMutationRoute) {
      const method = c.req.method.toUpperCase()
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const secFetchSite = c.req.header('sec-fetch-site')?.trim().toLowerCase()
        if (secFetchSite === 'cross-site') {
          return c.json({ error: 'forbidden', message: 'CSRF cross-site request blocked' }, 403)
        }

        const origin = c.req.header('origin')?.trim()
        const referer = c.req.header('referer')?.trim()
        const headerToCheck = origin !== undefined && origin !== '' ? origin : referer
        if (secFetchSite === 'same-site' && !headerToCheck) {
          return c.json(
            { error: 'forbidden', message: 'CSRF origin required for same-site request' },
            403,
          )
        }
        if (headerToCheck) {
          const valid = isOriginAllowed(
            headerToCheck,
            config,
            c.req.url,
            c.req.header('host'),
            (name) => c.req.header(name),
          )
          if (!valid) {
            return c.json({ error: 'forbidden', message: 'CSRF origin mismatch' }, 403)
          }
        }
      }
    }

    c.set('auth', auth)
    c.set('session', auth.session)
    c.set('effectiveUserId', auth.effectiveUserId)
    c.set('userId', auth.effectiveUserId)
    c.set('user', auth.session.user)
    c.set('authSource', auth.authSource)
    c.set('authMethod', auth.authMethod)
    c.set('sessionId', auth.sessionId)
    c.set('rememberMe', auth.rememberMe)
    c.set('canAccessAdmin', auth.canAccessAdmin)
    c.set('canAccessAuthor', auth.canAccessAuthor)

    if (db && auth.authSource === 'gateway' && config.authAdapter === 'hybrid') {
      markGatewayAuthSeen(db)
    }

    await next()
  }
}
