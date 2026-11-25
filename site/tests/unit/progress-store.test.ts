import { afterEach, describe, expect, it } from 'vitest'
import { BACKOFF_MS, OUTBOX_LOCK_NAME, backoffMs, createProgressStore, parsePersistedState } from '../../docs/.vitepress/theme/progress/progressStore'
import type { ProgressStore, ProgressStoreDeps } from '../../docs/.vitepress/theme/progress/progressStore'
import type { SessionState } from '../../docs/.vitepress/theme/auth/session'
import type { SeedData } from '../../docs/.vitepress/theme/progress/seed'
import type { FetchAllResult, SendResult } from '../../docs/.vitepress/theme/api/progress'
import type { OutboxOp, ProgressEvent, ProgressRecord, ProgressStatus } from '../../docs/.vitepress/theme/progress/types'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import { groupOfDir } from '../../docs/.vitepress/theme/progress/types'
import { FakeClock, FakeLocks, FakeScheduler, MemoryStorage, ScriptedBackend, deferred, op, rec, settle } from './progress-helpers'

const KEY = STORAGE_KEYS.progressV2

interface Rig {
  store: ProgressStore
  storage: MemoryStorage
  clock: FakeClock
  scheduler: FakeScheduler
  backend: ScriptedBackend
  locks: FakeLocks
  target: EventTarget
  events: ProgressEvent[]
  publishSession: (s: SessionState) => void
  sessionListeners: Set<(s: SessionState) => void>
}

const created: ProgressStore[] = []
afterEach(() => {
  for (const s of created.splice(0)) s.destroy()
})

function rig(overrides: Omit<Partial<ProgressStoreDeps>, 'storage'> & { storage?: MemoryStorage | null; clock?: FakeClock; backend?: ScriptedBackend } = {}): Rig {
  const clock = overrides.clock ?? new FakeClock()
  const storage = overrides.storage ?? new MemoryStorage()
  const backend = overrides.backend ?? new ScriptedBackend('rest', clock)
  const scheduler = new FakeScheduler()
  const locks = new FakeLocks()
  const target = new EventTarget()
  const sessionListeners = new Set<(s: SessionState) => void>()
  const subscribeSession =
    overrides.subscribeSession ??
    ((listener: (s: SessionState) => void) => {
      sessionListeners.add(listener)
      return () => {
        sessionListeners.delete(listener)
      }
    })
  const publishSession = (s: SessionState): void => {
    for (const l of [...sessionListeners]) l(s)
  }
  let n = 0
  const store = createProgressStore({
    backend,
    storage,
    now: clock.now,
    locks,
    scheduler,
    target,
    subscribeSession,
    newId: () => `id-${++n}`,
    isVisible: () => true,
    ...overrides,
  })
  created.push(store)
  const events: ProgressEvent[] = []
  store.subscribe((e) => events.push(e))
  return { store, storage, clock, scheduler, backend, locks, target, events, publishSession, sessionListeners }
}

/** Write a persisted state; V1 migration is marked done unless a test says otherwise. */
function persisted(storage: MemoryStorage, partial: Record<string, unknown> = {}): void {
  storage.map.set(KEY, JSON.stringify({ schema: 1, owner: null, server: {}, outbox: [], seedVersion: null, migratedV1: true, skewMs: 0, ...partial }))
}
const serverOf = (...records: ProgressRecord[]): Record<string, ProgressRecord> => Object.fromEntries(records.map((r) => [r.lectureId, r]))
const seedOf = (version: string, ...records: ProgressRecord[]): (() => Promise<SeedData>) => async () => ({ version, records })
const stored = (storage: MemoryStorage): Record<string, unknown> => JSON.parse(storage.map.get(KEY) ?? 'null') as Record<string, unknown>

describe('read priority', () => {
  it('is pending write > server record > seed > not started', async () => {
    // local backend: the cached server records are kept as they are (a rest backend would replace them with its own list)
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('s1', rec('g01-l01', 'completed'), rec('g01-l02', 'completed'), rec('g01-l03', 'completed')) })
    persisted(r.storage, {
      server: serverOf(rec('g01-l02', 'in_progress'), rec('g01-l03', 'in_progress')),
      outbox: [op('g01-l03', 'not_started', r.clock.t, { nextAt: r.clock.t + 60_000 })],
    })
    expect(r.store.isReady()).toBe(false)
    await r.store.load()
    expect(r.store.isReady()).toBe(true)
    expect(r.store.statusOf('g01-l01')).toBe('completed') // seed only
    expect(r.store.statusOf('g01-l02')).toBe('in_progress') // server beats seed
    expect(r.store.statusOf('g01-l03')).toBe('not_started') // pending write beats both
    expect(r.store.statusOf('G01-L99')).toBe('not_started') // nothing known
    expect(r.store.statusOf(' G01-L01 ')).toBe('completed') // ids are normalised
  })

  it('metaOf takes Notion ids from the server record first, then the seed', async () => {
    const r = rig({
      backend: new ScriptedBackend('local'),
      loadSeed: seedOf('s', rec('g01-l01', 'not_started', { notionNodeId: 'seed-node', notionPageId: 'seed-page' }), rec('g01-l02', 'not_started', { notionNodeId: 'seed-node-2' })),
    })
    persisted(r.storage, { server: serverOf(rec('g01-l01', 'completed', { notionNodeId: 'srv-node' })) })
    await r.store.load()
    expect(r.store.metaOf('g01-l01')).toEqual({ notionNodeId: 'srv-node', notionPageId: 'seed-page' })
    expect(r.store.metaOf('g01-l02')).toEqual({ notionNodeId: 'seed-node-2', notionPageId: null })
    expect(r.store.metaOf('g01-l03')).toEqual({ notionNodeId: null, notionPageId: null })
  })

  it('counts completed lectures', async () => {
    const r = rig({ loadSeed: seedOf('s', rec('g01-l01', 'completed'), rec('g01-l02', 'in_progress')) })
    await r.store.load()
    r.store.set('g01-l03', 'completed')
    expect(r.store.countCompleted(['g01-l01', 'g01-l02', 'g01-l03', 'g01-l04'])).toBe(2)
  })
})

