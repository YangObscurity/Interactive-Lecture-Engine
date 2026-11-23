<script setup lang="ts">
/**
 * HomeBody.vue — 站点首页核心门户与全景演进枢纽（Hero & Map Hub）。
 *
 * 架构设计原则：
 * 1. 以「课程速览图」（atlas，theme/map/atlas）为全站认知与视觉基准（Hero Anchor）；
 * 2. 顶栏收敛整合全站愿景、核心指标（课程组、讲义数、交互图表、知识节点状态同步）与启航指引；
 * 3. 黄金版心：1320px 宽屏视野，两侧留白匀称；
 * 4. 严守 SSR 安全铁律与客户端数据真源（themeConfig.groups + 目录扫描 + notion_knowledge_graph.json）；
 * 5. 下游优雅流转：动态衔接「继续阅读」、「课程组导航卡片矩阵」、「图表引擎与核心能力」与「工程阅读指南」。
 */
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useData, withBase } from 'vitepress'
import { recentReads } from './reading/readingProgress'
import { endBodyHydration } from './core/bodyHydration'
import { setRaw } from './core/storage'
import { HOME_MAP_ATTR, HOME_MAP_MODES, readStoredHomeMapMode } from './core/homeMapMode'
import type { HomeMapMode } from './core/homeMapMode'
import { data as curriculumData } from './curriculum/curriculum.data.mts'
import { useCurriculum } from './curriculum/useCurriculum'
import AtlasMap from './map/atlas/AtlasMap.vue'
import { DEFAULT_ATLAS_PRESET, isAtlasPreset, packageName } from './map/atlas/model.ts'
import type { AtlasPreset } from './map/atlas/model.ts'

const CanvasMap = defineAsyncComponent(() => import('./map/canvas/CanvasMap.vue'))
import { LecSlot } from './slots'
import type { GroupCardProps } from './slots'
import { useProgress } from './progress/useProgress'
import { lectureOfPath } from '../curriculum/data.ts'
import { useT } from '../i18n/useT.ts'
import { localePrefix, localizedLecture } from './core/langLinks'
import { pickLocalized, pickSiteText } from '../i18n/index.ts'
import { useAccess } from './access/useAccess'
import type { GroupI18n, I18nPages } from '../i18n/data.ts'

type Lecture = { n: number; text: string; link: string }
type Group = {
  id: string
  category?: string
  catSlot?: number
  dir: string
  title: string
  tagline: string
  summary: string
  accent: string
  tags: string[]
  lectures: Lecture[]
  lectureCount: number
  chartCount: number
  temp?: boolean
  i18n?: GroupI18n
}

type Recent = { path: string; title: string; group: string; pct: number; ts: number }

const { theme, localeIndex } = useData()
const { t, lang } = useT()
const access = useAccess()
const progress = useProgress()
const siteMeta = computed(() => (theme.value as any).siteMeta || {})
const groups = computed<Group[]>(() => ((theme.value as any).groups as Group[]) || [])
const totals = computed(() => ((theme.value as any).totals as { lectures: number; charts: number }) || {
  lectures: groups.value.reduce((acc, g) => acc + (g.lectureCount || g.lectures?.length || 0), 0),
  charts: groups.value.reduce((acc, g) => acc + (g.chartCount || 0), 0)
})
const groupText = (g: Group, field: 'title' | 'tagline' | 'summary') => pickLocalized(g, lang.value, field)

// 站点文案单一真源：siteMeta（来自 site-texts.json）；空值就是空（英文空字段不回落中文），空的行不渲染
const heroSiteName = computed(() => pickSiteText(siteMeta.value, lang.value, 'name'))
const heroTitle = computed(() => pickSiteText(siteMeta.value, lang.value, 'text'))
const heroTagline = computed(() => pickSiteText(siteMeta.value, lang.value, 'tagline'))

