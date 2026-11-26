/**
 * useLectureContext.ts — Lecture context detector (P6 singleton, FE-013 / FE-035 / FE-058).
 *
 * Uses `core/route.ts` as the single route parser (supports nested group dirs like `courses/g01/L01`
 * and locale prefixes like `/en/g05/L19`) and shares one reference-counted browser listener pair
 * (`scroll` + `selectionchange`) across all components calling `useLectureContext()`.
 */

import { ref, computed, onMounted, onUnmounted, watch, getCurrentInstance } from 'vue'
import { useData, useRoute } from 'vitepress'
import { getLocaleKeys } from '../../core/locales'
import { normalisePath, parseLecture, splitLocale } from '../../core/route'
import { currentLang, translate } from '../../../i18n/index.ts'

export interface LectureMeta {
  lectureId: string
  lectureNum: number
  title: string
  groupId: string
  groupDir: string
  groupTitle: string
  isTemp: boolean
  currentSection: string
  selectedText: string
}

interface GroupThemeItem {
  id?: string
  dir?: string
  title?: string
  temp?: boolean
}

interface CustomThemeConfig {
  groups?: GroupThemeItem[]
}

const DEFAULT_HEADING_OFFSET_PX = 160
const SCROLL_DEBOUNCE_MS = 120

// Shared client-side singleton state (never mutated per SSR request; only touched in mounted client).
const sharedCurrentSection = ref('')
const sharedSelectedText = ref('')
let listenerRefCount = 0
let scrollTimer: ReturnType<typeof setTimeout> | null = null

function updateActiveSection(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const headings = Array.from(document.querySelectorAll<HTMLElement>('.vp-doc h2, .vp-doc h3'))
  if (!headings.length) {
    sharedCurrentSection.value = ''
    return
  }
  const scrollY = window.scrollY || window.pageYOffset
  let current = headings[0]?.innerText?.replace(/\u200b/g, '').trim() || ''
  for (const h of headings) {
    if (h.offsetTop <= scrollY + DEFAULT_HEADING_OFFSET_PX) {
      current = h.innerText.replace(/\u200b/g, '').trim()
    } else {
      break
    }
  }
  sharedCurrentSection.value = current
}

function handleScrollDebounced(): void {
  if (scrollTimer !== null) clearTimeout(scrollTimer)
  scrollTimer = setTimeout(updateActiveSection, SCROLL_DEBOUNCE_MS)
}

function handleSelectionChange(): void {
  if (typeof window === 'undefined') return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) return
  const text = sel.toString().trim()
  if (text.length > 2) {
    sharedSelectedText.value = text
  }
}

function acquireListeners(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  listenerRefCount += 1
  if (listenerRefCount === 1) {
    updateActiveSection()
    window.addEventListener('scroll', handleScrollDebounced, { passive: true })
    document.addEventListener('selectionchange', handleSelectionChange)
  }
}

function releaseListeners(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  listenerRefCount = Math.max(0, listenerRefCount - 1)
  if (listenerRefCount === 0) {
    window.removeEventListener('scroll', handleScrollDebounced)
    document.removeEventListener('selectionchange', handleSelectionChange)
    if (scrollTimer !== null) {
      clearTimeout(scrollTimer)
      scrollTimer = null
    }
  }
}

/** Expose active client listener count for unit tests (`FE-013`). */
export function __getLectureContextListenerCountForTests(): number {
  return listenerRefCount
}

export function useLectureContext() {
  const { page, frontmatter, theme, site } = useData()
  const route = useRoute()

  const lectureInfo = computed<LectureMeta>(() => {
    const base = site.value.base || '/'
    const localeKeys = getLocaleKeys()
    const rawRoute = route.path || '/'
    const parsed = parseLecture(rawRoute, base, localeKeys)

    const themeConfig = theme.value as CustomThemeConfig
    const allGroups = themeConfig?.groups || []

    let candidateDir = ''
    if (parsed) {
      candidateDir = parsed.dir
    } else {
      const stripped = normalisePath(splitLocale(rawRoute, localeKeys).path, base).replace(/^\/+/, '')
      candidateDir = stripped
    }

    const cd = candidateDir.toLowerCase()
    let matchedGroup: (typeof allGroups)[number] | undefined
    for (const g of allGroups) {
      const gd = (g.dir || '').toLowerCase()
      if (gd === '' || !(gd === cd || cd.startsWith(`${gd}/`))) continue
      if (!matchedGroup || gd.length > (matchedGroup.dir || '').length) matchedGroup = g
    }

    const groupDir = matchedGroup?.dir || parsed?.dir || ''
    const groupSegment = parsed?.group || groupDir.split('/').pop()?.toLowerCase() || ''
    const lectureNum = parsed ? parsed.lectureNo : 0
    const lectureId = parsed ? parsed.lectureId : ''
    const fm = (frontmatter?.value ?? page.value?.frontmatter) as
      | { groupMeta?: { temp?: unknown }; groupTemp?: unknown }
      | undefined
    const frontmatterGroupTemp = fm?.groupMeta?.temp === true || fm?.groupTemp === true
    const isTemp = matchedGroup?.temp === true || frontmatterGroupTemp

    const fallbackTitle =
      lectureNum > 0
        ? translate(currentLang(), 'lecture.tb.eyebrow', { n: lectureNum })
        : ''

    return {
      lectureId,
      lectureNum,
      title: page.value.title || fallbackTitle,
      groupId: matchedGroup?.id || groupSegment.toUpperCase(),
      groupDir,
      groupTitle: matchedGroup?.title || groupSegment.toUpperCase(),
      isTemp,
      currentSection: sharedCurrentSection.value,
      selectedText: sharedSelectedText.value,
    }
  })

  const getProseExcerpt = (maxChars = 2500): string => {
    if (typeof document === 'undefined') return ''
    const docEl = document.querySelector('.vp-doc')
    if (!docEl) return ''
    const text = (docEl as HTMLElement).innerText || ''
    return text.replace(/\s+/g, ' ').slice(0, maxChars)
  }

  let routeTimer: ReturnType<typeof setTimeout> | null = null

  if (getCurrentInstance()) {
    onMounted(() => {
      acquireListeners()
    })

    onUnmounted(() => {
      releaseListeners()
      if (routeTimer !== null) {
        clearTimeout(routeTimer)
        routeTimer = null
      }
    })

    watch(
      () => route.path,
      () => {
        sharedCurrentSection.value = ''
        sharedSelectedText.value = ''
        if (typeof window !== 'undefined') {
          if (routeTimer !== null) clearTimeout(routeTimer)
          routeTimer = setTimeout(updateActiveSection, 300)
        }
      },
    )
  }

  return {
    lectureInfo,
    currentSection: sharedCurrentSection,
    selectedText: sharedSelectedText,
    getProseExcerpt,
  }
}