describe('seed', () => {
  it('never overrides a server record or a pending write, and a new seed version clears nothing', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('new-version', rec('g01-l01', 'completed'), rec('g01-l02', 'completed'), rec('g01-l03', 'completed')) })
    persisted(r.storage, {
      seedVersion: 'old-version',
      server: serverOf(rec('g01-l01', 'not_started'), rec('g01-l02', 'in_progress', { updatedAt: r.clock.iso(-1000) })),
      outbox: [op('g01-l03', 'in_progress', r.clock.t, { nextAt: r.clock.t + 60_000 })],
    })
    await r.store.load()
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.statusOf('g01-l02')).toBe('in_progress')
    expect(r.store.statusOf('g01-l03')).toBe('in_progress')
    expect(r.store.snapshot().counts).toEqual({ server: 2, seed: 3, outbox: 1 })
    expect(r.store.snapshot().seedVersion).toBe('new-version')
    expect(r.store.snapshot().log.some((l) => l.includes('seed version changed'))).toBe(true)
    expect(stored(r.storage).seedVersion).toBe('new-version')
  })

  it('a seed that fails to load leaves an empty seed and the store ready', async () => {
    const r = rig({
      loadSeed: () => Promise.reject(new Error('chunk failed')),
    })
    await r.store.load()
    expect(r.store.isReady()).toBe(true)
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.snapshot().log.some((l) => l.includes('seed could not be loaded'))).toBe(true)
  })
})

describe('extendSeed (P3b: lectures of a restricted tier arrive after the first load)', () => {
  it('seeds only lectures with no server record, no pending write and no seed record, then emits reset', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('s', rec('g01-l01', 'in_progress')) })
    persisted(r.storage, {
      server: serverOf(rec('g09-l02', 'not_started')),
      outbox: [op('g09-l03', 'in_progress', r.clock.t, { nextAt: r.clock.t + 60_000 })],
    })
    await r.store.load()
    r.events.length = 0
    r.store.extendSeed({
      version: 'x',
      records: [rec('g01-l01', 'completed'), rec('g09-l01', 'completed'), rec('g09-l02', 'completed'), rec('g09-l03', 'completed'), rec('g09-l04', 'in_progress')],
    })
    expect(r.store.statusOf('g09-l01')).toBe('completed') // new
    expect(r.store.statusOf('g09-l04')).toBe('in_progress') // new
    expect(r.store.statusOf('g01-l01')).toBe('in_progress') // the build seed stays
    expect(r.store.statusOf('g09-l02')).toBe('not_started') // server record wins
    expect(r.store.statusOf('g09-l03')).toBe('in_progress') // pending write wins
    expect(r.events.filter((e) => e.kind === 'reset')).toHaveLength(1)
    expect(r.store.snapshot().counts).toEqual({ server: 1, seed: 3, outbox: 1 })
    expect(r.store.snapshot().seedVersion).toBe('s') // the build seed version is not touched
  })

  it('emits nothing and changes nothing when every lecture is already known', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('s', rec('g01-l01', 'completed')) })
    await r.store.load()
    r.events.length = 0
    r.store.extendSeed({ version: 'x', records: [rec('g01-l01', 'not_started')] })
    expect(r.events).toEqual([])
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    r.store.extendSeed({ version: 'empty', records: [] })
    expect(r.events).toEqual([])
  })

  it('records given before the load finished are applied after the build seed is read, still below server records', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('s', rec('g01-l01', 'completed')) })
    persisted(r.storage, { server: serverOf(rec('g09-l02', 'not_started')) })
    r.store.extendSeed({ version: 'x', records: [rec('g09-l01', 'completed'), rec('g09-l02', 'completed')] })
    await r.store.load()
    expect(r.store.statusOf('g09-l01')).toBe('completed')
    expect(r.store.statusOf('g09-l02')).toBe('not_started')
    expect(r.store.statusOf('g01-l01')).toBe('completed')
  })

  it('a written status beats an extended seed', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('s') })
    await r.store.load()
    r.store.extendSeed({ version: 'x', records: [rec('g09-l01', 'completed')] })
    r.store.set('g09-l01', 'in_progress')
    expect(r.store.statusOf('g09-l01')).toBe('in_progress')
  })
})

