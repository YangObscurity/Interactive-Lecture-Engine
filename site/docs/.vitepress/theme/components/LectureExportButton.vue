<script setup lang="ts">
/**
 * LectureExportButton.vue — 讲义出版级长卷 PDF / 全景长图 / A4 多页导出套件
 *
 * 核心设计原则：
 * 1. 【一整张长卷 PDF】：单页连续延伸，零分页切断，原生矢量无损，文本支持检索复制；
 * 2. 【全景超清长图】：1200px 出版级阅读宽度，GPU 自适应抗截断，适合移动端与分享；
 * 3. 【出版级 A4 多页 PDF】：标准 A4 纸张多页排版，代码/图表/表格智能防跨页截断，带页码适合装订；
 * 4. 【双模自适应】：优先直连预生成静态产物 / 服务端无头 Chromium 按需生成；纯静态环境平滑降级为端侧生成。
 */

import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useData } from 'vitepress'
import { LECTURE_EXPORT } from '../../export.config'

const route = useRoute()
const { frontmatter } = useData()

// 讲义页面路由判定（结构判据，解耦具体课程组代号）
const isLecture = computed(() => {
  const p = route.path || ''
  return /\/[^/]+\/L\d+(?:\.html)?\/?$/i.test(p)
})

type ExportType = 'continuous' | 'png' | 'a4'

const isOpen = ref(false)
const isExporting = ref(false)
const exportProgressText = ref('')
const exportBtnRef = ref<HTMLButtonElement | null>(null)
const dropdownRef = ref<HTMLElement | null>(null)

// 友好 Toast 提示
const toastMessage = ref('')
const toastType = ref<'error' | 'warn' | 'info' | 'success'>('info')
let toastTimer: ReturnType<typeof setTimeout> | null = null

function showToast(msg: string, type: 'error' | 'warn' | 'info' | 'success' = 'info') {
  toastMessage.value = msg
  toastType.value = type
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastMessage.value = ''
  }, 4500)
}

function dismissToast() {
  toastMessage.value = ''
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
}

function toggleMenu() {
  if (isExporting.value) return
  isOpen.value = !isOpen.value
}

function closeMenu() {
  isOpen.value = false
}

function handlePointerDownOutside(e: PointerEvent | MouseEvent) {
  if (!isOpen.value) return
  if (dropdownRef.value && !dropdownRef.value.contains(e.target as Node)) {
    closeMenu()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen.value) {
    e.preventDefault()
    closeMenu()
    exportBtnRef.value?.focus()
  }
}

/** 取讲义标题作为下载文件名的主干（清洗 Windows 保留字符） */
function getLectureTitle(): string {
  const sanitize = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim()
  const fmTitle = frontmatter.value?.title
  if (fmTitle) return sanitize(String(fmTitle))
  const h1 = document.querySelector('.vp-doc h1')
  if (h1?.textContent) return sanitize(h1.textContent)
  return LECTURE_EXPORT.fallbackTitle
}

/** 从当前路由解析「组目录 + 讲次号」 */
function parseRouteInfo(): { groupKey: string; lecture: string } | null {
  const p = route.path || ''
  const m = p.match(/^\/(.+?)\/(L\d+)(?:\.html)?\/?$/i)
  if (!m) return null
  return { groupKey: m[1].toLowerCase(), lecture: m[2].toUpperCase() }
}

/** 构造静态资产 URL */
function assetUrl(info: { groupKey: string; lecture: string }, type: ExportType): string {
  const suffix = LECTURE_EXPORT.types[type].suffix
  return `${LECTURE_EXPORT.exportsPublicPath}/${info.groupKey}/${info.lecture}/${info.lecture}${suffix}`
}

/** 构造下载文件名 */
function buildFileName(info: { lecture: string }, type: ExportType): string {
  const tpl = LECTURE_EXPORT.fileNameTemplate[type]
  return tpl.replace('{title}', getLectureTitle()).replace('{lecture}', info.lecture)
}

