import { randomUUID } from 'node:crypto'
import type { DbClient } from '../db/types.js'
import { deriveAiGroupId, normalizeAiLectureId, pageClause, toIsoUtc } from './aiCommon.js'

export interface AiSession {
  id: string
  lecture_id: string
  group_id: string
  title: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

interface RawSessionRow {
  id: string
  lecture_id: string
  group_id: string
  title: string
  is_archived: boolean
  created_at: Date | string
  updated_at: Date | string
}

function mapSessionRow(row: RawSessionRow): AiSession {
  return {
    id: row.id,
    lecture_id: row.lecture_id,
    group_id: row.group_id,
    title: row.title,
    is_archived: Boolean(row.is_archived),
    created_at: toIsoUtc(row.created_at),
    updated_at: toIsoUtc(row.updated_at),
  }
}

export interface ListSessionsFilter {
  lectureId?: string
  groupId?: string
  archived?: boolean
  page?: { limit: number; offset: number }
}

export async function listSessions(
  db: DbClient,
  userId: string,
  filter?: ListSessionsFilter,
): Promise<AiSession[]> {
  const params: unknown[] = [userId]
  const conditions: string[] = ['user_id = $1']

  if (filter?.lectureId !== undefined) {
    const norm = normalizeAiLectureId(filter.lectureId)
    params.push(norm)
    conditions.push(`lecture_id = $${params.length}`)
  }

  if (filter?.groupId !== undefined && filter.groupId.trim() !== '') {
    params.push(filter.groupId.trim().toLowerCase())
    conditions.push(`group_id = $${params.length}`)
  }

  if (filter?.archived !== undefined) {
    params.push(filter.archived)
    conditions.push(`is_archived = $${params.length}`)
  }

  const query = `
    SELECT id, lecture_id, group_id, title, is_archived, created_at, updated_at
    FROM ai_sessions
    WHERE ${conditions.join(' AND ')}
    ORDER BY updated_at DESC, created_at DESC, id ASC
    ${pageClause(params, filter?.page)}
  `

  const res = await db.query<RawSessionRow>(query, params)
  return res.rows.map(mapSessionRow)
}

export async function getSessionById(
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<AiSession | null> {
  const res = await db.query<RawSessionRow>(
    `SELECT id, lecture_id, group_id, title, is_archived, created_at, updated_at
     FROM ai_sessions
     WHERE user_id = $1 AND id = $2`,
    [userId, sessionId],
  )
  const row = res.rows[0]
  return row ? mapSessionRow(row) : null
}

export interface CreateSessionInput {
  id?: string
  lecture_id: string
  group_id?: string
  title?: string
  is_archived?: boolean
}

export async function upsertSession(
  db: DbClient,
  userId: string,
  input: CreateSessionInput,
): Promise<AiSession> {
  const normLectureId = normalizeAiLectureId(input.lecture_id)
  const groupId = deriveAiGroupId(normLectureId, input.group_id)
  const id = input.id && typeof input.id === 'string' && input.id.trim() !== ''
    ? input.id.trim()
    : randomUUID()
  const title = input.title !== undefined && typeof input.title === 'string' && input.title.trim() !== ''
    ? input.title.trim()
    : '新会话'
  const isArchived = Boolean(input.is_archived)

  const res = await db.query<RawSessionRow>(
    `INSERT INTO ai_sessions (
       user_id, id, lecture_id, group_id, title, is_archived, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (user_id, id) DO UPDATE SET
       lecture_id = EXCLUDED.lecture_id,
       group_id = EXCLUDED.group_id,
       title = EXCLUDED.title,
       is_archived = EXCLUDED.is_archived,
       updated_at = now()
     RETURNING id, lecture_id, group_id, title, is_archived, created_at, updated_at`,
    [userId, id, normLectureId, groupId, title, isArchived],
  )

  const row = res.rows[0]
  if (!row) {
    throw new Error('Failed to upsert session')
  }
  return mapSessionRow(row)
}

export interface UpdateSessionInput {
  title?: string
  is_archived?: boolean
}

export async function updateSession(
  db: DbClient,
  userId: string,
  sessionId: string,
  input: UpdateSessionInput,
): Promise<AiSession | null> {
  const updates: string[] = ['updated_at = now()']
  const params: unknown[] = [userId, sessionId]

  if (input.title !== undefined && typeof input.title === 'string') {
    params.push(input.title.trim())
    updates.push(`title = $${params.length}`)
  }

  if (input.is_archived !== undefined) {
    params.push(Boolean(input.is_archived))
    updates.push(`is_archived = $${params.length}`)
  }

  const query = `
    UPDATE ai_sessions
    SET ${updates.join(', ')}
    WHERE user_id = $1 AND id = $2
    RETURNING id, lecture_id, group_id, title, is_archived, created_at, updated_at
  `

  const res = await db.query<RawSessionRow>(query, params)
  const row = res.rows[0]
  return row ? mapSessionRow(row) : null
}

export async function deleteSessionById(
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  await db.query(
    'DELETE FROM ai_sessions WHERE user_id = $1 AND id = $2',
    [userId, sessionId],
  )
}

export async function deleteSessionsByLecture(
  db: DbClient,
  userId: string,
  lectureId: string,
): Promise<void> {
  const norm = normalizeAiLectureId(lectureId)
  await db.query(
    'DELETE FROM ai_sessions WHERE user_id = $1 AND lecture_id = $2',
    [userId, norm],
  )
}
