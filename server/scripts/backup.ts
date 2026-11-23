import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { redactSecret } from '../src/config/load.js'
import { redactUrlSecrets } from '../src/db/index.js'
import { type DbCliOptions, resolveDatabaseConnection } from './db.js'

export interface BackupOptions extends DbCliOptions {
  backupDir?: string
  retention?: number
  databaseUrl?: string
}

export interface BackupResult {
  kind: 'pglite' | 'postgres'
  archivePath?: string
  checksumPath?: string
  sizeBytes?: number
  sha256?: string
  retained?: number
  pruned?: string[]
  pgDumpCommand?: string
}

const DEFAULT_BACKUP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../backups')
const DEFAULT_RETENTION = 14

export function formatTimestamp(date: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  const y = date.getFullYear()
  const m = pad(date.getMonth() + 1)
  const d = pad(date.getDate())
  const h = pad(date.getHours())
  const min = pad(date.getMinutes())
  const s = pad(date.getSeconds())
  return `${y}${m}${d}-${h}${min}${s}`
}

export async function runBackup(options: BackupOptions = {}): Promise<BackupResult> {
  const log = options.log ?? ((msg: string) => console.log(msg))
  const error = options.error ?? ((msg: string) => console.error(msg))

  let dbUrl = options.databaseUrl
  let _secretsToScrub: string[] = []

  if (!dbUrl) {
    const resolved = resolveDatabaseConnection(options)
    dbUrl = resolved.dbUrl
    _secretsToScrub = resolved.secretsToScrub
  }

  const backupDir = resolve(
    options.backupDir ??
      options.env?.BACKUP_DIR ??
      process.env.BACKUP_DIR ??
      DEFAULT_BACKUP_DIR,
  )

  const retention =
    options.retention ??
    (options.env?.BACKUP_RETENTION
      ? Number.parseInt(options.env.BACKUP_RETENTION, 10)
      : process.env.BACKUP_RETENTION
        ? Number.parseInt(process.env.BACKUP_RETENTION, 10)
        : DEFAULT_RETENTION)

  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error(`[backup] Invalid retention "${String(retention)}": expected an integer >= 1`)
  }

  mkdirSync(backupDir, { recursive: true })
  const ts = formatTimestamp()

  // 1. External PostgreSQL: print pg_dump commands
  if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
    const dumpFile = resolve(backupDir, `lecture-api-backup-${ts}.dump`)
    const cmd = `pg_dump "$DATABASE_URL" -Fc -f "${dumpFile}"`
    log(`[backup] External PostgreSQL database detected (${redactSecret(dbUrl)}).`)
    log('[backup] File-level PGlite snapshot does not apply to external PostgreSQL.')
    log('[backup] To back up this database, execute pg_dump:')
    log(`  ${cmd}`)
    return {
      kind: 'postgres',
      pgDumpCommand: cmd,
    }
  }

  // 2. Local PGlite database: dumpDataDir snapshot
  if (!dbUrl.startsWith('pglite:')) {
    error(`[backup] Unsupported database URL format: ${redactUrlSecrets(dbUrl)}`)
    throw new Error(`Unsupported database URL format: ${redactUrlSecrets(dbUrl)}`)
  }

  const rawDir = dbUrl.slice('pglite:'.length).trim()
  if (!rawDir || rawDir === 'memory' || rawDir === 'memory://') {
    throw new Error(
      `[backup] Cannot perform filesystem backup of in-memory database: ${dbUrl}`,
    )
  }

  const dataDir = resolve(rawDir)
  if (!existsSync(dataDir)) {
    throw new Error(`[backup] PGlite data directory does not exist: ${dataDir}`)
  }

  log(`[backup] Creating snapshot of PGlite data dir: ${dataDir}`)
  log('[backup] The API service must be stopped: PGlite allows one process per data directory.')
  const pglite = new PGlite(dataDir)
  let dumpBlob: Blob
  try {
    await pglite.waitReady
    dumpBlob = await pglite.dumpDataDir('gzip')
  } finally {
    await pglite.close()
  }

  const arrayBuffer = await dumpBlob.arrayBuffer()
  const buf = Buffer.from(arrayBuffer)
  const sha256 = createHash('sha256').update(buf).digest('hex')

  const archiveName = `lecture-api-backup-${ts}.tar.gz`
  const archivePath = resolve(backupDir, archiveName)
  const checksumPath = `${archivePath}.sha256`

  // Write to a temp name first so a crash never leaves a truncated file that looks like a backup.
  writeFileSync(`${archivePath}.part`, buf, { mode: 0o600 })
  renameSync(`${archivePath}.part`, archivePath)
  writeFileSync(checksumPath, `${sha256}  ${archiveName}\n`, 'utf8')

  log(`[backup] Snapshot saved: ${archivePath} (${(buf.length / 1024 / 1024).toFixed(2)} MB)`)
  log(`[backup] Checksum saved: ${checksumPath} (SHA256: ${sha256})`)

  // 3. Apply retention: keep latest N backups
  const pruned: string[] = []
  const files = readdirSync(backupDir)
  const archives = files
    .filter((f) => /^lecture-api-backup-\d{8}-\d{6}\.tar\.gz$/.test(f))
    .sort()
    .reverse()

  if (archives.length > retention) {
    const toPrune = archives.slice(retention)
    for (const oldArchive of toPrune) {
      const oldArchivePath = resolve(backupDir, oldArchive)
      const oldChecksumPath = `${oldArchivePath}.sha256`
      try {
        rmSync(oldArchivePath, { force: true })
        rmSync(oldChecksumPath, { force: true })
        pruned.push(oldArchive)
        log(`[backup] Retention pruned: ${oldArchive}`)
      } catch (err) {
        log(`[backup] Warning: failed to prune old backup ${oldArchive}: ${String(err)}`)
      }
    }
  }

  log(`[backup] Retention: keeping ${archives.length - pruned.length} of max ${retention} archive(s).`)

  return {
    kind: 'pglite',
    archivePath,
    checksumPath,
    sizeBytes: buf.length,
    sha256,
    retained: archives.length - pruned.length,
    pruned,
  }
}