/** 触发浏览器原生下载 */
function triggerDownload(url: string, fileName: string) {
  const link = document.createElement('a')
  link.download = fileName
  link.href = url
  link.target = '_blank'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

/** 核心统一导出调度器 */
async function handleExport(type: ExportType) {
  if (isExporting.value) return
  closeMenu()
  dismissToast()
  isExporting.value = true

  const info = parseRouteInfo()
  if (!info) {
    isExporting.value = false
    return
  }

  const url = assetUrl(info, type)
  const fileName = buildFileName(info, type)

  // 1. 尝试直接下载已就绪的静态产物
  try {
    const headRes = await fetch(url, { method: 'HEAD' }).catch(() => null)
    if (headRes && headRes.ok && !headRes.headers.get('content-type')?.includes('text/html')) {
      showToast(`正在下载: ${fileName}`, 'success')
      triggerDownload(url, fileName)
      setTimeout(() => {
        isExporting.value = false
      }, 800)
      return
    }
  } catch {}

  // 2. 尝试调用后端无头 Chromium 按需即时生成
  exportProgressText.value = type === 'continuous'
    ? '正在启动无头 Chromium 矢量生成一整张长卷 PDF...'
    : type === 'png'
    ? '正在启动无头 Chromium 渲染全景超清长图...'
    : '正在排版生成出版级 A4 多页 PDF...'

  try {
    const genRes = await fetch(
      `${LECTURE_EXPORT.apiPath}?group=${encodeURIComponent(info.groupKey)}&lecture=${encodeURIComponent(info.lecture)}&type=${type}`,
      { method: 'POST' }
    ).catch(() => null)

    if (genRes && genRes.ok) {
      const data = await genRes.json().catch(() => null)
      if (data && data.ok) {
        showToast(`生成完毕，正在下载: ${fileName}`, 'success')
        triggerDownload(url, fileName)
        setTimeout(() => {
          isExporting.value = false
          exportProgressText.value = ''
        }, 800)
        return
      }
    }
  } catch {}

  // 3. 优雅端侧降级（保证纯静态环境或离线时 100% 可用）
  if (type === 'continuous') {
    exportProgressText.value = '正在准备单页长卷打印...'
    await exportContinuousPdfFallback()
  } else if (type === 'png') {
    exportProgressText.value = '正在前端合成全景长图...'
    await exportLongImagePngFallback(fileName)
  } else if (type === 'a4') {
    exportProgressText.value = '正在调起出版级 A4 打印...'
    await exportA4PdfFallback()
  }
}

/** 降级实现：端侧单页无缝长卷 PDF 打印 */
async function exportContinuousPdfFallback() {
  const docEl = (document.querySelector('.VPDoc') || document.querySelector('.vp-doc')) as HTMLElement
  if (!docEl) {
    isExporting.value = false
    return
  }

  const w = 960
  const h = Math.ceil(Math.max(docEl.scrollHeight, docEl.offsetHeight)) + 40

  const styleId = '__lecture_continuous_print_style__'
  let styleEl = document.getElementById(styleId) as HTMLStyleElement
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = styleId
    document.head.appendChild(styleEl)
  }

  styleEl.textContent = `
    @page {
      size: ${w}px ${h}px !important;
      margin: 0 !important;
    }
    @media print {
      html, body {
        width: ${w}px !important;
        height: ${h}px !important;
        max-height: ${h}px !important;
        overflow: hidden !important;
        margin: 0 !important;
        padding: 0 !important;
        background: #ffffff !important;
        color: #1e293b !important;
      }
      .VPNav, .VPLocalNav, .VPSidebar, .aside, .VPDocAside, .reading-mode-nav-wrapper,
      .lecture-export-wrapper, .lecture-export-toast, .lecture-export-hud-overlay,
      .ai-sidebar-shell, .selection-toolbar-root, .lecture-progress-card,
      .VPDocFooter, .edit-link, .next-and-prev-link, .chart-tools, details.chart-code {
        display: none !important;
      }
      .VPContent, .VPDoc {
        width: ${w}px !important;
        max-width: ${w}px !important;
        margin: 0 auto !important;
        padding: 24px 32px !important;
        box-sizing: border-box !important;
      }
      .vp-doc {
        font-size: 16px !important;
      }
      * {
        break-inside: auto !important;
        page-break-inside: auto !important;
      }
    }
  `

  showToast('已唤起长卷打印面板：目标请选「另存为 PDF」并勾选「背景图形」', 'info')

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
    window.removeEventListener('afterprint', cleanup)
    isExporting.value = false
    exportProgressText.value = ''
  }

  window.addEventListener('afterprint', cleanup)
  setTimeout(() => window.print(), 100)
  setTimeout(() => { if (!cleanedUp) cleanup() }, 60000)
}

