<script setup lang="ts">
import { defineAsyncComponent, ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import { ICONS } from './icons'
import { aiState } from './aiState'
import { BYOK_CHANGED_EVENT, extractEndpointHost, readByokConfig } from './byokClient'
import type { ChatMessage, ScopeType, SendPayload } from './types'
import ChatInput from './ChatInput.vue'

const MarkdownRenderer = defineAsyncComponent(() => import('./MarkdownRenderer.vue'))

const { t } = useT()

const props = withDefaults(
  defineProps<{
    lectureId?: string
    lectureTitle?: string
    groupId?: string
    currentSection?: string
    selectedText?: string
    messages?: ChatMessage[]
    isStreaming?: boolean
    disabled?: boolean
    canUpload?: boolean
    statusState?:
      | 'checking'
      | 'ok'
      | 'unconfigured'
      | 'unavailable'
      | 'rate-limited'
      | 'byok-unverified'
      | 'byok-ok'
      | 'byok-failed'
      | 'mock'
    sourceLabel?: string
  }>(),
  {
    lectureId: '',
    lectureTitle: '',
    groupId: '',
    currentSection: '',
    selectedText: '',
    messages: () => [],
    isStreaming: false,
    disabled: false,
    canUpload: false,
    statusState: 'checking',
    sourceLabel: ''
  }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'toggleHistory'): void
  (e: 'send', payload: SendPayload): void
  (e: 'stop'): void
  (e: 'retry'): void
  (e: 'uploadPptx', file: File): void
  (e: 'clearSelection'): void
}>()

// 复制状态与定时器
const copiedMessageId = ref<string | null>(null)
let copyTimer: number | null = null

// 滚动吸底与手动翻滚检测
const messageListRef = ref<HTMLDivElement | null>(null)
const isUserScrolledUp = ref(false)

const statusGlyph = computed<string>(() => {
  switch (props.statusState) {
    case 'ok':
    case 'byok-ok':
      return ICONS.statusOk
    case 'unconfigured':
      return ICONS.statusUnconfigured
    case 'rate-limited':
      return ICONS.statusRateLimited
    case 'unavailable':
    case 'byok-failed':
      return ICONS.statusUnavailable
    default:
      return ICONS.statusUnverified
  }
})

// S6Y F6 (audit-spec #16, spec board 14): the header names the companion, the lecture and where requests go
// (服务端代理 / 自带模型：host); one state line under it says how that route is doing. The state is said once only.
const byokHost = ref('')
function refreshByokHost(): void {
  byokHost.value = extractEndpointHost(readByokConfig().baseUrl) || '-'
}

const routeLabel = computed<string>(() => {
  const st = props.statusState
  if (st === 'byok-ok' || st === 'byok-failed' || st === 'byok-unverified') return t('ai.sourceByok', { host: byokHost.value })
  if (st === 'mock') return t('ai.sourceMock')
  return t('ai.routeProxy')
})

/** Backend states in which nothing can be asked of it: quick actions are disabled with this line as the reason. */
const backendOff = computed(() => props.statusState === 'unavailable' || props.statusState === 'unconfigured')

const stateText = computed<string>(() => {
  switch (props.statusState) {
    case 'ok':
    case 'byok-ok':
    case 'mock':
      return t('ai.stateConnected')
    case 'unavailable':
      return t('ai.stateOffline')
    case 'unconfigured':
      return t('ai.stateUnconfigured')
    case 'rate-limited':
      return props.sourceLabel || t('ai.sourceChecking')
    case 'byok-unverified':
      return t('ai.stateByokUnverified')
    case 'byok-failed':
      return t('ai.stateByokFailed')
    default:
      return t('ai.sourceChecking')
  }
})

const stateTone = computed(() => {
  const st = props.statusState
  if (st === 'ok' || st === 'byok-ok' || st === 'mock') return 'on'
  if (st === 'checking' || st === 'byok-unverified') return 'wait'
  return 'off'
})

const quickReason = computed(() => (backendOff.value ? t('ai.quickOffReason', { state: stateText.value }) : ''))

// 空白态辅助问候语 (真实反映在线/BYOK/离线状态)
const emptyGreetingText = computed(() => {
  if (props.statusState === 'unavailable' || props.statusState === 'unconfigured') {
    return t('ai.emptyOffline')
  }
  return t('ai.emptyLecture')
})

