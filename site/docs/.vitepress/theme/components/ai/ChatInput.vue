<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { ICONS } from './icons'
import type { ScopeType, SendPayload, ScopeChipItem } from './types'

const props = withDefaults(
  defineProps<{
    lectureId?: string
    groupId?: string
    selectedText?: string
    isStreaming?: boolean
    disabled?: boolean
    placeholder?: string
  }>(),
  {
    lectureId: '',
    groupId: '',
    selectedText: '',
    isStreaming: false,
    disabled: false,
    placeholder: '输入你的问题... (Enter 发送)'
  }
)

const emit = defineEmits<{
  (e: 'send', payload: SendPayload): void
  (e: 'stop'): void
  (e: 'uploadPptx', file: File): void
  (e: 'clearSelection'): void
  (e: 'update:scope', scope: ScopeType): void
}>()

const inputText = ref('')
const currentScope = ref<ScopeType>('lecture')
const isFocused = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)

// 自适应工程检索范围 Chips (自适应单讲、课程组与选区，彻底消除超宽显示不全)
const scopeChips = computed<ScopeChipItem[]>(() => {
  const hasSelection = Boolean(props.selectedText && props.selectedText.trim().length > 0)
  const chips: ScopeChipItem[] = []

  // 1. 单讲范围 (仅在具体讲义页面提供)
  if (props.lectureId) {
    chips.push({
      id: 'lecture',
      label: '本讲',
      icon: ICONS.scopeLecture,
      description: `仅检索当前讲义上下文 (${props.lectureId.toUpperCase()})`
    })
  }

  // 2. 课程组范围
  if (props.groupId) {
    chips.push({
      id: 'group',
      label: props.lectureId ? '本组' : `本课程组 (${props.groupId.toUpperCase()})`,
      icon: ICONS.scopeGroup,
      description: `检索所属课程组全部模块 (${props.groupId.toUpperCase()})`
    })
  }

  // 3. 全站讲义
  chips.push({
    id: 'all',
    label: props.lectureId ? '全站' : '全站讲义',
    icon: ICONS.scopeAll,
    description: '检索全站全部讲义知识库'
  })

  // 4. 选中文本 (仅当存在高亮选区时显式呈现)
  if (hasSelection) {
    chips.push({
      id: 'selection',
      label: '选区',
      icon: ICONS.scopeSelection,
      description: '精准针对正文划选片段提问'
    })
  }

  return chips
})

// 智能监听上下文环境，自适应激活默认范围
watch(
  [() => props.lectureId, () => props.groupId, () => props.selectedText],
  ([lecId, grpId, selText]) => {
    if (selText && selText.trim().length > 0) {
      currentScope.value = 'selection'
      emit('update:scope', 'selection')
    } else if (lecId) {
      currentScope.value = 'lecture'
      emit('update:scope', 'lecture')
    } else if (grpId) {
      currentScope.value = 'group'
      emit('update:scope', 'group')
    } else {
      currentScope.value = 'all'
      emit('update:scope', 'all')
    }
  },
  { immediate: true }
)

// 选择范围切换
function selectScope(chip: ScopeChipItem) {
  if (chip.disabled) return
  currentScope.value = chip.id
  emit('update:scope', chip.id)
}

// 移除划词引用
function handleClearSelection() {
  emit('clearSelection')
  if (currentScope.value === 'selection') {
    currentScope.value = 'lecture'
    emit('update:scope', 'lecture')
  }
}

// 自适应高度调整
function adjustTextareaHeight() {
  if (typeof window === 'undefined') return
  const el = textareaRef.value
  if (!el) return

  el.style.height = 'auto'
  const targetHeight = Math.min(Math.max(el.scrollHeight, 40), 160)
  el.style.height = `${targetHeight}px`
}

watch(inputText, () => {
  nextTick(adjustTextareaHeight)
})

// 快捷键监听：Enter 发送，Shift+Enter 换行，防止拼音输入法冲突
function handleKeyDown(event: KeyboardEvent) {
  if (event.isComposing) {
    return
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    handleSend()
  }
}

