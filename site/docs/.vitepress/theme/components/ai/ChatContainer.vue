<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { ICONS } from './icons'
import { aiState } from './aiState'
import type { ChatMessage, ScopeType, SendPayload } from './types'
import ChatInput from './ChatInput.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'

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
  }>(),
  {
    lectureId: '',
    lectureTitle: '',
    groupId: '',
    currentSection: '',
    selectedText: '',
    messages: () => [],
    isStreaming: false,
    disabled: false
  }
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'toggleHistory'): void
  (e: 'send', payload: SendPayload): void
  (e: 'stop'): void
  (e: 'uploadPptx', file: File): void
  (e: 'clearSelection'): void
}>()

// 复制状态与定时器
const copiedMessageId = ref<string | null>(null)
let copyTimer: number | null = null

// 滚动吸底与手动翻滚检测
const messageListRef = ref<HTMLDivElement | null>(null)
const isUserScrolledUp = ref(false)

// 顶栏讲次徽章显示文本 (自适应单讲、课程组与全局状态)
const lectureBadgeText = computed(() => {
  if (props.lectureId) {
    return `${props.lectureId.toUpperCase()} · 伴读就绪`
  }
  if (props.groupId) {
    return `${props.groupId.toUpperCase()} 课程组 · 伴读就绪`
  }
  return '伴读工作台已就绪'
})

// 空白态辅助问候语 (自适应单讲与组别)
const emptyGreetingText = computed(() => {
  if (props.lectureId) {
    return '已连接本讲工程上下文，可随时划词或输入技术疑问'
  }
  if (props.groupId) {
    return `已连接 ${props.groupId.toUpperCase()} 课程组上下文，可随时探讨全组知识脉络`
  }
  return '已连接全站讲义知识库，可随时输入技术疑问或上传课件'
})

// 过滤小节标题噪声前缀，防止折行与排版错位 (Issue 4)
const cleanSectionTitle = computed(() => {
  if (!props.currentSection) return ''
  return props.currentSection
    .replace(/^(避坑警示|工程实战避坑|实战避坑|避坑指南|开篇|引子|小结|本讲总结|随堂测验|随堂自测)[：:]\s*/, '')
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
    case 'group': return '课程组'
    case 'all': return '全站'
    case 'selection': return '选区'
    default: return ''
  }
}

onMounted(() => {
  scrollToBottom(false)
  const el = messageListRef.value
  if (el) {
    el.addEventListener('scroll', checkScrollPosition, { passive: true })
  }
})