// 过滤小节标题噪声前缀，防止折行与排版错位（Unicode 转义避免硬编码中文）
const cleanSectionTitle = computed(() => {
  if (!props.currentSection) return ''
  return props.currentSection
    .replace(
      /^(\u907f\u5751\u8b66\u793a|\u5de5\u7a0b\u5b9e\u6218\u907f\u5751|\u5b9e\u6218\u907f\u5751|\u907f\u5751\u6307\u5357|\u5f00\u7bc7|\u5f15\u5b50|\u5c0f\u7ed3|\u672c\u8bb2\u603b\u7ed3|\u968f\u5802\u6d4b\u9a8c|\u968f\u5802\u81ea\u6d4b)[\uff1a:]\s*/,
      '',
    )
    .trim()
})

// 滚动位置监测
function checkScrollPosition() {
  const el = messageListRef.value
  if (!el) return
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  // 离底端超过 48px 则认定读者主动上滑查看历史
  isUserScrolledUp.value = distanceFromBottom > 48
}

// 平滑滚至底部
function scrollToBottom(smooth = true) {
  if (typeof window === 'undefined') return
  const el = messageListRef.value
  if (!el) return

  el.scrollTo({
    top: el.scrollHeight,
    behavior: smooth ? 'smooth' : 'auto'
  })
}

// 自动滚动吸底
function handleAutoScroll() {
  if (!isUserScrolledUp.value) {
    nextTick(() => {
      scrollToBottom(true)
    })
  }
}

// 监听消息变化（深度监听单条消息增量打字）
watch(
  () => props.messages,
  () => {
    handleAutoScroll()
  },
  { deep: true }
)

// 流式传输中持续吸底
watch(
  () => props.isStreaming,
  (streaming) => {
    if (streaming && !isUserScrolledUp.value) {
      handleAutoScroll()
    }
  }
)

// 复制代码块与消息内容
function handleCopyMessage(msg: ChatMessage) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return

  navigator.clipboard.writeText(msg.content).then(() => {
    copiedMessageId.value = msg.id
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copiedMessageId.value = null
    }, 2000)
  })
}

// 范围标签格式化
function getScopeBadge(scope?: ScopeType): string {
  switch (scope) {
    case 'group': return t('ai.scopeGroup')
    case 'all': return t('ai.scopeAll')
    case 'selection': return t('ai.scopeSelection')
    default: return ''
  }
}

