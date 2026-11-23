<script setup lang="ts">
/**
 * SelectionToolbar.vue — 正文划词“问问AI”浮动工具栏
 * 
 * 职责：
 *   1. 监听讲义正文 (.vp-doc) 内的划选文字，以 150ms 防抖捕获选区；
 *   2. 精准计算选区在视口中的 getBoundingClientRect，安全贴合浮动，防止溢出屏幕边界；
 *   3. 核心动作呈现工程极简按钮 [问问AI]，搭配 pulseTrigger 纯矢量 SVG 图标；
 *   4. 触发后向全局 aiState 注入引用并唤出侧边栏，或触发 ask-ai 事件；
 *   5. 点击空白处或选区折叠时自动隐藏，组件卸载时彻底移除所有事件监听。
 * 
 * 铁律：
 *   - 零 Emoji：严禁任何 Emoji 表情符号；
 *   - SSR 保护：严格防御 Node.js 服务端预渲染；
 *   - 内存安全：显式解绑所有全局监听器，杜绝内存泄漏。
 */

import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import { actionsForSurface, normalizePromptLang } from '../../../prompts/companion.ts'
import { companionPromptsRef } from '../../../prompts/store.ts'
import { ICONS } from './icons'
import { aiState } from './aiState'
import { normalizeConceptName } from '../../../concepts/names.ts'
import {
  fetchDevConceptsList,
  probeLocalAuthorSession,
  type ConceptListItem,
} from './conceptAuthorClient'

const { t, lang } = useT()

interface Props {
  /** 限定触发选区的容器选择器，默认 .vp-doc */
  targetSelector?: string
}

const props = withDefaults(defineProps<Props>(), {
  targetSelector: '.vp-doc'
})

const emit = defineEmits<{
  (e: 'ask-ai', selectedText: string): void
  (e: 'quick-action', payload: { actionId: string; selectedText: string }): void
}>()

const quickActionButtons = computed(() => {
  const pLang = normalizePromptLang(lang.value)
  return actionsForSurface(companionPromptsRef.value, 'menu').map((action) => ({
    id: action.id,
    label: action.label[pLang],
  }))
})

const isMounted = ref(false)
const visible = ref(false)
const selectedText = ref('')
const coords = ref<{ top: number; left: number }>({ top: 0, left: 0 })
const toolbarRef = ref<HTMLElement | null>(null)

const isLocalAuthor = ref(false)
const devConcepts = ref<ConceptListItem[]>([])
const selectedConceptSlug = ref('')
const selectionMeta = ref({
  sectionHeading: '',
  beforeContext: '',
  afterContext: '',
  lecturePath: '',
})

const matchingExistingConcepts = computed<ConceptListItem[]>(() => {
  if (!isLocalAuthor.value || selectedConceptSlug.value) return []
  const needle = normalizeConceptName(selectedText.value)
  if (!needle) return []
  const matched: ConceptListItem[] = []
  const seenSlugs = new Set<string>()
  for (const c of devConcepts.value) {
    if (c.status && c.status !== 'published') continue
    if (seenSlugs.has(c.slug)) continue
    const names = [c.term, c.english, ...(c.aliases ?? [])]
    if (names.some((n) => normalizeConceptName(n) === needle)) {
      seenSlugs.add(c.slug)
      matched.push(c)
    }
  }
  return matched
})

const matchingExistingConcept = computed<ConceptListItem | null>(() => matchingExistingConcepts.value[0] ?? null)

