<script setup lang="ts">
/**
 * AiSidebarShell.vue — 讲义 AI 伴读侧边栏外壳与分屏推挤布局容器
 * 
 * 核心职责与交互铁律：
 * 1. 独立浮层无极拉伸与正文恒定防挤压契约：
 *    - 侧边栏的无极拉伸变化完全发生在侧边栏自身浮动层，具有高层级阴影（box-shadow: -10px 0 36px）；
 *    - 左侧正文 (.VPDoc) 绝不发生跳动或挤压变形，恒定保留 400px 标准版心边距；
 * 2. 位置记忆与默认最大拉伸契约：
 *    - 记忆 key: 'lecture-ai-sidebar-custom-width'；
 *    - 仅在用户向左拖拽展开超过 420px 时记录新位置；
 *    - 若用户此前未曾拖拽展开过，默认记忆位置为最大允许宽度 MAX_WIDTH（window.innerWidth - 380px，clamped to 960px）；
 * 3. 边框圆形拉伸/收缩切换按钮 (Circular Toggle Button)：
 *    - 位于 AI 侧边栏左边缘居中位置（30px 直径圆形，无 Emoji，纯工程矢量 SVG）；
 *    - 标准/收起态 (<= 420px)：展示向左剪头 (<)，提示“拉伸至记忆宽度”，点击平滑过渡展开至记忆宽度；
 *    - 展开态 (> 420px)：展示向右剪头 (>)，提示“收缩回标准宽度 (400px)”，点击平滑收缩回 400px；
 * 4. 手动拖拽拉伸与动态字体缩放：
 *    - 支持按住左边缘任意位置拖拽（ew-resize）；
 *    - 拖拽超过 420px 自动更新记忆宽度；
 *    - 动态字体缩放：标准 400px 时为 13.5px，随拉伸平滑线性放大至沉浸阅读模式 19.5px；
 * 5. 严格规范：零 Emoji 铁律、严格 TypeScript、SSR 安全防护、生命周期 100% 解绑无内存泄漏。
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { aiState } from './aiState'
import { ICONS } from './icons'
import { useLectureContext } from './useLectureContext'
// 侧栏宽度记忆键统一收口在 site.config.mts（键名一旦笔误，用户拖拽宽度就静默不保存）
import {
  STORAGE_KEYS,
  storageKeysFor,
  readRawWithFallback,
  writeRawWithDualWrite,
} from '../../../site.config'

const SIDEBAR_WIDTH_KEYS = storageKeysFor(STORAGE_KEYS.aiSidebarWidth)

defineOptions({
  name: 'AiSidebarShell'
})

const { lectureInfo } = useLectureContext()

// 桌面端宽屏断点判定（>= 1200px）
const isDesktop = ref(false)
let resizeTimer: number | null = null

// 侧边栏无极拉伸与记忆状态常量
// ⚠️ 记忆键不再就地硬编码，改从 site.config.mts 的 STORAGE_KEYS.aiSidebarWidth 取；
// 键值本身未变（'lecture-ai-sidebar-custom-width'），老用户的记忆宽度照常读回。
const DEFAULT_WIDTH = 400
const MIN_WIDTH = 380
const EXPANDED_THRESHOLD = 420

const sidebarWidth = ref(DEFAULT_WIDTH)
const isDragging = ref(false)

// 是否处于宽屏拉伸展开状态 (> 420px)
const isExpanded = computed(() => sidebarWidth.value > EXPANDED_THRESHOLD)

// 计算当前窗口下的最大允许宽度：严格对齐用户规则（总宽减去现在的宽度，即 window.innerWidth - 400px）
function getMaxWidth(): number {
  if (typeof window === 'undefined') return 1200
  return Math.max(DEFAULT_WIDTH + 100, window.innerWidth - DEFAULT_WIDTH)
}

// 读取记忆的展开宽度：若无手动拖拽记录，则默认为当前窗口下的最大宽度
function getRememberedWidth(): number {
  if (typeof window === 'undefined') return 1200
  const maxW = getMaxWidth()
  const saved = readRawWithFallback(SIDEBAR_WIDTH_KEYS)
  if (saved) {
    const parsed = parseInt(saved, 10)
    if (!isNaN(parsed) && parsed > EXPANDED_THRESHOLD) {
      return Math.min(Math.max(EXPANDED_THRESHOLD, parsed), maxW)
    }
  }
  return maxW
}

// 圆形切换按钮悬停提示
const toggleBtnTooltip = computed(() => {
  if (isExpanded.value) {
    return '收缩回标准宽度 (400px)'
  }
  const remW = getRememberedWidth()
  return `拉伸至记忆宽度 (${remW}px)`
})

// 应用侧边栏宽度与动态字体缩放
function applyWidthAndFontScale(w: number) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const maxW = getMaxWidth()
  const clampedW = Math.min(Math.max(MIN_WIDTH, w), maxW)
  sidebarWidth.value = clampedW

  // 同步更新布局与 CSS 变量（仅作用于侧边栏自身浮动层，正文通过 --lec-ai-base-width 恒定保持 400px）
  document.documentElement.style.setProperty('--lec-ai-width', `${clampedW}px`)

  // 动态字体缩放计算：在 400px 时为 13.5px，在 maxW 时线性平滑放大至沉浸阅读模式 20px
  const minW = DEFAULT_WIDTH
  const ratio = Math.max(0, Math.min(1, (clampedW - minW) / Math.max(1, maxW - minW)))
  const fontSize = 13.5 + ratio * (20.0 - 13.5)
  const lineHeight = 1.6 + ratio * (2.15 - 1.6)
  document.documentElement.style.setProperty('--ai-chat-font-size', `${fontSize.toFixed(1)}px`)
  document.documentElement.style.setProperty('--ai-chat-line-height', `${lineHeight.toFixed(2)}`)
}

// 点击圆形按钮：在 400px 与记忆位置之间平滑切换
function toggleExpandCollapse() {
  if (isExpanded.value) {
    // 当前处于展开状态 -> 收缩回标准 400px
    applyWidthAndFontScale(DEFAULT_WIDTH)
  } else {
    // 当前处于标准状态 -> 拉伸至记忆宽度
    const targetW = getRememberedWidth()
    applyWidthAndFontScale(targetW)
  }
}

function handleMouseMove(e: MouseEvent) {
  if (!isDragging.value || typeof window === 'undefined') return
  const rawW = window.innerWidth - e.clientX
  applyWidthAndFontScale(rawW)
}

function handleMouseUp() {
  if (!isDragging.value) return
  isDragging.value = false
  if (typeof document !== 'undefined') {
    document.body.classList.remove('is-resizing-ai-sidebar')
  }
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mouseup', handleMouseUp)

  // 需求 4：若向左拖拽展开超过 420px，更新并持久化记忆至 localStorage
  // 若未达到 420px 则不覆盖既有的记忆展开宽度
  if (sidebarWidth.value > EXPANDED_THRESHOLD) {
    writeRawWithDualWrite(SIDEBAR_WIDTH_KEYS, String(sidebarWidth.value))
  }
}

function startResize(e?: MouseEvent) {
  if (typeof window === 'undefined') return
  if (e) {
    e.preventDefault()
  }
  isDragging.value = true
  if (typeof document !== 'undefined') {
    document.body.classList.add('is-resizing-ai-sidebar')
  }
  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mouseup', handleMouseUp)
}

/**
 * 同步分屏推挤布局类名
 * 仅在桌面端展开时向 documentElement 注入 .has-ai-split；
 * 收起或窄屏时立即彻底清除，确保 100% 零残留恢复。
 */
