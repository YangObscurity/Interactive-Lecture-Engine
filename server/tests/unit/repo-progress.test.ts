import { afterEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import {
  deriveGroupId,
  getAllProgress,
  getProgressByGroup,
  getProgressByLecture,
  InvalidLectureIdError,
  InvalidStatusError,
  normalizeLectureId,
  previewReassignUserProgress,
  reassignUserProgress,
  TooManyItemsError,
  upsertProgress,
  upsertProgressBatch,
} from '../../src/repo/progress.js'

const ISO_UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const openDbs: Db[] = []

async function makeMigratedDb(): Promise<Db> {
  const db = createDb('pglite:memory')
  openDbs.push(db)
  await runMigrations(db, { log: () => {} })
  return db
}

afterEach(async () => {
  while (openDbs.length > 0) {
    const db = openDbs.pop()!
    await db.close()
  }
})

describe('repo/progress helpers', () => {
  it('normalizes lecture_id and derives group_id via lastIndexOf("-")', () => {
    expect(normalizeLectureId('  G05-L19  ')).toBe('g05-l19')
    expect(normalizeLectureId('AI-INFRA-L01')).toBe('ai-infra-l01')
    expect(normalizeLectureId('g01-l100')).toBe('g01-l100')

    expect(deriveGroupId('g05-l19')).toBe('g05')
    expect(deriveGroupId('ai-infra-l01')).toBe('ai-infra')

    for (const bad of ['', 'g05', 'g05-l1', '-l01', 'g05_l01', 'g05-x01', 'g05 l01']) {
      expect(() => normalizeLectureId(bad)).toThrow(InvalidLectureIdError)
    }
  })
})

describe('repo/progress CRUD & lifecycle', () => {
  it('isolates data by user_id and supports all/group/lecture queries', async () => {
    const db = await makeMigratedDb()
    const t1 = new Date('2026-11-18T08:00:00.000Z')

    await upsertProgress(db, 'alice', { lecture_id: 'G05-L19', status: '学习中' }, t1)
    await upsertProgress(db, 'alice', { lecture_id: 'AI-INFRA-L01', status: '未开始' }, t1)
    await upsertProgress(db, 'bob', { lecture_id: 'g05-l19', status: '已完成' }, t1)

    const aliceAll = await getAllProgress(db, 'alice')
    expect(aliceAll).toHaveLength(2)
    expect(aliceAll.map((r) => r.lecture_id)).toEqual(['ai-infra-l01', 'g05-l19'])
    expect(aliceAll[0]?.group_id).toBe('ai-infra')
    expect(aliceAll[1]?.group_id).toBe('g05')

    const aliceG05 = await getProgressByGroup(db, 'alice', 'G05')
    expect(aliceG05).toHaveLength(1)
    expect(aliceG05[0]?.status).toBe('学习中')

    const bobOne = await getProgressByLecture(db, 'bob', 'G05-L19')
    expect(bobOne?.status).toBe('已完成')
    expect(bobOne?.completed_at).toBe('2026-11-18T08:00:00.000Z')

    const missing = await getProgressByLecture(db, 'alice', 'g99-l99')
    expect(missing).toBeNull()
  })

  it('preserves explicit group_id on update when omitted and enforces completed_at + updated_at rules', async () => {
    const db = await makeMigratedDb()
    const t1 = new Date('2026-11-18T08:00:00.123Z')
    const t2 = new Date('2026-11-18T08:05:00.456Z')
    const t3 = new Date('2026-11-18T08:10:00.789Z')
    const t4 = new Date('2026-11-18T08:15:00.001Z')

    // Insert with explicit group_id and ignored client timestamps
    const row1 = await upsertProgress(
      db,
      'alice',
      {
        lecture_id: 'g05-l01',
        group_id: 'CUSTOM-GRP',
        status: '学习中',
        completed_at: '1999-01-01T00:00:00.000Z',
        updated_at: '1999-01-01T00:00:00.000Z',
      },
      t1,
    )
    expect(row1.group_id).toBe('custom-grp')
    expect(row1.completed_at).toBeNull()
    expect(row1.updated_at).toBe(t1.toISOString())
    expect(row1.updated_at).toMatch(ISO_UTC_MS_RE)

    // Enter 已完成 without group_id -> preserves custom-grp, sets completed_at = t2
    const row2 = await upsertProgress(
      db,
      'alice',
      { lecture_id: 'g05-l01', status: '已完成' },
      t2,
    )
    expect(row2.group_id).toBe('custom-grp')
    expect(row2.completed_at).toBe(t2.toISOString())
    expect(row2.updated_at).toBe(t2.toISOString())

    // Stay 已完成 -> preserves original completed_at (t2), advances updated_at (t3)
    const row3 = await upsertProgress(
      db,
      'alice',
      { lecture_id: 'g05-l01', status: '已完成' },
      t3,
    )
    expect(row3.completed_at).toBe(t2.toISOString())
    expect(row3.updated_at).toBe(t3.toISOString())

    // Leave 已完成 -> clears completed_at to null
    const row4 = await upsertProgress(
      db,
      'alice',
      { lecture_id: 'g05-l01', status: '学习中' },
      t4,
    )
    expect(row4.completed_at).toBeNull()
    expect(row4.updated_at).toBe(t4.toISOString())
  })

  it('preserves notion_* when omitted and updates or clears when provided', async () => {
    const db = await makeMigratedDb()
    const t1 = new Date('2026-11-18T09:00:00.000Z')
    const t2 = new Date('2026-11-18T09:01:00.000Z')
    const t3 = new Date('2026-11-18T09:02:00.000Z')

    const r1 = await upsertProgress(
      db,
      'alice',
      {
        lecture_id: 'g02-l03',
        status: '学习中',
        notion_node_id: 'node_123',
        notion_page_id: 'page_abc',
      },
      t1,
    )
    expect(r1.notion_node_id).toBe('node_123')
    expect(r1.notion_page_id).toBe('page_abc')

    // Omit notion_* -> preserved
    const r2 = await upsertProgress(
      db,
      'alice',
      { lecture_id: 'g02-l03', status: '已完成' },
      t2,
    )
    expect(r2.notion_node_id).toBe('node_123')
    expect(r2.notion_page_id).toBe('page_abc')

    // Explicit null clears notion_node_id while omitting notion_page_id preserves it
    const r3 = await upsertProgress(
      db,
      'alice',
      { lecture_id: 'g02-l03', status: '已完成', notion_node_id: null },
      t3,
    )
    expect(r3.notion_node_id).toBeNull()
    expect(r3.notion_page_id).toBe('page_abc')
  })

  it('validates status and handles upsertProgressBatch atomicity, 200 cap, duplicates, and order', async () => {
    const db = await makeMigratedDb()
    const t1 = new Date('2026-11-18T10:00:00.000Z')

    expect(await upsertProgressBatch(db, 'alice', [], t1)).toEqual([])

    const tooMany = Array.from({ length: 201 }, (_, i) => ({
      lecture_id: `g01-l${String(i + 1).padStart(2, '0')}`,
      status: '学习中' as const,
    }))
    await expect(upsertProgressBatch(db, 'alice', tooMany, t1)).rejects.toThrow(
      TooManyItemsError,
    )

    // Mid-batch invalid status writes nothing
    await expect(
      upsertProgressBatch(
        db,
        'alice',
        [
          { lecture_id: 'g01-l01', status: '学习中' },
          { lecture_id: 'g01-l02', status: 'invalid-status' },
        ],
        t1,
      ),
    ).rejects.toThrow(InvalidStatusError)
    expect(await getAllProgress(db, 'alice')).toEqual([])

    // Exactly 200 items succeeds
    const exactly200 = tooMany.slice(0, 200)
    const batch200Res = await upsertProgressBatch(db, 'alice', exactly200, t1)
    expect(batch200Res).toHaveLength(200)

    // Duplicate lecture_ids in one batch succeed sequentially and preserve input order
    const t2 = new Date('2026-11-18T10:05:00.000Z')
    const dupRes = await upsertProgressBatch(
      db,
      'bob',
      [
        { lecture_id: 'g03-l02', status: '学习中' },
        { lecture_id: 'g03-l01', status: '未开始' },
        { lecture_id: 'G03-L02', status: '已完成' },
      ],
      t2,
    )
    expect(dupRes.map((r) => [r.lecture_id, r.status])).toEqual([
      ['g03-l02', '学习中'],
      ['g03-l01', '未开始'],
      ['g03-l02', '已完成'],
    ])
    const stored = await getProgressByLecture(db, 'bob', 'g03-l02')
    expect(stored?.status).toBe('已完成')
    expect(stored?.completed_at).toBe(t2.toISOString())
  })

  it('reassigns user progress with newer-updated_at wins and tie keeps target', async () => {
    const db = await makeMigratedDb()
    const tOlder = new Date('2026-11-18T07:00:00.000Z')
    const tTie = new Date('2026-11-18T08:00:00.000Z')
    const tNewer = new Date('2026-11-18T09:00:00.000Z')

    // Only in from -> moved to target
    await upsertProgress(db, 'anon', { lecture_id: 'g01-l01', status: '学习中' }, tOlder)
    // Newer in from -> overwrites target
    await upsertProgress(db, 'anon', { lecture_id: 'g01-l02', status: '已完成' }, tNewer)
    await upsertProgress(db, 'alice', { lecture_id: 'g01-l02', status: '未开始' }, tOlder)
    // Older in from -> target keeps its newer row
    await upsertProgress(db, 'anon', { lecture_id: 'g01-l03', status: '未开始' }, tOlder)
    await upsertProgress(db, 'alice', { lecture_id: 'g01-l03', status: '已完成' }, tNewer)
    // Exact tie -> keeps target (--to) existing row
    await upsertProgress(db, 'anon', { lecture_id: 'g01-l04', status: '未开始' }, tTie)
    await upsertProgress(db, 'alice', { lecture_id: 'g01-l04', status: '学习中' }, tTie)

    await expect(reassignUserProgress(db, 'alice', 'alice')).rejects.toThrow(/different/)

    const preview = await previewReassignUserProgress(db, 'anon', 'alice')
    expect(preview).toEqual({
      fromUserId: 'anon',
      toUserId: 'alice',
      fromCount: 4,
      toCount: 3,
      overlapCount: 3,
      sessions: { fromCount: 0, toCount: 0, overlapCount: 0 },
      messages: { fromCount: 0, toCount: 0, overlapCount: 0 },
      checklists: { fromCount: 0, toCount: 0, overlapCount: 0 },
    })

    const result = await reassignUserProgress(db, 'anon', 'alice')
    expect(result.deletedFromRows).toBe(4)

    expect(await getAllProgress(db, 'anon')).toEqual([])

    const aliceRows = await getAllProgress(db, 'alice')
    expect(aliceRows.map((r) => [r.lecture_id, r.status, r.updated_at])).toEqual([
      ['g01-l01', '学习中', tOlder.toISOString()],
      ['g01-l02', '已完成', tNewer.toISOString()],
      ['g01-l03', '已完成', tNewer.toISOString()],
      ['g01-l04', '学习中', tTie.toISOString()],
    ])
  })
})