function extractSelectionContext(range: Range, docContainer: Element): void {
  const startNode = range.startContainer
  const startEl = startNode.nodeType === Node.ELEMENT_NODE ? (startNode as Element) : startNode.parentElement
  const endEl = range.endContainer.nodeType === Node.ELEMENT_NODE ? (range.endContainer as Element) : range.endContainer.parentElement
  const linkEl = startEl?.closest('a.lec-term') ?? endEl?.closest('a.lec-term') ?? null
  let foundSlug = linkEl?.getAttribute('data-concept') ?? ''
  if (!foundSlug) {
    const insideLink = Array.from(docContainer.querySelectorAll('a.lec-term')).find((a) => range.intersectsNode(a))
    if (insideLink) foundSlug = insideLink.getAttribute('data-concept') ?? ''
  }
  selectedConceptSlug.value = foundSlug

  let sectionHeading = ''
  const blockEl = startEl?.closest('p, li, td, th, blockquote') ?? startEl
  const headings = Array.from(docContainer.querySelectorAll('h2, h3, h4'))
  for (const h of headings) {
    if (blockEl && (h.compareDocumentPosition(blockEl) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      sectionHeading = (h.textContent ?? '').replace(/\u200b/g, '').trim()
    }
  }

  let beforeContext = ''
  let afterContext = ''
  if (blockEl && typeof document !== 'undefined') {
    try {
      const preRange = document.createRange()
      preRange.selectNodeContents(blockEl)
      preRange.setEnd(range.startContainer, range.startOffset)
      beforeContext = preRange.toString().slice(-40)

      const postRange = document.createRange()
      postRange.selectNodeContents(blockEl)
      postRange.setStart(range.endContainer, range.endOffset)
      afterContext = postRange.toString().slice(0, 40)
    } catch {
      // ignore cross-container range extraction edge cases
    }
  }

  selectionMeta.value = {
    sectionHeading,
    beforeContext,
    afterContext,
    lecturePath: typeof window !== 'undefined' ? window.location.pathname : '',
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null

const toolbarStyle = computed(() => ({
  top: `${coords.value.top}px`,
  left: `${coords.value.left}px`
}))

const hide = () => {
  if (visible.value) {
    visible.value = false
  }
}

/**
 * 计算选区坐标并安全定位浮动条
 */
const updatePosition = (isScrollUpdate = false) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return

  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hide()
    return
  }

  const range = sel.getRangeAt(0)
  const commonNode = range.commonAncestorContainer
  const containerEl = commonNode.nodeType === Node.ELEMENT_NODE
    ? (commonNode as Element)
    : commonNode.parentElement

  if (!containerEl) {
    hide()
    return
  }

  // 门禁：仅在 targetSelector (.vp-doc) 内部触发
  const docContainer = containerEl.closest(props.targetSelector)
  if (!docContainer) {
    hide()
    return
  }

  // 排除浮动条自身、AI 侧边栏及表单输入元素
  if (
    containerEl.closest('.ai-selection-toolbar') ||
    containerEl.closest('.ai-sidebar') ||
    containerEl.closest('input, textarea, [contenteditable="true"]')
  ) {
    hide()
    return
  }

  const text = sel.toString().trim()
  if (!text || text.length === 0) {
    hide()
    return
  }

  if (isLocalAuthor.value) {
    extractSelectionContext(range, docContainer)
  }

  const rect = range.getBoundingClientRect()
  // 选区不可见或尺寸为零
  if (rect.width === 0 && rect.height === 0) {
    hide()
    return
  }

  // 视口边界过滤：选区若已滚出视口外则隐藏
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    hide()
    return
  }

  // 预估或实测浮动条尺寸
  const tbWidth = toolbarRef.value?.offsetWidth || 340
  const tbHeight = toolbarRef.value?.offsetHeight || 36

  // 上下定位：优先贴在选区上方 8px，若上方空间不足（< 8px）则翻转至选区下方
  let top = rect.top - tbHeight - 8
  if (top < 8) {
    top = rect.bottom + 8
  }

  // 左右定位：居中对齐选区，并进行屏幕左右安全内缩边界裁剪
  const padding = 12
  let left = rect.left + (rect.width / 2) - (tbWidth / 2)
  const maxLeft = window.innerWidth - tbWidth - padding
  left = Math.max(padding, Math.min(maxLeft, left))

  coords.value = {
    top: Math.round(top),
    left: Math.round(left)
  }
  selectedText.value = text

  if (!visible.value) {
    visible.value = true
    // DOM 挂载后根据真实 offsetWidth 再次微调，杜绝尺寸估算偏差
    nextTick(() => {
      if (toolbarRef.value && !isScrollUpdate) {
        const exactWidth = toolbarRef.value.offsetWidth
        const exactHeight = toolbarRef.value.offsetHeight
        let exactTop = rect.top - exactHeight - 8
        if (exactTop < 8) {
          exactTop = rect.bottom + 8
        }
        let exactLeft = rect.left + (rect.width / 2) - (exactWidth / 2)
        const exactMaxLeft = window.innerWidth - exactWidth - padding
        exactLeft = Math.max(padding, Math.min(exactMaxLeft, exactLeft))
        coords.value = {
          top: Math.round(exactTop),
          left: Math.round(exactLeft)
        }
      }
    })
  }
}

