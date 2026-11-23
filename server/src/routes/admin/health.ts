import type { Context } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { getMigrationStatus } from '../../db/migrate.js'
import type { Db } from '../../db/types.js'
import { aiCheck, probeNotion, SERVICE_NAME, SERVICE_VERSION } from '../health.js'
import type { AiRecorder } from '../ai/runtime.js'

export function createAdminHealthHandler(config: AppConfig, db: Db, recorder?: AiRecorder) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Cache-Control', 'no-store')
    c.header('Date', new Date().toUTCString())

    // 1. Probe DB and migrations
    let dbStatus: 'ok' | 'degraded' | 'down' = 'ok'
    let latencyMs = 0
    let appliedCount = 0
    let pendingCount = 0
    let latestApplied: string | null = null

    const start = performance.now()
    try {
      await db.query('SELECT 1')
      const elapsed = performance.now() - start
      latencyMs = Number(elapsed.toFixed(1))
      if (elapsed > 1500) {
        dbStatus = 'degraded'
      }

      const migrationStatus = await getMigrationStatus(db)
      appliedCount = migrationStatus.applied.length
      pendingCount = migrationStatus.pending.length
      if (pendingCount > 0) {
        dbStatus = 'down'
      }
      if (appliedCount > 0) {
        latestApplied = migrationStatus.applied[appliedCount - 1]!.name.replace(/\.sql$/, '')
      }
    } catch {
      dbStatus = 'down'
    }

    // 2. Probe Notion
    const notionStatus = await probeNotion(config.notionHealthUrl)
    const notionConfigured = Boolean(
      config.notionHealthUrl && config.notionHealthUrl.trim() !== '',
    )

    // 3. AI status
    const aiConfigured = config.aiProvider !== 'off'
    const ai = aiCheck(config, recorder)

    const ok = dbStatus !== 'down' && notionStatus !== 'down'

    const dbKind = config.databaseUrl.startsWith('pglite:') ? 'pglite' : 'postgres'

    const responseData = {
      ok,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      time: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      checks: {
        db: {
          status: dbStatus,
          latencyMs,
          migrations: {
            appliedCount,
            pendingCount,
            latestApplied,
          },
        },
        ai: {
          provider: config.aiProvider,
          configured: aiConfigured,
          status: ai.status,
          lastCall: ai.lastCall,
        },
        notion: {
          configured: notionConfigured,
          status: notionStatus,
        },
      },
      runtime: {
        nodeVersion: process.version,
        authAdapter: config.authAdapter,
        headerPreset: config.authHeaderPreset,
        dbKind,
      },
    }

    return c.json(responseData, 200)
  }
}