// P4a: the curriculum (inline data in the server render, merged with the readable tiers after mount) feeds the atlas and the stats
const curriculum = useCurriculum({ initial: curriculumData[localeIndex.value] ?? curriculumData.root ?? null })
const curData = computed(() => curriculum.data.value)
const lectureIds = computed(() => (curData.value?.groups ?? []).flatMap((g) => g.lectures.map((l) => l.id)))
const readCount = computed(() => progress.countCompleted(lectureIds.value))
const HOME_MODES = HOME_MAP_MODES

const atlasPreset = computed<AtlasPreset>(() => {
  const home = (theme.value as { lectureHome?: { atlasExpand?: unknown } }).lectureHome
  return isAtlasPreset(home?.atlasExpand) ? home.atlasExpand : DEFAULT_ATLAS_PRESET
})

const defaultMapMode = computed<HomeMapMode>(() => {
  const home = (theme.value as { lectureHome?: { map?: unknown } }).lectureHome
  return home?.map === 'graph' ? 'graph' : 'atlas'
})
const mapMode = ref<HomeMapMode>(defaultMapMode.value)
const userPickedMode = ref(false)
watch(defaultMapMode, (next) => {
  if (!userPickedMode.value) mapMode.value = next
})
function chooseMapMode(mode: HomeMapMode): void {
  userPickedMode.value = true
  mapMode.value = mode
  setRaw('homeMapMode', mode)
  // keep the first-paint attribute in step, so its CSS (toggle state) never contradicts the choice
  document.documentElement.setAttribute(HOME_MAP_ATTR, mode)
}

// ---- the map region: a mask with a spinner until the chosen map is really ready (labels painted with their fonts) ----
const MAP_REVEAL_CAP_MS = 6000 // 3 s for the fonts (labels.ts give-up) + the time to lay out; then the map is shown with what there is
const mapShown = ref(false)
let revealTimer: ReturnType<typeof setTimeout> | null = null
let revealToken = 0
function maskMap(): void {
  revealToken++
  mapShown.value = false
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = typeof window === 'undefined' ? null : setTimeout(() => { mapShown.value = true }, MAP_REVEAL_CAP_MS)
}
/** The map of `mode` says its labels are painted: wait for the font set to settle, then one frame, then show it. */
async function onMapReady(mode: HomeMapMode): Promise<void> {
  if (mode !== mapMode.value || mapShown.value) return
  const token = ++revealToken
  const fonts = document.fonts
  if (fonts?.ready) await Promise.race([fonts.ready.catch(() => undefined), new Promise((r) => setTimeout(r, 3000))])
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
  if (token !== revealToken || mode !== mapMode.value) return
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = null
  mapShown.value = true
}
watch(mapMode, () => maskMap(), { flush: 'sync' })
onBeforeUnmount(() => {
  if (revealTimer) clearTimeout(revealTimer)
  revealToken++
})

// 非根语言首页（/en/）：课程组、启航按钮指向本语言组页；「继续阅读」有译本去译本，否则去根语言原文
const localeKey = computed(() => (localeIndex.value === 'root' ? '' : localeIndex.value))
const prefix = computed(() => localePrefix(localeKey.value))
const i18nPages = computed(() => ((theme.value as { i18nPages?: I18nPages }).i18nPages) || {})
const groupHref = (g: Group) => withBase(`${prefix.value}/${g.dir}/`)
const lectureTitle = (l: Lecture | undefined) => (l ? localizedLecture(l.link, l.text, localeKey.value, i18nPages.value).title : '')