onMounted(() => {
  scrollToBottom(false)
  refreshByokHost()
  if (typeof window !== 'undefined') window.addEventListener(BYOK_CHANGED_EVENT, refreshByokHost)
  const el = messageListRef.value
  if (el) {
    el.addEventListener('scroll', checkScrollPosition, { passive: true })
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener(BYOK_CHANGED_EVENT, refreshByokHost)
  const el = messageListRef.value
  if (el) {
    el.removeEventListener('scroll', checkScrollPosition)
  }
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div class="chat-container">
    <!-- 1. 顶部栏 (Header) -->
    <header class="chat-header">
      <div class="header-left">
        <!-- S6Y F6 (spec board 14 .ai-head): 伴读 · lecture · where the requests go -->
        <h4 class="chat-title">{{ t('ai.title') }}</h4>
        <span v-if="lectureId || groupId" class="lecture-badge">{{ (lectureId || groupId).toUpperCase() }}</span>
        <span
          class="ai-src-badge"
          :data-ai-status="statusState || 'checking'"
          data-ai-source
        >
          <span class="ai-status-glyph" aria-hidden="true" v-html="statusGlyph"></span>
          <span data-ai-route>{{ routeLabel }}</span>
        </span>
      </div>

      <div class="header-right">
        <!-- 历史会话切换按钮 -->
        <button
          type="button"
          class="header-action-btn"
          :title="t('ai.historyTitle')"
          :aria-label="t('ai.historyTitle')"
          @click="emit('toggleHistory')"
        >
          <span class="btn-svg" v-html="ICONS.history"></span>
        </button>

        <!-- 关闭侧边栏按钮 -->
        <button
          type="button"
          class="header-action-btn"
          :title="t('ai.closeTitle')"
          :aria-label="t('ai.closeTitle')"
          @click="emit('close')"
        >
          <span class="btn-svg" v-html="ICONS.close"></span>
        </button>
      </div>
    </header>
    <!-- S6Y F6 (spec board 14 .state): the one line that says how the route is doing -->
    <div class="chat-state" :class="`is-${stateTone}`" role="status" data-ai-state><i aria-hidden="true"></i>{{ stateText }}</div>

    <!-- 2. 消息展示区 (Message List, FE-020 aria-live) -->
    <div ref="messageListRef" class="chat-messages-area" aria-live="polite" aria-atomic="false">
      <!-- 极简初始空白态 (Clean Empty State) -->
      <div v-if="!messages || messages.length === 0" class="clean-empty-state">
        <div class="core-vector-badge">
          <span class="badge-vector" v-html="ICONS.chipCore"></span>
        </div>
        <p class="empty-subtle-greeting">
          {{ emptyGreetingText }}
        </p>
        <div v-if="cleanSectionTitle" class="empty-anchor-hint" :title="t('ai.sectionPrefixTitle', { section: currentSection })">
          <span class="anchor-tag">{{ t('ai.currentSectionTag') }}</span>
          <span class="anchor-name">{{ cleanSectionTitle }}</span>
        </div>
      </div>

      <!-- 消息列表渲染 -->
      <div v-else class="messages-flow">
        <div
          v-for="msg in messages"
          :key="msg.id"
          class="message-row"
          :class="`is-${msg.role}`"
        >
          <!-- 用户消息 -->
          <template v-if="msg.role === 'user'">
            <div class="user-bubble-wrapper">
              <!-- 划选上下文引用卡片 (严格剔除“无”与空选区，无实质划词绝对不渲染卡片) -->
              <div v-if="msg.selectedText && msg.selectedText !== t('ai.noSelection') && msg.selectedText !== '\u65e0' && msg.selectedText.trim().length > 0" class="message-quote-box">
                <div class="quote-tag">
                  <span class="quote-svg" v-html="ICONS.scopeSelection"></span>
                  <span>{{ t('ai.quotedLabel') }}</span>
                </div>
                <div class="quote-body">{{ msg.selectedText }}</div>
              </div>

              <!-- 范围标签标记 -->
              <div v-if="msg.scope && msg.scope !== 'lecture'" class="message-scope-tag">
                [{{ getScopeBadge(msg.scope) }}]
              </div>

              <!-- 提问正文 -->
              <div class="user-bubble">
                {{ msg.content }}
              </div>
            </div>
          </template>

          <!-- AI 伴读回答 -->
          <template v-else-if="msg.role === 'assistant'">
            <div class="assistant-content-wrapper">
              <div class="assistant-header">
                <span class="assistant-icon" v-html="ICONS.chipCore"></span>
                <span class="assistant-name">{{ t('ai.assistantName') }}</span>
              </div>

              <!-- 工具调用进度条（原生 SSE tool_call 与 BYOK 浏览器工具循环共用；仅展示工具名与状态，绝不显示参数或返回值） -->
              <div v-if="msg.toolCalls && msg.toolCalls.length > 0" class="ai-tool-calls" data-ai-tool-calls>
                <span
                  v-for="tc in msg.toolCalls"
                  :key="tc.id"
                  class="ai-tool-pill"
                  :data-ai-tool-call="tc.name"
                  :data-ai-tool-state="tc.state"
                >
                  <span class="ai-tool-mark" :data-state="tc.state" aria-hidden="true"></span>
                  <span class="ai-tool-name">{{
                    tc.state === 'running'
                      ? t('ai.toolCallRunning', { name: tc.name })
                      : tc.state === 'error'
                        ? t('ai.toolCallError', { name: tc.name })
                        : t('ai.toolCallDone', { name: tc.name })
                  }}</span>
                </span>
              </div>

              <div class="assistant-body">
                <MarkdownRenderer
                  v-if="msg.content"
                  :content="msg.content"
                  :is-streaming="msg.isStreaming"
                />

                <!-- 流式打字中微脉冲动画 -->
                <div v-if="msg.isStreaming && !msg.content && !(msg.toolCalls && msg.toolCalls.length > 0)" class="typing-pulse-bar">
                  <span class="pulse-dot"></span>
                  <span class="pulse-dot"></span>
                  <span class="pulse-dot"></span>
                </div>

                <!-- 不完整或异常提示 (D-07 / FE-003，附带重试入口，绝不存为完整回答) -->
                <div
                  v-if="msg.isIncomplete || msg.isError || msg.error"
                  class="ai-msg-error-card"
                  :class="{ 'is-incomplete': Boolean(msg.isIncomplete) }"
                  :data-ai-incomplete="msg.isIncomplete ? '1' : undefined"
                  data-ai-error-bubble
                >
                  <p class="err-text">
                    {{
                      msg.isIncomplete
                        ? (msg.errorDetail && msg.errorDetail !== t('ai.incompleteBanner')
                            ? `${t('ai.incompleteBanner')} (${msg.errorDetail})`
                            : t('ai.incompleteBanner'))
                        : t('ai.errorBubble', { detail: msg.errorDetail || msg.error || t('ai.networkError') })
                    }}
                  </p>
                  <button
                    type="button"
                    class="ai-retry-btn"
                    data-ai-retry
                    :disabled="isStreaming"
                    @click="emit('retry')"
                  >
                    {{ t('ai.retry') }}
                  </button>
                </div>
              </div>

              <!-- 消息底部操作条 -->
              <div v-if="!msg.isError && !msg.isIncomplete && msg.content" class="assistant-footer">
                <button
                  type="button"
                  class="msg-tool-btn"
                  :title="copiedMessageId === msg.id ? t('ai.copied') : t('ai.copyAnswer')"
                  @click="handleCopyMessage(msg)"
                >
                  <span class="tool-svg" v-html="copiedMessageId === msg.id ? ICONS.check : ICONS.copy"></span>
                  <span class="tool-text">{{ copiedMessageId === msg.id ? t('ai.copied') : t('ai.copy') }}</span>
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 悬浮回到最底按钮 -->
      <button
        v-if="aiState.isOpen && isUserScrolledUp && messages && messages.length > 2"
        type="button"
        class="floating-scroll-bottom-btn"
        :title="t('ai.scrollBottomTitle')"
        @click="scrollToBottom(true)"
      >
        <span class="scroll-icon" v-html="ICONS.chevronDown"></span>
      </button>
    </div>

    <!-- 3. 输入控制区 (Input Bar) -->
    <p v-if="quickReason" class="chat-quick-reason" data-ai-quick-reason>{{ quickReason }}</p>
    <ChatInput
      :lecture-id="lectureId"
      :group-id="groupId"
      :selected-text="selectedText"
      :is-streaming="isStreaming"
      :disabled="disabled"
      :can-upload="canUpload"
      :quick-disabled-reason="quickReason"
      @send="emit('send', $event)"
      @stop="emit('stop')"
      @upload-pptx="emit('uploadPptx', $event)"
      @clear-selection="emit('clearSelection')"
    />
  </div>
</template>

<style scoped>
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--lec-bg);
  color: var(--lec-text);
  overflow: hidden;
  box-sizing: border-box;
}

/* 顶部栏 */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 46px;
  padding: 0 12px;
  background: var(--lec-surface);
  border-bottom: 1px solid var(--lec-border);
  flex-shrink: 0;
  user-select: none;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* S6Y F6: spec board 14 .ai-head h4 (14px) and .ctx (mono 11.5px, muted) */
.chat-title {
  margin: 0;
  font-family: var(--lec-font-heading);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  color: var(--lec-text);
}

.lecture-badge {
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
  font-weight: 400;
  color: var(--lec-text-muted);
}

/* spec board 14 .state: one line under the header, danger tint when the route is down */
.chat-state {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12.5px;
  line-height: 1.5;
  border-bottom: 1px solid var(--lec-border);
  color: var(--lec-text-muted);
  flex-shrink: 0;
}
.chat-state i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  border: var(--lec-line-mid) solid currentColor;
}
.chat-state.is-on {
  color: var(--lec-done-text);
}
.chat-state.is-on i {
  background: var(--lec-done);
  border-color: var(--lec-done);
}
.chat-state.is-off {
  color: var(--lec-danger);
  background: var(--lec-danger-tint);
}