onUnmounted(() => {
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
        <div class="lecture-badge">
          <span class="badge-icon" v-html="ICONS.chipCore"></span>
          <span class="pulse-indicator"></span>
          <span class="badge-text">{{ lectureBadgeText }}</span>
        </div>
      </div>

      <div class="header-right">
        <!-- 历史会话切换按钮 -->
        <button
          type="button"
          class="header-action-btn"
          title="历史会话"
          aria-label="历史会话"
          @click="emit('toggleHistory')"
        >
          <span class="btn-svg" v-html="ICONS.history"></span>
        </button>

        <!-- 关闭侧边栏按钮 -->
        <button
          type="button"
          class="header-action-btn"
          title="收起伴读"
          aria-label="收起伴读"
          @click="emit('close')"
        >
          <span class="btn-svg" v-html="ICONS.close"></span>
        </button>
      </div>
    </header>

    <!-- 2. 消息展示区 (Message List) -->
    <div ref="messageListRef" class="chat-messages-area">
      <!-- 极简初始空白态 (Clean Empty State) -->
      <div v-if="!messages || messages.length === 0" class="clean-empty-state">
        <div class="core-vector-badge">
          <span class="badge-vector" v-html="ICONS.chipCore"></span>
        </div>
        <div class="empty-status-line">
          <span class="status-dot"></span>
          <span class="status-name">{{ lectureBadgeText }}</span>
        </div>
        <p class="empty-subtle-greeting">
          {{ emptyGreetingText }}
        </p>
        <div v-if="cleanSectionTitle" class="empty-anchor-hint" :title="`当前阅读小节: ${currentSection}`">
          <span class="anchor-tag">当前小节</span>
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
              <div v-if="msg.selectedText && msg.selectedText !== '无' && msg.selectedText.trim().length > 0" class="message-quote-box">
                <div class="quote-tag">
                  <span class="quote-svg" v-html="ICONS.scopeSelection"></span>
                  <span>划词引用</span>
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
                <span class="assistant-name">AI 伴读</span>
              </div>

              <div class="assistant-body">
                <MarkdownRenderer :content="msg.content" />

                <!-- 流式打字中微脉冲动画 -->
                <div v-if="msg.isStreaming && !msg.content" class="typing-pulse-bar">
                  <span class="pulse-dot"></span>
                  <span class="pulse-dot"></span>
                  <span class="pulse-dot"></span>
                </div>

                <!-- 异常状态指示 (点 2: 错误提示) -->
                <div v-if="msg.error" class="ai-msg-error-alert">
                  <span class="err-badge">通信中断</span>
                  <span class="err-text">{{ msg.error }}</span>
                </div>
              </div>

              <!-- 消息底部操作条 -->
              <div class="assistant-footer">
                <button
                  type="button"
                  class="msg-tool-btn"
                  :title="copiedMessageId === msg.id ? '已复制' : '复制回答'"
                  @click="handleCopyMessage(msg)"
                >
                  <span class="tool-svg" v-html="copiedMessageId === msg.id ? ICONS.check : ICONS.copy"></span>
                  <span class="tool-text">{{ copiedMessageId === msg.id ? '已复制' : '复制' }}</span>
                </button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- 悬浮回到最底按钮 (严格限定在伴读展开、消息多于2条且上滑时在内部呈现，绝不漏出屏幕) -->
      <button
        v-if="aiState.isOpen && isUserScrolledUp && messages && messages.length > 2"
        type="button"
        class="floating-scroll-bottom-btn"
        title="回到底部"
        @click="scrollToBottom(true)"
      >
        <span class="scroll-icon" v-html="ICONS.chevronDown"></span>
      </button>
    </div>

    <!-- 3. 输入控制区 (Input Bar) -->
    <ChatInput
      :lecture-id="lectureId"
      :group-id="groupId"
      :selected-text="selectedText"
      :is-streaming="isStreaming"
      :disabled="disabled"
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
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
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
  background: var(--vp-c-bg-soft);
  border-bottom: 1px solid var(--vp-c-divider);
  flex-shrink: 0;
  user-select: none;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lecture-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  font-size: 11.5px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.badge-icon {
  display: inline-flex;
  color: var(--vp-c-brand-1);
}

.badge-icon :deep(svg) {
  width: 13px;
  height: 13px;
}

.pulse-indicator {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.6);
  animation: pulse-glow 2s infinite ease-in-out;
}

@keyframes pulse-glow {
  0%, 100% {
    transform: scale(1);
    opacity: 0.8;
  }
  50% {
    transform: scale(1.25);
    opacity: 1;
    box-shadow: 0 0 10px rgba(16, 185, 129, 0.9);
  }
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
  border-radius: 5px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s ease;
}

.header-action-btn:hover {
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
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
  border-radius: 14px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-brand-1);
  margin-bottom: 14px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
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
  color: var(--vp-c-text-1);
  margin-bottom: 6px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
}

.empty-subtle-greeting {
  font-size: 12.5px;
  color: var(--vp-c-text-3);
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
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  font-size: 11px;
  box-sizing: border-box;
  overflow: hidden;
}

.anchor-tag {
  color: var(--vp-c-text-3);
  white-space: nowrap;
  flex-shrink: 0;
  font-weight: 500;
}

.anchor-name {
  color: var(--vp-c-brand-1);
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
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

.user-bubble {
  padding: 8px 12px;
  background: var(--vp-c-brand-soft, rgba(62, 99, 221, 0.12));
  border: 1px solid var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
  border-radius: 10px 10px 2px 10px;
  font-size: 13.5px !important; /* 用户本人提问字体恒定保持小巧紧凑，绝不随拉伸放大 */
  line-height: 1.5 !important;
  word-break: break-word;
  white-space: pre-wrap;
}

/* 助手卡片 */
.assistant-content-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  padding: 10px 12px;
  gap: 6px;
}

.assistant-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  border-bottom: 1px dashed var(--vp-c-divider);
  padding-bottom: 6px;
}

.assistant-icon {
  display: inline-flex;
  color: var(--vp-c-brand-1);
}

.assistant-icon :deep(svg) {
  width: 13px;
  height: 13px;
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
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.25);
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}
.ai-msg-error-alert .err-tag {
  padding: 1px 6px;
  border-radius: 4px;
  background: #ef4444;
  color: #fff;
  font-weight: 600;
  font-size: 10px;
  flex-shrink: 0;
}
.ai-msg-error-alert .err-text {
  color: #ef4444;
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
  background: var(--vp-c-brand-1);
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
  border-top: 1px dashed var(--vp-c-divider);
}

.msg-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--vp-c-text-3);
  cursor: pointer;
  transition: all 0.15s ease;
}

.msg-tool-btn:hover {
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
}

.tool-svg :deep(svg) {
  width: 12px;
  height: 12px;
}

/* 浮动滚到底部快捷键 */
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
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-border);
  box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.2s ease;
  z-index: 10;
}

.floating-scroll-bottom-btn:hover {
  background: var(--vp-c-bg);
  color: var(--vp-c-brand-1);
  border-color: var(--vp-c-brand-1);
}

.scroll-icon :deep(svg) {
  width: 14px;
  height: 14px;
}
</style>
