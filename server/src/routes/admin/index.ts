import { Hono, type Context, type MiddlewareHandler } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { createDbManager, type DbManager } from '../../db/manager.js'
import type { Db } from '../../db/types.js'
import { getSetting, setSetting, RESERVED_DOMAIN_SETTING_KEYS } from '../../repo/siteSettings.js'
import type { AiRuntime } from '../ai/runtime.js'
import { createAdminAccessRouter } from './access.js'
import { createAdminAiToolsHandler, createAdminAiToolsSaveHandler } from './aiTools.js'
import { createAdminBackupsRouter } from './backups.js'
import { createAdminChecksRouter } from './checks.js'
import { createAdminCompanionRouter } from './companion.js'
import { createAdminDbRouter, type AdminDbRouterOptions } from './db.js'
import { createAdminFiguresRouter } from './figures.js'
import { createAdminHealthHandler } from './health.js'
import { createAdminLogsRouter } from './logs.js'
import { createAdminLookRouter } from './look.js'
import { createAdminOverviewHandler } from './overview.js'
import { createAdminRuntimeRouter } from './runtime.js'
import { createAdminTextsRouter } from './texts.js'
import { createAdminUsersRouter } from './users.js'

export function createAdminRouter(
  config: AppConfig,
  db: Db,
  aiRuntime?: AiRuntime,
  dbManager?: DbManager,
  adminDbOptions?: AdminDbRouterOptions,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>()
  const effectiveDbManager =
    dbManager ??
    createDbManager(db, {
      databaseUrl: config.databaseUrl,
      databaseUrlDirect: config.databaseUrlDirect,
    })

  const requireStrictAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
    const session = c.get('session')
    const roles = session?.roles ?? []
    if (!roles.includes('admin')) {
      return c.json({ error: 'forbidden', message: 'Admin role required' }, 403)
    }
    await next()
  }

  // 1. Author-accessible endpoints
  router.get('/overview', createAdminOverviewHandler(db))
  router.route('/checks', createAdminChecksRouter(config, db))
  router.route('/figures', createAdminFiguresRouter(config))
  router.route('/texts', createAdminTextsRouter(config, db))
  router.route('/companion', createAdminCompanionRouter(config, db, aiRuntime))

  // 2. Strictly Admin-only endpoints
  router.use('/health', requireStrictAdmin)
  router.get('/health', createAdminHealthHandler(config, db, aiRuntime?.recorder))

  if (aiRuntime) {
    router.use('/ai-tools', requireStrictAdmin)
    router.get('/ai-tools', createAdminAiToolsHandler(config, aiRuntime))
    router.put('/ai-tools', createAdminAiToolsSaveHandler(config, db, aiRuntime))
  }

  router.use('/users', requireStrictAdmin)
  router.use('/users/*', requireStrictAdmin)
  router.route('/users', createAdminUsersRouter(db))

  router.use('/access', requireStrictAdmin)
  router.use('/access/*', requireStrictAdmin)
  router.route('/access', createAdminAccessRouter(config, db))

  router.use('/look', requireStrictAdmin)
  router.use('/look/*', requireStrictAdmin)
  router.route('/look', createAdminLookRouter(config, db))

  router.use('/runtime', requireStrictAdmin)
  router.use('/runtime/*', requireStrictAdmin)
  router.route('/runtime', createAdminRuntimeRouter(config, aiRuntime))

  router.use('/logs', requireStrictAdmin)
  router.use('/logs/*', requireStrictAdmin)
  router.route('/logs', createAdminLogsRouter())

  router.use('/backups', requireStrictAdmin)
  router.use('/backups/*', requireStrictAdmin)
  router.route('/backups', createAdminBackupsRouter(db))

  router.use('/db', requireStrictAdmin)
  router.use('/db/*', requireStrictAdmin)
  router.route('/db', createAdminDbRouter(effectiveDbManager, adminDbOptions))

  const reservedSettingResponse = (
    c: Context<AppEnv>,
    key: string,
    action: 'read' | 'modify',
  ) =>
    c.json(
      {
        error: 'reserved_setting_key',
        message: `Cannot ${action} reserved domain setting key "${key}" via generic settings endpoint. Use the dedicated domain API.`,
      },
      400,
    )

  router.use('/settings', requireStrictAdmin)
  router.use('/settings/*', requireStrictAdmin)
  router.get('/settings/:key', async (c) => {
    const key = c.req.param('key')
    if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(key)) {
      return c.json({ error: 'invalid_setting_key', message: 'Invalid setting key' }, 400)
    }
    if (RESERVED_DOMAIN_SETTING_KEYS.has(key)) {
      return reservedSettingResponse(c, key, 'read')
    }
    const val = await getSetting(db, key)
    return c.json({ ok: true, key, value: val }, 200)
  })
  router.put('/settings/:key', async (c) => {
    const key = c.req.param('key')
    if (!/^[a-zA-Z0-9._:-]{1,64}$/.test(key)) {
      return c.json({ error: 'invalid_setting_key', message: 'Invalid setting key' }, 400)
    }
    if (RESERVED_DOMAIN_SETTING_KEYS.has(key)) {
      return reservedSettingResponse(c, key, 'modify')
    }
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('value' in body)) {
      return c.json({ error: 'invalid_request', message: 'Request body must be a JSON object with a value property' }, 400)
    }
    const val = (body as { value: unknown }).value
    await setSetting(db, key, val, c.get('userId') ?? 'admin')
    return c.json({ ok: true, key, value: val }, 200)
  })

  router.all('*', (c) => {
    return c.json({ error: 'not_found' }, 404)
  })

  return router
}