// 发送指令
function handleSend() {
  if (props.isStreaming) return
  const trimmed = inputText.value.trim()
  if (!trimmed) return

  const payload: SendPayload = {
    query: trimmed,
    scope: currentScope.value,
    selectedText: props.selectedText && props.selectedText.trim().length > 0 ? props.selectedText.trim() : undefined
  }

  emit('send', payload)
  inputText.value = ''
  nextTick(() => {
    adjustTextareaHeight()
    textareaRef.value?.focus()
  })
}

// 停止生成
function handleStop() {
  emit('stop')
}

// 文件上传触发
function triggerFileInput() {
  fileInputRef.value?.click()
}

function handleFileChange(event: Event) {
  const target = event.target as HTMLInputElement
  if (!target.files || target.files.length === 0) return

  const file = target.files[0]
  if (file.name.toLowerCase().endsWith('.pptx')) {
    emit('uploadPptx', file)
  }
  // 清空 value 允许重复选同一文件
  target.value = ''
}

// 截短展示选中文本
const truncatedSelection = computed(() => {
  if (!props.selectedText) return ''
  const clean = props.selectedText.replace(/\s+/g, ' ').trim()
  return clean.length > 70 ? `${clean.slice(0, 70)}...` : clean
})

onMounted(() => {
  adjustTextareaHeight()
})
</script>

<template>
  <div class="chat-input-wrapper">
    <!-- 1. 范围选择器 Chips -->
    <div class="scope-chips-bar" role="tablist" aria-label="检索范围切换">
      <button
        v-for="chip in scopeChips"
        :key="chip.id"
        type="button"
        class="scope-chip"
        :class="{
          'is-active': currentScope === chip.id,
          'is-disabled': chip.disabled
        }"
        :title="chip.description"
        :disabled="chip.disabled"
        @click="selectScope(chip)"
      >
        <span class="chip-icon" v-html="chip.icon"></span>
        <span class="chip-label">{{ chip.label }}</span>
      </button>
    </div>

    <!-- 2. 划词引用微胶囊预览（当有选区且激活时） -->
    <div v-if="selectedText && selectedText.trim()" class="selection-quote-card">
      <div class="quote-header">
        <span class="quote-icon" v-html="ICONS.scopeSelection"></span>
        <span class="quote-title">正文划选上下文</span>
        <button
          type="button"
          class="quote-clear-btn"
          title="移除选区引用"
          @click="handleClearSelection"
        >
          <span class="clear-icon" v-html="ICONS.close"></span>
        </button>
      </div>
      <div class="quote-snippet">
        {{ truncatedSelection }}
      </div>
    </div>

    <!-- 3. 输入框与控制栏主容器 -->
    <div
      class="input-box-container"
      :class="{
        'is-focused': isFocused,
        'is-disabled': disabled
      }"
    >
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="chat-textarea"
        :placeholder="placeholder"
        :disabled="disabled || isStreaming"
        rows="1"
        @focus="isFocused = true"
        @blur="isFocused = false"
        @input="adjustTextareaHeight"
        @keydown="handleKeyDown"
      ></textarea>

      <!-- 底部控制按钮栏 -->
      <div class="input-actions-bar">
        <div class="left-tools">
          <!-- PPTX 课件上传按钮 -->
          <input
            ref="fileInputRef"
            type="file"
            accept=".pptx"
            class="hidden-file-input"
            @change="handleFileChange"
          />
          <button
            type="button"
            class="tool-btn"
            title="上传课件 (.pptx) 考点导学"
            :disabled="disabled || isStreaming"
            @click="triggerFileInput"
          >
            <span class="tool-icon" v-html="ICONS.paperclip"></span>
            <span class="tool-label">课件导学</span>
          </button>
        </div>

        <div class="right-tools">
          <span class="shortcut-tip">Enter 发送 / Shift+Enter 换行</span>

          <!-- 发送 / 停止切换按钮 -->
          <button
            v-if="isStreaming"
            type="button"
            class="action-btn stop-btn"
            title="停止生成"
            @click="handleStop"
          >
            <span class="action-icon" v-html="ICONS.stop"></span>
            <span class="action-text">停止</span>
          </button>

          <button
            v-else
            type="button"
            class="action-btn send-btn"
            :disabled="disabled || !inputText.trim()"
            title="发送 (Enter)"
            @click="handleSend"
          >
            <span class="action-icon" v-html="ICONS.send"></span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input-wrapper {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 14px;
  background: var(--vp-c-bg);
  border-top: 1px solid var(--vp-c-divider);
}

