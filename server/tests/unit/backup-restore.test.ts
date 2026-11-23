import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { createPGliteDb } from '../../src/db/pglite.js'
import { runBackup } from '../../scripts/backup.js'
import { runRestore, verifyChecksum } from '../../scripts/restore.js'

describe('server backup and restore', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'lecture-api-br-'))
  const dataDir = join(scratchDir, 'data')
  const backupDir = join(scratchDir, 'backups')

  beforeEach(() => {
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(backupDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('prints pg_dump / pg_restore commands for external PostgreSQL URLs', async () => {
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)

    const bRes = await runBackup({
      databaseUrl: 'postgres://myuser:secret123@db.example.com:5432/proddb',
      backupDir,
      log,
    })
    expect(bRes.kind).toBe('postgres')
    expect(bRes.pgDumpCommand).toContain('pg_dump')
    expect(bRes.pgDumpCommand).not.toContain('secret123')
    expect(bRes.pgDumpCommand).toContain('$DATABASE_URL')

    const rRes = await runRestore({
      databaseUrl: 'postgres://myuser:secret123@db.example.com:5432/proddb',
      archivePath: '/tmp/some-dump.dump',
      log,
    })
    expect(rRes.kind).toBe('postgres')
    expect(rRes.pgRestoreCommand).toContain('pg_restore')
    expect(rRes.pgRestoreCommand).not.toContain('secret123')
    expect(rRes.pgRestoreCommand).toContain('$DATABASE_URL')
  })

  it('performs consistent snapshot of PGlite data directory and restores identical rows', async () => {
    // 1. Initialize PGlite database and insert rows
    const db = createPGliteDb(dataDir)
    await runMigrations(db)
    await db.query(
      `INSERT INTO progress (user_id, lecture_id, group_id, status)
       VALUES ('test-user', 'g01-l01', 'g01', '已完成'),
              ('test-user', 'g01-l02', 'g01', '学习中')`,
    )
    await db.close()

    // 2. Perform backup
    const bRes = await runBackup({
      databaseUrl: `pglite:${dataDir}`,
      backupDir,
      retention: 5,
    })
    expect(bRes.kind).toBe('pglite')
    expect(bRes.archivePath).toBeDefined()
    expect(existsSync(bRes.archivePath!)).toBe(true)
    expect(existsSync(bRes.checksumPath!)).toBe(true)
    expect(verifyChecksum(bRes.archivePath!, bRes.checksumPath!)).toBe(true)

    // 3. Wipe data directory
    rmSync(dataDir, { recursive: true, force: true })
    expect(existsSync(dataDir)).toBe(false)

    // 4. Restore database
    const rRes = await runRestore({
      databaseUrl: `pglite:${dataDir}`,
      archivePath: bRes.archivePath!,
    })
    expect(rRes.kind).toBe('pglite')
    expect(existsSync(dataDir)).toBe(true)

    // 5. Verify restored rows
    const restoredDb = createPGliteDb(dataDir)
    const checkRes = await restoredDb.query<{ lecture_id: string; status: string }>(
      'SELECT lecture_id, status FROM progress ORDER BY lecture_id ASC',
    )
    await restoredDb.close()

    expect(checkRes.rows).toEqual([
      { lecture_id: 'g01-l01', status: '已完成' },
      { lecture_id: 'g01-l02', status: '学习中' },
    ])
  })

  it('refuses to restore into non-empty directory without --force, but keeps old aside with --force', async () => {
    // 1. Create a dummy backup
    const db = createPGliteDb(dataDir)
    await runMigrations(db)
    await db.query(
      `INSERT INTO progress (user_id, lecture_id, group_id, status)
       VALUES ('user-a', 'g01-l01', 'g01', '已完成')`,
    )
    await db.close()

    const bRes = await runBackup({
      databaseUrl: `pglite:${dataDir}`,
      backupDir,
    })

    // 2. Modify existing data directory with a different row
    const db2 = createPGliteDb(dataDir)
    await db2.query(
      `INSERT INTO progress (user_id, lecture_id, group_id, status)
       VALUES ('user-b', 'g02-l01', 'g02', '学习中')`,
    )
    await db2.close()

    // 3. Attempt restore without force -> should throw
    await expect(
      runRestore({
        databaseUrl: `pglite:${dataDir}`,
        archivePath: bRes.archivePath!,
        force: false,
      }),
    ).rejects.toThrow(/Refusing to overwrite without --force/)

    // 4. Restore with force -> should preserve existing directory
    const rRes = await runRestore({
      databaseUrl: `pglite:${dataDir}`,
      archivePath: bRes.archivePath!,
      force: true,
    })
    expect(rRes.preservedDir).toBeDefined()
    expect(existsSync(rRes.preservedDir!)).toBe(true)

    // Verify restored database has user-a and NOT user-b
    const restoredDb = createPGliteDb(dataDir)
    const res = await restoredDb.query<{ user_id: string }>(
      'SELECT user_id FROM progress ORDER BY user_id ASC',
    )
    await restoredDb.close()
    expect(res.rows).toEqual([{ user_id: 'user-a' }])

    // Verify preserved old directory still exists
    expect(readdirSync(rRes.preservedDir!).length).toBeGreaterThan(0)
  })

  it('enforces retention and prunes older archives and checksums', async () => {
    const db = new PGlite(dataDir)
    await db.exec('CREATE TABLE t (x int);')
    await db.close()

    // Run 3 backups with retention = 2
    // We add slight delay or sleep between backups so timestamps or filenames differ
    const r1 = await runBackup({ databaseUrl: `pglite:${dataDir}`, backupDir, retention: 2 })
    // artificial delay to ensure distinct second timestamp if needed
    await new Promise((r) => setTimeout(r, 1100))
    const r2 = await runBackup({ databaseUrl: `pglite:${dataDir}`, backupDir, retention: 2 })
    await new Promise((r) => setTimeout(r, 1100))
    const r3 = await runBackup({ databaseUrl: `pglite:${dataDir}`, backupDir, retention: 2 })

    const files = readdirSync(backupDir).filter((f) => f.endsWith('.tar.gz'))
    expect(files.length).toBe(2)
    expect(files).not.toContain(basename(r1.archivePath!))
    expect(files).toContain(basename(r2.archivePath!))
    expect(files).toContain(basename(r3.archivePath!))
  })

  it('puts the old data directory back when the archive cannot be loaded', async () => {
    const db = createPGliteDb(dataDir)
    await runMigrations(db)
    await db.query(
      `INSERT INTO progress (user_id, lecture_id, group_id, status)
       VALUES ('keep-me', 'g01-l01', 'g01', '已完成')`,
    )
    await db.close()

    const badArchive = join(backupDir, 'lecture-api-backup-20200101-000000.tar.gz')
    writeFileSync(badArchive, 'this is not a tarball')

    await expect(
      runRestore({
        databaseUrl: `pglite:${dataDir}`,
        archivePath: badArchive,
        force: true,
      }),
    ).rejects.toThrow()

    const after = createPGliteDb(dataDir)
    const res = await after.query<{ user_id: string }>('SELECT user_id FROM progress')
    await after.close()
    expect(res.rows).toEqual([{ user_id: 'keep-me' }])
  })

  it('detects a tampered archive through the checksum file', async () => {
    const db = new PGlite(dataDir)
    await db.exec('CREATE TABLE t (x int);')
    await db.close()
    const b = await runBackup({ databaseUrl: `pglite:${dataDir}`, backupDir })
    writeFileSync(b.archivePath!, 'tampered')
    expect(verifyChecksum(b.archivePath!, b.checksumPath!)).toBe(false)
    await expect(
      runRestore({ databaseUrl: `pglite:${join(scratchDir, 'other')}`, archivePath: b.archivePath! }),
    ).rejects.toThrow(/Checksum verification failed/)
  })

  it('rejects an invalid retention value', async () => {
    await expect(
      runBackup({ databaseUrl: `pglite:${dataDir}`, backupDir, retention: 0 }),
    ).rejects.toThrow(/Invalid retention/)
  })
})