.chat-quick-reason {
  margin: 0;
  padding: 6px 12px 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--lec-text-muted);
}

.ai-src-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  border: 1px solid var(--lec-border);
  font-size: 11px;
  color: var(--lec-text-muted);
  white-space: nowrap;
}
.ai-src-badge[data-ai-status='ok'],
.ai-src-badge[data-ai-status='byok-ok'] {
  color: var(--lec-done-text);
  border-color: var(--lec-done);
  background: var(--lec-surface);
}
.ai-src-badge[data-ai-status='byok-unverified'] {
  color: var(--lec-accent);
  border-color: var(--lec-accent);
  background: var(--lec-accent-tint);
}
.ai-src-badge[data-ai-status='rate-limited'] {
  color: var(--lec-warning);
  border-color: var(--lec-warning);
  background: var(--lec-warning-tint);
}
.ai-src-badge[data-ai-status='unavailable'],
.ai-src-badge[data-ai-status='byok-failed'] {
  color: var(--lec-danger);
  border-color: var(--lec-danger);
  background: var(--lec-danger-tint);
}
.ai-src-badge[data-ai-status='unconfigured'] {
  color: var(--lec-text-muted);
  border-style: dashed;
  border-color: var(--lec-border);
}

.ai-status-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ai-msg-error-card {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: var(--lec-radius-2);
  border: 1px solid var(--lec-danger);
  background: var(--lec-danger-tint);
  color: var(--lec-text);
  font-size: 12.5px;
  line-height: 1.5;
}
.ai-msg-error-card.is-incomplete {
  border-color: var(--lec-warning);
  background: var(--lec-warning-tint);
}
.ai-msg-error-card .err-text {
  margin: 0 0 8px;
  color: var(--lec-danger);
}
.ai-msg-error-card.is-incomplete .err-text {
  color: var(--lec-text);
}
.ai-retry-btn {
  padding: 3px 10px;
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-border);
  background: var(--lec-bg);
  color: var(--lec-text);
  font-size: 12px;
  cursor: pointer;
}
.ai-retry-btn:hover:not(:disabled) {
  border-color: var(--lec-accent);
  color: var(--lec-accent);
}

