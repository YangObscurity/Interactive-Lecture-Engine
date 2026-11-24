import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runDbCli } from '../../scripts/db.js'
import { createDb, type Db } from '../../src/db/index.js'
import {
  computeMigrationChecksum,
  getMigrationStatus,
  MigrationChecksumError,
  runMigrations,
} from '../../src/db/migrate.js'
import { upsertProgress } from '../../src/repo/progress.js'

const tempDirs: string[] = []
const dbsToClose: Db[] = []

function makeTempDir(prefix = 'lecture-api-m2-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function trackDb(db: Db): Db {
  dbsToClose.push(db)
  return db
}

afterEach(async () => {
  while (dbsToClose.length > 0) {
    const db = dbsToClose.pop()!
    await db.close()
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createDb & PGliteDb', () => {
  it('rejects invalid or unsupported database URLs without leaking the secret/URL', () => {
    const sentinel = 'super-secret-db-pass-98765'
    const badUrls = [
      '',
      '   ',
      `mysql://user:${sentinel}@db.example.com/lecture`,
      'pglite:',
      'pglite:   ',
      `postgres://user:${sentinel}@:5432/db`,
      `postgresql:///missing_host?password=${sentinel}`,
      `pglite:bad\npath-${sentinel}`,
    ]

    for (const bad of badUrls) {
      let caught: Error | undefined
      try {
        createDb(bad)
      } catch (err) {
        caught = err as Error
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught?.message).not.toContain(sentinel)
    }
  })

  it('supports pglite:memory, multi-statement query, tx commit/rollback, and post-close rejection', async () => {
    const db = trackDb(createDb('pglite:memory'))
    expect(db.kind).toBe('pglite')

    await db.exec('CREATE TABLE items (id int PRIMARY KEY, label text NOT NULL);')

    const multi = await db.query<{ val: number }>('SELECT 1 AS val; SELECT 2 AS val;')
    expect(multi.rows[0]?.val).toBe(2)

    const inserted = await db.query(
      'INSERT INTO items (id, label) VALUES ($1, $2)',
      [1, 'a;b'],
    )
    expect(inserted.rowCount).toBe(1)

    const updated = await db.query(
      'UPDATE items SET label = $2 WHERE id = $1',
      [1, 'updated'],
    )
    expect(updated.rowCount).toBe(1)

    const selected = await db.query<{ label: string }>(
      'SELECT label FROM items WHERE id = $1',
      [1],
    )
    expect(selected.rowCount).toBe(1)
    expect(selected.rows[0]?.label).toBe('updated')

    // Rolled-back transaction leaves state untouched
    await expect(
      db.tx(async (tx) => {
        await tx.query('INSERT INTO items (id, label) VALUES ($1, $2)', [2, 'temp'])
        throw new Error('force rollback')
      }),
    ).rejects.toThrow('force rollback')

    const afterRollback = await db.query<{ id: number }>('SELECT id FROM items ORDER BY id')
    expect(afterRollback.rows).toEqual([{ id: 1 }])

    // Committed transaction persists
    await db.tx(async (tx) => {
      await tx.query('INSERT INTO items (id, label) VALUES ($1, $2)', [3, 'committed'])
    })
    const afterCommit = await db.query<{ id: number }>('SELECT id FROM items ORDER BY id')
    expect(afterCommit.rows).toEqual([{ id: 1 }, { id: 3 }])

    // Multi-statement with dollar-quoted string containing semicolons
    const dollarMulti = await db.query<{ val: number }>(
      "SELECT $tag$hello;semicolon$tag$ AS msg; SELECT 42 AS val;",
    )
    expect(dollarMulti.rows[0]?.val).toBe(42)

    // Re-entrant db.query/tx inside db.tx is rejected instead of deadlocking
    await expect(
      db.tx(async () => {
        await db.query('SELECT 1')
      }),
    ).rejects.toThrow(/Re-entrant/i)

    await db.close()
    await db.close() // idempotent close
    await expect(db.query('SELECT 1')).rejects.toThrow(/closed/i)
  })

  it('persists data in pglite:<nested-dir> across close and reopen', async () => {
    const base = makeTempDir('pglite-persist-')
    const nestedDir = join(base, 'nested', 'store')

    const db1 = createDb(`pglite:${nestedDir}`)
    await runMigrations(db1)
    await upsertProgress(db1, 'alice', { lecture_id: 'g01-l01', status: '学习中' })
    await db1.close()

    const db2 = trackDb(createDb(`pglite:${nestedDir}`))
    const status = await getMigrationStatus(db2)
    expect(status.applied).toHaveLength(3)
    expect(status.pending).toHaveLength(0)

    const rows = await db2.query<{ lecture_id: string; status: string }>(
      'SELECT lecture_id, status FROM progress WHERE user_id = $1',
      ['alice'],
    )
    expect(rows.rows).toEqual([{ lecture_id: 'g01-l01', status: '学习中' }])
  })

  it('serializes 20 concurrent transactions and queries safely via mutex', async () => {
    const db = trackDb(createDb('pglite:memory://'))
    await db.exec('CREATE TABLE counter (id int PRIMARY KEY, n int NOT NULL); INSERT INTO counter VALUES (1, 0);')

    const tasks = Array.from({ length: 20 }, (_, i) =>
      db.tx(async (tx) => {
        const res = await tx.query<{ n: number }>('SELECT n FROM counter WHERE id = 1')
        const cur = res.rows[0]!.n
        await tx.query('UPDATE counter SET n = $1 WHERE id = 1', [cur + 1])
        return i
      }),
    )

    const indices = await Promise.all(tasks)
    expect(indices).toHaveLength(20)

    const finalRes = await db.query<{ n: number }>('SELECT n FROM counter WHERE id = 1')
    expect(finalRes.rows[0]?.n).toBe(20)
  })
})

describe('migrations & runner', () => {
  it('0001_init.sql and 0002_ai_checklists.sql are forward-only with zero DROP statements', () => {
    const sqlPath1 = resolve(
      fileURLToPath(import.meta.url),
      '../../../migrations/0001_init.sql',
    )
    const sql1 = readFileSync(sqlPath1, 'utf8')
    expect(sql1.toUpperCase()).not.toMatch(/\bDROP\b/)
    expect(sql1).toContain('CREATE TABLE IF NOT EXISTS progress')
    expect(sql1).toContain('CREATE TABLE IF NOT EXISTS idempotency_keys')
    expect(sql1).toContain('idx_progress_user_group')
    expect(sql1).toContain('idx_idempotency_keys_created_at')

    const sqlPath2 = resolve(
      fileURLToPath(import.meta.url),
      '../../../migrations/0002_ai_checklists.sql',
    )
    const sql2 = readFileSync(sqlPath2, 'utf8')
    expect(sql2.toUpperCase()).not.toMatch(/\bDROP\b/)
    expect(sql2).toContain('CREATE TABLE IF NOT EXISTS ai_sessions')
    expect(sql2).toContain('CREATE TABLE IF NOT EXISTS ai_messages')
    expect(sql2).toContain('CREATE TABLE IF NOT EXISTS ai_review_checklists')
  })

  it('keeps getMigrationStatus and --dry-run strictly read-only on an empty DB', async () => {
    const db = trackDb(createDb('pglite:memory'))

    const status = await getMigrationStatus(db)
    expect(status.applied).toEqual([])
    expect(status.pending.map((m) => m.filename)).toEqual([
      '0001_init.sql',
      '0002_ai_checklists.sql',
      '0003_auth_and_admin_settings.sql',
    ])

    const dry = await runMigrations(db, { dryRun: true })
    expect(dry.applied).toEqual([])
    expect(dry.dryRunSql).toContain('0001_init.sql')
    expect(dry.dryRunSql).toContain('0002_ai_checklists.sql')
    expect(dry.dryRunSql).toContain('0003_auth_and_admin_settings.sql')
    expect(dry.dryRunSql).toContain('CREATE TABLE IF NOT EXISTS progress')
    expect(dry.dryRunSql).toContain('CREATE TABLE IF NOT EXISTS ai_sessions')
    expect(dry.dryRunSql).toContain('CREATE TABLE IF NOT EXISTS auth_users')

    // Neither schema_migrations nor progress was created
    const tables = await db.query<{ sm: string | null; pr: string | null }>(
      "SELECT to_regclass('public.schema_migrations') AS sm, to_regclass('public.progress') AS pr",
    )
    expect(tables.rows[0]).toEqual({ sm: null, pr: null })
  })

  it('applies migrations idempotently and logs skipped advisory lock on PGlite', async () => {
    const db = trackDb(createDb('pglite:memory'))
    const logs: string[] = []

    const first = await runMigrations(db, { log: (m) => logs.push(m) })
    expect(first.applied).toEqual([
      '0001_init.sql',
      '0002_ai_checklists.sql',
      '0003_auth_and_admin_settings.sql',
    ])
    expect(logs.some((l) => l.includes('pg_advisory_lock') && l.includes('PGlite'))).toBe(true)

    const statusAfter = await getMigrationStatus(db)
    expect(statusAfter.applied).toHaveLength(3)
    expect(statusAfter.applied[0]?.name).toBe('0001_init.sql')
    expect(statusAfter.applied[1]?.name).toBe('0002_ai_checklists.sql')
    expect(statusAfter.applied[2]?.name).toBe('0003_auth_and_admin_settings.sql')
    expect(statusAfter.applied[0]?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(statusAfter.pending).toEqual([])

    const second = await runMigrations(db, { log: (m) => logs.push(m) })
    expect(second.applied).toEqual([])

    const dryAfter = await runMigrations(db, { dryRun: true })
    expect(dryAfter.dryRunSql).toBe('')
  })

  it('normalizes CRLF vs LF checksums, orders numerically, detects checksum mismatch, and rolls back failed migrations', async () => {
    expect(computeMigrationChecksum('SELECT 1;\r\nSELECT 2;\r\n')).toBe(
      computeMigrationChecksum('SELECT 1;\nSELECT 2;\n'),
    )

    const migDir = makeTempDir('custom-migs-')
    writeFileSync(join(migDir, '0001_first.sql'), 'CREATE TABLE t1 (id int PRIMARY KEY);\n')
    writeFileSync(join(migDir, '0002_second.sql'), 'CREATE TABLE t2 (id int PRIMARY KEY);\n')
    writeFileSync(join(migDir, '0010_tenth.sql'), 'CREATE TABLE t10 (id int PRIMARY KEY);\n')

    const db = trackDb(createDb('pglite:memory'))
    const res = await runMigrations(db, { migrationsDir: migDir, log: () => {} })
    expect(res.applied).toEqual(['0001_first.sql', '0002_second.sql', '0010_tenth.sql'])

    // Modify 0002_second.sql -> checksum mismatch
    writeFileSync(join(migDir, '0002_second.sql'), 'CREATE TABLE t2 (id int PRIMARY KEY, x text);\n')
    await expect(getMigrationStatus(db, { migrationsDir: migDir })).rejects.toThrow(
      MigrationChecksumError,
    )
    await expect(
      runMigrations(db, { migrationsDir: migDir, log: () => {} }),
    ).rejects.toThrow(MigrationChecksumError)

    // Restore 0002, add failing 0011_bad.sql -> rolls back t11_partial and does not record 11
    writeFileSync(join(migDir, '0002_second.sql'), 'CREATE TABLE t2 (id int PRIMARY KEY);\n')
    writeFileSync(
      join(migDir, '0011_bad.sql'),
      'CREATE TABLE t11_partial (id int PRIMARY KEY);\nSELECT * FROM non_existent_table_xyz;\n',
    )

    await expect(
      runMigrations(db, { migrationsDir: migDir, log: () => {} }),
    ).rejects.toThrow()

    const checkPartial = await db.query<{ r: string | null }>(
      "SELECT to_regclass('public.t11_partial') AS r",
    )
    expect(checkPartial.rows[0]?.r).toBeNull()

    const ledger = await db.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    )
    expect(ledger.rows.map((r) => r.version)).toEqual([1, 2, 10])
  })
})

describe('scripts/db.ts CLI', () => {
  it('supports DATABASE_URL_DIRECT alone, --dry-run, migrate, status, and secret redaction', async () => {
    const dir = makeTempDir('cli-db-')
    const dbPath = join(dir, 'store')
    const out: string[] = []
    const errOut: string[] = []

    const dryCode = await runDbCli(['migrate', '--dry-run'], {
      env: { DATABASE_URL_DIRECT: `pglite:${dbPath}` },
      envFile: false,
      log: (m) => out.push(m),
      error: (m) => errOut.push(m),
    })
    expect(dryCode).toBe(0)
    expect(out.join('\n')).toContain('CREATE TABLE IF NOT EXISTS progress')
    expect(errOut).toEqual([])

    out.length = 0
    const statusBefore = await runDbCli(['status'], {
      env: { DATABASE_URL_DIRECT: `pglite:${dbPath}` },
      envFile: false,
      log: (m) => out.push(m),
      error: (m) => errOut.push(m),
    })
    expect(statusBefore).toBe(0)
    expect(out.join('\n')).toContain('Pending migrations: 3')

    out.length = 0
    const migCode = await runDbCli(['migrate'], {
      env: { DATABASE_URL_DIRECT: `pglite:${dbPath}` },
      envFile: false,
      log: (m) => out.push(m),
      error: (m) => errOut.push(m),
    })
    expect(migCode).toBe(0)
    expect(out.join('\n')).toContain('0001_init.sql')

    // Secret redaction on invalid DATABASE_URL_DIRECT
    const sentinel = 'secret-cli-token-444555'
    errOut.length = 0
    const badCode = await runDbCli(['status'], {
      env: { DATABASE_URL_DIRECT: `mysql://user:${sentinel}@host/db` },
      envFile: false,
      log: (m) => out.push(m),
      error: (m) => errOut.push(m),
    })
    expect(badCode).toBe(1)
    expect(errOut.join('\n')).toContain('DATABASE_URL_DIRECT')
    expect(errOut.join('\n')).toContain('set (length ')
    expect(errOut.join('\n')).not.toContain(sentinel)
  })

  it('enforces --yes confirmation gate and prints counts on db:reassign', async () => {
    const dir = makeTempDir('cli-reassign-')
    const dbPath = join(dir, 'store')
    const dbUrl = `pglite:${dbPath}`

    const db = createDb(dbUrl)
    await runMigrations(db)
    await upsertProgress(db, 'anonymous', { lecture_id: 'g01-l01', status: '学习中' })
    await upsertProgress(db, 'anonymous', { lecture_id: 'g01-l02', status: '已完成' })
    await upsertProgress(db, 'alice', { lecture_id: 'g01-l02', status: '未开始' })
    await db.close()

    const logs: string[] = []
    const errs: string[] = []
    const noYesCode = await runDbCli(
      ['reassign', '--from', 'anonymous', '--to', 'alice'],
      {
        env: { DATABASE_URL: dbUrl },
        envFile: false,
        log: (m) => logs.push(m),
        error: (m) => errs.push(m),
      },
    )
    expect(noYesCode).toBe(1)
    expect(logs.join('\n')).toContain('from="anonymous" (2 rows)')
    expect(logs.join('\n')).toContain('to="alice" (1 rows)')
    expect(logs.join('\n')).toContain('overlap=1')
    expect(errs.join('\n')).toContain('--yes')

    logs.length = 0
    errs.length = 0
    const yesCode = await runDbCli(
      ['reassign', '--from=anonymous', '--to=alice', '--yes'],
      {
        env: { DATABASE_URL: dbUrl },
        envFile: false,
        log: (m) => logs.push(m),
        error: (m) => errs.push(m),
      },
    )
    expect(yesCode).toBe(0)
    expect(errs).toEqual([])
    expect(logs.join('\n')).toContain('Reassigned 2 row(s)')

    const verifyDb = trackDb(createDb(dbUrl))
    const anonRows = await verifyDb.query('SELECT * FROM progress WHERE user_id = $1', ['anonymous'])
    expect(anonRows.rows).toHaveLength(0)
    const aliceRows = await verifyDb.query<{ lecture_id: string }>(
      'SELECT lecture_id FROM progress WHERE user_id = $1 ORDER BY lecture_id',
      ['alice'],
    )
    expect(aliceRows.rows.map((r) => r.lecture_id)).toEqual(['g01-l01', 'g01-l02'])
  })
})