// group cards (slot GroupCard): fields of the group, the status of each lecture, where to go on
type CardLecture = { id: string; n: number; title: string }
const curGroups = computed(() => new Map((curData.value?.groups ?? []).map((g) => [g.id, g])))
function cardLectures(g: Group): CardLecture[] {
  const cg = curGroups.value.get(g.id)
  if (cg) return cg.lectures.map((l) => ({ id: l.id, n: l.n, title: l.title }))
  return g.lectures.map((l) => ({ id: lectureOfPath(l.link)?.id ?? '', n: l.n, title: lectureTitle(l) }))
}
const cards = computed<Array<{ key: string; props: GroupCardProps }>>(() =>
  groups.value.map((g) => {
    const lecs = cardLectures(g)
    const st = lecs.map((l) => progress.statusOf(l.id))
    const read = st.filter((s) => s === 'completed').length
    const reading = st.filter((s) => s === 'in_progress').length
    const line = (l: CardLecture): string => t('card.lectureLine', { n: l.n, title: l.title })
    let next: GroupCardProps['next']
    const ri = st.indexOf('in_progress')
    const ui = st.findIndex((s) => s !== 'completed')
    if (ri >= 0) next = { kind: 'reading', heading: t('card.next.reading'), title: line(lecs[ri] as CardLecture) }
    else if (read === 0 && lecs.length > 0) next = { kind: 'start', heading: t('card.next.start'), title: line(lecs[0] as CardLecture) }
    else if (ui < 0) next = { kind: 'done', heading: t('card.next.done'), title: '' }
    else next = { kind: 'next', heading: t('card.next.next'), title: line(lecs[ui] as CardLecture) }
    const cg = curGroups.value.get(g.id)
    return {
      key: g.id,
      props: {
        id: g.id,
        href: groupHref(g),
        category: cg?.category ?? '',
        slot: cg?.catSlot ?? g.catSlot ?? 1,
        title: groupText(g, 'title'),
        tagline: groupText(g, 'tagline'),
        summary: groupText(g, 'summary'),
        tags: g.tags ?? [],
        total: lecs.length,
        read,
        reading,
        ticks: st.map((s) => (s === 'completed' ? 'r' : s === 'in_progress' ? 'g' : 'u')).join(''),
        pkg: packageName(lecs.length),
        next,
        labels: {
          lectures: t('home.card.lectures', { n: lecs.length }),
          read: t('card.read', { read, total: lecs.length }),
          readHeading: t('card.heading.read'),
          lecturesHeading: t('card.heading.lectures'),
          tagsHeading: t('card.heading.tags'),
          tagsSeparator: t('card.tagsSeparator'),
          enter: t('card.enter'),
        },
      },
    }
  }),
)

// 启航按钮
const firstGroupLink = computed(() => groups.value.length > 0 ? groupHref(groups.value[0]) : withBase(`${prefix.value}/`))
const firstGroupTitle = computed(() => groups.value.length > 0 ? t('home.startFrom', { id: groups.value[0].id, title: groupText(groups.value[0], 'title') }) : t('home.startBasic'))
const groupsRangeLabel = computed(() => {
  if (groups.value.length === 0) return t('home.rangeEmpty')
  if (groups.value.length === 1) return groups.value[0].id
  return `${groups.value[0].id} ~ ${groups.value[groups.value.length - 1].id}`
})

// 知识图谱节点状态同步统计（动态读取知识图谱，无硬编码）
const notionNodeTotal = ref(0)

// 「继续阅读」只存在于浏览器本地，必须在 mounted 之后读（SSR 阶段没有 localStorage）
const recent = ref<Recent[]>([])
const recentView = computed(() =>
  recent.value.map((r) => {
    const v = localizedLecture(r.path, r.title, localeKey.value, i18nPages.value)
    return { ...r, href: withBase(v.path), title: v.title }
  })
)
const homeReady = ref(false)
const graphSettled = ref(false)
onMounted(async () => {
  // hydration rendered the site default (what the server rendered); the remembered mode replaces it before anything shows: the
  // toggle was already right from the first paint (the head script's `data-home-map`) and the map region is masked
  const storedMode = readStoredHomeMapMode()
  if (storedMode) {
    userPickedMode.value = true
    mapMode.value = storedMode
  }
  maskMap()
  endBodyHydration()
  homeReady.value = true
  recent.value = recentReads(6)
  void loadNodeTotal()
})
// P3b: the inline graph plus the graphs of the readable restricted tiers (access/useAccess.ts); asked again when that set changes
async function loadNodeTotal(): Promise<void> {
  try {
    const data = await access.loadGraph()
    if (Array.isArray(data) && data.length > 0) {
      notionNodeTotal.value = data.length
    }
  } catch {} finally {
    graphSettled.value = true
  }
}
watch(access.version, (v) => {
  if (v > 1) void loadNodeTotal() // the first answer is already in the load above
})
</script>

