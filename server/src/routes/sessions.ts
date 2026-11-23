import { type Context, Hono } from 'hono'
import type { AppEnv } from '../app.js'
import type { Db } from '../db/types.js'
import { parsePage } from '../http/pagination.js'
import {
  InvalidLectureIdError,
  normalizeAiLectureId,
} from '../repo/aiCommon.js'
import {
  deleteSessionById,
  deleteSessionsByLecture,
  getSessionById,
  listSessions,
  type UpdateSessionInput,
  updateSession,
  upsertSession,
} from '../repo/aiSessions.js'

function getRequestUserId(c: Context<AppEnv>): string | null {
  const userId = c.get('userId') ?? c.get('effectiveUserId') ?? c.get('user')?.id
  if (typeof userId === 'string' && userId.trim() !== '') {
    return userId.trim()
  }
  return null
}

export function createSessionsRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // Guard: require authenticated user
  router.use('*', async (c, next) => {
    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    await next()
  })

  // GET / (list sessions)
  router.get('/', async (c) => {
    const userId = getRequestUserId(c)!
    const lectureIdParam = c.req.query('lecture_id')
    const groupIdParam = c.req.query('group_id')
    const archivedParam = c.req.query('archived')

    c.header('Cache-Control', 'no-store')

    let archived: boolean | undefined
    if (archivedParam === 'true') {
      archived = true
    } else if (archivedParam === 'false') {
      archived = false
    }

    const page = parsePage(c.req.query('limit'), c.req.query('offset'))
    try {
      const sessions = await listSessions(db, userId, {
        lectureId: lectureIdParam !== undefined ? lectureIdParam : undefined,
        groupId: groupIdParam,
        archived,
        page,
      })
      return c.json(sessions, 200)
    } catch (err) {
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      return c.json({ error: 'invalid_request' }, 400)
    }
  })

  // GET /:id
  router.get('/:id', async (c) => {
    const userId = getRequestUserId(c)!
    const id = c.req.param('id')
    c.header('Cache-Control', 'no-store')

    const session = await getSessionById(db, userId, id)
    if (!session) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(session, 200)
  })

  // POST / (create/upsert session)
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

    if (!body['lecture_id'] || typeof body['lecture_id'] !== 'string') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    try {
      const session = await upsertSession(db, userId, {
        id: typeof body['id'] === 'string' ? body['id'] : undefined,
        lecture_id: body['lecture_id'],
        group_id: typeof body['group_id'] === 'string' ? body['group_id'] : undefined,
        title: typeof body['title'] === 'string' ? body['title'] : undefined,
        is_archived: typeof body['is_archived'] === 'boolean' ? body['is_archived'] : undefined,
      })
      return c.json(session, 201)
    } catch (err) {
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

    const input: UpdateSessionInput = {}
    if (body['title'] !== undefined) {
      if (typeof body['title'] !== 'string') {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.title = body['title']
    }
    if (body['is_archived'] !== undefined) {
      if (typeof body['is_archived'] !== 'boolean') {
        return c.json({ error: 'invalid_request' }, 400)
      }
      input.is_archived = body['is_archived']
    }

    const updated = await updateSession(db, userId, id, input)
    if (!updated) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(updated, 200)
  })

  // DELETE / (with ?lecture_id=)
  router.delete('/', async (c) => {
    const userId = getRequestUserId(c)!
    const lectureId = c.req.query('lecture_id')
    if (!lectureId || lectureId.trim() === '') {
      return c.json({ error: 'invalid_request' }, 400)
    }

    try {
      normalizeAiLectureId(lectureId)
    } catch (err) {
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      return c.json({ error: 'invalid_request' }, 400)
    }

    await deleteSessionsByLecture(db, userId, lectureId)
    return c.body(null, 204)
  })

  // DELETE /:id
  router.delete('/:id', async (c) => {
    const userId = getRequestUserId(c)!
    const id = c.req.param('id')
    await deleteSessionById(db, userId, id)
    return c.body(null, 204)
  })

  return router
}
