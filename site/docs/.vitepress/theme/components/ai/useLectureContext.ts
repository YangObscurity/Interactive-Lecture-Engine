/**
 * useLectureContext.ts — 讲义上下文感知器
 * 
 * 职责：
 *   1. 动态感知**当前页面**所处的讲次、课程组与大纲；
 *      讲次/组名一律从路由与主题配置动态读取，本文件不硬编码任何具体课程编号；
 *   2. 监听视口滚动，自动识别读者正在浏览的 H2/H3 章节小节；
 *   3. 提取正文文本摘要与用户当前划选的高亮选区。
 * 
 * 铁律：严格遵循 SSR 保护，生命周期卸载时 100% 显式移除监听器，杜绝内存泄漏。
 */

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useData, useRoute } from 'vitepress'

export interface LectureMeta {
  lectureId: string     // 如 "<组目录>-L01"
  lectureNum: number    // 如 1
  title: string         // 讲次标题，取自当前页面 frontmatter.title
  groupId: string       // 课程组 id（大写，来自主题配置）
  groupDir: string      // 课程组目录名（小写，来自主题配置）
  groupTitle: string    // 课程组标题（来自主题配置）
  currentSection: string // 当前视口内的 ## / ### 章节名称
  selectedText: string  // 用户选中的正文文本
}

interface GroupThemeItem {
  id?: string
  dir?: string
  title?: string
}

interface CustomThemeConfig {
  groups?: GroupThemeItem[]
}

export function useLectureContext() {
  const { page, theme } = useData()
  const route = useRoute()

  const currentSection = ref('')
  const selectedText = ref('')
  let scrollTimer: number | null = null
  let routeTimer: number | null = null

  // 1. 解析当前讲号与课程组
  const lectureInfo = computed<LectureMeta>(() => {
    const rawPath = page.value.relativePath || route.path.replace(/^\//, '')
    // 匹配具体讲次，如 "g01/L01.md" 或 "/g01/L01"
    const match = rawPath.match(/([a-z0-9]+)\/L(\d+)/i)
    // 匹配课程组目录，如 "g01/index.md" 或 "g01/"
    const groupMatch = rawPath.match(/^([a-z0-9]+)(\/|$)/i)

    const themeConfig = theme.value as CustomThemeConfig
    const allGroups = themeConfig?.groups || []

    const candidateDir = match ? match[1].toLowerCase() : (groupMatch ? groupMatch[1].toLowerCase() : '')
    const matchedGroup = allGroups.find((g) => g.dir?.toLowerCase() === candidateDir)

    const groupDir = matchedGroup ? candidateDir : (match ? match[1].toLowerCase() : '')
    const lectureNum = match ? parseInt(match[2], 10) : 0
    const lectureId = match ? `${groupDir}-L${String(lectureNum).padStart(2, '0')}` : ''

    return {
      lectureId,
      lectureNum,
      title: page.value.title || `第 ${lectureNum} 讲`,
      groupId: matchedGroup?.id || groupDir.toUpperCase(),
      groupDir,
      groupTitle: matchedGroup?.title || '专业讲义',
      currentSection: currentSection.value,
      selectedText: selectedText.value
    }
  })

  // 2. 视口滚动检测：感知当前正在阅读的具体小节（带防抖）
  const updateActiveSection = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const headings = Array.from(document.querySelectorAll<HTMLElement>('.vp-doc h2, .vp-doc h3'))
    if (!headings.length) return

    const scrollY = window.scrollY || window.pageYOffset
    const offset = 160 // 顶栏偏移量

    let current = headings[0]?.innerText?.replace(/\u200b/g, '').trim() || ''
    for (const h of headings) {
      if (h.offsetTop <= scrollY + offset) {
        current = h.innerText.replace(/\u200b/g, '').trim()
      } else {
        break
      }
    }
    currentSection.value = current
  }

  const debouncedScroll = () => {
    if (scrollTimer) window.clearTimeout(scrollTimer)
    scrollTimer = window.setTimeout(updateActiveSection, 120)
  }

  // 3. 提取当前讲义正文纯文本摘要（过滤导航与多余空白）
  const getProseExcerpt = (maxChars = 2500): string => {
    if (typeof document === 'undefined') return ''
    const docEl = document.querySelector('.vp-doc')
    if (!docEl) return ''
    const text = (docEl as HTMLElement).innerText || ''
    return text.replace(/\s+/g, ' ').slice(0, maxChars)
  }

  // 4. 监听用户选区变化
  const handleSelection = () => {
    if (typeof window === 'undefined') return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      // 允许保留已选中的文字供侧边栏引用，不盲目清空
      return
    }
    const text = sel.toString().trim()
    if (text.length > 2) {
      selectedText.value = text
    }
  }

  onMounted(() => {
    updateActiveSection()
    window.addEventListener('scroll', debouncedScroll, { passive: true })
    document.addEventListener('selectionchange', handleSelection)
  })

  onUnmounted(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', debouncedScroll)
      document.removeEventListener('selectionchange', handleSelection)
      if (scrollTimer) window.clearTimeout(scrollTimer)
      if (routeTimer) window.clearTimeout(routeTimer)
    }
  })

  // 路由切页时重置小节
  watch(
    () => route.path,
    () => {
      currentSection.value = ''
      selectedText.value = ''
      if (routeTimer) window.clearTimeout(routeTimer)
      routeTimer = window.setTimeout(updateActiveSection, 300)
    }
  )

  return {
    lectureInfo,
    currentSection,
    selectedText,
    getProseExcerpt
  }
}