/** 降级实现：端侧出版级 A4 多页 PDF 打印 */
async function exportA4PdfFallback() {
  const styleId = '__lecture_a4_print_style__'
  let styleEl = document.getElementById(styleId) as HTMLStyleElement
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = styleId
    document.head.appendChild(styleEl)
  }

  styleEl.textContent = `
    @page {
      size: A4 portrait;
      margin: 16mm 14mm 16mm 14mm;
      @bottom-center {
        content: counter(page);
        font-size: 9pt;
        color: #64748b;
      }
    }
    @media print {
      html, body {
        background: #ffffff !important;
        color: #1e293b !important;
        width: 100% !important;
        height: auto !important;
      }
      .VPNav, .VPLocalNav, .VPSidebar, .aside, .VPDocAside, .reading-mode-nav-wrapper,
      .lecture-export-wrapper, .lecture-export-toast, .lecture-export-hud-overlay,
      .ai-sidebar-shell, .selection-toolbar-root, .lecture-progress-card,
      .VPDocFooter, .edit-link, .next-and-prev-link, .chart-tools, details.chart-code {
        display: none !important;
      }
      .VPContent, .VPDoc {
        max-width: 860px !important;
        margin: 0 auto !important;
        padding: 0 !important;
      }
      figure.chart, table, tr, details.details, pre, .vp-code-block,
      .wave-compare-grid, .scope-viewer {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      h1, h2, h3, h4 {
        break-after: avoid !important;
        page-break-after: avoid !important;
      }
    }
  `

  showToast('已唤起标准 A4 打印：目标请选「另存为 PDF」并勾选「背景图形」', 'info')

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
    window.removeEventListener('afterprint', cleanup)
    isExporting.value = false
    exportProgressText.value = ''
  }

  window.addEventListener('afterprint', cleanup)
  setTimeout(() => window.print(), 100)
  setTimeout(() => { if (!cleanedUp) cleanup() }, 60000)
}

/** 降级实现：端侧合成 1200px 高清长图 */
async function exportLongImagePngFallback(fileName: string) {
  try {
    const { toPng } = await import('html-to-image')
    const docEl = (document.querySelector('.VPDoc') || document.querySelector('.vp-doc')) as HTMLElement
    if (!docEl) throw new Error('未找到正文容器')

    const isDark = document.documentElement.classList.contains('dark')
    const bgColor = isDark ? '#1a1a1a' : '#ffffff'
    const scrollH = docEl.scrollHeight || docEl.offsetHeight

    let pixelRatio = 1.6
    if (scrollH * pixelRatio > 16000) {
      pixelRatio = Math.max(1.0, Math.floor((15800 / scrollH) * 100) / 100)
    }

    const dataUrl = await toPng(docEl, {
      pixelRatio,
      backgroundColor: bgColor,
      skipAutoScale: false,
      filter: (node: Node) => {
        if (node instanceof HTMLElement) {
          if (node.classList.contains('ai-sidebar-shell')) return false
          if (node.classList.contains('selection-toolbar-root')) return false
          if (node.classList.contains('reading-mode-nav-wrapper')) return false
          if (node.classList.contains('lecture-export-wrapper')) return false
          if (node.classList.contains('lecture-export-hud-overlay')) return false
          if (node.classList.contains('lecture-export-toast')) return false
          if (node.classList.contains('VPDocAside')) return false
          if (node.classList.contains('aside')) return false
          if (node.classList.contains('VPDocFooter')) return false
          if (node.classList.contains('edit-link')) return false
          if (node.classList.contains('next-and-prev-link')) return false
          if (node.classList.contains('chart-tools')) return false
          if (node.classList.contains('chart-code')) return false
        }
        return true
      },
    })

    triggerDownload(dataUrl, fileName)
    showToast('全景高清长图已成功生成并下载！', 'success')
  } catch (err: any) {
    showToast(`长图生成异常: ${err?.message || '画布超限'}，推荐改用「长卷 PDF」`, 'error')
  } finally {
    isExporting.value = false
    exportProgressText.value = ''
  }
}

watch(() => route.path, () => {
  closeMenu()
  dismissToast()
})

watch(isOpen, (val) => {
  if (typeof window === 'undefined') return
  if (val) {
    window.addEventListener('pointerdown', handlePointerDownOutside)
    window.addEventListener('keydown', handleKeydown)
  } else {
    window.removeEventListener('pointerdown', handlePointerDownOutside)
    window.removeEventListener('keydown', handleKeydown)
  }
})

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', handlePointerDownOutside)
    window.removeEventListener('keydown', handleKeydown)
  }
  dismissToast()
})
</script>

