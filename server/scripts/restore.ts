import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { PGlite } from '@electric-sql/pglite'
import { redactSecret } from '../src/config/load.js'
import { redactUrlSecrets } from '../src/db/index.js'
import { type DbCliOptions, resolveDatabaseConnection } from './db.js'

export interface RestoreOptions extends DbCliOptions {
  archivePath: string
  targetDir?: string
  databaseUrl?: string
  force?: boolean
  skipChecksum?: boolean
}

export interface RestoreResult {
  kind: 'pglite' | 'postgres'
  targetDir?: string
  preservedDir?: string
  rowsRestored?: {
    progress?: number
    aiSessions?: number
  }
  pgRestoreCommand?: string
}

export function verifyChecksum(archivePath: string, checksumPath: string): boolean {
  if (!existsSync(checksumPath)) {
    return true
  }
  const expectedHash = readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0]
  if (!expectedHash) {
    return true
  }
  const fileBytes = readFileSync(archivePath)
  const actualHash = createHash('sha256').update(fileBytes).digest('hex')
  return expectedHash.toLowerCase() === actualHash.toLowerCase()
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const log = options.log ?? ((msg: string) => console.log(msg))

  let dbUrl = options.databaseUrl
  if (!dbUrl) {
    const resolved = resolveDatabaseConnection(options)
    dbUrl = resolved.dbUrl
  }

  // 1. External PostgreSQL: print pg_restore command
  if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
    const cmd = `pg_restore --clean --if-exists -d "$DATABASE_URL" "${options.archivePath}"`
    log(`[restore] External PostgreSQL database detected (${redactSecret(dbUrl)}).`)
    log('[restore] File-level PGlite restore does not apply to external PostgreSQL.')
    log('[restore] To restore PostgreSQL from dump, execute pg_restore:')
    log(`  ${cmd}`)
    return {
      kind: 'postgres',
      pgRestoreCommand: cmd,
    }
  }

  // 2. Local PGlite database
  if (!dbUrl.startsWith('pglite:')) {
    throw new Error(`[restore] Unsupported database URL format: ${redactUrlSecrets(dbUrl)}`)
  }

  const rawDir = options.targetDir ?? dbUrl.slice('pglite:'.length).trim()
  if (!rawDir || rawDir === 'memory' || rawDir === 'memory://') {
    throw new Error(`[restore] Cannot restore into in-memory database: ${dbUrl}`)
  }

  const dataDir = resolve(rawDir)
  const archivePath = resolve(options.archivePath)

  if (!existsSync(archivePath)) {
    throw new Error(`[restore] Archive file not found: ${archivePath}`)
  }

  // Verify sha256 checksum if .sha256 exists
  if (!options.skipChecksum) {
    const checksumPath = `${archivePath}.sha256`
    if (existsSync(checksumPath)) {
      log(`[restore] Verifying SHA256 checksum from ${checksumPath}...`)
      const valid = verifyChecksum(archivePath, checksumPath)
      if (!valid) {
        throw new Error(`[restore] Checksum verification failed for archive: ${archivePath}`)
      }
      log('[restore] Checksum verification passed.')
    } else {
      log('[restore] Note: No .sha256 checksum file found alongside archive. Skipping checksum check.')
    }
  }

  // Refuse to overwrite a non-empty data directory without --force
  let hasExisting = false
  if (existsSync(dataDir)) {
    const existingFiles = readdirSync(dataDir)
    if (existingFiles.length > 0) {
      if (!options.force) {
        throw new Error(
          `Target data directory "${dataDir}" is non-empty (${existingFiles.length} files/dirs). ` +
            'Refusing to overwrite without --force. Pass --force to preserve the old directory and restore.',
        )
      }
      hasExisting = true
    }
  }

  const buf = readFileSync(archivePath)
  // PGlite reports a corrupt archive through an unhandled stream error, so reject it up front.
  try {
    gunzipSync(buf)
  } catch (err) {
    throw new Error(
      `[restore] Archive is not a valid gzip file: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Load into a sibling directory first: the live directory is only touched once the snapshot
  // has been loaded and queried successfully.
  mkdirSync(dirname(dataDir), { recursive: true })
  const stagingDir = `${dataDir}.restoring`
  rmSync(stagingDir, { recursive: true, force: true })

  log(`[restore] Loading snapshot into staging directory: ${stagingDir}`)
  const blob = new File([buf], basename(archivePath))

  let progressCount = 0
  let sessionCount = 0
  let pglite: PGlite | undefined

  try {
    pglite = new PGlite(stagingDir, { loadDataDir: blob })
    await pglite.waitReady
    // Verify basic tables if they exist in the snapshot
    try {
      const pRes = await pglite.query<{ count: string | number }>(
        'SELECT count(*) as count FROM progress',
      )
      progressCount = Number(pRes.rows[0]?.count ?? 0)
    } catch {
      // table might not exist yet if snapshot was empty
    }
    try {
      const sRes = await pglite.query<{ count: string | number }>(
        'SELECT count(*) as count FROM ai_sessions',
      )
      sessionCount = Number(sRes.rows[0]?.count ?? 0)
    } catch {
      // table might not exist
    }
    await pglite.close()
    pglite = undefined
  } catch (err) {
    await pglite?.close().catch(() => undefined)
    rmSync(stagingDir, { recursive: true, force: true })
    throw err
  }

  let preservedDir: string | undefined
  if (hasExisting) {
    const pad = (n: number) => n.toString().padStart(2, '0')
    const now = new Date()
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    preservedDir = `${dataDir}.bak.${ts}`
    log(`[restore] Renaming existing data directory aside to: ${preservedDir}`)
    renameSync(dataDir, preservedDir)
  } else {
    rmSync(dataDir, { recursive: true, force: true })
  }
  renameSync(stagingDir, dataDir)

  log(`[restore] Snapshot restored successfully into: ${dataDir}`)
  log(`[restore] Verified tables: progress rows = ${progressCount}, ai_sessions = ${sessionCount}`)
  if (preservedDir) {
    log(`[restore] Previous database directory preserved at: ${preservedDir}`)
  }

  return {
    kind: 'pglite',
    targetDir: dataDir,
    preservedDir,
    rowsRestored: {
      progress: progressCount,
      aiSessions: sessionCount,
    },
  }
}

export async function runRestoreCli(
  args: string[] = process.argv.slice(2),
  options: DbCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((msg: string) => console.log(msg))
  const error = options.error ?? ((msg: string) => console.error(msg))

  let archivePath: string | undefined
  let targetDir: string | undefined
  let databaseUrl: string | undefined
  let force = false
  let skipChecksum = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--archive' || arg === '--file') {
      const next = args[++i]
      if (!next) {
        error(`Missing value for ${arg}`)
        return 1
      }
      archivePath = next
    } else if (arg.startsWith('--archive=')) {
      archivePath = arg.slice('--archive='.length)
    } else if (arg.startsWith('--file=')) {
      archivePath = arg.slice('--file='.length)
    } else if (arg === '--force') {
      force = true
    } else if (arg === '--skip-checksum') {
      skipChecksum = true
    } else if (arg === '--target-dir') {
      const next = args[++i]
      if (!next) {
        error('Missing value for --target-dir')
        return 1
      }
      targetDir = next
    } else if (arg.startsWith('--target-dir=')) {
      targetDir = arg.slice('--target-dir='.length)
    } else if (arg === '--database-url') {
      const next = args[++i]
      if (!next) {
        error('Missing value for --database-url')
        return 1
      }
      databaseUrl = next
    } else if (arg.startsWith('--database-url=')) {
      databaseUrl = arg.slice('--database-url='.length)
    } else if (arg === '--help' || arg === '-h') {
      log('Usage: restore.ts --archive <path> [--force] [--skip-checksum] [--target-dir <dir>] [--database-url <url>]')
      return 0
    } else {
      error(`Unknown option: ${arg}`)
      return 1
    }
  }

  if (!archivePath) {
    error('Missing required argument: --archive <path-to-tar.gz>')
    return 1
  }

  try {
    await runRestore({
      ...options,
      archivePath,
      targetDir,
      databaseUrl,
      force,
      skipChecksum,
      log,
      error,
    })
    return 0
  } catch (err) {
    error(`[restore error] ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const code = await runRestoreCli()
  if (code !== 0) {
    process.exit(code)
  }
}
