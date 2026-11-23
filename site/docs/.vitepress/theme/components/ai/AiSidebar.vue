<script setup lang="ts">
/**
 * AiSidebar.vue — 讲义 AI 伴读侧边栏顶层装配组件
 * 
 * 职责：
 *   集成 AiSidebarShell (分屏外壳)、ChatContainer (会话流与输入)、
 *   SessionHistoryDrawer (历史管理)、useDifyChat (SSE流式通信)、
 *   neonRepository (数据持久化) 与 pptxUploader (课件解析)。
 * 
 * 铁律：零 Emoji、严格 TypeScript (零 any)、SSR 安全、严禁面条代码。
 */

import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { API_ENDPOINTS } from '../../../site.config.mts'
import { useT } from '../../../i18n/useT.ts'
import { normalizePromptLang } from '../../../prompts/companion.ts'
import { getQuickActions } from '../../../prompts/store.ts'
import { isEnabled } from '../../debug/flags'
import { aiState } from './aiState'
import {
  BYOK_CHANGED_EVENT,
  BYOK_STATUS_EVENT,
  extractEndpointHost,
  getByokVerifyState,
  isByokActive,
  readByokConfig,
  type ByokConfig,
  type ByokVerifyStatus,
} from './byokClient'
import { companionRuntime } from './companionRuntime'
import { useLectureContext } from './useLectureContext'
import { useDifyChat, type DifyChatInputs } from './useDifyChat'
import { companionSessionStore, dbMessagesToChatMessages } from './sessionStore'
import {
  getAllSessions,
  getSessions,
  type AiSession,
} from './neonRepository'
import { uploadAndMapPptx } from './pptxUploader'
import type { SendPayload } from './types'

import AiSidebarShell from './AiSidebarShell.vue'
import ChatContainer from './ChatContainer.vue'
import SessionHistoryDrawer from './SessionHistoryDrawer.vue'
// Local author mode only: never part of the production bundle (the dev branch is dead code there, so no chunk is emitted)
const ConceptAuthorPanel = import.meta.env.DEV ? defineAsyncComponent(() => import('./ConceptAuthorPanel.vue')) : null

defineOptions({
  name: 'AiSidebar'
})

export type CompanionConnectionState =
  | 'checking'
  | 'ok'
  | 'unconfigured'
  | 'unavailable'
  | 'rate-limited'
  | 'byok-unverified'
  | 'byok-ok'
  | 'byok-failed'
  | 'mock'

const { t, lang } = useT()
const { lectureInfo, currentSection } = useLectureContext()
const companionCaps = companionRuntime()

// 历史会话抽屉开关
const isHistoryOpen = ref(false)

// 单一会话真源
const activeSessionId = companionSessionStore.activeSessionId
const byokConfig = ref<ByokConfig>(readByokConfig())
const byokVerifyStatus = ref<ByokVerifyStatus>(getByokVerifyState().status)
const proxyHealthState = ref<'checking' | 'ok' | 'unconfigured' | 'unavailable'>('checking')
const rateLimitSec = ref<number>(0)
let rateLimitTimer: ReturnType<typeof setInterval> | null = null

function clearRateLimitTimer(): void {
  if (rateLimitTimer !== null) {
    clearInterval(rateLimitTimer)
    rateLimitTimer = null
  }
  rateLimitSec.value = 0
}

function startRateLimitCountdown(seconds: number): void {
  clearRateLimitTimer()
  const clean = Math.max(1, Math.ceil(seconds))
  rateLimitSec.value = clean
  if (typeof window === 'undefined') return
  rateLimitTimer = setInterval(() => {
    if (rateLimitSec.value <= 1) {
      clearRateLimitTimer()
    } else {
      rateLimitSec.value -= 1
    }
  }, 1000)
}

function isDebugMockActive(): boolean {
  try {
    return isEnabled('aiMock')
  } catch {
    return false
  }
}

async function probeHealth(): Promise<void> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return
  if (!companionCaps.allowProxy) return
  if (isByokActive(byokConfig.value)) return
  if (isDebugMockActive()) return
  if (rateLimitSec.value > 0) return

  proxyHealthState.value = 'checking'
  try {
    const res = await fetch(API_ENDPOINTS.health, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'manual',
    })
    if (!res.ok) {
      proxyHealthState.value = 'unavailable'
      return
    }
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean
      checks?: { ai?: string }
      aiLastCall?: { ok?: boolean }
    } | null
    const aiCheck = json?.checks?.ai
    if (aiCheck === 'off') {
      proxyHealthState.value = 'unconfigured'
    } else if (aiCheck === 'degraded' || json?.aiLastCall?.ok === false) {
      proxyHealthState.value = 'unavailable'
    } else if (aiCheck === 'ok') {
      proxyHealthState.value = 'ok'
    } else {
      proxyHealthState.value = 'unavailable'
    }
  } catch {
    proxyHealthState.value = 'unavailable'
  }
}