describe('writes', () => {
  it('a group directory becomes its last segment, like core/route.ts (nested groups do not split a lecture in two)', async () => {
    expect(groupOfDir('courses/g01')).toBe('g01')
    expect(groupOfDir('G05')).toBe('g05')
    expect(groupOfDir('/a/b/')).toBe('b')
    expect(groupOfDir('')).toBe('')
    const r = rig({ backend: new ScriptedBackend('local') })
    await r.store.load()
    r.store.set('g01-l01', 'completed', { groupId: 'courses/g01' })
    await r.store.flush()
    const server = stored(r.storage).server as Record<string, ProgressRecord>
    expect(server['g01-l01']?.groupId).toBe('g01')
  })

  it('apply at once, notify with origin user, and persist', () => {
    const r = rig()
    r.store.set('G05-L19', 'in_progress', { groupId: 'G05' })
    expect(r.store.statusOf('g05-l19')).toBe('in_progress')
    expect(r.store.pending()).toBe(1)
    const change = r.events.find((e) => e.kind === 'change')
    expect(change).toEqual({ kind: 'change', ids: ['g05-l19'], origin: 'user' })
    const outbox = stored(r.storage).outbox as OutboxOp[]
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ lectureId: 'g05-l19', groupId: 'g05', status: 'in_progress', attempts: 0 })
  })

  it('a newer write replaces the unsent one of the same lecture', async () => {
    const r = rig()
    r.store.set('g01-l01', 'in_progress')
    r.store.set('g01-l01', 'completed')
    expect(r.store.pending()).toBe(1)
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
    expect(r.backend.sent[0]).toHaveLength(1)
    expect(r.backend.sent[0]?.[0]).toMatchObject({ lectureId: 'g01-l01', status: 'completed' })
  })

  it('the write being sent stays; a newer write for that lecture queues behind it', async () => {
    const r = rig()
    const gate = deferred<{ ok: true; records: ProgressRecord[]; serverDate: null }>()
    r.backend.sendResults.push(gate.promise)
    r.store.set('g01-l01', 'in_progress')
    await settle()
    expect(r.backend.sent).toHaveLength(1)
    expect(r.store.syncState()).toBe('sending')

    r.store.set('g01-l01', 'completed')
    expect(r.store.pending()).toBe(2) // in flight + newer
    expect(r.store.statusOf('g01-l01')).toBe('completed')

    gate.resolve({ ok: true, records: [rec('g01-l01', 'in_progress', { updatedAt: r.clock.iso() })], serverDate: null })
    await r.store.flush()
    await settle()
    expect(r.backend.sent).toHaveLength(2)
    expect(r.backend.sent[1]?.[0]).toMatchObject({ status: 'completed' })
    expect(r.store.pending()).toBe(0)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    expect(r.store.syncState()).toBe('idle')
  })

  it('writes made in the same tick go out as one send', async () => {
    const r = rig()
    r.store.setMany([
      { lectureId: 'g01-l01', status: 'completed' },
      { lectureId: 'g01-l02', status: 'completed' },
      { lectureId: 'g01-l03', status: 'in_progress' },
    ])
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
    expect(r.backend.sent[0]?.map((o) => o.lectureId)).toEqual(['g01-l01', 'g01-l02', 'g01-l03'])
  })

  it('a write equal to what is already shown queues nothing; reverting an unsent write cancels it', async () => {
    const r = rig({ loadSeed: seedOf('s', rec('g01-l01', 'completed')) })
    await r.store.load()
    r.store.set('g01-l01', 'completed')
    expect(r.store.pending()).toBe(0)
    r.backend.sendResults.push(deferred<{ ok: true; records: ProgressRecord[]; serverDate: null }>().promise) // keep sends from finishing
    r.store.set('g01-l01', 'not_started')
    r.store.set('g01-l01', 'completed') // back to the seed value before anything was sent
    expect(r.store.pending()).toBe(0)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
  })

  it('ignores invalid input and never throws', () => {
    const r = rig()
    expect(() => r.store.set('', 'completed')).not.toThrow()
    expect(() => r.store.set('g01-l01', 'done' as unknown as ProgressStatus)).not.toThrow()
    expect(r.store.pending()).toBe(0)
  })

  it('a successful send stores the server record and updates the clock skew from the Date header', async () => {
    const r = rig()
    r.backend.sendResults.push({ ok: true, records: [rec('g01-l01', 'completed', { updatedAt: r.clock.iso(), completedAt: r.clock.iso() })], serverDate: r.clock.t + 4000 })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.store.pending()).toBe(0)
    expect(r.store.snapshot().counts.server).toBe(1)
    expect(r.store.snapshot().skewMs).toBe(4000)
    expect((stored(r.storage).server as Record<string, ProgressRecord>)['g01-l01']?.status).toBe('completed')
  })
})

