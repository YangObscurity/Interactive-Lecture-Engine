import type { Db, DbClient } from '../db/types.js'

export const PROGRESS_STATUSES = ['未开始', '学习中', '已完成'] as const
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number]

export const LECTURE_ID_RE = /^[a-z0-9][a-z0-9_-]*-l\d{2,}$/
export const MAX_PROGRESS_BATCH_ITEMS = 200

const PROGRESS_STATUS_SET = new Set<string>(PROGRESS_STATUSES)

export interface ProgressRow {
  lecture_id: string
  group_id: string
  status: ProgressStatus
  completed_at: string | null
  updated_at: string
  notion_node_id: string | null
  notion_page_id: string | null
}

export interface UpsertProgressInput {
  lecture_id: string
  status: ProgressStatus | string
  group_id?: string | null
  notion_node_id?: string | null
  notion_page_id?: string | null
  completed_at?: string | null
  updated_at?: string | null
}

export interface ReassignTableStats {
  fromCount: number
  toCount: number
  overlapCount: number
}

export interface ReassignTableResult {
  upsertedToRows: number
  deletedFromRows: number
}

export interface ReassignPreview {
  fromUserId: string
  toUserId: string
  fromCount: number
  toCount: number
  overlapCount: number
  sessions?: ReassignTableStats
  messages?: ReassignTableStats
  checklists?: ReassignTableStats
}

export interface ReassignResult {
  fromUserId: string
  toUserId: string
  upsertedToRows: number
  deletedFromRows: number
  sessions?: ReassignTableResult
  messages?: ReassignTableResult
  checklists?: ReassignTableResult
}

export class InvalidLectureIdError extends Error {
  readonly code = 'invalid_lecture_id'

  constructor(message = 'Invalid lecture_id format') {
    super(message)
    this.name = 'InvalidLectureIdError'
  }
}

export class InvalidStatusError extends Error {
  readonly code = 'invalid_status'

  constructor(
    message = `Invalid status; allowed values: ${PROGRESS_STATUSES.join(', ')}`,
  ) {
    super(message)
    this.name = 'InvalidStatusError'
  }
}

export class TooManyItemsError extends Error {
  readonly code = 'too_many_items'
  readonly max = MAX_PROGRESS_BATCH_ITEMS

  constructor(
    message = `Batch exceeds maximum of ${MAX_PROGRESS_BATCH_ITEMS} items`,
  ) {
    super(message)
    this.name = 'TooManyItemsError'
  }
}

export function normalizeLectureId(raw: string): string {
  if (typeof raw !== 'string') {
    throw new InvalidLectureIdError()
  }
  const normalized = raw.trim().toLowerCase()
  if (!LECTURE_ID_RE.test(normalized)) {
    throw new InvalidLectureIdError(
      'Invalid lecture_id format; expected <group>-l<two or more digits>',
    )
  }
  return normalized
}

export function deriveGroupId(lectureId: string): string {
  const normalized = normalizeLectureId(lectureId)
  const idx = normalized.lastIndexOf('-')
  if (idx <= 0) {
    throw new InvalidLectureIdError()
  }
  return normalized.slice(0, idx)
}

function normalizeStatus(raw: unknown): ProgressStatus {
  if (typeof raw !== 'string' || !PROGRESS_STATUS_SET.has(raw)) {
    throw new InvalidStatusError()
  }
  return raw as ProgressStatus
}

function normalizeOptionalGroupId(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) {
    return null
  }
  const trimmed = raw.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function toIsoString(val: Date | string): string {
  const date = val instanceof Date ? val : new Date(val)
  return date.toISOString()
}

interface RawProgressRow {
  lecture_id: string
  group_id: string
  status: string
  completed_at: Date | string | null
  updated_at: Date | string
  notion_node_id: string | null
  notion_page_id: string | null
}

