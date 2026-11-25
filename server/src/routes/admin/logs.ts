import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import { serverLogBuffer } from '../../http/logBuffer.js'

export function createAdminLogsRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    const limitQuery = c.req.query('limit')
    const parsed = limitQuery ? Number.parseInt(limitQuery, 10) : 50
    const limit = Number.isFinite(parsed) ? Math.min(200, Math.max(1, parsed)) : 50
    const level = c.req.query('level') || 'all'
    const category = c.req.query('category') || 'all'

    const logs = serverLogBuffer.getEntries({ limit, level, category })
    return c.json({ ok: true, logs, total: logs.length }, 200)
  })

  return router
}
