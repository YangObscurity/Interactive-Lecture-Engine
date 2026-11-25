import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { afterEach, describe, expect, it } from 'vitest'
import { createDb, type Db } from '../../src/db/index.js'
import { getMigrationStatus, runMigrations } from '../../src/db/migrate.js'
import {
  getAllProgress,
  reassignUserProgress,
  upsertProgress,
  upsertProgressBatch,
} from '../../src/repo/progress.js'

interface WireHarness {
  pglite: PGlite
  server: PGLiteSocketServer
  db: Db
  url: string
  secretPass: string
}

const harnesses: WireHarness[] = []

async function startWireHarness(): Promise<WireHarness> {
  const pglite = await PGlite.create('memory://')
  const server = new PGLiteSocketServer({
    db: pglite,
    host: '127.0.0.1',
    port: 0,
    maxConnections: 20,
  })
  await server.start()

  const secretPass = 'wire-secret-token-999'
  const url = `postgres://postgres:${secretPass}@${server.getServerConn()}/postgres?sslmode=disable`
  const db = createDb(url)

  const harness = { pglite, server, db, url, secretPass }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!
    await h.db.close()
    await h.server.stop()
    await h.pglite.close()
  }
})

describe('PgDb over real Postgres TCP wire protocol (@electric-sql/pglite-socket)', () => {
  it('runs migrations with pg_advisory_lock/unlock, exercises repo/progress CRUD/batch/reassign, and redacts secrets', async () => {
    const { db, secretPass } = await startWireHarness()
    expect(db.kind).toBe('pg')

    // Read-only status before migration
    const statusBefore = await getMigrationStatus(db)
    expect(statusBefore.applied).toEqual([])
    expect(statusBefore.pending.map((m) => m.filename)).toEqual([
      '0001_init.sql',
      '0002_ai_checklists.sql',
      '0003_auth_and_admin_settings.sql',
    ])

    // Apply migrations over real TCP wire protocol using withSession + pg_advisory_lock
    const logs: string[] = []
    const migRes = await runMigrations(db, { log: (m) => logs.push(m) })
    expect(migRes.applied).toEqual([
      '0001_init.sql',
      '0002_ai_checklists.sql',
      '0003_auth_and_admin_settings.sql',
    ])
    expect(logs.some((l) => l.includes('0001_init.sql'))).toBe(true)
    expect(logs.some((l) => l.includes('0002_ai_checklists.sql'))).toBe(true)
    expect(logs.some((l) => l.includes('0003_auth_and_admin_settings.sql'))).toBe(true)

    const statusAfter = await getMigrationStatus(db)
    expect(statusAfter.applied).toHaveLength(3)
    expect(statusAfter.pending).toEqual([])

    // Error sanitization: preserve PG code while never leaking credentials
    let sqlErr: (Error & { code?: string; client?: unknown }) | undefined
    try {
      await db.query('SELECT * FROM nonexistent_wire_table')
    } catch (err) {
      sqlErr = err as Error & { code?: string; client?: unknown }
    }
    expect(sqlErr).toBeInstanceOf(Error)
    expect(sqlErr?.code).toBe('42P01')
    expect(sqlErr?.client).toBeUndefined()
    expect(sqlErr?.message).not.toContain(secretPass)

    // repo/progress CRUD + batch + reassign over wire protocol
    const t1 = new Date('2026-11-18T11:00:00.100Z')
    const t2 = new Date('2026-11-18T11:05:00.200Z')

    const single = await upsertProgress(
      db,
      'alice',
      { lecture_id: 'G05-L19', status: '已完成', notion_node_id: 'n1' },
      t1,
    )
    expect(single.lecture_id).toBe('g05-l19')
    expect(single.group_id).toBe('g05')
    expect(single.completed_at).toBe(t1.toISOString())

    const batch = await upsertProgressBatch(
      db,
      'anon',
      [
        { lecture_id: 'ai-infra-l01', status: '学习中' },
        { lecture_id: 'g05-l19', status: '未开始' },
        { lecture_id: 'g05-l19', status: '已完成' },
      ],
      t2,
    )
    expect(batch).toHaveLength(3)
    expect(batch[2]?.status).toBe('已完成')

    const reassigned = await reassignUserProgress(db, 'anon', 'alice')
    expect(reassigned.deletedFromRows).toBe(2)

    const aliceRows = await getAllProgress(db, 'alice')
    expect(aliceRows.map((r) => [r.lecture_id, r.status, r.updated_at])).toEqual([
      ['ai-infra-l01', '学习中', t2.toISOString()],
      ['g05-l19', '已完成', t2.toISOString()],
    ])

    // jsonb round-trip through PgDb
    await db.query(
      'INSERT INTO idempotency_keys (user_id, key, fingerprint, status_code, response) VALUES ($1, $2, $3, $4, $5::jsonb)',
      ['alice', 'k1', 'fp1', 200, JSON.stringify({ ok: true, count: 2 })],
    )
    const idem = await db.query<{ response: { ok: boolean; count: number } }>(
      'SELECT response FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      ['alice', 'k1'],
    )
    expect(idem.rows[0]?.response).toEqual({ ok: true, count: 2 })
  })

  it('handles tx commit, tx rollback, aborted-tx COMMIT detection, and concurrent tx() calls', async () => {
    const { db } = await startWireHarness()
    await runMigrations(db, { log: () => {} })

    // Normal rollback on thrown error
    await expect(
      db.tx(async (tx) => {
        await tx.query(
          "INSERT INTO progress (user_id, lecture_id, group_id, status) VALUES ('u1', 'g01-l01', 'g01', '学习中')",
        )
        throw new Error('abort wire tx')
      }),
    ).rejects.toThrow('abort wire tx')

    expect(await getAllProgress(db, 'u1')).toEqual([])

    // Aborted transaction where inner query fails and caller swallows it:
    // Postgres returns command='ROLLBACK' on COMMIT; PgDb.tx MUST throw!
    await expect(
      db.tx(async (tx) => {
        try {
          await tx.query('SELECT * FROM missing_tbl_aborts_tx')
        } catch {
          // Swallowed intentionally to verify COMMIT command === 'ROLLBACK' guard
        }
        return 'should-not-succeed'
      }),
    ).rejects.toThrow(/aborted|rolled back/i)

    // Concurrent transactions over Pool + PGLiteSocketServer
    const concurrent = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        db.tx(async (tx) =>
          upsertProgress(
            tx,
            'concurrent-user',
            { lecture_id: `g01-l${String(idx + 1).padStart(2, '0')}`, status: '学习中' },
            new Date('2026-11-18T12:00:00.000Z'),
          ),
        ),
      ),
    )
    expect(concurrent).toHaveLength(10)
    expect(await getAllProgress(db, 'concurrent-user')).toHaveLength(10)
  })

  it('supports withSession sessionDb query, exec, tx, and nested withSession', async () => {
    const { db } = await startWireHarness()
    if (!db.withSession) {
      throw new Error('withSession expected on pg db')
    }
    const result = await db.withSession(async (session) => {
      await session.exec('CREATE TEMP TABLE tmp_session (id int, val text)')
      await session.query('INSERT INTO tmp_session VALUES ($1, $2)', [1, 'first'])
      const nested = await session.withSession!(async (nestedSession) => {
        await nestedSession.tx(async (tx) => {
          await tx.query('INSERT INTO tmp_session VALUES ($1, $2)', [2, 'second'])
        })
        const res = await nestedSession.query<{ id: number; val: string }>(
          'SELECT id, val FROM tmp_session ORDER BY id',
        )
        return res.rows
      })
      await session.close() // no-op for sessionDb
      return nested
    })
    expect(result).toEqual([
      { id: 1, val: 'first' },
      { id: 2, val: 'second' },
    ])
  })
})

