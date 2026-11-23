/**
 * sessionStore.ts — Single source of truth for AI companion sessions (P6).
 *
 * Fixes:
 *   - FE-004: Mock or failed turns are never persisted to neonRepository.
 *   - FE-006: Each session owns an isolated Dify conversation_id; creating/switching resets it.
 *   - FE-007: Turns capture { turnId, lectureId, sessionId } upfront and append messages incrementally;
 *             switching sessions or lectures aborts the in-flight stream and prevents cross-write.
 *   - FE-008: Explicit cross-lecture selection is preserved instead of overwritten by sessions[0].
 *   - FE-009: Visiting a lecture or clicking "New session" creates no premature DB row.
 *   - FE-012: Unifies activeSessionId across AiSidebar and SessionHistoryDrawer.
 */

import { ref, type Ref } from 'vue'
import { BRANDING } from '../../../site.config.mts'
import { currentLang, translate } from '../../../i18n/index.ts'
import { aiState } from './aiState'
import { showMessageToast } from './toast'
import {
  neonRepository,
  purgeEmptySessions,
  type AiMessage,
  type AiSession,
  type AppendMessageParams,
  type CreateSessionParams,
} from './neonRepository'
import type { ChatMessage } from './useDifyChat'

export interface SessionRepoLike {
  getSessions(lectureId: string): Promise<AiSession[]>
  createSession(params: CreateSessionParams): Promise<AiSession>
  updateSessionTitle(sessionId: string, title: string, lectureIdHint?: string): Promise<boolean>
  getMessages(sessionId: string): Promise<AiMessage[]>
  appendMessage(params: AppendMessageParams): Promise<AiMessage>
  clearSessions(lectureId: string): Promise<boolean>
}

export interface TurnSnapshot {
  turnId: number
  lectureId: string
  groupId: string
  sessionId: string
  isDraft: boolean
}

export interface CommitTurnInput {
  snapshot: TurnSnapshot
  sessionTitle: string
  userMessage: ChatMessage
  assistantMessage: ChatMessage
  selectedContext?: string
  conversationId?: string
}

export interface CommitTurnResult {
  saved: boolean
  reason?: 'stale_turn' | 'error' | 'incomplete' | 'mock' | 'persist_failed'
  sessionId?: string
  errorDetail?: string
}

const GENERIC_TITLE_RE = /^(\u4f1a\u8bdd\s*\d*|\u65b0\u4f1a\u8bdd|\u65b0\u63a2\u8ba8|\u5168\u7ad9\u63a2\u8ba8\s*\d*|New session|Session\s*\d*)$/i

export function dbMessagesToChatMessages(
  dbMsgs: readonly AiMessage[],
  noSelectionLiteral: string = BRANDING.noSelectionName
): ChatMessage[] {
  return dbMsgs.map((m) => {
    const rawCtx = (m.selected_context || '').trim()
    const validCtx = rawCtx && rawCtx !== noSelectionLiteral && rawCtx !== 'None' ? rawCtx : undefined
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      selectedText: validCtx,
      createdAt: new Date(m.created_at).getTime(),
    }
  })
}

export interface CompanionSessionStore {
  activeSessionId: Ref<string>
  activeLectureId: Ref<string>
  sessions: Ref<AiSession[]>
  draftSession: Ref<AiSession | null>
  getConversationId(sessionId: string): string
  setConversationId(sessionId: string, conversationId: string): void
  registerAbort(abortFn: (() => void) | null): void
  abortActiveStream(): void
  markExplicitSelection(session: AiSession): void
  loadForLecture(lectureId: string): Promise<{ sessionId: string; messages: AiMessage[] }>
  selectSession(sessionId: string): Promise<AiMessage[]>
  startNewDraft(lectureId: string, groupId: string, title: string): AiSession
  beginTurn(lectureId: string, groupId: string, fallbackTitle: string): TurnSnapshot
  isTurnCurrent(snapshot: TurnSnapshot): boolean
  commitTurn(input: CommitTurnInput): Promise<CommitTurnResult>
  clearLecture(lectureId: string): Promise<void>
}

