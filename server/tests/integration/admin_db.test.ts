import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { Hono } from 'hono'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, type AppEnv } from '../../src/app.js'
import { verifyPassword } from '../../src/auth/password.js'
import { parseEnv } from '../../src/config/env.js'
import type { AppConfig } from '../../src/config/schema.js'
import * as dbModule from '../../src/db/index.js'
import { createDb, createDbManager, type DbManager } from '../../src/db/index.js'
import { getMigrationStatus, runMigrations } from '../../src/db/migrate.js'
import type { Db, DbClient } from '../../src/db/types.js'
import { createMessage } from '../../src/repo/aiMessages.js'
import { upsertSession } from '../../src/repo/aiSessions.js'
import { upsertProgress } from '../../src/repo/progress.js'
import { upsertReviewChecklistBatch } from '../../src/repo/reviewChecklists.js'
import { setSetting } from '../../src/repo/siteSettings.js'
import { createAdminDbRouter } from '../../src/routes/admin/db.js'

function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: 'pglite:memory',
    databaseUrlDirect: null,
    host: '127.0.0.1',
    port: 8100,
    authAdapter: 'trusted-header',
    authHeaderPreset: 'authelia',
    authHeaderUser: 'Remote-User',
    authHeaderGroups: 'Remote-Groups',
    authHeaderEmail: 'Remote-Email',
    authHeaderName: 'Remote-Name',
    authGroupSeparator: ',',
    authRoleMap: {
      admins: ['admin'],
      authors: ['author'],
      students: ['reader'],
    },
    logoutUrl: null,
    authCookieName: 'lec_session',
    authCookieSecure: 'auto',
    sessionTtlHours: 12,
    rememberMeDays: 30,
    authMethodsEnabled: 'password,passkey,gateway',
    webauthnRpId: '',
    webauthnRpName: 'Interactive Lecture Engine',
    webauthnOrigin: '',
    authBootstrapToken: null,
    dbAutoMigrate: false,
    notionHealthUrl: null,
    allowNonLoopback: false,
    logLevel: 'info',
    aiProvider: 'off',
    difyApiBase: 'https://api.dify.ai/v1',
    difyApiKey: null,
    openaiApiBase: 'https://api.openai.com/v1',
    openaiApiKey: null,
    openaiModel: 'gpt-4o-mini',
    aiUpstreamTimeoutMs: 60000,
    aiUploadMaxBytes: 52428800,
    aiAllowAnonymous: false,
    aiRatePerMinute: 20,
    aiMaxConcurrent: 2,
    aiDailyLimit: 300,
    writeRatePerMinute: 120,
    aiQueryMaxBytes: 8192,
    aiInputsMaxBytes: 32768,
    aiStreamMaxMs: 300000,
    aiAccessLog: false,
    aiPromptsFile: null,
    siteDistDir: null,
    aiToolsFile: null,
    aiToolTimeoutMs: 8000,
    aiToolMaxResultBytes: 24000,
    aiToolMaxSteps: 5,
    aiMcpToken: null,
    aiMcpTicketSecret: null,
    ...overrides,
  }
}

const ADMIN_HEADERS = {
  'Remote-User': 'admin-alice',
  'Remote-Groups': 'admins',
}

const AUTHOR_HEADERS = {
  'Remote-User': 'author-bob',
  'Remote-Groups': 'authors',
}

const READER_HEADERS = {
  'Remote-User': 'reader-carol',
  'Remote-Groups': 'students',
}