describe('retry and refusal', () => {
  it('backs off 1 s, 5 s, 30 s, 2 min and then keeps 2 min', async () => {
    expect(BACKOFF_MS).toEqual([1000, 5000, 30000, 120000])
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([1000, 5000, 30000, 120000, 120000, 120000])

    const r = rig()
    for (let i = 0; i < 6; i++) r.backend.sendResults.push({ ok: false, error: { retryable: true, status: 503 } })
    r.store.set('g01-l01', 'completed')
    const waits: number[] = []
    for (let i = 0; i < 6; i++) {
      await r.store.flush()
      const [pending] = r.store.snapshot().outbox
      expect(pending?.attempts).toBe(i + 1)
      waits.push((pending?.nextAt ?? 0) - r.clock.t)
      expect(r.scheduler.lastDelay).toBe(waits[i])
      r.clock.advance(waits[i] as number)
    }
    expect(waits).toEqual([1000, 5000, 30000, 120000, 120000, 120000])
    expect(r.store.syncState()).toBe('retrying')
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed') // still shown optimistically
  })

  it('does not resend before the retry time, and the scheduled timer retries', async () => {
    const r = rig()
    r.backend.sendResults.push({ ok: false, error: { retryable: true, status: 500 } })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1) // not due yet
    r.clock.advance(1000)
    const timer = r.scheduler.timers.at(-1)
    expect(timer).toBeDefined()
    timer?.fn()
    await settle()
    expect(r.backend.sent).toHaveLength(2)
    expect(r.store.pending()).toBe(0)
    expect(r.store.syncState()).toBe('idle')
  })

  it('a network failure reads as offline, an HTTP failure as retrying', async () => {
    const r = rig()
    r.backend.sendResults.push({ ok: false, error: { retryable: true } })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.store.syncState()).toBe('offline')
    r.backend.sendResults.push({ ok: false, error: { retryable: true, status: 502 } })
    await r.store.flush({ force: true })
    expect(r.store.syncState()).toBe('retrying')
  })

  it('429 waits for Retry-After instead of the backoff table', async () => {
    const r = rig()
    r.backend.sendResults.push({ ok: false, error: { retryable: true, status: 429, retryAfterMs: 7000 } })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    const [pending] = r.store.snapshot().outbox
    expect((pending?.nextAt ?? 0) - r.clock.t).toBe(7000)
    expect(r.scheduler.lastDelay).toBe(7000)
  })

  it('an other 4xx drops the write, rolls the lecture back and raises rejected', async () => {
    const r = rig({ loadSeed: seedOf('s', rec('g01-l01', 'in_progress')) })
    await r.store.load()
    r.backend.sendResults.push({ ok: false, error: { retryable: false, status: 422 } })
    r.store.set('g01-l01', 'completed')
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    await r.store.flush()
    expect(r.store.pending()).toBe(0)
    expect(r.store.statusOf('g01-l01')).toBe('in_progress') // back to the seed
    expect(r.events).toContainEqual({ kind: 'rejected', id: 'g01-l01', status: 'completed' })
    expect(r.events).toContainEqual({ kind: 'change', ids: ['g01-l01'] })
    expect(r.store.syncState()).toBe('idle')
    expect(stored(r.storage).outbox).toEqual([])
  })

  it('a refused batch rejects every write in it', async () => {
    const r = rig()
    r.backend.sendResults.push({ ok: false, error: { retryable: false, status: 400 } })
    r.store.setMany([
      { lectureId: 'g01-l01', status: 'completed' },
      { lectureId: 'g01-l02', status: 'completed' },
    ])
    await r.store.flush()
    const rejected = r.events.filter((e) => e.kind === 'rejected')
    expect(rejected).toHaveLength(2)
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
  })

  it('retries when the page comes online or becomes visible, ignoring the schedule', async () => {
    const r = rig()
    await r.store.load()
    r.backend.sendResults.push({ ok: false, error: { retryable: true } })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)

    r.target.dispatchEvent(new Event('online'))
    await settle()
    expect(r.backend.sent).toHaveLength(2)
    expect(r.store.pending()).toBe(0)

    r.backend.sendResults.push({ ok: false, error: { retryable: true } })
    r.store.set('g01-l02', 'completed')
    await r.store.flush()
    expect(r.store.pending()).toBe(1)
    r.target.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(r.store.pending()).toBe(0)
  })

  it('survives a backend that throws', async () => {
    const r = rig()
    r.backend.send = () => Promise.reject(new Error('boom'))
    r.store.set('g01-l01', 'completed')
    await expect(r.store.flush()).resolves.toBeUndefined()
    expect(r.store.pending()).toBe(1)
    expect(r.store.snapshot().outbox[0]?.attempts).toBe(1)
  })
})

describe('load and arbitration (API_CONTRACT 2.5)', () => {
  const at = Date.parse('2026-11-18T08:00:00.000Z')

  async function arbitrate(opts: { updatedAt: string | null; skewMs?: number; opAt?: number }): Promise<Rig> {
    const clock = new FakeClock(at + 60_000)
    const backend = new ScriptedBackend('rest', clock)
    backend.fetchAllResult = {
      ok: true,
      records: [rec('g01-l01', 'in_progress', { updatedAt: opts.updatedAt })],
      serverDate: clock.t + (opts.skewMs ?? 0),
      unfilteredGet: true,
    }
    const r = rig({ clock, backend })
    persisted(r.storage, { outbox: [op('g01-l01', 'completed', opts.opAt ?? at, { nextAt: clock.t + 3_600_000 })] })
    await r.store.load()
    return r
  }

  it('drops a pending write when the server record is newer', async () => {
    const r = await arbitrate({ updatedAt: new Date(at + 1000).toISOString() })
    expect(r.store.pending()).toBe(0)
    expect(r.store.statusOf('g01-l01')).toBe('in_progress')
    expect(r.store.snapshot().log.some((l) => l.includes('dropped pending write for g01-l01'))).toBe(true)
  })

  it('keeps a pending write that is newer than the server record', async () => {
    const r = await arbitrate({ updatedAt: new Date(at - 1000).toISOString() })
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
  })

  it('keeps the write when the server has no updated_at', async () => {
    const r = await arbitrate({ updatedAt: null })
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
  })

  it('positive skew (server clock ahead): a server time that only looks later is not later', async () => {
    // server stamped op.at + 5 s, but the server clock runs 10 s ahead, so that is really 5 s BEFORE the write
    const r = await arbitrate({ updatedAt: new Date(at + 5000).toISOString(), skewMs: 10_000 })
    expect(r.store.snapshot().skewMs).toBe(10_000)
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
  })

  it('negative skew (server clock behind): a server time that looks earlier is later', async () => {
    const r = await arbitrate({ updatedAt: new Date(at - 5000).toISOString(), skewMs: -10_000 })
    expect(r.store.snapshot().skewMs).toBe(-10_000)
    expect(r.store.pending()).toBe(0)
    expect(r.store.statusOf('g01-l01')).toBe('in_progress')
  })

  it('replaces cached server records with the fetched ones (rest) and keeps them (local)', async () => {
    const rest = rig()
    rest.backend.fetchAllResult = { ok: true, records: [rec('g01-l02', 'completed')], serverDate: null, unfilteredGet: true }
    persisted(rest.storage, { server: serverOf(rec('g01-l01', 'completed')) })
    await rest.store.load()
    expect(rest.store.statusOf('g01-l01')).toBe('not_started')
    expect(rest.store.statusOf('g01-l02')).toBe('completed')

    const local = rig({ backend: new ScriptedBackend('local') })
    persisted(local.storage, { server: serverOf(rec('g01-l01', 'completed')) })
    await local.store.load()
    expect(local.store.statusOf('g01-l01')).toBe('completed')
  })

  it('a failed fetch keeps the local data and reports why in the log', async () => {
    const r = rig()
    r.backend.fetchAllResult = { ok: false, error: { retryable: true, status: 503 } }
    persisted(r.storage, { server: serverOf(rec('g01-l01', 'completed')) })
    await r.store.load()
    expect(r.store.isReady()).toBe(true)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    expect(r.store.snapshot().log.some((l) => l.includes('could not read server progress'))).toBe(true)
  })

  it('records whether the backend could be read unfiltered, and sends what was pending', async () => {
    const r = rig()
    r.backend.fetchAllResult = { ok: true, records: [], serverDate: null, unfilteredGet: false }
    persisted(r.storage, { outbox: [op('g01-l01', 'completed', r.clock.t)] })
    expect(r.store.snapshot().unfilteredGet).toBeNull()
    await r.store.load()
    await settle()
    expect(r.store.snapshot().unfilteredGet).toBe(false)
    expect(r.backend.sent).toHaveLength(1)
    expect(r.store.pending()).toBe(0)
  })

  it('load is idempotent', async () => {
    const r = rig()
    await Promise.all([r.store.load(), r.store.load()])
    await r.store.load()
    expect(r.backend.fetchAllCalls).toBe(1)
    await r.store.reload()
    expect(r.backend.fetchAllCalls).toBe(2)
  })

  it('a write made before the load finishes is sent after the arbitration', async () => {
    const r = rig()
    const loading = r.store.load()
    r.store.set('g01-l01', 'completed')
    await loading
    await settle()
    expect(r.backend.fetchAllCalls).toBe(1)
    expect(r.backend.sent).toHaveLength(1)
  })
})

