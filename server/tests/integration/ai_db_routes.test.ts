import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import type { AppConfig } from '../../src/config/schema.js'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'

function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: 'pglite:memory',
    databaseUrlDirect: null,
    host: '127.0.0.1',
    port: 8100,
    authAdapter: 'trusted-header',
    authHeaderPreset: 'authelia',
    authHeaderUser: 'Remote-User',
    authHeaderGroups: 'Remote-Groups',
    authHeaderEmail: 'Remote-Email',
    authHeaderName: 'Remote-Name',
    authGroupSeparator: ',',
    authRoleMap: {
      admins: ['admin'],
      staff: ['author'],
    },
    logoutUrl: null,
    dbAutoMigrate: false,
    notionHealthUrl: null,
    allowNonLoopback: false,
    logLevel: 'info',
    aiProvider: 'off',
    difyApiBase: 'https://api.dify.ai/v1',
    difyApiKey: null,
    openaiApiBase: 'https://api.openai.com/v1',
    openaiApiKey: null,
    openaiModel: 'gpt-4o-mini',
    aiUpstreamTimeoutMs: 60000,
    aiUploadMaxBytes: 52428800,
    aiAllowAnonymous: false,
    aiRatePerMinute: 20,
    aiMaxConcurrent: 2,
    aiDailyLimit: 300,
    writeRatePerMinute: 120,
    aiQueryMaxBytes: 8192,
    aiInputsMaxBytes: 32768,
    aiStreamMaxMs: 300000,
    aiAccessLog: false,
    aiPromptsFile: null,
    siteDistDir: null,
    aiToolsFile: null,
    aiToolTimeoutMs: 8000,
    aiToolMaxResultBytes: 24000,
    aiToolMaxSteps: 5,
    aiMcpToken: null,
    aiMcpTicketSecret: null,
    ...overrides,
  }
}