function mapProgressRow(row: RawProgressRow): ProgressRow {
  return {
    lecture_id: row.lecture_id,
    group_id: row.group_id,
    status: row.status as ProgressStatus,
    completed_at: row.completed_at === null ? null : toIsoString(row.completed_at),
    updated_at: toIsoString(row.updated_at),
    notion_node_id: row.notion_node_id ?? null,
    notion_page_id: row.notion_page_id ?? null,
  }
}

function assertNonEmptyUserId(userId: string, label = 'userId'): string {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return userId.trim()
}

export async function getAllProgress(
  db: DbClient,
  userId: string,
): Promise<ProgressRow[]> {
  const uid = assertNonEmptyUserId(userId)
  const res = await db.query<RawProgressRow>(
    `SELECT lecture_id, group_id, status, completed_at, updated_at, notion_node_id, notion_page_id
     FROM progress
     WHERE user_id = $1
     ORDER BY lecture_id ASC`,
    [uid],
  )
  return res.rows.map(mapProgressRow)
}

export async function getProgressByGroup(
  db: DbClient,
  userId: string,
  groupId: string,
): Promise<ProgressRow[]> {
  const uid = assertNonEmptyUserId(userId)
  const gid = groupId.trim().toLowerCase()
  const res = await db.query<RawProgressRow>(
    `SELECT lecture_id, group_id, status, completed_at, updated_at, notion_node_id, notion_page_id
     FROM progress
     WHERE user_id = $1 AND group_id = $2
     ORDER BY lecture_id ASC`,
    [uid, gid],
  )
  return res.rows.map(mapProgressRow)
}

export async function getProgressByLecture(
  db: DbClient,
  userId: string,
  lectureId: string,
): Promise<ProgressRow | null> {
  const uid = assertNonEmptyUserId(userId)
  const lid = normalizeLectureId(lectureId)
  const res = await db.query<RawProgressRow>(
    `SELECT lecture_id, group_id, status, completed_at, updated_at, notion_node_id, notion_page_id
     FROM progress
     WHERE user_id = $1 AND lecture_id = $2`,
    [uid, lid],
  )
  const row = res.rows[0]
  return row ? mapProgressRow(row) : null
}

interface NormalizedUpsertInput {
  lectureId: string
  insertGroupId: string
  explicitGroupId: string | null
  status: ProgressStatus
  notionNodeId: string | null
  hasNotionNodeId: boolean
  notionPageId: string | null
  hasNotionPageId: boolean
}

function validateUpsertInput(input: UpsertProgressInput): NormalizedUpsertInput {
  const lectureId = normalizeLectureId(input.lecture_id)
  const status = normalizeStatus(input.status)
  const explicitGroupId = normalizeOptionalGroupId(input.group_id)
  const insertGroupId = explicitGroupId ?? deriveGroupId(lectureId)

  const hasNotionNodeId = input.notion_node_id !== undefined
  const notionNodeId = input.notion_node_id ?? null
  const hasNotionPageId = input.notion_page_id !== undefined
  const notionPageId = input.notion_page_id ?? null

  return {
    lectureId,
    insertGroupId,
    explicitGroupId,
    status,
    notionNodeId,
    hasNotionNodeId,
    notionPageId,
    hasNotionPageId,
  }
}

const UPSERT_PROGRESS_SQL = `
INSERT INTO progress (
  user_id,
  lecture_id,
  group_id,
  status,
  completed_at,
  updated_at,
  notion_node_id,
  notion_page_id
)
VALUES (
  $1,
  $2,
  $3,
  $4,
  CASE WHEN $4 = '已完成' THEN $6::timestamptz ELSE NULL END,
  $6::timestamptz,
  $7,
  $9
)
ON CONFLICT (user_id, lecture_id) DO UPDATE SET
  group_id = COALESCE($5, progress.group_id),
  status = EXCLUDED.status,
  completed_at = CASE
    WHEN EXCLUDED.status = '已完成' THEN COALESCE(progress.completed_at, $6::timestamptz)
    ELSE NULL
  END,
  updated_at = $6::timestamptz,
  notion_node_id = CASE WHEN $8::boolean THEN $7 ELSE progress.notion_node_id END,
  notion_page_id = CASE WHEN $10::boolean THEN $9 ELSE progress.notion_page_id END
RETURNING lecture_id, group_id, status, completed_at, updated_at, notion_node_id, notion_page_id
`