const syncSplitLayoutClass = () => {
  if (typeof document === 'undefined') return
  const shouldSplit = aiState.isOpen && isDesktop.value
  document.documentElement.classList.toggle('has-ai-split', shouldSplit)
}

// 监听侧边栏开关状态变化
watch(
  () => aiState.isOpen,
  () => {
    syncSplitLayoutClass()
  }
)

/**
 * 窗口尺寸响应防抖监听
 */
const handleResize = () => {
  if (typeof window === 'undefined') return
  if (resizeTimer !== null) {
    window.clearTimeout(resizeTimer)
  }
  resizeTimer = window.setTimeout(() => {
    const currentWide = window.innerWidth >= 1200
    if (isDesktop.value !== currentWide) {
      isDesktop.value = currentWide
      syncSplitLayoutClass()
    }
    // 若当前处于展开状态，窗口变窄时自动重新夹取最大允许宽度，防止超出屏幕
    if (isExpanded.value) {
      const maxW = getMaxWidth()
      if (sidebarWidth.value > maxW) {
        applyWidthAndFontScale(maxW)
      }
    }
  }, 100)
}

/**
 * 全局键盘快捷键处理器
 * Ctrl+J / Cmd+J 快速切换伴读侧边栏显隐；
 * Esc 在侧边栏开启时快速关闭。
 */
