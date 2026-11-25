import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv, updateEnvText } from '../config/env.js'
import { redactUrlSecrets } from './pg.js'
import type { Db, DbClient, DbQueryResult } from './types.js'

const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env')
const DRAIN_TIMEOUT_MS = 5000

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

function formatBackupTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const h = pad(date.getHours())
  const min = pad(date.getMinutes())
  const s = pad(date.getSeconds())
  const suffix = randomBytes(3).toString('hex')
  return `${y}${m}${d}-${h}${min}${s}-${suffix}`
}

export function resolveEnvFilePath(
  customEnv?: Record<string, string | undefined>,
): string | null {
  const explicit =
    customEnv?.LECTURE_ENV_FILE?.trim() ?? process.env.LECTURE_ENV_FILE?.trim()
  if (explicit) {
    return resolve(explicit)
  }

  if (existsSync(DEFAULT_ENV_FILE)) {
    return DEFAULT_ENV_FILE
  }

  const cwdEnv = resolve(process.cwd(), '.env')
  if (existsSync(cwdEnv)) {
    return cwdEnv
  }

  const parentEnv = resolve(process.cwd(), '../.env')
  if (existsSync(parentEnv)) {
    return parentEnv
  }

  return null
}

function normalizeFilesystemPath(dir: string): string {
  let abs = resolve(dir)
  try {
    if (existsSync(abs)) {
      abs = realpathSync(abs)
    }
  } catch {
    // Keep resolve path when realpath fails
  }
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

export function extractPgliteDir(databaseUrl: string): string | null {
  const trimmed = databaseUrl.trim()
  if (!trimmed.startsWith('pglite:')) {
    return null
  }
  const rest = trimmed.slice('pglite:'.length).trim()
  if (!rest) return null
  if (rest === 'memory' || rest === 'memory://') {
    return 'memory'
  }
  return resolve(rest)
}

export function canonicalDbTarget(databaseUrl: string): string {
  const trimmed = databaseUrl.trim()
  if (trimmed === 'pglite:memory' || trimmed === 'pglite:memory://') {
    return 'pglite:memory://'
  }
  if (trimmed.startsWith('pglite:')) {
    const dir = trimmed.slice('pglite:'.length).trim()
    return `pglite:${normalizeFilesystemPath(dir)}`
  }
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'postgres:') {
      parsed.protocol = 'postgresql:'
    }
    if (parsed.port === '5432') {
      parsed.port = ''
    }
    parsed.hostname = parsed.hostname.toLowerCase()
    return parsed.toString()
  } catch {
    return trimmed
  }
}

export function isEnvFileWritable(envFilePath: string | null): boolean {
  if (!envFilePath) return false
  try {
    if (!existsSync(envFilePath)) {
      return false
    }
    accessSync(envFilePath, constants.R_OK | constants.W_OK)
    accessSync(dirname(envFilePath), constants.W_OK)
    return true
  } catch {
    return false
  }
}

export interface DbManagerMetaInput {
  databaseUrl: string
  databaseUrlDirect?: string | null
  envFilePath?: string | null
}

export interface DbManagerPublicMeta {
  kind: 'pg' | 'pglite'
  databaseUrlRedacted: string
  databaseUrlDirectRedacted: string | null
  pgliteDir: string | null
  envFilePath: string | null
  envWritable: boolean
}

export interface DbSwapNextMeta {
  databaseUrl: string
  databaseUrlDirect?: string | null
}

export interface DbSwapOptions {
  updateEnv?: boolean
}

export interface DbSwapResult {
  previousKind: 'pg' | 'pglite'
  currentKind: 'pg' | 'pglite'
  envUpdated: boolean
  backupPath: string | null
}

export interface DbManager {
  asDb(): Db
  getMeta(): DbManagerPublicMeta
  getCurrentUrl(): string
  getCurrentDirectUrl(): string | null
  runWithRequestDb?<T>(fn: () => Promise<T>): Promise<T>
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
  swapTo(
    nextDb: Db,
    nextMeta: DbSwapNextMeta,
    options?: DbSwapOptions,
  ): Promise<DbSwapResult>
  onSwap?(listener: () => void | Promise<void>): () => void
  close(): Promise<void>
}

