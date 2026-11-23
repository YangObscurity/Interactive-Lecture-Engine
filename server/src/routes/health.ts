import type { Context } from 'hono'
import type { AppConfig } from '../config/schema.js'
import { getMigrationStatus } from '../db/migrate.js'
import type { Db } from '../db/types.js'
import { SERVICE_NAME, SERVICE_VERSION } from '../version.js'
import type { AiLastCall, AiRecorder } from './ai/runtime.js'

export { SERVICE_NAME, SERVICE_VERSION }

/** The public health result is cached this long so the endpoint cannot be used as an amplifier (D-12). */
export const HEALTH_CACHE_MS = 10_000

export type HealthStatus = 'ok' | 'degraded' | 'down' | 'off'

export interface HealthResponse {
  ok: boolean
  service: string
  version: string
  checks: {
    db: 'ok' | 'degraded' | 'down'
    ai: 'off' | 'ok' | 'degraded'
    notion: HealthStatus
  }
  /** Result of the last real AI proxy call; omitted until one has happened. */
  aiLastCall?: AiLastCall
  time: string
}

/**
 * AI status without probing the upstream: `off` = not configured; otherwise `ok` unless the last
 * real proxy call failed (`degraded`). `lastCall` is null until a call has been made.
 */
export function aiCheck(
  config: AppConfig,
  recorder?: AiRecorder,
): { status: 'off' | 'ok' | 'degraded'; lastCall: AiLastCall | null } {
  if (config.aiProvider === 'off') return { status: 'off', lastCall: null }
  const lastCall = recorder?.last() ?? null
  return { status: lastCall !== null && !lastCall.ok ? 'degraded' : 'ok', lastCall }
}

export async function probeDb(db: Db): Promise<'ok' | 'degraded' | 'down'> {
  const start = performance.now()
  try {
    await db.query('SELECT 1')
    const status = await getMigrationStatus(db)
    if (status.pending.length > 0) {
      return 'down'
    }
    const elapsed = performance.now() - start
    if (elapsed > 1500) {
      return 'degraded'
    }
    return 'ok'
  } catch (err) {
    console.error('Health check db probe failed:', err instanceof Error ? err.message : err)
    return 'down'
  }
}

export async function probeNotion(notionHealthUrl?: string | null): Promise<HealthStatus> {
  if (!notionHealthUrl || notionHealthUrl.trim() === '') {
    return 'off'
  }
  try {
    const res = await fetch(notionHealthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    return res.ok ? 'ok' : 'down'
  } catch {
    return 'down'
  }
}

interface ProbeResult {
  at: number
  db: HealthResponse['checks']['db']
  notion: HealthStatus
  time: string
}

export interface HealthHandlerOptions {
  ai?: AiRecorder
  now?: () => number
  ttlMs?: number
}

export function createHealthHandler(config: AppConfig, db: Db, options: HealthHandlerOptions = {}) {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? HEALTH_CACHE_MS
  let cached: ProbeResult | null = null
  let inflight: Promise<ProbeResult> | null = null

  const probe = async (): Promise<ProbeResult> => {
    const [dbStatus, notionStatus] = await Promise.all([probeDb(db), probeNotion(config.notionHealthUrl)])
    return { at: now(), db: dbStatus, notion: notionStatus, time: new Date(now()).toISOString() }
  }

  return async (c: Context): Promise<Response> => {
    let snapshot = cached
    if (!snapshot || now() - snapshot.at >= ttlMs || now() < snapshot.at) {
      // Concurrent requests share one probe.
      inflight ??= probe().finally(() => {
        inflight = null
      })
      snapshot = await inflight
      cached = snapshot
    }

    const ai = aiCheck(config, options.ai)
    const checks = { db: snapshot.db, ai: ai.status, notion: snapshot.notion }
    const ok = checks.db !== 'down' && checks.notion !== 'down'

    const body: HealthResponse = {
      ok,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      checks,
      ...(ai.lastCall ? { aiLastCall: ai.lastCall } : {}),
      time: snapshot.time,
    }

    c.header('Cache-Control', 'no-store')
    return c.json(body, 200)
  }
}
