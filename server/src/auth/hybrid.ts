import type { AppConfig } from '../config/schema.js'
import type { Db } from '../db/types.js'
import { createLocalAuthAdapter } from './local.js'
import { resolveTrustedHeaderAuth } from './trustedHeader.js'
import type { AsyncAuthAdapter, AuthResult, HeaderGetter } from './types.js'

export function createHybridAuthAdapter(config: AppConfig, db: Db): AsyncAuthAdapter {
  const localAdapter = createLocalAuthAdapter(config, db)

  return {
    async authenticate(getHeader: HeaderGetter, reqUrl?: string): Promise<AuthResult> {
      // 1. Evaluate trustedHeader FIRST (e.g. Authelia Remote-User + Remote-Groups)
      const trusted = resolveTrustedHeaderAuth(getHeader, config)
      if (trusted.session.authenticated && trusted.effectiveUserId) {
        return trusted
      }

      // 2. Fall through to local cookie session
      return localAdapter.authenticate(getHeader, reqUrl)
    },
  }
}
