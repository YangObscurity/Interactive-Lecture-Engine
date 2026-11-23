import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, parseEnv } from '../src/config/env.js'
import { redactSecret } from '../src/config/load.js'
import { validateDatabaseUrl } from '../src/config/schema.js'
import { createDb, redactUrlSecrets } from '../src/db/index.js'
import { getMigrationStatus, runMigrations } from '../src/db/migrate.js'
import {
  previewReassignUserProgress,
  reassignUserProgress,
} from '../src/repo/progress.js'

const DEFAULT_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../.env')

export interface DbCliOptions {
  env?: Record<string, string | undefined>
  envFile?: string | false
  migrationsDir?: string
  log?: (msg: string) => void
  error?: (msg: string) => void
}

function readEnvSetting(
  key: string,
  env: Record<string, string | undefined>,
  dotenv: Record<string, string>,
): string | undefined {
  if (Object.hasOwn(env, key) && env[key] !== undefined) {
    return env[key]
  }
  if (Object.hasOwn(dotenv, key)) {
    return dotenv[key]
  }
  return undefined
}

export function resolveDatabaseConnection(options: DbCliOptions): {
  dbUrl: string
  secretsToScrub: string[]
} {
  const env = options.env ?? process.env
  const envFile = options.envFile === undefined ? DEFAULT_ENV_FILE : options.envFile

  let dotenv: Record<string, string> = {}
  if (envFile !== false && existsSync(envFile)) {
    dotenv = parseEnv(readFileSync(envFile, 'utf8'))
  }

  const rawDirect = readEnvSetting('DATABASE_URL_DIRECT', env, dotenv)
  const rawPrimary = readEnvSetting('DATABASE_URL', env, dotenv)

  const direct = rawDirect?.trim() ?? ''
  const primary = rawPrimary?.trim() ?? ''

  const secretsToScrub = [direct, primary].filter((s) => s.length > 0)

  const chosenKey = direct ? 'DATABASE_URL_DIRECT' : 'DATABASE_URL'
  const chosenVal = direct || primary

  if (!chosenVal) {
    throw new ConfigError(
      'DATABASE_URL: 缺少必填配置项（请设置 DATABASE_URL_DIRECT 或 DATABASE_URL）',
      ['DATABASE_URL'],
    )
  }

  const validationError = validateDatabaseUrl(chosenVal)
  if (validationError !== null) {
    throw new ConfigError(
      `${chosenKey} (${redactSecret(chosenVal)}): ${validationError}`,
      [chosenKey],
    )
  }

  return { dbUrl: chosenVal, secretsToScrub }
}

function scrubMessage(message: string, secrets: string[]): string {
  let out = redactUrlSecrets(message)
  for (const secret of secrets) {
    out = redactUrlSecrets(out, secret)
  }
  return out
}

interface ParsedReassignArgs {
  from?: string
  to?: string
  yes: boolean
}

function parseReassignArgs(args: string[]): ParsedReassignArgs {
  const out: ParsedReassignArgs = { yes: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--yes') {
      out.yes = true
    } else if (arg === '--from') {
      const next = args[i + 1]
      if (next === undefined) {
        throw new Error('Missing value for --from')
      }
      out.from = next
      i++
    } else if (arg.startsWith('--from=')) {
      out.from = arg.slice('--from='.length)
    } else if (arg === '--to') {
      const next = args[i + 1]
      if (next === undefined) {
        throw new Error('Missing value for --to')
      }
      out.to = next
      i++
    } else if (arg.startsWith('--to=')) {
      out.to = arg.slice('--to='.length)
    } else {
      throw new Error(`Unknown flag for reassign: ${arg}`)
    }
  }

  return out
}