const handleKeydown = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault()
    aiState.toggleSidebar()
    return
  }

  if (e.key === 'Escape' && aiState.isOpen) {
    e.preventDefault()
    aiState.closeSidebar()
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    isDesktop.value = window.innerWidth >= 1200
    // 初始化为默认标准宽度 400px
    applyWidthAndFontScale(DEFAULT_WIDTH)
    window.addEventListener('keydown', handleKeydown)
    window.addEventListener('resize', handleResize, { passive: true })
    syncSplitLayoutClass()
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown)
    window.removeEventListener('resize', handleResize)
    window.removeEventListener('mousemove', handleMouseMove)
    window.removeEventListener('mouseup', handleMouseUp)
  }
  if (resizeTimer !== null) {
    window.clearTimeout(resizeTimer)
    resizeTimer = null
  }
  // 卸载时彻底移除分屏布局类名，零残留
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('has-ai-split')
    document.body.classList.remove('is-resizing-ai-sidebar')
  }
})
</script>

<template>
  <!-- 1. 未展开状态：屏幕右侧边缘半圆角矩形唤出标 (纯图标极简形态) -->
  <transition name="ai-trigger-fade">
    <button
      v-if="!aiState.isOpen"
      class="ai-trigger-tab"
      type="button"
      title="展开 AI 伴读 (Ctrl+J / Cmd+J)"
      aria-label="展开 AI 伴读"
      @click="aiState.openSidebar()"
    >
      <span class="ai-trigger-icon" v-html="ICONS.chipCore"></span>
    </button>
  </transition>

  <!-- 2. 移动端/窄屏滑出抽屉遮罩背景 -->
  <transition name="ai-fade">
    <div
      v-if="aiState.isOpen && !isDesktop"
      class="ai-backdrop"
      aria-hidden="true"
      @click="aiState.closeSidebar()"
    />
  </transition>

  <!-- 3. AI 伴读侧边栏面板容器 (支持左右无极拉伸与动态字号缩放) -->
  <aside
    class="ai-sidebar-shell"
    :class="{
      'is-open': aiState.isOpen,
      'is-desktop': isDesktop,
      'is-mobile': !isDesktop,
      'is-resizing': isDragging,
      'is-expanded': isExpanded
    }"
    :style="isDesktop ? { width: `${sidebarWidth}px` } : undefined"
    :aria-hidden="!aiState.isOpen"
    aria-label="AI 伴读侧边栏"
  >
    <!-- 左边缘拉伸微手柄 (按住左右无极调节) -->
    <div
      v-if="isDesktop && aiState.isOpen"
      class="ai-resizer-handle"
      title="按住左右拖拽调节侧边栏宽度与阅读字体大小"
      @mousedown="startResize"
    >
      <div class="ai-resizer-line"></div>
    </div>

    <!-- 左边缘圆形拉伸/收缩切换按钮 (Circular Toggle Button) -->
    <button
      v-if="isDesktop && aiState.isOpen"
      type="button"
      class="ai-sidebar-toggle-btn"
      :class="{ 'is-expanded': isExpanded }"
      :title="toggleBtnTooltip"
      :aria-label="toggleBtnTooltip"
      @click.stop="toggleExpandCollapse"
      @mousedown.stop
    >
      <span
        class="toggle-btn-icon"
        v-html="isExpanded ? ICONS.chevronRight : ICONS.chevronLeft"
      ></span>
    </button>

    <!-- 侧边栏主体区域（单层结构，杜绝双重顶栏） -->
    <div class="ai-shell-body">
      <slot>
        <!-- 默认插槽占位内容 -->
        <div class="ai-shell-placeholder">
          <div class="ai-placeholder-badge" v-html="ICONS.chipCore"></div>
          <div class="ai-placeholder-title">
            {{ lectureInfo.lectureId ? `${lectureInfo.lectureId.toUpperCase()} 伴读就绪` : '伴读工作台已就绪' }}
          </div>
          <div class="ai-placeholder-desc">
            已接入全站讲义知识图谱，可随时划词或输入工程技术疑问。
          </div>
          <div class="ai-placeholder-shortcut">
            快捷键 <kbd>Ctrl+J</kbd> 或 <kbd>Cmd+J</kbd> 快速切换显隐
          </div>
        </div>
      </slot>
    </div>
  </aside>
