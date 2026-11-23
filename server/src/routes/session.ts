import { Hono } from 'hono'
import type { AppEnv } from '../app.js'

export function createSessionRouter(): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    const session = c.get('session')
    return c.json(session, 200)
  })

  router.all('/', (c) => {
    c.header('Allow', 'GET')
    c.header('Cache-Control', 'no-store')
    return c.json({ error: 'method_not_allowed' }, 405)
  })

  return router
}
