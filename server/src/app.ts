import type { LanguageModel } from 'ai'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createAuthMiddleware, type AuthResult, type WireSession, type WireSessionUser } from './auth/index.js'
import type { AppConfig } from './config/schema.js'
import { createDbManager, type DbManager } from './db/manager.js'
import type { Db } from './db/types.js'
import { handleAppError, rateLimited } from './http/errors.js'
import { serverLogBuffer } from './http/logBuffer.js'
import { type Clock, WriteRateLimiter } from './http/rateLimit.js'
import { createAdminRouter } from './routes/admin/index.js'
import { createAiRouter } from './routes/ai/index.js'
import { type AiCallRecord, createAiRuntime } from './routes/ai/runtime.js'
import { createHealthHandler } from './routes/health.js'
import { createMcpRouter } from './routes/mcp.js'
import { createMessagesRouter } from './routes/messages.js'
import { createProgressRouter } from './routes/progress.js'
import { createReviewChecklistsRouter } from './routes/reviewChecklists.js'
import { createSessionRouter } from './routes/session.js'
import { createSessionsRouter } from './routes/sessions.js'
import { createToolsRouter } from './routes/tools.js'
import { createAuthRouter } from './routes/auth.js'
import { createMeRouter } from './routes/me.js'
import type { McpClientFactory } from './tools/index.js'

export interface AppVariables {
  auth: AuthResult
  session: WireSession
  effectiveUserId: string | null
  userId: string | null
  user: WireSessionUser | null
  aiCall: AiCallRecord | null
  authSource: 'none' | 'gateway' | 'cookie'
  authMethod: string
  sessionId: string | null
  rememberMe: boolean
  canAccessAdmin: boolean
  canAccessAuthor: boolean
}

export type AppEnv = {
  Variables: AppVariables
}

export interface AppOptions {
  /** Clock used by limits, health cache and AI status (tests inject a fake one). */
  now?: Clock
  /** Test hook to supply an AI SDK LanguageModel (e.g. MockLanguageModelV4) instead of HTTP OpenAI. */
  modelFactory?: (config: AppConfig) => LanguageModel
  /** Test hook to supply an MCP client factory (e.g. InMemoryTransport) for external MCP tests. */
  mcpClientFactory?: McpClientFactory
  /** Live hot-swappable database manager (defaults to wrapping the passed Db). */
  dbManager?: DbManager
}

const appCloseHandlers = new WeakMap<object, () => Promise<void>>()

export async function closeAppResources(app: Hono<AppEnv>): Promise<void> {
  const closeFn = appCloseHandlers.get(app)
  if (closeFn) {
    await closeFn()
  }
}

