<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { isEnabled, onFlagsChange } from '../../debug/flags'
import { useT } from '../../../i18n/useT.ts'
import { actionsForSurface, normalizePromptLang } from '../../../prompts/companion.ts'
import { companionPromptsRef } from '../../../prompts/store.ts'
import { BYOK_CHANGED_EVENT, isByokActive, readByokConfig } from './byokClient'
import { ICONS } from './icons'
import type { ScopeType, SendPayload, ScopeChipItem } from './types'

const { t, lang } = useT()

const props = withDefaults(
  defineProps<{
    lectureId?: string
    groupId?: string
    selectedText?: string
    isStreaming?: boolean
    disabled?: boolean
    canUpload?: boolean
    placeholder?: string
    /** S6Y F6 (audit-spec #28): set while the backend is unreachable; every quick action is disabled and says why */
    quickDisabledReason?: string
  }>(),
  {
    lectureId: '',
    groupId: '',
    selectedText: '',
    isStreaming: false,
    disabled: false,
    canUpload: false,
    placeholder: '',
    quickDisabledReason: ''
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
const aiScopeEnabled = ref(isEnabled('aiScope'))
const aiUploadEnabled = ref(isEnabled('aiUpload'))
const byokActive = ref(isByokActive(readByokConfig()))

const refreshInputFlags = () => {
  aiScopeEnabled.value = isEnabled('aiScope')
  aiUploadEnabled.value = isEnabled('aiUpload')
  byokActive.value = isByokActive(readByokConfig())
}

// 自适应工程检索范围 Chips（aiScope 开关关闭时不渲染多选范围假入口，FE-010）
const scopeChips = computed<ScopeChipItem[]>(() => {
  const hasSelection = Boolean(props.selectedText && props.selectedText.trim().length > 0)
  const chips: ScopeChipItem[] = []

  if (aiScopeEnabled.value) {
    if (props.lectureId) {
      chips.push({
        id: 'lecture',
        label: t('ai.scopeLecture'),
        icon: ICONS.scopeLecture,
        description: t('ai.scopeLectureDesc', { id: props.lectureId.toUpperCase() })
      })
    }

    if (props.groupId) {
      chips.push({
        id: 'group',
        label: props.lectureId
          ? t('ai.scopeGroupLong')
          : t('ai.scopeGroupWithId', { id: props.groupId.toUpperCase() }),
        icon: ICONS.scopeGroup,
        description: t('ai.scopeGroupDesc', { id: props.groupId.toUpperCase() })
      })
    }

    chips.push({
      id: 'all',
      label: props.lectureId ? t('ai.scopeAll') : t('ai.scopeAllLong'),
      icon: ICONS.scopeAll,
      description: t('ai.scopeAllDesc')
    })
  }

  if (hasSelection) {
    chips.push({
      id: 'selection',
      label: t('ai.scopeSelection'),
      icon: ICONS.scopeSelection,
      description: t('ai.scopeSelectionDesc')
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

// 快捷动作按钮（由站点 companion.json 统一定义，按 enabled / surfaces 过滤，needsSelection 联动启用状态）
const hasEffectiveSelection = computed(() => {
  const s = (props.selectedText || '').trim()
  return s.length > 0 && s !== t('ai.noSelection')
})

const quickActionItems = computed(() => {
  const pLang = normalizePromptLang(lang.value)
  return actionsForSurface(companionPromptsRef.value, 'panel').map((action) => {
    const needsSelection = action.needsSelection
    const selectionBlocked = needsSelection && !hasEffectiveSelection.value
    const offReason = props.quickDisabledReason
    const disabled = Boolean(props.disabled || props.isStreaming || selectionBlocked || offReason)
    const label = action.label[pLang]
    return {
      id: action.id,
      label,
      needsSelection,
      disabled,
      title: offReason || (selectionBlocked ? t('ai.quickActionNeedsSelection') : label),
    }
  })
})

function handleQuickAction(actionId: string) {
  if (props.disabled || props.isStreaming || props.quickDisabledReason) return
  const cleanSel = hasEffectiveSelection.value ? props.selectedText.trim() : undefined
  const payload: SendPayload = {
    query: '',
    scope: cleanSel ? 'selection' : currentScope.value,
    selectedText: cleanSel,
    actionId,
  }
  emit('send', payload)
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
  if (file && file.name.toLowerCase().endsWith('.pptx')) {
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

let stopFlagListener: (() => void) | null = null

onMounted(() => {
  refreshInputFlags()
  stopFlagListener = onFlagsChange(refreshInputFlags)
  if (typeof window !== 'undefined') {
    window.addEventListener(BYOK_CHANGED_EVENT, refreshInputFlags)
  }
  adjustTextareaHeight()
})

onUnmounted(() => {
  stopFlagListener?.()
  stopFlagListener = null
  if (typeof window !== 'undefined') {
    window.removeEventListener(BYOK_CHANGED_EVENT, refreshInputFlags)
  }
})
</script>

<template>
  <div class="chat-input-wrapper">
    <!-- 1. 范围选择器 Chips (受 aiScope 特性开关控制) -->
    <div v-if="scopeChips.length > 0" class="scope-chips-bar" role="tablist" :aria-label="t('ai.scopeTablistAria')">
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
        <span class="quote-title">{{ t('ai.quotedContextLabel') }}</span>
        <button
          type="button"
          class="quote-clear-btn"
          :title="t('ai.clearQuoteTitle')"
          @click="handleClearSelection"
        >
          <span class="clear-icon" v-html="ICONS.close"></span>
        </button>
      </div>
      <div class="quote-snippet">
        {{ truncatedSelection }}
      </div>
    </div>

    <!-- 2.5 站点受控快捷动作栏 -->
    <div
      v-if="quickActionItems.length > 0"
      class="quick-actions-bar"
      role="group"
      :aria-label="t('ai.quickActionsAria')"
      data-ai-quick-actions
    >
      <button
        v-for="item in quickActionItems"
        :key="item.id"
        type="button"
        class="quick-action-btn"
        :class="{
          'needs-selection': item.needsSelection,
          'is-disabled': item.disabled
        }"
        :data-ai-quick-action="item.id"
        :data-needs-selection="item.needsSelection ? '1' : '0'"
        :disabled="item.disabled"
        :title="item.title"
        @click="handleQuickAction(item.id)"
      >
        <span class="quick-action-label">{{ item.label }}</span>
      </button>
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
        :placeholder="placeholder || t('ai.inputPlaceholder')"
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
          <!-- PPTX 课件上传按钮（受 aiUpload 特性开关及 adapter === 'proxy' 控制，BYOK 直连下隐藏，FE-011） -->
          <template v-if="aiUploadEnabled && canUpload && !byokActive">
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
              :title="t('ai.uploadTitle')"
              :disabled="disabled || isStreaming"
              @click="triggerFileInput"
            >
              <span class="tool-icon" v-html="ICONS.paperclip"></span>
              <span class="tool-label">{{ t('ai.uploadBtn') }}</span>
            </button>
          </template>
        </div>

        <div class="right-tools">
          <span class="shortcut-tip">{{ t('ai.shortcutHint') }}</span>

          <!-- 发送 / 停止切换按钮 -->
          <button
            v-if="isStreaming"
            type="button"
            class="action-btn stop-btn"
            :title="t('ai.stopTitle')"
            @click="handleStop"
          >
            <span class="action-icon" v-html="ICONS.stop"></span>
            <span class="action-text">{{ t('ai.stopLabel') }}</span>
          </button>

          <button
            v-else
            type="button"
            class="action-btn send-btn"
            :disabled="disabled || !inputText.trim()"
            :title="t('ai.sendTitle')"
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
  background: var(--lec-bg);
  border-top: 1px solid var(--lec-border);
}

/* Scope selection chips */
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
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-border);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  user-select: none;
}

.scope-chip:hover:not(:disabled) {
  border-color: var(--lec-accent);
  color: var(--lec-text);
}

.scope-chip.is-active {
  background: var(--lec-accent-tint);
  border-color: var(--lec-accent);
  color: var(--lec-accent);
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

/* Selection quote card */
.selection-quote-card {
  padding: 6px 10px;
  background: var(--lec-surface);
  border-left: 3px solid var(--lec-accent);
  border-radius: 0 var(--lec-radius-1) var(--lec-radius-1) 0;
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.quote-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--lec-accent);
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
  color: var(--lec-text-muted);
  display: inline-flex;
  align-items: center;
  border-radius: var(--lec-radius-1);
}
.quote-clear-btn:hover {
  color: var(--lec-text);
  background: var(--lec-surface);
}
.quote-clear-btn :deep(svg) {
  width: 12px;
  height: 12px;
}

.quote-snippet {
  color: var(--lec-text-muted);
  font-family: var(--lec-font-mono);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Input box container */
.input-box-container {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  transition: border-color 0.2s ease;
}

.input-box-container:focus-within {
  border-color: var(--lec-accent);
  outline: 2px solid var(--lec-accent-tint);
  outline-offset: 0;
}

.chat-textarea {
  width: 100%;
  min-height: 42px;
  max-height: 160px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--lec-text);
  background: transparent;
  border: none;
  resize: none;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}

.chat-textarea::placeholder {
  color: var(--lec-text-muted);
  font-size: 12.5px;
}

.hidden-file-input {
  display: none;
}

/* Bottom action bar */
.input-actions-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px 6px;
  border-top: 1px dashed var(--lec-border);
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
  border-radius: var(--lec-radius-1);
  font-size: 11.5px;
  color: var(--lec-text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.tool-btn:hover:not(:disabled) {
  background: var(--lec-bg);
  color: var(--lec-text);
  border-color: var(--lec-border);
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
  color: var(--lec-text-muted);
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
  border-radius: var(--lec-radius-1);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.send-btn {
  width: 28px;
  padding: 0;
  background: var(--lec-accent);
  border: 1px solid var(--lec-accent);
  color: var(--lec-on-accent);
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.send-btn:disabled {
  background: var(--lec-surface);
  border-color: var(--lec-border);
  color: var(--lec-text-muted);
  cursor: not-allowed;
}

.send-btn :deep(svg) {
  width: 14px;
  height: 14px;
}

.stop-btn {
  gap: 4px;
  padding: 0 8px;
  background: var(--lec-surface);
  border: 1px solid var(--lec-border);
  color: var(--lec-danger);
  font-weight: 500;
}

.stop-btn:hover {
  background: var(--lec-danger-tint);
  border-color: var(--lec-danger);
}

.stop-btn :deep(svg) {
  width: 12px;
  height: 12px;
}

/* 站点受控快捷动作按钮条（遵循 spec-board chips 语法与双肤契约） */
.quick-actions-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.quick-action-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
  border-radius: var(--lec-radius-1);
  border: var(--lec-line-hair) solid var(--lec-border);
  background: var(--lec-surface);
  color: var(--lec-text);
  font-family: var(--lec-font-heading);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  cursor: pointer;
  white-space: nowrap;
}

.quick-action-btn:hover:not(:disabled) {
  border-color: var(--lec-accent);
  background: var(--lec-accent-tint);
  color: var(--lec-accent);
}

.quick-action-btn:focus-visible {
  outline: 2px solid var(--lec-accent);
  outline-offset: 2px;
}

.quick-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

[data-lec-theme='datasheet'] .quick-action-btn {
  border-color: var(--lec-border);
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
}
</style>
