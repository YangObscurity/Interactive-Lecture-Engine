import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import type { AiRuntime } from '../ai/runtime.js'

export function createAdminRuntimeRouter(config: AppConfig, aiRuntime?: AiRuntime): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    return c.json(
      {
        ok: true,
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        authAdapter: config.authAdapter,
        pid: process.pid,
      },
      200,
    )
  })

  router.post('/reload', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      await aiRuntime?.prompts?.reload()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      serverLogBuffer.add({
        level: 'error',
        category: 'error',
        message: `Runtime reload failed: ${msg}`,
      })
      return c.json({ ok: false, error: 'reload_failed', message: msg }, 500)
    }

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: 'Runtime prompt store and caches reloaded',
    })

    return c.json(
      {
        ok: true,
        reloadedAt: new Date().toISOString(),
      },
      200,
    )
  })

  return router
}