const useByokTransport = computed<boolean>(() => {
  if (!companionCaps.allowProxy) return true
  return isByokActive(byokConfig.value)
})

const companionStatus = computed<CompanionConnectionState>(() => {
  if (useByokTransport.value) {
    if (!isByokActive(byokConfig.value)) return 'byok-failed'
    if (byokVerifyStatus.value === 'ok') return 'byok-ok'
    if (byokVerifyStatus.value === 'failed') return 'byok-failed'
    return 'byok-unverified'
  }
  if (isDebugMockActive()) return 'mock'
  if (rateLimitSec.value > 0) return 'rate-limited'
  return proxyHealthState.value
})

const sourceLabel = computed<string>(() => {
  const st = companionStatus.value
  const host = extractEndpointHost(byokConfig.value.baseUrl) || '-'
  if (st === 'byok-ok') return t('ai.sourceByokOk', { host })
  if (st === 'byok-failed') return t('ai.sourceByokFailed', { host })
  if (st === 'byok-unverified') return t('ai.sourceByokUnverified', { host })
  if (st === 'mock') return t('ai.sourceMock')
  if (st === 'rate-limited') return t('ai.sourceRateLimited', { seconds: rateLimitSec.value })
  if (st === 'unconfigured') return t('ai.sourceUnconfigured')
  if (st === 'unavailable') return t('ai.sourceUnavailable')
  if (st === 'ok') return t('ai.sourceProxy')
  return t('ai.sourceChecking')
})

const refreshByok = () => {
  byokConfig.value = readByokConfig()
  byokVerifyStatus.value = getByokVerifyState().status
  if (!useByokTransport.value && aiState.isOpen) {
    void probeHealth()
  }
}

const refreshByokStatus = () => {
  byokVerifyStatus.value = getByokVerifyState().status
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener(BYOK_CHANGED_EVENT, refreshByok)
    window.addEventListener(BYOK_STATUS_EVENT, refreshByokStatus)
  }
  if (aiState.isOpen) {
    void probeHealth()
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener(BYOK_CHANGED_EVENT, refreshByok)
    window.removeEventListener(BYOK_STATUS_EVENT, refreshByokStatus)
  }
  clearRateLimitTimer()
  companionSessionStore.registerAbort(null)
})

watch(
  () => aiState.isOpen,
  (open) => {
    if (open) {
      refreshByok()
      void probeHealth()
    } else {
      isHistoryOpen.value = false
    }
  }
)

// 初始化流式引擎
const {
  messages: difyMessages,
  isStreaming,
  sendMessage: difySend,
  retryLastMessage: difyRetry,
  stopStreaming,
  clearMessages: difyClear,
  setConversationId,
} = useDifyChat({
  apiEndpoint: API_ENDPOINTS.aiChat,
  adapter: companionCaps.adapter,
  onRateLimited: (sec) => startRateLimitCountdown(sec),
  onUnconfigured: () => {
    clearRateLimitTimer()
    proxyHealthState.value = 'unconfigured'
  },
  onUnavailable: () => {
    if (rateLimitSec.value <= 0) proxyHealthState.value = 'unavailable'
  },
  onProxyOk: () => {
    clearRateLimitTimer()
    proxyHealthState.value = 'ok'
  },
})

companionSessionStore.registerAbort(() => stopStreaming())

// 当前讲变更时，通过 sessionStore 重载（保留跨讲显式跳转会话，绝不预建空会话）
const reloadLectureSessions = async () => {
  const lecId = lectureInfo.value.lectureId || 'global'
  try {
    const { sessionId, messages: dbMsgs } = await companionSessionStore.loadForLecture(lecId)
    difyClear()
    if (sessionId) {
      setConversationId(companionSessionStore.getConversationId(sessionId))
      difyMessages.value = dbMessagesToChatMessages(dbMsgs, t('ai.noSelection'))
    }
  } catch {
    difyClear()
  }
}

watch(
  () => lectureInfo.value.lectureId,
  () => {
    void reloadLectureSessions()
  },
  { immediate: true }
)

