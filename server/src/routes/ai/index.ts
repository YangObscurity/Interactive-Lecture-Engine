import { Hono, type MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { forbidden, rateLimited } from '../../http/errors.js'
import { createChatHandler } from './chat.js'
import {
  type AiRoute,
  type AiRuntime,
  getRequestUserId,
  isDailyLimitExempt,
  newCallRecord,
  writeAiAccessLog,
} from './runtime.js'
import { createUploadHandler } from './upload.js'

function routeOf(path: string): AiRoute | 'other' {
  if (/\/chat\/?$/.test(path)) return 'chat'
  if (/\/upload\/?$/.test(path)) return 'upload'
  return 'other'
}

export function createAiRouter(config: AppConfig, rt: AiRuntime): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // Access log + AUTH_ADAPTER=none gate. Streaming handlers set `record.deferred` and write the
  // log line themselves when the stream ends.
  router.use('*', async (c, next) => {
    const record = newCallRecord(c, routeOf(c.req.path), rt.now)
    c.set('aiCall', record)
    await next()
    if (!record.deferred) {
      record.status = c.res.status
      if (record.outcome === 'unknown') record.outcome = c.res.status < 400 ? 'ok' : 'rejected'
      const len = Number(c.res.headers.get('content-length'))
      record.bytesOut = Number.isFinite(len) && len > 0 ? len : 0
      writeAiAccessLog(config, rt, getRequestUserId(c), record)
    }
  })

  // With AUTH_ADAPTER=none every visitor is the same 'anonymous' identity: no per-user limits are
  // possible, so the AI proxy stays closed unless the operator opts in explicitly. (With
  // AI_PROVIDER=off there is nothing to protect and the usual 503 ai_not_configured applies.)
  router.use('*', async (c, next) => {
    if (config.aiProvider !== 'off' && config.authAdapter === 'none' && !config.aiAllowAnonymous) {
      throw forbidden('ai_requires_authentication')
    }
    await next()
  })

  // Per-user request rate and daily cap (POST chat/upload only). Authors and admins skip the daily cap.
  const limitRequests: MiddlewareHandler<AppEnv> = async (c, next) => {
    const userId = getRequestUserId(c)
    if (userId) {
      const decision = rt.limiter.check(userId, { exemptDaily: isDailyLimitExempt(c) })
      if (!decision.ok) {
        const record = c.get('aiCall')
        if (record && decision.kind) record.limit = decision.kind
        throw rateLimited(decision.kind ?? 'rate', decision.retryAfterSec)
      }
    }
    await next()
  }

  router.post('/chat', limitRequests, createChatHandler(config, rt))
  router.post('/upload', limitRequests, createUploadHandler(config, rt))

  router.all('*', (c) => {
    return c.json({ error: 'not_found' }, 404)
  })

  return router
}
