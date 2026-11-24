import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { getSetting } from '../../repo/siteSettings.js'
import { saveSiteContentSetting } from '../../services/contentSync.js'

export function createAdminLookRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const look = (await getSetting(db, 'look')) ?? {
      theme: 'default',
      primaryColor: '#3b82f6',
      accentColor: '#10b981',
    }
    return c.json({ ok: true, look }, 200)
  })

  router.put('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { look?: unknown; theme?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    const payload =
      body?.look && typeof body.look === 'object' && !Array.isArray(body.look)
        ? body.look
        : typeof body?.theme === 'string' && body.theme.trim()
          ? { theme: body.theme.trim() }
          : body?.theme && typeof body.theme === 'object' && !Array.isArray(body.theme)
            ? body.theme
            : null
    if (!payload) {
      return c.json({ error: 'invalid_request', message: 'Missing look object or theme name' }, 400)
    }

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'look', payload, {
      filename: 'look.json',
      effect: 'rebuild_required',
      rebuildReason: 'Theme and style changes require a site rebuild to take effect in static pages',
      updatedBy: userId,
      config,
    })

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Theme look updated by ${userId} (${persistence.mode}, ${persistence.effect})`,
    })

    return c.json({ ok: true, look: payload, persistence }, 200)
  })

  return router
}
