import { type Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { Db } from '../db/types.js'
import { parsePage } from '../http/pagination.js'
import {
  type CreateMessageInput,
  createMessageResult,
  deleteMessageById,
  deleteMessagesBySession,
  listMessages,
  MessageIdConflictError,
  type MessageRole,
  SessionNotFoundError,
  type UpdateMessageInput,
  updateMessage,
} from '../repo/aiMessages.js'

function getRequestUserId(c: Context<AppEnv>): string | null {
  const userId = c.get('userId') ?? c.get('effectiveUserId') ?? c.get('user')?.id
  if (typeof userId === 'string' && userId.trim() !== '') {
    return userId.trim()
  }
  return null
}

const VALID_ROLES = new Set<string>(['user', 'assistant', 'system'])

/** Token counts are stored as int4; larger values are rejected instead of overflowing in the database. */
const MAX_TOKEN_COUNT = 2_147_483_647

function isNonNegativeInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TOKEN_COUNT
}

export function createMessagesRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // Guard: require authenticated user
  router.use('*', async (c, next) => {
    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    await next()
  })

  // GET / (list messages, optional ?session_id=)
  router.get('/', async (c) => {
    const userId = getRequestUserId(c)!
    const sessionId = c.req.query('session_id')
    c.header('Cache-Control', 'no-store')

    const page = parsePage(c.req.query('limit'), c.req.query('offset'))
    const messages = await listMessages(db, userId, sessionId, page)
    return c.json(messages, 200)
  })

  // POST / (create message)
  router.post('/', async (c) => {
    const userId = getRequestUserId(c)!

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const sessionId = body['session_id']
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const role = body['role']
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const content = body['content']
    if (typeof content !== 'string') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    let promptTokens: number | undefined
    if (body['prompt_tokens'] !== undefined) {
      if (!isNonNegativeInt(body['prompt_tokens'])) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      promptTokens = body['prompt_tokens'] as number
    }

    let completionTokens: number | undefined
    if (body['completion_tokens'] !== undefined) {
      if (!isNonNegativeInt(body['completion_tokens'])) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      completionTokens = body['completion_tokens'] as number
    }

    const input: CreateMessageInput = {
      id: typeof body['id'] === 'string' ? body['id'] : undefined,
      session_id: sessionId,
      role: role as MessageRole,
      content,
      selected_context: body['selected_context'] !== undefined && body['selected_context'] !== null
        ? String(body['selected_context'])
        : null,
      model: typeof body['model'] === 'string' ? body['model'] : undefined,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    }

    try {
      const { message, created } = await createMessageResult(db, userId, input)
      // Replaying the same id with identical content is idempotent: 200 with the stored row.
      return c.json(message, created ? 201 : 200)
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return c.json({ error: 'not_found' }, 404)
      }
      if (err instanceof MessageIdConflictError) {
        return c.json({ error: 'id_conflict' }, 409)
      }
      // Database failures are server errors, not client mistakes: the global handler answers 500.
      throw err
    }
  })

  // PATCH /:id
  router.patch('/:id', async (c) => {
    const userId = getRequestUserId(c)!
    const id = c.req.param('id')

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const input: UpdateMessageInput = {}

    if (body['content'] !== undefined) {
      if (typeof body['content'] !== 'string') {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.content = body['content']
    }

    if (body['prompt_tokens'] !== undefined) {
      if (!isNonNegativeInt(body['prompt_tokens'])) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.prompt_tokens = body['prompt_tokens'] as number
    }

    if (body['completion_tokens'] !== undefined) {
      if (!isNonNegativeInt(body['completion_tokens'])) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.completion_tokens = body['completion_tokens'] as number
    }

    if (body['model'] !== undefined) {
      if (typeof body['model'] !== 'string') {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.model = body['model']
    }

    if (body['selected_context'] !== undefined) {
      input.selected_context = body['selected_context'] !== null
        ? String(body['selected_context'])
        : null
    }

    const updated = await updateMessage(db, userId, id, input)
    if (!updated) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(updated, 200)
  })

  // DELETE / (with ?session_id=)
  router.delete('/', async (c) => {
    const userId = getRequestUserId(c)!
    const sessionId = c.req.query('session_id')
    if (!sessionId || sessionId.trim() === '') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    await deleteMessagesBySession(db, userId, sessionId.trim())
    return c.body(null, 204)
  })

  // DELETE /:id
  router.delete('/:id', async (c) => {
    const userId = getRequestUserId(c)!
    const id = c.req.param('id')
    await deleteMessageById(db, userId, id)
    return c.body(null, 204)
  })

  return router
}