async function executeUpsertNormalized(
  client: DbClient,
  uid: string,
  norm: NormalizedUpsertInput,
  now: Date,
): Promise<ProgressRow> {
  const nowIso = now.toISOString()
  const res = await client.query<RawProgressRow>(UPSERT_PROGRESS_SQL, [
    uid,
    norm.lectureId,
    norm.insertGroupId,
    norm.status,
    norm.explicitGroupId,
    nowIso,
    norm.notionNodeId,
    norm.hasNotionNodeId,
    norm.notionPageId,
    norm.hasNotionPageId,
  ])
  const row = res.rows[0]
  if (!row) {
    throw new Error('Upsert progress failed to return a row')
  }
  return mapProgressRow(row)
}

export async function upsertProgress(
  db: DbClient,
  userId: string,
  input: UpsertProgressInput,
  now: Date = new Date(),
): Promise<ProgressRow> {
  const uid = assertNonEmptyUserId(userId)
  const norm = validateUpsertInput(input)
  return executeUpsertNormalized(db, uid, norm, now)
}

export async function upsertProgressBatch(
  db: Db | DbClient,
  userId: string,
  items: readonly UpsertProgressInput[],
  now: Date = new Date(),
): Promise<ProgressRow[]> {
  const uid = assertNonEmptyUserId(userId)
  if (items.length > MAX_PROGRESS_BATCH_ITEMS) {
    throw new TooManyItemsError()
  }

  const normalizedItems = items.map(validateUpsertInput)
  if (normalizedItems.length === 0) {
    return []
  }

  const run = async (client: DbClient): Promise<ProgressRow[]> => {
    const out: ProgressRow[] = []
    for (const norm of normalizedItems) {
      const row = await executeUpsertNormalized(client, uid, norm, now)
      out.push(row)
    }
    return out
  }

  if ('tx' in db && typeof (db as Db).tx === 'function') {
    return (db as Db).tx(run)
  }
  return run(db as DbClient)
}

function validateReassignUsers(
  fromUserId: string,
  toUserId: string,
): { from: string; to: string } {
  const from = assertNonEmptyUserId(fromUserId, 'fromUserId')
  const to = assertNonEmptyUserId(toUserId, 'toUserId')
  if (from === to) {
    throw new Error('fromUserId and toUserId must be different')
  }
  return { from, to }
}

async function checkTableExists(db: DbClient, tableName: string): Promise<boolean> {
  try {
    const res = await db.query<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_name = $1",
      [tableName],
    )
    return (res.rows[0]?.cnt ?? 0) > 0
  } catch {
    return false
  }
}