export function createApp(config: AppConfig, db: Db, options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  const dbManager =
    options.dbManager ??
    createDbManager(db, {
      databaseUrl: config.databaseUrl,
      databaseUrlDirect: config.databaseUrlDirect,
    })
  const effectiveDb = dbManager.asDb()
  const now = options.now ?? Date.now
  const aiRuntime = createAiRuntime(config, {
    now,
    ...(options.modelFactory ? { modelFactory: options.modelFactory } : {}),
    ...(options.mcpClientFactory ? { mcpClientFactory: options.mcpClientFactory } : {}),
  })
  appCloseHandlers.set(app, () => aiRuntime.mcpManager.closeAll())
  const writeLimiter = new WriteRateLimiter(config.writeRatePerMinute, now)
  const authLimiter = new WriteRateLimiter(config.writeRatePerMinute, now)

  // 1. Global Date Header, Read Cache-Control & Structured Audit Ring Logging (Outermost middleware)
  app.use('*', async (c, next) => {
    const startMs = now()
    await next()
    c.header('Date', new Date().toUTCString())
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      c.header('Cache-Control', 'no-store')
    }
    const status = c.res.status
    const path = c.req.path
    if (path.startsWith('/api/auth') || path.startsWith('/api/admin') || status >= 400) {
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
      const category = status >= 500
        ? 'error'
        : path.startsWith('/api/auth')
          ? 'auth'
          : path.startsWith('/api/admin')
            ? 'admin'
            : 'http'
      serverLogBuffer.add({
        level,
        category,
        message: `${c.req.method} ${path} -> ${status} (${Math.max(0, now() - startMs)}ms)`,
        details: {
          method: c.req.method,
          path,
          status,
          userId: c.get('effectiveUserId') ?? 'anonymous',
        },
      })
    }
  })

  // 2. Request body limit:
  // Standard routes: 256 KB (262144 bytes)
  // Upload route (/api/ai/upload): config.aiUploadMaxBytes (default 20 MB)
  const standardLimitMiddleware = bodyLimit({
    maxSize: 256 * 1024,
    onError: (c) => {
      c.header('Date', new Date().toUTCString())
      c.header('Connection', 'close')
      return c.json({ error: 'payload_too_large' }, 413)
    },
  })

  const uploadLimitMiddleware = bodyLimit({
    maxSize: config.aiUploadMaxBytes,
    onError: (c) => {
      c.header('Date', new Date().toUTCString())
      c.header('Connection', 'close')
      return c.json({ error: 'payload_too_large' }, 413)
    },
  })

  app.use('*', async (c, next) => {
    const isUpload =
      c.req.method === 'POST' &&
      (c.req.path === '/api/ai/upload' || c.req.path === '/api/ai/upload/')

    if (isUpload) {
      const cl = c.req.header('content-length')
      if (cl && Number(cl) > config.aiUploadMaxBytes) {
        c.header('Date', new Date().toUTCString())
        c.header('Connection', 'close')
        return c.json({ error: 'payload_too_large' }, 413)
      }
      return uploadLimitMiddleware(c, next)
    }

    return standardLimitMiddleware(c, next)
  })

  // 3. Auth context extraction
  app.use('*', createAuthMiddleware(config, effectiveDb))

  // 4. Route Tier Access Guards
  const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
    const effectiveUserId = c.get('effectiveUserId')
    if (!effectiveUserId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    await next()
  }

  const requireAdminOrAuthor: MiddlewareHandler<AppEnv> = async (c, next) => {
    const effectiveUserId = c.get('effectiveUserId')
    if (!effectiveUserId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const session = c.get('session')
    const roles = session?.roles ?? []
    if (!roles.includes('admin') && !roles.includes('author')) {
      return c.json({ error: 'forbidden' }, 403)
    }
    await next()
  }

  // Per-user write limit for progress, sessions and messages. With AUTH_ADAPTER=none every
  // visitor shares the 'anonymous' identity, so a per-user cap would throttle the whole site:
  // it is skipped there (nginx limit_req is the only cap in that mode).
  const limitWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
    const method = c.req.method
    const isWrite = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE'
    const userId = c.get('effectiveUserId')
    if (isWrite && userId && config.authAdapter !== 'none') {
      const decision = writeLimiter.check(userId)
      if (!decision.ok) {
        throw rateLimited(decision.kind ?? 'write_rate', decision.retryAfterSec)
      }
    }
    await next()
  }

  // Tier guards
  const requireAuthenticatedMe: MiddlewareHandler<AppEnv> = async (c, next) => {
    const effectiveUserId = c.get('effectiveUserId')
    const authSource = c.get('authSource')
    if (!effectiveUserId || effectiveUserId === 'anonymous' || authSource === 'none') {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    await next()
  }

  const limitAuthWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    const clientIp = forwarded || c.req.header('x-real-ip')?.trim() || 'auth-client'
    const decision = authLimiter.check(`auth:${clientIp}`)
    if (!decision.ok) {
      throw rateLimited(decision.kind ?? 'auth_rate', decision.retryAfterSec)
    }
    await next()
  }

  app.use('/api/auth/login', limitAuthWrites)
  app.use('/api/auth/bootstrap', limitAuthWrites)
  app.use('/api/auth/methods/passkey/*', limitAuthWrites)
  app.use('/api/db', requireUser)
  app.use('/api/db/*', requireUser)
  app.use('/api/progress', requireUser)
  app.use('/api/progress/*', requireUser)
  app.use('/api/notion', requireUser)
  app.use('/api/notion/*', requireUser)
  app.use('/api/ai', requireUser)
  app.use('/api/ai/*', requireUser)
  app.use('/api/tools', requireUser)
  app.use('/api/tools/*', requireUser)
  app.use('/api/db', limitWrites)
  app.use('/api/db/*', limitWrites)
  app.use('/api/progress', limitWrites)
  app.use('/api/progress/*', limitWrites)
  app.use('/api/me', requireAuthenticatedMe)
  app.use('/api/me/*', requireAuthenticatedMe)
  app.use('/api/me', limitWrites)
  app.use('/api/me/*', limitWrites)
  app.use('/api/admin', requireAdminOrAuthor)
  app.use('/api/admin/*', requireAdminOrAuthor)

  // 5. Mount Route Handlers
  // Tier 1: Public Routes
  app.get('/api/health', createHealthHandler(config, effectiveDb, { ai: aiRuntime.recorder, now }))
  app.route('/api/auth/session', createSessionRouter())
  app.route('/api/auth', createAuthRouter(config, effectiveDb))

  // Tier 2: User Routes
  const meRouter = createMeRouter(config, effectiveDb)
  app.route('/api/me', meRouter)

  const progressRouter = createProgressRouter(effectiveDb)
  app.route('/api/db/progress', progressRouter)
  app.route('/api/progress', progressRouter)

  const sessionsRouter = createSessionsRouter(effectiveDb)
  app.route('/api/db/sessions', sessionsRouter)

  const messagesRouter = createMessagesRouter(effectiveDb)
  app.route('/api/db/messages', messagesRouter)

  const reviewChecklistsRouter = createReviewChecklistsRouter(effectiveDb)
  app.route('/api/db/review-checklists', reviewChecklistsRouter)
  app.route('/api/db/checklist', reviewChecklistsRouter)

  const aiRouter = createAiRouter(config, aiRuntime)
  app.route('/api/ai', aiRouter)

  const toolsRouter = createToolsRouter(aiRuntime)
  app.route('/api/tools', toolsRouter)

  // Stateless MCP endpoint for Dify (Bearer AI_MCP_TOKEN checked inside mcpRouter)
  const mcpRouter = createMcpRouter(
    config,
    aiRuntime.toolEngine,
    now,
    async (name) => (await aiRuntime.mcpManager.loadConfig()).engineTools[name]?.enabled !== false,
  )
  app.route('/api/mcp', mcpRouter)

  // Tier 3: Admin Routes
  const adminRouter = createAdminRouter(config, effectiveDb, aiRuntime, dbManager)
  app.route('/api/admin', adminRouter)

  // Unimplemented routes fall through
  app.all('/api/notion/*', (c) => c.json({ error: 'not_found' }, 404))

  // 6. Global 404 Not Found & Error Handlers
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  app.onError(handleAppError)

  return app
}