</template>

<style scoped>
/* 唤出条快捷键指示器 */
.ai-trigger-key {
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-3);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono, monospace);
  letter-spacing: 0;
}

/* 唤出条淡入淡出动画 */
.ai-trigger-fade-enter-active,
.ai-trigger-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.ai-trigger-fade-enter-from,
.ai-trigger-fade-leave-to {
  opacity: 0;
  transform: translateY(-50%) translateX(100%);
}

/* 窄屏遮罩层 */
.ai-backdrop {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  -webkit-backdrop-filter: blur(2px);
  z-index: 190;
}
.ai-fade-enter-active,
.ai-fade-leave-active {
  transition: opacity 0.22s ease;
}
.ai-fade-enter-from,
.ai-fade-leave-to {
  opacity: 0;
}

/* 侧边栏面板骨架 */
.ai-sidebar-shell {
  position: fixed;
  right: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--vp-c-bg);
  box-sizing: border-box;
  transform: translateX(100%);
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.28s;
  visibility: hidden;
  pointer-events: none;
}

.ai-sidebar-shell.is-open {
  transform: translateX(0);
  visibility: visible;
  pointer-events: auto;
}

/* 拖拽无极拉伸调整手柄 (加宽热区与高亮条，解决不易进入交互问题) */
.ai-resizer-handle {
  position: absolute;
  left: -8px;
  top: 0;
  bottom: 0;
  width: 16px; /* 加宽热区至 16px，确保鼠标极易捕获与进入拖拽交互 */
  cursor: ew-resize;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.ai-resizer-line {
  width: 3px;
  height: 48px;
  border-radius: 2px;
  background: var(--vp-c-divider);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.ai-resizer-handle:hover .ai-resizer-line,
.ai-sidebar-shell.is-resizing .ai-resizer-line {
  background: var(--vp-c-brand-1);
  height: 84px;
  width: 5px; /* 加宽至 5px 饱满蓝色交互条 */
  border-radius: 3px;
  box-shadow: 0 0 12px var(--vp-c-brand-1);
}

/* 圆形拉伸与收缩切换按钮 (向左移动，与拖拉线严格保持 10px 间距，彻底消除重叠冲突) */
.ai-sidebar-toggle-btn {
  position: absolute;
  right: calc(100% + 10px); /* 位于侧栏左边界以左，预留 10px 独立操作空间 */
  left: auto;
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 60;
  color: var(--vp-c-text-2);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  padding: 0;
  outline: none;
}

.ai-sidebar-toggle-btn:hover {
  background: var(--vp-c-bg);
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18), 0 0 0 2px rgba(59, 130, 246, 0.2);
  transform: translateY(-50%) scale(1.08);
}

.ai-sidebar-toggle-btn:active {
  transform: translateY(-50%) scale(0.95);
}

.toggle-btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.toggle-btn-icon :deep(svg) {
  width: 14px;
  height: 14px;
}

.ai-sidebar-shell.is-resizing {
  transition: none !important;
  user-select: none;
}

/* 桌面端分屏布局规格 */
.ai-sidebar-shell.is-desktop {
  top: var(--vp-nav-height, 64px);
  bottom: 0;
  width: var(--lec-ai-width, 400px);
  height: calc(100vh - var(--vp-nav-height, 64px));
  border-left: 1px solid var(--vp-c-divider);
  box-shadow: -4px 0 20px rgba(0, 0, 0, 0.08);
  z-index: 50; /* 桌面端浮层层级高于正文 (.VPDoc)，但严格低于 VitePress 顶栏 (z-index: 100/110) */
  transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1),
              width 0.28s cubic-bezier(0.16, 1, 0.3, 1),
              box-shadow 0.28s ease,
              visibility 0.28s;
}