export async function runDbCli(
  args: string[] = process.argv.slice(2),
  options: DbCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((msg: string) => console.log(msg))
  const error = options.error ?? ((msg: string) => console.error(msg))

  const [command, ...rest] = args
  if (!command || command === '--help' || command === '-h') {
    error('Usage: db.ts <status | migrate [--dry-run] | reassign --from <id> --to <id> [--yes]>')
    return 1
  }

  let dbUrl: string
  let secretsToScrub: string[] = []
  try {
    const resolved = resolveDatabaseConnection(options)
    dbUrl = resolved.dbUrl
    secretsToScrub = resolved.secretsToScrub
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    error(scrubMessage(msg, secretsToScrub))
    return 1
  }

  const db = createDb(dbUrl)
  try {
    if (command === 'status') {
      if (rest.length > 0) {
        error(`Unknown arguments for status: ${rest.join(' ')}`)
        return 1
      }
      const status = await getMigrationStatus(db, {
        migrationsDir: options.migrationsDir,
      })
      log(`Applied migrations: ${status.applied.length}`)
      for (const m of status.applied) {
        log(`  [applied] v${m.version} ${m.name} (${m.appliedAt})`)
      }
      log(`Pending migrations: ${status.pending.length}`)
      for (const m of status.pending) {
        log(`  [pending] v${m.version} ${m.filename}`)
      }
      return 0
    }

    if (command === 'migrate') {
      let dryRun = false
      for (const arg of rest) {
        if (arg === '--dry-run') {
          dryRun = true
        } else {
          error(`Unknown flag for migrate: ${arg}`)
          return 1
        }
      }

      const result = await runMigrations(db, {
        dryRun,
        migrationsDir: options.migrationsDir,
        log,
      })

      if (dryRun) {
        if (result.dryRunSql && result.dryRunSql.length > 0) {
          log(result.dryRunSql)
        } else {
          log('-- No pending migrations.')
        }
        return 0
      }

      if (result.applied.length === 0) {
        log('Database is already up to date.')
      } else {
        log(`Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`)
      }
      return 0
    }

    if (command === 'reassign') {
      let parsed: ParsedReassignArgs
      try {
        parsed = parseReassignArgs(rest)
      } catch (err) {
        error(err instanceof Error ? err.message : String(err))
        return 1
      }

      const from = parsed.from?.trim() ?? ''
      const to = parsed.to?.trim() ?? ''
      if (!from || !to) {
        error('Both --from <id> and --to <id> are required.')
        return 1
      }
      if (from === to) {
        error('--from and --to must be different user IDs.')
        return 1
      }

      const preview = await previewReassignUserProgress(db, from, to)
      log(
        `Reassign preview: from="${preview.fromUserId}" (${preview.fromCount} rows), to="${preview.toUserId}" (${preview.toCount} rows), overlap=${preview.overlapCount}`,
      )
      if (preview.sessions) {
        log(
          `  ai_sessions: from=${preview.sessions.fromCount}, to=${preview.sessions.toCount}, overlap=${preview.sessions.overlapCount}`,
        )
      }
      if (preview.messages) {
        log(
          `  ai_messages: from=${preview.messages.fromCount}, to=${preview.messages.toCount}, overlap=${preview.messages.overlapCount}`,
        )
      }
      if (preview.checklists) {
        log(
          `  ai_review_checklists: from=${preview.checklists.fromCount}, to=${preview.checklists.toCount}, overlap=${preview.checklists.overlapCount}`,
        )
      }

      if (!parsed.yes) {
        error('Refusing to modify database without --yes. Re-run with --yes to confirm.')
        return 1
      }

      const res = await reassignUserProgress(db, from, to)
      log(
        `Reassigned ${res.deletedFromRows} row(s) from "${res.fromUserId}" to "${res.toUserId}" (${res.upsertedToRows} inserted/updated).`,
      )
      if (res.sessions) {
        log(
          `  ai_sessions: reassigned ${res.sessions.deletedFromRows} row(s) (${res.sessions.upsertedToRows} inserted/updated).`,
        )
      }
      if (res.messages) {
        log(
          `  ai_messages: reassigned ${res.messages.deletedFromRows} row(s) (${res.messages.upsertedToRows} inserted/updated).`,
        )
      }
      if (res.checklists) {
        log(
          `  ai_review_checklists: reassigned ${res.checklists.deletedFromRows} row(s) (${res.checklists.upsertedToRows} inserted/updated).`,
        )
      }
      return 0
    }

    error(`Unknown command: ${command}`)
    return 1
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    error(scrubMessage(msg, secretsToScrub))
    return 1
  } finally {
    await db.close()
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const code = await runDbCli()
  if (code !== 0) {
    process.exit(code)
  }
}
