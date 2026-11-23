import { randomUUID } from 'node:crypto'
import type { Db, DbClient } from '../db/types.js'
import { pageClause, toIsoUtc } from './aiCommon.js'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface AiMessage {
  id: string
  session_id: string
  role: MessageRole
  content: string
  selected_context: string | null
  model: string
  prompt_tokens: number
  completion_tokens: number
  created_at: string
}

interface RawMessageRow {
  id: string
  session_id: string
  role: MessageRole
  content: string
  selected_context: string | null
  model: string
  prompt_tokens: number
  completion_tokens: number
  created_at: Date | string
}

function mapMessageRow(row: RawMessageRow): AiMessage {
  return {
    id: row.id,
    session_id: row.session_id,
    role: row.role,
    content: row.content,
    selected_context: row.selected_context ?? null,
    model: row.model ?? '',
    prompt_tokens: Number(row.prompt_tokens ?? 0),
    completion_tokens: Number(row.completion_tokens ?? 0),
    created_at: toIsoUtc(row.created_at),
  }
}

export async function listMessages(
  db: DbClient,
  userId: string,
  sessionId?: string,
  page?: { limit: number; offset: number },
): Promise<AiMessage[]> {
  const params: unknown[] = [userId]
  const conditions: string[] = ['user_id = $1']

  if (sessionId !== undefined && sessionId.trim() !== '') {
    params.push(sessionId.trim())
    conditions.push(`session_id = $${params.length}`)
  }

  const query = `
    SELECT id, session_id, role, content, selected_context, model, prompt_tokens, completion_tokens, created_at
    FROM ai_messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at ASC, id ASC
    ${pageClause(params, page)}
  `

  const res = await db.query<RawMessageRow>(query, params)
  return res.rows.map(mapMessageRow)
}

export interface CreateMessageInput {
  id?: string
  session_id: string
  role: MessageRole
  content: string
  selected_context?: string | null
  model?: string
  prompt_tokens?: number
  completion_tokens?: number
}

export class SessionNotFoundError extends Error {
  readonly code = 'not_found'

  constructor(message = 'Session not found') {
    super(message)
    this.name = 'SessionNotFoundError'
  }
}

/** A message id that already exists for this user but with different session, role or content. */
export class MessageIdConflictError extends Error {
  readonly code = 'id_conflict'

  constructor(message = 'Message id already exists with different content') {
    super(message)
    this.name = 'MessageIdConflictError'
  }
}

export interface CreateMessageResult {
  message: AiMessage
  /** False when the id already existed with identical session, role and content (idempotent replay). */
  created: boolean
}

/**
 * Insert a message. Re-sending the same id with identical session, role and content is an
 * idempotent replay (the stored row is returned with `created: false`); the same id with
 * different data throws `MessageIdConflictError`. Any other database error propagates.
 */
export async function createMessageResult(
  db: Db,
  userId: string,
  input: CreateMessageInput,
): Promise<CreateMessageResult> {
  const id = input.id && typeof input.id === 'string' && input.id.trim() !== ''
    ? input.id.trim()
    : randomUUID()
  const sessionId = input.session_id.trim()
  const role = input.role
  const content = input.content
  const selectedContext = input.selected_context !== undefined ? input.selected_context : null
  const model = input.model ?? ''
  const promptTokens = input.prompt_tokens ?? 0
  const completionTokens = input.completion_tokens ?? 0

  return db.tx(async (txClient) => {
    // 1. Verify session exists and belongs to current user
    const sessionRes = await txClient.query(
      'SELECT id FROM ai_sessions WHERE user_id = $1 AND id = $2',
      [userId, sessionId],
    )
    if (sessionRes.rows.length === 0) {
      throw new SessionNotFoundError()
    }

    // 2. Insert message (a duplicate id inserts nothing)
    const msgRes = await txClient.query<RawMessageRow>(
      `INSERT INTO ai_messages (
         user_id, id, session_id, role, content, selected_context, model, prompt_tokens, completion_tokens, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (user_id, id) DO NOTHING
       RETURNING id, session_id, role, content, selected_context, model, prompt_tokens, completion_tokens, created_at`,
      [userId, id, sessionId, role, content, selectedContext, model, promptTokens, completionTokens],
    )

    const inserted = msgRes.rows[0]
    if (!inserted) {
      const existingRes = await txClient.query<RawMessageRow>(
        `SELECT id, session_id, role, content, selected_context, model, prompt_tokens, completion_tokens, created_at
         FROM ai_messages WHERE user_id = $1 AND id = $2`,
        [userId, id],
      )
      const existing = existingRes.rows[0]
      if (!existing) {
        throw new Error('Failed to insert message')
      }
      if (existing.session_id !== sessionId || existing.role !== role || existing.content !== content) {
        throw new MessageIdConflictError()
      }
      return { message: mapMessageRow(existing), created: false }
    }

    // 3. Update session updated_at in same transaction
    await txClient.query(
      'UPDATE ai_sessions SET updated_at = now() WHERE user_id = $1 AND id = $2',
      [userId, sessionId],
    )

    return { message: mapMessageRow(inserted), created: true }
  })
}

export async function createMessage(
  db: Db,
  userId: string,
  input: CreateMessageInput,
): Promise<AiMessage> {
  return (await createMessageResult(db, userId, input)).message
}

export interface UpdateMessageInput {
  content?: string
  completion_tokens?: number
  prompt_tokens?: number
  model?: string
  selected_context?: string | null
}

export async function updateMessage(
  db: DbClient,
  userId: string,
  messageId: string,
  input: UpdateMessageInput,
): Promise<AiMessage | null> {
  const updates: string[] = []
  const params: unknown[] = [userId, messageId]

  if (input.content !== undefined) {
    params.push(input.content)
    updates.push(`content = $${params.length}`)
  }

  if (input.completion_tokens !== undefined) {
    params.push(input.completion_tokens)
    updates.push(`completion_tokens = $${params.length}`)
  }

  if (input.prompt_tokens !== undefined) {
    params.push(input.prompt_tokens)
    updates.push(`prompt_tokens = $${params.length}`)
  }

  if (input.model !== undefined) {
    params.push(input.model)
    updates.push(`model = $${params.length}`)
  }

  if (input.selected_context !== undefined) {
    params.push(input.selected_context)
    updates.push(`selected_context = $${params.length}`)
  }

  if (updates.length === 0) {
    // No fields to update, fetch and return existing
    const res = await db.query<RawMessageRow>(
      `SELECT id, session_id, role, content, selected_context, model, prompt_tokens, completion_tokens, created_at
       FROM ai_messages
       WHERE user_id = $1 AND id = $2`,
      [userId, messageId],
    )
    const row = res.rows[0]
    return row ? mapMessageRow(row) : null
  }

  const query = `
    UPDATE ai_messages
    SET ${updates.join(', ')}
    WHERE user_id = $1 AND id = $2
    RETURNING id, session_id, role, content, selected_context, model, prompt_tokens, completion_tokens, created_at
  `

  const res = await db.query<RawMessageRow>(query, params)
  const row = res.rows[0]
  return row ? mapMessageRow(row) : null
}

export async function deleteMessageById(
  db: DbClient,
  userId: string,
  messageId: string,
): Promise<void> {
  await db.query(
    'DELETE FROM ai_messages WHERE user_id = $1 AND id = $2',
    [userId, messageId],
  )
}

export async function deleteMessagesBySession(
  db: DbClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  await db.query(
    'DELETE FROM ai_messages WHERE user_id = $1 AND session_id = $2',
    [userId, sessionId],
  )
}