.header-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.header-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--lec-radius-1);
  background: transparent;
  border: 1px solid transparent;
  color: var(--lec-text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.header-action-btn:hover {
  background: var(--lec-bg);
  color: var(--lec-text);
  border-color: var(--lec-border);
}

.btn-svg :deep(svg) {
  width: 14px;
  height: 14px;
}

/* 消息内容滚轴区 */
.chat-messages-area {
  position: relative;
  flex: 1;
  overflow-y: auto;
  padding: 16px 14px;
  scrollbar-width: thin;
}

/* 极简空白态 */
.clean-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 280px;
  height: 100%;
  text-align: center;
  padding: 24px 16px;
  user-select: none;
}

.core-vector-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  border: 1px solid var(--lec-border);
  color: var(--lec-accent);
  margin-bottom: 14px;
}

.badge-vector :deep(svg) {
  width: 28px;
  height: 28px;
}

.empty-status-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--lec-text);
  margin-bottom: 6px;
}

.empty-subtle-greeting {
  font-size: 12.5px;
  color: var(--lec-text-muted);
  max-width: 240px;
  line-height: 1.5;
  margin: 0 0 14px;
}

.empty-anchor-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 88%;
  padding: 4px 10px;
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  border: 1px solid var(--lec-border);
  font-size: 11px;
  box-sizing: border-box;
  overflow: hidden;
}

.anchor-tag {
  color: var(--lec-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  font-weight: 500;
}

.anchor-name {
  color: var(--lec-accent);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 消息流流向 */
.messages-flow {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.message-row {
  display: flex;
  width: 100%;
}

.message-row.is-user {
  justify-content: flex-end;
}

.message-row.is-assistant {
  justify-content: flex-start;
}

/* 用户气泡 */
.user-bubble-wrapper {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: 86%;
  gap: 4px;
}

.message-quote-box {
  background: var(--vp-c-bg-soft);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 5px 5px 0;
  padding: 4px 8px;
  font-size: 11.5px;
  text-align: left;
  max-width: 100%;
}

.quote-tag {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--vp-c-brand-1);
  font-weight: 600;
  margin-bottom: 2px;
}

.quote-svg :deep(svg) {
  width: 11px;
  height: 11px;
}

.quote-body {
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono, monospace);
  line-height: 1.35;
  word-break: break-all;
}

.message-scope-tag {
  font-size: 10.5px;
  color: var(--lec-accent);
  font-weight: 500;
}

.user-bubble {
  padding: 8px 12px;
  background: var(--lec-accent-tint);
  border: 1px solid var(--lec-accent);
  color: var(--lec-text);
  border-radius: var(--lec-radius-2);
  font-size: 13.5px !important;
  line-height: 1.5 !important;
  word-break: break-word;
  white-space: pre-wrap;
}

.assistant-content-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
  background: var(--lec-surface);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  padding: 10px 12px;
  gap: 6px;
}