export async function previewReassignUserProgress(
  db: DbClient,
  fromUserId: string,
  toUserId: string,
): Promise<ReassignPreview> {
  const { from, to } = validateReassignUsers(fromUserId, toUserId)

  const fromRes = await db.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM progress WHERE user_id = $1',
    [from],
  )
  const toRes = await db.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM progress WHERE user_id = $1',
    [to],
  )
  const overlapRes = await db.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
     FROM progress f
     INNER JOIN progress t ON t.lecture_id = f.lecture_id
     WHERE f.user_id = $1 AND t.user_id = $2`,
    [from, to],
  )

  const preview: ReassignPreview = {
    fromUserId: from,
    toUserId: to,
    fromCount: Number(fromRes.rows[0]?.cnt ?? 0),
    toCount: Number(toRes.rows[0]?.cnt ?? 0),
    overlapCount: Number(overlapRes.rows[0]?.cnt ?? 0),
  }

  const hasSessions = await checkTableExists(db, 'ai_sessions')
  if (hasSessions) {
    const sFrom = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_sessions WHERE user_id = $1',
      [from],
    )
    const sTo = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_sessions WHERE user_id = $1',
      [to],
    )
    const sOverlap = await db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM ai_sessions f
       INNER JOIN ai_sessions t ON t.id = f.id
       WHERE f.user_id = $1 AND t.user_id = $2`,
      [from, to],
    )
    preview.sessions = {
      fromCount: Number(sFrom.rows[0]?.cnt ?? 0),
      toCount: Number(sTo.rows[0]?.cnt ?? 0),
      overlapCount: Number(sOverlap.rows[0]?.cnt ?? 0),
    }
  }

  const hasMessages = await checkTableExists(db, 'ai_messages')
  if (hasMessages) {
    const mFrom = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_messages WHERE user_id = $1',
      [from],
    )
    const mTo = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_messages WHERE user_id = $1',
      [to],
    )
    const mOverlap = await db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM ai_messages f
       INNER JOIN ai_messages t ON t.id = f.id
       WHERE f.user_id = $1 AND t.user_id = $2`,
      [from, to],
    )
    preview.messages = {
      fromCount: Number(mFrom.rows[0]?.cnt ?? 0),
      toCount: Number(mTo.rows[0]?.cnt ?? 0),
      overlapCount: Number(mOverlap.rows[0]?.cnt ?? 0),
    }
  }

  const hasChecklists = await checkTableExists(db, 'ai_review_checklists')
  if (hasChecklists) {
    const cFrom = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_review_checklists WHERE user_id = $1',
      [from],
    )
    const cTo = await db.query<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM ai_review_checklists WHERE user_id = $1',
      [to],
    )
    const cOverlap = await db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt
       FROM ai_review_checklists f
       INNER JOIN ai_review_checklists t ON t.id = f.id
       WHERE f.user_id = $1 AND t.user_id = $2`,
      [from, to],
    )
    preview.checklists = {
      fromCount: Number(cFrom.rows[0]?.cnt ?? 0),
      toCount: Number(cTo.rows[0]?.cnt ?? 0),
      overlapCount: Number(cOverlap.rows[0]?.cnt ?? 0),
    }
  }

  return preview
}