export function createDbManager(
  initialDb: Db,
  initialMeta: DbManagerMetaInput,
): DbManager {
  let currentDb: Db = initialDb
  let currentDatabaseUrl: string = initialMeta.databaseUrl
  let currentDatabaseUrlDirect: string | null = initialMeta.databaseUrlDirect ?? null
  const envFilePath: string | null = initialMeta.envFilePath ?? null
  const swapMutex = new AsyncMutex()
  const operationMutex = new AsyncMutex()
  const swapListeners = new Set<() => void | Promise<void>>()

  interface RequestPin {
    db: Db
    released: boolean
    activeInTracker: boolean
  }

  const requestStore = new AsyncLocalStorage<RequestPin>()
  const inflight = new WeakMap<Db, { count: number; waiters: Array<() => void> }>()

  function getTracker(db: Db): { count: number; waiters: Array<() => void> } {
    let t = inflight.get(db)
    if (!t) {
      t = { count: 0, waiters: [] }
      inflight.set(db, t)
    }
    return t
  }

  function decrementTracker(tracker: { count: number; waiters: Array<() => void> }): void {
    tracker.count = Math.max(0, tracker.count - 1)
    if (tracker.count === 0 && tracker.waiters.length > 0) {
      const waiters = tracker.waiters.splice(0, tracker.waiters.length)
      for (const wake of waiters) wake()
    }
  }

  function acquirePinTracker(pin: RequestPin): void {
    if (!pin.activeInTracker && !pin.released) {
      pin.activeInTracker = true
      getTracker(pin.db).count++
    }
  }

  function releasePinTracker(pin: RequestPin): void {
    if (pin.activeInTracker) {
      pin.activeInTracker = false
      decrementTracker(getTracker(pin.db))
    }
  }

  function resolveTargetDb(): Db {
    const pin = requestStore.getStore()
    if (pin && !pin.released) {
      return pin.db
    }
    return currentDb
  }

  async function trackOperation<T>(db: Db, fn: () => Promise<T>): Promise<T> {
    const tracker = getTracker(db)
    tracker.count++
    try {
      return await fn()
    } finally {
      decrementTracker(tracker)
    }
  }

  async function drainDb(db: Db, timeoutMs: number): Promise<void> {
    const tracker = getTracker(db)
    if (tracker.count === 0) return
    await Promise.race([
      new Promise<void>((resolveWait) => {
        tracker.waiters.push(resolveWait)
      }),
      new Promise<void>((resolveTimer) => {
        const timer = setTimeout(resolveTimer, timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ])
  }

  const proxyDb: Db = {
    get kind(): 'pg' | 'pglite' {
      return resolveTargetDb().kind
    },
    query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<DbQueryResult<T>> {
      const target = resolveTargetDb()
      return trackOperation(target, () => target.query<T>(sql, params))
    },
    exec(sql: string): Promise<void> {
      const target = resolveTargetDb()
      return trackOperation(target, () => target.exec(sql))
    },
    tx<R>(fn: (client: DbClient) => Promise<R>): Promise<R> {
      const target = resolveTargetDb()
      return trackOperation(target, () => target.tx(fn))
    },
    close(): Promise<void> {
      return currentDb.close()
    },
    withSession<R>(fn: (sessionDb: Db) => Promise<R>): Promise<R> {
      const target = resolveTargetDb()
      return trackOperation(target, () => {
        if (target.withSession) {
          return target.withSession(fn)
        }
        // Snapshot wrapper pinning the current concrete DB with an intentional no-op close()
        const pinnedSessionDb: Db = {
          kind: target.kind,
          query: (s, p) => target.query(s, p),
          exec: (s) => target.exec(s),
          tx: (innerFn) => target.tx(innerFn),
          close: async () => {},
        }
        return fn(pinnedSessionDb)
      })
    },
  }

  function persistEnvUpdate(nextMeta: DbSwapNextMeta): {
    envUpdated: boolean
    backupPath: string | null
  } {
    if (!envFilePath || !existsSync(envFilePath)) {
      return { envUpdated: false, backupPath: null }
    }

    let tmpPath: string | null = null
    try {
      accessSync(envFilePath, constants.R_OK | constants.W_OK)
      accessSync(dirname(envFilePath), constants.W_OK)

      const existingStat = statSync(envFilePath)
      const ownerMode = (existingStat.mode & 0o600) || 0o600
      const existingText = readFileSync(envFilePath, 'utf8')

      const updates: Record<string, string> = {
        DATABASE_URL: nextMeta.databaseUrl,
      }

      if (nextMeta.databaseUrlDirect !== undefined) {
        if (nextMeta.databaseUrlDirect && nextMeta.databaseUrlDirect.trim() !== '') {
          updates.DATABASE_URL_DIRECT = nextMeta.databaseUrlDirect.trim()
        } else {
          const parsed = parseEnv(existingText)
          if (Object.hasOwn(parsed, 'DATABASE_URL_DIRECT')) {
            updates.DATABASE_URL_DIRECT = ''
          }
        }
      }

      // Compute updated content BEFORE writing backup so failed parses leave no orphan backup
      const updatedText = updateEnvText(existingText, updates)

      const backupPath = `${envFilePath}.bak-${formatBackupTimestamp()}`
      writeFileSync(backupPath, existingText, { encoding: 'utf8', mode: ownerMode })
      try {
        chmodSync(backupPath, ownerMode)
      } catch {
        // Ignore chmod failure on unsupported filesystems
      }
      if (existingText.length > 0 && statSync(backupPath).size === 0) {
        throw new Error('Failed to verify non-empty .env backup file')
      }

      tmpPath = `${envFilePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
      writeFileSync(tmpPath, updatedText, { encoding: 'utf8', mode: ownerMode })
      try {
        chmodSync(tmpPath, ownerMode)
      } catch {
        // Ignore chmod failure
      }
      renameSync(tmpPath, envFilePath)
      tmpPath = null
      try {
        chmodSync(envFilePath, ownerMode)
      } catch {
        // Ignore chmod failure
      }

      return { envUpdated: true, backupPath }
    } catch {
      if (tmpPath) {
        try {
          rmSync(tmpPath, { force: true })
        } catch {
          // Ignore cleanup errors
        }
      }
      return { envUpdated: false, backupPath: null }
    }
  }

  return {
    asDb(): Db {
      return proxyDb
    },

    getMeta(): DbManagerPublicMeta {
      const databaseUrlRedacted = redactUrlSecrets(
        currentDatabaseUrl,
        currentDatabaseUrl,
      )
      const databaseUrlDirectRedacted = currentDatabaseUrlDirect
        ? redactUrlSecrets(currentDatabaseUrlDirect, currentDatabaseUrlDirect)
        : null
      return {
        kind: currentDb.kind,
        databaseUrlRedacted,
        databaseUrlDirectRedacted,
        pgliteDir: extractPgliteDir(currentDatabaseUrl),
        envFilePath,
        envWritable: isEnvFileWritable(envFilePath),
      }
    },

    getCurrentUrl(): string {
      return currentDatabaseUrl
    },

    getCurrentDirectUrl(): string | null {
      return currentDatabaseUrlDirect
    },

    async runWithRequestDb<T>(fn: () => Promise<T>): Promise<T> {
      const existing = requestStore.getStore()
      if (existing && !existing.released) {
        return fn()
      }
      const pin: RequestPin = {
        db: currentDb,
        released: false,
        activeInTracker: false,
      }
      acquirePinTracker(pin)
      try {
        return await requestStore.run(pin, fn)
      } finally {
        pin.released = true
        releasePinTracker(pin)
      }
    },

    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      const pin = requestStore.getStore()
      if (pin && !pin.released) {
        releasePinTracker(pin)
        return operationMutex.run(async () => {
          if (!pin.released && pin.db === currentDb) {
            acquirePinTracker(pin)
          }
          return await fn()
        })
      }
      return operationMutex.run(fn)
    },

    async swapTo(
      nextDb: Db,
      nextMeta: DbSwapNextMeta,
      options?: DbSwapOptions,
    ): Promise<DbSwapResult> {
      if (nextDb.kind !== 'pg' && nextDb.kind !== 'pglite') {
        throw new Error(`Unsupported Db kind: ${String(nextDb.kind)}`)
      }

      return swapMutex.run(async () => {
        const previousDb = currentDb
        const previousKind = previousDb.kind
        const callerPin = requestStore.getStore()
        if (callerPin && !callerPin.released && callerPin.db === previousDb) {
          callerPin.released = true
          releasePinTracker(callerPin)
        }

        currentDb = nextDb
        currentDatabaseUrl = nextMeta.databaseUrl
        currentDatabaseUrlDirect = nextMeta.databaseUrlDirect ?? null

        if (previousDb !== nextDb) {
          await drainDb(previousDb, DRAIN_TIMEOUT_MS)
          await previousDb.close().catch(() => {})
        }

        let envUpdated = false
        let backupPath: string | null = null
        if (options?.updateEnv !== false) {
          const persisted = persistEnvUpdate(nextMeta)
          envUpdated = persisted.envUpdated
          backupPath = persisted.backupPath
        }

        for (const listener of swapListeners) {
          try {
            await listener()
          } catch {
            // Keep DB swap deterministic even if cache listener fails
          }
        }

        return {
          previousKind,
          currentKind: nextDb.kind,
          envUpdated,
          backupPath,
        }
      })
    },

    onSwap(listener: () => void | Promise<void>): () => void {
      swapListeners.add(listener)
      return () => {
        swapListeners.delete(listener)
      }
    },

    async close(): Promise<void> {
      await swapMutex.run(async () => {
        await drainDb(currentDb, DRAIN_TIMEOUT_MS)
        await currentDb.close()
      })
    },
  }
}