/* 范围选择 Chips */
.scope-chips-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}
.scope-chips-bar::-webkit-scrollbar {
  display: none;
}

.scope-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1.2;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  user-select: none;
}

.scope-chip:hover:not(:disabled) {
  border-color: var(--vp-c-border);
  color: var(--vp-c-text-1);
}

.scope-chip.is-active {
  background: var(--vp-c-brand-soft, rgba(62, 99, 221, 0.12));
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}

.scope-chip.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
  border-style: dashed;
}

.chip-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.chip-icon :deep(svg) {
  width: 12px;
  height: 12px;
}

/* 划词微卡片预览 */
.selection-quote-card {
  padding: 6px 10px;
  background: var(--vp-c-bg-mute);
  border-left: 3px solid var(--vp-c-brand-1);
  border-radius: 0 6px 6px 0;
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.quote-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--vp-c-brand-1);
  font-weight: 600;
}

.quote-header .quote-icon {
  display: inline-flex;
  margin-right: 4px;
}
.quote-header .quote-icon :deep(svg) {
  width: 12px;
  height: 12px;
}

.quote-title {
  flex: 1;
  font-size: 11px;
}

.quote-clear-btn {
  background: transparent;
  border: none;
  padding: 2px;
  cursor: pointer;
  color: var(--vp-c-text-3);
  display: inline-flex;
  align-items: center;
  border-radius: 3px;
}
.quote-clear-btn:hover {
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
}
.quote-clear-btn :deep(svg) {
  width: 12px;
  height: 12px;
}

.quote-snippet {
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono, monospace);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 输入框主容器 */
.input-box-container {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.input-box-container:focus-within {
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 2px var(--vp-c-brand-soft, rgba(62, 99, 221, 0.15));
}

.chat-textarea {
  width: 100%;
  min-height: 42px;
  max-height: 160px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--vp-c-text-1);
  background: transparent;
  border: none;
  resize: none;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}

.chat-textarea::placeholder {
  color: var(--vp-c-text-3);
  font-size: 12.5px;
}

.hidden-file-input {
  display: none;
}

/* 底部操作条 */
.input-actions-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 6px;
  border-top: 1px dashed var(--vp-c-divider);
}

.left-tools,
.right-tools {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s ease;
}

.tool-btn:hover:not(:disabled) {
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
}

.tool-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tool-icon :deep(svg) {
  width: 13px;
  height: 13px;
}

.shortcut-tip {
  font-size: 11px;
  color: var(--vp-c-text-3);
  display: none;
}

@media (min-width: 480px) {
  .shortcut-tip {
    display: inline;
  }
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.send-btn {
  width: 28px;
  padding: 0;
  background: var(--vp-c-brand-1);
  border: 1px solid var(--vp-c-brand-1);
  color: #ffffff;
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.send-btn:disabled {
  background: var(--vp-c-bg-mute);
  border-color: var(--vp-c-divider);
  color: var(--vp-c-text-3);
  cursor: not-allowed;
}

.send-btn :deep(svg) {
  width: 14px;
  height: 14px;
}

.stop-btn {
  gap: 4px;
  padding: 0 8px;
  background: var(--vp-c-bg-mute);
  border: 1px solid var(--vp-c-divider);
  color: #ef4444;
  font-weight: 500;
}

.stop-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: #ef4444;
}

.stop-btn :deep(svg) {
  width: 12px;
  height: 12px;
}
</style>