export function createSessionStore(
  repo: SessionRepoLike = neonRepository,
  options: { purgeOnFirstLoad?: boolean } = {}
): CompanionSessionStore {
  const activeSessionId = ref<string>('')
  const activeLectureId = ref<string>('')
  const sessions = ref<AiSession[]>([])
  const draftSession = ref<AiSession | null>(null)

  const persistedSessionIds = new Set<string>()
  const conversationIds = new Map<string, string>()

  let pendingExplicitSession: AiSession | null = null
  let currentTurnId = 0
  let abortedTurnId = 0
  let abortStreamCallback: (() => void) | null = null
  let initialPurgeDone = options.purgeOnFirstLoad === false

  function syncGlobalSessionId(id: string): void {
    activeSessionId.value = id
    aiState.currentSessionId = id
  }

  function registerAbort(abortFn: (() => void) | null): void {
    abortStreamCallback = abortFn
  }

  function abortActiveStream(): void {
    abortedTurnId = currentTurnId
    if (abortStreamCallback) {
      abortStreamCallback()
    }
  }

  function getConversationId(sessionId: string): string {
    return conversationIds.get(sessionId) || ''
  }

  function setConversationId(sessionId: string, convId: string): void {
    if (!sessionId) return
    if (convId) conversationIds.set(sessionId, convId)
    else conversationIds.delete(sessionId)
  }

  function markExplicitSelection(sess: AiSession): void {
    pendingExplicitSession = sess
    syncGlobalSessionId(sess.id)
  }

  async function loadForLecture(lectureId: string): Promise<{ sessionId: string; messages: AiMessage[] }> {
    const normalized = lectureId || 'global'
    if (activeLectureId.value && activeLectureId.value.toLowerCase() !== normalized.toLowerCase()) {
      abortActiveStream()
    }
    activeLectureId.value = normalized
    draftSession.value = null

    if (!initialPurgeDone) {
      initialPurgeDone = true
      try {
        purgeEmptySessions(activeSessionId.value || undefined)
      } catch {
        // ignore purge error
      }
    }

    const list = await repo.getSessions(normalized)
    sessions.value = list
    for (const s of list) {
      persistedSessionIds.add(s.id)
    }

    // Preserve explicit cross-lecture selection (FE-008)
    const explicit = pendingExplicitSession
    if (explicit && explicit.lecture_id.toLowerCase() === normalized.toLowerCase()) {
      pendingExplicitSession = null
      syncGlobalSessionId(explicit.id)
      const msgs = await repo.getMessages(explicit.id)
      return { sessionId: explicit.id, messages: msgs }
    }
    if (!explicit && sessions.value.length > 0) {
      const target = sessions.value[0]!
      syncGlobalSessionId(target.id)
      const msgs = await repo.getMessages(target.id)
      return { sessionId: target.id, messages: msgs }
    }

    // Lazy session guarantee (FE-009): never pre-create an empty DB session on visit
    if (!explicit) {
      syncGlobalSessionId('')
    }
    return { sessionId: activeSessionId.value, messages: [] }
  }

  async function selectSession(sessionId: string): Promise<AiMessage[]> {
    if (activeSessionId.value && activeSessionId.value !== sessionId) {
      abortActiveStream()
    }
    draftSession.value = null
    syncGlobalSessionId(sessionId)
    persistedSessionIds.add(sessionId)
    return repo.getMessages(sessionId)
  }

  function startNewDraft(lectureId: string, groupId: string, title: string): AiSession {
    abortActiveStream()
    const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    const now = new Date().toISOString()
    const draft: AiSession = {
      id,
      lecture_id: lectureId || 'global',
      group_id: groupId || 'general',
      title,
      is_archived: false,
      created_at: now,
      updated_at: now,
    }
    draftSession.value = draft
    conversationIds.delete(id)
    syncGlobalSessionId(id)
    return draft
  }

  function beginTurn(lectureId: string, groupId: string, fallbackTitle: string): TurnSnapshot {
    currentTurnId += 1
    const lec = lectureId || 'global'
    let sessId = activeSessionId.value
    let isDraft = false

    if (!sessId) {
      const id = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const now = new Date().toISOString()
      draftSession.value = {
        id,
        lecture_id: lec,
        group_id: groupId || 'general',
        title: fallbackTitle,
        is_archived: false,
        created_at: now,
        updated_at: now,
      }
      sessId = id
      syncGlobalSessionId(id)
      isDraft = true
    } else if (!persistedSessionIds.has(sessId)) {
      isDraft = true
    }

    return {
      turnId: currentTurnId,
      lectureId: lec,
      groupId: groupId || 'general',
      sessionId: sessId,
      isDraft,
    }
  }

  function isTurnCurrent(snapshot: TurnSnapshot): boolean {
    if (abortedTurnId >= snapshot.turnId) return false
    if (currentTurnId !== snapshot.turnId) return false
    if (activeLectureId.value.toLowerCase() !== snapshot.lectureId.toLowerCase()) return false
    if (activeSessionId.value !== snapshot.sessionId) return false
    return true
  }

  async function commitTurn(input: CommitTurnInput): Promise<CommitTurnResult> {
    const { snapshot, sessionTitle, userMessage, assistantMessage, selectedContext, conversationId } = input
    if (!isTurnCurrent(snapshot)) {
      return { saved: false, reason: 'stale_turn' }
    }
    if (assistantMessage.isMock) {
      return { saved: false, reason: 'mock' }
    }
    if (assistantMessage.isIncomplete) {
      return { saved: false, reason: 'incomplete' }
    }
    if (assistantMessage.isError) {
      return { saved: false, reason: 'error' }
    }

    const sessId = snapshot.sessionId
    try {
      if (!persistedSessionIds.has(sessId)) {
        const created = await repo.createSession({
          id: sessId,
          lecture_id: snapshot.lectureId,
          group_id: snapshot.groupId,
          title: sessionTitle,
        })
        persistedSessionIds.add(created.id)
        sessions.value = [created, ...sessions.value.filter((s) => s.id !== created.id)]
        draftSession.value = null
      } else {
        const existing = sessions.value.find((s) => s.id === sessId)
        if (existing && (!existing.title || GENERIC_TITLE_RE.test(existing.title.trim())) && sessionTitle) {
          existing.title = sessionTitle
          void repo.updateSessionTitle(sessId, sessionTitle, snapshot.lectureId).catch(() => {})
        }
      }

      if (conversationId) {
        conversationIds.set(sessId, conversationId)
      }

      // Incremental save: persist only the completed turn's user + assistant messages (FE-007)
      await repo.appendMessage({
        id: userMessage.id,
        session_id: sessId,
        role: 'user',
        content: userMessage.content,
        selected_context: selectedContext || null,
      })
      await repo.appendMessage({
        id: assistantMessage.id,
        session_id: sessId,
        role: 'assistant',
        content: assistantMessage.content,
      })

      return { saved: true, sessionId: sessId }
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err || 'unknown')
      showMessageToast(translate(currentLang(), 'ai.errPersistFailed', { detail }))
      return { saved: false, reason: 'persist_failed', errorDetail: detail }
    }
  }

  async function clearLecture(lectureId: string): Promise<void> {
    abortActiveStream()
    const normalized = lectureId || 'global'
    try {
      await repo.clearSessions(normalized)
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err || 'unknown')
      showMessageToast(translate(currentLang(), 'ai.errPersistFailed', { detail }))
      throw err
    }
    sessions.value = []
    draftSession.value = null
    syncGlobalSessionId('')
  }

  return {
    activeSessionId,
    activeLectureId,
    sessions,
    draftSession,
    getConversationId,
    setConversationId,
    registerAbort,
    abortActiveStream,
    markExplicitSelection,
    loadForLecture,
    selectSession,
    startNewDraft,
    beginTurn,
    isTurnCurrent,
    commitTurn,
    clearLecture,
  }
}

export const companionSessionStore = createSessionStore()
