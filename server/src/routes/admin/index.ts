import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import type { Db } from '../../db/types.js'
import type { AiRuntime } from '../ai/runtime.js'
import { createAdminAiToolsHandler } from './aiTools.js'
import { createAdminHealthHandler } from './health.js'
import { createAdminOverviewHandler } from './overview.js'

export function createAdminRouter(config: AppConfig, db: Db, aiRuntime?: AiRuntime): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/overview', createAdminOverviewHandler(db))
  router.get('/health', createAdminHealthHandler(config, db, aiRuntime?.recorder))
  if (aiRuntime) {
    router.get('/ai-tools', createAdminAiToolsHandler(config, aiRuntime))
  }

  router.all('*', (c) => {
    return c.json({ error: 'not_found' }, 404)
  })

  return router
}