/**
 * 防抖 150ms 监听选区变化
 */
const onSelectionChange = () => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    updatePosition()
  }, 150)
}

/**
 * 点击外部区域处理
 */
const onPointerDown = (event: PointerEvent) => {
  if (!visible.value) return
  const target = event.target as Node | null
  if (target && toolbarRef.value && toolbarRef.value.contains(target)) {
    return
  }
  hide()
}

/**
 * 视口滚动与缩放时同步位置（采用 requestAnimationFrame 节流，杜绝 Layout Thrashing 强制同步重排）
 */
let rafId: number | null = null
const onScrollOrResize = () => {
  if (!visible.value) return
  if (rafId !== null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    if (visible.value) {
      updatePosition(true)
    }
  })
}

/**
 * 点击 [问问AI] 按钮核心动作
 */
const onAskAi = () => {
  const text = selectedText.value
  if (!text) return

  // 1. 发出 Vue 事件
  emit('ask-ai', text)

  // 2. 联动全局状态：注入划选内容并唤出侧边栏
  aiState.openSidebar(text)

  // 3. 隐藏浮动条
  visible.value = false
}

const onQuickAction = (actionId: string) => {
  const text = selectedText.value
  if (!text) return

  emit('quick-action', { actionId, selectedText: text })
  aiState.dispatchAction(actionId, text)
  visible.value = false
}

const onConceptAction = (mode: 'create' | 'attach' | 'edit' | 'supplement' | 'delete') => {
  const text = selectedText.value
  if (!text || !isLocalAuthor.value) return
  const targetSlug =
    mode === 'edit' || mode === 'delete'
      ? selectedConceptSlug.value
      : mode === 'attach'
        ? matchingExistingConcept.value?.slug
        : mode === 'supplement' && matchingExistingConcepts.value.length === 1
          ? matchingExistingConcept.value?.slug
          : undefined
  aiState.openConceptTask({
    mode,
    selectedText: text,
    ...(targetSlug ? { targetSlug } : {}),
    lecturePath: selectionMeta.value.lecturePath,
    sectionHeading: selectionMeta.value.sectionHeading,
    beforeContext: selectionMeta.value.beforeContext,
    afterContext: selectionMeta.value.afterContext,
  })
  visible.value = false
}

const refreshDevConceptCatalog = async () => {
  if (!import.meta.env.DEV) return
  const session = await probeLocalAuthorSession()
  isLocalAuthor.value = session.isLocalAuthor
  if (session.isLocalAuthor) {
    devConcepts.value = await fetchDevConceptsList()
  }
}

const onToolbarKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    hide()
  }
}

onMounted(() => {
  isMounted.value = true
  if (import.meta.env.DEV) {
    void refreshDevConceptCatalog()
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScrollOrResize, { passive: true })
    window.addEventListener('resize', onScrollOrResize, { passive: true })
  }
})

onUnmounted(() => {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('scroll', onScrollOrResize)
    window.removeEventListener('resize', onScrollOrResize)
  }
})
</script>

