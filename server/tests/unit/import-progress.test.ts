import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { createPGliteDb } from '../../src/db/pglite.js'
import { runProgressImport } from '../../scripts/import_progress.js'

describe('server import_progress script', () => {
  const scratchDir = mkdtempSync(join(tmpdir(), 'lecture-api-imp-'))
  const dataDir = join(scratchDir, 'data')
  const jsonFile = join(scratchDir, 'graph.json')
  const curriculumFile = join(scratchDir, 'curriculum.txt')

  beforeEach(() => {
    mkdirSync(scratchDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(scratchDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  const sampleGraph = [
    {
      lectureId: 'G01-L01',
      groupId: 'G01',
      status: '已完成',
      completedDate: '2026-10-01T12:00:00Z',
      nodeId: 'c_intro',
      notionPageId: 'page-1',
      title: '第1讲 · C语言定位',
    },
    {
      lectureId: 'G01-L02',
      groupId: 'G01',
      status: '学习中',
      nodeId: 'c_syntax',
      title: '第2讲 · 语法与控制流',
    },
    {
      lectureId: 'G01-L03',
      groupId: 'G01',
      status: '未开始',
      nodeId: 'c_bits',
      title: '第3讲 · 位运算',
    },
  ]

  it('dry-run by default writes nothing; --apply writes rows and second apply is a no-op', async () => {
    writeFileSync(jsonFile, JSON.stringify(sampleGraph, null, 2), 'utf8')

    // 1. Initialize DB with migrations
    const db = createPGliteDb(dataDir)
    await runMigrations(db)
    await db.close()

    // 2. Dry-run
    const dryRes = await runProgressImport({
      filePath: jsonFile,
      userId: 'test-owner',
      databaseUrl: `pglite:${dataDir}`,
      apply: false,
    })

    expect(dryRes.applied).toBe(false)
    expect(dryRes.newCount).toBe(2) // G01-L01, G01-L02 (G01-L03 is unstarted)
    expect(dryRes.changedCount).toBe(0)
    expect(dryRes.unchangedCount).toBe(0)

    // Verify DB still has 0 rows
    const verifyDb1 = createPGliteDb(dataDir)
    const countRes1 = await verifyDb1.query<{ count: string | number }>(
      'SELECT count(*) as count FROM progress WHERE user_id = $1',
      ['test-owner'],
    )
    expect(Number(countRes1.rows[0]?.count)).toBe(0)
    await verifyDb1.close()

    // 3. First apply
    const apply1 = await runProgressImport({
      filePath: jsonFile,
      userId: 'test-owner',
      databaseUrl: `pglite:${dataDir}`,
      apply: true,
    })

    expect(apply1.applied).toBe(true)
    expect(apply1.newCount).toBe(2)
    expect(apply1.changedCount).toBe(0)

    // Verify DB now has 2 rows
    const verifyDb2 = createPGliteDb(dataDir)
    const rowsRes = await verifyDb2.query<{ lecture_id: string; status: string }>(
      'SELECT lecture_id, status FROM progress WHERE user_id = $1 ORDER BY lecture_id ASC',
      ['test-owner'],
    )
    expect(rowsRes.rows).toEqual([
      { lecture_id: 'g01-l01', status: '已完成' },
      { lecture_id: 'g01-l02', status: '学习中' },
    ])
    await verifyDb2.close()

    // 4. Second apply (idempotency check)
    const apply2 = await runProgressImport({
      filePath: jsonFile,
      userId: 'test-owner',
      databaseUrl: `pglite:${dataDir}`,
      apply: true,
    })

    expect(apply2.applied).toBe(true)
    expect(apply2.newCount).toBe(0)
    expect(apply2.changedCount).toBe(0)
    expect(apply2.unchangedCount).toBe(2)
  })

  it('identifies orphans and prunes them only with --prune flag', async () => {
    writeFileSync(jsonFile, JSON.stringify(sampleGraph, null, 2), 'utf8')
    // Curriculum file only lists g01-l01 and g01-l02
    writeFileSync(curriculumFile, 'g01-l01\ng01-l02\n', 'utf8')

    // 1. Initialize DB and insert a valid row + an orphan row
    const db = createPGliteDb(dataDir)
    await runMigrations(db)
    await db.query(
      `INSERT INTO progress (user_id, lecture_id, group_id, status)
       VALUES ('test-owner', 'g01-l01', 'g01', '已完成'),
              ('test-owner', 'orphan-l99', 'orphan', '已完成')`,
    )
    await db.close()

    // 2. Reconcile without prune
    const recRes = await runProgressImport({
      filePath: jsonFile,
      userId: 'test-owner',
      databaseUrl: `pglite:${dataDir}`,
      curriculumPath: curriculumFile,
      reconcile: true,
      prune: false,
    })

    expect(recRes.orphans).toEqual(['orphan-l99'])
    expect(recRes.prunedCount).toBe(0)

    // Verify orphan still exists in DB
    const checkDb1 = createPGliteDb(dataDir)
    const rows1 = await checkDb1.query<{ lecture_id: string }>(
      'SELECT lecture_id FROM progress WHERE user_id = $1 ORDER BY lecture_id ASC',
      ['test-owner'],
    )
    expect(rows1.rows.map((r) => r.lecture_id)).toEqual(['g01-l01', 'orphan-l99'])
    await checkDb1.close()

    // 3. Reconcile with prune
    const pruneRes = await runProgressImport({
      filePath: jsonFile,
      userId: 'test-owner',
      databaseUrl: `pglite:${dataDir}`,
      curriculumPath: curriculumFile,
      reconcile: true,
      prune: true,
    })

    expect(pruneRes.orphans).toEqual(['orphan-l99'])
    expect(pruneRes.prunedCount).toBe(1)

    // Verify orphan was deleted from DB
    const checkDb2 = createPGliteDb(dataDir)
    const rows2 = await checkDb2.query<{ lecture_id: string }>(
      'SELECT lecture_id FROM progress WHERE user_id = $1 ORDER BY lecture_id ASC',
      ['test-owner'],
    )
    expect(rows2.rows.map((r) => r.lecture_id)).toEqual(['g01-l01'])
    await checkDb2.close()
  })
})
