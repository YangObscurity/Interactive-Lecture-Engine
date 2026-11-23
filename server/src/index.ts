import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve, type ServerType } from '@hono/node-server'
import { type AppEnv, closeAppResources, createApp } from './app.js'
import { ConfigError, formatConfigSummary, loadConfig } from './config/load.js'
import type { AppConfig } from './config/schema.js'
import { createDb } from './db/index.js'
import { getMigrationStatus, runMigrations } from './db/migrate.js'
import type { Db } from './db/types.js'
import type { Hono } from 'hono'

import { SERVICE_NAME, SERVICE_VERSION } from './version.js'

export { SERVICE_NAME, SERVICE_VERSION }

export interface ServerInstance {
  server: ServerType
  db: Db
  app: Hono<AppEnv>
  config: AppConfig
  port: number
  host: string
  close: () => Promise<void>
}

export async function startServer(
  customEnv?: Record<string, string | undefined>,
  overrides?: { db?: Db },
): Promise<ServerInstance> {
  const cfg = loadConfig(customEnv)
  const summary = formatConfigSummary(cfg)
  console.info(`${SERVICE_NAME} (${SERVICE_VERSION}) config loaded:`, JSON.stringify(summary))

  const db = overrides?.db ?? (await createDb(cfg.databaseUrl))

  // Startup migration check
  const status = await getMigrationStatus(db)
  if (status.pending.length > 0) {
    if (cfg.dbAutoMigrate) {
      console.info(`Applying ${status.pending.length} pending migration(s)...`)
      await runMigrations(db, { log: console.info })
    } else {
      console.error(
        `Found ${status.pending.length} pending migration(s). Refusing to start without migrations applied.\nPlease run: npm run db:migrate`,
      )
      await db.close()
      throw new Error(
        'Pending migrations exist. Refusing to start without migrations applied. Please run: npm run db:migrate',
      )
    }
  }

  const app = createApp(cfg, db)

  return new Promise<ServerInstance>((resolvePromise, reject) => {
    try {
      const server = serve(
        {
          fetch: app.fetch,
          hostname: cfg.host,
          port: cfg.port,
        },
        (info) => {
          console.info(
            `${SERVICE_NAME} (${SERVICE_VERSION}) listening on http://${info.address}:${info.port}`,
          )
          const close = async () => {
            await closeAppResources(app)
            return new Promise<void>((resClose) => {
              server.close(async () => {
                await db.close()
                resClose()
              })
            })
          }
          resolvePromise({
            server,
            db,
            app,
            config: cfg,
            port: info.port,
            host: info.address,
            close,
          })
        },
      )
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Entrypoint helper: loads and validates configuration, prints summary.
 */
export function main(customEnv?: Record<string, string | undefined>): number {
  try {
    const cfg = loadConfig(customEnv)
    const summary = formatConfigSummary(cfg)
    console.info(`${SERVICE_NAME} (${SERVICE_VERSION}) config loaded:`, JSON.stringify(summary))
    return 0
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message)
      return 1
    }
    const message = err instanceof Error ? err.message : 'Unknown startup error'
    console.error(message)
    return 1
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  startServer()
    .then(({ server, db, app }) => {
      const shutdown = async () => {
        console.info('Shutting down server...')
        await closeAppResources(app)
        server.close(async () => {
          await db.close()
          process.exit(0)
        })
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((err) => {
      if (err instanceof ConfigError) {
        console.error(err.message)
      } else {
        const message = err instanceof Error ? err.message : 'Unknown startup error'
        console.error(message)
      }
      process.exit(1)
    })
}
