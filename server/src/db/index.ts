import { createPgDb, type PgDbOptions } from './pg.js'
import { createPGliteDb } from './pglite.js'
import type { Db } from './types.js'

export type { Db, DbClient, DbQueryResult } from './types.js'
export {
  canonicalDbTarget,
  createDbManager,
  extractPgliteDir,
  isEnvFileWritable,
  resolveEnvFilePath,
  type DbManager,
  type DbManagerMetaInput,
  type DbManagerPublicMeta,
  type DbSwapNextMeta,
  type DbSwapOptions,
  type DbSwapResult,
} from './manager.js'
export { createPgDb, redactUrlSecrets, sanitizePgError, type PgDbOptions } from './pg.js'
export { createPGliteDb } from './pglite.js'

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/

export interface CreateDbOptions {
  pg?: PgDbOptions
}

export function createDb(databaseUrl: string, options?: CreateDbOptions): Db {
  if (typeof databaseUrl !== 'string') {
    throw new Error('Invalid database URL: expected a non-empty string')
  }

  const trimmed = databaseUrl.trim()
  if (!trimmed || CONTROL_CHAR_RE.test(trimmed)) {
    throw new Error(
      'Invalid database URL: must be non-empty and contain no control characters',
    )
  }

  if (trimmed === 'pglite:memory' || trimmed === 'pglite:memory://') {
    return createPGliteDb('memory://')
  }

  if (trimmed.startsWith('pglite:')) {
    const dir = trimmed.slice('pglite:'.length).trim()
    if (!dir) {
      throw new Error('Invalid pglite URL: expected pglite:memory or pglite:<directory>')
    }
    return createPGliteDb(dir)
  }

  if (trimmed.startsWith('postgres://') || trimmed.startsWith('postgresql://')) {
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      throw new Error('Invalid PostgreSQL connection URL format')
    }
    if (!parsed.hostname) {
      throw new Error('Invalid PostgreSQL connection URL: missing hostname')
    }
    return createPgDb(trimmed, options?.pg)
  }

  throw new Error(
    'Unsupported database URL scheme (expected postgres://, postgresql://, pglite:memory, or pglite:<directory>)',
  )
}
