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

import { ref, watch } from 'vue'
import { aiState } from './aiState'
import { useLectureContext } from './useLectureContext'
import { useDifyChat, type DifyChatInputs } from './useDifyChat'
// AI 对话端点统一从 site.config.mts 取，避免与 useDifyChat 的默认值各写一份
import { API_ENDPOINTS } from '../../../site.config'
import {
  saveSession,
  saveMessages,
  getMessages,
  getSessions,
  clearAllSessionsForLecture,
  neonRepository,
  type AiSession
} from './neonRepository'
import { uploadAndMapPptx } from './pptxUploader'
import type { ChatMessage, SendPayload } from './types'

import AiSidebarShell from './AiSidebarShell.vue'
import ChatContainer from './ChatContainer.vue'
import SessionHistoryDrawer from './SessionHistoryDrawer.vue'

defineOptions({
  name: 'AiSidebar'
})

const { lectureInfo, currentSection } = useLectureContext()

// 历史会话抽屉开关
const isHistoryOpen = ref(false)

// 当前激活会话 ID 与会话列表追踪
const activeSessionId = ref<string>('')
const currentLectureSessionsList = ref<AiSession[]>([])

// 初始化 Dify 聊天引擎 (单一数据真源，实时响应式)
const {
  messages: difyMessages,
  isStreaming,
  sendMessage: difySend,
  stopStreaming,
  clearMessages: difyClear
} = useDifyChat({
  apiEndpoint: API_ENDPOINTS.aiChat,
  fallbackToMock: true
})

// 当前讲变更时，重载该讲历史会话
const reloadLectureSessions = async () => {
  const lecId = lectureInfo.value.lectureId || 'global'
  try {
    const sessions = await getSessions(lecId)
    currentLectureSessionsList.value = sessions
    if (sessions.length > 0) {
      activeSessionId.value = sessions[0].id
      const dbMsgs = await getMessages(sessions[0].id)
      difyClear()
      difyMessages.value = dbMsgs.map((m) => {
        const rawCtx = (m.selected_context || '').trim()
        const validCtx = rawCtx && rawCtx !== '无' ? rawCtx : undefined
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          selectedText: validCtx,
          createdAt: new Date(m.created_at).getTime()
        }
      })
    } else {
      // 惰性会话：未产生问答前绝对不预先落库创建空会话！
      activeSessionId.value = ''
      difyClear()
    }
  } catch {
    difyClear()
  }
}

watch(
  () => lectureInfo.value.lectureId,
  () => {
    reloadLectureSessions()
  },
  { immediate: true }
)