<template>
  <div v-if="isLecture" ref="dropdownRef" class="lecture-export-wrapper">
    <!-- 主触发按钮 -->
    <button
      ref="exportBtnRef"
      type="button"
      class="lecture-export-btn"
      :class="{
        'is-loading': isExporting,
        'is-active': isOpen,
      }"
      :title="isExporting ? exportProgressText : '讲义导出：单页长卷 PDF / 全景长图 / A4 多页'"
      :aria-expanded="isOpen"
      :disabled="isExporting"
      aria-haspopup="menu"
      aria-controls="lecture-export-menu"
      aria-label="讲义导出菜单"
      @click="toggleMenu"
    >
      <span class="export-icon">
        <svg
          v-if="isExporting"
          class="spin-icon"
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        >
          <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
          <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      </span>
      <span class="export-text">
        {{ isExporting ? '处理中...' : '导出讲义' }}
      </span>
      <span class="export-chevron">
        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
    </button>

    <!-- 下拉弹出面板 -->
    <transition name="export-fade">
      <div
        v-if="isOpen"
        id="lecture-export-menu"
        class="lecture-export-dropdown"
        role="menu"
        aria-label="导出格式选项"
      >
        <div class="dropdown-header">
          <div class="dropdown-title">讲义完整版导出</div>
          <div class="dropdown-sub">
            支持单页无缝长卷、超清长图与出版级 A4 多页规格
          </div>
        </div>

        <div class="dropdown-options">
          <!-- 选项 1：一整张长卷 PDF -->
          <button
            type="button"
            class="option-item is-recommend"
            role="menuitem"
            tabindex="0"
            @click="handleExport('continuous')"
          >
            <div class="option-icon scroll-badge">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" />
                <line x1="9" y1="15" x2="15" y2="15" />
              </svg>
            </div>
            <div class="option-content">
              <div class="option-title">
                <span>一整张长卷 PDF</span>
                <span class="badge-tag rec">推荐 · 单页连续</span>
              </div>
              <div class="option-desc">
                单页连续延伸，零分页切断，原生矢量排版，文字支持检索复制
              </div>
            </div>
          </button>

          <!-- 选项 2：全景超清长图 PNG -->
          <button
            type="button"
            class="option-item"
            role="menuitem"
            tabindex="0"
            @click="handleExport('png')"
          >
            <div class="option-icon img-badge">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
            </div>
            <div class="option-content">
              <div class="option-title">
                <span>全景超清长图</span>
                <span class="badge-tag">PNG · 1200px</span>
              </div>
              <div class="option-desc">
                1200px 出版级宽度，高清晰度，适合移动端与社交分享
              </div>
            </div>
          </button>

          <!-- 选项 3：出版级标准 A4 PDF -->
          <button
            type="button"
            class="option-item"
            role="menuitem"
            tabindex="0"
            @click="handleExport('a4')"
          >
            <div class="option-icon a4-badge">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </div>
            <div class="option-content">
              <div class="option-title">
                <span>出版级 A4 多页 PDF</span>
                <span class="badge-tag">多页装订</span>
              </div>
              <div class="option-desc">
                标准 A4 规格多页排版，代码与图表智能防截断，带页码适合打印
              </div>
            </div>
          </button>
        </div>
      </div>
    </transition>

    <!-- 动态 HUD 遮罩 -->
    <transition name="hud-fade">
      <div v-if="isExporting" class="lecture-export-hud-overlay">
        <div class="lecture-export-hud-card">
          <div class="hud-spinner">
            <svg class="spin-icon-hud" viewBox="0 0 36 36">
              <circle class="hud-circle-bg" cx="18" cy="18" r="14" fill="none" stroke-width="3" />
              <circle class="hud-circle-val" cx="18" cy="18" r="14" fill="none" stroke-width="3" />
            </svg>
          </div>
          <div class="hud-text-area">
            <div class="hud-main-title">讲义导出处理中</div>
            <div class="hud-sub-desc">{{ exportProgressText }}</div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 提示 Toast -->
    <transition name="toast-fade">
      <div v-if="toastMessage" class="lecture-export-toast" :class="`type-${toastType}`">
        <span class="toast-body">
          <span class="toast-msg">{{ toastMessage }}</span>
        </span>
        <button type="button" class="toast-close" aria-label="关闭提示" @click="dismissToast">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.lecture-export-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  z-index: 20;
}

.lecture-export-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: nowrap;
}

.lecture-export-btn:hover {
  color: var(--vp-c-text-1);
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-bg-elv);
}

.lecture-export-btn:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.lecture-export-btn.is-loading {
  cursor: wait;
  opacity: 0.85;
}

.export-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.export-chevron {
  display: flex;
  align-items: center;
  opacity: 0.6;
  margin-left: 1px;
  transition: transform 0.2s;
}

.lecture-export-btn.is-active .export-chevron {
  transform: rotate(180deg);
}

.spin-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  100% {
    transform: rotate(360deg);
  }
}

