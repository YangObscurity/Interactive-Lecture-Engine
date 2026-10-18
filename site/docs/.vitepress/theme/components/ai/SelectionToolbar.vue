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
import { ICONS } from './icons'
import { aiState } from './aiState'

interface Props {
  /** 限定触发选区的容器选择器，默认 .vp-doc */
  targetSelector?: string
}

const props = withDefaults(defineProps<Props>(), {
  targetSelector: '.vp-doc'
})

const emit = defineEmits<{
  (e: 'ask-ai', selectedText: string): void
}>()

const isMounted = ref(false)
const visible = ref(false)
const selectedText = ref('')
const coords = ref<{ top: number; left: number }>({ top: 0, left: 0 })
const toolbarRef = ref<HTMLElement | null>(null)

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
  const tbWidth = toolbarRef.value?.offsetWidth || 108
  const tbHeight = toolbarRef.value?.offsetHeight || 34

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

onMounted(() => {
  isMounted.value = true
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
        aria-label="划词快速操作"
      >
        <button
          type="button"
          class="ai-toolbar-btn"
          @mousedown.prevent
          @click="onAskAi"
          title="向 AI 伴读询问选中文本"
        >
          <span class="ai-toolbar-icon" v-html="ICONS.pulseTrigger"></span>
          <span class="ai-toolbar-label">问问AI</span>
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-selection-toolbar {
  position: fixed;
  z-index: 1000;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px;
  border-radius: 9999px;
  background: var(--vp-c-bg-elv, #ffffff);
  border: 1px solid var(--vp-c-divider, rgba(60, 60, 67, 0.18));
  box-shadow: 0 4px 16px -2px rgba(0, 0, 0, 0.12), 0 1px 4px rgba(0, 0, 0, 0.06);
  backdrop-filter: blur(8px);
  user-select: none;
  pointer-events: auto;
  transform: translate3d(0, 0, 0);
}

.ai-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 9999px;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.02em;
  color: var(--vp-c-text-1, #213547);
  background: transparent;
  border: none;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.16s ease;
  line-height: 1;
}

.ai-toolbar-btn:hover {
  color: var(--vp-c-brand-1, #10b981);
  background: var(--vp-c-default-soft, rgba(16, 185, 129, 0.08));
}

.ai-toolbar-btn:active {
  transform: scale(0.96);
}

.ai-toolbar-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-brand-1, #10b981);
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
