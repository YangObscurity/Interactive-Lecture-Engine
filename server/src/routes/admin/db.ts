import { randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Hono, type Context } from 'hono'
import type { AppEnv } from '../../app.js'
import { validateDatabaseUrl } from '../../config/schema.js'
import {
  canonicalDbTarget,
  createDb,
  extractPgliteDir,
  redactUrlSecrets,
  type DbManager,
} from '../../db/index.js'
import { getMigrationStatus, runMigrations } from '../../db/migrate.js'
import type { Db, DbClient } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'
import { RESERVED_DOMAIN_SETTING_KEYS } from '../../repo/siteSettings.js'
import {
  createManagedUser,
  deleteManagedUser,
  updateManagedUser,
  UserManagementError,
  type CreateManagedUserInput,
  type UpdateManagedUserInput,
} from '../../services/usersService.js'

const CONNECTION_TIMEOUT_MS = 8000
const MIGRATION_TIMEOUT_MS = 30000
const TRANSFER_BATCH_SIZE = 100

type ColumnKind = 'text' | 'boolean' | 'integer' | 'bigint' | 'timestamptz' | 'jsonb'

interface TransferTableColumn {
  name: string
  kind: ColumnKind
}

interface TransferTableSpec {
  name: string
  pkColumns: readonly string[]
  columns: readonly TransferTableColumn[]
}