describe('reader identity', () => {
  const session = (s: SessionState) => async () => s
  const alice: SessionState = { status: 'authenticated', user: { id: 'alice', name: null, email: null }, roles: ['reader'], groups: [], logoutUrl: null }
  const bob: SessionState = { status: 'authenticated', user: { id: 'bob', name: null, email: null }, roles: ['reader'], groups: [], logoutUrl: null }

  it('a different signed-in user clears server records and pending writes and takes the owner', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), getSession: session(bob) })
    persisted(r.storage, { owner: 'alice', server: serverOf(rec('g01-l01', 'completed')), outbox: [op('g01-l02', 'completed', r.clock.t, { nextAt: r.clock.t + 3_600_000 })] })
    await r.store.load()
    expect(r.store.snapshot().owner).toBe('bob')
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.pending()).toBe(0)
    expect((stored(r.storage) as { owner: string }).owner).toBe('bob')
    expect(r.store.snapshot().log.some((l) => l.includes('reader changed'))).toBe(true)
  })

  it('the same user keeps everything', async () => {
    const again = rig({ backend: new ScriptedBackend('local'), getSession: session(alice) })
    persisted(again.storage, { owner: 'alice', server: serverOf(rec('g01-l01', 'completed')), outbox: [op('g01-l02', 'completed', again.clock.t, { nextAt: again.clock.t + 3_600_000 })] })
    await again.store.load()
    expect(again.store.statusOf('g01-l01')).toBe('completed')
    expect(again.store.pending()).toBe(1)
  })

  it('signing in for the first time (owner was empty) also clears, as the plan says', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), getSession: session(alice) })
    persisted(r.storage, { owner: null, server: serverOf(rec('g01-l01', 'completed')) })
    await r.store.load()
    expect(r.store.snapshot().owner).toBe('alice')
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
  })

  it('signed out (anonymous from the server) while an owner is stored clears and resets the owner', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), getSession: session({ status: 'anonymous', source: 'server' }) })
    persisted(r.storage, { owner: 'alice', server: serverOf(rec('g01-l01', 'completed')) })
    await r.store.load()
    expect(r.store.snapshot().owner).toBeNull()
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
  })

  it.each<[string, SessionState]>([
    ['auth none', { status: 'anonymous', source: 'none' }],
    ['unavailable', { status: 'unavailable', reason: 'network' }],
    ['unknown', { status: 'unknown' }],
  ])('%s leaves the owner and the data alone', async (_label, s) => {
    const r = rig({ backend: new ScriptedBackend('local'), getSession: session(s) })
    persisted(r.storage, { owner: 'alice', server: serverOf(rec('g01-l01', 'completed')) })
    await r.store.load()
    expect(r.store.snapshot().owner).toBe('alice')
    expect(r.store.statusOf('g01-l01')).toBe('completed')
  })

  it('a session that rejects behaves like no session', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), getSession: () => Promise.reject(new Error('x')) })
    persisted(r.storage, { owner: 'alice', server: serverOf(rec('g01-l01', 'completed')) })
    await r.store.load()
    expect(r.store.statusOf('g01-l01')).toBe('completed')
  })

  it('SPA logout transition (alice -> anonymous/server) clears records, extra seed, outbox, aborts requests, cancels timers, and ignores delayed responses', async () => {
    const r = rig({ backend: new ScriptedBackend('rest'), getSession: session(alice) })
    await r.store.load()

    // Alice has a server record and an extra seed
    r.store.extendSeed({ version: 'v-tier', records: [rec('g09-l01', 'completed')] })
    expect(r.store.statusOf('g09-l01')).toBe('completed')

    // Set up in-flight send with a deferred promise
    const delayedSend = deferred<SendResult>()
    r.backend.sendResults.push(delayedSend.promise)
    r.store.set('g01-l01', 'completed')
    await settle(5)
    expect(r.backend.lastSendSignal).toBeDefined()
    expect(r.backend.lastSendSignal?.aborted).toBe(false)
    expect(r.store.pending()).toBe(1)

    // Arm a retry timer via a pending op in storage
    r.storage.map.set(
      KEY,
      JSON.stringify({
        schema: 1,
        owner: 'alice',
        server: serverOf(rec('g01-l02', 'completed')),
        outbox: [op('g01-l03', 'in_progress', r.clock.t, { nextAt: r.clock.t + 60_000 })],
        seedVersion: null,
        migratedV1: true,
        skewMs: 0,
      }),
    )
    r.target.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }))
    expect(r.scheduler.timers.length).toBeGreaterThan(0)

    // Alice logs out via subscribeSession
    r.events.length = 0
    r.publishSession({ status: 'anonymous', source: 'server' })

    // State is immediately cleared
    expect(r.store.snapshot().owner).toBeNull()
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.statusOf('g01-l02')).toBe('not_started')
    expect(r.store.statusOf('g01-l03')).toBe('not_started')
    expect(r.store.statusOf('g09-l01')).toBe('not_started')
    expect(r.store.pending()).toBe(0)
    expect(r.scheduler.timers).toHaveLength(0)
    expect(r.backend.lastSendSignal?.aborted).toBe(true)
    expect((stored(r.storage) as { owner: unknown }).owner).toBeNull()

    // Delayed send now resolves late
    delayedSend.resolve({ ok: true, records: [rec('g01-l01', 'completed')], serverDate: null })
    await settle(10)

    // Late resolution must NOT update store, mutate state, or trigger rejected events
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.pending()).toBe(0)
    expect(r.events.filter((e) => e.kind === 'rejected')).toHaveLength(0)
  })

  it('direct user switch (alice -> bob without reload) aborts alice requests, clears outbox/records, sets bob owner, reloads bob records, and preserves bob optimistic writes', async () => {
    const r = rig({ backend: new ScriptedBackend('rest'), getSession: session(alice) })
    await r.store.load()

    // Alice has in-flight send
    const delayedSendAlice = deferred<SendResult>()
    r.backend.sendResults.push(delayedSendAlice.promise)
    r.store.set('g01-l01', 'completed')
    await settle(5)
    expect(r.backend.lastSendSignal?.aborted).toBe(false)
    const sentBeforeBobCount = r.backend.sent.length

    // Bob's server records will return g01-l02 completed
    r.backend.fetchAllResult = {
      ok: true,
      records: [rec('g01-l02', 'completed')],
      serverDate: null,
      unfilteredGet: true,
    }

    // Switch to bob
    r.publishSession(bob)

    // Alice's send signal aborted
    expect(r.backend.lastSendSignal?.aborted).toBe(true)
    expect(r.store.snapshot().owner).toBe('bob')
    expect(r.store.statusOf('g01-l01')).toBe('not_started')

    // While bob's reload is in-flight, bob makes an optimistic write
    r.store.set('g01-l03', 'completed')
    expect(r.store.statusOf('g01-l03')).toBe('completed')

    // Let bob's reload and flush finish
    await settle(10)

    // Alice's delayed send resolves late
    delayedSendAlice.resolve({ ok: true, records: [rec('g01-l01', 'completed')], serverDate: null })
    await settle(5)

    // Bob sees his server record + his own optimistic write, never Alice's
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.statusOf('g01-l02')).toBe('completed')
    expect(r.store.statusOf('g01-l03')).toBe('completed')
    expect(r.store.snapshot().owner).toBe('bob')

    // Ensure Alice's write was never sent under Bob's session
    for (const sentBatch of r.backend.sent.slice(sentBeforeBobCount)) {
      for (const op of sentBatch) {
        expect(op.lectureId).not.toBe('g01-l01')
      }
    }
  })

  it('non-decisive session notifications and duplicate notifications for the same signed-in user do not abort or clear writes', async () => {
    const r = rig({ backend: new ScriptedBackend('rest'), getSession: session(alice) })
    await r.store.load()

    // Alice has a pending write and armed timer
    r.backend.sendResults.push({ ok: false, error: { retryable: true } })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.store.pending()).toBe(1)
    expect(r.scheduler.timers.length).toBeGreaterThan(0)
    const timerCount = r.scheduler.timers.length

    // Non-decisive notifications: unknown, unavailable, anonymous/none
    r.publishSession({ status: 'unknown' })
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    expect(r.scheduler.timers.length).toBe(timerCount)

    r.publishSession({ status: 'unavailable', reason: 'network' })
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    expect(r.scheduler.timers.length).toBe(timerCount)

    r.publishSession({ status: 'anonymous', source: 'none' })
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    expect(r.scheduler.timers.length).toBe(timerCount)

    // Duplicate notification for alice
    r.publishSession(alice)
    expect(r.store.pending()).toBe(1)
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    expect(r.scheduler.timers.length).toBe(timerCount)
  })

  it('reset cancels pending retry timers and aborts in-flight requests so late network callbacks are ignored', async () => {
    const r = rig({ backend: new ScriptedBackend('rest') })
    await r.store.load()

    // 1. Arm a retry timer via retryable send
    r.backend.sendResults.push({ ok: false, error: { retryable: true } })
    r.store.set('g01-l02', 'completed')
    await r.store.flush()
    expect(r.scheduler.timers.length).toBeGreaterThan(0)

    // 2. Start an in-flight send for a new lecture that hangs
    const delayedSend = deferred<SendResult>()
    r.backend.sendResults.push(delayedSend.promise)
    r.store.set('g01-l01', 'completed')
    await settle(5)
    expect(r.backend.lastSendSignal?.aborted).toBe(false)
    expect(r.scheduler.timers.length).toBeGreaterThan(0)

    // 3. Reset
    r.store.reset()

    expect(r.backend.lastSendSignal?.aborted).toBe(true)
    expect(r.scheduler.timers).toHaveLength(0)
    expect(r.store.pending()).toBe(0)

    // 4. Delayed network callback finishes late
    delayedSend.resolve({ ok: true, records: [rec('g01-l01', 'completed')], serverDate: null })
    await settle(5)
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.statusOf('g01-l02')).toBe('not_started')
  })

  it('aborts in-flight fetchAll on identity switch and ignores late server response from prior account', async () => {
    let activeSession: SessionState = alice
    const delayedAliceFetch = deferred<FetchAllResult>()
    const r = rig({
      backend: new ScriptedBackend('rest'),
      getSession: async () => activeSession,
    })
    r.backend.fetchAllResults.push(delayedAliceFetch.promise)

    const initialLoad = r.store.load()
    await settle(5)
    expect(r.backend.lastFetchSignal?.aborted).toBe(false)

    // Before Alice's fetchAll resolves, switch to Bob (Bob has g01-l09 only)
    activeSession = bob
    r.backend.fetchAllResults.push({
      ok: true,
      records: [rec('g01-l09', 'completed')],
      serverDate: null,
      unfilteredGet: true,
    })
    r.publishSession(bob)

    expect(r.backend.fetchSignals[0]?.aborted).toBe(true)
    await settle(5)

    // Alice's delayed fetchAll resolves late with g01-l01 completed
    delayedAliceFetch.resolve({
      ok: true,
      records: [rec('g01-l01', 'completed')],
      serverDate: null,
      unfilteredGet: true,
    })
    await initialLoad
    await settle(5)

    expect(r.store.snapshot().owner).toBe('bob')
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(r.store.statusOf('g01-l09')).toBe('completed')

    // Manual reload() without subscribeSession respects getSession switching cleanly without sticky latestSubSession
    activeSession = alice
    r.backend.fetchAllResults.push({
      ok: true,
      records: [rec('g01-l01', 'completed')],
      serverDate: null,
      unfilteredGet: true,
    })
    await r.store.reload()
    expect(r.store.snapshot().owner).toBe('alice')
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    expect(r.store.statusOf('g01-l09')).toBe('not_started')
  })
})