// 发送消息处理 (打通 Dify 实时打字流与 Neon 持久化)
const handleSend = async (payload: SendPayload) => {
  const rawSel = (payload.selectedText || aiState.quotedText || '').trim()
  const effectiveSelection = rawSel && rawSel !== '无' ? rawSel : ''
  const isHome = !lectureInfo.value.lectureId
  const lecName = isHome ? '全站讲义知识库' : `${lectureInfo.value.lectureId} · ${lectureInfo.value.title}`
  const grpName = isHome ? '全部课程组' : `${lectureInfo.value.groupId} · ${lectureInfo.value.groupTitle}`
  const secName = currentSection.value || (isHome ? '全站导览' : '全篇')
  const selName = effectiveSelection || '无'

  const dynamicInputs: DifyChatInputs = {
    current_lecture: lecName,
    group: grpName,
    selection: selName,
    outline: secName
  }

  // 惰性会话落库与智能命名：
  // 1. 若当前尚无会话，以用户首句提问直接创建有语义的专属会话；
  // 2. 若当前会话是已有会话，但标题仍为“会话 1”等无语义占位符，首次发问自动自愈为提问主题！
  const cleanSnippet = payload.query.replace(/[\r\n]+/g, ' ').trim().slice(0, 20)
  if (!activeSessionId.value) {
    const lecId = lectureInfo.value.lectureId || 'global'
    const newSessId = 'sess_' + Date.now().toString(36)
    activeSessionId.value = newSessId
    const sessionTitle = isHome
      ? `探讨: ${cleanSnippet || '全站导读'}`
      : `${lectureInfo.value.title || '讲义'}: ${cleanSnippet || '讲义问答'}`
    const createdSess = await saveSession({
      id: newSessId,
      lecture_id: lecId,
      group_id: lectureInfo.value.groupDir || 'general',
      title: sessionTitle,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    currentLectureSessionsList.value.unshift(createdSess)
  } else if (cleanSnippet) {
    const activeSess = currentLectureSessionsList.value.find((s) => s.id === activeSessionId.value)
    const isGeneric = !activeSess?.title || /^(会话\s*\d*|新会话|新探讨|全站探讨\s*\d*|探讨:\s*全站导读)$/i.test(activeSess.title.trim())
    if (isGeneric) {
      const refinedTitle = isHome
        ? `探讨: ${cleanSnippet}`
        : `${lectureInfo.value.title || '讲义'}: ${cleanSnippet}`
      if (activeSess) {
        activeSess.title = refinedTitle
      }
      void neonRepository.updateSessionTitle(activeSessionId.value, refinedTitle, lectureInfo.value.lectureId)
    }
  }

  const prevLen = difyMessages.value.length

  try {
    await difySend(payload.query, dynamicInputs)

    // 发送完成或中止后，持久化新追加的一轮问答至 Neon 数据库
    const newMsgs = difyMessages.value.slice(prevLen)
    if (newMsgs.length >= 2 && activeSessionId.value) {
      const userM = newMsgs[0]
      const botM = newMsgs[1]
      await saveMessages(activeSessionId.value, [
        {
          id: userM.id,
          session_id: activeSessionId.value,
          role: 'user',
          content: userM.content,
          selected_context: effectiveSelection || undefined,
          created_at: new Date(userM.createdAt).toISOString()
        },
        {
          id: botM.id,
          session_id: activeSessionId.value,
          role: 'assistant',
          content: botM.content,
          created_at: new Date(botM.createdAt).toISOString()
        }
      ])
    }

    // 提问发送完毕后，消费并清空划选引用，防止跨提问残留
    if (aiState.quotedText) {
      aiState.clearQuotedText()
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    difyMessages.value.push({
      id: 'err_' + Date.now(),
      role: 'assistant',
      content: `[通信提示] ${errorMsg || '请求未能完成，请检查网络或后端反向代理配置。'}`,
      createdAt: Date.now()
    })
  }
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
    content: `[课件导学] 已上传课件: ${file.name}，正在分析考点并映射精读讲次...`,
    createdAt: Date.now()
  })

  const botMsgId = 'msg_' + Date.now() + '_a'
  difyMessages.value.push({
    id: botMsgId,
    role: 'assistant',
    content: '正在解析 PPTX 课件与考点映射，请稍候...',
    createdAt: Date.now(),
    isStreaming: true
  })

  try {
    const res = await uploadAndMapPptx(file)
    const botIdx = difyMessages.value.findIndex((m) => m.id === botMsgId)
    if (botIdx !== -1) {
      difyMessages.value[botIdx].content = res.formattedMarkdown
      difyMessages.value[botIdx].isStreaming = false
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    const botIdx = difyMessages.value.findIndex((m) => m.id === botMsgId)
    if (botIdx !== -1) {
      difyMessages.value[botIdx].content = `[课件解析失败] ${errorMsg || '文件格式不支持或超时。'}`
      difyMessages.value[botIdx].isStreaming = false
    }
  }
}

// 会话切换与管理
const handleSelectSession = async (sessId: string) => {
  activeSessionId.value = sessId
  isHistoryOpen.value = false
  const dbMsgs = await getMessages(sessId)
  difyClear()
  difyMessages.value = dbMsgs.map((m) => {
    const rawCtx = (m.selected_context || '').trim()
    const validCtx = rawCtx && rawCtx !== '无' ? rawCtx : undefined
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      selectedText: validCtx,
      createdAt: new Date(m.created_at).getTime()
    }
  })
}

// 抽屉触发新建会话处理 (单源真理，绝不重复创建)
const handleSessionCreated = (newSession: AiSession) => {
  activeSessionId.value = newSession.id
  difyClear()
  isHistoryOpen.value = false
}

const handleClearSessions = async () => {
  const lecId = lectureInfo.value.lectureId || 'global'
  await clearAllSessionsForLecture(lecId)
  difyClear()
  await reloadLectureSessions()
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

      <!-- 主会话视口与输入面板 (直接绑定单一数据源 difyMessages) -->
      <ChatContainer
        :lecture-id="lectureInfo.lectureId"
        :lecture-title="lectureInfo.title"
        :group-id="lectureInfo.groupId"
        :current-section="currentSection"
        :selected-text="aiState.quotedText"
        :messages="difyMessages"
        :is-streaming="isStreaming"
        @close="aiState.closeSidebar()"
        @toggle-history="isHistoryOpen = !isHistoryOpen"
        @send="handleSend"
        @stop="handleStop"
        @upload-pptx="handleUploadPptx"
        @clear-selection="aiState.clearQuotedText()"
      />
    </AiSidebarShell>
  </div>
</template>

<style scoped>
.ai-assistant-root {
  position: relative;
  z-index: 15; /* 桌面端严格低于 VitePress 顶栏 (z-index: 20/30)，确保顶栏与下拉菜单完全在最上层 */
}
@media (max-width: 1199px) {
  .ai-assistant-root {
    z-index: 200; /* 移动端全屏抽屉浮层置顶 */
  }
}
</style>
