import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from '../app.js'
import type { Db } from '../db/types.js'
import { computeFingerprint, executeIdempotent } from '../http/idempotency.js'
import {
  getAllProgress,
  getProgressByGroup,
  getProgressByLecture,
  InvalidLectureIdError,
  InvalidStatusError,
  normalizeLectureId,
  PROGRESS_STATUSES,
  type ProgressRow,
  type ProgressStatus,
  TooManyItemsError,
  type UpsertProgressInput,
  upsertProgress,
  upsertProgressBatch,
} from '../repo/progress.js'

function getRequestUserId(c: Context<AppEnv>): string | null {
  const userId = c.get('userId') ?? c.get('effectiveUserId') ?? c.get('user')?.id
  if (typeof userId === 'string' && userId.trim() !== '') {
    return userId.trim()
  }
  return null
}

export function createProgressRouter(db: Db): Hono<AppEnv> {
  const router = new Hono<AppEnv>()

  // Guard: require authenticated user
  router.use('*', async (c, next) => {
    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    await next()
  })

  // GET / (and /api/db/progress, /api/progress)
  router.get('/', async (c) => {
    const userId = getRequestUserId(c)!
    const lectureIdParam = c.req.query('lecture_id')
    const groupIdParam = c.req.query('group_id')

    c.header('Cache-Control', 'no-store')

    // Single lecture query: ?lecture_id=<id>
    if (lectureIdParam) {
      let normLec: string
      try {
        normLec = normalizeLectureId(lectureIdParam)
      } catch (err) {
        if (err instanceof InvalidLectureIdError) {
          return c.json({ error: 'invalid_lecture_id' }, 400)
        }
        return c.json({ error: 'invalid_request' }, 400)
      }

      const row = await getProgressByLecture(db, userId, normLec)
      if (!row) {
        return c.json({ error: 'not_found' }, 404)
      }
      return c.json(row, 200)
    }

    // Group query: ?group_id=<id>
    if (groupIdParam) {
      const rows = await getProgressByGroup(db, userId, groupIdParam)
      return c.json(rows, 200)
    }

    // All records for current user
    const rows = await getAllProgress(db, userId)
    return c.json(rows, 200)
  })

  // POST /batch - MUST be defined before /:lecture_id so /batch is not captured as a lecture_id!
  router.post('/batch', async (c) => {
    const userId = getRequestUserId(c)!

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (!body || typeof body !== 'object' || !Array.isArray(body['items'])) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const rawItems: unknown[] = body['items']
    if (rawItems.length > 200) {
      return c.json({ error: 'too_many_items' }, 400)
    }

    // Atomic pre-validation of all items
    const inputs: UpsertProgressInput[] = []
    for (const it of rawItems) {
      if (!it || typeof it !== 'object') {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      const itemRecord = it as Record<string, unknown>
      const rawLectureId = itemRecord['lecture_id']
      if (typeof rawLectureId !== 'string') {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }

      let normLec: string
      try {
        normLec = normalizeLectureId(rawLectureId)
      } catch (err) {
        if (err instanceof InvalidLectureIdError) {
          return c.json({ error: 'invalid_lecture_id' }, 400)
        }
        return c.json({ error: 'invalid_request' }, 400)
      }

      const rawStatus = itemRecord['status']
      if (typeof rawStatus !== 'string' || !PROGRESS_STATUSES.includes(rawStatus as ProgressStatus)) {
        return c.json({ error: 'invalid_status' }, 400)
      }

      inputs.push({
        lecture_id: normLec,
        status: rawStatus as ProgressStatus,
        group_id: typeof itemRecord['group_id'] === 'string' ? itemRecord['group_id'] : null,
        notion_node_id: typeof itemRecord['notion_node_id'] === 'string' ? itemRecord['notion_node_id'] : undefined,
        notion_page_id: typeof itemRecord['notion_page_id'] === 'string' ? itemRecord['notion_page_id'] : undefined,
      })
    }

    const rawKey = c.req.header('idempotency-key')
    const fingerprint = computeFingerprint(c.req.method, c.req.path, body)
    const now = new Date()

    try {
      const result = await executeIdempotent<ProgressRow[]>(
        db,
        userId,
        rawKey,
        fingerprint,
        now,
        async (txClient) => {
          const rows = await upsertProgressBatch(txClient, userId, inputs, now)
          return { statusCode: 200, body: rows }
        },
      )

      if (result.replayed) {
        c.header('Idempotency-Replayed', 'true')
      }
      return c.json(result.body, result.statusCode as ContentfulStatusCode)
    } catch (err) {
      if (err instanceof TooManyItemsError) {
        return c.json({ error: 'too_many_items' }, 400)
      }
      if (err instanceof InvalidStatusError) {
        return c.json({ error: 'invalid_status' }, 400)
      }
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      throw err
    }
  })

  // GET /:lecture_id
  router.get('/:lecture_id', async (c) => {
    const userId = getRequestUserId(c)!
    const rawLec = c.req.param('lecture_id')

    c.header('Cache-Control', 'no-store')

    let normLec: string
    try {
      normLec = normalizeLectureId(rawLec)
    } catch (err) {
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      return c.json({ error: 'invalid_request' }, 400)
    }

    const row = await getProgressByLecture(db, userId, normLec)
    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(row, 200)
  })

  // Single lecture PATCH upsert handler
  async function handlePatch(c: Context<AppEnv>, lectureIdFallback?: string) {
    const userId = getRequestUserId(c)!

    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const rawLectureId =
      lectureIdFallback || body['lecture_id'] || c.req.query('lecture_id')
    if (!rawLectureId || typeof rawLectureId !== 'string') {
      return c.json({ error: 'invalid_lecture_id' }, 400)
    }

    let normLectureId: string
    try {
      normLectureId = normalizeLectureId(rawLectureId)
    } catch (err) {
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      return c.json({ error: 'invalid_request' }, 400)
    }

    const rawStatus = body['status']
    if (typeof rawStatus !== 'string' || !PROGRESS_STATUSES.includes(rawStatus as ProgressStatus)) {
      return c.json({ error: 'invalid_status' }, 400)
    }

    const input: UpsertProgressInput = {
      lecture_id: normLectureId,
      status: rawStatus as ProgressStatus,
      group_id: typeof body['group_id'] === 'string' ? body['group_id'] : null,
      notion_node_id: typeof body['notion_node_id'] === 'string' ? body['notion_node_id'] : undefined,
      notion_page_id: typeof body['notion_page_id'] === 'string' ? body['notion_page_id'] : undefined,
    }

    const rawKey = c.req.header('idempotency-key')
    const fingerprint = computeFingerprint(c.req.method, c.req.path, body)
    const now = new Date()

    try {
      const result = await executeIdempotent<ProgressRow>(
        db,
        userId,
        rawKey,
        fingerprint,
        now,
        async (txClient) => {
          const row = await upsertProgress(txClient, userId, input, now)
          return { statusCode: 200, body: row }
        },
      )

      if (result.replayed) {
        c.header('Idempotency-Replayed', 'true')
      }
      return c.json(result.body, result.statusCode as ContentfulStatusCode)
    } catch (err) {
      if (err instanceof InvalidStatusError) {
        return c.json({ error: 'invalid_status' }, 400)
      }
      if (err instanceof InvalidLectureIdError) {
        return c.json({ error: 'invalid_lecture_id' }, 400)
      }
      throw err
    }
  }

  // PATCH /:lecture_id
  router.patch('/:lecture_id', async (c) => {
    return handlePatch(c, c.req.param('lecture_id'))
  })

  // PATCH /
  router.patch('/', async (c) => {
    return handlePatch(c)
  })

  return router
}