<template>
  <div class="home-body" :data-home-ready="homeReady ? '1' : undefined" :data-home-settled="homeReady && graphSettled && progress.ready.value ? '1' : undefined">
    <!-- 首页顶部全景视效与愿景核心 (Hero Hub Header) -->
    <header class="hb-hero-hub">
      <h1 v-if="heroTitle" class="hub-title">
        {{ heroTitle }}
      </h1>

      <p v-if="heroTagline" class="hub-tagline">
        {{ heroTagline }}
      </p>

      <!-- 核心指标徽标组 (Compact Metrics Strip) -->
      <div class="hub-stats-strip">
        <div class="stat-item">
          <span class="stat-num">{{ groups.length }}</span>
          <span class="stat-label">{{ t('home.stat.groups') }}</span>
        </div>
        <span class="stat-divider">·</span>
        <div class="stat-item">
          <span class="stat-num">{{ totals.lectures }}</span>
          <span class="stat-label">{{ t('home.stat.lectures') }}</span>
        </div>
        <span class="stat-divider">·</span>
        <div class="stat-item">
          <span class="stat-num">{{ totals.charts }}</span>
          <span class="stat-label">{{ t('home.stat.charts') }}</span>
        </div>
        <template v-if="notionNodeTotal > 0">
          <span class="stat-divider">·</span>
          <div class="stat-item">
            <span class="stat-num">{{ notionNodeTotal }}</span>
            <span class="stat-label">{{ t('home.stat.nodes') }}</span>
          </div>
        </template>
        <template v-if="progress.ready.value && lectureIds.length > 0">
          <span class="stat-divider">·</span>
          <div class="stat-item stat-read">
            <span class="stat-read-num">{{ readCount }}</span>
            <span class="stat-label">{{ t('home.stat.read') }}</span>
          </div>
        </template>
      </div>
    </header>

    <!-- 课程速览（atlas）与依赖画布（graph） -->
    <section v-if="curData && curData.groups.length > 0" id="atlas" class="hb-section hb-atlas">
      <div class="hb-section-header hb-map-head">
        <div class="hb-map-titles">
          <h2 class="hb-h2">{{ t(mapMode === 'graph' ? 'home.map.canvasTitle' : 'home.map.title') }}</h2>
          <span class="hb-section-subtitle">{{ t(mapMode === 'graph' ? 'home.map.canvasSubtitle' : 'home.map.subtitle') }}</span>
        </div>
        <div class="hb-map-switch" role="group" :aria-label="t('home.map.modeLabel')">
          <button
            v-for="mode in HOME_MODES"
            :key="mode"
            type="button"
            class="hb-mode-btn"
            :data-map-mode="mode"
            :aria-pressed="mapMode === mode"
            @click="chooseMapMode(mode)"
          >
            {{ t(mode === 'atlas' ? 'home.map.modeAtlas' : 'home.map.modeGraph') }}
          </button>
        </div>
      </div>
      <div class="hb-map-region" :class="{ 'is-shown': mapShown }" :data-map-state="mapShown ? 'ready' : 'loading'" :aria-busy="mapShown ? 'false' : 'true'">
        <div class="hb-map-body">
          <AtlasMap v-if="mapMode === 'atlas'" :curriculum="curData" :site-name="heroSiteName" :default-preset="atlasPreset" :group-href="(dir: string) => withBase(`${prefix}/${dir}/`)" @ready="onMapReady('atlas')" />
          <CanvasMap v-else :curriculum="curData" :group-href="(dir: string) => withBase(`${prefix}/${dir}/`)" @ready="onMapReady('graph')" />
        </div>
        <div v-if="!mapShown" class="hb-map-mask" role="status" data-map-mask>
          <span class="hb-map-spinner" aria-hidden="true"></span>
          <span class="hb-map-mask-text">{{ t('home.map.loading') }}</span>
        </div>
      </div>
    </section>

    <!-- 课程组卡片（槽位 GroupCard） -->
    <section id="groups" class="hb-section">
      <div class="hb-section-header">
        <h2 class="hb-h2">{{ t('home.groups.title') }}</h2>
        <span class="hb-section-subtitle">{{ t('home.groups.subtitle', { n: groups.length }) }}</span>
      </div>
      <div class="hb-gcards">
        <LecSlot v-for="c in cards" :key="c.key" name="GroupCard" v-bind="c.props" />
      </div>
    </section>

    <!-- 继续阅读模块 -->
    <section v-if="recent.length" class="hb-section">
      <div class="hb-section-header">
        <h2 class="hb-h2">{{ t('home.recent.title') }}</h2>
      </div>
      <div class="hb-recent">
        <a v-for="r in recentView" :key="r.path" class="hb-rc" :href="r.href">
          <span class="hb-rc-g">{{ r.group.toUpperCase() }}</span>
          <span class="hb-rc-t">{{ r.title }}</span>
          <span class="hb-rc-bar"><i :style="{ width: Math.round(r.pct * 100) + '%' }"></i></span>
          <span class="hb-rc-n">{{ Math.round(r.pct * 100) }}%</span>
        </a>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ---- the remembered map mode, from the first paint: `<html data-home-map>` is set by the head script (core/homeMapMode.ts) ---- */
