/**
 * progress/progressStore.ts — the single source of truth for lecture progress (plan_v2_p3 §3.3).
 *
 *   createProgressStore(deps)   the store; every collaborator is injectable (backend, storage, clock, locks,
 *                               scheduler, session, seed), so tests need no real network, timers or browser.
 *   progressStore               the site singleton, wired to the configured backend and the lazily loaded seed.
 *   configureProgress(theme)    point the singleton at `themeConfig.lectureModules` (call before `load()`).
 *
 * Read rule:  statusOf(id) = newest pending write ?? server record ?? seed ?? 'not_started'.
 * Writes:     optimistic, queued in an outbox that survives reloads, sent by one tab at a time (Web Locks),
 *             retried with backoff, refused writes roll back and raise a `rejected` event.
 * Load:       local state -> session (identity switch clears) -> seed -> V1 import -> fetch all + arbitration
 *             (API_CONTRACT.md §2.5) -> send what is pending.
 *
 * SSR-safe (nothing touches `window` at import time) and the public methods never throw.
 */
import { API_ENDPOINTS, STORAGE_KEYS } from '../../site.config.mts'
import { createLocalBackend, createRestBackend } from '../api/progress'
import type { ProgressBackend, SendError } from '../api/progress'
import { configureSession, getSession, subscribeSession } from '../auth/session'
import type { SessionState } from '../auth/session'
import { registerDebugPanel } from '../debug/registry'
import { EMPTY_SEED, seedIndex } from './seed'
import type { SeedData } from './seed'
import { groupOfDir, groupOfLecture, isProgressStatus, normaliseLectureId } from './types'
import type { OutboxOp, ProgressEvent, ProgressListener, ProgressRecord, ProgressStatus, SyncState } from './types'
import { planV1Migration, readV1Progress } from './v1Migration'

// ---------------------------------------------------------------------------------------------------
// public types
// ---------------------------------------------------------------------------------------------------

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

/** The part of `navigator.locks` the store uses. */
export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface ProgressStoreDeps {
  backend: ProgressBackend
  /** Who is reading. Default: no session (identity rules do not apply). */
  getSession?: () => Promise<SessionState>
  /** Session change listener. Default: none. */
  subscribeSession?: (listener: (session: SessionState) => void) => () => void
  /** The seed (build-time knowledge-graph statuses). Default: empty. */
  loadSeed?: () => Promise<SeedData>
  /** `undefined`: the browser's localStorage when there is one; `null`: keep everything in memory. */
  storage?: KeyValueStorage | null
  now?: () => number
  /** `undefined`: `navigator.locks` when there is one; `null`: no cross-tab lock. */
  locks?: LockManagerLike | null
  scheduler?: Scheduler
  newId?: () => string
  /** Where `online`, `visibilitychange` and `storage` events come from. `undefined`: `window`; `null`: none. */
  target?: EventTarget | null
  isVisible?: () => boolean
  /** Persistence key (default `STORAGE_KEYS.progressV2`). */
  storageKey?: string
}

export interface ProgressWrite {
  lectureId: string
  status: ProgressStatus
  groupId?: string
}

export interface ProgressMeta {
  notionNodeId: string | null
  notionPageId: string | null
}

export interface ProgressSnapshot {
  ready: boolean
  backend: 'local' | 'rest'
  owner: string | null
  seedVersion: string | null
  counts: { server: number; seed: number; outbox: number }
  outbox: OutboxOp[]
  skewMs: number
  /** null until the first fetch finished; false when the backend could only be read group by group. */
  unfilteredGet: boolean | null
  syncState: SyncState
  /** Recent decisions worth knowing when debugging (identity switches, dropped operations, ...). */
  log: string[]
}