export async function runBackupCli(
  args: string[] = process.argv.slice(2),
  options: BackupOptions = {},
): Promise<number> {
  const log = options.log ?? ((msg: string) => console.log(msg))
  const error = options.error ?? ((msg: string) => console.error(msg))

  let backupDir: string | undefined
  let retention: number | undefined
  let databaseUrl: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--dir' || arg === '--backup-dir') {
      const next = args[++i]
      if (!next) {
        error(`Missing value for ${arg}`)
        return 1
      }
      backupDir = next
    } else if (arg.startsWith('--dir=')) {
      backupDir = arg.slice('--dir='.length)
    } else if (arg.startsWith('--backup-dir=')) {
      backupDir = arg.slice('--backup-dir='.length)
    } else if (arg === '--retention') {
      const next = args[++i]
      if (!next) {
        error('Missing value for --retention')
        return 1
      }
      retention = Number.parseInt(next, 10)
    } else if (arg.startsWith('--retention=')) {
      retention = Number.parseInt(arg.slice('--retention='.length), 10)
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
      log('Usage: backup.ts [--dir <path>] [--retention <N>] [--database-url <url>]')
      return 0
    } else {
      error(`Unknown option: ${arg}`)
      return 1
    }
  }

  try {
    await runBackup({
      ...options,
      backupDir: backupDir ?? options.backupDir,
      retention: retention ?? options.retention,
      databaseUrl: databaseUrl ?? options.databaseUrl,
      log,
      error,
    })
    return 0
  } catch (err) {
    error(`[backup error] ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const code = await runBackupCli()
  if (code !== 0) {
    process.exit(code)
  }
}
