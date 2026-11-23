<script setup lang="ts">
/**
 * ReadingModeToggle.vue — 顶栏内嵌沉浸式阅读切换按钮
 *
 * 职责：
 *   作为顶栏原生一级组件（嵌入 nav-bar-content-after 插槽，位于主题开关与分割线右侧）；
 *   提供沉浸阅读与普通阅读的一键平滑切换，状态持久化到 localStorage（core/storage，键名不变）；
 *   路由范围：仅在首页关闭（隐藏按键），在所有课程组页与讲义页均支持开启；
 *   离开首页进入组或讲义页时依据 localStorage 自动恢复沉浸状态（reading/readingMode）。
 *
 * SSR / hydration：按钮状态初值恒为 false（服务端与客户端首帧一致，FE-037），
 * onMounted 后再从 html.reading-mode 同步。首帧的 html 类由 config.mts 的 <head> 内联脚本加上，
 * 激活态样式同时挂在 `html.reading-mode .reading-mode-nav-btn` 上，因此不会闪烁。
 *
 * 铁律：零 Emoji、纯工程矢量 SVG、SSR 安全防护、双向生命周期防御与实时响应。
 */

import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute } from 'vitepress'
import { isHome as isHomePath } from '../core/route'
import { getLocaleKeys } from '../core/locales'
import { setFlag } from '../core/storage'
import { applyReadingMode, READING_MODE_CLASS } from '../reading/readingMode'
import { useT } from '../../i18n/useT.ts'

const route = useRoute()
const { t } = useT()

// 仅在首页关闭（/ 或 /index.html 或空路径），组页与讲义页全面开启沉浸模式
const isHome = computed(() => isHomePath(route.path || '', '/', getLocaleKeys()))

const isReadingMode = ref(false)

function syncState() {
  if (typeof document === 'undefined') return
  isReadingMode.value = applyReadingMode(route.path || window.location.pathname)
}

function toggleReadingMode() {
  if (typeof document === 'undefined') return
  const next = !document.documentElement.classList.contains(READING_MODE_CLASS)
  document.documentElement.classList.toggle(READING_MODE_CLASS, next)
  isReadingMode.value = next
  setFlag('readingMode', next)
  // 触发全局 resize 事件，使 ECharts 与地图组件响应版心宽度变化自动重新标定视口
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
  }
)

let classObserver: MutationObserver | null = null

// V1 timing kept: one resize 80 ms after client setup (V1's `immediate` route watcher did this;
// ECharts / map components refit on it). Only the DOM-touching sync is deferred to onMounted.
if (typeof window !== 'undefined') {
  setTimeout(() => window.dispatchEvent(new Event('resize')), 80)
}

onMounted(() => {
  syncState()

  // MutationObserver 监听 html class 变动，确保外部（reading/readingMode）改变 reading-mode 时按钮状态同步
  if (typeof MutationObserver !== 'undefined') {
    classObserver = new MutationObserver(() => {
      const inReading = document.documentElement.classList.contains(READING_MODE_CLASS)
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
      :title="isReadingMode ? t('reading.toggle.exitTitle') : t('reading.toggle.enterTitle')"
      :aria-label="isReadingMode ? t('reading.toggle.exit') : t('reading.toggle.enter')"
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
      <span class="rm-text">{{ isReadingMode ? t('reading.toggle.exit') : t('reading.toggle.enter') }}</span>
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
html.reading-mode .reading-mode-nav-btn {
  background: var(--vp-c-brand-1) !important;
  border-color: var(--vp-c-brand-1) !important;
  color: var(--lec-on-accent) !important;
  box-shadow: none !important;
}

.reading-mode-nav-btn.is-active .rm-icon,
.reading-mode-nav-btn.is-active .rm-text,
html.reading-mode .reading-mode-nav-btn .rm-icon,
html.reading-mode .reading-mode-nav-btn .rm-text {
  color: var(--lec-on-accent) !important;
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

@media (min-width: 768px) and (max-width: 1023px) {
  .rm-text {
    display: none;
  }
  .reading-mode-nav-btn {
    gap: 0;
    padding-left: 8px;
    padding-right: 8px;
  }
}

@media (max-width: 767px) {
  .reading-mode-nav-wrapper {
    margin-left: 0;
  }
  .reading-mode-nav-btn {
    width: 40px;
    height: 40px;
    padding: 0;
    justify-content: center;
    gap: 0;
  }
  .rm-text {
    display: none;
  }
}
</style>