function buildSessionTitle(query: string, isHome: boolean): string {
  const cleanSnippet = query.replace(/[\r\n]+/g, ' ').trim().slice(0, 20)
  if (isHome) {
    return t('ai.sessionTitleExplore', { snippet: cleanSnippet || t('ai.globalOutlineName') })
  }
  return t('ai.sessionTitleLecture', {
    title: lectureInfo.value.title || lectureInfo.value.lectureId,
    snippet: cleanSnippet || t('ai.userSessionDefault'),
  })
}

async function resolveDraftCount(): Promise<number> {
  const all = await getAllSessions()
  return all.length
}

// 发送消息处理 (captured TurnSnapshot + zero mock/error DB write)
const handleSend = async (payload: SendPayload) => {
  const rawSel = (payload.selectedText || aiState.quotedText || '').trim()
  const noSel = t('ai.noSelection')
  const effectiveSelection = rawSel && rawSel !== noSel ? rawSel : ''
  const isHome = !lectureInfo.value.lectureId
  const lecName = isHome
    ? t('ai.globalContextName')
    : `${lectureInfo.value.lectureId}: ${lectureInfo.value.title}`
  const grpName = isHome
    ? t('ai.globalGroupName')
    : `${lectureInfo.value.groupId}: ${lectureInfo.value.groupTitle}`
  const secName =
    currentSection.value || (isHome ? t('ai.globalOutlineName') : t('ai.lectureOutlineName'))

  const dynamicInputs: DifyChatInputs = {
    current_lecture: lecName,
    group: grpName,
    selection: effectiveSelection,
    outline: secName,
  }

  const pLang = normalizePromptLang(lang.value)
  const actionObj = payload.actionId
    ? getQuickActions().find((a) => a.id === payload.actionId)
    : undefined
  const displayLabel = actionObj ? actionObj.label[pLang] : undefined
  const titleText = payload.query.trim() || displayLabel || ''

  const lecId = lectureInfo.value.lectureId || 'global'
  const grpId = lectureInfo.value.groupDir || 'general'
  const sessionTitle = buildSessionTitle(titleText, isHome)
  const snapshot = companionSessionStore.beginTurn(lecId, grpId, sessionTitle)
  setConversationId(companionSessionStore.getConversationId(snapshot.sessionId))

  const outcome = await difySend(payload.query, dynamicInputs, {
    actionId: payload.actionId,
    displayLabel,
    lang: lang.value,
  })
  if (!outcome) return

  if (outcome.isError || outcome.isIncomplete) {
    return
  }

  await companionSessionStore.commitTurn({
    snapshot,
    sessionTitle,
    userMessage: outcome.userMessage,
    assistantMessage: outcome.assistantMessage,
    selectedContext: effectiveSelection || undefined,
    conversationId: outcome.conversationId,
  })

  if (aiState.quotedText) {
    aiState.clearQuotedText()
  }
}

watch(
  [() => aiState.pendingAction, () => aiState.isOpen, isStreaming],
  ([pending, open, streaming]) => {
    // A menu action clicked mid-stream waits here and runs when the stream ends
    if (!open || !pending || streaming) return
    const nextAction = aiState.consumePendingAction()
    if (!nextAction) return
    void handleSend({
      query: '',
      scope: nextAction.selectedText ? 'selection' : aiState.activeScope,
      selectedText: nextAction.selectedText,
      actionId: nextAction.actionId,
    })
  },
  { immediate: true }
)

const handleRetry = async () => {
  const lecId = lectureInfo.value.lectureId || 'global'
  const grpId = lectureInfo.value.groupDir || 'general'
  const isHome = !lectureInfo.value.lectureId
  const snapshot = companionSessionStore.beginTurn(lecId, grpId, t('ai.userSessionDefault'))
  const outcome = await difyRetry()
  if (!outcome) return

  if (outcome.isError || outcome.isIncomplete) {
    return
  }

  const title = buildSessionTitle(outcome.userMessage.content, isHome)
  await companionSessionStore.commitTurn({
    snapshot,
    sessionTitle: title,
    userMessage: outcome.userMessage,
    assistantMessage: outcome.assistantMessage,
    selectedContext: outcome.userMessage.selectedText,
    conversationId: outcome.conversationId,
  })
}

// 停止流式
const handleStop = () => {
  stopStreaming()
}