describe('persistence', () => {
  it('unreadable stored state starts empty and keeps a copy for diagnosis', async () => {
    const r = rig()
    r.storage.map.set(KEY, '{not json')
    await r.store.load()
    expect(r.store.isReady()).toBe(true)
    expect(r.store.pending()).toBe(0)
    expect(r.storage.map.get(`${KEY}:corrupt`)).toBe('{not json')
    expect(stored(r.storage).schema).toBe(1) // replaced by a valid state
    expect(r.store.snapshot().log.some((l) => l.includes(':corrupt'))).toBe(true)
  })

  it('a schema this version does not know is treated as corrupt, not interpreted', async () => {
    const raw = JSON.stringify({ schema: 2, owner: null, server: {}, outbox: [{ nope: true }] })
    const r = rig()
    r.storage.map.set(KEY, raw)
    await r.store.load()
    expect(r.storage.map.get(`${KEY}:corrupt`)).toBe(raw)
    expect(r.store.pending()).toBe(0)
  })

  it('parsePersistedState drops malformed entries but keeps the rest', () => {
    const state = parsePersistedState(
      JSON.stringify({
        schema: 1,
        owner: 'a',
        server: { x: rec('g01-l01', 'completed'), y: { lectureId: 'g01-l02', status: 'weird' } },
        outbox: [op('g01-l01', 'completed', 5), { id: 1 }],
        seedVersion: 3,
        migratedV1: 'yes',
        skewMs: 'x',
      }),
    )
    expect(Object.keys(state?.server ?? {})).toEqual(['g01-l01'])
    expect(state?.outbox).toHaveLength(1)
    expect(state).toMatchObject({ owner: 'a', seedVersion: null, migratedV1: false, skewMs: 0 })
    expect(parsePersistedState('[]')).toBeNull()
    expect(parsePersistedState('null')).toBeNull()
  })

  it('a pending write survives a reload and is sent by the next store', async () => {
    const first = rig()
    first.backend.sendResults.push({ ok: false, error: { retryable: true } })
    first.store.set('g01-l01', 'completed')
    await first.store.flush()
    expect(first.store.pending()).toBe(1)

    const second = rig({ storage: first.storage, clock: first.clock })
    await second.store.load()
    expect(second.store.statusOf('g01-l01')).toBe('completed')
    await second.store.flush({ force: true })
    expect(second.backend.sent.flat().map((o) => o.lectureId)).toContain('g01-l01')
    expect(second.store.pending()).toBe(0)
  })

  it('storage that refuses writes degrades to memory without losing the write', async () => {
    const r = rig()
    r.storage.failWrites = true
    expect(() => r.store.set('g01-l01', 'completed')).not.toThrow()
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
    expect(r.store.snapshot().log.some((l) => l.includes('memory only'))).toBe(true)
  })

  it('works with no storage at all (private mode, SSR)', async () => {
    const r = rig({ storage: null })
    await r.store.load()
    r.store.set('g01-l01', 'completed')
    expect(r.store.statusOf('g01-l01')).toBe('completed')
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
  })

  it('reset forgets everything that was persisted', async () => {
    const r = rig()
    r.store.set('g01-l01', 'completed')
    r.store.reset()
    expect(r.store.pending()).toBe(0)
    expect(r.store.statusOf('g01-l01')).toBe('not_started')
    expect(stored(r.storage)).toMatchObject({ owner: null, outbox: [], migratedV1: false })
    expect(r.events.at(-1)).toEqual({ kind: 'reset' })
  })
})

