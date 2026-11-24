import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { getSetting } from '../../repo/siteSettings.js'
import { saveSiteContentSetting } from '../../services/contentSync.js'

export function createAdminAccessRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const access = (await getSetting(db, 'access')) ?? { tiers: [] }
    return c.json({ ok: true, access }, 200)
  })

  router.put('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { access?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    if (!body?.access || typeof body.access !== 'object') {
      return c.json({ error: 'invalid_request', message: 'Missing access object' }, 400)
    }

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'access', body.access, {
      filename: 'access.json',
      effect: 'rebuild_required',
      rebuildReason: 'Changes to access tiers require a site rebuild to take effect in static pages',
      updatedBy: userId,
      config,
    })

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Access configuration updated by ${userId} (${persistence.mode}, ${persistence.effect})`,
    })

    return c.json({ ok: true, access: body.access, persistence }, 200)
  })

  return router
}