// 上传课件并生成考点映射
const handleUploadPptx = async (file: File) => {
  difyMessages.value.push({
    id: 'msg_' + Date.now() + '_u',
    role: 'user',
    content: `[${t('ai.uploadBtn')}] ${file.name}`,
    createdAt: Date.now(),
  })

  const botMsgId = 'msg_' + Date.now() + '_a'
  difyMessages.value.push({
    id: botMsgId,
    role: 'assistant',
    content: '...',
    createdAt: Date.now(),
    isStreaming: true,
  })

  try {
    const res = await uploadAndMapPptx(file)
    const botIdx = difyMessages.value.findIndex((m) => m.id === botMsgId)
    if (botIdx !== -1 && difyMessages.value[botIdx]) {
      difyMessages.value[botIdx]!.content = res.formattedMarkdown
      difyMessages.value[botIdx]!.isStreaming = false
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    const botIdx = difyMessages.value.findIndex((m) => m.id === botMsgId)
    if (botIdx !== -1 && difyMessages.value[botIdx]) {
      difyMessages.value[botIdx]!.isError = true
      difyMessages.value[botIdx]!.error = errorMsg
      difyMessages.value[botIdx]!.errorDetail = errorMsg
      difyMessages.value[botIdx]!.isStreaming = false
    }
  }
}

// 会话切换与管理
const handleSelectSession = async (sessId: string) => {
  isHistoryOpen.value = false
  const dbMsgs = await companionSessionStore.selectSession(sessId)
  difyClear()
  setConversationId(companionSessionStore.getConversationId(sessId))
  difyMessages.value = dbMessagesToChatMessages(dbMsgs, t('ai.noSelection'))
}

// 抽屉触发新建会话（惰性草稿已在 SessionHistoryDrawer 中写入 sessionStore，提问前不落库）
const handleSessionCreated = async (newSession: AiSession) => {
  isHistoryOpen.value = false
  if (!newSession.id) {
    const count = await resolveDraftCount()
    companionSessionStore.startNewDraft(
      lectureInfo.value.lectureId || 'global',
      lectureInfo.value.groupDir || 'general',
      `${t('ai.userSessionDefault')} ${count + 1}`
    )
  } else {
    companionSessionStore.activeSessionId.value = newSession.id
  }
  difyClear()
  setConversationId('')
}

const handleClearSessions = async () => {
  const lecId = lectureInfo.value.lectureId || 'global'
  try {
    await companionSessionStore.clearLecture(lecId)
    difyClear()
  } catch {
    // Error toast emitted by sessionStore; preserve current local messages
  }
}
</script>

<template>
  <div class="ai-assistant-root">
    <AiSidebarShell>
      <!-- 会话历史侧拉抽屉 (使用规范 current-session-id 属性) -->
      <SessionHistoryDrawer
        :is-open="isHistoryOpen"
        :lecture-id="lectureInfo.lectureId"
        :group-id="lectureInfo.groupDir"
        :current-session-id="activeSessionId"
        @update:is-open="isHistoryOpen = $event"
        @select-session="handleSelectSession"
        @create-session="handleSessionCreated"
        @clear-sessions="handleClearSessions"
      />

      <component
        :is="ConceptAuthorPanel"
        v-if="ConceptAuthorPanel && aiState.conceptAction"
        :task="aiState.conceptAction"
        @close="aiState.clearConceptTask()"
      />

      <!-- 主会话视口与输入面板 -->
      <ChatContainer
        v-else
        :lecture-id="lectureInfo.lectureId"
        :lecture-title="lectureInfo.title"
        :group-id="lectureInfo.groupId"
        :current-section="currentSection"
        :selected-text="aiState.quotedText"
        :messages="difyMessages"
        :is-streaming="isStreaming"
        :status-state="companionStatus"
        :source-label="sourceLabel"
        :can-upload="companionCaps.allowProxy && !isByokActive(byokConfig)"
        @close="aiState.closeSidebar()"
        @toggle-history="isHistoryOpen = !isHistoryOpen"
        @send="handleSend"
        @stop="handleStop"
        @retry="handleRetry"
        @upload-pptx="handleUploadPptx"
        @clear-selection="aiState.clearQuotedText()"
      />
    </AiSidebarShell>
  </div>
</template>

<style scoped>
.ai-assistant-root {
  position: relative;
  z-index: 65; /* 桌面端高于正文与局部导航、仍严格低于 VPNav (z-index: 100) */
}
@media (max-width: 1199px) {
  .ai-assistant-root {
    z-index: 200; /* 移动端全屏抽屉与唤出条置顶（FE-020） */
  }
}
</style>