describe('several tabs', () => {
  it('a storage event from another tab refreshes this one without a reload', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const a = rig({ storage, clock })
    const b = rig({ storage, clock })
    await a.store.load()
    await b.store.load()
    a.backend.sendResults.push({ ok: false, error: { retryable: true } })
    a.store.set('g01-l01', 'completed')
    expect(b.store.statusOf('g01-l01')).toBe('not_started')

    b.events.length = 0
    b.target.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }))
    expect(b.store.statusOf('g01-l01')).toBe('completed')
    expect(b.events).toContainEqual({ kind: 'reset' })
  })

  it('a value another tab left unreadable is copied aside before this tab starts over', async () => {
    const storage = new MemoryStorage()
    const b = rig({ storage })
    await b.store.load()
    storage.map.set(KEY, '{half written')
    b.target.dispatchEvent(Object.assign(new Event('storage'), { key: KEY }))
    expect(storage.map.get(`${KEY}:corrupt`)).toBe('{half written')
    expect(b.store.pending()).toBe(0)
  })

  it('storage events for other keys are ignored', async () => {
    const storage = new MemoryStorage()
    const a = rig({ storage })
    const b = rig({ storage })
    await a.store.load()
    await b.store.load()
    a.store.set('g01-l01', 'completed')
    b.events.length = 0
    b.target.dispatchEvent(Object.assign(new Event('storage'), { key: 'something-else' }))
    expect(b.events).toEqual([])
  })

  it('a write in one tab does not erase a write the other tab made meanwhile', async () => {
    const storage = new MemoryStorage()
    const clock = new FakeClock()
    const a = rig({ storage, clock })
    const b = rig({ storage, clock })
    await a.store.load()
    await b.store.load()
    a.backend.sendResults.push({ ok: false, error: { retryable: true } }, { ok: false, error: { retryable: true } })
    b.backend.sendResults.push({ ok: false, error: { retryable: true } }, { ok: false, error: { retryable: true } })
    a.store.set('g01-l01', 'completed')
    b.store.set('g01-l02', 'completed') // b never saw a's event
    const outbox = stored(storage).outbox as OutboxOp[]
    expect(outbox.map((o) => o.lectureId).sort()).toEqual(['g01-l01', 'g01-l02'])
    expect(b.store.statusOf('g01-l01')).toBe('completed')
  })
})