<template>
  <Teleport to="body" v-if="isMounted">
    <Transition name="ai-pill-fade">
      <div
        v-if="visible"
        ref="toolbarRef"
        class="ai-selection-toolbar"
        :style="toolbarStyle"
        role="toolbar"
        :aria-label="t('ai.askAiToolbarAria')"
        @keydown="onToolbarKeyDown"
      >
        <button
          type="button"
          class="ai-toolbar-btn is-primary-trigger"
          data-ai-toolbar-ask
          @mousedown.prevent
          @click="onAskAi"
          :title="t('ai.askAiTitle')"
        >
          <span class="ai-toolbar-icon" aria-hidden="true" v-html="ICONS.pulseTrigger"></span>
          <span class="ai-toolbar-label">{{ t('ai.askAi') }}</span>
        </button>
        <span v-if="quickActionButtons.length > 0" class="ai-toolbar-sep" aria-hidden="true"></span>
        <button
          v-for="action in quickActionButtons"
          :key="action.id"
          type="button"
          class="ai-toolbar-btn"
          :data-ai-toolbar-action="action.id"
          @mousedown.prevent
          @click="onQuickAction(action.id)"
          :title="action.label"
        >
          <span class="ai-toolbar-label">{{ action.label }}</span>
        </button>
        <template v-if="isLocalAuthor">
          <span class="ai-toolbar-sep" aria-hidden="true"></span>
          <template v-if="selectedConceptSlug">
            <button
              type="button"
              class="ai-toolbar-btn"
              data-ai-toolbar-concept="edit"
              @mousedown.prevent
              @click="onConceptAction('edit')"
            >
              <span class="ai-toolbar-label">{{ t('ai.conceptEditBtn') }}</span>
            </button>
            <button
              type="button"
              class="ai-toolbar-btn"
              data-ai-toolbar-concept="delete"
              @mousedown.prevent
              @click="onConceptAction('delete')"
            >
              <span class="ai-toolbar-label">{{ t('ai.conceptDeleteBtn') }}</span>
            </button>
          </template>
          <template v-else>
            <button
              v-if="matchingExistingConcept"
              type="button"
              class="ai-toolbar-btn"
              data-ai-toolbar-concept="attach"
              @mousedown.prevent
              @click="onConceptAction('attach')"
            >
              <span class="ai-toolbar-label">{{ t('ai.conceptAttachBtn', { term: matchingExistingConcept.term }) }}</span>
            </button>
            <button
              v-if="matchingExistingConcept"
              type="button"
              class="ai-toolbar-btn"
              data-ai-toolbar-concept="supplement"
              @mousedown.prevent
              @click="onConceptAction('supplement')"
            >
              <span class="ai-toolbar-label">{{ t('ai.conceptSupplementBtn') }}</span>
            </button>
            <button
              type="button"
              class="ai-toolbar-btn"
              data-ai-toolbar-concept="create"
              @mousedown.prevent
              @click="onConceptAction('create')"
            >
              <span class="ai-toolbar-label">{{ t('ai.conceptCreateBtn') }}</span>
            </button>
          </template>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-selection-toolbar {
  position: fixed;
  z-index: 1000;
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  max-width: calc(100vw - 24px);
  gap: 4px;
  padding: 4px 6px;
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  border: var(--lec-line-hair) solid var(--lec-border);
  user-select: none;
  pointer-events: auto;
  transform: translate3d(0, 0, 0);
}

.ai-toolbar-sep {
  width: 1px;
  height: 16px;
  background: var(--lec-border);
  flex-shrink: 0;
}

.ai-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: var(--lec-radius-1);
  font-family: var(--lec-font-heading);
  font-size: 12px;
  font-weight: 500;
  color: var(--lec-text);
  background: transparent;
  border: var(--lec-line-hair) solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  line-height: 1.2;
}

.ai-toolbar-btn:hover {
  color: var(--lec-accent);
  background: var(--lec-accent-tint);
  border-color: var(--lec-accent);
}

.ai-toolbar-btn:focus-visible {
  outline: 2px solid var(--lec-accent);
  outline-offset: 2px;
}

[data-lec-theme='datasheet'] .ai-selection-toolbar {
  border-radius: var(--lec-radius-1);
  border-top: var(--lec-line-heavy) solid var(--lec-text);
}

[data-lec-theme='datasheet'] .ai-toolbar-btn {
  font-family: var(--lec-font-mono);
  font-size: 11.5px;
}

.ai-toolbar-btn:active {
  transform: scale(0.96);
}

.ai-toolbar-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--lec-accent);
  flex-shrink: 0;
}

.ai-toolbar-icon :deep(svg) {
  display: block;
}

.ai-toolbar-label {
  display: inline-block;
  line-height: 1;
}

/* 动效过渡 */
.ai-pill-fade-enter-active,
.ai-pill-fade-leave-active {
  transition: opacity 0.15s ease, transform 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

.ai-pill-fade-enter-from,
.ai-pill-fade-leave-to {
  opacity: 0;
  transform: translateY(4px) scale(0.96);
}
</style>
