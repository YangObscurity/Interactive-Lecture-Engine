<script setup lang="ts">
/**
 * LectureTitleHost.vue — mounts `<LecSlot name="LectureTitleBlock">` in `#doc-before` on configured lecture pages.
 * Renders the initial status synchronously as `not_started` during SSR + first hydration pass, then tracks `useProgress()`.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useData, useRoute, withBase } from 'vitepress'
import { getRootLang, pickLocalized, type MessageKey } from '../../i18n/index.ts'
import { useT } from '../../i18n/useT.ts'
import type { GroupI18n, I18nPages } from '../../i18n/data.ts'
import { getLocaleKeys } from '../core/locales'
import { localizedLecture } from '../core/langLinks'
import { parseLecture } from '../core/route'
import { lectureIdOf } from '../../curriculum/data'
import { useProgress } from '../progress/useProgress'
import { getAccess } from '../access/store'
import type { ProgressStatus } from '../progress/types'
import { LecSlot } from '../slots'
import { parseLectureDescription, parseLectureTitle } from '../reading/lectureMeta'

interface ThemeGroup {
  id: string
  category?: string
  catSlot?: number
  dir: string
  title: string
  i18n?: GroupI18n
  lectures?: ReadonlyArray<{ n: number; text: string; link: string }>
}

const { theme, frontmatter, site, localeIndex } = useData()
const route = useRoute()
const { t, lang } = useT()
const progress = useProgress()

const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})

const STATUS_KEYS: Record<ProgressStatus, MessageKey> = {
  not_started: 'sidebar.status.notStarted',
  in_progress: 'sidebar.status.inProgress',
  completed: 'sidebar.status.completed',
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

const propsData = computed(() => {
  const lec = parseLecture(route.path, site.value.base, getLocaleKeys())
  if (!lec) return null
  const groups = ((theme.value as { groups?: ThemeGroup[] }).groups ?? [])
  const group = groups.find((g) => g.dir === lec.dir)
  if (!group) return null

  const localeKey = localeIndex.value === 'root' ? '' : localeIndex.value
  const i18nPages = ((theme.value as { i18nPages?: I18nPages }).i18nPages) ?? {}
  const fm = frontmatter.value as { title?: string; order?: number; description?: string }
  const lecId = lectureIdOf(group.dir, lec.lectureNo)

  const list = [...(group.lectures ?? [])].sort((a, b) => a.n - b.n)
  const idx = list.findIndex((item) => item.n === lec.lectureNo)
  const toLink = (item: { n: number; text: string; link: string } | undefined) => {
    if (!item) return null
    const v = localizedLecture(item.link, item.text, localeKey, i18nPages)
    return { label: v.title, href: withBase(v.path) }
  }

  const parsedDesc = parseLectureDescription(fm.description ?? '')
  const rawTitle = (fm.title || list[idx]?.text || '').trim()
  const title = parseLectureTitle(rawTitle)
  const rootLang = getRootLang()
  const status: ProgressStatus = mounted.value ? progress.statusOf(lecId) : 'not_started'

  return {
    code: `${group.id}-L${pad2(lec.lectureNo)}`,
    groupId: group.id,
    groupTitle: pickLocalized(group, lang.value, 'title'),
    category: group.category ?? '',
    catSlot: group.catSlot ?? 1,
    eyebrow: t('lecture.tb.eyebrow', { n: lec.lectureNo }),
    title,
    nodeId: parsedDesc.nodeId,
    difficulty: parsedDesc.difficulty,
    maxStars: parsedDesc.maxStars,
    estimated: parsedDesc.estimated,
    status,
    statusLabel: t(STATUS_KEYS[status]),
    prev: idx > 0 ? toLink(list[idx - 1]) : null,
    next: idx >= 0 && idx + 1 < list.length ? toLink(list[idx + 1]) : null,
    notionLang: lang.value === rootLang ? '' : rootLang,
    labels: {
      node: t('lecture.tb.node'),
      difficulty: t('lecture.tb.difficulty'),
      estimated: t('lecture.tb.estimated'),
      status: t('lecture.tb.status'),
      prev: t('lecture.tb.prev'),
      next: t('lecture.tb.next'),
      none: t('lecture.tb.none'),
      starsAria: t('lecture.tb.starsAria', { n: parsedDesc.difficulty, max: parsedDesc.maxStars }),
    },
  }
})

/**
 * A restricted-tier lecture is built without its group's metadata (it arrives from the gateway after hydration), so the
 * title block appears late and pushes the whole article down by its height. Until then an empty box of that height keeps
 * the place (`.lec-tb-ph`, sized per skin in base.css / theme.css); it holds no text, so nothing of the tier leaks.
 * The box must not stay when access settles without the group (gateway or network error) or after ACCESS_WAIT_MS:
 * these lectures carry their title only in the title block, so the article then starts at the top, without an empty box. "Settled" is set one macrotask after `getAccess()` resolves,
 * because this component mounts before the theme root, whose listener merges the tier data on the same promise.
 */
const ACCESS_WAIT_MS = 10_000
const accessSettled = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  const settle = (): void => {
    accessSettled.value = true
  }
  settleTimer = setTimeout(settle, ACCESS_WAIT_MS)
  void getAccess().then(() => {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(settle, 0)
  })
})
onBeforeUnmount(() => clearTimeout(settleTimer))
const awaitingTier = computed(() => {
  if (propsData.value || accessSettled.value) return false
  const tier = (frontmatter.value as { accessTier?: unknown }).accessTier
  return typeof tier === 'string' && tier !== '' && parseLecture(route.path, site.value.base, getLocaleKeys()) !== null
})
</script>

<template>
  <LecSlot v-if="propsData" name="LectureTitleBlock" v-bind="propsData" />
  <div v-else-if="awaitingTier" class="lec-tb-ph" aria-hidden="true" />
</template>