describe('sending lock', () => {
  it('sends under the Web Lock of the plan', async () => {
    const r = rig()
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.locks.names).toEqual([OUTBOX_LOCK_NAME])
    expect(OUTBOX_LOCK_NAME).toBe('tut:v2:progress-outbox')
  })

  it('sends directly when there are no locks', async () => {
    const r = rig({ locks: null })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
  })

  it('sends directly when requesting the lock throws', async () => {
    const r = rig({
      locks: {
        request: () => Promise.reject(new Error('SecurityError')),
      },
    })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
    expect(r.store.pending()).toBe(0)
  })

  it('a send that fails inside the lock is not run a second time', async () => {
    const calls: number[] = []
    const r = rig({
      locks: {
        async request<T>(_name: string, cb: () => Promise<T>): Promise<T> {
          calls.push(1)
          return cb()
        },
      },
    })
    r.backend.sendResults.push({ ok: false, error: { retryable: true } })
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(r.backend.sent).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })
})

describe('subscriptions', () => {
  it('unsubscribe stops events; a throwing listener does not stop the others', () => {
    const r = rig()
    const seen: string[] = []
    r.store.subscribe(() => {
      throw new Error('bad listener')
    })
    const off = r.store.subscribe((e) => seen.push(e.kind))
    r.store.set('g01-l01', 'completed')
    expect(seen).toContain('change')
    off()
    seen.length = 0
    r.store.set('g01-l02', 'completed')
    expect(seen).toEqual([])
  })

  it('subscribeSync fires when the pending count or sync state changes', async () => {
    const r = rig()
    let n = 0
    r.store.subscribeSync(() => n++)
    r.store.set('g01-l01', 'completed')
    await r.store.flush()
    expect(n).toBeGreaterThanOrEqual(2)
  })
})

describe('completedAtOf', () => {
  it('is the newest pending write, then the server record, then the seed, else null', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('s1', rec('g01-l01', 'completed', { completedAt: '2026-10-01T00:00:00.000Z' }), rec('g01-l02', 'completed', { completedAt: '2026-10-02T00:00:00.000Z' }), rec('g01-l03', 'completed', { completedAt: '2026-10-03T00:00:00.000Z' })) })
    persisted(r.storage, {
      server: serverOf(rec('g01-l02', 'completed', { completedAt: '2026-11-02T00:00:00.000Z' }), rec('g01-l03', 'completed', { completedAt: '2026-11-03T00:00:00.000Z' }), rec('g01-l04', 'in_progress')),
      outbox: [op('g01-l03', 'not_started', r.clock.t, { nextAt: r.clock.t + 60_000 }), op('g01-l05', 'completed', Date.parse('2026-11-17T10:30:00.000Z'), { nextAt: r.clock.t + 60_000 })],
    })
    await r.store.load()
    expect(r.store.completedAtOf('g01-l01')).toBe('2026-10-01T00:00:00.000Z') // seed only
    expect(r.store.completedAtOf('G01-L02')).toBe('2026-11-02T00:00:00.000Z') // server beats seed, ids normalised
    expect(r.store.completedAtOf('g01-l03')).toBeNull() // a pending write that is not `completed` hides the old time
    expect(r.store.completedAtOf('g01-l04')).toBeNull() // server record without a time
    expect(r.store.completedAtOf('g01-l05')).toBe('2026-11-17T10:30:00.000Z') // pending `completed`: the time of the write
    expect(r.store.completedAtOf('g01-l99')).toBeNull()
  })

  it('a server record that is no longer completed hides the seed\'s completion time', async () => {
    const r = rig({ backend: new ScriptedBackend('local'), loadSeed: seedOf('s1', rec('g02-l01', 'completed', { completedAt: '2026-10-01T00:00:00.000Z' })) })
    persisted(r.storage, { server: serverOf(rec('g02-l01', 'in_progress', { completedAt: null })) })
    await r.store.load()
    expect(r.store.statusOf('g02-l01')).toBe('in_progress')
    expect(r.store.completedAtOf('g02-l01')).toBeNull()
  })

  it('follows a write made on this page', async () => {
    const r = rig({ backend: new ScriptedBackend('local') })
    await r.store.load()
    r.store.set('g01-l07', 'completed')
    expect(r.store.completedAtOf('g01-l07')).toBe(r.clock.iso())
    r.store.set('g01-l07', 'in_progress')
    expect(r.store.completedAtOf('g01-l07')).toBeNull()
  })
})
