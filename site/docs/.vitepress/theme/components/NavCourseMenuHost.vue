<script setup lang="ts">
/**
 * theme/components/NavCourseMenuHost.vue - Topbar controller & slot host for NavCourseMenu (WP-F4).
 *
 * Replaces the flat "课程组" dropdown with a two-column accessible menu per spec board §04.1.
 * Desktop: flyout panel with group preview and lecture status.
 * Mobile: collapsible accordion list in the phone drawer.
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData, useRoute, useRouter } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import { getRootLang, normalizeLang, pickLocalized, type LangCode } from '../../i18n/index.ts'
import type { I18nPages } from '../../i18n/data.ts'
import { localizedLecture } from '../core/langLinks.ts'
import { parseLecture } from '../core/route.ts'
import { trapFocus } from '../core/focusTrap.ts'
import { useProgress } from '../progress/useProgress.ts'
import { LecSlot } from '../slots/index.ts'
import type {
  CourseMenuGroupView,
  CourseMenuLabels,
  CourseMenuLectureView,
  NavCourseMenuProps,
} from '../slots/registry.ts'

interface RawLectureItem {
  n?: number
  text?: string
  link?: string
}

interface RawGroupItem {
  id?: string
  dir?: string
  title?: string
  catSlot?: number
  category?: string
  temp?: boolean
  lectureCount?: number
  lectures?: RawLectureItem[]
  i18n?: Partial<Record<LangCode, Partial<Record<string, string | undefined>>>>
}

const props = defineProps<{
  screenMenu?: boolean
}>()

const router = useRouter()
const route = useRoute()
const { site, localeIndex, theme, lang } = useData()
const { t } = useT()
const progress = useProgress()

const closeScreen = inject('close-screen', null) as (() => void) | null

const isOpen = ref(false)
const activeGroupId = ref<string>('')
const activeColumn = ref<'groups' | 'lectures'>('groups')
const activeLectureIndex = ref<number>(-1)
const expandedGroupIds = ref<string[]>([])
const wrapRef = ref<HTMLElement | null>(null)

let restoreFocusEl: HTMLElement | null = null

const localeKeys = computed(() =>
  Object.keys(site.value.locales ?? {}).filter((k) => k !== 'root'),
)

const activeLocale = computed(() => localeIndex.value || 'root')
const isEn = computed(() => activeLocale.value === 'en')
const activeLang = computed<LangCode>(() => normalizeLang(lang.value) ?? getRootLang())

const currentRoutePath = computed(() => router.route.path || route.path || '/')

const parsedLec = computed(() =>
  parseLecture(currentRoutePath.value, site.value.base || '/', localeKeys.value),
)

const currentGroupId = computed<string | null>(() => {
  if (parsedLec.value?.group) {
    return parsedLec.value.group.toUpperCase()
  }
  const clean = currentRoutePath.value.replace(new RegExp(`^/(?:${localeKeys.value.join('|')})/`), '/')
  const m = /^\/([^/]+)\/?/.exec(clean)
  if (m && m[1]) {
    const rawDir = m[1].toLowerCase()
    const found = (theme.value?.groups as Array<{ id: string; dir: string }> | undefined)?.find(
      (g) => g.dir.toLowerCase() === rawDir || g.id.toLowerCase() === rawDir,
    )
    if (found) return found.id.toUpperCase()
  }
  return null
})

const currentLectureId = computed<string | null>(() => {
  return parsedLec.value?.lectureId ?? null
})

const i18nPages = computed<I18nPages>(() => {
  const loc = site.value.locales?.[activeLocale.value] as { themeConfig?: { i18nPages?: I18nPages } } | undefined
  return loc?.themeConfig?.i18nPages ?? {}
})

const groupsView = computed<CourseMenuGroupView[]>(() => {
  const rawGroups = (theme.value?.groups as RawGroupItem[] | undefined) ?? []
  return rawGroups.map((g) => {
    const gid = String(g.id ?? '')
    const dir = String(g.dir ?? '')
    const catSlot = Number(g.catSlot ?? 1)
    const category = String(g.category ?? '')
    const groupHref = isEn.value ? `/en/${dir}/` : `/${dir}/`
    const groupTitle = pickLocalized(g, activeLang.value, 'title') || String(g.title ?? '')
    const isCurrentGroup = currentGroupId.value !== null && currentGroupId.value === gid.toUpperCase()

    const rawLectures = Array.isArray(g.lectures) ? g.lectures : []
    const lectures: CourseMenuLectureView[] = rawLectures.map((l: RawLectureItem) => {
      const n = Number(l.n ?? 1)
      const no = String(n).padStart(2, '0')
      const lecRawLink = String(l.link ?? `/${dir}/L${no}`)
      const lecRawTitle = String(l.text ?? '')
      const loc = localizedLecture(lecRawLink, lecRawTitle, isEn.value ? 'en' : '', i18nPages.value)

      const dirSegment = g.dir.split('/').pop() || g.dir
      const lecId = `${dirSegment.toLowerCase()}-l${no}`
      const statusRaw = progress.ready.value ? progress.statusOf(lecId) : 'not_started'
      const status: 'read' | 'reading' | 'unread' =
        statusRaw === 'completed' ? 'read' : statusRaw === 'in_progress' ? 'reading' : 'unread'

      const isCurrentLecture = currentLectureId.value !== null && currentLectureId.value.toLowerCase() === lecId

      const statusText =
        status === 'read'
          ? t('cmenu.statusRead')
          : status === 'reading'
            ? t('cmenu.statusReading')
            : t('cmenu.statusUnread')

      const ariaLabel = t('cmenu.lectureAria', { n, title: loc.title, status: statusText })

      return {
        id: lecId,
        no,
        title: loc.title,
        href: loc.path,
        status,
        isCurrent: isCurrentLecture,
        ariaLabel,
      }
    })

    const readCount = progress.ready.value
      ? lectures.filter((l) => l.status === 'read').length
      : 0
    const totalCount = Number(g.lectureCount ?? lectures.length)

    return {
      id: gid,
      title: groupTitle,
      href: groupHref,
      catSlot,
      category,
      read: readCount,
      total: totalCount,
      isCurrent: isCurrentGroup,
      lectures,
    }
  })
})

const activeGroup = computed<CourseMenuGroupView | null>(() => {
  if (groupsView.value.length === 0) return null
  return (
    groupsView.value.find((g) => g.id.toUpperCase() === activeGroupId.value.toUpperCase()) ??
    groupsView.value[0] ??
    null
  )
})

watch(
  currentGroupId,
  (gid) => {
    if (gid) {
      activeGroupId.value = gid
      if (!expandedGroupIds.value.includes(gid)) {
        expandedGroupIds.value.push(gid)
      }
    } else if (!activeGroupId.value && groupsView.value.length > 0) {
      activeGroupId.value = groupsView.value[0]?.id ?? ''
    }
  },
  { immediate: true },
)

function openMenu(): void {
  if (typeof document !== 'undefined') {
    restoreFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  if (!activeGroupId.value && groupsView.value.length > 0) {
    activeGroupId.value = currentGroupId.value ?? groupsView.value[0]?.id ?? ''
  }
  activeColumn.value = 'groups'
  activeLectureIndex.value = -1
  isOpen.value = true
}

function closeMenu(): void {
  isOpen.value = false
  const target = restoreFocusEl
  restoreFocusEl = null
  if (target && typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => target.focus())
  }
}

function toggleMenu(): void {
  if (isOpen.value) closeMenu()
  else openMenu()
}

function selectGroup(groupId: string): void {
  activeGroupId.value = groupId
  activeColumn.value = 'groups'
  activeLectureIndex.value = -1
}

function toggleGroupExpand(groupId: string): void {
  const idx = expandedGroupIds.value.indexOf(groupId)
  if (idx >= 0) {
    expandedGroupIds.value.splice(idx, 1)
  } else {
    expandedGroupIds.value.push(groupId)
  }
}

function handleOpenGroup(group: CourseMenuGroupView, ev?: MouseEvent): void {
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0)) return
  isOpen.value = false
  closeScreen?.()
}

function handleOpenLecture(lecture: CourseMenuLectureView, ev?: MouseEvent): void {
  if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0)) return
  isOpen.value = false
  closeScreen?.()
}

function handleKeyDown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.preventDefault()
    ev.stopPropagation()
    closeMenu()
    return
  }

  if (ev.key === 'Tab') {
    const container = wrapRef.value?.querySelector('.cm') as HTMLElement | null
    if (trapFocus(container, ev)) {
      return
    }
  }

  const groups = groupsView.value
  if (groups.length === 0) return

  const curGroupIdx = groups.findIndex((g) => g.id.toUpperCase() === activeGroupId.value.toUpperCase())
  const grpIdx = curGroupIdx >= 0 ? curGroupIdx : 0

  if (activeColumn.value === 'groups') {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      const nextIdx = (grpIdx + 1) % groups.length
      activeGroupId.value = groups[nextIdx]?.id ?? ''
      return
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      const prevIdx = grpIdx <= 0 ? groups.length - 1 : grpIdx - 1
      activeGroupId.value = groups[prevIdx]?.id ?? ''
      return
    }
    if (ev.key === 'ArrowRight') {
      ev.preventDefault()
      const ag = activeGroup.value
      if (ag && ag.lectures.length > 0) {
        activeColumn.value = 'lectures'
        const curLecIdx = ag.lectures.findIndex((l) => l.isCurrent)
        activeLectureIndex.value = curLecIdx >= 0 ? curLecIdx : 0
      }
      return
    }
  } else if (activeColumn.value === 'lectures') {
    const ag = activeGroup.value
    const lecs = ag?.lectures ?? []
    if (lecs.length === 0) {
      activeColumn.value = 'groups'
      return
    }

    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      activeLectureIndex.value = (activeLectureIndex.value + 1) % lecs.length
      return
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      activeLectureIndex.value =
        activeLectureIndex.value <= 0 ? lecs.length - 1 : activeLectureIndex.value - 1
      return
    }
    if (ev.key === 'ArrowLeft') {
      ev.preventDefault()
      activeColumn.value = 'groups'
      activeLectureIndex.value = -1
      return
    }
  }
}

function handleDocumentClick(ev: MouseEvent): void {
  if (!isOpen.value) return
  const target = ev.target as Node | null
  if (wrapRef.value && !wrapRef.value.contains(target)) {
    closeMenu()
  }
}

const labels = computed<CourseMenuLabels>(() => ({
  groups: t('nav.groups'),
  dialogLabel: t('cmenu.dialogLabel'),
  enterGroup: t('cmenu.enterGroup'),
  readCount: t('cmenu.readCount'),
  readSuffix: t('cmenu.readSuffix'),
  hintSelectGroup: t('cmenu.hintSelectGroup'),
  hintEnterLectures: t('cmenu.hintEnterLectures'),
  hintOpen: t('cmenu.hintOpen'),
  hintClose: t('cmenu.hintClose'),
  expandGroup: t('cmenu.expandGroup'),
  collapseGroup: t('cmenu.collapseGroup'),
}))

const slotProps = computed<NavCourseMenuProps>(() => ({
  isOpen: isOpen.value,
  isMobile: Boolean(props.screenMenu),
  groups: groupsView.value,
  activeGroupId: activeGroupId.value,
  activeGroup: activeGroup.value,
  activeLectureIndex: activeLectureIndex.value,
  activeColumn: activeColumn.value,
  expandedGroupIds: expandedGroupIds.value,
  labels: labels.value,
  onToggle: toggleMenu,
  onClose: closeMenu,
  onSelectGroup: selectGroup,
  onToggleGroupExpand: toggleGroupExpand,
  onOpenGroup: handleOpenGroup,
  onOpenLecture: handleOpenLecture,
  onKeyDown: handleKeyDown,
}))

watch(
  () => route.path,
  () => {
    isOpen.value = false
  },
)

onMounted(() => {
  document.addEventListener('click', handleDocumentClick, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick, true)
})
</script>

<template>
  <div ref="wrapRef" class="lec-course-menu-host">
    <LecSlot name="NavCourseMenu" v-bind="slotProps" />
  </div>
</template>

<style scoped>
.lec-course-menu-host {
  display: inline-flex;
  align-items: center;
  position: relative;
}
</style>