export async function reassignUserProgress(
  db: Db,
  fromUserId: string,
  toUserId: string,
): Promise<ReassignResult> {
  const { from, to } = validateReassignUsers(fromUserId, toUserId)

  return db.tx(async (txClient) => {
    // 1. Reassign progress table
    const upsertRes = await txClient.query(
      `INSERT INTO progress (
         user_id,
         lecture_id,
         group_id,
         status,
         completed_at,
         updated_at,
         notion_node_id,
         notion_page_id
       )
       SELECT
         $2,
         lecture_id,
         group_id,
         status,
         completed_at,
         updated_at,
         notion_node_id,
         notion_page_id
       FROM progress
       WHERE user_id = $1
       ON CONFLICT (user_id, lecture_id) DO UPDATE SET
         group_id = EXCLUDED.group_id,
         status = EXCLUDED.status,
         completed_at = EXCLUDED.completed_at,
         updated_at = EXCLUDED.updated_at,
         notion_node_id = EXCLUDED.notion_node_id,
         notion_page_id = EXCLUDED.notion_page_id
       WHERE EXCLUDED.updated_at > progress.updated_at`,
      [from, to],
    )

    const delRes = await txClient.query(
      'DELETE FROM progress WHERE user_id = $1',
      [from],
    )

    const result: ReassignResult = {
      fromUserId: from,
      toUserId: to,
      upsertedToRows: upsertRes.rowCount,
      deletedFromRows: delRes.rowCount,
    }

    const hasAiTables = await checkTableExists(txClient, 'ai_sessions')
    if (hasAiTables) {
      // 2. Reassign ai_sessions first so foreign keys in ai_messages can be satisfied
      const sUpsert = await txClient.query(
        `INSERT INTO ai_sessions (
           user_id,
           id,
           lecture_id,
           group_id,
           title,
           is_archived,
           created_at,
           updated_at
         )
         SELECT
           $2,
           id,
           lecture_id,
           group_id,
           title,
           is_archived,
           created_at,
           updated_at
         FROM ai_sessions
         WHERE user_id = $1
         ON CONFLICT (user_id, id) DO UPDATE SET
           lecture_id = EXCLUDED.lecture_id,
           group_id = EXCLUDED.group_id,
           title = EXCLUDED.title,
           is_archived = EXCLUDED.is_archived,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at > ai_sessions.updated_at`,
        [from, to],
      )

      // 3. Reassign ai_messages
      const mUpsert = await txClient.query(
        `INSERT INTO ai_messages (
           user_id,
           id,
           session_id,
           role,
           content,
           selected_context,
           model,
           prompt_tokens,
           completion_tokens,
           created_at
         )
         SELECT
           $2,
           id,
           session_id,
           role,
           content,
           selected_context,
           model,
           prompt_tokens,
           completion_tokens,
           created_at
         FROM ai_messages
         WHERE user_id = $1
         ON CONFLICT (user_id, id) DO UPDATE SET
           session_id = EXCLUDED.session_id,
           role = EXCLUDED.role,
           content = EXCLUDED.content,
           selected_context = EXCLUDED.selected_context,
           model = EXCLUDED.model,
           prompt_tokens = EXCLUDED.prompt_tokens,
           completion_tokens = EXCLUDED.completion_tokens,
           created_at = EXCLUDED.created_at
         WHERE EXCLUDED.created_at > ai_messages.created_at`,
        [from, to],
      )

      // 4. Reassign ai_review_checklists
      const cUpsert = await txClient.query(
        `INSERT INTO ai_review_checklists (
           user_id,
           id,
           lecture_id,
           group_id,
           topic_title,
           section_anchor,
           is_completed,
           pptx_source,
           priority,
           created_at,
           updated_at
         )
         SELECT
           $2,
           id,
           lecture_id,
           group_id,
           topic_title,
           section_anchor,
           is_completed,
           pptx_source,
           priority,
           created_at,
           updated_at
         FROM ai_review_checklists
         WHERE user_id = $1
         ON CONFLICT (user_id, id) DO UPDATE SET
           lecture_id = EXCLUDED.lecture_id,
           group_id = EXCLUDED.group_id,
           topic_title = EXCLUDED.topic_title,
           section_anchor = EXCLUDED.section_anchor,
           is_completed = EXCLUDED.is_completed,
           pptx_source = EXCLUDED.pptx_source,
           priority = EXCLUDED.priority,
           updated_at = EXCLUDED.updated_at
         WHERE EXCLUDED.updated_at > ai_review_checklists.updated_at`,
        [from, to],
      )

      // 5. Delete old user records from AI tables (delete messages, sessions, checklists)
      const mDel = await txClient.query(
        'DELETE FROM ai_messages WHERE user_id = $1',
        [from],
      )
      const sDel = await txClient.query(
        'DELETE FROM ai_sessions WHERE user_id = $1',
        [from],
      )
      const cDel = await txClient.query(
        'DELETE FROM ai_review_checklists WHERE user_id = $1',
        [from],
      )

      result.sessions = {
        upsertedToRows: sUpsert.rowCount,
        deletedFromRows: sDel.rowCount,
      }
      result.messages = {
        upsertedToRows: mUpsert.rowCount,
        deletedFromRows: mDel.rowCount,
      }
      result.checklists = {
        upsertedToRows: cUpsert.rowCount,
        deletedFromRows: cDel.rowCount,
      }
    }

    return result
  })
}
