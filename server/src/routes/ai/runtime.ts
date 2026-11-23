import { createHash } from 'node:crypto'
import type { LanguageModel } from 'ai'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import {
  AiRequestLimiter,
  type Clock,
  ConcurrencyGate,
  type LimitKind,
  OwnedIdTracker,
} from '../../http/rateLimit.js'
import { createServerPromptStore, type ServerPromptStore } from '../../prompts/companion.js'
import { ExternalMcpManager, type McpClientFactory, ToolEngine } from '../../tools/index.js'

/** Result of the most recent real proxy call (never a synthetic upstream probe). */
export interface AiLastCall {
  ok: boolean
  /** ISO-8601 UTC time the call finished. */
  at: string
  /** HTTP status returned to the client for failures that happened before the stream started. */
  status?: number
}

export interface AiRecorder {
  record(ok: boolean, status?: number): void
  last(): AiLastCall | null
}

export function createAiRecorder(now: Clock = Date.now): AiRecorder {
  let lastCall: AiLastCall | null = null
  return {
    record(ok, status) {
      lastCall = {
        ok,
        at: new Date(now()).toISOString(),
        ...(status !== undefined ? { status } : {}),
      }
    },
    last: () => lastCall,
  }
}

export type AiRoute = 'chat' | 'upload'

export interface AiCallRecord {
  route: AiRoute | 'other'
  startedAt: number
  bytesIn: number
  bytesOut: number
  status: number
  outcome: string
  limit: LimitKind | null
  promptVersion?: number | null
  /** Set by streaming handlers: the access-log line is written when the stream ends. */
  deferred: boolean
  logged: boolean
}

export interface AiRuntime {
  limiter: AiRequestLimiter
  toolsLimiter: AiRequestLimiter
  chatGate: ConcurrencyGate
  uploadGate: ConcurrencyGate
  /** Conversation ids this server has seen for each user (from Dify frames or minted for OpenAI). */
  conversations: OwnedIdTracker
  /** Upload file ids returned to each user. */
  files: OwnedIdTracker
  recorder: AiRecorder
  prompts: ServerPromptStore
  toolEngine: ToolEngine
  mcpManager: ExternalMcpManager
  aiToolMaxSteps: number
  modelFactory?: (config: AppConfig) => LanguageModel
  now: Clock
}

export interface CreateAiRuntimeOptions {
  now?: Clock
  modelFactory?: (config: AppConfig) => LanguageModel
  mcpClientFactory?: McpClientFactory
}

export function createAiRuntime(config: AppConfig, optionsOrNow: Clock | CreateAiRuntimeOptions = Date.now): AiRuntime {
  const opts: CreateAiRuntimeOptions =
    typeof optionsOrNow === 'function' ? { now: optionsOrNow } : optionsOrNow
  const now = opts.now ?? Date.now
  const toolEngine = new ToolEngine(config, { now })
  const mcpManager = new ExternalMcpManager(config, toolEngine, {
    now,
    ...(opts.mcpClientFactory ? { createClient: opts.mcpClientFactory } : {}),
  })

  return {
    limiter: new AiRequestLimiter(config.aiRatePerMinute, config.aiDailyLimit, now),
    toolsLimiter: new AiRequestLimiter(config.aiRatePerMinute, config.aiDailyLimit, now),
    chatGate: new ConcurrencyGate(config.aiMaxConcurrent),
    // Fixed: at most one upload per user at a time (the body is buffered in memory).
    uploadGate: new ConcurrencyGate(1),
    conversations: new OwnedIdTracker(200),
    files: new OwnedIdTracker(200),
    recorder: createAiRecorder(now),
    prompts: createServerPromptStore(config),
    toolEngine,
    mcpManager,
    aiToolMaxSteps: config.aiToolMaxSteps,
    ...(opts.modelFactory ? { modelFactory: opts.modelFactory } : {}),
    now,
  }
}

export function getRequestUserId(c: Context<AppEnv>): string | null {
  const userId = c.get('userId') ?? c.get('effectiveUserId') ?? c.get('user')?.id
  if (typeof userId === 'string' && userId.trim() !== '') {
    return userId.trim()
  }
  return null
}

/** Roles that are not held to the per-user daily AI cap (the cap is for readers; plan_v2_fix_round1 S4). */
export const DAILY_LIMIT_EXEMPT_ROLES = ['author', 'admin'] as const

/**
 * True when the caller is an authenticated author or admin (roles come from the gateway groups via
 * `AUTH_ROLE_MAP`). Anonymous sessions (AUTH_ADAPTER=none, AI_ALLOW_ANONYMOUS) are never exempt.
 */
export function isDailyLimitExempt(c: Context<AppEnv>): boolean {
  const session = c.get('session')
  if (!session || !session.authenticated) return false
  return session.roles.some((role) => (DAILY_LIMIT_EXEMPT_ROLES as readonly string[]).includes(role))
}

export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 16)
}

export function newCallRecord(c: Context<AppEnv>, route: AiRoute | 'other', now: Clock): AiCallRecord {
  const cl = Number(c.req.header('content-length'))
  return {
    route,
    startedAt: now(),
    bytesIn: Number.isFinite(cl) && cl > 0 ? cl : 0,
    bytesOut: 0,
    status: 0,
    outcome: 'unknown',
    limit: null,
    deferred: false,
    logged: false,
  }
}

/**
 * Write one structured access-log line for an AI call. Contains only the hashed user id, route,
 * byte counts, status, duration and limit hits; never prompts, answers, file names or keys.
 */
export function writeAiAccessLog(
  config: AppConfig,
  rt: AiRuntime,
  userId: string | null,
  record: AiCallRecord,
): void {
  if (record.logged) return
  record.logged = true
  if (!config.aiAccessLog) return
  const line = {
    evt: 'ai_call',
    ts: new Date(rt.now()).toISOString(),
    user: userId ? hashUserId(userId) : null,
    route: record.route,
    provider: config.aiProvider,
    status: record.status,
    outcome: record.outcome,
    prompt_version: record.promptVersion ?? null,
    bytes_in: record.bytesIn,
    bytes_out: record.bytesOut,
    ms: Math.max(0, Math.round(rt.now() - record.startedAt)),
    limit: record.limit,
  }
  console.info(JSON.stringify(line))
}