export interface ProgressStore {
  /** Load once per page (idempotent: later calls return the same promise). Never rejects. */
  load(): Promise<void>
  /** Run the load again (identity change, debugging). */
  reload(): Promise<void>
  isReady(): boolean
  statusOf(lectureId: string): ProgressStatus
  metaOf(lectureId: string): ProgressMeta
  /**
   * When the lecture was completed (ISO string), for display. The newest pending write decides first (its own time
   * when it is `completed`, otherwise null); then the server record, then the seed; null when unknown.
   */
  completedAtOf(lectureId: string): string | null
  countCompleted(lectureIds: Iterable<string>): number
  set(lectureId: string, status: ProgressStatus, options?: { groupId?: string }): void
  setMany(items: readonly ProgressWrite[]): void
  subscribe(listener: ProgressListener): () => void
  /** Notified whenever `syncState()` or `pending()` may have changed. */
  subscribeSync(listener: () => void): () => void
  syncState(): SyncState
  pending(): number
  /** Send now. `force` ignores the retry schedule (online / visible / debug). */
  flush(options?: { force?: boolean }): Promise<void>
  /**
   * Add seed records that arrived after the first load (the readable tiers' lectures, P3b). Only a lecture that has
   * neither a server record nor a pending write, and no seed record yet, is seeded; a `reset` event follows when
   * something was added. Safe to call before `load()` finished: the records are kept and applied when the seed is read.
   */
  extendSeed(extra: SeedData): void
  /** Forget all persisted state (owner, server records, outbox, migration flag). */
  reset(): void
  snapshot(): ProgressSnapshot
  /** Remove listeners and timers (tests, HMR). */
  destroy(): void
}

// ---------------------------------------------------------------------------------------------------
// persisted state
// ---------------------------------------------------------------------------------------------------

export const OUTBOX_LOCK_NAME = 'tut:v2:progress-outbox'
/** Delay before retry n (n = attempts so far, 1-based); the last value repeats. */
export const BACKOFF_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000]

export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1
  return BACKOFF_MS[i] as number
}

type Dict<T> = Record<string, T>
function dict<T>(): Dict<T> {
  return Object.create(null) as Dict<T>
}

interface PersistedState {
  schema: 1
  owner: string | null
  server: Dict<ProgressRecord>
  outbox: OutboxOp[]
  seedVersion: string | null
  migratedV1: boolean
  skewMs: number
}

function emptyState(): PersistedState {
  return { schema: 1, owner: null, server: dict(), outbox: [], seedVersion: null, migratedV1: false, skewMs: 0 }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

function isProgressRecord(v: unknown): v is ProgressRecord {
  return (
    isObject(v) &&
    typeof v.lectureId === 'string' &&
    v.lectureId !== '' &&
    typeof v.groupId === 'string' &&
    isProgressStatus(v.status) &&
    isStringOrNull(v.completedAt) &&
    isStringOrNull(v.updatedAt) &&
    isStringOrNull(v.notionNodeId) &&
    isStringOrNull(v.notionPageId)
  )
}

function isOutboxOp(v: unknown): v is OutboxOp {
  return (
    isObject(v) &&
    typeof v.id === 'string' &&
    typeof v.lectureId === 'string' &&
    v.lectureId !== '' &&
    typeof v.groupId === 'string' &&
    isProgressStatus(v.status) &&
    typeof v.at === 'number' &&
    typeof v.attempts === 'number' &&
    typeof v.nextAt === 'number'
  )
}

/** null = the value is not a state this version understands (corrupt or from a newer schema). */
export function parsePersistedState(raw: string): PersistedState | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(v) || v.schema !== 1) return null
  if (!isStringOrNull(v.owner) || !isObject(v.server) || !Array.isArray(v.outbox)) return null
  const server = dict<ProgressRecord>()
  for (const rec of Object.values(v.server)) if (isProgressRecord(rec)) server[rec.lectureId] = rec
  return {
    schema: 1,
    owner: v.owner,
    server,
    outbox: v.outbox.filter(isOutboxOp),
    seedVersion: typeof v.seedVersion === 'string' ? v.seedVersion : null,
    migratedV1: v.migratedV1 === true,
    skewMs: typeof v.skewMs === 'number' && Number.isFinite(v.skewMs) ? v.skewMs : 0,
  }
}

// ---------------------------------------------------------------------------------------------------
// environment defaults (all lazy: nothing here runs at import time)
// ---------------------------------------------------------------------------------------------------

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

function browserLocks(): LockManagerLike | null {
  try {
    if (typeof navigator === 'undefined' || !navigator.locks) return null
    const locks = navigator.locks
    return { request: <T>(name: string, callback: () => Promise<T>): Promise<T> => locks.request(name, callback) as Promise<T> }
  } catch {
    return null
  }
}

const defaultScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

let idSeq = 0
function defaultNewId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // fall through
  }
  const rand = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')
  return `${rand()}-${rand().slice(0, 4)}-${Date.now().toString(16)}-${(idSeq++).toString(16)}`
}

function defaultIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

// ---------------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------------

const LOG_LIMIT = 50

