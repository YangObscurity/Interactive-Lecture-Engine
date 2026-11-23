import { describe, expect, it } from 'vitest'
import { planV1Migration, readV1Progress } from '../../docs/.vitepress/theme/progress/v1Migration'
import { createProgressStore } from '../../docs/.vitepress/theme/progress/progressStore'
import { PROGRESS_WIRE_STATUS, STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import { FakeClock, FakeScheduler, MemoryStorage, ScriptedBackend, rec, settle } from './progress-helpers'

const P = STORAGE_KEYS.neonPrefix
const W = PROGRESS_WIRE_STATUS

function v1(id: string, status: string, updated: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ lecture_id: id, group_id: id.split('-')[0], status, updated_at: updated, completed_at: null, notion_node_id: null, notion_page_id: null, ...extra })
}

function seedStorage(): MemoryStorage {
  const s = new MemoryStorage()
  s.setItem(`${P}progress_all_map`, JSON.stringify({
    'g01-l01': JSON.parse(v1('g01-l01', W.completed, '2026-11-01T00:00:00.000Z')),
    'G01-L02': JSON.parse(v1('G01-L02', W.in_progress, '2026-11-02T00:00:00.000Z')),
  }))
  s.setItem(`${P}progress_g01-l02`, v1('g01-l02', W.completed, '2026-11-03T00:00:00.000Z')) // newer than the map entry
  s.setItem(`${P}progress_g01-l03`, v1('g01-l03', W.in_progress, '2026-11-04T00:00:00.000Z')) // only per-lecture key
  s.setItem(`${P}progress_G02-L01`, v1('G02-L01', W.in_progress, '2026-11-05T00:00:00.000Z')) // upper-case key
  s.setItem(`${P}progress_g02-l02`, '{broken') // unreadable: skipped
  s.setItem(`${P}progress_g02-l03`, v1('g02-l03', 'unknown-status', '2026-11-05T00:00:00.000Z')) // not a status
  s.setItem(`${P}sessions_g01-l01`, '[]') // not progress
  return s
}

describe('readV1Progress', () => {
  it('takes the union of the map and the per-lecture keys, lower-cases ids and keeps the newer record', () => {
    const got = readV1Progress(seedStorage())
    const byId = Object.fromEntries(got.map((r) => [r.lectureId, r]))
    expect(Object.keys(byId).sort()).toEqual(['g01-l01', 'g01-l02', 'g01-l03', 'g02-l01'])
    expect(byId['g01-l02']?.status).toBe('completed') // per-lecture key was newer than the map
    expect(byId['g01-l02']?.updatedAt).toBe(Date.parse('2026-11-03T00:00:00.000Z'))
    expect(byId['g02-l01']?.groupId).toBe('g02')
  })

  it('never writes', () => {
    const s = seedStorage()
    const before = JSON.stringify([...s.map.entries()])
    readV1Progress(s)
    expect(JSON.stringify([...s.map.entries()])).toBe(before)
  })

  it('an empty or unreadable storage gives nothing', () => {
    expect(readV1Progress(new MemoryStorage())).toEqual([])
    const s = new MemoryStorage()
    s.setItem(`${P}progress_all_map`, 'not json')
    expect(readV1Progress(s)).toEqual([])
  })
})

describe('planV1Migration', () => {
  const now = Date.parse('2026-11-18T00:00:00.000Z')
  let n = 0
  const newId = () => `m${++n}`
  const seed = new Map([rec('g01-l01', 'completed'), rec('g01-l02', 'in_progress')].map((r) => [r.lectureId, r]))

  it('ignores records equal to the seed and queues the others with the V1 time', () => {
    const ops = planV1Migration({
      v1: [
        { lectureId: 'g01-l01', groupId: 'g01', status: 'completed', updatedAt: 1 }, // same as seed
        { lectureId: 'g01-l02', groupId: 'g01', status: 'completed', updatedAt: 1000 }, // differs
        { lectureId: 'g09-l01', groupId: 'g09', status: 'not_started', updatedAt: 5 }, // no seed entry: base is not started
        { lectureId: 'g09-l02', groupId: 'g09', status: 'in_progress', updatedAt: 0 }, // no usable V1 time
      ],
      seed,
      now,
      newId,
    })
    expect(ops.map((o) => [o.lectureId, o.status, o.at])).toEqual([
      ['g01-l02', 'completed', 1000],
      ['g09-l02', 'in_progress', now],
    ])
    expect(ops.every((o) => o.attempts === 0 && o.nextAt === now)).toBe(true)
  })

  it('skips lectures that already have a pending write', () => {
    const ops = planV1Migration({
      v1: [{ lectureId: 'g01-l02', groupId: 'g01', status: 'completed', updatedAt: 1000 }],
      seed,
      skip: new Set(['g01-l02']),
      now,
      newId,
    })
    expect(ops).toEqual([])
  })
})