const TRANSFER_TABLES: readonly TransferTableSpec[] = [
  {
    name: 'auth_users',
    pkColumns: ['id'],
    columns: [
      { name: 'id', kind: 'text' },
      { name: 'username', kind: 'text' },
      { name: 'email', kind: 'text' },
      { name: 'display_name', kind: 'text' },
      { name: 'password_hash', kind: 'text' },
      { name: 'roles', kind: 'jsonb' },
      { name: 'disabled', kind: 'boolean' },
      { name: 'last_login_at', kind: 'timestamptz' },
      { name: 'created_at', kind: 'timestamptz' },
      { name: 'updated_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'auth_sessions',
    pkColumns: ['id'],
    columns: [
      { name: 'id', kind: 'text' },
      { name: 'user_id', kind: 'text' },
      { name: 'token_hash', kind: 'text' },
      { name: 'auth_method', kind: 'text' },
      { name: 'remember_me', kind: 'boolean' },
      { name: 'user_agent', kind: 'text' },
      { name: 'ip_address', kind: 'text' },
      { name: 'expires_at', kind: 'timestamptz' },
      { name: 'created_at', kind: 'timestamptz' },
      { name: 'last_seen_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'auth_credentials',
    pkColumns: ['id'],
    columns: [
      { name: 'id', kind: 'text' },
      { name: 'user_id', kind: 'text' },
      { name: 'method', kind: 'text' },
      { name: 'credential_id', kind: 'text' },
      { name: 'public_key', kind: 'text' },
      { name: 'algorithm', kind: 'integer' },
      { name: 'sign_count', kind: 'bigint' },
      { name: 'transports', kind: 'jsonb' },
      { name: 'label', kind: 'text' },
      { name: 'aaguid', kind: 'text' },
      { name: 'last_used_at', kind: 'timestamptz' },
      { name: 'created_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'auth_challenges',
    pkColumns: ['challenge'],
    columns: [
      { name: 'challenge', kind: 'text' },
      { name: 'kind', kind: 'text' },
      { name: 'method', kind: 'text' },
      { name: 'user_id', kind: 'text' },
      { name: 'metadata', kind: 'jsonb' },
      { name: 'expires_at', kind: 'timestamptz' },
      { name: 'created_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'site_settings',
    pkColumns: ['key'],
    columns: [
      { name: 'key', kind: 'text' },
      { name: 'value', kind: 'jsonb' },
      { name: 'updated_by', kind: 'text' },
      { name: 'updated_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'site_settings_history',
    pkColumns: ['id'],
    columns: [
      { name: 'id', kind: 'bigint' },
      { name: 'setting_key', kind: 'text' },
      { name: 'previous_value', kind: 'jsonb' },
      { name: 'new_value', kind: 'jsonb' },
      { name: 'updated_by', kind: 'text' },
      { name: 'updated_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'progress',
    pkColumns: ['user_id', 'lecture_id'],
    columns: [
      { name: 'user_id', kind: 'text' },
      { name: 'lecture_id', kind: 'text' },
      { name: 'group_id', kind: 'text' },
      { name: 'status', kind: 'text' },
      { name: 'completed_at', kind: 'timestamptz' },
      { name: 'updated_at', kind: 'timestamptz' },
      { name: 'notion_node_id', kind: 'text' },
      { name: 'notion_page_id', kind: 'text' },
    ],
  },
  {
    name: 'ai_sessions',
    pkColumns: ['user_id', 'id'],
    columns: [
      { name: 'user_id', kind: 'text' },
      { name: 'id', kind: 'text' },
      { name: 'lecture_id', kind: 'text' },
      { name: 'group_id', kind: 'text' },
      { name: 'title', kind: 'text' },
      { name: 'is_archived', kind: 'boolean' },
      { name: 'created_at', kind: 'timestamptz' },
      { name: 'updated_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'ai_messages',
    pkColumns: ['user_id', 'id'],
    columns: [
      { name: 'user_id', kind: 'text' },
      { name: 'id', kind: 'text' },
      { name: 'session_id', kind: 'text' },
      { name: 'role', kind: 'text' },
      { name: 'content', kind: 'text' },
      { name: 'selected_context', kind: 'text' },
      { name: 'model', kind: 'text' },
      { name: 'prompt_tokens', kind: 'integer' },
      { name: 'completion_tokens', kind: 'integer' },
      { name: 'created_at', kind: 'timestamptz' },
    ],
  },
  {
    name: 'ai_review_checklists',
    pkColumns: ['user_id', 'id'],
    columns: [
      { name: 'user_id', kind: 'text' },
      { name: 'id', kind: 'text' },
      { name: 'lecture_id', kind: 'text' },
      { name: 'group_id', kind: 'text' },
      { name: 'topic_title', kind: 'text' },
      { name: 'section_anchor', kind: 'text' },
      { name: 'is_completed', kind: 'boolean' },
      { name: 'pptx_source', kind: 'text' },
      { name: 'priority', kind: 'integer' },
      { name: 'created_at', kind: 'timestamptz' },
      { name: 'updated_at', kind: 'timestamptz' },
    ],
  },
] as const

interface CrudTableSpec {
  name: 'progress' | 'ai_sessions' | 'ai_messages' | 'ai_review_checklists' | 'auth_users' | 'site_settings'
  pkColumns: readonly string[]
  columns: readonly string[]
  readOnlyColumns: readonly string[]
  editableColumns: readonly string[]
  insertableColumns: readonly string[]
  searchableColumns: readonly string[]
  jsonbColumns: ReadonlySet<string>
  defaultSort: string
  hasUpdatedAt: boolean
  autoUuidId: boolean
}

const CRUD_TABLES: readonly CrudTableSpec[] = [
  {
    name: 'progress',
    pkColumns: ['user_id', 'lecture_id'],
    columns: [
      'user_id',
      'lecture_id',
      'group_id',
      'status',
      'completed_at',
      'updated_at',
      'notion_node_id',
      'notion_page_id',
    ],
    readOnlyColumns: ['user_id', 'lecture_id', 'updated_at'],
    editableColumns: ['group_id', 'status', 'completed_at', 'notion_node_id', 'notion_page_id'],
    insertableColumns: [
      'user_id',
      'lecture_id',
      'group_id',
      'status',
      'completed_at',
      'updated_at',
      'notion_node_id',
      'notion_page_id',
    ],
    searchableColumns: ['user_id', 'lecture_id', 'group_id', 'status'],
    jsonbColumns: new Set<string>(),
    defaultSort: 'updated_at',
    hasUpdatedAt: true,
    autoUuidId: false,
  },
  {
    name: 'ai_sessions',
    pkColumns: ['user_id', 'id'],
    columns: [
      'user_id',
      'id',
      'lecture_id',
      'group_id',
      'title',
      'is_archived',
      'created_at',
      'updated_at',
    ],
    readOnlyColumns: ['user_id', 'id', 'created_at', 'updated_at'],
    editableColumns: ['lecture_id', 'group_id', 'title', 'is_archived'],
    insertableColumns: [
      'user_id',
      'id',
      'lecture_id',
      'group_id',
      'title',
      'is_archived',
      'created_at',
      'updated_at',
    ],
    searchableColumns: ['user_id', 'id', 'lecture_id', 'group_id', 'title'],
    jsonbColumns: new Set<string>(),
    defaultSort: 'updated_at',
    hasUpdatedAt: true,
    autoUuidId: true,
  },
  {
    name: 'ai_messages',
    pkColumns: ['user_id', 'id'],
    columns: [
      'user_id',
      'id',
      'session_id',
      'role',
      'content',
      'selected_context',
      'model',
      'prompt_tokens',
      'completion_tokens',
      'created_at',
    ],
    readOnlyColumns: ['user_id', 'id', 'created_at'],
    editableColumns: [
      'session_id',
      'role',
      'content',
      'selected_context',
      'model',
      'prompt_tokens',
      'completion_tokens',
    ],
    insertableColumns: [
      'user_id',
      'id',
      'session_id',
      'role',
      'content',
      'selected_context',
      'model',
      'prompt_tokens',
      'completion_tokens',
      'created_at',
    ],
    searchableColumns: ['user_id', 'id', 'session_id', 'role', 'content', 'model'],
    jsonbColumns: new Set<string>(),
    defaultSort: 'created_at',
    hasUpdatedAt: false,
    autoUuidId: true,
  },
  {
    name: 'ai_review_checklists',
    pkColumns: ['user_id', 'id'],
    columns: [
      'user_id',
      'id',
      'lecture_id',
      'group_id',
      'topic_title',
      'section_anchor',
      'is_completed',
      'pptx_source',
      'priority',
      'created_at',
      'updated_at',
    ],
    readOnlyColumns: ['user_id', 'id', 'created_at', 'updated_at'],
    editableColumns: [
      'lecture_id',
      'group_id',
      'topic_title',
      'section_anchor',
      'is_completed',
      'pptx_source',
      'priority',
    ],
    insertableColumns: [
      'user_id',
      'id',
      'lecture_id',
      'group_id',
      'topic_title',
      'section_anchor',
      'is_completed',
      'pptx_source',
      'priority',
      'created_at',
      'updated_at',
    ],
    searchableColumns: ['user_id', 'id', 'lecture_id', 'group_id', 'topic_title', 'section_anchor'],
    jsonbColumns: new Set<string>(),
    defaultSort: 'updated_at',
    hasUpdatedAt: true,
    autoUuidId: true,
  },
  {
    name: 'auth_users',
    pkColumns: ['id'],
    columns: [
      'id',
      'username',
      'email',
      'display_name',
      'roles',
      'disabled',
      'last_login_at',
      'created_at',
      'updated_at',
    ],
    readOnlyColumns: ['id', 'last_login_at', 'created_at', 'updated_at'],
    editableColumns: ['username', 'email', 'display_name', 'roles', 'disabled', 'password'],
    insertableColumns: [
      'id',
      'username',
      'email',
      'display_name',
      'roles',
      'disabled',
      'last_login_at',
      'created_at',
      'updated_at',
      'password',
    ],
    searchableColumns: ['id', 'username', 'email', 'display_name'],
    jsonbColumns: new Set<string>(['roles']),
    defaultSort: 'created_at',
    hasUpdatedAt: true,
    autoUuidId: true,
  },
  {
    name: 'site_settings',
    pkColumns: ['key'],
    columns: ['key', 'value', 'updated_by', 'updated_at'],
    readOnlyColumns: ['key', 'updated_at'],
    editableColumns: ['value', 'updated_by'],
    insertableColumns: ['key', 'value', 'updated_by', 'updated_at'],
    searchableColumns: ['key', 'updated_by'],
    jsonbColumns: new Set<string>(['value']),
    defaultSort: 'updated_at',
    hasUpdatedAt: true,
    autoUuidId: false,
  },
] as const

const CRUD_TABLE_MAP = new Map<string, CrudTableSpec>(
  CRUD_TABLES.map((spec) => [spec.name, spec]),
)

function scrubErrorMessage(
  err: unknown,
  ...secrets: Array<string | null | undefined>
): string {
  let msg = err instanceof Error ? err.message : String(err)
  for (const s of secrets) {
    if (s && s.trim()) {
      const cleanSecret = s.trim()
      msg = redactUrlSecrets(msg, cleanSecret)
      try {
        const parsed = new URL(cleanSecret)
        if (parsed.username) {
          const decodedUser = decodeURIComponent(parsed.username)
          if (decodedUser.length >= 4 && decodedUser !== 'postgres') {
            msg = msg.split(parsed.username).join('[REDACTED]')
            if (decodedUser !== parsed.username) {
              msg = msg.split(decodedUser).join('[REDACTED]')
            }
          }
        }
      } catch {
        // ignore non-URL secret strings
      }
    }
  }
  return redactUrlSecrets(msg)
}

function redactTarget(url: string | null | undefined): string | null {
  if (!url) return null
  return redactUrlSecrets(url, url)
}

function isPgUrl(url: string): boolean {
  const lower = url.trim().toLowerCase()
  return lower.startsWith('postgres://') || lower.startsWith('postgresql://')
}

function createProbeDb(url: string): Db {
  return createDb(url, {
    pg: {
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: MIGRATION_TIMEOUT_MS,
    },
  })
}

function isUncreatedFilesystemPglite(targetUrl: string): boolean {
  const dir = extractPgliteDir(targetUrl)
  if (!dir || dir === 'memory') return false
  return !existsSync(dir)
}

function assertWritablePgliteParent(targetUrl: string): void {
  const dir = extractPgliteDir(targetUrl)
  if (!dir || dir === 'memory') return
  let probe = resolve(dir)
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  accessSync(probe, constants.W_OK)
}

function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (m) => `\\${m}`)
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${ms}ms`))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

function isActiveFilesystemPglite(targetUrl: string, currentUrl: string): boolean {
  const canonicalTarget = canonicalDbTarget(targetUrl)
  if (!canonicalTarget.startsWith('pglite:') || canonicalTarget === 'pglite:memory://') {
    return false
  }
  return canonicalTarget === canonicalDbTarget(currentUrl)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getPgErrorCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

function isUniqueViolation(err: unknown): boolean {
  if (getPgErrorCode(err) === '23505') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /duplicate key|unique constraint/i.test(msg)
}

function isForeignKeyViolation(err: unknown): boolean {
  if (getPgErrorCode(err) === '23503') return true
  const msg = err instanceof Error ? err.message : String(err)
  return /foreign key constraint/i.test(msg)
}

function isClientConstraintError(err: unknown): boolean {
  const code = getPgErrorCode(err)
  if (
    code === '23502' ||
    code === '23514' ||
    code === '22P02' ||
    code === '22003' ||
    code === '22001' ||
    code === '22007' ||
    code === '22008'
  ) {
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  return /violates check constraint|null value in column|invalid input syntax|out of range|value too long/i.test(
    msg,
  )
}

async function countTableRowsSafe(db: Db, tableName: string): Promise<number | null> {
  const regRes = await db.query<{ reg: string | null }>(
    'SELECT to_regclass($1) AS reg',
    [`public.${tableName}`],
  )
  if (!regRes.rows[0]?.reg) {
    return null
  }
  const countRes = await db.query<{ cnt: string | number }>(
    `SELECT COUNT(*)::int AS cnt FROM "${tableName}"`,
  )
  return Number(countRes.rows[0]?.cnt ?? 0)
}

function serializeColumnValue(value: unknown, kind: ColumnKind): unknown {
  if (value === undefined || value === null) {
    return null
  }
  if (kind === 'jsonb') {
    return typeof value === 'string' ? value : JSON.stringify(value)
  }
  if (kind === 'timestamptz') {
    if (value instanceof Date) {
      return value.toISOString()
    }
    return value
  }
  if (kind === 'bigint') {
    return String(value)
  }
  return value
}

function placeholderForColumn(index: number, kind: ColumnKind): string {
  if (kind === 'jsonb') return `$${index}::jsonb`
  if (kind === 'timestamptz') return `$${index}::timestamptz`
  return `$${index}`
}

function parseLimitParam(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 25
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return 25
  return Math.min(100, Math.max(1, parsed))
}

function parseOffsetParam(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) return 0
  return parsed
}

function extractPrimaryKeyValues(
  spec: CrudTableSpec,
  rawPk: unknown,
): { ok: true; values: string[] } | { ok: false; message: string } {
  if (spec.pkColumns.length === 1 && typeof rawPk === 'string') {
    const trimmed = rawPk.trim()
    if (!trimmed) {
      return { ok: false, message: `Missing primary key "${spec.pkColumns[0]}"` }
    }
    return { ok: true, values: [trimmed] }
  }

  if (!isPlainObject(rawPk)) {
    return {
      ok: false,
      message: `Primary key must provide: ${spec.pkColumns.join(', ')}`,
    }
  }

  const values: string[] = []
  for (const col of spec.pkColumns) {
    const val = rawPk[col]
    if (typeof val !== 'string' || !val.trim()) {
      return { ok: false, message: `Missing or invalid primary key column "${col}"` }
    }
    values.push(val.trim())
  }
  return { ok: true, values }
}

function formatCrudColumnsSql(columns: readonly string[]): string {
  return columns.map((col) => `"${col}"`).join(', ')
}

export class TransferTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransferTimeoutError'
  }
}

function isTransferTimeoutError(err: unknown): boolean {
  if (err instanceof TransferTimeoutError) return true
  if (err instanceof Error && err.name === 'TransferTimeoutError') return true
  return getPgErrorCode(err) === '57014'
}

function makeDeadlineGuard(
  timeoutMs: number,
  phase: string,
  now: () => number = Date.now,
): () => number {
  const deadlineMs = now() + timeoutMs
  return () => {
    const rem = deadlineMs - now()
    if (rem <= 0) {
      throw new TransferTimeoutError(`${phase} timed out after ${timeoutMs}ms`)
    }
    return rem
  }
}

async function applyPgStatementTimeout(
  txClient: DbClient,
  kind: Db['kind'],
  remMs: number,
): Promise<void> {
  if (kind !== 'pg') return
  const boundedMs = Math.max(1, Math.min(Math.floor(remMs), 2147483647))
  await txClient.query(`SET LOCAL statement_timeout = ${boundedMs}`)
}

export interface AdminDbRouterOptions {
  transferWriteTimeoutMs?: number
  now?: () => number
  onActiveDataMutated?: () => Promise<void> | void
}

export function createAdminDbRouter(
  dbManager: DbManager,
  options?: AdminDbRouterOptions,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>()
  const activeDb = dbManager.asDb()
  const transferWriteTimeoutMs = options?.transferWriteTimeoutMs ?? MIGRATION_TIMEOUT_MS * 2
  const now = options?.now ?? Date.now

  // 1. GET /config — inspect current DB engine config, migrations, and table counts
  router.get('/config', async (c) => {
    c.header('Cache-Control', 'no-store')
    const meta = dbManager.getMeta()
    const migStatus = await getMigrationStatus(activeDb)

    const tableCounts: Record<string, number | null> = {}
    for (const spec of CRUD_TABLES) {
      tableCounts[spec.name] = await countTableRowsSafe(activeDb, spec.name)
    }

    return c.json(
      {
        ok: true,
        kind: meta.kind,
        databaseUrl: meta.databaseUrlRedacted,
        databaseUrlDirect: meta.databaseUrlDirectRedacted,
        pgliteDir: meta.pgliteDir,
        envFilePath: meta.envFilePath,
        envWritable: meta.envWritable,
        migrations: {
          applied: migStatus.applied.length,
          pending: migStatus.pending.length,
          total: migStatus.applied.length + migStatus.pending.length,
        },
        tableCounts,
      },
      200,
    )
  })

  // 2. POST /test — test connectivity and migration state of targetUrl
  router.post('/test', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!isPlainObject(body) || typeof body.targetUrl !== 'string') {
      return c.json(
        { error: 'invalid_database_url', message: 'targetUrl string is required' },
        400,
      )
    }

    const targetUrl = body.targetUrl.trim()
    const urlError = validateDatabaseUrl(targetUrl)
    if (urlError !== null) {
      return c.json({ error: 'invalid_database_url', message: urlError }, 400)
    }

    let targetDirectUrl: string | null = null
    if (body.targetDirectUrl !== undefined && body.targetDirectUrl !== null) {
      if (typeof body.targetDirectUrl !== 'string') {
        return c.json(
          { error: 'invalid_database_url', message: 'targetDirectUrl must be a string or null' },
          400,
        )
      }
      const trimmedDirect = body.targetDirectUrl.trim()
      if (trimmedDirect !== '') {
        const directErr = validateDatabaseUrl(trimmedDirect)
        if (directErr !== null) {
          return c.json({ error: 'invalid_database_url', message: directErr }, 400)
        }
        if (!isPgUrl(targetUrl) || !isPgUrl(trimmedDirect)) {
          return c.json(
            {
              error: 'invalid_database_url',
              message: 'targetDirectUrl requires both targetUrl and targetDirectUrl to be postgres:// URLs',
            },
            400,
          )
        }
        targetDirectUrl = trimmedDirect
      }
    }

    const reuseActive = isActiveFilesystemPglite(targetUrl, dbManager.getCurrentUrl())
    const virtualProbe = !reuseActive && isUncreatedFilesystemPglite(targetUrl)
    let tempDb: Db | null = null
    const directBox: { db: Db | null } = { db: null }
    const start = performance.now()

    try {
      if (virtualProbe) {
        assertWritablePgliteParent(targetUrl)
      }
      const testDb = reuseActive
        ? activeDb
        : (tempDb = createProbeDb(virtualProbe ? 'pglite:memory://' : targetUrl))
      const { serverVersion, migStatus } = await withTimeout(
        (async () => {
          const verRes = await testDb.query<{ version: string }>('SELECT version() AS version')
          const status = await getMigrationStatus(testDb)
          if (
            targetDirectUrl !== null &&
            canonicalDbTarget(targetDirectUrl) !== canonicalDbTarget(targetUrl)
          ) {
            directBox.db = createProbeDb(targetDirectUrl)
            await directBox.db.query('SELECT 1')
          }
          return {
            serverVersion: verRes.rows[0]?.version ?? null,
            migStatus: status,
          }
        })(),
        CONNECTION_TIMEOUT_MS,
        'Database connection test',
      )

      return c.json(
        {
          ok: true,
          kind: testDb.kind,
          serverVersion,
          latencyMs: Number((performance.now() - start).toFixed(1)),
          migrationsApplied: migStatus.applied.length,
          migrationsPending: migStatus.pending.length,
          targetRedacted: redactTarget(targetUrl),
        },
        200,
      )
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: scrubErrorMessage(err, targetUrl, targetDirectUrl),
          latencyMs: Number((performance.now() - start).toFixed(1)),
          targetRedacted: redactTarget(targetUrl),
        },
        200,
      )
    } finally {
      if (directBox.db) {
        await directBox.db.close().catch(() => {})
      }
      if (tempDb) {
        await tempDb.close().catch(() => {})
      }
    }
  })

  // 3. POST /init & POST /migrate — run or dry-run migrations
  const handleMigrate = async (c: {
    header: (name: string, val: string) => void
    req: { text: () => Promise<string> }
    json: <T>(data: T, status?: 200 | 400 | 502) => Response
  }) => {
    c.header('Cache-Control', 'no-store')
    let body: Record<string, unknown> = {}
    const rawText = await c.req.text()
    if (rawText.trim() !== '') {
      let parsed: unknown
      try {
        parsed = JSON.parse(rawText)
      } catch {
        return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
      }
      if (!isPlainObject(parsed)) {
        return c.json({ error: 'invalid_request', message: 'Request body must be a JSON object' }, 400)
      }
      body = parsed
    }

    const dryRun = Boolean(body.dryRun)
    if (body.targetUrl !== undefined && body.targetUrl !== null) {
      if (typeof body.targetUrl !== 'string') {
        return c.json({ error: 'invalid_database_url', message: 'targetUrl must be a string' }, 400)
      }
      if (body.targetUrl.trim() === '') {
        return c.json({ error: 'invalid_database_url', message: 'targetUrl cannot be empty' }, 400)
      }
    }

    const targetUrl =
      typeof body.targetUrl === 'string' && body.targetUrl.trim() !== ''
        ? body.targetUrl.trim()
        : null

    if (targetUrl !== null) {
      const urlErr = validateDatabaseUrl(targetUrl)
      if (urlErr !== null) {
        return c.json({ error: 'invalid_database_url', message: urlErr }, 400)
      }
    }

    let targetDirectUrl: string | null = null
    if (body.targetDirectUrl !== undefined && body.targetDirectUrl !== null) {
      if (typeof body.targetDirectUrl !== 'string') {
        return c.json(
          { error: 'invalid_database_url', message: 'targetDirectUrl must be a string or null' },
          400,
        )
      }
      const trimmedDirect = body.targetDirectUrl.trim()
      if (trimmedDirect !== '') {
        const directErr = validateDatabaseUrl(trimmedDirect)
        if (directErr !== null) {
          return c.json({ error: 'invalid_database_url', message: directErr }, 400)
        }
        const effectivePoolUrl = targetUrl ?? dbManager.getCurrentUrl()
        if (!isPgUrl(effectivePoolUrl) || !isPgUrl(trimmedDirect)) {
          return c.json(
            {
              error: 'invalid_database_url',
              message: 'targetDirectUrl is only supported when migrating a postgres:// database',
            },
            400,
          )
        }
        targetDirectUrl = trimmedDirect
      }
    }

    return dbManager.runExclusive(async () => {
      const effectiveMigrateUrl =
        targetDirectUrl ??
        targetUrl ??
        (activeDb.kind === 'pg' ? dbManager.getCurrentDirectUrl() : null)
      const reuseActive =
        effectiveMigrateUrl === null ||
        (targetUrl === null && effectiveMigrateUrl === dbManager.getCurrentUrl()) ||
        isActiveFilesystemPglite(effectiveMigrateUrl, dbManager.getCurrentUrl())
      const virtualDryRun =
        dryRun &&
        !reuseActive &&
        effectiveMigrateUrl !== null &&
        isUncreatedFilesystemPglite(effectiveMigrateUrl)
      let tempDb: Db | null = null

      try {
        if (virtualDryRun && effectiveMigrateUrl) {
          assertWritablePgliteParent(effectiveMigrateUrl)
        }
        const targetDb = reuseActive
          ? activeDb
          : (tempDb = createProbeDb(virtualDryRun ? 'pglite:memory://' : effectiveMigrateUrl!))
        const result = await withTimeout(
          runMigrations(targetDb, { dryRun, log: () => {} }),
          MIGRATION_TIMEOUT_MS,
          'Database migration',
        )
        const status = await getMigrationStatus(targetDb)

        if (!dryRun && result.applied.length > 0) {
          serverLogBuffer.add({
            level: 'info',
            category: 'admin',
            message: `Applied ${result.applied.length} migration(s) on ${targetDb.kind}: ${result.applied.join(', ')}`,
          })
        }

        return c.json(
          {
            ok: true,
            dryRun,
            applied: result.applied,
            pending: status.pending.map((m) => m.filename),
            dryRunSql: result.dryRunSql ?? '',
          },
          200,
        )
      } catch (err) {
        return c.json(
          {
            ok: false,
            error: 'migration_failed',
            message: scrubErrorMessage(err, targetUrl, targetDirectUrl),
          },
          502,
        )
      } finally {
        if (tempDb) {
          await tempDb.close().catch(() => {})
        }
      }
    })
  }

  router.post('/init', (c) => handleMigrate(c))
  router.post('/migrate', (c) => handleMigrate(c))

  // 4. POST /switch — test, optionally migrate, and hot-swap active DB engine
  router.post('/switch', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!isPlainObject(body) || typeof body.targetUrl !== 'string') {
      return c.json(
        { error: 'invalid_database_url', message: 'targetUrl string is required' },
        400,
      )
    }

    const targetUrl = body.targetUrl.trim()
    const urlErr = validateDatabaseUrl(targetUrl)
    if (urlErr !== null) {
      return c.json({ error: 'invalid_database_url', message: urlErr }, 400)
    }

    let targetDirectUrl: string | null = null
    if (body.targetDirectUrl !== undefined && body.targetDirectUrl !== null) {
      if (typeof body.targetDirectUrl !== 'string') {
        return c.json(
          { error: 'invalid_database_url', message: 'targetDirectUrl must be a string or null' },
          400,
        )
      }
      const trimmedDirect = body.targetDirectUrl.trim()
      if (trimmedDirect !== '') {
        const directErr = validateDatabaseUrl(trimmedDirect)
        if (directErr !== null) {
          return c.json({ error: 'invalid_database_url', message: directErr }, 400)
        }
        if (!isPgUrl(targetUrl) || !isPgUrl(trimmedDirect)) {
          return c.json(
            {
              error: 'invalid_database_url',
              message: 'targetDirectUrl requires both targetUrl and targetDirectUrl to be postgres:// URLs',
            },
            400,
          )
        }
        targetDirectUrl = trimmedDirect
      }
    }

    const dryRun = Boolean(body.dryRun)
    const autoMigrate = body.autoMigrate !== false
    const updateEnv = body.updateEnv !== false

    return dbManager.runExclusive(async () => {
      const meta = dbManager.getMeta()
      const sameFsPglite = isActiveFilesystemPglite(targetUrl, dbManager.getCurrentUrl())
      const sameTarget =
        sameFsPglite ||
        (canonicalDbTarget(targetUrl) === canonicalDbTarget(dbManager.getCurrentUrl()) &&
          targetDirectUrl === dbManager.getCurrentDirectUrl())

      if (!dryRun && canonicalDbTarget(targetUrl) === 'pglite:memory://') {
        return c.json(
          {
            error: 'invalid_database_url',
            message: 'In-memory database (pglite:memory) is not supported for persistent database switch',
          },
          400,
        )
      }

      if (dryRun) {
        const virtualDryRun = !sameFsPglite && isUncreatedFilesystemPglite(targetUrl)
        let tempDb: Db | null = null
        let tempDirectDb: Db | null = null
        try {
          if (virtualDryRun) {
            assertWritablePgliteParent(targetUrl)
          }
          const candidateDb = sameFsPglite
            ? activeDb
            : (tempDb = createProbeDb(virtualDryRun ? 'pglite:memory://' : targetUrl))
          await withTimeout(candidateDb.query('SELECT 1'), CONNECTION_TIMEOUT_MS, 'Switch probe')
          const migProbeDb =
            targetDirectUrl && canonicalDbTarget(targetDirectUrl) !== canonicalDbTarget(targetUrl)
              ? (tempDirectDb = createProbeDb(targetDirectUrl))
              : candidateDb
          if (tempDirectDb) {
            await withTimeout(tempDirectDb.query('SELECT 1'), CONNECTION_TIMEOUT_MS, 'Switch direct probe')
          }
          const status = await getMigrationStatus(migProbeDb)
          const migDry = await runMigrations(migProbeDb, { dryRun: true, log: () => {} })

          return c.json(
            {
              ok: true,
              dryRun: true,
              sameTarget,
              previousKind: meta.kind,
              targetKind: candidateDb.kind,
              migrationsApplied: status.applied.length,
              migrationsPending: status.pending.map((m) => m.filename),
              dryRunSql: migDry.dryRunSql ?? '',
              envWritable: meta.envWritable,
              databaseUrl: redactTarget(targetUrl),
            },
            200,
          )
        } catch (err) {
          return c.json(
            {
              ok: false,
              error: 'target_unreachable',
              message: scrubErrorMessage(err, targetUrl, targetDirectUrl),
            },
            502,
          )
        } finally {
          if (tempDirectDb) {
            await tempDirectDb.close().catch(() => {})
          }
          if (tempDb) {
            await tempDb.close().catch(() => {})
          }
        }
      }

      if (sameTarget) {
        return c.json(
          {
            error: 'same_database_target',
            message: 'Target database is already the active database',
          },
          400,
        )
      }

      let probeDb: Db | null = null
      let runtimeDb: Db | null = null
      let migrationsApplied: string[] = []
      let swapped = false

      try {
        probeDb = createProbeDb(targetUrl)
        await withTimeout(probeDb.query('SELECT 1'), CONNECTION_TIMEOUT_MS, 'Switch probe')

        if (autoMigrate) {
          if (
            targetDirectUrl !== null &&
            canonicalDbTarget(targetDirectUrl) !== canonicalDbTarget(targetUrl)
          ) {
            const directDb = createProbeDb(targetDirectUrl)
            try {
              const migRes = await withTimeout(
                runMigrations(directDb, { log: () => {} }),
                MIGRATION_TIMEOUT_MS,
                'Switch direct migration',
              )
              migrationsApplied = migRes.applied
            } finally {
              await directDb.close().catch(() => {})
            }
          } else {
            const migRes = await withTimeout(
              runMigrations(probeDb, { log: () => {} }),
              MIGRATION_TIMEOUT_MS,
              'Switch migration',
            )
            migrationsApplied = migRes.applied
          }
        } else {
          const checkDb =
            targetDirectUrl !== null &&
            canonicalDbTarget(targetDirectUrl) !== canonicalDbTarget(targetUrl)
              ? createProbeDb(targetDirectUrl)
              : null
          try {
            const migStatus = await withTimeout(
              getMigrationStatus(checkDb ?? probeDb),
              CONNECTION_TIMEOUT_MS,
              'Switch migration check',
            )
            if (migStatus.applied.length === 0 || migStatus.pending.length > 0) {
              return c.json(
                {
                  ok: false,
                  error: 'target_not_migrated',
                  message: `Target database is missing required schema migrations (${migStatus.pending.length} pending)`,
                  migrationsApplied: migStatus.applied.length,
                  migrationsPending: migStatus.pending.map((m) => m.filename),
                },
                409,
              )
            }
          } finally {
            if (checkDb) {
              await checkDb.close().catch(() => {})
            }
          }
        }

        if (isPgUrl(targetUrl)) {
          await probeDb.close().catch(() => {})
          probeDb = null
          runtimeDb = createDb(targetUrl)
        } else {
          runtimeDb = probeDb
          probeDb = null
        }

        const swapRes = await dbManager.swapTo(
          runtimeDb,
          {
            databaseUrl: targetUrl,
            databaseUrlDirect: targetDirectUrl,
          },
          { updateEnv },
        )
        swapped = true

        serverLogBuffer.add({
          level: 'info',
          category: 'admin',
          message: `Database engine switched: ${swapRes.previousKind} -> ${swapRes.currentKind} (target=${redactTarget(targetUrl)}, envUpdated=${String(swapRes.envUpdated)})`,
        })

        return c.json(
          {
            ok: true,
            previousKind: swapRes.previousKind,
            currentKind: swapRes.currentKind,
            migrationsApplied,
            envUpdated: swapRes.envUpdated,
            backupPath: swapRes.backupPath,
            databaseUrl: redactTarget(targetUrl),
          },
          200,
        )
      } catch (err) {
        if (runtimeDb && !swapped) {
          await runtimeDb.close().catch(() => {})
        }
        return c.json(
          {
            ok: false,
            error: 'switch_failed',
            message: scrubErrorMessage(err, targetUrl, targetDirectUrl),
          },
          502,
        )
      } finally {
        if (probeDb) {
          await probeDb.close().catch(() => {})
        }
      }
    })
  })

  // 5. POST /transfer — cross-engine FK-ordered data transfer (push or pull)
  router.post('/transfer', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!isPlainObject(body) || typeof body.targetUrl !== 'string') {
      return c.json(
        { error: 'invalid_database_url', message: 'targetUrl string is required' },
        400,
      )
    }

    const targetUrl = body.targetUrl.trim()
    const urlErr = validateDatabaseUrl(targetUrl)
    if (urlErr !== null) {
      return c.json({ error: 'invalid_database_url', message: urlErr }, 400)
    }

    let targetDirectUrl: string | null = null
    if (body.targetDirectUrl !== undefined && body.targetDirectUrl !== null) {
      if (typeof body.targetDirectUrl !== 'string') {
        return c.json(
          { error: 'invalid_database_url', message: 'targetDirectUrl must be a string or null' },
          400,
        )
      }
      const trimmedDirect = body.targetDirectUrl.trim()
      if (trimmedDirect !== '') {
        const directErr = validateDatabaseUrl(trimmedDirect)
        if (directErr !== null) {
          return c.json({ error: 'invalid_database_url', message: directErr }, 400)
        }
        if (!isPgUrl(targetUrl) || !isPgUrl(trimmedDirect)) {
          return c.json(
            {
              error: 'invalid_database_url',
              message: 'targetDirectUrl requires both targetUrl and targetDirectUrl to be postgres:// URLs',
            },
            400,
          )
        }
        targetDirectUrl = trimmedDirect
      }
    }

    const direction = body.direction ?? 'push'
    if (direction !== 'push' && direction !== 'pull') {
      return c.json(
        { error: 'invalid_request', message: 'direction must be "push" or "pull"' },
        400,
      )
    }

    const conflictStrategy = body.conflictStrategy ?? 'upsert'
    if (conflictStrategy !== 'upsert' && conflictStrategy !== 'skip') {
      return c.json(
        { error: 'invalid_request', message: 'conflictStrategy must be "upsert" or "skip"' },
        400,
      )
    }

    const dryRun = Boolean(body.dryRun)
    const migrateTarget = body.migrateTarget !== false

    return dbManager.runExclusive(async () => {
      if (
        canonicalDbTarget(targetUrl) === canonicalDbTarget(dbManager.getCurrentUrl()) ||
        isActiveFilesystemPglite(targetUrl, dbManager.getCurrentUrl())
      ) {
        return c.json(
          {
            error: 'same_database_target',
            message: 'Transfer target cannot be identical to the active database',
          },
          400,
        )
      }

      if (!dryRun && canonicalDbTarget(targetUrl) === 'pglite:memory://') {
        return c.json(
          {
            error: 'invalid_database_url',
            message: 'In-memory database (pglite:memory) is not supported for persistent database transfer',
          },
          400,
        )
      }

      const virtualTargetDry = dryRun && isUncreatedFilesystemPglite(targetUrl)
      let externalDb: Db | null = null

      try {
        if (virtualTargetDry) {
          assertWritablePgliteParent(targetUrl)
        }
        externalDb = createProbeDb(virtualTargetDry ? 'pglite:memory://' : targetUrl)
        await withTimeout(externalDb.query('SELECT 1'), CONNECTION_TIMEOUT_MS, 'Transfer probe')

        const sourceDb = direction === 'push' ? activeDb : externalDb
        const destDb = direction === 'push' ? externalDb : activeDb

        if (dryRun) {
          const tables: Array<{
            table: string
            sourceCount: number | null
            targetCount: number | null
          }> = []

          for (const table of TRANSFER_TABLES) {
            const sourceCount = await countTableRowsSafe(sourceDb, table.name)
            const targetCount = await countTableRowsSafe(destDb, table.name)
            tables.push({
              table: table.name,
              sourceCount,
              targetCount,
            })
          }

          return c.json(
            {
              ok: true,
              dryRun: true,
              direction,
              tables,
            },
            200,
          )
        }

        if (migrateTarget) {
          const destDirectUrl =
            direction === 'push'
              ? targetDirectUrl
              : (destDb.kind === 'pg' ? dbManager.getCurrentDirectUrl() : null)
          if (
            destDirectUrl !== null &&
            canonicalDbTarget(destDirectUrl) !==
              canonicalDbTarget(direction === 'push' ? targetUrl : dbManager.getCurrentUrl())
          ) {
            const migDirectDb = createProbeDb(destDirectUrl)
            try {
              await withTimeout(
                runMigrations(migDirectDb, { log: () => {} }),
                MIGRATION_TIMEOUT_MS,
                'Transfer destination direct migration',
              )
            } finally {
              await migDirectDb.close().catch(() => {})
            }
          } else {
            await withTimeout(
              runMigrations(destDb, { log: () => {} }),
              MIGRATION_TIMEOUT_MS,
              'Transfer destination migration',
            )
          }
        }

        // Snapshot all source tables inside a consistent read transaction before writing destination.
        const sourceKind = sourceDb.kind
        const sourceSnapshots = new Map<string, Record<string, unknown>[]>()
        await sourceDb.tx(async (srcTx) => {
          const assertSourceDeadline = makeDeadlineGuard(
            MIGRATION_TIMEOUT_MS,
            'Transfer source snapshot',
            now,
          )
          if (sourceKind === 'pg') {
            await srcTx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
          }
          for (const table of TRANSFER_TABLES) {
            let rem = assertSourceDeadline()
            await applyPgStatementTimeout(srcTx, sourceKind, rem)
            const existRes = await srcTx.query<{ reg: string | null }>(
              `SELECT to_regclass($1) AS reg`,
              [`public.${table.name}`],
            )
            if (!existRes.rows[0]?.reg) {
              sourceSnapshots.set(table.name, [])
              continue
            }
            rem = assertSourceDeadline()
            await applyPgStatementTimeout(srcTx, sourceKind, rem)
            const colsSql = table.columns
              .map((col) => (col.kind === 'jsonb' ? `"${col.name}"::text AS "${col.name}"` : `"${col.name}"`))
              .join(', ')
            const orderBySql = table.pkColumns.map((pk) => `"${pk}" ASC`).join(', ')
            const rowsRes = await srcTx.query<Record<string, unknown>>(
              `SELECT ${colsSql} FROM "${table.name}" ORDER BY ${orderBySql}`,
            )
            sourceSnapshots.set(table.name, rowsRes.rows)
          }
          assertSourceDeadline()
        })

        const destKind = destDb.kind
        const transferredCounts = new Map<string, number>()

        try {
          await destDb.tx(async (txClient) => {
            const assertWriteDeadline = makeDeadlineGuard(
              transferWriteTimeoutMs,
              'Transfer write',
              now,
            )
            for (const table of TRANSFER_TABLES) {
              assertWriteDeadline()
              const rows = sourceSnapshots.get(table.name) ?? []
              if (rows.length === 0) {
                transferredCounts.set(table.name, 0)
                continue
              }

              const colNamesSql = table.columns.map((col) => `"${col.name}"`).join(', ')
              const pkSql = table.pkColumns.map((pk) => `"${pk}"`).join(', ')
              const pkSet = new Set(table.pkColumns)
              const nonPkCols = table.columns.filter((col) => !pkSet.has(col.name))
              const conflictTargetSql =
                conflictStrategy === 'skip' || nonPkCols.length === 0
                  ? 'ON CONFLICT DO NOTHING'
                  : `ON CONFLICT (${pkSql}) DO UPDATE SET ${nonPkCols.map((col) => `"${col.name}" = EXCLUDED."${col.name}"`).join(', ')}`

              let tableTransferred = 0
              for (let offset = 0; offset < rows.length; offset += TRANSFER_BATCH_SIZE) {
                const rem = assertWriteDeadline()
                await applyPgStatementTimeout(txClient, destKind, rem)
                const batch = rows.slice(offset, offset + TRANSFER_BATCH_SIZE)
                const params: unknown[] = []
                const valueTuples: string[] = []

                for (const row of batch) {
                  const placeholders: string[] = []
                  for (const col of table.columns) {
                    params.push(serializeColumnValue(row[col.name], col.kind))
                    placeholders.push(placeholderForColumn(params.length, col.kind))
                  }
                  valueTuples.push(`(${placeholders.join(', ')})`)
                }

                const sql = `INSERT INTO "${table.name}" (${colNamesSql}) VALUES ${valueTuples.join(', ')} ${conflictTargetSql}`
                const insertRes = await txClient.query(sql, params)
                tableTransferred += insertRes.rowCount
              }

              if (table.name === 'site_settings_history') {
                const rem = assertWriteDeadline()
                await applyPgStatementTimeout(txClient, destKind, rem)
                await txClient.query(
                  `SELECT setval(
                    pg_get_serial_sequence('site_settings_history', 'id'),
                    GREATEST(COALESCE((SELECT MAX(id) FROM site_settings_history), 1), 1),
                    true
                  )`,
                )
              }

              transferredCounts.set(table.name, tableTransferred)
            }
            assertWriteDeadline()
          })
        } catch (writeErr) {
          if (isTransferTimeoutError(writeErr)) {
            return c.json(
              {
                ok: false,
                error: 'transfer_timeout',
                message: scrubErrorMessage(writeErr, targetUrl, targetDirectUrl),
              },
              504,
            )
          }
          if (isUniqueViolation(writeErr)) {
            return c.json(
              {
                ok: false,
                error: 'transfer_unique_conflict',
                message: scrubErrorMessage(writeErr, targetUrl, targetDirectUrl),
              },
              409,
            )
          }
          throw writeErr
        }

        const results: Array<{
          table: string
          sourceCount: number
          transferredCount: number
          targetCount: number
        }> = []

        for (const table of TRANSFER_TABLES) {
          const sourceCount = sourceSnapshots.get(table.name)?.length ?? 0
          const transferredCount = transferredCounts.get(table.name) ?? 0
          const targetCount = (await countTableRowsSafe(destDb, table.name)) ?? 0
          results.push({
            table: table.name,
            sourceCount,
            transferredCount,
            targetCount,
          })
        }

        serverLogBuffer.add({
          level: 'info',
          category: 'admin',
          message: `Database transfer completed: direction=${direction}, strategy=${conflictStrategy}, target=${redactTarget(targetUrl)}`,
        })

        if (direction === 'pull') {
          await options?.onActiveDataMutated?.()
        }

        return c.json(
          {
            ok: true,
            dryRun: false,
            direction,
            conflictStrategy,
            results,
          },
          200,
        )
      } catch (err) {
        if (isTransferTimeoutError(err)) {
          return c.json(
            {
              ok: false,
              error: 'transfer_timeout',
              message: scrubErrorMessage(err, targetUrl, targetDirectUrl),
            },
            504,
          )
        }
        return c.json(
          {
            ok: false,
            error: 'transfer_failed',
            message: scrubErrorMessage(err, targetUrl, targetDirectUrl),
          },
          502,
        )
      } finally {
        if (externalDb) {
          await externalDb.close().catch(() => {})
        }
      }
    })
  })

  // 6. GET /tables — metadata and row counts for whitelisted 6 tables
  router.get('/tables', async (c) => {
    c.header('Cache-Control', 'no-store')
    const tables = await Promise.all(
      CRUD_TABLES.map(async (spec) => ({
        name: spec.name,
        pkColumns: [...spec.pkColumns],
        columns: [...spec.columns],
        readOnlyColumns: [...spec.readOnlyColumns],
        editableColumns: [...spec.editableColumns],
        searchableColumns: [...spec.searchableColumns],
        defaultSort: spec.defaultSort,
        rowCount: await countTableRowsSafe(activeDb, spec.name),
      })),
    )

    return c.json({ ok: true, tables }, 200)
  })

  // 7. GET /tables/:table/rows — paginated, sorted, searchable read
  router.get('/tables/:table/rows', async (c) => {
    c.header('Cache-Control', 'no-store')
    const tableName = c.req.param('table')
    const spec = CRUD_TABLE_MAP.get(tableName)
    if (!spec) {
      return c.json(
        { error: 'invalid_table', message: `Table "${tableName}" is not accessible` },
        400,
      )
    }

    const limit = parseLimitParam(c.req.query('limit'))
    const offset = parseOffsetParam(c.req.query('offset'))

    const rawSort = c.req.query('sort')?.trim()
    let sortCol = spec.defaultSort
    if (rawSort) {
      if (!spec.columns.includes(rawSort)) {
        return c.json(
          { error: 'invalid_sort_column', message: `Invalid sort column "${rawSort}"` },
          400,
        )
      }
      sortCol = rawSort
    }

    const rawOrder = c.req.query('order')?.trim().toLowerCase()
    let orderDir: 'ASC' | 'DESC' = 'DESC'
    if (rawOrder) {
      if (rawOrder !== 'asc' && rawOrder !== 'desc') {
        return c.json(
          { error: 'invalid_sort_order', message: 'order must be "asc" or "desc"' },
          400,
        )
      }
      orderDir = rawOrder === 'asc' ? 'ASC' : 'DESC'
    }

    const whereClauses: string[] = []
    const params: unknown[] = []

    if (spec.name === 'site_settings' && RESERVED_DOMAIN_SETTING_KEYS.size > 0) {
      const reservedList = Array.from(RESERVED_DOMAIN_SETTING_KEYS)
      const reservedPlaceholders = reservedList.map((k) => {
        params.push(k)
        return `$${params.length}`
      })
      whereClauses.push(`"key" NOT IN (${reservedPlaceholders.join(', ')})`)
    }

    const q = c.req.query('q')?.trim() ?? ''
    if (q !== '' && spec.searchableColumns.length > 0) {
      params.push(`%${escapeLikePattern(q)}%`)
      const qParamIdx = params.length
      const clauses = spec.searchableColumns.map(
        (col) => `CAST("${col}" AS TEXT) ILIKE $${qParamIdx} ESCAPE '\\'`,
      )
      whereClauses.push(`(${clauses.join(' OR ')})`)
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''

    const countRes = await activeDb.query<{ cnt: string | number }>(
      `SELECT COUNT(*)::int AS cnt FROM "${spec.name}" ${whereSql}`,
      params,
    )
    const total = Number(countRes.rows[0]?.cnt ?? 0)

    const limitIdx = params.length + 1
    const offsetIdx = params.length + 2
    const tieBreakerSql = spec.pkColumns.map((pk) => `"${pk}" ASC`).join(', ')
    const rowsRes = await activeDb.query<Record<string, unknown>>(
      `SELECT ${formatCrudColumnsSql(spec.columns)}
       FROM "${spec.name}"
       ${whereSql}
       ORDER BY "${sortCol}" ${orderDir}, ${tieBreakerSql}
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, limit, offset],
    )

    return c.json(
      {
        ok: true,
        table: spec.name,
        rows: rowsRes.rows,
        total,
        limit,
        offset,
        sort: sortCol,
        order: orderDir.toLowerCase(),
      },
      200,
    )
  })

  // 8. POST /tables/:table/rows — insert row
  router.post('/tables/:table/rows', async (c) => {
    c.header('Cache-Control', 'no-store')
    const tableName = c.req.param('table')
    const spec = CRUD_TABLE_MAP.get(tableName)
    if (!spec) {
      return c.json(
        { error: 'invalid_table', message: `Table "${tableName}" is not accessible` },
        400,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!isPlainObject(body)) {
      return c.json({ error: 'invalid_request', message: 'Request body must be a JSON object' }, 400)
    }

    const keys = Object.keys(body)
    for (const key of keys) {
      if (!spec.insertableColumns.includes(key)) {
        return c.json(
          { error: 'invalid_column', message: `Column "${key}" is not allowed on "${spec.name}"` },
          400,
        )
      }
    }

    const insertCols: string[] = []
    const insertParams: unknown[] = []
    const placeholders: string[] = []

    const pushField = (colName: string, value: unknown, isJsonb: boolean) => {
      insertCols.push(`"${colName}"`)
      if (isJsonb) {
        insertParams.push(JSON.stringify(value))
        placeholders.push(`$${insertParams.length}::jsonb`)
      } else {
        insertParams.push(value)
        placeholders.push(`$${insertParams.length}`)
      }
    }

    if (spec.name === 'auth_users') {
      try {
        const user = await createManagedUser(activeDb, body as CreateManagedUserInput)
        const row = Object.fromEntries(
          spec.columns.map((col) => [
            col,
            col === 'roles' ? user.roles : (user as unknown as Record<string, unknown>)[col] ?? null,
          ]),
        )
        return c.json(
          {
            ok: true,
            table: spec.name,
            row,
            persistence: { mode: 'db_live', effect: 'live' },
          },
          201,
        )
      } catch (err) {
        if (err instanceof UserManagementError) {
          return c.json({ error: err.code, message: err.message }, err.status)
        }
        throw err
      }
    } else {
      const payload: Record<string, unknown> = { ...body }
      if (
        spec.autoUuidId &&
        (payload.id === undefined || (typeof payload.id === 'string' && payload.id.trim() === ''))
      ) {
        payload.id = randomUUID()
      }

      if (!spec.autoUuidId) {
        for (const pkCol of spec.pkColumns) {
          if (typeof payload[pkCol] !== 'string' || !payload[pkCol].trim()) {
            return c.json(
              { error: 'invalid_primary_key', message: `Primary key column "${pkCol}" must be a non-empty string` },
              400,
            )
          }
          payload[pkCol] = payload[pkCol].trim()
        }
      }

      if (spec.name === 'site_settings') {
        const settingKey = typeof payload.key === 'string' ? payload.key.trim() : ''
        if (RESERVED_DOMAIN_SETTING_KEYS.has(settingKey)) {
          return c.json(
            {
              error: 'reserved_setting_key',
              message: `Cannot insert reserved domain setting key "${settingKey}". Use the dedicated domain API.`,
            },
            400,
          )
        }
        if (typeof payload.updated_by !== 'string' || payload.updated_by.trim() === '') {
          payload.updated_by = c.get('userId') ?? 'admin'
        } else {
          payload.updated_by = payload.updated_by.trim()
        }
      }

      for (const col of spec.insertableColumns) {
        if (!Object.hasOwn(payload, col)) continue
        const val = payload[col]
        if (spec.jsonbColumns.has(col) && val === undefined) continue
        pushField(col, val, spec.jsonbColumns.has(col))
      }

      if (insertCols.length === 0) {
        return c.json({ error: 'invalid_request', message: 'No columns provided' }, 400)
      }
    }

    try {
      const insertedRow =
        spec.name === 'site_settings'
          ? await activeDb.tx(async (txClient) => {
              const res = await txClient.query<Record<string, unknown>>(
                `INSERT INTO "${spec.name}" (${insertCols.join(', ')})
                 VALUES (${placeholders.join(', ')})
                 RETURNING ${formatCrudColumnsSql(spec.columns)}`,
                insertParams,
              )
              const created = res.rows[0] ?? null
              if (created) {
                await txClient.query(
                  `INSERT INTO site_settings_history (setting_key, previous_value, new_value, updated_by, updated_at)
                   VALUES ($1, NULL, $2::jsonb, $3, NOW())`,
                  [
                    String(created.key),
                    JSON.stringify(created.value ?? null),
                    String(created.updated_by ?? c.get('userId') ?? 'admin'),
                  ],
                )
              }
              return created
            })
          : (
              await activeDb.query<Record<string, unknown>>(
                `INSERT INTO "${spec.name}" (${insertCols.join(', ')})
                 VALUES (${placeholders.join(', ')})
                 RETURNING ${formatCrudColumnsSql(spec.columns)}`,
                insertParams,
              )
            ).rows[0] ?? null

      return c.json({ ok: true, table: spec.name, row: insertedRow }, 201)
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json(
          { error: 'conflict', message: scrubErrorMessage(err) },
          409,
        )
      }
      if (isForeignKeyViolation(err) || isClientConstraintError(err)) {
        return c.json(
          { error: 'constraint_violation', message: scrubErrorMessage(err) },
          400,
        )
      }
      throw err
    }
  })

  // 9. PATCH /tables/:table/rows and PATCH /tables/:table/rows/:pk
  const handlePatch = async (
    c: Context<AppEnv>,
    singlePkParam?: string,
  ) => {
    c.header('Cache-Control', 'no-store')
    const tableName = c.req.param('table') ?? ''
    const spec = CRUD_TABLE_MAP.get(tableName)
    if (!spec) {
      return c.json(
        { error: 'invalid_table', message: `Table "${tableName}" is not accessible` },
        400,
      )
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    if (!isPlainObject(body)) {
      return c.json({ error: 'invalid_request', message: 'Request body must be a JSON object' }, 400)
    }

    if (singlePkParam !== undefined && body.pk !== undefined) {
      const bodyPkStr = typeof body.pk === 'string' ? body.pk.trim() : null
      if (bodyPkStr === null || bodyPkStr !== singlePkParam.trim()) {
        return c.json(
          { error: 'primary_key_mismatch', message: 'Body pk does not match URL primary key parameter' },
          400,
        )
      }
    }

    const rawPk = singlePkParam !== undefined ? singlePkParam : body.pk

    const pkExtracted = extractPrimaryKeyValues(spec, rawPk)
    if (!pkExtracted.ok) {
      return c.json({ error: 'invalid_primary_key', message: pkExtracted.message }, 400)
    }

    let data: Record<string, unknown>
    if (body.data !== undefined) {
      if (!isPlainObject(body.data)) {
        return c.json({ error: 'invalid_request', message: 'data must be a JSON object' }, 400)
      }
      data = body.data
    } else if (singlePkParam !== undefined) {
      const rest: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(body)) {
        if (k !== 'pk') rest[k] = v
      }
      data = rest
    } else {
      return c.json({ error: 'invalid_request', message: 'data object is required' }, 400)
    }

    const updateKeys = Object.keys(data)
    if (updateKeys.length === 0) {
      return c.json({ error: 'no_fields_to_update', message: 'No editable fields provided' }, 400)
    }

    for (const key of updateKeys) {
      if (!spec.editableColumns.includes(key)) {
        return c.json(
          { error: 'invalid_column', message: `Column "${key}" is read-only or not allowed on "${spec.name}"` },
          400,
        )
      }
    }

    if (spec.name === 'site_settings') {
      const settingKey = pkExtracted.values[0] ?? ''
      if (RESERVED_DOMAIN_SETTING_KEYS.has(settingKey)) {
        return c.json(
          {
            error: 'reserved_setting_key',
            message: `Cannot modify reserved domain setting key "${settingKey}". Use the dedicated domain API.`,
          },
          400,
        )
      }
    }

    if (spec.name === 'auth_users') {
      const targetUserId = pkExtracted.values[0]!
      try {
        const user = await updateManagedUser(activeDb, targetUserId, data as UpdateManagedUserInput)
        const row = Object.fromEntries(
          spec.columns.map((col) => [
            col,
            col === 'roles' ? user.roles : (user as unknown as Record<string, unknown>)[col] ?? null,
          ]),
        )
        return c.json({ ok: true, table: spec.name, row }, 200)
      } catch (err) {
        if (err instanceof UserManagementError) {
          return c.json({ error: err.code, message: err.message }, err.status)
        }
        if (isUniqueViolation(err)) {
          return c.json({ error: 'conflict', message: scrubErrorMessage(err) }, 409)
        }
        throw err
      }
    }

    const setClauses: string[] = []
    const params: unknown[] = []
    if (spec.hasUpdatedAt) {
      setClauses.push('"updated_at" = NOW()')
    }

    for (const key of updateKeys) {
      const val = data[key]
      if (spec.jsonbColumns.has(key)) {
        params.push(JSON.stringify(val))
        setClauses.push(`"${key}" = $${params.length}::jsonb`)
      } else {
        params.push(val)
        setClauses.push(`"${key}" = $${params.length}`)
      }
    }

    const whereClauses: string[] = []
    spec.pkColumns.forEach((pkCol, idx) => {
      params.push(pkExtracted.values[idx])
      whereClauses.push(`"${pkCol}" = $${params.length}`)
    })

    try {
      const updatedRow =
        spec.name === 'site_settings'
          ? await activeDb.tx(async (txClient) => {
              const prevRes = await txClient.query<{ value: unknown }>(
                `SELECT value FROM site_settings WHERE key = $1`,
                [pkExtracted.values[0]!],
              )
              if (prevRes.rowCount === 0 || !prevRes.rows[0]) {
                return null
              }
              const prevValue = prevRes.rows[0].value
              const res = await txClient.query<Record<string, unknown>>(
                `UPDATE "${spec.name}"
                 SET ${setClauses.join(', ')}
                 WHERE ${whereClauses.join(' AND ')}
                 RETURNING ${formatCrudColumnsSql(spec.columns)}`,
                params,
              )
              const updated = res.rows[0] ?? null
              if (updated) {
                await txClient.query(
                  `INSERT INTO site_settings_history (setting_key, previous_value, new_value, updated_by, updated_at)
                   VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW())`,
                  [
                    String(updated.key),
                    prevValue !== null && prevValue !== undefined ? JSON.stringify(prevValue) : null,
                    JSON.stringify(updated.value ?? null),
                    String(updated.updated_by ?? c.get('userId') ?? 'admin'),
                  ],
                )
              }
              return updated
            })
          : (
              await activeDb.query<Record<string, unknown>>(
                `UPDATE "${spec.name}"
                 SET ${setClauses.join(', ')}
                 WHERE ${whereClauses.join(' AND ')}
                 RETURNING ${formatCrudColumnsSql(spec.columns)}`,
                params,
              )
            ).rows[0] ?? null
      if (!updatedRow) {
        return c.json({ error: 'not_found', message: 'Row not found' }, 404)
      }
      return c.json({ ok: true, table: spec.name, row: updatedRow }, 200)
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: 'conflict', message: scrubErrorMessage(err) }, 409)
      }
      if (isForeignKeyViolation(err) || isClientConstraintError(err)) {
        return c.json({ error: 'constraint_violation', message: scrubErrorMessage(err) }, 400)
      }
      throw err
    }
  }

  router.patch('/tables/:table/rows', (c) => handlePatch(c))
  router.patch('/tables/:table/rows/:pk', (c) => handlePatch(c, c.req.param('pk')))

  // 10. DELETE /tables/:table/rows and DELETE /tables/:table/rows/:pk
  const handleDelete = async (
    c: Context<AppEnv>,
    singlePkParam?: string,
  ) => {
    c.header('Cache-Control', 'no-store')
    const tableName = c.req.param('table') ?? ''
    const spec = CRUD_TABLE_MAP.get(tableName)
    if (!spec) {
      return c.json(
        { error: 'invalid_table', message: `Table "${tableName}" is not accessible` },
        400,
      )
    }

    let rawPk: unknown = singlePkParam
    if (rawPk === undefined) {
      const rawBody = await c.req.text()
      if (rawBody.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
        }
        if (!isPlainObject(parsed)) {
          return c.json({ error: 'invalid_request', message: 'Request body must be a JSON object' }, 400)
        }
        rawPk = parsed.pk
      }
    }

    if (rawPk === undefined) {
      if (spec.pkColumns.length === 1) {
        rawPk = c.req.query(spec.pkColumns[0]!) ?? c.req.query('pk')
      } else {
        const fromQuery: Record<string, string> = {}
        let hasAny = false
        for (const pkCol of spec.pkColumns) {
          const qv = c.req.query(pkCol)
          if (qv !== undefined) {
            fromQuery[pkCol] = qv
            hasAny = true
          }
        }
        if (hasAny) {
          rawPk = fromQuery
        }
      }
    }

    const pkExtracted = extractPrimaryKeyValues(spec, rawPk)
    if (!pkExtracted.ok) {
      return c.json({ error: 'invalid_primary_key', message: pkExtracted.message }, 400)
    }

    if (spec.name === 'site_settings') {
      const settingKey = pkExtracted.values[0] ?? ''
      if (RESERVED_DOMAIN_SETTING_KEYS.has(settingKey)) {
        return c.json(
          {
            error: 'reserved_setting_key',
            message: `Cannot delete reserved domain setting key "${settingKey}". Use the dedicated domain API.`,
          },
          400,
        )
      }
    }

    if (spec.name === 'auth_users') {
      const targetUserId = pkExtracted.values[0]!
      try {
        const deleted = await deleteManagedUser(activeDb, targetUserId)
        return c.json({ ok: true, table: spec.name, deleted: { id: deleted.id } }, 200)
      } catch (err) {
        if (err instanceof UserManagementError) {
          return c.json({ error: err.code, message: err.message }, err.status)
        }
        throw err
      }
    }

    const whereClauses: string[] = []
    const params: unknown[] = []
    spec.pkColumns.forEach((pkCol, idx) => {
      params.push(pkExtracted.values[idx])
      whereClauses.push(`"${pkCol}" = $${params.length}`)
    })

    try {
      const deletedRow =
        spec.name === 'site_settings'
          ? await activeDb.tx(async (txClient) => {
              const prevRes = await txClient.query<{ value: unknown }>(
                `SELECT value FROM site_settings WHERE key = $1`,
                [pkExtracted.values[0]!],
              )
              if (prevRes.rowCount === 0 || !prevRes.rows[0]) {
                return null
              }
              const res = await txClient.query<Record<string, unknown>>(
                `DELETE FROM "${spec.name}"
                 WHERE ${whereClauses.join(' AND ')}
                 RETURNING ${formatCrudColumnsSql(spec.pkColumns)}`,
                params,
              )
              if (res.rows[0]) {
                await txClient.query(
                  `INSERT INTO site_settings_history (setting_key, previous_value, new_value, updated_by, updated_at)
                   VALUES ($1, $2::jsonb, 'null'::jsonb, $3, NOW())`,
                  [
                    pkExtracted.values[0]!,
                    prevRes.rows[0].value !== null && prevRes.rows[0].value !== undefined
                      ? JSON.stringify(prevRes.rows[0].value)
                      : null,
                    c.get('userId') ?? 'admin',
                  ],
                )
              }
              return res.rows[0] ?? null
            })
          : (
              await activeDb.query<Record<string, unknown>>(
                `DELETE FROM "${spec.name}"
                 WHERE ${whereClauses.join(' AND ')}
                 RETURNING ${formatCrudColumnsSql(spec.pkColumns)}`,
                params,
              )
            ).rows[0] ?? null

      if (!deletedRow) {
        return c.json({ error: 'not_found', message: 'Row not found' }, 404)
      }

      return c.json({ ok: true, table: spec.name, deleted: deletedRow }, 200)
    } catch (err) {
      if (isForeignKeyViolation(err) || isClientConstraintError(err)) {
        return c.json({ error: 'constraint_violation', message: scrubErrorMessage(err) }, 400)
      }
      throw err
    }
  }

  router.delete('/tables/:table/rows', (c) => handleDelete(c))
  router.delete('/tables/:table/rows/:pk', (c) => handleDelete(c, c.req.param('pk')))

  return router
}
