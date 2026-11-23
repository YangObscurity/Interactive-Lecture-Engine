import { describe, expect, it } from 'vitest'
import { main, startServer } from '../../src/index.js'

describe('Server Startup & Lifecycle Integration Tests', () => {
  it('refuses to start when pending migrations exist and DB_AUTO_MIGRATE=false', async () => {
    // Unmigrated memory DB with auto migrate false
    const env = {
      DATABASE_URL: 'pglite:memory',
      DB_AUTO_MIGRATE: 'false',
      HOST: '127.0.0.1',
      PORT: '18198',
    }

    await expect(startServer(env)).rejects.toThrow(
      /Pending migrations exist. Refusing to start without migrations applied/,
    )
  })

  it('automatically applies migrations and starts server when DB_AUTO_MIGRATE=true', async () => {
    const env = {
      DATABASE_URL: 'pglite:memory',
      DB_AUTO_MIGRATE: 'true',
      HOST: '127.0.0.1',
      PORT: '18199',
    }

    const instance = await startServer(env)
    try {
      expect(instance.port).toBeGreaterThan(0)
      expect(instance.host).toBe('127.0.0.1')

      // Probe actual HTTP server
      const res = await fetch(`http://${instance.host}:${instance.port}/api/health`)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.ok).toBe(true)
      expect(data.checks.db).toBe('ok')
    } finally {
      await instance.close()
    }
  })

  it('main() returns 1 on invalid configuration', () => {
    const originalEnv = process.env['DATABASE_URL']
    try {
      delete process.env['DATABASE_URL']
      process.env['HOST'] = '127.0.0.1'
      const code = main()
      expect(code).toBe(1)
    } finally {
      if (originalEnv !== undefined) {
        process.env['DATABASE_URL'] = originalEnv
      }
    }
  })
})