export function createProgressStore(deps: ProgressStoreDeps): ProgressStore {
  const now = deps.now ?? Date.now
  const key = deps.storageKey ?? STORAGE_KEYS.progressV2
  const newId = deps.newId ?? defaultNewId
  const scheduler = deps.scheduler ?? defaultScheduler
  const isVisible = deps.isVisible ?? defaultIsVisible
  const storage = (): KeyValueStorage | null => (storageBroken ? null : deps.storage === undefined ? browserStorage() : deps.storage)
  const locks = (): LockManagerLike | null => (deps.locks === undefined ? browserLocks() : deps.locks)

  let state = emptyState()
  let lastRaw: string | null = null
  /** Persisting failed once (quota, private mode): from then on the state lives in memory only. */
  let storageBroken = false
  let seed: Map<string, ProgressRecord> = new Map()
  let baseSeedData: SeedData | null = null
  /** Records given to `extendSeed`; they survive a reload of the build seed and are re-applied after it. */
  const extraSeed = new Map<string, ProgressRecord>()
  let ready = false
  let initialized = false
  let bootAwaitingSession = false
  let latestSubSeq = 0
  let latestSubSession: SessionState | null = null
  let establishedIdentity = 'none'
  let epoch = 0
  let loadSeq = 0
  let flushToken = 0
  const activeControllers = new Set<AbortController>()
  let sync: SyncState = 'idle'
  let unfilteredGet: boolean | null = null
  let loading: Promise<void> | null = null
  let flushing: Promise<void> | null = null
  let flushAgain = false
  let flushForce = false
  let timer: unknown = null
  let detach: (() => void) | null = null
  const inflight = new Set<string>()
  const listeners = new Set<ProgressListener>()
  const syncListeners = new Set<() => void>()
  const log: string[] = []

  function identityKeyOf(s: SessionState): string {
    if (s.status === 'authenticated') return `user:${s.user.id}`
    if (s.status === 'anonymous' && s.source === 'server') return 'anon'
    return 'none'
  }

  function invalidatePendingWork(opts?: { clearLoading?: boolean }): void {
    epoch++
    flushToken++
    for (const ac of activeControllers) {
      try {
        ac.abort()
      } catch {
        // ignore
      }
    }
    activeControllers.clear()
    if (timer !== null) {
      scheduler.clear(timer)
      timer = null
    }
    inflight.clear()
    flushing = null
    flushAgain = false
    flushForce = false
    sync = 'idle'
    if (opts?.clearLoading) {
      loading = null
    }
  }

  const note = (message: string): void => {
    log.push(`${new Date(now()).toISOString()} ${message}`)
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT)
  }

  const emit = (event: ProgressEvent): void => {
    for (const l of [...listeners]) {
      try {
        l(event)
      } catch {
        // one broken listener must not stop the others
      }
    }
  }
  const notifySync = (): void => {
    for (const l of [...syncListeners]) {
      try {
        l()
      } catch {
        // see emit
      }
    }
  }

  // ---- persistence ------------------------------------------------------------------------------

  function readPersisted(): PersistedState {
    const s = storage()
    if (!s) return state
    let raw: string | null
    try {
      raw = s.getItem(key)
    } catch {
      return emptyState()
    }
    lastRaw = raw
    return adopt(s, raw)
  }

  /** Parse a stored value; a value this version does not understand is copied to `<key>:corrupt` before it is dropped. */
  function adopt(s: KeyValueStorage, raw: string | null): PersistedState {
    if (raw === null) return emptyState()
    const parsed = parsePersistedState(raw)
    if (parsed) return parsed
    try {
      s.setItem(`${key}:corrupt`, raw)
    } catch {
      // nothing more to do
    }
    note(`stored state not understood; copy kept under ${key}:corrupt, starting empty`)
    return emptyState()
  }

  function persist(): void {
    const s = storage()
    if (!s) return
    try {
      const raw = JSON.stringify(state)
      s.setItem(key, raw)
      lastRaw = raw
    } catch {
      storageBroken = true
      note('could not write to storage; progress is kept in memory only')
    }
  }

  /** Adopt what another tab wrote since we last looked. True when the state changed. */
  function refresh(): boolean {
    const s = storage()
    if (!s) return false
    let raw: string | null
    try {
      raw = s.getItem(key)
    } catch {
      return false
    }
    if (raw === lastRaw) return false
    lastRaw = raw
    state = adopt(s, raw)
    return true
  }

  // ---- reading ----------------------------------------------------------------------------------

  const latestOp = (id: string): OutboxOp | undefined => {
    for (let i = state.outbox.length - 1; i >= 0; i--) {
      const op = state.outbox[i] as OutboxOp
      if (op.lectureId === id) return op
    }
    return undefined
  }

  function statusOf(lectureId: string): ProgressStatus {
    const id = normaliseLectureId(String(lectureId ?? ''))
    return latestOp(id)?.status ?? state.server[id]?.status ?? seed.get(id)?.status ?? 'not_started'
  }

  function metaOf(lectureId: string): ProgressMeta {
    const id = normaliseLectureId(String(lectureId ?? ''))
    const server = state.server[id]
    const fromSeed = seed.get(id)
    return {
      notionNodeId: server?.notionNodeId ?? fromSeed?.notionNodeId ?? null,
      notionPageId: server?.notionPageId ?? fromSeed?.notionPageId ?? null,
    }
  }

  function completedAtOf(lectureId: string): string | null {
    const id = normaliseLectureId(String(lectureId ?? ''))
    const op = latestOp(id)
    if (op) return op.status === 'completed' ? new Date(op.at).toISOString() : null
    // a server record decides even when its completedAt is null (e.g. moved back to in progress): never fall
    // through to the seed's older completion time then
    const server = state.server[id]
    if (server) return server.status === 'completed' ? server.completedAt : null
    const fromSeed = seed.get(id)
    return fromSeed?.status === 'completed' ? fromSeed.completedAt : null
  }

  /** Seed the lectures of `extraSeed` that nothing else knows (no server record, no pending write, no seed record). True when one was added. */
  function applyExtraSeed(): boolean {
    let added = false
    for (const [id, rec] of extraSeed) {
      if (seed.has(id) || state.server[id] || latestOp(id)) continue
      seed.set(id, rec)
      added = true
    }
    return added
  }

  function extendSeed(extra: SeedData): void {
    for (const rec of extra.records) extraSeed.set(rec.lectureId, rec)
    if (applyExtraSeed()) emit({ kind: 'reset' })
  }

  // ---- writing ----------------------------------------------------------------------------------

  function setMany(items: readonly ProgressWrite[]): void {
    try {
      if (items.length === 0) return
      if (refresh()) emit({ kind: 'reset' })
      const at = now()
      const changed = new Set<string>()
      for (const item of items) {
        const id = normaliseLectureId(String(item.lectureId ?? ''))
        if (!id || !isProgressStatus(item.status)) continue
        const groupId = item.groupId
          ? groupOfDir(item.groupId)
          : (state.server[id]?.groupId ?? seed.get(id)?.groupId ?? groupOfLecture(id))
        const before = statusOf(id)
        // a newer write replaces the ones not sent yet; the one being sent stays
        state.outbox = state.outbox.filter((op) => op.lectureId !== id || inflight.has(op.id))
        if (item.status === statusOf(id)) {
          if (before !== item.status) changed.add(id)
          continue
        }
        state.outbox.push({ id: newId(), lectureId: id, groupId, status: item.status, at, attempts: 0, nextAt: at })
        changed.add(id)
      }
      if (changed.size === 0) return
      persist()
      emit({ kind: 'change', ids: [...changed], origin: 'user' })
      notifySync()
      void flush()
    } catch (err) {
      note(`set failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function set(lectureId: string, status: ProgressStatus, options?: { groupId?: string }): void {
    setMany([{ lectureId, status, ...(options?.groupId ? { groupId: options.groupId } : {}) }])
  }

  // ---- sending ----------------------------------------------------------------------------------

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const manager = locks()
    if (!manager) return fn()
    let ran = false
    try {
      return await manager.request(OUTBOX_LOCK_NAME, () => {
        ran = true
        return fn()
      })
    } catch (err) {
      if (ran) throw err
      return fn() // the lock itself is unavailable (insecure context, ...): send without it
    }
  }

  function applySkew(serverDate: number | null): void {
    if (serverDate !== null) state.skewMs = serverDate - now()
  }

  function scheduleRetry(): void {
    if (timer !== null) {
      scheduler.clear(timer)
      timer = null
    }
    let next = Number.POSITIVE_INFINITY
    for (const op of state.outbox) if (!inflight.has(op.id) && op.nextAt < next) next = op.nextAt
    if (next === Number.POSITIVE_INFINITY) return
    timer = scheduler.set(() => {
      timer = null
      void flush()
    }, Math.max(0, next - now()))
  }

  function settleSyncState(failure: SendError | null): void {
    if (state.outbox.length === 0) sync = 'idle'
    else if (failure) sync = failure.status === undefined ? 'offline' : 'retrying'
    else if (sync === 'sending') sync = 'idle'
    notifySync()
  }

  async function sendDue(force: boolean, myFlushToken: number, myEpoch: number): Promise<void> {
    if (epoch !== myEpoch || flushToken !== myFlushToken) return
    if (refresh()) emit({ kind: 'reset' })
    // only the newest operation of a lecture matters; older unsent ones are superseded
    const newest = new Map<string, OutboxOp>()
    for (const op of state.outbox) if (!inflight.has(op.id)) newest.set(op.lectureId, op)
    const keep = new Set([...newest.values()].map((op) => op.id))
    const before = state.outbox.length
    state.outbox = state.outbox.filter((op) => inflight.has(op.id) || keep.has(op.id))
    if (state.outbox.length !== before) persist()

    const t = now()
    const due = state.outbox.filter((op) => !inflight.has(op.id) && (force || op.nextAt <= t))
    if (due.length === 0) {
      scheduleRetry()
      settleSyncState(null)
      return
    }

    for (const op of due) inflight.add(op.id)
    sync = 'sending'
    notifySync()

    const ac = new AbortController()
    activeControllers.add(ac)
    let result: Awaited<ReturnType<ProgressBackend['send']>>
    try {
      result = await deps.backend.send(due.map((op) => ({ ...op })), ac.signal)
    } catch (err) {
      result = { ok: false, error: { retryable: true } }
      note(`send threw: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      activeControllers.delete(ac)
    }

    if (epoch !== myEpoch || flushToken !== myFlushToken) {
      return
    }

    for (const op of due) inflight.delete(op.id)
    if (refresh()) emit({ kind: 'reset' })

    const sentIds = new Set(due.map((op) => op.id))
    if (result.ok) {
      applySkew(result.serverDate)
      state.outbox = state.outbox.filter((op) => !sentIds.has(op.id))
      const ids: string[] = []
      for (const rec of result.records) {
        state.server[rec.lectureId] = rec
        ids.push(rec.lectureId)
      }
      persist()
      if (ids.length) emit({ kind: 'change', ids })
      scheduleRetry()
      settleSyncState(null)
      return
    }

    const error = result.error
    if (error.retryable) {
      const t2 = now()
      for (const op of state.outbox) {
        if (!sentIds.has(op.id)) continue
        op.attempts += 1
        op.nextAt = t2 + (error.status === 429 && error.retryAfterMs !== undefined ? error.retryAfterMs : backoffMs(op.attempts))
      }
      persist()
      scheduleRetry()
      settleSyncState(error)
      return
    }

    // refused: drop the writes; every lecture falls back to what the server (or the seed) says
    const refused = state.outbox.filter((op) => sentIds.has(op.id))
    state.outbox = state.outbox.filter((op) => !sentIds.has(op.id))
    persist()
    note(`backend refused ${refused.length} write(s) with status ${error.status ?? '?'}`)
    emit({ kind: 'change', ids: [...new Set(refused.map((op) => op.lectureId))] })
    for (const op of refused) emit({ kind: 'rejected', id: op.lectureId, status: op.status })
    scheduleRetry()
    settleSyncState(null)
  }

  async function runFlush(force: boolean, myFlushToken: number): Promise<void> {
    const myEpoch = epoch
    await Promise.resolve() // writes made in the same tick go out together
    if (epoch !== myEpoch || flushToken !== myFlushToken) return
    if (loading) {
      await loading
      if (epoch !== myEpoch || flushToken !== myFlushToken) return
    }
    let useForce = force
    do {
      flushAgain = false
      useForce ||= flushForce
      flushForce = false
      try {
        await withLock(() => sendDue(useForce, myFlushToken, myEpoch))
      } catch (err) {
        if (epoch !== myEpoch || flushToken !== myFlushToken) return
        note(`flush failed: ${err instanceof Error ? err.message : String(err)}`)
        for (const id of [...inflight]) inflight.delete(id)
      }
      if (epoch !== myEpoch || flushToken !== myFlushToken) return
      useForce = false
    } while (flushAgain)
  }

  function flush(options?: { force?: boolean }): Promise<void> {
    if (flushing) {
      flushAgain = true
      if (options?.force) flushForce = true
      return flushing
    }
    const myFlushToken = ++flushToken
    flushing = runFlush(options?.force === true, myFlushToken).finally(() => {
      if (flushToken === myFlushToken) flushing = null
    })
    return flushing
  }

  // ---- loading ----------------------------------------------------------------------------------

  function applyIdentity(session: SessionState): void {
    const clear = (why: string): void => {
      state.server = dict()
      state.outbox = []
      note(why)
    }
    if (session.status === 'authenticated') {
      if (state.owner !== session.user.id) {
        clear(`reader changed (${state.owner === null ? 'anonymous' : 'other user'} -> ${session.user.id}): local progress and pending writes cleared`)
        state.owner = session.user.id
      }
    } else if (session.status === 'anonymous' && session.source === 'server') {
      if (state.owner !== null) {
        clear('signed out: local progress and pending writes cleared')
        state.owner = null
      }
    }
  }

  function importV1(): void {
    if (state.migratedV1) return
    const s = storage()
    const v1 = s ? readV1Progress(s) : []
    const skip = new Set(state.outbox.map((op) => op.lectureId))
    const ops = planV1Migration({ v1, seed, skip, now: now(), newId })
    state.outbox.push(...ops)
    state.migratedV1 = true
    if (v1.length > 0) note(`V1 import: ${v1.length} record(s) found, ${ops.length} differ from the seed and are queued`)
  }

  /** Server records replace the cached ones; pending writes the server has already outdated are dropped. */
  function arbitrate(records: readonly ProgressRecord[]): void {
    const next = dict<ProgressRecord>()
    for (const rec of records) next[rec.lectureId] = rec
    state.server = next
    const kept: OutboxOp[] = []
    for (const op of state.outbox) {
      const updated = next[op.lectureId]?.updatedAt
      const t = updated ? Date.parse(updated) : Number.NaN
      if (!inflight.has(op.id) && !Number.isNaN(t) && t > op.at + state.skewMs) {
        note(`dropped pending write for ${op.lectureId}: the server record is newer`)
      } else {
        kept.push(op)
      }
    }
    state.outbox = kept
  }

  async function doLoad(overrideSession?: SessionState): Promise<void> {
    const myEpoch = epoch
    const myLoadSeq = ++loadSeq
    try {
      state = readPersisted()
      attach()
      const subSeqBefore = latestSubSeq
      if (!initialized) bootAwaitingSession = true
      let sessionRes: SessionState
      let seedDataRes: SeedData
      try {
        const [session, seedData] = await Promise.all([
          Promise.resolve()
            .then(() => (deps.getSession ? deps.getSession() : ({ status: 'unknown' } as SessionState)))
            .catch((): SessionState => ({ status: 'unknown' })),
          Promise.resolve()
            .then(() => (deps.loadSeed ? deps.loadSeed() : EMPTY_SEED))
            .catch((): SeedData => {
              note('seed could not be loaded')
              return EMPTY_SEED
            }),
        ])
        sessionRes = session
        seedDataRes = seedData
      } finally {
        if (!initialized) bootAwaitingSession = false
      }

      if (myEpoch !== epoch || myLoadSeq !== loadSeq) return

      baseSeedData = seedDataRes
      const effectiveSession =
        latestSubSeq !== subSeqBefore && latestSubSession
          ? latestSubSession
          : (overrideSession ?? sessionRes)

      refresh()
      applyIdentity(effectiveSession)
      seed = seedIndex(seedDataRes)
      applyExtraSeed()
      if (state.seedVersion !== null && state.seedVersion !== seedDataRes.version) {
        note(`seed version changed ${state.seedVersion} -> ${seedDataRes.version}`)
      }
      state.seedVersion = seedDataRes.version
      importV1()
      persist()
      ready = true
      initialized = true
      establishedIdentity = identityKeyOf(effectiveSession)
      emit({ kind: 'reset' })
      notifySync()

      // the screen already shows local data; now ask the server
      let fetched: Awaited<ReturnType<ProgressBackend['fetchAll']>>
      const ac = new AbortController()
      activeControllers.add(ac)
      try {
        fetched = await deps.backend.fetchAll(ac.signal)
      } catch {
        fetched = { ok: false, error: { retryable: true } }
      } finally {
        activeControllers.delete(ac)
      }

      if (myEpoch !== epoch || myLoadSeq !== loadSeq) return

      if (fetched.ok) {
        applySkew(fetched.serverDate)
        unfilteredGet = fetched.unfilteredGet
        if (deps.backend.kind === 'rest') arbitrate(fetched.records)
      } else {
        note(`could not read server progress (status ${fetched.error.status ?? 'none'}); keeping local data`)
      }
      persist()
      emit({ kind: 'reset' })
      notifySync()
    } catch (err) {
      if (myEpoch !== epoch || myLoadSeq !== loadSeq) return
      note(`load failed: ${err instanceof Error ? err.message : String(err)}`)
      ready = true
      emit({ kind: 'reset' })
    }
    if (myEpoch !== epoch || myLoadSeq !== loadSeq) return
    void flush()
  }

  function load(): Promise<void> {
    loading ??= doLoad()
    return loading
  }

  function reload(): Promise<void> {
    loading = doLoad()
    return loading
  }

  function onSessionChange(s: SessionState): void {
    if (s.status !== 'authenticated' && !(s.status === 'anonymous' && s.source === 'server')) {
      return
    }
    latestSubSeq++
    latestSubSession = s
    if (!initialized && bootAwaitingSession) {
      return
    }
    const nextIdentity = s.status === 'authenticated' ? `user:${s.user.id}` : 'anon'
    const currentIdentity = state.owner !== null ? `user:${state.owner}` : establishedIdentity
    if (nextIdentity === currentIdentity) {
      return
    }

    invalidatePendingWork({ clearLoading: s.status !== 'authenticated' })
    extraSeed.clear()
    seed = baseSeedData ? seedIndex(baseSeedData) : new Map()
    state.server = dict()
    state.outbox = []
    unfilteredGet = null
    state.owner = s.status === 'authenticated' ? s.user.id : null
    establishedIdentity = nextIdentity
    note(`identity boundary switch (${currentIdentity} -> ${nextIdentity}): cleared records, outbox, and in-flight work`)
    persist()
    ready = true
    emit({ kind: 'reset' })
    notifySync()

    if (s.status === 'authenticated') {
      loading = doLoad(s)
    } else if (s.status === 'anonymous' && s.source === 'server') {
      loadSeq++
    }
  }

  // ---- events from the page ---------------------------------------------------------------------

  function attach(): void {
    if (detach) return
    let detachSession: (() => void) | null = null
    if (deps.subscribeSession) {
      detachSession = deps.subscribeSession(onSessionChange)
    }
    const target = deps.target === undefined ? (typeof window !== 'undefined' ? window : null) : deps.target
    if (!target) {
      if (detachSession) {
        detach = () => {
          detachSession?.()
          detachSession = null
        }
      }
      return
    }
    const onOnline = (): void => {
      if (state.outbox.length) void flush({ force: true })
    }
    const onVisible = (): void => {
      if (isVisible() && state.outbox.length) void flush({ force: true })
    }
    const onStorage = (e: Event): void => {
      const k = (e as Partial<StorageEvent>).key
      if (k !== undefined && k !== null && k !== key) return
      const prevOwner = state.owner
      if (refresh()) {
        if (state.owner !== prevOwner) {
          invalidatePendingWork()
          loadSeq++
          extraSeed.clear()
          seed = baseSeedData ? seedIndex(baseSeedData) : new Map()
          unfilteredGet = null
          establishedIdentity = state.owner !== null ? `user:${state.owner}` : 'anon'
          emit({ kind: 'reset' })
          notifySync()
        } else {
          emit({ kind: 'reset' })
          notifySync()
          scheduleRetry()
        }
      }
    }
    target.addEventListener('online', onOnline)
    target.addEventListener('visibilitychange', onVisible)
    target.addEventListener('storage', onStorage)
    detach = () => {
      detachSession?.()
      detachSession = null
      target.removeEventListener('online', onOnline)
      target.removeEventListener('visibilitychange', onVisible)
      target.removeEventListener('storage', onStorage)
    }
  }

  // ---- misc -------------------------------------------------------------------------------------

  function reset(): void {
    invalidatePendingWork({ clearLoading: true })
    loadSeq++
    extraSeed.clear()
    seed = baseSeedData ? seedIndex(baseSeedData) : new Map()
    establishedIdentity = 'none'
    latestSubSession = null
    state = emptyState()
    unfilteredGet = null
    persist()
    note('state reset')
    emit({ kind: 'reset' })
    notifySync()
  }

  function snapshot(): ProgressSnapshot {
    return {
      ready,
      backend: deps.backend.kind,
      owner: state.owner,
      seedVersion: state.seedVersion,
      counts: { server: Object.keys(state.server).length, seed: seed.size, outbox: state.outbox.length },
      outbox: state.outbox.map((op) => ({ ...op })),
      skewMs: state.skewMs,
      unfilteredGet,
      syncState: sync,
      log: [...log],
    }
  }

  function destroy(): void {
    invalidatePendingWork({ clearLoading: true })
    detach?.()
    detach = null
    listeners.clear()
    syncListeners.clear()
  }

  return {
    load,
    reload,
    isReady: () => ready,
    statusOf,
    metaOf,
    completedAtOf,
    countCompleted(ids) {
      let n = 0
      for (const id of ids) if (statusOf(id) === 'completed') n++
      return n
    },
    set,
    setMany,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeSync(listener) {
      syncListeners.add(listener)
      return () => {
        syncListeners.delete(listener)
      }
    },
    syncState: () => sync,
    pending: () => state.outbox.length,
    flush,
    extendSeed,
    reset,
    snapshot,
    destroy,
  }
}

