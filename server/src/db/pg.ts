import { Pool, type PoolClient, type QueryResult } from 'pg'
import type { Db, DbClient, DbQueryResult } from './types.js'

const PG_URL_RE = /postgres(?:ql)?:\/\/[^\s'"]+/gi

const SAFE_PG_ERROR_PROPS = [
  'code',
  'detail',
  'constraint',
  'severity',
  'hint',
  'position',
  'where',
  'schema',
  'table',
  'column',
  'dataType',
  'routine',
] as const

export function redactUrlSecrets(text: string, secretUrl?: string): string {
  let out = text
  if (secretUrl) {
    out = out.split(secretUrl).join('[REDACTED]')
    try {
      const parsed = new URL(secretUrl)
      if (parsed.password) {
        const decoded = decodeURIComponent(parsed.password)
        out = out.split(parsed.password).join('[REDACTED]')
        if (decoded && decoded !== parsed.password) {
          out = out.split(decoded).join('[REDACTED]')
        }
      }
    } catch {
      // Ignore invalid URL during redaction
    }
  }
  return out.replace(PG_URL_RE, '[REDACTED]')
}

export function sanitizePgError(err: unknown, secretUrl: string): Error {
  if (!(err instanceof Error)) {
    return new Error(redactUrlSecrets(String(err), secretUrl))
  }

  const sanitized = new Error(redactUrlSecrets(err.message, secretUrl))
  sanitized.name = err.name || 'DatabaseError'
  if (err.stack) {
    sanitized.stack = redactUrlSecrets(err.stack, secretUrl)
  }

  const srcRecord = err as unknown as Record<string, unknown>
  const dstRecord = sanitized as unknown as Record<string, unknown>
  for (const prop of SAFE_PG_ERROR_PROPS) {
    const val = srcRecord[prop]
    if (typeof val === 'string' || typeof val === 'number') {
      dstRecord[prop] = typeof val === 'string' ? redactUrlSecrets(val, secretUrl) : val
    }
  }

  // Ensure no PoolClient reference survives on the thrown error
  if ('client' in dstRecord) {
    delete dstRecord['client']
  }

  return sanitized
}

function normalizePgResult<T>(res: QueryResult | QueryResult[]): DbQueryResult<T> {
  if (Array.isArray(res)) {
    if (res.length === 0) {
      return { rows: [], rowCount: 0 }
    }
    const last = res[res.length - 1]!
    return {
      rows: last.rows as T[],
      rowCount: last.rowCount ?? 0,
    }
  }

  return {
    rows: res.rows as T[],
    rowCount: res.rowCount ?? 0,
  }
}

export interface PgDbOptions {
  connectionTimeoutMillis?: number
  statementTimeoutMs?: number
}

export function createPgDb(connectionString: string, opts: PgDbOptions = {}): Db {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 10000,
    ...(opts.statementTimeoutMs !== undefined
      ? { statement_timeout: opts.statementTimeoutMs }
      : {}),
  })

  // pg-pool copies options with Object.assign({}, options), leaving connectionString enumerable.
  if (pool.options && Object.prototype.hasOwnProperty.call(pool.options, 'connectionString')) {
    Object.defineProperty(pool.options, 'connectionString', {
      enumerable: false,
      configurable: true,
      writable: true,
      value: pool.options.connectionString,
    })
  }

  pool.on('error', (err: Error) => {
    const clean = sanitizePgError(err, connectionString)
    console.error('Postgres pool idle client error:', clean.message)
  })

  async function runQuery<T = Record<string, unknown>>(
    executor: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    sql: string,
    params?: unknown[],
  ): Promise<DbQueryResult<T>> {
    try {
      const res =
        params !== undefined
          ? await executor.query(sql, params)
          : await executor.query(sql)
      return normalizePgResult<T>(res as QueryResult | QueryResult[])
    } catch (err) {
      throw sanitizePgError(err, connectionString)
    }
  }

  async function runExec(
    executor: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    sql: string,
  ): Promise<void> {
    try {
      await executor.query(sql)
    } catch (err) {
      throw sanitizePgError(err, connectionString)
    }
  }

  function isClientDead(client: PoolClient): boolean {
    const raw = client as unknown as { _ending?: boolean; _queryable?: boolean }
    return Boolean(raw._ending) || raw._queryable === false
  }

  async function runClientTx<R>(
    client: PoolClient,
    fn: (txClient: DbClient) => Promise<R>,
  ): Promise<{ value: R }> {
    const txClient: DbClient = {
      query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
        runQuery<T>(client, sql, params),
      exec: (sql: string) => runExec(client, sql),
    }

    try {
      await client.query('BEGIN')
    } catch (err) {
      const wrapped = sanitizePgError(err, connectionString)
      ;(wrapped as { __txTainted?: boolean }).__txTainted = true
      throw wrapped
    }

    try {
      const value = await fn(txClient)
      const commitRes = await client.query('COMMIT')
      if (commitRes.command === 'ROLLBACK') {
        throw new Error('Transaction aborted and rolled back by PostgreSQL')
      }
      return { value }
    } catch (err) {
      let rollbackFailed = false
      try {
        await client.query('ROLLBACK')
      } catch {
        rollbackFailed = true
      }
      const wrapped = sanitizePgError(err, connectionString)
      if (rollbackFailed || isClientDead(client)) {
        ;(wrapped as { __txTainted?: boolean }).__txTainted = true
      }
      throw wrapped
    }
  }

  const db: Db = {
    kind: 'pg',

    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>> {
      return runQuery<T>(pool, sql, params)
    },

    exec(sql: string): Promise<void> {
      return runExec(pool, sql)
    },

    async tx<R>(fn: (client: DbClient) => Promise<R>): Promise<R> {
      let client: PoolClient
      try {
        client = await pool.connect()
      } catch (err) {
        throw sanitizePgError(err, connectionString)
      }

      let releaseErr = false
      try {
        const res = await runClientTx(client, fn)
        return res.value
      } catch (err) {
        releaseErr =
          Boolean((err as { __txTainted?: boolean }).__txTainted) || isClientDead(client)
        throw err
      } finally {
        client.release(releaseErr ? true : undefined)
      }
    },

    async withSession<R>(fn: (sessionDb: Db) => Promise<R>): Promise<R> {
      let client: PoolClient
      try {
        client = await pool.connect()
      } catch (err) {
        throw sanitizePgError(err, connectionString)
      }

      let sessionTainted = false

      const sessionDb: Db = {
        kind: 'pg',
        query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>> {
          return runQuery<T>(client, sql, params).catch((err) => {
            if (isClientDead(client)) {
              sessionTainted = true
            }
            throw err
          })
        },
        exec(sql: string): Promise<void> {
          return runExec(client, sql).catch((err) => {
            if (isClientDead(client)) {
              sessionTainted = true
            }
            throw err
          })
        },
        async tx<T>(innerFn: (txClient: DbClient) => Promise<T>): Promise<T> {
          try {
            const res = await runClientTx(client, innerFn)
            return res.value
          } catch (err) {
            if (
              Boolean((err as { __txTainted?: boolean }).__txTainted) ||
              isClientDead(client)
            ) {
              sessionTainted = true
            }
            throw err
          }
        },
        async close(): Promise<void> {
          // Owned by the outer withSession() caller.
        },
        async withSession<T>(innerFn: (nestedSession: Db) => Promise<T>): Promise<T> {
          return innerFn(sessionDb)
        },
      }

      try {
        return await fn(sessionDb)
      } finally {
        client.release(sessionTainted || isClientDead(client) ? true : undefined)
      }
    },

    async close(): Promise<void> {
      try {
        await pool.end()
      } catch (err) {
        throw sanitizePgError(err, connectionString)
      }
    },
  }

  return db
}
