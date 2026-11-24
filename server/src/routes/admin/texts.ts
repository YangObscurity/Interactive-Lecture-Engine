import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { getSetting } from '../../repo/siteSettings.js'
import { saveSiteContentSetting } from '../../services/contentSync.js'

const DEFAULT_TEXTS = {
  brand: {
    name: 'Interactive Lecture Engine',
    tagline: 'Scientific & Academic Lecture Engine',
  },
}

export function createAdminTextsRouter(config: AppConfig, db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const texts = (await getSetting(db, 'texts')) ?? DEFAULT_TEXTS
    return c.json({ ok: true, texts }, 200)
  })

  router.put('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { texts?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON body' }, 400)
    }

    if (!body?.texts || typeof body.texts !== 'object') {
      return c.json({ error: 'invalid_request', message: 'Missing texts object' }, 400)
    }

    const userId = c.get('userId') ?? 'admin'
    const persistence = await saveSiteContentSetting(db, 'texts', body.texts, {
      filename: 'site-texts.json',
      effect: 'live',
      updatedBy: userId,
      config,
    })

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Site texts updated by ${userId} (${persistence.mode})`,
    })

    return c.json({ ok: true, texts: body.texts, persistence }, 200)
  })

  return router
}