// ---------------------------------------------------------------------------------------------------
// the site singleton
// ---------------------------------------------------------------------------------------------------

export interface ProgressRuntime {
  adapter: 'local' | 'rest'
  endpoint: string
  notionSync: boolean
  authAdapter: string
  sessionEndpoint: string | undefined
  groupIds: string[]
}

const DEFAULT_RUNTIME: ProgressRuntime = {
  adapter: 'local',
  endpoint: API_ENDPOINTS.db,
  notionSync: false,
  authAdapter: 'none',
  sessionEndpoint: undefined,
  groupIds: [],
}

let runtime: ProgressRuntime = DEFAULT_RUNTIME
let runtimeBackend: ProgressBackend = createLocalBackend()

/** Read the site settings out of `themeConfig` (`useData().theme.value`); anything missing keeps its default. */
export function parseProgressRuntime(theme: unknown): ProgressRuntime {
  const t = isObject(theme) ? theme : {}
  const modules = isObject(t.lectureModules) ? t.lectureModules : {}
  const progress = isObject(modules.progress) ? modules.progress : {}
  const auth = isObject(modules.auth) ? modules.auth : {}
  const groupIds: string[] = []
  if (Array.isArray(t.groups)) {
    for (const g of t.groups) {
      const dir = isObject(g) && typeof g.dir === 'string' ? g.dir : ''
      const last = dir.split('/').filter(Boolean).pop()
      if (last) groupIds.push(normaliseLectureId(last))
    }
  }
  return {
    adapter: progress.adapter === 'rest' ? 'rest' : 'local',
    endpoint: typeof progress.endpoint === 'string' && progress.endpoint ? progress.endpoint : DEFAULT_RUNTIME.endpoint,
    notionSync: progress.notionSync === true,
    authAdapter: typeof auth.adapter === 'string' ? auth.adapter : 'none',
    sessionEndpoint: typeof auth.sessionEndpoint === 'string' && auth.sessionEndpoint ? auth.sessionEndpoint : undefined,
    groupIds,
  }
}

