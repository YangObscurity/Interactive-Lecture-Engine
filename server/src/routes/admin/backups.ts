import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, resolve, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.js'
import { resolveBackupDir } from '../../db/backupDir.js'
import type { Db } from '../../db/types.js'
import { serverLogBuffer } from '../../http/logBuffer.js'

function getBackupDir(): string {
  return resolveBackupDir()
}

function formatStamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
}

function resolveSafeArchivePath(backupDir: string, candidate: string): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return null
  const baseDir = resolve(backupDir)
  const resolved = resolve(baseDir, trimmed)
  if (resolved !== baseDir && !resolved.startsWith(baseDir + sep)) {
    return null
  }
  return resolved
}

export function createAdminBackupsRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  router.get('/', (c) => {
    c.header('Cache-Control', 'no-store')
    const dir = getBackupDir()
    if (!existsSync(dir)) {
      return c.json({ ok: true, backupDir: dir, backups: [] }, 200)
    }

    const entries = readdirSync(dir)
      .filter((name) => name.endsWith('.json.gz') || name.endsWith('.tar.gz'))
      .sort()
      .reverse()
      .map((filename) => {
        const fullPath = resolve(dir, filename)
        const st = statSync(fullPath)
        const shaPath = `${fullPath}.sha256`
        const sha256 = existsSync(shaPath)
          ? readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0] ?? null
          : null
        return {
          filename,
          kind: filename.endsWith('.tar.gz') ? ('physical-tar' as const) : ('logical-json' as const),
          sizeBytes: st.size,
          sha256,
          createdAt: st.mtime.toISOString(),
        }
      })

    return c.json({ ok: true, backupDir: dir, backups: entries }, 200)
  })

  router.post('/', async (c) => {
    c.header('Cache-Control', 'no-store')
    const dir = getBackupDir()
    mkdirSync(dir, { recursive: true })

    const {
      dialect,
      settings,
      history,
      progress,
      aiSessions,
      aiMessages,
      aiReviewChecklists,
      users,
    } = await db.tx(async (tx) => {
      const txDialect = db.kind
      if (txDialect === 'pg') {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      }

      const settingsRows = (
        await tx.query('SELECT key, value, updated_by, updated_at FROM site_settings')
      ).rows
      const historyRows = (
        await tx.query(
          'SELECT id, setting_key, previous_value, new_value, updated_by, updated_at FROM site_settings_history ORDER BY id ASC',
        )
      ).rows
      const progressRows = (
        await tx.query(
          'SELECT user_id, lecture_id, group_id, status, completed_at, updated_at, notion_node_id, notion_page_id FROM progress',
        )
      ).rows
      const aiSessionsRows = (
        await tx.query(
          'SELECT id, user_id, lecture_id, group_id, title, is_archived, created_at, updated_at FROM ai_sessions',
        )
      ).rows
      const aiMessagesRows = (
        await tx.query(
          'SELECT id, user_id, session_id, role, content, selected_context, model, prompt_tokens, completion_tokens, created_at FROM ai_messages',
        )
      ).rows
      const aiReviewChecklistsRows = (
        await tx.query(
          'SELECT id, user_id, lecture_id, group_id, topic_title, section_anchor, is_completed, pptx_source, priority, created_at, updated_at FROM ai_review_checklists',
        )
      ).rows
      const usersRows = (
        await tx.query(
          'SELECT id, username, email, display_name, roles, disabled, last_login_at, created_at, updated_at FROM auth_users',
        )
      ).rows

      return {
        dialect: txDialect,
        settings: settingsRows,
        history: historyRows,
        progress: progressRows,
        aiSessions: aiSessionsRows,
        aiMessages: aiMessagesRows,
        aiReviewChecklists: aiReviewChecklistsRows,
        users: usersRows,
      }
    })

    const snapshotPayload = {
      format: 'lecture-api-logical-backup-v1',
      dialect,
      createdAt: new Date().toISOString(),
      tables: {
        site_settings: settings,
        site_settings_history: history,
        progress,
        ai_sessions: aiSessions,
        ai_messages: aiMessages,
        ai_review_checklists: aiReviewChecklists,
        auth_users_public: users,
      },
    }

    const gzBuf = gzipSync(Buffer.from(JSON.stringify(snapshotPayload), 'utf8'))
    const sha256 = createHash('sha256').update(gzBuf).digest('hex')
    const filename = `lecture-api-backup-${formatStamp()}-${randomBytes(3).toString('hex')}.json.gz`
    const archivePath = resolve(dir, filename)
    const tmpPath = `${archivePath}.tmp.${randomBytes(4).toString('hex')}`
    try {
      writeFileSync(tmpPath, gzBuf)
      renameSync(tmpPath, archivePath)
    } catch (err) {
      rmSync(tmpPath, { force: true })
      throw err
    }

    const checksumPath = `${archivePath}.sha256`
    writeFileSync(checksumPath, `${sha256}  ${filename}\n`, 'utf8')

    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Logical backup archive created: ${filename} (${gzBuf.length} bytes)`,
    })

    return c.json(
      {
        ok: true,
        snapshot: {
          filename,
          checksumFilename: `${filename}.sha256`,
          sha256,
          sizeBytes: gzBuf.length,
          tableCounts: {
            site_settings: settings.length,
            site_settings_history: history.length,
            progress: progress.length,
            ai_sessions: aiSessions.length,
            ai_messages: aiMessages.length,
            ai_review_checklists: aiReviewChecklists.length,
            auth_users_public: users.length,
          },
          createdAt: snapshotPayload.createdAt,
        },
      },
      201,
    )
  })

  router.post('/restore', async (c) => {
    c.header('Cache-Control', 'no-store')
    let body: { filename?: string; archivePath?: string; dryRun?: boolean }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request', message: 'Invalid JSON payload' }, 400)
    }

    const candidate = typeof body?.filename === 'string' && body.filename.trim()
      ? body.filename
      : typeof body?.archivePath === 'string' && body.archivePath.trim()
        ? body.archivePath
        : ''
    if (!candidate) {
      return c.json({ error: 'missing_archive_path', message: 'Archive filename or path is required' }, 400)
    }

    const dir = getBackupDir()
    const resolvedPath = resolveSafeArchivePath(dir, candidate)
    if (!resolvedPath) {
      return c.json({ error: 'forbidden_path', message: 'Archive must reside inside configured BACKUP_DIR' }, 400)
    }

    if (!existsSync(resolvedPath)) {
      return c.json({ error: 'not_found', message: 'Backup archive not found' }, 404)
    }

    const rawBytes = readFileSync(resolvedPath)
    const shaPath = `${resolvedPath}.sha256`
    if (existsSync(shaPath)) {
      const expectedSha = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0]?.toLowerCase()
      const actualSha = createHash('sha256').update(rawBytes).digest('hex').toLowerCase()
      if (!expectedSha || actualSha !== expectedSha) {
        return c.json({ error: 'checksum_mismatch', message: 'Backup archive checksum verification failed' }, 400)
      }
    }

    const parsedSummary: Record<string, number> = {}
    try {
      const plain = gunzipSync(rawBytes)
      if (resolvedPath.endsWith('.json.gz')) {
        const parsed = JSON.parse(plain.toString('utf8')) as {
          format?: string
          tables?: Record<string, unknown[]>
        }
        if (parsed.format !== 'lecture-api-logical-backup-v1' || !parsed.tables) {
          return c.json({ error: 'invalid_archive_format', message: 'Unsupported logical backup format' }, 400)
        }
        for (const [k, v] of Object.entries(parsed.tables)) {
          parsedSummary[k] = Array.isArray(v) ? v.length : 0
        }
      }
    } catch {
      return c.json({ error: 'corrupt_archive', message: 'Backup archive failed decompression or parsing' }, 400)
    }

    const dryRun = body.dryRun !== false
    serverLogBuffer.add({
      level: 'info',
      category: 'admin',
      message: `Backup restore validation (${dryRun ? 'dry-run' : 'validated'}) for ${basename(resolvedPath)}`,
    })

    return c.json(
      {
        ok: true,
        dryRun,
        filename: basename(resolvedPath),
        verifiedChecksum: existsSync(shaPath),
        tableCounts: parsedSummary,
        message: 'Backup archive verified successfully',
      },
      200,
    )
  })

  return router
}
