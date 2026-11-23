import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from './types.js'

export const DEFAULT_MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
)

// Deterministic 32-bit signed integer key for pg_advisory_lock across processes.
export const MIGRATION_ADVISORY_LOCK_ID = 74208100

const MIGRATION_FILE_RE = /^(\d+)_(.+)\.sql$/

export interface AppliedMigration {
  version: number
  name: string
  checksum: string
  appliedAt: string
}

export interface MigrationFile {
  version: number
  name: string
  filename: string
  sql: string
  checksum: string
}

export interface MigrationStatus {
  applied: AppliedMigration[]
  pending: MigrationFile[]
}

export interface MigrationOptions {
  migrationsDir?: string
}

export interface RunMigrationsOptions extends MigrationOptions {
  dryRun?: boolean
  log?: (msg: string) => void
}

export interface RunMigrationsResult {
  applied: string[]
  dryRunSql?: string
}

export class MigrationChecksumError extends Error {
  readonly version: number
  readonly migrationName: string
  readonly expectedChecksum: string
  readonly actualChecksum: string | null

  constructor(
    message: string,
    details: {
      version: number
      migrationName: string
      expectedChecksum: string
      actualChecksum: string | null
    },
  ) {
    super(message)
    this.name = 'MigrationChecksumError'
    this.version = details.version
    this.migrationName = details.migrationName
    this.expectedChecksum = details.expectedChecksum
    this.actualChecksum = details.actualChecksum
  }
}

export function computeMigrationChecksum(sql: string): string {
  const normalized = sql.replace(/\r\n/g, '\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

export function loadMigrationFiles(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  if (!existsSync(migrationsDir)) {
    throw new Error(`Migrations directory does not exist: ${migrationsDir}`)
  }

  const entries = readdirSync(migrationsDir, { withFileTypes: true })
  const files: MigrationFile[] = []
  const seenVersions = new Map<number, string>()

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) {
      continue
    }
    const match = MIGRATION_FILE_RE.exec(entry.name)
    if (!match) {
      throw new Error(
        `Invalid migration filename "${entry.name}": expected <digits>_<name>.sql`,
      )
    }

    const version = Number.parseInt(match[1]!, 10)
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(`Invalid migration version in "${entry.name}"`)
    }

    const existing = seenVersions.get(version)
    if (existing) {
      throw new Error(
        `Duplicate migration version ${version}: "${existing}" and "${entry.name}"`,
      )
    }
    seenVersions.set(version, entry.name)

    const rawSql = readFileSync(join(migrationsDir, entry.name), 'utf8')
    const normalizedSql = rawSql.replace(/\r\n/g, '\n')
    files.push({
      version,
      name: entry.name,
      filename: entry.name,
      sql: normalizedSql,
      checksum: computeMigrationChecksum(normalizedSql),
    })
  }

  files.sort((a, b) => a.version - b.version)
  return files
}

interface RawLedgerRow {
  version: number
  name: string
  checksum: string
  applied_at: Date | string
}

export async function getMigrationStatus(
  db: Db,
  opts?: MigrationOptions,
): Promise<MigrationStatus> {
  const migrationsDir = opts?.migrationsDir ?? DEFAULT_MIGRATIONS_DIR
  const diskFiles = loadMigrationFiles(migrationsDir)

  const regRes = await db.query<{ reg: string | null }>(
    "SELECT to_regclass('public.schema_migrations') AS reg",
  )

  if (!regRes.rows[0]?.reg) {
    return {
      applied: [],
      pending: diskFiles,
    }
  }

  const ledgerRes = await db.query<RawLedgerRow>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC',
  )

  const diskByVersion = new Map<number, MigrationFile>()
  for (const file of diskFiles) {
    diskByVersion.set(file.version, file)
  }

  const applied: AppliedMigration[] = []
  const appliedVersions = new Set<number>()

  for (const row of ledgerRes.rows) {
    const version = Number(row.version)
    const disk = diskByVersion.get(version)
    if (!disk) {
      throw new MigrationChecksumError(
        `Applied migration v${version} (${row.name}) is missing from migrations directory`,
        {
          version,
          migrationName: row.name,
          expectedChecksum: row.checksum,
          actualChecksum: null,
        },
      )
    }
    if (disk.checksum !== row.checksum) {
      throw new MigrationChecksumError(
        `Checksum mismatch for applied migration ${disk.filename} (version ${version}): expected ${row.checksum}, got ${disk.checksum}`,
        {
          version,
          migrationName: disk.filename,
          expectedChecksum: row.checksum,
          actualChecksum: disk.checksum,
        },
      )
    }

    appliedVersions.add(version)
    applied.push({
      version,
      name: row.name,
      checksum: row.checksum,
      appliedAt: new Date(row.applied_at).toISOString(),
    })
  }

  const pending = diskFiles.filter((file) => !appliedVersions.has(file.version))
  return { applied, pending }
}

const CREATE_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)
`

export async function runMigrations(
  db: Db,
  opts?: RunMigrationsOptions,
): Promise<RunMigrationsResult> {
  const log = opts?.log ?? ((msg: string) => console.info(msg))

  if (opts?.dryRun) {
    const status = await getMigrationStatus(db, opts)
    const dryRunSql =
      status.pending.length === 0
        ? ''
        : status.pending
            .map(
              (m) =>
                `-- Migration ${m.filename} (version ${m.version}, sha256: ${m.checksum})\n${m.sql.trimEnd()}\n`,
            )
            .join('\n')
    return {
      applied: [],
      dryRunSql,
    }
  }

  async function applyPending(targetDb: Db): Promise<string[]> {
    await targetDb.exec(CREATE_LEDGER_SQL)
    const status = await getMigrationStatus(targetDb, opts)
    const appliedNames: string[] = []

    for (const migration of status.pending) {
      await targetDb.tx(async (txClient) => {
        await txClient.exec(migration.sql)
        await txClient.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.filename, migration.checksum],
        )
      })
      appliedNames.push(migration.filename)
      log(`Applied migration ${migration.filename}`)
    }

    return appliedNames
  }

  if (db.kind === 'pg') {
    const withSession = db.withSession
      ? db.withSession.bind(db)
      : async <R>(fn: (sessionDb: Db) => Promise<R>) => fn(db)

    return withSession(async (sessionDb) => {
      await sessionDb.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID])
      let result: RunMigrationsResult | undefined
      let primaryErr: unknown
      let hasPrimaryErr = false
      try {
        const applied = await applyPending(sessionDb)
        result = { applied }
      } catch (err) {
        hasPrimaryErr = true
        primaryErr = err
      }

      try {
        await sessionDb.query('SELECT pg_advisory_unlock($1)', [
          MIGRATION_ADVISORY_LOCK_ID,
        ])
      } catch (unlockErr) {
        if (!hasPrimaryErr) {
          throw unlockErr
        }
        log(
          `Warning: failed to release pg_advisory_unlock after migration failure: ${unlockErr instanceof Error ? unlockErr.message : String(unlockErr)}`,
        )
      }

      if (hasPrimaryErr) {
        throw primaryErr
      }
      return result!
    })
  }

  log(
    'Skipping pg_advisory_lock on PGlite (single-process WASM engine serialized via local mutex).',
  )
  const applied = await applyPending(db)
  return { applied }
}