/**
 * Point the singleton (and the session client) at the configured adapters. Call once on the client with
 * `useData().theme.value`, before `progressStore.load()`.
 */
export function configureProgress(theme: unknown): ProgressRuntime {
  runtime = parseProgressRuntime(theme)
  const { groupIds } = runtime
  runtimeBackend =
    runtime.adapter === 'rest' ? createRestBackend({ endpoint: runtime.endpoint, groupIds: () => groupIds }) : createLocalBackend()
  configureSession({ adapter: runtime.authAdapter, sessionEndpoint: runtime.sessionEndpoint })
  return runtime
}

/** The settings the singleton currently runs with. */
export function progressRuntime(): ProgressRuntime {
  return runtime
}

const delegatingBackend: ProgressBackend = {
  get kind() {
    return runtimeBackend.kind
  },
  fetchAll: (signal) => runtimeBackend.fetchAll(signal),
  send: (ops, signal) => runtimeBackend.send(ops, signal),
}

/**
 * The site store. The seed is imported lazily: `seed.data.mts` is a VitePress data loader whose data VitePress
 * inlines into whatever chunk imports it, so a dynamic `import()` keeps it out of every page's main chunk.
 */
export const progressStore: ProgressStore = createProgressStore({
  backend: delegatingBackend,
  getSession: () => getSession(),
  subscribeSession: (listener) => subscribeSession(listener),
  loadSeed: () => import('./seed.data.mts').then((m) => m.data),
})

/**
 * Register the `progress` debug panel (snapshot + `flush` / `reset` / `reload` actions). WP-P2 calls it from the
 * theme once on the client; registering is cheap and safe even when the debug console is off.
 */
export function registerProgressDebugPanel(store: ProgressStore = progressStore): () => void {
  return registerDebugPanel('progress', {
    describe: () => store.snapshot(),
    actions: {
      flush: () => store.flush({ force: true }),
      reset: () => store.reset(),
      reload: () => store.reload(),
    },
  })
}
