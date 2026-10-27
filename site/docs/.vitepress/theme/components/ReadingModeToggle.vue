<script setup lang="ts">
/**
 * ReadingModeToggle.vue — 顶栏内嵌沉浸式阅读切换按钮
 * 
 * 职责：
 *   作为顶栏原生一级组件（嵌入 nav-bar-content-after 插槽，位于主题开关与分割线右侧）；
 *   提供沉浸阅读与普通阅读的一键平滑切换，状态持久化到 localStorage；
 *   路由范围：仅在首页关闭（隐藏按键），在所有课程组页与讲义页均支持开启；
 *   离开首页进入组或讲义页时依据 localStorage 自动恢复沉浸状态。
 * 
 * 铁律：零 Emoji、纯工程矢量 SVG、SSR 安全防护、双向生命周期防御与实时响应。
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vitepress'

const KEY = 'lecture-reading-mode'
const route = useRoute()

// 仅在首页关闭（/ 或 /index.html 或空路径），组页与讲义页全面开启沉浸模式
const isHome = computed(() => {
  const p = (route.path || '').replace(/index(?:\.html)?$/, '').replace(/\.html$/, '')
  return p === '' || p === '/'
})

function getSavedMode(): boolean {
  if (typeof window === 'undefined') return false
  const p = (window.location.pathname || '').replace(/index(?:\.html)?$/, '').replace(/\.html$/, '')
  if (p === '' || p === '/') return false
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

// 客户端初始化时直接取 localStorage 状态，杜绝任何生命周期延迟或先假后真
const isReadingMode = ref(getSavedMode())

function syncState() {
  if (typeof document === 'undefined') return
  const p = (route.path || (typeof window !== 'undefined' ? window.location.pathname : '')).replace(/index(?:\.html)?$/, '').replace(/\.html$/, '')
  const home = p === '' || p === '/'
  if (home) {
    document.documentElement.classList.remove('reading-mode')
    isReadingMode.value = false
    return
  }

  let saved = false
  try {
    saved = localStorage.getItem(KEY) === '1'
  } catch {}
  const hasClass = document.documentElement.classList.contains('reading-mode')
  const shouldBeActive = saved || hasClass

  if (document.documentElement.classList.contains('reading-mode') !== shouldBeActive) {
    document.documentElement.classList.toggle('reading-mode', shouldBeActive)
  }
  isReadingMode.value = shouldBeActive
}

function toggleReadingMode() {
  if (typeof document === 'undefined') return
  const next = !document.documentElement.classList.contains('reading-mode')
  document.documentElement.classList.toggle('reading-mode', next)
  isReadingMode.value = next
  try {
    localStorage.setItem(KEY, next ? '1' : '0')
  } catch {
    // 忽略无痕隐私模式异常
  }
  // 触发全局 resize 事件，使 ECharts 与 Markmap 响应版心宽度变化自动重新标定视口
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'))
  }, 50)
}

// 路由监听：如果在首页则强制清退 reading-mode 类；离开首页进入组或讲义页则依 localStorage 恢复
watch(
  () => route.path,
  () => {
    if (typeof document === 'undefined') return
    syncState()
    setTimeout(() => window.dispatchEvent(new Event('resize')), 80)
  },
  { immediate: true }
)

let classObserver: MutationObserver | null = null

onMounted(() => {
  if (typeof window === 'undefined') return
  syncState()

  // 挂载 MutationObserver 实时监听 html class 变动，确保外部任何脚本（如 reading-mode.ts）改变 reading-mode 时，按钮状态绝对 100% 同步
  if (typeof MutationObserver !== 'undefined') {
    classObserver = new MutationObserver(() => {
      const inReading = document.documentElement.classList.contains('reading-mode')
      if (isReadingMode.value !== inReading) {
        isReadingMode.value = inReading
      }
    })
    classObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    })
  }
})

onUnmounted(() => {
  if (classObserver) {
    classObserver.disconnect()
    classObserver = null
  }
})
</script>

<template>
  <div v-if="!isHome" class="reading-mode-nav-wrapper">
    <button
      type="button"
      class="reading-mode-nav-btn"
      :class="{ 'is-active': isReadingMode }"
      :title="isReadingMode ? '退出沉浸式阅读 (恢复侧栏与标准版心)' : '开启沉浸式阅读 (放宽全景版心，聚焦阅读)'"
      :aria-label="isReadingMode ? '退出沉浸' : '沉浸阅读'"
      :aria-pressed="isReadingMode"
      @click="toggleReadingMode"
    >
      <span class="rm-icon">
        <!-- 专注阅读工程矢量 SVG -->
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
      </span>
      <span class="rm-text">{{ isReadingMode ? '退出沉浸' : '沉浸阅读' }}</span>
    </button>
  </div>
</template>

<style scoped>
.reading-mode-nav-wrapper {
  display: flex;
  align-items: center;
  margin-left: 8px;
}

.reading-mode-nav-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 11px;
  border-radius: 6px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-2);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
}

.reading-mode-nav-btn:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-elv);
}

.reading-mode-nav-btn.is-active,
:global(html.reading-mode) .reading-mode-nav-btn {
  background: var(--vp-c-brand-1) !important;
  border-color: var(--vp-c-brand-1) !important;
  color: #ffffff !important;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12) !important;
}

.reading-mode-nav-btn.is-active .rm-icon,
.reading-mode-nav-btn.is-active .rm-text,
:global(html.reading-mode) .reading-mode-nav-btn .rm-icon,
:global(html.reading-mode) .reading-mode-nav-btn .rm-text {
  color: #ffffff !important;
}

.rm-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.rm-text {
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}
</style>
