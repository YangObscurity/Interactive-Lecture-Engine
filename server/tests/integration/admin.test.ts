import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import { createMessage } from '../../src/repo/aiMessages.js'
import { upsertSession } from '../../src/repo/aiSessions.js'
import { upsertProgress } from '../../src/repo/progress.js'
import { upsertReviewChecklistBatch } from '../../src/repo/reviewChecklists.js'

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
      students: ['reader'],
    },
    logoutUrl: null,
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
    authCookieName: 'lec_session',
    authCookieSecure: 'auto',
    sessionTtlHours: 12,
    rememberMeDays: 30,
    authMethodsEnabled: 'password,passkey,gateway',
    webauthnRpId: '',
    webauthnRpName: 'Interactive Lecture Engine',
    webauthnOrigin: '',
    ...overrides,
  }
}

describe('Admin Telemetry & Health Integration Tests (M4c)', () => {
  let db: Db
  let config: AppConfig
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    db = createDb('pglite:memory')
    await runMigrations(db)
    config = makeTestConfig()
    app = createApp(config, db)

    // Seed test data for overview counts
    await upsertProgress(db, 'alice', { lecture_id: 'g01-l01', status: '已完成' })
    await upsertProgress(db, 'alice', { lecture_id: 'g01-l02', status: '学习中' })
    const sess = await upsertSession(db, 'alice', { lecture_id: 'g01-l01', title: '会话 1' })
    await createMessage(db, 'alice', { session_id: sess.id, role: 'user', content: '提问一' })
    await createMessage(db, 'alice', { session_id: sess.id, role: 'assistant', content: '回答一' })
    await upsertReviewChecklistBatch(db, 'alice', [
      { lecture_id: 'g01-l01', topic_title: '考点 1', is_completed: true },
      { lecture_id: 'g01-l01', topic_title: '考点 2', is_completed: false },
    ])
  })

  afterAll(async () => {
    await db.close()
  })

  describe('Admin RBAC Guard', () => {
    it('enforces 401 unauthenticated, 403 reader, and allows 200 admin', async () => {
      // 1. Unauthenticated -> 401
      const resUnauth = await app.request('/api/admin/overview')
      expect(resUnauth.status).toBe(401)
      expect(await resUnauth.json()).toEqual({ error: 'unauthenticated' })

      // 2. Reader without admin role -> 403
      const resReader = await app.request('/api/admin/overview', {
        headers: {
          'Remote-User': 'bob',
          'Remote-Groups': 'students',
        },
      })
      expect(resReader.status).toBe(403)
      expect(await resReader.json()).toEqual({ error: 'forbidden' })

      // 3. Admin -> 200
      const resAdmin = await app.request('/api/admin/overview', {
        headers: {
          'Remote-User': 'charlie',
          'Remote-Groups': 'admins',
        },
      })
      expect(resAdmin.status).toBe(200)
    })
  })

  describe('GET /api/admin/overview', () => {
    it('returns exact telemetry aggregates with zero PII or message text', async () => {
      const res = await app.request('/api/admin/overview', {
        headers: {
          'Remote-User': 'admin-user',
          'Remote-Groups': 'admins',
        },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('no-store')
      expect(res.headers.get('date')).toBeTruthy()

      const data = (await res.json()) as {
        generatedAt: string
        totals: Record<string, number>
        byStatus: Record<string, number>
        byGroup: Array<{ group_id: string; total_rows: number; completed: number; in_progress: number; not_started: number }>
        recentActivity: Record<string, number>
      }

      // Check ISO date
      expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false)

      // Check totals
      expect(data.totals.users).toBe(1)
      expect(data.totals.progressRows).toBe(2)
      expect(data.totals.completedLectures).toBe(1)
      expect(data.totals.sessions).toBe(1)
      expect(data.totals.messages).toBe(2)
      expect(data.totals.checklistItems).toBe(2)
      expect(data.totals.completedChecklistItems).toBe(1)

      // Check byStatus
      expect(data.byStatus).toEqual({
        未开始: 0,
        学习中: 1,
        已完成: 1,
      })

      // Check byGroup
      expect(data.byGroup).toHaveLength(1)
      expect(data.byGroup[0]).toEqual({
        group_id: 'g01',
        total_rows: 2,
        completed: 1,
        in_progress: 1,
        not_started: 0,
      })

      // Check recentActivity
      expect(data.recentActivity.progressUpdatedLast24h).toBe(2)
      expect(data.recentActivity.sessionsCreatedLast24h).toBe(1)
      expect(data.recentActivity.messagesCreatedLast24h).toBe(2)

      // PII / Content leak check
      const rawJson = JSON.stringify(data)
      expect(rawJson).not.toContain('提问一')
      expect(rawJson).not.toContain('回答一')
      expect(rawJson).not.toContain('alice')
      expect(rawJson).not.toContain('admin-user')
    })
  })

  describe('GET /api/admin/health', () => {
    it('returns deep runtime and migration health without secrets or hostnames', async () => {
      const res = await app.request('/api/admin/health', {
        headers: {
          'Remote-User': 'admin-user',
          'Remote-Groups': 'admins',
        },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toContain('no-store')
      expect(res.headers.get('date')).toBeTruthy()

      const data = (await res.json()) as {
        ok: boolean
        service: string
        version: string
        time: string
        uptimeSeconds: number
        checks: {
          db: {
            status: string
            latencyMs: number
            migrations: { appliedCount: number; pendingCount: number; latestApplied: string | null }
          }
          ai: { provider: string; configured: boolean; status: string }
          notion: { configured: boolean; status: string }
        }
        runtime: {
          nodeVersion: string
          authAdapter: string
          headerPreset: string
          dbKind: string
        }
      }

      expect(data.ok).toBe(true)
      expect(data.service).toBe('lecture-api')
      expect(data.version).toBe('2026.11.21')
      expect(typeof data.uptimeSeconds).toBe('number')

      // Checks
      expect(data.checks.db.status).toBe('ok')
      expect(data.checks.db.migrations.appliedCount).toBe(3)
      expect(data.checks.db.migrations.pendingCount).toBe(0)
      expect(data.checks.db.migrations.latestApplied).toBe('0003_auth_and_admin_settings')
      expect(data.checks.ai.provider).toBe('off')
      expect(data.checks.ai.configured).toBe(false)
      expect(data.checks.ai.status).toBe('off')
      expect(data.checks.notion.configured).toBe(false)
      expect(data.checks.notion.status).toBe('off')

      // Runtime
      expect(data.runtime.nodeVersion).toBe(process.version)
      expect(data.runtime.authAdapter).toBe('trusted-header')
      expect(data.runtime.headerPreset).toBe('authelia')
      expect(data.runtime.dbKind).toBe('pglite')

      // Secret & hostname leak check
      const rawText = JSON.stringify(data)
      expect(rawText).not.toContain('pglite:memory')
      expect(rawText).not.toContain('127.0.0.1')
      expect(rawText).not.toContain('8100')
      expect(rawText).not.toContain('password')
    })
  })
})
