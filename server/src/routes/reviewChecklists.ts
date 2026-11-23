import { type Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { Db } from '../db/types.js'
import { parsePage } from '../http/pagination.js'
import { InvalidLectureIdError } from '../repo/aiCommon.js'
import {
  type CreateChecklistItemInput,
  ChecklistValidationError,
  deleteReviewChecklistItem,
  listReviewChecklists,
  type UpdateChecklistItemInput,
  updateReviewChecklistItem,
  upsertReviewChecklistBatch,
} from '../repo/reviewChecklists.js'

function getRequestUserId(c: Context<AppEnv>): string | null {
  const userId = c.get('userId') ?? c.get('effectiveUserId') ?? c.get('user')?.id
  if (typeof userId === 'string' && userId.trim() !== '') {
    return userId.trim()
  }
  return null
}

export function createReviewChecklistsRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // Guard: require authenticated user
  router.use('*', async (c, next) => {
    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    await next()
  })

  // GET / (list checklists)
  router.get('/', async (c) => {
    const userId = getRequestUserId(c)!
    const lectureIdParam = c.req.query('lecture_id')
    const groupIdParam = c.req.query('group_id')
    c.header('Cache-Control', 'no-store')

    const page = parsePage(c.req.query('limit'), c.req.query('offset'))
    try {
      const items = await listReviewChecklists(db, userId, {
        lectureId: lectureIdParam !== undefined ? lectureIdParam : undefined,
        groupId: groupIdParam,
        page,
      })
      return c.json(items, 200)
    } catch (err) {
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      return c.json({ error: 'invalid_request' }, 400)
    }
  })

  // POST / (batch or single item)
  router.post('/', async (c) => {
    const userId = getRequestUserId(c)!

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    let items: CreateChecklistItemInput[]
    const record = body as Record<string, unknown>

    if (Array.isArray(body)) {
      items = body as CreateChecklistItemInput[]
    } else if (Array.isArray(record['items'])) {
      items = record['items'] as CreateChecklistItemInput[]
    } else if (typeof record['lecture_id'] === 'string' || typeof record['topic_title'] === 'string') {
      // Single object
      items = [body as CreateChecklistItemInput]
    } else {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (items.length === 0) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (items.length > 200) {
      return c.json({ error: 'too_many_items' }, 400)
    }

    try {
      const created = await upsertReviewChecklistBatch(db, userId, items)
      return c.json(created, 201)
    } catch (err) {
      if (err instanceof ChecklistValidationError) {
        return c.json({ error: err.code }, 400)
      }
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      return c.json({ error: 'invalid_request' }, 400)
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

    const input: UpdateChecklistItemInput = {}

    if (body['topic_title'] !== undefined) {
      if (typeof body['topic_title'] !== 'string') {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.topic_title = body['topic_title']
    }

    if (body['section_anchor'] !== undefined) {
      input.section_anchor = body['section_anchor'] !== null ? String(body['section_anchor']) : null
    }

    if (body['is_completed'] !== undefined) {
      if (typeof body['is_completed'] !== 'boolean') {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.is_completed = body['is_completed']
    }

    if (body['pptx_source'] !== undefined) {
      input.pptx_source = body['pptx_source'] !== null ? String(body['pptx_source']) : null
    }

    if (body['priority'] !== undefined) {
      if (typeof body['priority'] !== 'number' || !Number.isInteger(body['priority'])) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.priority = body['priority']
    }

    const updated = await updateReviewChecklistItem(db, userId, id, input)
    if (!updated) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(updated, 200)
  })

  // DELETE /:id
  router.delete('/:id', async (c) => {
    const userId = getRequestUserId(c)!
    const id = c.req.param('id')
    await deleteReviewChecklistItem(db, userId, id)
    return c.body(null, 204)
  })

  return router
}