.ai-sidebar-shell.is-desktop.is-expanded,
.ai-sidebar-shell.is-desktop.is-resizing {
  box-shadow: -10px 0 36px rgba(0, 0, 0, 0.18), -2px 0 8px rgba(0, 0, 0, 0.08);
}

/* 移动端/窄屏滑出抽屉规格 */
.ai-sidebar-shell.is-mobile {
  top: 0;
  bottom: 0;
  width: min(420px, 88vw);
  height: 100vh;
  box-shadow: -8px 0 32px rgba(0, 0, 0, 0.28);
  z-index: 200;
}

/* 侧边栏顶栏 */
.ai-shell-header {
  height: 52px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg-elv);
  flex-shrink: 0;
}

.ai-shell-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  user-select: none;
}

.ai-brand-icon {
  display: flex;
  align-items: center;
  color: var(--vp-c-brand-1);
}

.ai-brand-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  letter-spacing: 0.3px;
}

.ai-lecture-chip {
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 999px;
  background-color: rgba(59, 130, 246, 0.1);
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono, monospace);
  border: 1px solid rgba(59, 130, 246, 0.2);
}

.ai-shell-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ai-close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: all 0.15s ease;
}

.ai-close-btn:hover {
  background-color: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-divider);
}

.ai-btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 侧边栏内容主体 */
.ai-shell-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background-color: var(--vp-c-bg);
}

/* 默认占位界面（极简工程风） */
.ai-shell-placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 24px;
  text-align: center;
}

.ai-placeholder-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background-color: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-brand-1);
  margin-bottom: 14px;
}

.ai-placeholder-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  margin-bottom: 8px;
}

.ai-placeholder-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
  max-width: 260px;
  margin-bottom: 16px;
}

.ai-placeholder-shortcut {
  font-size: 11px;
  color: var(--vp-c-text-3);
}

.ai-placeholder-shortcut kbd {
  font-size: 10px;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono, monospace);
  color: var(--vp-c-text-2);
}
</style>

<!-- 全局布局与分屏推挤规则（零残留，随 .has-ai-split 动态生效） -->
<style>
@media (min-width: 1200px) {
  /* 沉浸阅读模式联动：阅读模式切换按钮平滑让位 */
  html.has-ai-split #lecture-reading-btn {
    right: calc(var(--lec-ai-width, 400px) + 20px) !important;
    transition: right 0.28s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* 拖拽过程中禁用阅读按钮过渡，确保极致跟手 */
  body.is-resizing-ai-sidebar #lecture-reading-btn {
    transition: none !important;
  }

  /* 屏幕宽度在 1200px~1540px 时隐藏右侧小纲，避免挤压正文与交互图表 */
  @media (max-width: 1540px) {
    html.has-ai-split:not(.reading-mode) .VPDoc .aside,
    html.has-ai-split:not(.reading-mode) .VPDocAside {
      display: none !important;
    }
  }
}
</style>