describe('V1 import inside the store', () => {
  function makeStore(storage: MemoryStorage, backend = new ScriptedBackend('rest')) {
    const clock = new FakeClock()
    return {
      backend,
      store: createProgressStore({
        backend,
        storage,
        now: clock.now,
        locks: null,
        scheduler: new FakeScheduler(),
        target: null,
        newId: (() => {
          let i = 0
          return () => `id-${++i}`
        })(),
        loadSeed: async () => ({ version: 's', records: [rec('g01-l01', 'completed'), rec('g01-l02', 'in_progress')] }),
      }),
    }
  }

  it('queues what differs from the seed, sends it, does it only once and keeps the V1 keys', async () => {
    const storage = seedStorage()
    const v1Keys = [...storage.map.keys()].filter((k) => k.startsWith(P))
    const v1Before = v1Keys.map((k) => storage.map.get(k))

    const first = makeStore(storage)
    await first.store.load()
    await settle()
    // seed: l01 completed (V1 same -> ignored), l02 in_progress (V1 completed -> queued), l03 and g02-l01 not in seed (queued)
    const sentIds = first.backend.sent.flat().map((o) => o.lectureId).sort()
    expect(sentIds).toEqual(['g01-l02', 'g01-l03', 'g02-l01'])
    expect(first.backend.sent.flat().find((o) => o.lectureId === 'g01-l02')?.at).toBe(Date.parse('2026-11-03T00:00:00.000Z'))
    expect(JSON.parse(storage.map.get(STORAGE_KEYS.progressV2) ?? '{}')).toMatchObject({ migratedV1: true })
    expect(first.store.snapshot().log.some((l) => l.includes('V1 import: 4 record(s) found, 3 differ'))).toBe(true)

    // a second page load imports nothing, even though V1 data is still there
    const second = makeStore(storage)
    await second.store.load()
    await settle()
    expect(second.backend.sent.flat().map((o) => o.lectureId)).not.toContain('g01-l03')
    expect(second.store.snapshot().log.some((l) => l.includes('V1 import'))).toBe(false)

    expect(v1Keys.map((k) => storage.map.get(k))).toEqual(v1Before) // V1 keys untouched
    expect([...storage.map.keys()].filter((k) => k.startsWith(P))).toEqual(v1Keys)
  })

  it('the server wins over an imported record that it has since changed', async () => {
    const storage = new MemoryStorage()
    storage.setItem(`${P}progress_g01-l02`, v1('g01-l02', W.completed, '2026-11-03T00:00:00.000Z'))
    const backend = new ScriptedBackend('rest')
    backend.fetchAllResult = {
      ok: true,
      records: [rec('g01-l02', 'in_progress', { updatedAt: '2026-11-10T00:00:00.000Z' })],
      serverDate: null,
      unfilteredGet: true,
    }
    const { store } = makeStore(storage, backend)
    await store.load()
    await settle()
    expect(backend.sent).toHaveLength(0)
    expect(store.statusOf('g01-l02')).toBe('in_progress')
  })

  it('with no V1 data nothing is queued, and the flag is still set', async () => {
    const storage = new MemoryStorage()
    const { store, backend } = makeStore(storage)
    await store.load()
    await settle()
    expect(backend.sent).toHaveLength(0)
    expect(JSON.parse(storage.map.get(STORAGE_KEYS.progressV2) ?? '{}')).toMatchObject({ migratedV1: true })
  })
})