html[data-home-map] .hb-mode-btn {
  color: var(--lec-text);
  background: var(--lec-bg);
  border-color: var(--lec-border);
}
html[data-home-map='atlas'] .hb-mode-btn[data-map-mode='atlas'],
html[data-home-map='graph'] .hb-mode-btn[data-map-mode='graph'] {
  color: var(--lec-bg);
  background: var(--lec-text);
  border-color: var(--lec-text);
}
/* the section title and subtitle follow the mode only once the component has decided it: no flash of the other mode's text */
html[data-home-map]:not([data-hydrated='1']) .hb-map-titles {
  visibility: hidden;
}

/* ---- the map region: reserves the map's final height; the mask covers it until the map is ready ---- */
.hb-map-region {
  position: relative;
  height: min(78vh, 760px);
  min-height: 420px;
}
.hb-map-body {
  height: 100%;
  visibility: hidden;
}
.hb-map-region.is-shown .hb-map-body {
  visibility: visible;
  animation: hb-map-in 0.16s ease-out;
}
.hb-map-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: var(--lec-bg);
  border-top: 1px solid var(--lec-border);
  border-bottom: 1px solid var(--lec-border);
  color: var(--lec-text-muted);
  font-size: 13px;
}
.hb-map-spinner {
  width: 28px;
  height: 28px;
  box-sizing: border-box;
  border: 3px solid var(--lec-border);
  border-top-color: var(--lec-accent);
  border-radius: var(--lec-status-radius, 50%);
  animation: hb-map-spin 0.9s linear infinite;
}
@keyframes hb-map-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes hb-map-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .hb-map-spinner {
    animation-duration: 2.4s;
  }
  .hb-map-region.is-shown .hb-map-body {
    animation: none;
  }
}

.hb-map-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}
.hb-map-titles {
  min-width: 0;
}
.hb-map-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.hb-mode-btn {
  height: 30px;
  padding: 0 12px;
  font-size: 13px;
  color: var(--lec-text);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1, 4px);
  cursor: pointer;
}
.hb-mode-btn:hover {
  color: var(--lec-accent);
  border-color: var(--lec-accent);
}
.hb-mode-btn[aria-pressed='true'] {
  color: var(--lec-bg);
  background: var(--lec-text);
  border-color: var(--lec-text);
}
</style>