describe('WP-3: Admin DB Selector, Hot-Swap, Transfer & Whitelisted 6-Table CRUD', () => {
  let tempRoot: string

  beforeAll(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'wp3-admin-db-'))
  })

  afterAll(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  describe('RBAC enforcement on all /api/admin/db/* endpoints', () => {
    let db: Db
    let app: ReturnType<typeof createApp>

    beforeAll(async () => {
      db = createDb('pglite:memory')
      await runMigrations(db)
      app = createApp(makeTestConfig(), db)
    })

    afterAll(async () => {
      await db.close()
    })

    const endpoints: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/admin/db/config' },
      { method: 'POST', path: '/api/admin/db/test', body: { targetUrl: 'pglite:memory' } },
      { method: 'POST', path: '/api/admin/db/init', body: { dryRun: true } },
      { method: 'POST', path: '/api/admin/db/migrate', body: { dryRun: true } },
      { method: 'POST', path: '/api/admin/db/switch', body: { targetUrl: 'pglite:memory', dryRun: true } },
      { method: 'POST', path: '/api/admin/db/transfer', body: { targetUrl: 'pglite:memory', dryRun: true } },
      { method: 'GET', path: '/api/admin/db/tables' },
      { method: 'GET', path: '/api/admin/db/tables/progress/rows' },
      { method: 'POST', path: '/api/admin/db/tables/progress/rows', body: {} },
      { method: 'PATCH', path: '/api/admin/db/tables/progress/rows', body: {} },
      { method: 'DELETE', path: '/api/admin/db/tables/progress/rows', body: {} },
    ]

    it('rejects unauthenticated with 401, and reader & author with 403 on every endpoint', async () => {
      for (const ep of endpoints) {
        const initBase: RequestInit = {
          method: ep.method,
          ...(ep.body !== undefined ? { body: JSON.stringify(ep.body) } : {}),
        }

        const resUnauth = await app.request(ep.path, initBase)
        expect(resUnauth.status).toBe(401)

        const resReader = await app.request(ep.path, {
          ...initBase,
          headers: {
            ...READER_HEADERS,
            ...(ep.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
        })
        expect(resReader.status).toBe(403)

        const resAuthor = await app.request(ep.path, {
          ...initBase,
          headers: {
            ...AUTHOR_HEADERS,
            ...(ep.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
        })
        expect(resAuthor.status).toBe(403)
      }
    })
  })

  describe('Config, Test, Init/Migrate & Live Hot-Swap with .env backup', () => {
    let envFile: string
    let dbDirA: string
    let dbDirB: string
    let dbManager: DbManager
    let app: ReturnType<typeof createApp>

    beforeAll(async () => {
      dbDirA = join(tempRoot, 'swap-a')
      dbDirB = join(tempRoot, 'swap-b')
      envFile = join(tempRoot, '.env')
      writeFileSync(
        envFile,
        [
          '# Primary DB config',
          `DATABASE_URL=pglite:${dbDirA}`,
          'DATABASE_URL_DIRECT=postgresql://direct_user:DirectPass123@db.example.com/lec',
          'PORT=8100',
          '',
        ].join('\n'),
        'utf8',
      )

      const initialDb = createDb(`pglite:${dbDirA}`)
      await runMigrations(initialDb)
      await upsertProgress(initialDb, 'user-a', { lecture_id: 'g01-l01', status: '已完成' })

      dbManager = createDbManager(initialDb, {
        databaseUrl: `pglite:${dbDirA}`,
        databaseUrlDirect: 'postgresql://direct_user:DirectPass123@db.example.com/lec',
        envFilePath: envFile,
      })
      app = createApp(
        makeTestConfig({
          databaseUrl: `pglite:${dbDirA}`,
          databaseUrlDirect: 'postgresql://direct_user:DirectPass123@db.example.com/lec',
        }),
        dbManager.asDb(),
        { dbManager },
      )
    })

    afterAll(async () => {
      await dbManager.close()
    })

    it('GET /api/admin/db/config redacts secrets and reports migrations & tableCounts', async () => {
      const res = await app.request('/api/admin/db/config', { headers: ADMIN_HEADERS })
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.kind).toBe('pglite')
      expect(data.pgliteDir).toBe(dbDirA)
      expect(data.envFilePath).toBe(envFile)
      expect(data.envWritable).toBe(true)
      expect(data.migrations).toEqual({ applied: 3, pending: 0, total: 3 })
      expect(data.tableCounts.progress).toBe(1)
      expect(data.tableCounts.auth_users).toBe(0)

      const raw = JSON.stringify(data)
      expect(raw).not.toContain('DirectPass123')
      expect(raw).not.toContain('direct_user')
      expect(data.databaseUrlDirect).toBe('[REDACTED]')
    })

    it('POST /api/admin/db/test validates URLs, reports PGlite connectivity, and redacts pg errors', async () => {
      const badRes = await app.request('/api/admin/db/test', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: 'mysql://localhost/db' }),
      })
      expect(badRes.status).toBe(400)

      const okRes = await app.request('/api/admin/db/test', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: `pglite:${dbDirA}` }),
      })
      expect(okRes.status).toBe(200)
      const okData = await okRes.json()
      expect(okData.ok).toBe(true)
      expect(okData.kind).toBe('pglite')
      expect(typeof okData.serverVersion).toBe('string')
      expect(typeof okData.latencyMs).toBe('number')
      expect(okData.migrationsApplied).toBe(3)
      expect(okData.migrationsPending).toBe(0)

      const failRes = await app.request('/api/admin/db/test', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: 'postgresql://secretuser:UltraSecretPwd99@127.0.0.1:1/nonexistent',
        }),
      })
      expect(failRes.status).toBe(200)
      const failData = await failRes.json()
      expect(failData.ok).toBe(false)
      expect(typeof failData.error).toBe('string')
      const failRaw = JSON.stringify(failData)
      expect(failRaw).not.toContain('UltraSecretPwd99')
      expect(failRaw).not.toContain('secretuser')
    })

    it('POST /api/admin/db/init and /migrate support dryRun and live migration of a fresh target', async () => {
      const initDir = join(tempRoot, 'init-target')

      const dryRes = await app.request('/api/admin/db/init', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: `pglite:${initDir}`, dryRun: true }),
      })
      expect(dryRes.status).toBe(200)
      const dryData = await dryRes.json()
      expect(dryData.ok).toBe(true)
      expect(dryData.dryRun).toBe(true)
      expect(dryData.applied).toEqual([])
      expect(dryData.pending).toHaveLength(3)
      expect(dryData.dryRunSql).toContain('CREATE TABLE IF NOT EXISTS progress')
      expect(existsSync(initDir)).toBe(false)

      const verifyUnmigrated = createDb(`pglite:${initDir}`)
      try {
        const st = await getMigrationStatus(verifyUnmigrated)
        expect(st.applied).toHaveLength(0)
        expect(st.pending).toHaveLength(3)
      } finally {
        await verifyUnmigrated.close()
      }

      const liveRes = await app.request('/api/admin/db/migrate', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: `pglite:${initDir}`, dryRun: false }),
      })
      expect(liveRes.status).toBe(200)
      const liveData = await liveRes.json()
      expect(liveData.ok).toBe(true)
      expect(liveData.dryRun).toBe(false)
      expect(liveData.applied).toHaveLength(3)
      expect(liveData.pending).toEqual([])
    })

    it('POST /api/admin/db/switch dryRun performs no swap, and live switch hot-swaps all routers + backs up .env', async () => {
      // Dry run first
      const dryRes = await app.request('/api/admin/db/switch', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: `pglite:${dbDirB}`, dryRun: true }),
      })
      expect(dryRes.status).toBe(200)
      const dryData = await dryRes.json()
      expect(dryData.ok).toBe(true)
      expect(dryData.dryRun).toBe(true)
      expect(dryData.migrationsPending).toHaveLength(3)
      expect(dryData.dryRunSql).toContain('CREATE TABLE IF NOT EXISTS auth_users')
      expect(dryData.envWritable).toBe(true)

      // Live switch to dbDirB
      const switchRes = await app.request('/api/admin/db/switch', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: `pglite:${dbDirB}`, autoMigrate: true }),
      })
      expect(switchRes.status).toBe(200)
      const switchData = await switchRes.json()
      expect(switchData.ok).toBe(true)
      expect(switchData.previousKind).toBe('pglite')
      expect(switchData.currentKind).toBe('pglite')
      expect(switchData.migrationsApplied).toHaveLength(3)
      expect(switchData.envUpdated).toBe(true)
      expect(switchData.backupPath).toMatch(/\.bak-\d{8}-\d{6}-[0-9a-f]{6}$/)
      expect(existsSync(switchData.backupPath)).toBe(true)

      const backupContent = readFileSync(switchData.backupPath, 'utf8')
      expect(backupContent).toContain(`DATABASE_URL=pglite:${dbDirA}`)

      const updatedEnv = parseEnv(readFileSync(envFile, 'utf8'))
      expect(updatedEnv.DATABASE_URL).toBe(`pglite:${dbDirB}`)
      expect(updatedEnv.DATABASE_URL_DIRECT).toBe('')
      expect(updatedEnv.PORT).toBe('8100')

      // Overview and CRUD tables now read the empty dbDirB immediately
      const overviewRes = await app.request('/api/admin/overview', { headers: ADMIN_HEADERS })
      expect(overviewRes.status).toBe(200)
      const overviewData = await overviewRes.json()
      expect(overviewData.totals.progressRows).toBe(0)

      // Switching again to the same active dir is rejected with 400
      const sameRes = await app.request('/api/admin/db/switch', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: `pglite:${dbDirB}` }),
      })
      expect(sameRes.status).toBe(400)
      const sameData = await sameRes.json()
      expect(sameData.error).toBe('same_database_target')
    })

    it('handles read-only .env gracefully on switch without crashing', async () => {
      const dbDirC = join(tempRoot, 'swap-c')
      const roDir = join(tempRoot, 'ro-env-dir')
      const roEnv = join(roDir, '.env')
      const roBaseDb = createDb('pglite:memory')
      await runMigrations(roBaseDb)

      const fsMkdir = await import('node:fs')
      fsMkdir.mkdirSync(roDir, { recursive: true })
      writeFileSync(roEnv, 'DATABASE_URL=pglite:memory\n', 'utf8')
      chmodSync(roEnv, 0o444)

      const localManager = createDbManager(roBaseDb, {
        databaseUrl: 'pglite:memory',
        envFilePath: roEnv,
      })
      const localApp = createApp(makeTestConfig(), localManager.asDb(), {
        dbManager: localManager,
      })

      try {
        const res = await localApp.request('/api/admin/db/switch', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: `pglite:${dbDirC}` }),
        })
        expect(res.status).toBe(200)
        const data = await res.json()
        expect(data.ok).toBe(true)
        expect(data.envUpdated).toBe(false)
        expect(data.backupPath).toBeNull()
      } finally {
        chmodSync(roEnv, 0o644)
        await localManager.close()
      }
    })
  })

  describe('Cross-Engine Data Transfer (push, pull, dryRun, upsert/skip, sequence sync)', () => {
    let sourceDb: Db
    let targetDir: string
    let pullSourceDir: string
    let app: ReturnType<typeof createApp>

    beforeAll(async () => {
      sourceDb = createDb('pglite:memory')
      await runMigrations(sourceDb)
      targetDir = join(tempRoot, 'transfer-target')
      pullSourceDir = join(tempRoot, 'transfer-pull-source')

      // Seed all 10 tables in FK order
      await sourceDb.query(
        `INSERT INTO auth_users (id, username, email, display_name, password_hash, roles, disabled)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        ['u-1', 'alice', 'alice@example.com', 'Alice', 'hash1', JSON.stringify(['reader', 'admin']), false],
      )
      await sourceDb.query(
        `INSERT INTO auth_sessions (id, user_id, token_hash, auth_method, remember_me, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + interval '1 day')`,
        ['sess-auth-1', 'u-1', 'tokhash-1', 'password', true],
      )
      await sourceDb.query(
        `INSERT INTO auth_credentials (id, user_id, method, credential_id, public_key, transports)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        ['cred-1', 'u-1', 'passkey', 'cred-ext-1', 'pubkey-1', JSON.stringify(['internal'])],
      )
      await sourceDb.query(
        `INSERT INTO auth_challenges (challenge, kind, method, user_id, metadata, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + interval '5 minutes')`,
        ['chal-1', 'registration', 'passkey', 'u-1', JSON.stringify({ rpId: 'localhost' })],
      )

      await setSetting(sourceDb, 'theme', { mode: 'dark', accent: '#3b82f6' }, 'u-1')
      await setSetting(sourceDb, 'theme', { mode: 'light', accent: '#2563eb' }, 'u-1')

      await upsertProgress(sourceDb, 'u-1', { lecture_id: 'g01-l01', status: '已完成' })
      const aiSess = await upsertSession(sourceDb, 'u-1', {
        id: 'ai-sess-1',
        lecture_id: 'g01-l01',
        title: 'Lecture Q&A',
      })
      await createMessage(sourceDb, 'u-1', {
        id: 'ai-msg-1',
        session_id: aiSess.id,
        role: 'user',
        content: 'What is Bayes theorem?',
      })
      await upsertReviewChecklistBatch(sourceDb, 'u-1', [
        { id: 'chk-1', lecture_id: 'g01-l01', topic_title: 'Bayes rule', is_completed: true },
      ])

      app = createApp(makeTestConfig(), sourceDb)
    })

    afterAll(async () => {
      await sourceDb.close()
    })

    it('rejects identical active target URL with 400', async () => {
      const res = await app.request('/api/admin/db/transfer', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: 'pglite:memory' }),
      })
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe('same_database_target')
    })

    it('supports dryRun counts, live push transfer, idempotent upsert/skip, and site_settings_history sequence sync', async () => {
      // 1. Dry run
      const dryRes = await app.request('/api/admin/db/transfer', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUrl: `pglite:${targetDir}`, dryRun: true }),
      })
      expect(dryRes.status).toBe(200)
      const dryData = await dryRes.json()
      expect(dryData.ok).toBe(true)
      expect(dryData.dryRun).toBe(true)
      expect(dryData.direction).toBe('push')
      const usersRow = dryData.tables.find((t: { table: string }) => t.table === 'auth_users')
      expect(usersRow.sourceCount).toBe(1)
      expect(usersRow.targetCount).toBeNull()

      // 2. Live push
      const pushRes = await app.request('/api/admin/db/transfer', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: `pglite:${targetDir}`,
          direction: 'push',
          conflictStrategy: 'upsert',
        }),
      })
      expect(pushRes.status).toBe(200)
      const pushData = await pushRes.json()
      expect(pushData.ok).toBe(true)
      expect(pushData.dryRun).toBe(false)
      for (const r of pushData.results) {
        expect(r.targetCount).toBe(r.sourceCount)
      }

      // 3. Re-run idempotent upsert
      const rerunUpsert = await app.request('/api/admin/db/transfer', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: `pglite:${targetDir}`,
          conflictStrategy: 'upsert',
        }),
      })
      expect(rerunUpsert.status).toBe(200)

      // 4. Re-run with skip
      const rerunSkip = await app.request('/api/admin/db/transfer', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: `pglite:${targetDir}`,
          conflictStrategy: 'skip',
        }),
      })
      expect(rerunSkip.status).toBe(200)
      const skipData = await rerunSkip.json()
      const skipUsers = skipData.results.find((r: { table: string }) => r.table === 'auth_users')
      expect(skipUsers.transferredCount).toBe(0)
      expect(skipUsers.targetCount).toBe(1)

      // 5. Verify site_settings_history sequence advances without collision on target
      const verifyTarget = createDb(`pglite:${targetDir}`)
      try {
        await setSetting(verifyTarget, 'banner', { text: 'Updated after transfer' }, 'u-1')
        const histRes = await verifyTarget.query<{ id: number | string }>(
          'SELECT id FROM site_settings_history ORDER BY id ASC',
        )
        expect(histRes.rows).toHaveLength(3)
        expect(Number(histRes.rows[2]?.id)).toBe(3)
      } finally {
        await verifyTarget.close()
      }
    })

    it('supports pull transfer from external DB into active DB', async () => {
      const extDb = createDb(`pglite:${pullSourceDir}`)
      await runMigrations(extDb)
      await upsertProgress(extDb, 'u-pulled', { lecture_id: 'g02-l01', status: '学习中' })
      await extDb.close()

      const pullRes = await app.request('/api/admin/db/transfer', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: `pglite:${pullSourceDir}`,
          direction: 'pull',
          conflictStrategy: 'upsert',
        }),
      })
      expect(pullRes.status).toBe(200)
      const pullData = await pullRes.json()
      expect(pullData.ok).toBe(true)
      expect(pullData.direction).toBe('pull')

      const checkActive = await sourceDb.query(
        'SELECT status FROM progress WHERE user_id = $1 AND lecture_id = $2',
        ['u-pulled', 'g02-l01'],
      )
      expect(checkActive.rows[0]).toEqual({ status: '学习中' })
    })
  })

  describe('Whitelisted 6-Table CRUD & Security Guards', () => {
    let db: Db
    let app: ReturnType<typeof createApp>

    beforeAll(async () => {
      db = createDb('pglite:memory')
      await runMigrations(db)
      app = createApp(makeTestConfig(), db)
    })

    afterAll(async () => {
      await db.close()
    })

    it('lists exactly the 6 whitelisted tables and rejects non-whitelisted or SQL-injected table names', async () => {
      const listRes = await app.request('/api/admin/db/tables', { headers: ADMIN_HEADERS })
      expect(listRes.status).toBe(200)
      const listData = await listRes.json()
      expect(listData.tables.map((t: { name: string }) => t.name)).toEqual([
        'progress',
        'ai_sessions',
        'ai_messages',
        'ai_review_checklists',
        'auth_users',
        'site_settings',
      ])

      for (const badTable of ['schema_migrations', 'idempotency_keys', 'auth_sessions', 'users; DROP TABLE auth_users']) {
        const res = await app.request(`/api/admin/db/tables/${encodeURIComponent(badTable)}/rows`, {
          headers: ADMIN_HEADERS,
        })
        expect(res.status).toBe(400)
        const data = await res.json()
        expect(data.error).toBe('invalid_table')
      }
    })

    it('rejects invalid columns and invalid sort columns with 400', async () => {
      const badSort = await app.request('/api/admin/db/tables/progress/rows?sort=nonexistent_col', {
        headers: ADMIN_HEADERS,
      })
      expect(badSort.status).toBe(400)
      expect((await badSort.json()).error).toBe('invalid_sort_column')

      const badInsertCol = await app.request('/api/admin/db/tables/progress/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'u1', lecture_id: 'g01-l01', bogus_col: 123 }),
      })
      expect(badInsertCol.status).toBe(400)
      expect((await badInsertCol.json()).error).toBe('invalid_column')

      const badHashSort = await app.request('/api/admin/db/tables/auth_users/rows?sort=password_hash', {
        headers: ADMIN_HEADERS,
      })
      expect(badHashSort.status).toBe(400)

      const badHashWrite = await app.request('/api/admin/db/tables/auth_users/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'hacker', password_hash: 'raw' }),
      })
      expect(badHashWrite.status).toBe(400)
      expect((await badHashWrite.json()).error).toBe('invalid_column')
    })

    it('handles progress composite PK CRUD + NaN-safe pagination, search, and sort', async () => {
      const createRes = await app.request('/api/admin/db/tables/progress/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'crud-u1',
          lecture_id: 'g01-l01',
          group_id: 'g01',
          status: '学习中',
        }),
      })
      expect(createRes.status).toBe(201)

      await app.request('/api/admin/db/tables/progress/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'crud-u2',
          lecture_id: 'g02-l01',
          group_id: 'g02',
          status: '已完成',
        }),
      })

      const getRes = await app.request(
        '/api/admin/db/tables/progress/rows?limit=notanumber&offset=-5&q=crud-u1&sort=lecture_id&order=asc',
        { headers: ADMIN_HEADERS },
      )
      expect(getRes.status).toBe(200)
      const getData = await getRes.json()
      expect(getData.limit).toBe(25)
      expect(getData.offset).toBe(0)
      expect(getData.total).toBe(1)
      expect(getData.rows[0].user_id).toBe('crud-u1')

      const patchRes = await app.request('/api/admin/db/tables/progress/rows', {
        method: 'PATCH',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pk: { user_id: 'crud-u1', lecture_id: 'g01-l01' },
          data: { status: '已完成' },
        }),
      })
      expect(patchRes.status).toBe(200)
      expect((await patchRes.json()).row.status).toBe('已完成')

      const delRes = await app.request('/api/admin/db/tables/progress/rows', {
        method: 'DELETE',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: { user_id: 'crud-u1', lecture_id: 'g01-l01' } }),
      })
      expect(delRes.status).toBe(200)

      const delQueryRes = await app.request(
        '/api/admin/db/tables/progress/rows?user_id=crud-u2&lecture_id=g02-l01',
        { method: 'DELETE', headers: ADMIN_HEADERS },
      )
      expect(delQueryRes.status).toBe(200)
    })

    it('handles ai_sessions, ai_messages (including cascade delete), ai_review_checklists, and site_settings CRUD', async () => {
      // Create session
      const sessRes = await app.request('/api/admin/db/tables/ai_sessions/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'u-chat',
          id: 's-chat-1',
          lecture_id: 'g01-l01',
          group_id: 'g01',
          title: 'Initial Title',
        }),
      })
      expect(sessRes.status).toBe(201)

      // Create message
      const msgRes = await app.request('/api/admin/db/tables/ai_messages/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'u-chat',
          id: 'm-chat-1',
          session_id: 's-chat-1',
          role: 'user',
          content: 'Hello AI',
          model: 'gpt-4o-mini',
        }),
      })
      expect(msgRes.status).toBe(201)

      // Update message
      const msgPatch = await app.request('/api/admin/db/tables/ai_messages/rows', {
        method: 'PATCH',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pk: { user_id: 'u-chat', id: 'm-chat-1' },
          data: { content: 'Updated prompt' },
        }),
      })
      expect(msgPatch.status).toBe(200)
      expect((await msgPatch.json()).row.content).toBe('Updated prompt')

      // Delete parent session -> verify ai_messages cascades
      const delSess = await app.request('/api/admin/db/tables/ai_sessions/rows', {
        method: 'DELETE',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: { user_id: 'u-chat', id: 's-chat-1' } }),
      })
      expect(delSess.status).toBe(200)

      const remainingMsgs = await app.request('/api/admin/db/tables/ai_messages/rows', {
        headers: ADMIN_HEADERS,
      })
      expect((await remainingMsgs.json()).total).toBe(0)

      // ai_review_checklists CRUD
      const chkCreate = await app.request('/api/admin/db/tables/ai_review_checklists/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'u-chat',
          id: 'chk-crud-1',
          lecture_id: 'g01-l01',
          group_id: 'g01',
          topic_title: 'Gradient Descent',
          is_completed: false,
          priority: 2,
        }),
      })
      expect(chkCreate.status).toBe(201)

      const chkPatch = await app.request('/api/admin/db/tables/ai_review_checklists/rows', {
        method: 'PATCH',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pk: { user_id: 'u-chat', id: 'chk-crud-1' },
          data: { is_completed: true },
        }),
      })
      expect(chkPatch.status).toBe(200)
      expect((await chkPatch.json()).row.is_completed).toBe(true)

      const chkDel = await app.request('/api/admin/db/tables/ai_review_checklists/rows', {
        method: 'DELETE',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ pk: { user_id: 'u-chat', id: 'chk-crud-1' } }),
      })
      expect(chkDel.status).toBe(200)

      // site_settings CRUD
      const setCreate = await app.request('/api/admin/db/tables/site_settings/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'announcement',
          value: { enabled: true, text: 'Welcome' },
          updated_by: 'admin-alice',
        }),
      })
      expect(setCreate.status).toBe(201)

      const setPatch = await app.request('/api/admin/db/tables/site_settings/rows/announcement', {
        method: 'PATCH',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: false }),
      })
      expect(setPatch.status).toBe(200)
      expect((await setPatch.json()).row.value).toBe(false)

      const setDel = await app.request('/api/admin/db/tables/site_settings/rows/announcement', {
        method: 'DELETE',
        headers: ADMIN_HEADERS,
      })
      expect(setDel.status).toBe(200)
    })

    it('handles auth_users CRUD: hashes password, never leaks password_hash, and protects last active admin', async () => {
      const adminCreate = await app.request('/api/admin/db/tables/auth_users/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'rootadmin',
          email: 'root@example.com',
          display_name: 'Root Admin',
          password: 'StrongPassword123!',
          roles: ['admin'],
        }),
      })
      expect(adminCreate.status).toBe(201)
      const adminData = await adminCreate.json()
      expect(adminData.row.username).toBe('rootadmin')
      expect(adminData.row.roles).toEqual(['reader', 'admin'])
      expect('password_hash' in adminData.row).toBe(false)
      expect(JSON.stringify(adminData)).not.toContain('StrongPassword123!')

      const adminId = adminData.row.id as string

      // Verify password actually got hashed properly in DB
      const hashRow = await db.query<{ password_hash: string }>(
        'SELECT password_hash FROM auth_users WHERE id = $1',
        [adminId],
      )
      expect(await verifyPassword('StrongPassword123!', hashRow.rows[0]!.password_hash)).toBe(true)

      // GET list never leaks password_hash
      const listRes = await app.request('/api/admin/db/tables/auth_users/rows', {
        headers: ADMIN_HEADERS,
      })
      expect(listRes.status).toBe(200)
      const listData = await listRes.json()
      expect('password_hash' in listData.rows[0]).toBe(false)

      // Last-active-admin protection on PATCH (remove admin role or disable)
      const demoteLast = await app.request(`/api/admin/db/tables/auth_users/rows/${adminId}`, {
        method: 'PATCH',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: ['reader'] }),
      })
      expect(demoteLast.status).toBe(409)
      expect((await demoteLast.json()).error).toBe('cannot_remove_last_admin')

      const disableLast = await app.request(`/api/admin/db/tables/auth_users/rows/${adminId}`, {
        method: 'PATCH',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: true }),
      })
      expect(disableLast.status).toBe(409)
      expect((await disableLast.json()).error).toBe('cannot_remove_last_admin')

      // Last-active-admin protection on DELETE
      const deleteLast = await app.request(`/api/admin/db/tables/auth_users/rows/${adminId}`, {
        method: 'DELETE',
        headers: ADMIN_HEADERS,
      })
      expect(deleteLast.status).toBe(409)
      expect((await deleteLast.json()).error).toBe('cannot_remove_last_admin')

      // Create second reader user and delete it -> succeeds
      const readerCreate = await app.request('/api/admin/db/tables/auth_users/rows', {
        method: 'POST',
        headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'plainreader',
          password: 'ReaderPassword123!',
          roles: ['reader'],
        }),
      })
      expect(readerCreate.status).toBe(201)
      const readerId = (await readerCreate.json()).row.id as string

      const delReader = await app.request(`/api/admin/db/tables/auth_users/rows/${readerId}`, {
        method: 'DELETE',
        headers: ADMIN_HEADERS,
      })
      expect(delReader.status).toBe(200)
    })
  })

  describe('Blind-Audit Hardening, PgDb Wire Protocol (PGLiteSocketServer) & Edge Cases', () => {
    it('supports real PgDb (PGLiteSocketServer) test, migrate, push/pull transfer & hot-swap', async () => {
      const srcDir = join(tempRoot, 'wire-src')
      const sourceDb = createDb(`pglite:${srcDir}`)
      await runMigrations(sourceDb)
      await upsertProgress(sourceDb, 'wire-u', { lecture_id: 'g01-l01', status: '已完成' })
      await setSetting(sourceDb, 'wire_setting', { theme: 'datasheet' }, 'wire-admin')

      const pgRaw = await PGlite.create('memory://')
      const socketServer = new PGLiteSocketServer({
        db: pgRaw,
        host: '127.0.0.1',
        port: 0,
        maxConnections: 20,
      })
      await socketServer.start()
      const pgUrl = `postgres://postgres:wireSecretPwd@${socketServer.getServerConn()}/postgres?sslmode=disable`

      const wireEnv = join(tempRoot, '.env.wire')
      writeFileSync(wireEnv, `DATABASE_URL=pglite:${srcDir}\n`, 'utf8')
      const dbManager = createDbManager(sourceDb, {
        databaseUrl: `pglite:${srcDir}`,
        envFilePath: wireEnv,
      })
      const app = createApp(makeTestConfig({ databaseUrl: `pglite:${srcDir}` }), dbManager.asDb(), {
        dbManager,
      })

      try {
        const testRes = await app.request('/api/admin/db/test', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: pgUrl }),
        })
        expect(testRes.status).toBe(200)
        const testData = await testRes.json()
        expect(testData.ok).toBe(true)
        expect(testData.kind).toBe('pg')

        // PGlite -> PgDb push transfer
        const transferRes = await app.request('/api/admin/db/transfer', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: pgUrl, direction: 'push', conflictStrategy: 'upsert' }),
        })
        expect(transferRes.status).toBe(200)
        const transferData = await transferRes.json()
        expect(transferData.ok).toBe(true)
        expect(
          transferData.results.find((r: { table: string }) => r.table === 'progress').targetCount,
        ).toBe(1)

        // Hot-swap active engine to PgDb over TCP wire protocol
        const createDbSpy = vi.spyOn(dbModule, 'createDb')
        const swapToSpy = vi.spyOn(dbManager, 'swapTo')
        try {
          const swapRes = await app.request('/api/admin/db/switch', {
            method: 'POST',
            headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUrl: pgUrl, autoMigrate: true }),
          })
          expect(swapRes.status).toBe(200)
          const swapData = await swapRes.json()
          expect(swapData.ok).toBe(true)
          expect(swapData.previousKind).toBe('pglite')
          expect(swapData.currentKind).toBe('pg')
          expect(JSON.stringify(swapData)).not.toContain('wireSecretPwd')

          // REV2-2: verify probe used statementTimeoutMs: 30000, while switched runtime pool createDb contract
          // used standard pool options (no statementTimeoutMs: 30000)
          expect(swapToSpy).toHaveBeenCalledTimes(1)
          const createDbCallsForPg = createDbSpy.mock.calls.filter((call) => call[0] === pgUrl)
          expect(createDbCallsForPg.length).toBeGreaterThanOrEqual(2)
          // Probe call carries probe timeouts
          expect(createDbCallsForPg[0]![1]?.pg?.statementTimeoutMs).toBe(30000)
          expect(createDbCallsForPg[0]![1]?.pg?.connectionTimeoutMillis).toBe(8000)
          // Switched runtime pool call does NOT get pinned to probe options
          expect(createDbCallsForPg[1]![1]).toBeUndefined()
        } finally {
          swapToSpy.mockRestore()
          createDbSpy.mockRestore()
        }

        // Live CRUD query on swapped PgDb
        const rowsRes = await app.request('/api/admin/db/tables/site_settings/rows', {
          headers: ADMIN_HEADERS,
        })
        expect(rowsRes.status).toBe(200)
        const rowsData = await rowsRes.json()
        expect(rowsData.total).toBe(1)
        expect(rowsData.rows[0].key).toBe('wire_setting')
      } finally {
        await dbManager.close()
        await socketServer.stop()
        await pgRaw.close()
      }
    })

    it('rejects bad targetDirectUrl combinations, avoids creating dir on dryRun, handles skip/upsert collisions, and preserves blank passwords + history', async () => {
      const dbDir = join(tempRoot, 'edge-main')
      const extDir = join(tempRoot, 'edge-ext')
      const neverCreatedDir = join(tempRoot, 'should-never-exist')

      const mainDb = createDb(`pglite:${dbDir}`)
      await runMigrations(mainDb)
      const extDb = createDb(`pglite:${extDir}`)
      await runMigrations(extDb)
      await extDb.query(
        `INSERT INTO auth_users (id, username, email, display_name, password_hash, roles, disabled)
         VALUES ('ext-u-1', 'shared_admin', 'shared@example.com', 'External Name', 'hash', '["reader","admin"]'::jsonb, FALSE)`,
      )
      await upsertProgress(extDb, 'ext-u-1', { lecture_id: 'g01-l01', status: '已完成' })
      await extDb.close()

      const dbManager = createDbManager(mainDb, { databaseUrl: `pglite:${dbDir}` })
      const app = createApp(makeTestConfig({ databaseUrl: `pglite:${dbDir}` }), dbManager.asDb(), {
        dbManager,
      })

      try {
        // 1. Mix pglite targetUrl with postgres targetDirectUrl -> 400
        const mixRes = await app.request('/api/admin/db/switch', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: `pglite:${join(tempRoot, 'mix-target')}`,
            targetDirectUrl: 'postgresql://user:pass@127.0.0.1:5432/db',
          }),
        })
        expect(mixRes.status).toBe(400)

        // 2. Test fails when targetUrl is broken even if targetDirectUrl is valid
        const testPair = await app.request('/api/admin/db/test', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: 'postgresql://u:secretpass@127.0.0.1:1/bad',
            targetDirectUrl: 'postgresql://u:secretpass@127.0.0.1:5432/good',
          }),
        })
        expect(testPair.status).toBe(200)
        const pairData = await testPair.json()
        expect(pairData.ok).toBe(false)
        expect(JSON.stringify(pairData)).not.toContain('secretpass')

        // 3. Dry-run test / switch against non-existent FS pglite does not create directory
        await app.request('/api/admin/db/test', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: `pglite:${neverCreatedDir}` }),
        })
        await app.request('/api/admin/db/switch', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: `pglite:${neverCreatedDir}`, dryRun: true }),
        })
        expect(existsSync(neverCreatedDir)).toBe(false)

        // 4. Empty targetUrl on /migrate -> 400
        const emptyMig = await app.request('/api/admin/db/migrate', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: '' }),
        })
        expect(emptyMig.status).toBe(400)

        // 5. Seed conflicting username with different UUID in mainDb -> conflictStrategy='skip' succeeds without 23505
        const createRes = await app.request('/api/admin/db/tables/auth_users/rows', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'shared_admin',
            email: 'other@example.com',
            display_name: 'Local Name',
            password: 'LocalPassword123!',
            roles: ['admin'],
          }),
        })
        expect(createRes.status).toBe(201)
        const localUserId = (await createRes.json()).row.id as string

        const skipRes = await app.request('/api/admin/db/transfer', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: `pglite:${extDir}`,
            direction: 'push',
            conflictStrategy: 'skip',
          }),
        })
        expect(skipRes.status).toBe(200)

        // 6. PATCH auth_users with blank password "" preserves existing password hash
        const blankPwPatch = await app.request(`/api/admin/db/tables/auth_users/rows/${localUserId}`, {
          method: 'PATCH',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: 'Updated Name', password: '' }),
        })
        expect(blankPwPatch.status).toBe(200)
        const hashCheck = await mainDb.query<{ password_hash: string }>(
          'SELECT password_hash FROM auth_users WHERE id = $1',
          [localUserId],
        )
        expect(await verifyPassword('LocalPassword123!', hashCheck.rows[0]!.password_hash)).toBe(true)

        // 7. PATCH /:pk mismatch -> 400; integer overflow (22003) -> 400; site_settings audit trail + % LIKE escape
        const mismatchPatch = await app.request(`/api/admin/db/tables/auth_users/rows/${localUserId}`, {
          method: 'PATCH',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pk: 'other-id', display_name: 'X' }),
        })
        expect(mismatchPatch.status).toBe(400)

        const badChecklist = await app.request('/api/admin/db/tables/ai_review_checklists/rows', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: localUserId,
            lecture_id: 'g01-l01',
            group_id: 'g01',
            topic_title: 'k1',
            priority: 9999999999,
          }),
        })
        expect(badChecklist.status).toBe(400)

        await app.request('/api/admin/db/tables/site_settings/rows', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'percent_100%_test', value: { v: 1 } }),
        })
        await app.request('/api/admin/db/tables/site_settings/rows', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'percent_other', value: { v: 2 } }),
        })
        const histCount = await mainDb.query<{ cnt: number }>(
          `SELECT COUNT(*)::int AS cnt FROM site_settings_history WHERE setting_key = 'percent_100%_test'`,
        )
        expect(histCount.rows[0]!.cnt).toBe(1)

        const qEscaped = await app.request('/api/admin/db/tables/site_settings/rows?q=100%25_', {
          headers: ADMIN_HEADERS,
        })
        expect(qEscaped.status).toBe(200)
        const qData = await qEscaped.json()
        expect(qData.rows).toHaveLength(1)
        expect(qData.rows[0].key).toBe('percent_100%_test')

        // Short (<3 chars) username rejected in both POST and PATCH auth_users CRUD
        const shortPost = await app.request('/api/admin/db/tables/auth_users/rows', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'ab', password: 'LocalPassword123!' }),
        })
        expect(shortPost.status).toBe(400)
        const shortPatch = await app.request(`/api/admin/db/tables/auth_users/rows/${localUserId}`, {
          method: 'PATCH',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'ab' }),
        })
        expect(shortPatch.status).toBe(400)
      } finally {
        await dbManager.close()
      }
    })

    it('enforces transfer write deadline inside destDb.tx() and rolls back atomically before returning 504', async () => {
      const extSourceDir = join(tempRoot, 'timeout-ext-src')
      const extSourceDb = createDb(`pglite:${extSourceDir}`)
      await runMigrations(extSourceDb)
      // Insert 120 rows (>1 TRANSFER_BATCH_SIZE=100) so at least one batch inserts before batch 2 checks deadline
      for (let i = 0; i < 120; i++) {
        await upsertProgress(extSourceDb, `timeout-u-${String(i).padStart(3, '0')}`, {
          lecture_id: 'g01-l01',
          status: '已完成',
        })
      }
      await extSourceDb.close()

      const destDir = join(tempRoot, 'timeout-dest')
      const realDestDb = createDb(`pglite:${destDir}`)
      await runMigrations(realDestDb)

      let insertBatchesExecuted = 0
      const slowDestDb: Db = {
        kind: realDestDb.kind,
        query: (sql, params) => realDestDb.query(sql, params),
        exec: (sql) => realDestDb.exec(sql),
        close: () => realDestDb.close(),
        tx: (fn) =>
          realDestDb.tx(async (txClient) => {
            const wrappedClient: DbClient = {
              query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
                const res = await txClient.query<T>(sql, params)
                if (sql.startsWith('INSERT INTO "progress"')) {
                  insertBatchesExecuted += 1
                  await new Promise((r) => setTimeout(r, 30))
                }
                return res
              },
              exec: (sql) => txClient.exec(sql),
            }
            return fn(wrappedClient)
          }),
      }

      const dbManager = createDbManager(slowDestDb, { databaseUrl: `pglite:${destDir}` })
      const testApp = new Hono<AppEnv>()
      testApp.route('/api/admin/db', createAdminDbRouter(dbManager, { transferWriteTimeoutMs: 15 }))

      try {
        const res = await testApp.request('/api/admin/db/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: `pglite:${extSourceDir}`,
            direction: 'pull',
            conflictStrategy: 'upsert',
            migrateTarget: false,
          }),
        })

        expect(res.status).toBe(504)
        const body = (await res.json()) as { ok: boolean; error: string; message: string }
        expect(body.ok).toBe(false)
        expect(body.error).toBe('transfer_timeout')
        expect(insertBatchesExecuted).toBe(1)

        // Rollback must already have completed BEFORE the 504 response returned
        const countRes = await realDestDb.query<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM progress',
        )
        expect(countRes.rows[0]?.cnt).toBe(0)
      } finally {
        await dbManager.close()
      }
    })

    it('enforces REV2-7(a), REV2-6, and REV2-5: rejects pglite:memory when dryRun is false, serializes /migrate with runExclusive, and excludes reserved domain setting keys in row listing', async () => {
      const dbDir = join(tempRoot, 'rev-fixes-db')
      const mainDb = createDb(`pglite:${dbDir}`)
      await runMigrations(mainDb)

      const dbManager = createDbManager(mainDb, { databaseUrl: `pglite:${dbDir}` })
      const app = createApp(makeTestConfig({ databaseUrl: `pglite:${dbDir}` }), dbManager.asDb(), {
        dbManager,
      })

      try {
        // Same-target switch keeps dryRun: true working while rejecting live !dryRun swap
        const switchSameDryRes = await app.request('/api/admin/db/switch', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: `pglite:${dbDir}`, dryRun: true }),
        })
        expect(switchSameDryRes.status).toBe(200)
        const switchSameDryBody = (await switchSameDryRes.json()) as {
          ok: boolean
          dryRun: boolean
          sameTarget: boolean
        }
        expect(switchSameDryBody.ok).toBe(true)
        expect(switchSameDryBody.dryRun).toBe(true)
        expect(switchSameDryBody.sameTarget).toBe(true)

        // 1. REV2-7(a): Reject pglite:memory on /switch when dryRun is false
        const switchMemRes = await app.request('/api/admin/db/switch', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: 'pglite:memory', dryRun: false }),
        })
        expect(switchMemRes.status).toBe(400)
        expect((await switchMemRes.json()).error).toBe('invalid_database_url')

        // Omitting dryRun defaults to false
        const switchMemOmitDry = await app.request('/api/admin/db/switch', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: 'pglite:memory://' }),
        })
        expect(switchMemOmitDry.status).toBe(400)
        expect((await switchMemOmitDry.json()).error).toBe('invalid_database_url')

        // Reject pglite:memory on /transfer when dryRun is false
        const transferMemRes = await app.request('/api/admin/db/transfer', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: 'pglite:memory', dryRun: false }),
        })
        expect(transferMemRes.status).toBe(400)
        expect((await transferMemRes.json()).error).toBe('invalid_database_url')

        // dryRun: true on /transfer remains supported
        const transferMemDry = await app.request('/api/admin/db/transfer', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUrl: 'pglite:memory', dryRun: true }),
        })
        expect(transferMemDry.status).toBe(200)

        // 2. REV2-6: /migrate is serialized via dbManager.runExclusive
        const runExclusiveSpy = vi.spyOn(dbManager, 'runExclusive')
        const migRes = await app.request('/api/admin/db/migrate', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ dryRun: true }),
        })
        expect(migRes.status).toBe(200)
        expect(runExclusiveSpy).toHaveBeenCalled()

        // 3. REV2-5: Exclude RESERVED_DOMAIN_SETTING_KEYS from GET /tables/site_settings/rows
        // Seed reserved settings and regular custom settings directly
        await mainDb.query(
          `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES
           ('access', '{"default":"public"}'::jsonb, 'admin', NOW()),
           ('texts', '{"title":"Test"}'::jsonb, 'admin', NOW()),
           ('custom_visible_setting', '{"enabled":true}'::jsonb, 'admin', NOW())`,
        )

        const rowsRes = await app.request('/api/admin/db/tables/site_settings/rows', {
          headers: ADMIN_HEADERS,
        })
        expect(rowsRes.status).toBe(200)
        const rowsData = (await rowsRes.json()) as { ok: boolean; total: number; rows: Array<{ key: string }> }
        expect(rowsData.ok).toBe(true)
        expect(rowsData.total).toBe(1)
        expect(rowsData.rows).toHaveLength(1)
        expect(rowsData.rows[0]?.key).toBe('custom_visible_setting')
        expect(rowsData.rows.some((r) => r.key === 'access')).toBe(false)
        expect(rowsData.rows.some((r) => r.key === 'texts')).toBe(false)

        // Writes to reserved keys are still rejected with reserved_setting_key
        const postReserved = await app.request('/api/admin/db/tables/site_settings/rows', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'access', value: { default: 'public' } }),
        })
        expect(postReserved.status).toBe(400)
        expect((await postReserved.json()).error).toBe('reserved_setting_key')

        const patchReserved = await app.request('/api/admin/db/tables/site_settings/rows/access', {
          method: 'PATCH',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { value: { default: 'login' } } }),
        })
        expect(patchReserved.status).toBe(400)
        expect((await patchReserved.json()).error).toBe('reserved_setting_key')

        const delReserved = await app.request('/api/admin/db/tables/site_settings/rows/access', {
          method: 'DELETE',
          headers: ADMIN_HEADERS,
        })
        expect(delReserved.status).toBe(400)
        expect((await delReserved.json()).error).toBe('reserved_setting_key')
      } finally {
        await dbManager.close()
      }
    })

    it('invalidates AI runtime caches after a successful pull transfer updates site_settings', async () => {
      const mainDir = join(tempRoot, 'pull-cache-main')
      const extDir = join(tempRoot, 'pull-cache-ext')
      const mainDb = createDb(`pglite:${mainDir}`)
      const extDb = createDb(`pglite:${extDir}`)
      await runMigrations(mainDb)
      await runMigrations(extDb)

      // Seed active DB with default enabled search_lectures tool and populate AI cache before pull
      await mainDb.query(
        `INSERT INTO site_settings (key, value, updated_by, updated_at)
         VALUES ('ai_tools', '{"version":1,"engineTools":{"search_lectures":{"enabled":true}},"mcpServers":[]}'::jsonb, 'admin', NOW())`,
      )
      await extDb.query(
        `INSERT INTO site_settings (key, value, updated_by, updated_at)
         VALUES ('ai_tools', '{"version":1,"engineTools":{"search_lectures":{"enabled":false}},"mcpServers":[]}'::jsonb, 'admin', NOW())`,
      )
      await extDb.close()

      const dbManager = createDbManager(mainDb, { databaseUrl: `pglite:${mainDir}` })
      const app = createApp(makeTestConfig({ databaseUrl: `pglite:${mainDir}` }), dbManager.asDb(), {
        dbManager,
      })

      try {
        // Warm runtime cache via GET /api/admin/ai-tools
        const beforeRes = await app.request('/api/admin/ai-tools', { headers: ADMIN_HEADERS })
        expect(beforeRes.status).toBe(200)
        const beforeBody = (await beforeRes.json()) as {
          engineTools: Array<{ name: string; enabled: boolean }>
        }
        expect(beforeBody.engineTools.find((t) => t.name === 'search_lectures')?.enabled).toBe(true)

        // Pull from external DB (overwriting site_settings.ai_tools)
        const pullRes = await app.request('/api/admin/db/transfer', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: `pglite:${extDir}`,
            direction: 'pull',
            conflictStrategy: 'upsert',
            dryRun: false,
          }),
        })
        expect(pullRes.status).toBe(200)

        // Cache must immediately reflect the pulled ai_tools setting without swap or restart
        const afterRes = await app.request('/api/admin/ai-tools', { headers: ADMIN_HEADERS })
        expect(afterRes.status).toBe(200)
        const afterBody = (await afterRes.json()) as {
          engineTools: Array<{ name: string; enabled: boolean }>
        }
        expect(afterBody.engineTools.find((t) => t.name === 'search_lectures')?.enabled).toBe(false)
      } finally {
        await dbManager.close()
      }
    })

    it('preserves JSON null values across push/pull transfer without violating JSONB NOT NULL constraints', async () => {
      const mainDir = join(tempRoot, 'json-null-transfer-main')
      const extDir = join(tempRoot, 'json-null-transfer-ext')
      const mainDb = createDb(`pglite:${mainDir}`)
      const extDb = createDb(`pglite:${extDir}`)
      await runMigrations(mainDb)
      await runMigrations(extDb)
      await extDb.close()

      const dbManager = createDbManager(mainDb, { databaseUrl: `pglite:${mainDir}` })
      const app = createApp(makeTestConfig({ databaseUrl: `pglite:${mainDir}` }), dbManager.asDb(), {
        dbManager,
      })

      try {
        // Store a JSON null setting AND delete a setting (writes new_value='null'::jsonb in history)
        const putNullRes = await app.request('/api/admin/settings/null_setting', {
          method: 'PUT',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: null }),
        })
        expect(putNullRes.status).toBe(200)

        await app.request('/api/admin/settings/to_delete', {
          method: 'PUT',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: 'temp' }),
        })
        const delRes = await app.request('/api/admin/db/tables/site_settings/rows/to_delete', {
          method: 'DELETE',
          headers: ADMIN_HEADERS,
        })
        expect(delRes.status).toBe(200)

        const pushRes = await app.request('/api/admin/db/transfer', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: `pglite:${extDir}`,
            direction: 'push',
            conflictStrategy: 'upsert',
            dryRun: false,
          }),
        })
        expect(pushRes.status).toBe(200)

        const verifyExtDb = createDb(`pglite:${extDir}`)
        try {
          const extSetting = await verifyExtDb.query<{ key: string; value: unknown }>(
            `SELECT key, value FROM site_settings WHERE key = 'null_setting'`,
          )
          expect(extSetting.rows).toHaveLength(1)
          expect(extSetting.rows[0]?.value).toBeNull()

          const extHistory = await verifyExtDb.query<{ setting_key: string; previous_value: unknown; new_value: unknown }>(
            `SELECT setting_key, previous_value, new_value FROM site_settings_history WHERE setting_key = 'to_delete' ORDER BY id ASC`,
          )
          expect(extHistory.rows.length).toBeGreaterThanOrEqual(2)
          expect(extHistory.rows[0]?.previous_value).toBeNull()
          expect(extHistory.rows[extHistory.rows.length - 1]?.new_value).toBeNull()
        } finally {
          await verifyExtDb.close()
        }
      } finally {
        await dbManager.close()
      }
    })

    it('accepts JSON null values in POST and PATCH site_settings CRUD row routes', async () => {
      const dbDir = join(tempRoot, 'json-null-crud-db')
      const mainDb = createDb(`pglite:${dbDir}`)
      await runMigrations(mainDb)

      const dbManager = createDbManager(mainDb, { databaseUrl: `pglite:${dbDir}` })
      const app = createApp(makeTestConfig({ databaseUrl: `pglite:${dbDir}` }), dbManager.asDb(), {
        dbManager,
      })

      try {
        const postRes = await app.request('/api/admin/db/tables/site_settings/rows', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'crud_null_post', value: null }),
        })
        expect(postRes.status).toBe(201)
        const postBody = (await postRes.json()) as { ok: boolean; row: { key: string; value: unknown } }
        expect(postBody.ok).toBe(true)
        expect(postBody.row.key).toBe('crud_null_post')
        expect(postBody.row.value).toBeNull()

        const patchNonNull = await app.request('/api/admin/db/tables/site_settings/rows/crud_null_post', {
          method: 'PATCH',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { value: 'changed' } }),
        })
        expect(patchNonNull.status).toBe(200)

        const patchBackNull = await app.request('/api/admin/db/tables/site_settings/rows/crud_null_post', {
          method: 'PATCH',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: { value: null } }),
        })
        expect(patchBackNull.status).toBe(200)
        const patchBody = (await patchBackNull.json()) as { ok: boolean; row: { key: string; value: unknown } }
        expect(patchBody.ok).toBe(true)
        expect(patchBody.row.value).toBeNull()
      } finally {
        await dbManager.close()
      }
    })

    it('pins auth and handler operations to one DB per request and drains whole request on swapTo', async () => {
      const dirA = join(tempRoot, 'pin-drain-a')
      const dirB = join(tempRoot, 'pin-drain-b')
      const rawDbA = createDb(`pglite:${dirA}`)
      const dbB = createDb(`pglite:${dirB}`)
      await runMigrations(rawDbA)
      await runMigrations(dbB)

      const events: string[] = []
      let afterBootstrap = false
      let swapStarted = false
      let releaseSwapTrigger!: () => void
      const swapTriggerReady = new Promise<void>((resolve) => {
        releaseSwapTrigger = resolve
      })

      const instrumentedDbA: Db = {
        kind: rawDbA.kind,
        async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
          if (afterBootstrap && sql.includes('auth_sessions') && !swapStarted) {
            swapStarted = true
            const res = await rawDbA.query<T>(sql, params)
            events.push('auth_session_verified_on_dbA')
            releaseSwapTrigger()
            return res
          }
          if (afterBootstrap && sql.includes('INSERT INTO auth_users')) {
            // Yield so swapTo enters drainDb(dbA) BEFORE this handler writes the row
            await new Promise((r) => setTimeout(r, 30))
            events.push('user_insert_on_dbA')
          }
          return rawDbA.query<T>(sql, params)
        },
        exec: (sql) => rawDbA.exec(sql),
        tx: (fn) => rawDbA.tx(fn),
        close: async () => {
          events.push('dbA_closed')
          await rawDbA.close()
        },
        withSession: rawDbA.withSession?.bind(rawDbA),
      }

      const dbManager = createDbManager(instrumentedDbA, { databaseUrl: `pglite:${dirA}` })
      const app = createApp(
        makeTestConfig({ authAdapter: 'local', databaseUrl: `pglite:${dirA}` }),
        dbManager.asDb(),
        { dbManager },
      )

      try {
        // Bootstrap admin user in dbA ONLY (dbB has empty auth_users/auth_sessions)
        const bootRes = await app.request('/api/auth/bootstrap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'admin_a',
            password: 'AdminPassword!123',
            displayName: 'Admin A',
          }),
        })
        expect(bootRes.status).toBe(201)
        const setCookie = bootRes.headers.get('set-cookie') ?? ''
        const cookiePair = setCookie.split(';')[0] ?? ''
        expect(cookiePair).toContain('lec_session=')

        afterBootstrap = true

        // Fire POST /api/admin/users authorized against dbA
        const userReqPromise = Promise.resolve(
          app.request('/api/admin/users', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Cookie: cookiePair,
            },
            body: JSON.stringify({
              username: 'pinned_user',
              password: 'PinnedUser!123',
              displayName: 'Pinned User',
              roles: ['reader'],
            }),
          }),
        ).then((res) => {
          events.push(`user_req_done:${res.status}`)
          return res
        })

        await swapTriggerReady
        const swapStart = Date.now()
        let swapDurationMs = -1
        const swapPromise = dbManager
          .swapTo(dbB, { databaseUrl: `pglite:${dirB}` }, { updateEnv: false })
          .then((r) => {
            swapDurationMs = Date.now() - swapStart
            events.push('swap_done')
            return r
          })

        const [userRes] = await Promise.all([userReqPromise, swapPromise])
        expect(userRes.status).toBe(201)

        // Whole request finished inserting on dbA BEFORE swapTo closed dbA, waking drainDb without hitting 5s timeout
        expect(swapDurationMs).toBeGreaterThanOrEqual(0)
        expect(swapDurationMs).toBeLessThan(2500)
        const insertIdx = events.indexOf('user_insert_on_dbA')
        const closeIdx = events.indexOf('dbA_closed')
        const swapDoneIdx = events.indexOf('swap_done')
        expect(insertIdx).toBeGreaterThan(-1)
        expect(closeIdx).toBeGreaterThan(insertIdx)
        expect(swapDoneIdx).toBeGreaterThan(closeIdx)

        // Request authorized on dbA must NOT insert into dbB
        const dbBUsers = await dbB.query<{ username: string }>('SELECT username FROM auth_users')
        expect(dbBUsers.rows).toEqual([])

        // Verify pinned_user actually landed in dbA
        const reopenedA = createDb(`pglite:${dirA}`)
        try {
          const dbAUsers = await reopenedA.query<{ username: string }>(
            'SELECT username FROM auth_users WHERE username = $1',
            ['pinned_user'],
          )
          expect(dbAUsers.rows).toHaveLength(1)
        } finally {
          await reopenedA.close()
        }
      } finally {
        await dbManager.close().catch(() => {})
      }
    })

    it('reads all logical backup tables inside a single REPEATABLE READ READ ONLY Pg transaction', async () => {
      const pgDir = join(tempRoot, 'backup-snapshot-pgdata')
      const backupDir = join(tempRoot, 'backup-snapshot-archives')
      const pglite = await PGlite.create({ dataDir: pgDir })
      const socketServer = new PGLiteSocketServer({
        db: pglite,
        port: 0,
        host: '127.0.0.1',
        maxConnections: 20,
      })
      await socketServer.start()
      const pgUrl = `postgresql://postgres:postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`

      const pgDb = createDb(pgUrl)
      await runMigrations(pgDb)

      // Seed initial related session + message
      await pgDb.query(
        `INSERT INTO ai_sessions (id, user_id, lecture_id, group_id, title)
         VALUES ('sess-initial', 'reader-1', 'g01/L01', 'g01', 'Initial Session')`,
      )
      await pgDb.query(
        `INSERT INTO ai_messages (id, user_id, session_id, role, content)
         VALUES ('msg-initial', 'reader-1', 'sess-initial', 'user', 'Hello initial')`,
      )

      let observingBackup = false
      let txCount = 0
      const outerQueries: string[] = []
      const txQueries: string[] = []

      const instrumentedPgDb: Db = {
        kind: pgDb.kind,
        query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
          if (observingBackup) outerQueries.push(sql)
          return pgDb.query<T>(sql, params)
        },
        exec: (sql) => pgDb.exec(sql),
        close: () => pgDb.close(),
        tx<R>(fn: (txClient: DbClient) => Promise<R>): Promise<R> {
          if (observingBackup) txCount++
          return pgDb.tx(async (innerTx) => {
            const wrappedTx: DbClient = {
              query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
                if (observingBackup) txQueries.push(sql)
                return innerTx.query<T>(sql, params)
              },
              exec: (sql) => innerTx.exec(sql),
            }
            return fn(wrappedTx)
          })
        },
      }

      const dbManager = createDbManager(instrumentedPgDb, { databaseUrl: pgUrl })
      const app = createApp(makeTestConfig({ databaseUrl: pgUrl }), dbManager.asDb(), { dbManager })
      const prevBackupDir = process.env.BACKUP_DIR
      process.env.BACKUP_DIR = backupDir

      try {
        observingBackup = true
        const res = await app.request('/api/admin/backups', {
          method: 'POST',
          headers: ADMIN_HEADERS,
        })
        observingBackup = false
        expect(res.status).toBe(201)

        const body = (await res.json()) as {
          ok: boolean
          snapshot: { filename: string; tableCounts: { ai_sessions: number; ai_messages: number } }
        }
        expect(body.ok).toBe(true)
        expect(txCount).toBe(1)
        expect(outerQueries).toEqual([])
        expect(txQueries[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        expect(txQueries.slice(1).map((q) => q.match(/FROM\s+(\w+)/)?.[1])).toEqual([
          'site_settings',
          'site_settings_history',
          'progress',
          'ai_sessions',
          'ai_messages',
          'ai_review_checklists',
          'auth_users',
        ])
        expect(body.snapshot.tableCounts.ai_sessions).toBe(1)
        expect(body.snapshot.tableCounts.ai_messages).toBe(1)

        const rawJson = gunzipSync(readFileSync(join(backupDir, body.snapshot.filename))).toString('utf8')
        const parsed = JSON.parse(rawJson) as {
          dialect: string
          tables: {
            ai_sessions: Array<{ id: string }>
            ai_messages: Array<{ id: string; session_id: string }>
          }
        }
        expect(parsed.dialect).toBe('pg')
        const sessionIds = new Set(parsed.tables.ai_sessions.map((s) => s.id))
        expect([...sessionIds]).toEqual(['sess-initial'])
        expect(parsed.tables.ai_messages.every((m) => sessionIds.has(m.session_id))).toBe(true)

        // Verify created archive also passes read-only restore integrity check
        const verifyRes = await app.request('/api/admin/backups/restore', {
          method: 'POST',
          headers: { ...ADMIN_HEADERS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: body.snapshot.filename, dryRun: false }),
        })
        expect(verifyRes.status).toBe(200)
        expect((await verifyRes.json()).ok).toBe(true)
      } finally {
        if (prevBackupDir === undefined) {
          delete process.env.BACKUP_DIR
        } else {
          process.env.BACKUP_DIR = prevBackupDir
        }
        await dbManager.close().catch(() => {})
        await socketServer.stop()
        await pglite.close()
      }
    })
  })
})
