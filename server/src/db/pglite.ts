import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite, type Results, type Transaction } from '@electric-sql/pglite'
import type { Db, DbClient, DbQueryResult } from './types.js'

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

export function hasMultipleSqlStatements(sql: string): boolean {
  let statementCount = 0
  let hasTokenInCurrent = false
  let i = 0
  const len = sql.length

  while (i < len) {
    const ch = sql[i]!
    const next = sql[i + 1]

    // Line comment: -- ...
    if (ch === '-' && next === '-') {
      i += 2
      while (i < len && sql[i] !== '\n') i++
      continue
    }

    // Block comment: /* ... */ (supports PostgreSQL nested block comments)
    if (ch === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < len && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else {
          i++
        }
      }
      continue
    }

    // Single-quoted string: '...'
    if (ch === "'") {
      hasTokenInCurrent = true
      i++
      while (i < len) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }

    // Double-quoted identifier: "..."
    if (ch === '"') {
      hasTokenInCurrent = true
      i++
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }

    // Dollar-quoted string: $tag$...$tag$
    if (ch === '$') {
      const rest = sql.slice(i)
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)
      if (tagMatch) {
        const tag = tagMatch[0]
        hasTokenInCurrent = true
        const endIdx = sql.indexOf(tag, i + tag.length)
        if (endIdx === -1) {
          i = len
        } else {
          i = endIdx + tag.length
        }
        continue
      }
    }

    if (ch === ';') {
      if (hasTokenInCurrent) {
        statementCount++
        if (statementCount > 1) return true
        hasTokenInCurrent = false
      }
      i++
      continue
    }

    if (!/\s/.test(ch)) {
      hasTokenInCurrent = true
      if (statementCount >= 1) {
        return true
      }
    }

    i++
  }

  return false
}

function normalizePGliteResult<T>(res: Results<T>): DbQueryResult<T> {
  return {
    rows: res.rows,
    rowCount: res.rowCount ?? res.affectedRows ?? 0,
  }
}

function normalizeExecResults<T>(results: Array<Results<unknown>>): DbQueryResult<T> {
  if (results.length === 0) {
    return { rows: [], rowCount: 0 }
  }
  const last = results[results.length - 1]! as Results<T>
  return normalizePGliteResult<T>(last)
}

const txStorage = new AsyncLocalStorage<symbol>()

export function createPGliteDb(target: string): Db {
  let dataDir: string
  if (target === 'memory' || target === 'memory://') {
    dataDir = 'memory://'
  } else {
    const resolvedDir = resolve(target)
    // PGlite NodeFS calls mkdirSync without { recursive: true }.
    mkdirSync(resolvedDir, { recursive: true })
    dataDir = resolvedDir
  }

  const pglite = new PGlite(dataDir)
  pglite.waitReady.catch(() => {})

  const mutex = new AsyncMutex()
  const instanceToken = Symbol('pglite-tx')
  let closed = false

  function assertNotReentrant(): void {
    if (txStorage.getStore() === instanceToken) {
      throw new Error(
        'Re-entrant call on PGliteDb inside tx(); use the transaction client passed to tx() instead.',
      )
    }
  }

  async function executeQuery<T>(
    executor: Pick<PGlite, 'query' | 'exec'> | Pick<Transaction, 'query' | 'exec'>,
    sql: string,
    params?: unknown[],
  ): Promise<DbQueryResult<T>> {
    if ((!params || params.length === 0) && hasMultipleSqlStatements(sql)) {
      const results = await executor.exec(sql)
      return normalizeExecResults<T>(results)
    }
    const res = await executor.query<T>(sql, params)
    return normalizePGliteResult<T>(res)
  }

  return {
    kind: 'pglite',

    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<DbQueryResult<T>> {
      assertNotReentrant()
      return mutex.run(async () => {
        if (closed) {
          throw new Error('PGlite database is closed')
        }
        await pglite.waitReady
        return executeQuery<T>(pglite, sql, params)
      })
    },

    async exec(sql: string): Promise<void> {
      assertNotReentrant()
      return mutex.run(async () => {
        if (closed) {
          throw new Error('PGlite database is closed')
        }
        await pglite.waitReady
        await pglite.exec(sql)
      })
    },

    async tx<R>(fn: (client: DbClient) => Promise<R>): Promise<R> {
      assertNotReentrant()
      return mutex.run(async () => {
        if (closed) {
          throw new Error('PGlite database is closed')
        }
        await pglite.waitReady
        return txStorage.run(instanceToken, () =>
          pglite.transaction(async (tx) => {
            const txClient: DbClient = {
              query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
                executeQuery<T>(tx, sql, params),
              exec: async (sql: string) => {
                await tx.exec(sql)
              },
            }
            return fn(txClient)
          }),
        )
      })
    },

    async close(): Promise<void> {
      assertNotReentrant()
      return mutex.run(async () => {
        if (closed) return
        closed = true
        await pglite.waitReady.catch(() => {})
        await pglite.close()
      })
    },
  }
}
