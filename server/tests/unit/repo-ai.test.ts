import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb } from '../../src/db/index.js'
import { runMigrations } from '../../src/db/migrate.js'
import type { Db } from '../../src/db/types.js'
import {
  InvalidLectureIdError,
  normalizeAiLectureId,
  deriveAiGroupId,
} from '../../src/repo/aiCommon.js'
import {
  deleteSessionById,
  deleteSessionsByLecture,
  getSessionById,
  listSessions,
  updateSession,
  upsertSession,
} from '../../src/repo/aiSessions.js'
import {
  createMessage,
  deleteMessageById,
  deleteMessagesBySession,
  listMessages,
  SessionNotFoundError,
  updateMessage,
} from '../../src/repo/aiMessages.js'
import {
  ChecklistValidationError,
  deleteReviewChecklistItem,
  listReviewChecklists,
  updateReviewChecklistItem,
  upsertReviewChecklistBatch,
} from '../../src/repo/reviewChecklists.js'
import {
  previewReassignUserProgress,
  reassignUserProgress,
  upsertProgress,
} from '../../src/repo/progress.js'

describe('AI DB Repositories Unit Tests (M4a)', () => {
  let db: Db

  beforeAll(async () => {
    db = createDb('pglite:memory')
    await runMigrations(db)
  })

  afterAll(async () => {
    await db.close()
  })

  describe('aiCommon validation helpers', () => {
    it('normalizes valid lecture_ids and global keyword', () => {
      expect(normalizeAiLectureId('g01-l01')).toBe('g01-l01')
      expect(normalizeAiLectureId('  G05-L19  ')).toBe('g05-l19')
      expect(normalizeAiLectureId('Global')).toBe('global')
      expect(normalizeAiLectureId(' GLOBAL ')).toBe('global')
      expect(normalizeAiLectureId('lr-sub-l03')).toBe('lr-sub-l03')
    })

    it('rejects invalid lecture_ids', () => {
      expect(() => normalizeAiLectureId('invalid')).toThrow(InvalidLectureIdError)
      expect(() => normalizeAiLectureId('g01-l1')).toThrow(InvalidLectureIdError)
      expect(() => normalizeAiLectureId('')).toThrow(InvalidLectureIdError)
      expect(() => normalizeAiLectureId(null)).toThrow(InvalidLectureIdError)
    })

    it('derives group_id properly including global', () => {
      expect(deriveAiGroupId('global')).toBe('global')
      expect(deriveAiGroupId('g01-l01')).toBe('g01')
      expect(deriveAiGroupId('custom-sec-l02')).toBe('custom-sec')
      expect(deriveAiGroupId('g01-l01', 'custom_group')).toBe('custom_group')
    })
  })

  describe('aiSessions repository', () => {
    it('creates, lists with filters, updates, and deletes sessions', async () => {
      // 1. Create session
      const sess1 = await upsertSession(db, 'alice', {
        lecture_id: 'g01-l01',
        title: '会话 1',
      })
      expect(sess1.id).toBeTruthy()
      expect(sess1.lecture_id).toBe('g01-l01')
      expect(sess1.group_id).toBe('g01')
      expect(sess1.title).toBe('会话 1')
      expect(sess1.is_archived).toBe(false)
      expect(sess1.created_at).toBeTruthy()
      expect(sess1.updated_at).toBeTruthy()

      // 2. Create global session
      const sessGlobal = await upsertSession(db, 'alice', {
        lecture_id: 'global',
        title: '全局会话',
      })
      expect(sessGlobal.lecture_id).toBe('global')
      expect(sessGlobal.group_id).toBe('global')

      // 3. List sessions
      const allAlice = await listSessions(db, 'alice')
      expect(allAlice.length).toBe(2)

      const filterLec = await listSessions(db, 'alice', { lectureId: 'g01-l01' })
      expect(filterLec.length).toBe(1)
      expect(filterLec[0]?.id).toBe(sess1.id)

      // 4. Update session
      const updated = await updateSession(db, 'alice', sess1.id, {
        title: '更新后的会话',
        is_archived: true,
      })
      expect(updated?.title).toBe('更新后的会话')
      expect(updated?.is_archived).toBe(true)

      // 5. Get by ID
      const fetched = await getSessionById(db, 'alice', sess1.id)
      expect(fetched?.title).toBe('更新后的会话')

      // Non-existent or other user get
      const otherUser = await getSessionById(db, 'bob', sess1.id)
      expect(otherUser).toBeNull()

      // 6. Delete by ID
      await deleteSessionById(db, 'alice', sess1.id)
      expect(await getSessionById(db, 'alice', sess1.id)).toBeNull()

      // 7. Delete by lecture
      await deleteSessionsByLecture(db, 'alice', 'global')
      expect(await getSessionById(db, 'alice', sessGlobal.id)).toBeNull()
    })
  })

  describe('aiMessages repository', () => {
    it('creates message, cascades delete from parent session, updates message', async () => {
      // Create session first
      const sess = await upsertSession(db, 'alice', {
        lecture_id: 'g02-l01',
        title: '问答会话',
      })

      // Create message
      const msg1 = await createMessage(db, 'alice', {
        session_id: sess.id,
        role: 'user',
        content: '第一讲讲了什么？',
        model: 'dify-agent',
        prompt_tokens: 10,
        completion_tokens: 0,
      })
      expect(msg1.id).toBeTruthy()
      expect(msg1.session_id).toBe(sess.id)
      expect(msg1.role).toBe('user')
      expect(msg1.content).toBe('第一讲讲了什么？')

      // Create assistant reply
      const msg2 = await createMessage(db, 'alice', {
        session_id: sess.id,
        role: 'assistant',
        content: '第一讲主要介绍了基础概念。',
        model: 'dify-agent',
        prompt_tokens: 10,
        completion_tokens: 20,
      })

      // List messages
      const msgs = await listMessages(db, 'alice', sess.id)
      expect(msgs.length).toBe(2)
      expect(msgs[0]?.id).toBe(msg1.id)
      expect(msgs[1]?.id).toBe(msg2.id)

      // Throws on session not belonging to user
      await expect(
        createMessage(db, 'bob', {
          session_id: sess.id,
          role: 'user',
          content: '非法访问',
        }),
      ).rejects.toThrow(SessionNotFoundError)

      // Update message
      const updatedMsg = await updateMessage(db, 'alice', msg2.id, {
        content: '修改后的回复',
        completion_tokens: 25,
      })
      expect(updatedMsg?.content).toBe('修改后的回复')
      expect(updatedMsg?.completion_tokens).toBe(25)

      // Delete message by id
      await deleteMessageById(db, 'alice', msg1.id)
      const remainingMsgs = await listMessages(db, 'alice', sess.id)
      expect(remainingMsgs.length).toBe(1)

      // Cascade delete: deleting session deletes all remaining messages
      await deleteSessionById(db, 'alice', sess.id)
      const msgsAfterSessionDel = await listMessages(db, 'alice', sess.id)
      expect(msgsAfterSessionDel.length).toBe(0)

      // Clean up messages by session
      await deleteMessagesBySession(db, 'alice', sess.id)
    })
  })

  describe('reviewChecklists repository', () => {
    it('handles batch insert with validation limits, patch, and delete', async () => {
      // 1. Batch insert valid items
      const items = await upsertReviewChecklistBatch(db, 'alice', [
        {
          lecture_id: 'g04-l01',
          topic_title: '考点 1',
          priority: 3,
        },
        {
          lecture_id: 'g04-l01',
          topic_title: '考点 2',
          section_anchor: '#sec-2',
          priority: 1,
        },
      ])
      expect(items.length).toBe(2)
      expect(items[0]?.priority).toBe(3)
      expect(items[1]?.priority).toBe(1)
      const itemId = items[0]!.id

      // 2. Validation errors
      await expect(upsertReviewChecklistBatch(db, 'alice', [])).rejects.toThrow(
        ChecklistValidationError,
      )

      const tooMany = new Array(201).fill(null).map((_, i) => ({
        lecture_id: 'g04-l01',
        topic_title: `考点 ${i}`,
      }))
      let caughtError: ChecklistValidationError | null = null
      try {
        await upsertReviewChecklistBatch(db, 'alice', tooMany)
      } catch (err) {
        if (err instanceof ChecklistValidationError) {
          caughtError = err
        }
      }
      expect(caughtError).not.toBeNull()
      expect(caughtError?.code).toBe('too_many_items')

      await expect(
        upsertReviewChecklistBatch(db, 'alice', [
          { lecture_id: 'bad-id', topic_title: '标题' },
        ]),
      ).rejects.toThrow(InvalidLectureIdError)

      await expect(
        upsertReviewChecklistBatch(db, 'alice', [
          { lecture_id: 'g04-l01', topic_title: '' },
        ]),
      ).rejects.toThrow(ChecklistValidationError)

      // 3. List
      const list = await listReviewChecklists(db, 'alice', { lectureId: 'g04-l01' })
      expect(list.length).toBe(2)

      // 4. Update
      const patched = await updateReviewChecklistItem(db, 'alice', itemId, {
        is_completed: true,
        priority: 5,
      })
      expect(patched?.is_completed).toBe(true)
      expect(patched?.priority).toBe(5)

      // 5. Delete
      await deleteReviewChecklistItem(db, 'alice', itemId)
      const listAfter = await listReviewChecklists(db, 'alice', { lectureId: 'g04-l01' })
      expect(listAfter.length).toBe(1)
    })
  })

  describe('Extended db:reassign with AI tables', () => {
    it('reassigns progress, sessions, messages, and checklists in single transaction', async () => {
      // Setup data for anonymous
      await upsertProgress(db, 'anon_u', { lecture_id: 'g05-l01', status: '学习中' })
      const sess = await upsertSession(db, 'anon_u', {
        id: 'sess_reassign_1',
        lecture_id: 'g05-l01',
        title: '匿名会话',
      })
      await createMessage(db, 'anon_u', {
        id: 'msg_reassign_1',
        session_id: sess.id,
        role: 'user',
        content: '匿名提问',
      })
      await upsertReviewChecklistBatch(db, 'anon_u', [
        {
          id: 'chk_reassign_1',
          lecture_id: 'g05-l01',
          topic_title: '待重分配考点',
        },
      ])

      // Preview
      const preview = await previewReassignUserProgress(db, 'anon_u', 'target_u')
      expect(preview.fromCount).toBe(1)
      expect(preview.toCount).toBe(0)
      expect(preview.sessions?.fromCount).toBe(1)
      expect(preview.messages?.fromCount).toBe(1)
      expect(preview.checklists?.fromCount).toBe(1)

      // Reassign
      const result = await reassignUserProgress(db, 'anon_u', 'target_u')
      expect(result.deletedFromRows).toBe(1)
      expect(result.sessions?.deletedFromRows).toBe(1)
      expect(result.messages?.deletedFromRows).toBe(1)
      expect(result.checklists?.deletedFromRows).toBe(1)

      // Verify target user now owns records
      const targetSessions = await listSessions(db, 'target_u')
      expect(targetSessions.some((s) => s.id === 'sess_reassign_1')).toBe(true)

      const targetMessages = await listMessages(db, 'target_u', 'sess_reassign_1')
      expect(targetMessages.some((m) => m.id === 'msg_reassign_1')).toBe(true)

      const targetChecklists = await listReviewChecklists(db, 'target_u')
      expect(targetChecklists.some((c) => c.id === 'chk_reassign_1')).toBe(true)

      // Verify anon user no longer owns records
      expect(await listSessions(db, 'anon_u')).toHaveLength(0)
      expect(await listReviewChecklists(db, 'anon_u')).toHaveLength(0)
    })
  })
})