@media (max-width: 640px) {
  .export-text {
    display: none;
  }
  .lecture-export-btn {
    padding: 0 7px;
    gap: 2px;
  }
}

.lecture-export-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 330px;
  max-width: calc(100vw - 24px);
  padding: 14px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-elv);
  box-shadow: 0 14px 36px -4px rgba(0, 0, 0, 0.12), 0 4px 14px -2px rgba(0, 0, 0, 0.06);
  z-index: 1000;
  white-space: normal;
}

.lecture-export-dropdown::before {
  content: '';
  position: absolute;
  top: -6px;
  right: 36px;
  width: 10px;
  height: 10px;
  background: var(--vp-c-bg-elv);
  border-left: 1px solid var(--vp-c-divider);
  border-top: 1px solid var(--vp-c-divider);
  transform: rotate(45deg);
  z-index: 1;
}

html.dark .lecture-export-dropdown {
  border-color: rgba(255, 255, 255, 0.1);
  box-shadow: 0 18px 42px -4px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.06);
}

html.dark .lecture-export-dropdown::before {
  border-left-color: rgba(255, 255, 255, 0.1);
  border-top-color: rgba(255, 255, 255, 0.1);
}

.dropdown-header {
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.dropdown-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  letter-spacing: -0.01em;
}

.dropdown-sub {
  font-size: 11.5px;
  color: var(--vp-c-text-2);
  margin-top: 3px;
  line-height: 1.4;
}

.dropdown-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.option-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 10px 11px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  text-align: left;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: normal;
}

.option-item:hover {
  background: var(--vp-c-bg);
  border-color: var(--vp-c-brand-1);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

html.dark .option-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

.option-item.is-recommend {
  border-color: rgba(16, 185, 129, 0.28);
  background: rgba(16, 185, 129, 0.04);
}

.option-item.is-recommend:hover {
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.08);
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.12);
}

.option-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  flex-shrink: 0;
  margin-top: 2px;
}

.scroll-badge {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.img-badge {
  background: rgba(59, 130, 246, 0.1);
  color: #3b82f6;
}

.a4-badge {
  background: rgba(139, 92, 246, 0.1);
  color: #8b5cf6;
}

.option-content {
  flex: 1;
}

.option-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.badge-tag {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 9999px;
  background: var(--vp-c-bg-mute);
  color: var(--vp-c-text-2);
  font-weight: 500;
  line-height: 1.3;
}

.badge-tag.rec {
  background: rgba(16, 185, 129, 0.14);
  border: 1px solid rgba(16, 185, 129, 0.24);
  color: #10b981;
  font-weight: 600;
}

.option-desc {
  font-size: 11.5px;
  color: var(--vp-c-text-3);
  margin-top: 3px;
  line-height: 1.4;
  word-break: break-word;
}

.export-fade-enter-active,
.export-fade-leave-active {
  transition: opacity 0.2s, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.export-fade-enter-from,
.export-fade-leave-to {
  opacity: 0;
  transform: translateY(-6px) scale(0.97);
}

.lecture-export-hud-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(3px);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.lecture-export-hud-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 24px;
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
  max-width: 90vw;
}

.hud-spinner {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.spin-icon-hud {
  width: 100%;
  height: 100%;
  animation: spin 1.2s linear infinite;
}

.hud-circle-bg {
  stroke: var(--vp-c-divider);
}

.hud-circle-val {
  stroke: var(--vp-c-brand-1);
  stroke-dasharray: 80 40;
  stroke-linecap: round;
}

.hud-text-area {
  display: flex;
  flex-direction: column;
}

.hud-main-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.hud-sub-desc {
  font-size: 12px;
  color: var(--vp-c-text-2);
  margin-top: 4px;
}

.hud-fade-enter-active,
.hud-fade-leave-active {
  transition: opacity 0.25s;
}

.hud-fade-enter-from,
.hud-fade-leave-to {
  opacity: 0;
}

.lecture-export-toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 10000;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 440px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--vp-c-bg-elv);
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  font-size: 12.5px;
  line-height: 1.4;
}

.lecture-export-toast.type-error {
  border-left: 4px solid #ef4444;
}

.lecture-export-toast.type-success {
  border-left: 4px solid #10b981;
}

.lecture-export-toast.type-info {
  border-left: 4px solid var(--vp-c-brand-1);
}

.toast-body {
  flex: 1;
}

.toast-msg {
  color: var(--vp-c-text-1);
}

.toast-close {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vp-c-text-3);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
}

.toast-close:hover {
  color: var(--vp-c-text-1);
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