.assistant-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--lec-text-muted);
  border-bottom: 1px dashed var(--lec-border);
  padding-bottom: 6px;
}

.assistant-icon {
  display: inline-flex;
  color: var(--lec-accent);
}

.assistant-icon :deep(svg) {
  width: 13px;
  height: 13px;
}

.ai-tool-calls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 2px 0;
}

.ai-tool-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: 999px;
  background: var(--lec-bg);
  color: var(--lec-text-muted);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: nowrap;
}

.ai-tool-pill[data-ai-tool-state='running'] {
  border-color: var(--lec-accent);
  color: var(--lec-text);
}

.ai-tool-pill[data-ai-tool-state='error'] {
  border-color: var(--lec-danger);
  color: var(--lec-danger);
}

.ai-tool-mark {
  display: inline-block;
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: var(--lec-status-radius);
  background: var(--lec-text-muted);
}

.ai-tool-mark[data-state='running'] {
  background: var(--lec-accent);
  animation: ai-tool-pulse 1.1s ease-in-out infinite;
}

.ai-tool-mark[data-state='done'] {
  background: var(--lec-done);
}

.ai-tool-mark[data-state='error'] {
  background: var(--lec-danger);
}

[data-lec-theme='datasheet'] .ai-tool-pill {
  border-radius: var(--lec-radius-1);
  font-family: var(--lec-font-mono);
  font-size: 11px;
}

@keyframes ai-tool-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.assistant-body {
  position: relative;
  min-height: 20px;
  font-size: var(--ai-chat-font-size, 13.5px);
  line-height: var(--ai-chat-line-height, 1.65);
  transition: font-size 0.28s ease, line-height 0.28s ease;
}

.ai-msg-error-alert {
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--lec-radius-1);
  background: var(--lec-danger-tint);
  border: 1px solid var(--lec-danger);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}
.ai-msg-error-alert .err-tag {
  padding: 1px 6px;
  border-radius: var(--lec-radius-1);
  background: var(--lec-danger);
  color: var(--lec-on-accent);
  font-weight: 600;
  font-size: 10px;
  flex-shrink: 0;
}
.ai-msg-error-alert .err-text {
  color: var(--lec-danger);
  word-break: break-all;
}

.typing-pulse-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
}

.pulse-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--lec-accent);
  animation: dot-bounce 1.4s infinite ease-in-out both;
}

.pulse-dot:nth-child(1) { animation-delay: -0.32s; }
.pulse-dot:nth-child(2) { animation-delay: -0.16s; }

@keyframes dot-bounce {
  0%, 80%, 100% {
    transform: scale(0.6);
    opacity: 0.4;
  }
  40% {
    transform: scale(1.15);
    opacity: 1;
  }
}

.assistant-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-top: 4px;
  border-top: 1px dashed var(--lec-border);
}

.msg-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--lec-radius-1);
  padding: 2px 6px;
  font-size: 11px;
  color: var(--lec-text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.msg-tool-btn:hover {
  background: var(--lec-bg);
  color: var(--lec-text);
  border-color: var(--lec-border);
}

.tool-svg :deep(svg) {
  width: 12px;
  height: 12px;
}

.floating-scroll-bottom-btn {
  position: absolute;
  right: 18px;
  bottom: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--lec-surface);
  border: 1px solid var(--lec-border);
  color: var(--lec-text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
  z-index: 10;
}

.floating-scroll-bottom-btn:hover {
  background: var(--lec-bg);
  color: var(--lec-accent);
  border-color: var(--lec-accent);
}

.scroll-icon :deep(svg) {
  width: 14px;
  height: 14px;
}
</style>
