import { randomUUID } from 'node:crypto'
import type { Db, DbClient } from '../db/types.js'
import { deriveAiGroupId, normalizeAiLectureId, pageClause, toIsoUtc } from './aiCommon.js'

export interface AiReviewChecklist {
  id: string
  lecture_id: string
  group_id: string
  topic_title: string
  section_anchor: string | null
  is_completed: boolean
  pptx_source: string | null
  priority: number
  created_at: string
  updated_at: string
}

interface RawChecklistRow {
  id: string
  lecture_id: string
  group_id: string
  topic_title: string
  section_anchor: string | null
  is_completed: boolean
  pptx_source: string | null
  priority: number
  created_at: Date | string
  updated_at: Date | string
}

function mapChecklistRow(row: RawChecklistRow): AiReviewChecklist {
  return {
    id: row.id,
    lecture_id: row.lecture_id,
    group_id: row.group_id,
    topic_title: row.topic_title,
    section_anchor: row.section_anchor ?? null,
    is_completed: Boolean(row.is_completed),
    pptx_source: row.pptx_source ?? null,
    priority: Number(row.priority ?? 1),
    created_at: toIsoUtc(row.created_at),
    updated_at: toIsoUtc(row.updated_at),
  }
}

export interface ListChecklistsFilter {
  lectureId?: string
  groupId?: string
  page?: { limit: number; offset: number }
}

export async function listReviewChecklists(
  db: DbClient,
  userId: string,
  filter?: ListChecklistsFilter,
): Promise<AiReviewChecklist[]> {
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

  const query = `
    SELECT id, lecture_id, group_id, topic_title, section_anchor, is_completed, pptx_source, priority, created_at, updated_at
    FROM ai_review_checklists
    WHERE ${conditions.join(' AND ')}
    ORDER BY priority DESC, created_at ASC, id ASC
    ${pageClause(params, filter?.page)}
  `

  const res = await db.query<RawChecklistRow>(query, params)
  return res.rows.map(mapChecklistRow)
}

export interface CreateChecklistItemInput {
  id?: string
  lecture_id: string
  group_id?: string
  topic_title: string
  section_anchor?: string | null
  is_completed?: boolean
  pptx_source?: string | null
  priority?: number
}

export class ChecklistValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ChecklistValidationError'
  }
}

export async function upsertReviewChecklistBatch(
  db: Db,
  userId: string,
  rawItems: CreateChecklistItemInput[],
): Promise<AiReviewChecklist[]> {
  if (rawItems.length === 0) {
    throw new ChecklistValidationError('invalid_request', 'Items array cannot be empty')
  }
  if (rawItems.length > 200) {
    throw new ChecklistValidationError('too_many_items', 'Batch exceeds maximum of 200 items')
  }

  // Pre-validate all items before beginning transaction
  const normalizedItems = rawItems.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ChecklistValidationError('invalid_request', `Item at index ${index} must be an object`)
    }
    if (typeof item.topic_title !== 'string' || item.topic_title.trim() === '') {
      throw new ChecklistValidationError('invalid_request', `Item at index ${index} missing required topic_title`)
    }
    const normLectureId = normalizeAiLectureId(item.lecture_id)
    const groupId = deriveAiGroupId(normLectureId, item.group_id)
    const id = item.id && typeof item.id === 'string' && item.id.trim() !== ''
      ? item.id.trim()
      : randomUUID()
    const topicTitle = item.topic_title.trim()
    const sectionAnchor = item.section_anchor !== undefined && item.section_anchor !== null
      ? String(item.section_anchor).trim()
      : null
    const isCompleted = Boolean(item.is_completed)
    const pptxSource = item.pptx_source !== undefined && item.pptx_source !== null
      ? String(item.pptx_source).trim()
      : null
    const priority = typeof item.priority === 'number' && Number.isInteger(item.priority)
      ? item.priority
      : 1

    return {
      id,
      normLectureId,
      groupId,
      topicTitle,
      sectionAnchor,
      isCompleted,
      pptxSource,
      priority,
    }
  })

  return db.tx(async (txClient) => {
    const results: AiReviewChecklist[] = []

    for (const item of normalizedItems) {
      const res = await txClient.query<RawChecklistRow>(
        `INSERT INTO ai_review_checklists (
           user_id, id, lecture_id, group_id, topic_title, section_anchor, is_completed, pptx_source, priority, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
         ON CONFLICT (user_id, id) DO UPDATE SET
           lecture_id = EXCLUDED.lecture_id,
           group_id = EXCLUDED.group_id,
           topic_title = EXCLUDED.topic_title,
           section_anchor = EXCLUDED.section_anchor,
           is_completed = EXCLUDED.is_completed,
           pptx_source = EXCLUDED.pptx_source,
           priority = EXCLUDED.priority,
           updated_at = now()
         RETURNING id, lecture_id, group_id, topic_title, section_anchor, is_completed, pptx_source, priority, created_at, updated_at`,
        [
          userId,
          item.id,
          item.normLectureId,
          item.groupId,
          item.topicTitle,
          item.sectionAnchor,
          item.isCompleted,
          item.pptxSource,
          item.priority,
        ],
      )

      const row = res.rows[0]
      if (!row) {
        throw new Error('Failed to upsert checklist item')
      }
      results.push(mapChecklistRow(row))
    }

    return results
  })
}

export interface UpdateChecklistItemInput {
  topic_title?: string
  section_anchor?: string | null
  is_completed?: boolean
  pptx_source?: string | null
  priority?: number
}

export async function updateReviewChecklistItem(
  db: DbClient,
  userId: string,
  itemId: string,
  input: UpdateChecklistItemInput,
): Promise<AiReviewChecklist | null> {
  const updates: string[] = ['updated_at = now()']
  const params: unknown[] = [userId, itemId]

  if (input.topic_title !== undefined && typeof input.topic_title === 'string') {
    params.push(input.topic_title.trim())
    updates.push(`topic_title = $${params.length}`)
  }

  if (input.section_anchor !== undefined) {
    params.push(input.section_anchor !== null ? String(input.section_anchor).trim() : null)
    updates.push(`section_anchor = $${params.length}`)
  }

  if (input.is_completed !== undefined) {
    params.push(Boolean(input.is_completed))
    updates.push(`is_completed = $${params.length}`)
  }

  if (input.pptx_source !== undefined) {
    params.push(input.pptx_source !== null ? String(input.pptx_source).trim() : null)
    updates.push(`pptx_source = $${params.length}`)
  }

  if (input.priority !== undefined && typeof input.priority === 'number' && Number.isInteger(input.priority)) {
    params.push(input.priority)
    updates.push(`priority = $${params.length}`)
  }

  const query = `
    UPDATE ai_review_checklists
    SET ${updates.join(', ')}
    WHERE user_id = $1 AND id = $2
    RETURNING id, lecture_id, group_id, topic_title, section_anchor, is_completed, pptx_source, priority, created_at, updated_at
  `

  const res = await db.query<RawChecklistRow>(query, params)
  const row = res.rows[0]
  return row ? mapChecklistRow(row) : null
}

export async function deleteReviewChecklistItem(
  db: DbClient,
  userId: string,
  itemId: string,
): Promise<void> {
  await db.query(
    'DELETE FROM ai_review_checklists WHERE user_id = $1 AND id = $2',
    [userId, itemId],
  )
}