describe('AI DB Routes Integration Tests (M4a)', () => {
  let db: Db
  let config: AppConfig
  let app: ReturnType<typeof createApp>

  beforeAll(async () => {
    db = createDb('pglite:memory')
    await runMigrations(db)
    config = makeTestConfig()
    app = createApp(config, db)
  })

  afterAll(async () => {
    await db.close()
  })

  const aliceHeaders = {
    'Remote-User': 'alice',
    'Content-Type': 'application/json',
  }

  const bobHeaders = {
    'Remote-User': 'bob',
    'Content-Type': 'application/json',
  }

  describe('Sessions API (/api/db/sessions)', () => {
    it('creates, lists, gets, patches, and deletes session with multi-user isolation', async () => {
      // 1. Alice creates a session
      const createRes = await app.request('/api/db/sessions', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          lecture_id: 'g01-l01',
          title: 'Alice 会话',
        }),
      })
      expect(createRes.status).toBe(201)
      const session = (await createRes.json()) as Record<string, unknown>
      expect(session['id']).toBeTruthy()
      expect(session['group_id']).toBe('g01')
      expect(session['title']).toBe('Alice 会话')
      const sessionId = session['id'] as string

      // 2. Bob cannot read Alice's session (404)
      const bobGet = await app.request(`/api/db/sessions/${sessionId}`, {
        headers: bobHeaders,
      })
      expect(bobGet.status).toBe(404)
      expect(await bobGet.json()).toEqual({ error: 'not_found' })

      // 3. Bob cannot patch Alice's session (404)
      const bobPatch = await app.request(`/api/db/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: bobHeaders,
        body: JSON.stringify({ title: 'Bob 篡改' }),
      })
      expect(bobPatch.status).toBe(404)

      // 4. Bob cannot delete Alice's session (returns 204 idempotently without affecting Alice)
      const bobDel = await app.request(`/api/db/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: bobHeaders,
      })
      expect(bobDel.status).toBe(204)

      // Alice still has her session
      const aliceGet = await app.request(`/api/db/sessions/${sessionId}`, {
        headers: aliceHeaders,
      })
      expect(aliceGet.status).toBe(200)

      // 5. Global lecture_id session
      const globalRes = await app.request('/api/db/sessions', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          lecture_id: 'global',
        }),
      })
      expect(globalRes.status).toBe(201)
      const globalSession = (await globalRes.json()) as Record<string, unknown>
      expect(globalSession['lecture_id']).toBe('global')
      expect(globalSession['group_id']).toBe('global')

      // 6. Delete sessions by lecture_id
      const delByLec = await app.request('/api/db/sessions?lecture_id=global', {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      expect(delByLec.status).toBe(204)
    })
  })

  describe('Messages API (/api/db/messages)', () => {
    it('appends messages, isolates across users, and cascades on session delete', async () => {
      // 1. Alice creates session
      const sRes = await app.request('/api/db/sessions', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ lecture_id: 'g02-l01', title: '会话2' }),
      })
      const sess = (await sRes.json()) as Record<string, unknown>
      const sessionId = sess['id'] as string

      // 2. Alice adds message
      const mRes = await app.request('/api/db/messages', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          session_id: sessionId,
          role: 'user',
          content: '请讲讲第二讲',
          prompt_tokens: 5,
          completion_tokens: 0,
        }),
      })
      expect(mRes.status).toBe(201)
      const msg = (await mRes.json()) as Record<string, unknown>
      const messageId = msg['id'] as string

      // 3. Bob attempts to add message to Alice's session -> 404
      const bobAdd = await app.request('/api/db/messages', {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({
          session_id: sessionId,
          role: 'user',
          content: 'Bob 试图在 Alice 会话插话',
        }),
      })
      expect(bobAdd.status).toBe(404)

      // 4. Bob attempts to patch Alice's message -> 404
      const bobPatch = await app.request(`/api/db/messages/${messageId}`, {
        method: 'PATCH',
        headers: bobHeaders,
        body: JSON.stringify({ content: 'Bob 篡改' }),
      })
      expect(bobPatch.status).toBe(404)

      // 5. Alice patches her message
      const alicePatch = await app.request(`/api/db/messages/${messageId}`, {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ content: 'Alice 修正问题' }),
      })
      expect(alicePatch.status).toBe(200)
      expect((await alicePatch.json())['content']).toBe('Alice 修正问题')

      // 6. Alice deletes session -> messages cascade deleted
      await app.request(`/api/db/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: aliceHeaders,
      })

      const listAfter = await app.request(`/api/db/messages?session_id=${sessionId}`, {
        headers: aliceHeaders,
      })
      expect(listAfter.status).toBe(200)
      expect(await listAfter.json()).toEqual([])
    })
  })

  describe('Review Checklists API (/api/db/review-checklists & /api/db/checklist)', () => {
    it('supports batch upsert, single item, 200 vs 201 limits, patch, and delete', async () => {
      // 1. Single item object payload
      const singleRes = await app.request('/api/db/review-checklists', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({
          lecture_id: 'g03-l01',
          topic_title: '考点 A',
        }),
      })
      expect(singleRes.status).toBe(201)
      const singleItems = (await singleRes.json()) as unknown[]
      expect(Array.isArray(singleItems)).toBe(true)
      expect(singleItems.length).toBe(1)
      const itemA = singleItems[0] as Record<string, unknown>
      const itemId = itemA['id'] as string

      // 2. Batch 200 items succeeds
      const batch200 = new Array(200).fill(null).map((_, i) => ({
        lecture_id: 'g03-l02',
        topic_title: `考点 ${i + 1}`,
      }))
      const batchRes = await app.request('/api/db/review-checklists', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ items: batch200 }),
      })
      expect(batchRes.status).toBe(201)
      const batchItems = await batchRes.json()
      expect(Array.isArray(batchItems)).toBe(true)
      expect(batchItems.length).toBe(200)

      // 3. Batch 201 items fails with 400 too_many_items
      const batch201 = new Array(201).fill(null).map((_, i) => ({
        lecture_id: 'g03-l02',
        topic_title: `考点 ${i + 1}`,
      }))
      const tooManyRes = await app.request('/api/db/review-checklists', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ items: batch201 }),
      })
      expect(tooManyRes.status).toBe(400)
      expect(await tooManyRes.json()).toEqual({ error: 'too_many_items' })

      // 4. Empty items array -> 400 invalid_request
      const emptyRes = await app.request('/api/db/review-checklists', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ items: [] }),
      })
      expect(emptyRes.status).toBe(400)
      expect(await emptyRes.json()).toEqual({ error: 'invalid_request' })

      // 5. Alias /api/db/checklist works identically
      const aliasRes = await app.request('/api/db/checklist?lecture_id=g03-l01', {
        headers: aliceHeaders,
      })
      expect(aliasRes.status).toBe(200)
      const aliasList = (await aliasRes.json()) as unknown[]
      expect(aliasList.length).toBe(1)

      // 6. Multi-user isolation: Bob cannot patch Alice's checklist item
      const bobPatch = await app.request(`/api/db/review-checklists/${itemId}`, {
        method: 'PATCH',
        headers: bobHeaders,
        body: JSON.stringify({ is_completed: true }),
      })
      expect(bobPatch.status).toBe(404)

      // 7. Alice patches her checklist item
      const alicePatch = await app.request(`/api/db/review-checklists/${itemId}`, {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ is_completed: true }),
      })
      expect(alicePatch.status).toBe(200)
      expect((await alicePatch.json())['is_completed']).toBe(true)

      // 8. Alice deletes checklist item
      const delRes = await app.request(`/api/db/review-checklists/${itemId}`, {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      expect(delRes.status).toBe(204)
    })

    it('handles validation errors and edge cases across sessions, messages, and checklists', async () => {
      // Sessions validation errors
      const getBadLecture = await app.request('/api/db/sessions?lecture_id=INVALID!!', {
        headers: aliceHeaders,
      })
      expect(getBadLecture.status).toBe(400)
      expect(await getBadLecture.json()).toEqual({ error: 'invalid_lecture_id' })

      const getFilterArchived = await app.request('/api/db/sessions?archived=true', {
        headers: aliceHeaders,
      })
      expect(getFilterArchived.status).toBe(200)

      const getFilterUnarchived = await app.request('/api/db/sessions?archived=false', {
        headers: aliceHeaders,
      })
      expect(getFilterUnarchived.status).toBe(200)

      const postBadJson = await app.request('/api/db/sessions', {
        method: 'POST',
        headers: aliceHeaders,
        body: 'invalid-json',
      })
      expect(postBadJson.status).toBe(400)
      expect(await postBadJson.json()).toEqual({ error: 'invalid_request' })

      const postNoLecture = await app.request('/api/db/sessions', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ title: 'no lecture id' }),
      })
      expect(postNoLecture.status).toBe(400)
      expect(await postNoLecture.json()).toEqual({ error: 'invalid_request' })

      const postInvalidLecture = await app.request('/api/db/sessions', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ lecture_id: 'bad@@@' }),
      })
      expect(postInvalidLecture.status).toBe(400)
      expect(await postInvalidLecture.json()).toEqual({ error: 'invalid_lecture_id' })

      const patchBadJson = await app.request('/api/db/sessions/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: 'bad-json',
      })
      expect(patchBadJson.status).toBe(400)

      const patchBadTypes = await app.request('/api/db/sessions/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ title: 12345 }),
      })
      expect(patchBadTypes.status).toBe(400)

      const patchBadArchived = await app.request('/api/db/sessions/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ is_archived: 'not-a-bool' }),
      })
      expect(patchBadArchived.status).toBe(400)

      const patchNotFound = await app.request('/api/db/sessions/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ title: 'New' }),
      })
      expect(patchNotFound.status).toBe(404)

      const delMissingQuery = await app.request('/api/db/sessions', {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      expect(delMissingQuery.status).toBe(400)
      expect(await delMissingQuery.json()).toEqual({ error: 'invalid_request' })

      const delBadLecture = await app.request('/api/db/sessions?lecture_id=invalid!', {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      expect(delBadLecture.status).toBe(400)
      expect(await delBadLecture.json()).toEqual({ error: 'invalid_lecture_id' })

      // Messages validation errors
      const getMsgNoSession = await app.request('/api/db/messages', {
        headers: aliceHeaders,
      })
      expect(getMsgNoSession.status).toBe(200)
      expect(Array.isArray(await getMsgNoSession.json())).toBe(true)

      const postMsgBadJson = await app.request('/api/db/messages', {
        method: 'POST',
        headers: aliceHeaders,
        body: '{not valid json',
      })
      expect(postMsgBadJson.status).toBe(400)

      const postMsgMissingFields = await app.request('/api/db/messages', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ session_id: 's1' }),
      })
      expect(postMsgMissingFields.status).toBe(400)

      const postMsgBadRole = await app.request('/api/db/messages', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ session_id: 's1', role: 'invalid_role', content: 'test' }),
      })
      expect(postMsgBadRole.status).toBe(400)

      const patchMsgBadJson = await app.request('/api/db/messages/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: '{bad',
      })
      expect(patchMsgBadJson.status).toBe(400)

      const patchMsgBadContent = await app.request('/api/db/messages/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ content: 12345 }),
      })
      expect(patchMsgBadContent.status).toBe(400)

      const patchMsgNotFound = await app.request('/api/db/messages/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ content: 'updated' }),
      })
      expect(patchMsgNotFound.status).toBe(404)

      const delMsgNotFound = await app.request('/api/db/messages/nonexistent', {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      expect(delMsgNotFound.status).toBe(204)

      const delMsgNoSession = await app.request('/api/db/messages', {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      expect(delMsgNoSession.status).toBe(400)

      // Review checklists validation errors
      const getChecklistBadLecture = await app.request('/api/db/review-checklists?lecture_id=bad!!!', {
        headers: aliceHeaders,
      })
      expect(getChecklistBadLecture.status).toBe(400)
      expect(await getChecklistBadLecture.json()).toEqual({ error: 'invalid_lecture_id' })

      const postChecklistBadJson = await app.request('/api/db/review-checklists', {
        method: 'POST',
        headers: aliceHeaders,
        body: 'invalid-json',
      })
      expect(postChecklistBadJson.status).toBe(400)

      const postChecklistBadItem = await app.request('/api/db/review-checklists', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ lecture_id: 'g01-l01' }),
      })
      expect(postChecklistBadItem.status).toBe(400)

      const postChecklistBadLecture = await app.request('/api/db/review-checklists', {
        method: 'POST',
        headers: aliceHeaders,
        body: JSON.stringify({ lecture_id: 'bad@@@', topic_title: 'topic' }),
      })
      expect(postChecklistBadLecture.status).toBe(400)
      expect(await postChecklistBadLecture.json()).toEqual({ error: 'invalid_lecture_id' })

      const patchChecklistBadJson = await app.request('/api/db/review-checklists/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: 'invalid-json',
      })
      expect(patchChecklistBadJson.status).toBe(400)

      const patchChecklistBadVal = await app.request('/api/db/review-checklists/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ is_completed: 'not_bool' }),
      })
      expect(patchChecklistBadVal.status).toBe(400)

      const patchChecklistNotFound = await app.request('/api/db/review-checklists/nonexistent', {
        method: 'PATCH',
        headers: aliceHeaders,
        body: JSON.stringify({ is_completed: true }),
      })
      expect(patchChecklistNotFound.status).toBe(404)

      const delChecklistNotFound = await app.request('/api/db/review-checklists/nonexistent', {
        method: 'DELETE',
        headers: aliceHeaders,
      })
      expect(delChecklistNotFound.status).toBe(204)
    })
  })
})
