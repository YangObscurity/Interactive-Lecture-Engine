<script setup lang="ts">
/**
 * GroupPage.vue - one course group's page (P4a WP-H3, docs-dev/MAP.md; the group-page prototype):
 * title block, group map (slot `GroupMap`: progress grid or DIP), lecture map (Notion lanes) with the relation panel, tracking,
 * cross-group jump, completion pulse and batch marking.
 *
 * The page owns the state (what is tracked, previewed, selected) and the rules; the components draw. Statuses come from the
 * progress store (unread until it is ready, equal to the server render); readiness is "unread and every prerequisite read,
 * in this group or another". All writes go through the store (one PATCH for one lecture, one batch POST for several).
 *
 * Clicks (the map engine's rule, `useClickRule`): a single click opens the lecture after the double-click window, a double
 * click (or Space) tracks, Esc or a click on the blank map leaves tracking (or batch mode). `#track-<lecture id>` in the URL
 * locks that lecture on arrival (that is where a cross-group "track" lands).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useData, useRouter, withBase } from 'vitepress'
import { data as curriculumData } from '../curriculum/curriculum.data.mts'
import { useCurriculum } from '../curriculum/useCurriculum'
import { useProgress } from '../progress/useProgress'
import { groupOfDir } from '../progress/types'
import { showMessageToast } from '../components/ai/toast'
import { groupResume } from '../reading/readingProgress'
import { localePrefix, localizedLecture } from '../core/langLinks'
import { getRaw, setRaw } from '../core/storage'
import { useClickRule } from '../map'
import { packageName, pad2 } from '../map/atlas/model.ts'
import { LecSlot } from '../slots'
import type { GroupMapProps } from '../slots'
import { lectureIdOf, stripLectureNumber } from '../../curriculum/data'
import { getRootLang, pickLocalized, translate } from '../../i18n/index.ts'
import { useT } from '../../i18n/useT.ts'
import type { I18nPages } from '../../i18n/data.ts'
import GroupTitleBlock from './GroupTitleBlock.vue'
import LaneMap from './LaneMap.vue'
import RelationPanel from './RelationPanel.vue'
import { useEdgeStyle } from './useEdgeStyle'
import { groupLinks, indexCurriculum, isReady, lanesOf, lecStatusOf, newlyReady, parseTrackHash, progressOf, readySet, rolesOf, trackHash } from './model'
import type { LecStatus } from './model'
import type { GroupLecture, LaneView, PageGroup } from './types'

const props = defineProps<{ group: PageGroup }>()

const { theme, localeIndex } = useData()
const { t, lang } = useT()
const router = useRouter()

// ---- language ----------------------------------------------------------------------------------------------------------

const localeKey = computed(() => (localeIndex.value === 'root' ? '' : localeIndex.value))
const prefix = computed(() => localePrefix(localeKey.value))
const i18nPages = computed(() => (theme.value as { i18nPages?: I18nPages }).i18nPages ?? {})
const rootLang = getRootLang()
const rootName = translate(rootLang, 'lang.name')
/** The Notion texts (description, category titles) are in the root language: mark them on a page of another language. */
const notionLang = computed(() => (lang.value === rootLang ? '' : rootLang))
const badgeTitle = computed(() => t('group.badge.original', { root: translate(lang.value, 'lang.name') }))
const groupText = (field: 'title' | 'tagline' | 'summary'): string => pickLocalized(props.group, lang.value, field)

// ---- data: the page's lectures, the curriculum (relations, Notion fields), the progress store ---------------------------

const curriculum = useCurriculum({ initial: curriculumData[localeIndex.value] ?? curriculumData.root ?? null })
const index = computed(() => indexCurriculum(curriculum.data.value))
const curGroup = computed(() => curriculum.data.value?.groups.find((g) => g.id === props.group.id) ?? null)

const rows = computed(() => props.group.lectures.map((l) => ({ ...l, ...localizedLecture(l.link, l.text, localeKey.value, i18nPages.value) })))
const translatedCount = computed(() => rows.value.filter((r) => r.translated).length)

const progress = useProgress()
progress.onRejected(({ id }) => {
  showMessageToast(t('progress.rejected', { id: id.toUpperCase() }))
})
const statusOf = (id: string): LecStatus => lecStatusOf(progress.statusOf(id))
const readyOf = (id: string): boolean => isReady(id, index.value, statusOf)
const hasGraph = computed(() => index.value.graphGroups.has(props.group.id))

const statusText = (s: LecStatus): string => t(s === 'read' ? 'atlas.status.read' : s === 'reading' ? 'atlas.status.reading' : 'atlas.status.unread')
function labelOf(n: number, title: string, s: LecStatus, ready: boolean): string {
  return `${props.group.id} ${t('card.lectureLine', { n, title })}${t('group.sep.comma')}${statusText(s)}${ready ? t('group.lecture.readyNote') : ''}`
}

const lectures = computed<GroupLecture[]>(() =>
  rows.value.map((r) => {
    const id = lectureIdOf(props.group.dir, r.n)
    const title = stripLectureNumber(r.title)
    const status = statusOf(id)
    const ready = readyOf(id)
    return { id, n: r.n, title, href: r.path, untranslated: !r.translated, category: index.value.lec.get(id)?.category ?? '', status, ready, label: labelOf(r.n, title, status, ready) }
  }),
)
const byId = computed(() => new Map(lectures.value.map((l) => [l.id, l])))

const lanes = computed<LaneView[]>(() =>
  lanesOf(lectures.value).map((ln, i) => ({
    index: i,
    name: ln.category || (hasGraph.value ? t('group.lanes.unlinked') : t('group.lanes.all')),
    notion: ln.category !== '',
    lectures: ln.lectures,
  })),
)

const total = computed(() => lectures.value.length)
const readCount = computed(() => lectures.value.filter((l) => l.status === 'read').length)
const readingCount = computed(() => lectures.value.filter((l) => l.status === 'reading').length)
const readyCount = computed(() => lectures.value.filter((l) => l.ready).length)

// ---- title block --------------------------------------------------------------------------------------------------------

const links = computed(() => groupLinks(props.group.id, index.value))
const resumeRaw = ref<{ path: string; title: string; pct: number } | null>(null)
const cta = computed(() => {
  const first = rows.value[0]
  const list = lectures.value
  const nameOf = (l: GroupLecture): string => t('card.lectureLine', { n: l.n, title: l.title })
  const startHref = first?.path ?? '/'
  const startLabel = t('group.cta.start', { n: first?.n ?? 1 })
  const r = resumeRaw.value
  if (r) {
    const v = localizedLecture(r.path, r.title, localeKey.value, i18nPages.value)
    return { kind: 'continue' as const, href: v.path, label: t('group.cta.continue', { title: stripLectureNumber(v.title) }), pct: t('group.cta.pct', { pct: Math.round(r.pct * 100) }), startHref, startLabel }
  }
  const reading = list.find((l) => l.status === 'reading')
  const next = reading ?? (readCount.value > 0 ? list.find((l) => l.status !== 'read') : undefined)
  if (next) return { kind: 'continue' as const, href: next.href, label: t('group.cta.continue', { title: nameOf(next) }), pct: '', startHref, startLabel }
  if (total.value > 0 && readCount.value === total.value) return { kind: 'restart' as const, href: startHref, label: t('group.cta.restart', { n: first?.n ?? 1 }), pct: '', startHref, startLabel }
  return { kind: 'start' as const, href: startHref, label: startLabel, pct: '', startHref, startLabel }
})

// ---- group map (slot GroupMap) ------------------------------------------------------------------------------------------

const mapProps = computed<GroupMapProps>(() => ({
  groupId: props.group.id,
  pkg: packageName(total.value),
  read: readCount.value,
  total: total.value,
  lectures: lectures.value.map((l) => ({ id: l.id, n: l.n, number: pad2(l.n), title: l.title, href: withBase(l.href), status: l.status, ready: l.ready, label: l.label })),
  categories: lanes.value.map((ln) => ({ index: ln.index, name: ln.name, read: ln.lectures.filter((l) => l.status === 'read').length, total: ln.lectures.length })),
  categoryLang: notionLang.value,
  labels: { categories: t('group.map.categories'), padding: t('group.map.padding'), paddingNote: t('group.map.paddingNote'), lectures: t('group.map.lectures') },
}))

// ---- interaction state --------------------------------------------------------------------------------------------------

const lockId = ref<string | null>(null)
const peekId = ref<string | null>(null)
const batch = ref(false)
const selected = ref<ReadonlySet<string>>(new Set())
const pulse = ref<ReadonlySet<string>>(new Set())
const live = ref('')
const descOpen = ref(typeof document !== 'undefined' ? document.documentElement.getAttribute('data-lec-desc') !== 'closed' : true)
const laneMap = ref<InstanceType<typeof LaneMap> | null>(null)
const edgeStyle = useEdgeStyle()
const rule = useClickRule()

const shownId = computed(() => lockId.value ?? peekId.value)
const shown = computed(() => (shownId.value ? (byId.value.get(shownId.value) ?? null) : null))
const roles = computed(() => (lockId.value ? rolesOf(lockId.value, index.value, props.group.id) : null))
const inGroup = (id: string): boolean => byId.value.has(id)
const preIds = computed(() => (lockId.value ? (index.value.rel.pre.get(lockId.value) ?? []).filter(inGroup) : []))
const postIds = computed(() => (lockId.value ? (index.value.rel.post.get(lockId.value) ?? []).filter(inGroup) : []))

const reducedMotion = (): boolean => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function open(href: string): void {
  void router.go(withBase(href))
}

function setLive(text: string): void {
  live.value = text
  clearTimeout(liveTimer)
  liveTimer = setTimeout(() => (live.value = ''), 8000)
}
let liveTimer: ReturnType<typeof setTimeout> | undefined
let pulseTimer: ReturnType<typeof setTimeout> | undefined

function lock(id: string | null, announce = false): void {
  lockId.value = id
  peekId.value = null
  if (id !== null && batch.value) setBatch(false)
  if (announce && id !== null) {
    const l = byId.value.get(id)
    if (l) setLive(t('group.live.tracking', { name: t('card.lectureLine', { n: l.n, title: l.title }), pre: preIds.value.length, post: postIds.value.length }))
  }
}

function track(id: string): void {
  if (inGroup(id)) {
    lock(id, true)
    void nextTick(() => laneMap.value?.reveal(id, false))
    return
  }
  // another group: its page, with the lecture locked there
  const dir = index.value.lec.get(id)?.groupDir
  if (dir) open(`${prefix.value}/${dir}/${trackHash(id)}`)
}

function toggleTrack(id: string): void {
  if (lockId.value === id) lock(null)
  else lock(id, true)
}

function setBatch(on: boolean): void {
  batch.value = on
  selected.value = new Set()
  if (on) lock(null)
}

function toggleSelect(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

/** Write statuses, then pulse the lectures that just became ready and name them (this group and the others). */
function writeStatus(ids: readonly string[], status: LecStatus): void {
  if (ids.length === 0) return
  const candidates = [...new Set([...lectures.value.map((l) => l.id), ...ids.flatMap((id) => index.value.rel.post.get(id) ?? [])])]
  const before = readySet(candidates, index.value, statusOf)
  progress.setMany(ids.map((lectureId) => ({ lectureId, groupId: groupOfDir(props.group.dir), status: progressOf(status) })))
  const fresh = newlyReady(before, readySet(candidates, index.value, statusOf))
  const mine = fresh.filter(inGroup)
  pulse.value = new Set(mine)
  clearTimeout(pulseTimer)
  pulseTimer = setTimeout(() => (pulse.value = new Set()), 3400)
  const names = fresh.map((id) => {
    const x = index.value.lec.get(id)
    if (!x) return id
    return inGroup(id) ? t('group.live.lecture', { n: x.n }) : t('group.live.crossLecture', { id: x.groupId, n: x.n })
  })
  const head = t('group.live.marked', { status: statusText(status) })
  const shownNames = names.slice(0, 5).join(t('card.tagsSeparator')) + (names.length > 5 ? t('group.live.more', { n: names.length }) : '')
  setLive(names.length ? head + t('group.live.nowReady', { names: shownNames }) : head)
}

function mark(id: string, status: LecStatus): void {
  if (lockId.value === null) lockId.value = id
  peekId.value = null
  writeStatus([id], status)
}

function applyBatch(status: LecStatus): void {
  const ids = [...selected.value]
  selected.value = new Set()
  writeStatus(ids, status)
}

// ---- the lecture map's events ------------------------------------------------------------------------------------------

function onLaneClick(id: string): void {
  if (batch.value) {
    toggleSelect(id)
    return
  }
  const l = byId.value.get(id)
  if (l) rule.click(() => open(l.href))
}
function onLaneDblclick(id: string): void {
  if (batch.value) return
  rule.dblclick(() => toggleTrack(id))
}
function onLaneSpace(id: string): void {
  if (!batch.value) toggleTrack(id)
}
function onPeek(id: string | null): void {
  if (lockId.value !== null || batch.value) return
  peekId.value = id
}
function onBlank(): void {
  if (lockId.value !== null && !batch.value) lock(null)
}

// ---- the group map's events (delegated: the slot component only draws) --------------------------------------------------

const lectureOf = (target: EventTarget | null): string | null =>
  target instanceof Element ? (target.closest<HTMLElement>('[data-lecture]')?.dataset.lecture ?? null) : null
const laneOf = (target: EventTarget | null): string | null => (target instanceof Element ? (target.closest<HTMLElement>('[data-lane]')?.dataset.lane ?? null) : null)

function scrollToEl(el: Element | null, block: ScrollLogicalPosition): void {
  el?.scrollIntoView({ block, behavior: reducedMotion() ? 'auto' : 'smooth' })
}

function onMapClick(e: MouseEvent): void {
  const lane = laneOf(e.target)
  if (lane !== null) {
    scrollToEl(document.getElementById(`gp-lane-${lane}`), 'start')
    return
  }
  const id = lectureOf(e.target)
  if (id === null || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  const l = byId.value.get(id)
  if (l) rule.click(() => open(l.href))
}
function trackFromMap(id: string): void {
  if (batch.value) setBatch(false)
  lock(id, true)
  void nextTick(() => laneMap.value?.reveal(id, !reducedMotion()))
}
function onMapDblclick(e: MouseEvent): void {
  const id = lectureOf(e.target)
  if (id === null) return
  e.preventDefault()
  rule.dblclick(() => trackFromMap(id))
}
function onMapKeydown(e: KeyboardEvent): void {
  if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return
  const id = lectureOf(e.target)
  if (id === null) return
  e.preventDefault()
  trackFromMap(id)
}

// ---- document-level: Esc, the arrival anchor, the stored preference ----------------------------------------------------

function onEscape(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  if (batch.value) setBatch(false)
  else if (lockId.value !== null) lock(null)
}

function arrive(hash: string): void {
  const id = parseTrackHash(hash)
  if (id === null || !inGroup(id)) return
  lock(id, true)
  // VitePress scrolls to the chip (its id is the anchor) or to the top; centre the chip once that is done
  setTimeout(() => laneMap.value?.reveal(id, false), 80)
}

function setDescOpen(open: boolean): void {
  descOpen.value = open
  setRaw('groupDesc', open ? '1' : '0')
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-lec-desc', open ? 'open' : 'closed')
  }
}

const onHashChange = (): void => arrive(window.location.hash)
const onGroupDescChanged = (e: Event): void => {
  const open = (e as CustomEvent<{ open?: boolean }>).detail?.open
  if (typeof open === 'boolean') descOpen.value = open
  else descOpen.value = getRaw('groupDesc') !== '0'
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-lec-desc', descOpen.value ? 'open' : 'closed')
  }
}

const gpReady = ref(false)
onMounted(() => {
  gpReady.value = true
  document.addEventListener('keydown', onEscape)
  window.addEventListener('hashchange', onHashChange)
  window.addEventListener('lecture:group-desc-changed', onGroupDescChanged)
  const r = groupResume(props.group.dir)
  if (r) resumeRaw.value = { path: r.path, title: props.group.lectures.find((l) => l.link === r.path)?.text || r.title, pct: r.pct }
  const isOpen = getRaw('groupDesc') !== '0'
  descOpen.value = isOpen
  document.documentElement.setAttribute('data-lec-desc', isOpen ? 'open' : 'closed')
  arrive(window.location.hash)
  // the router may push the URL a moment after this page mounts
  setTimeout(() => arrive(window.location.hash), 0)
})
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onEscape)
  window.removeEventListener('hashchange', onHashChange)
  window.removeEventListener('lecture:group-desc-changed', onGroupDescChanged)
  clearTimeout(liveTimer)
  clearTimeout(pulseTimer)
})
</script>

<template>
  <div class="gp" :data-group="group.id" :data-gp-ready="gpReady ? '1' : undefined">
    <GroupTitleBlock
      :id="group.id"
      :category="curGroup?.category ?? group.category ?? ''"
      :cat-slot="curGroup?.catSlot ?? group.catSlot ?? 1"
      :title="groupText('title')"
      :tagline="groupText('tagline')"
      :summary="groupText('summary')"
      :tags="group.tags"
      :lecture-count="total"
      :stages="curGroup?.phases.length ?? 0"
      :chart-count="group.chartCount"
      :read="readCount"
      :reading="readingCount"
      :ready="readyCount"
      :translated="localeKey ? t('group.translated', { n: translatedCount, m: total }) : ''"
      :pre="links.pre"
      :post="links.post"
      :prefix="prefix"
      :cta="cta"
      :notion-lang="notionLang"
    />

    <section class="gp-sec" :aria-label="t('group.map.title')" data-gp-section="map">
      <div class="gp-sec-head">
        <h2>{{ t('group.map.title') }}</h2>
        <span class="sub">{{ t('group.map.sub') }}</span>
        <div class="tools">
          <span class="gp-legend">
            <span><i class="gp-mk" aria-hidden="true" />{{ t('atlas.status.unread') }}</span>
            <span v-if="hasGraph"><i class="gp-mk s-ready" aria-hidden="true" />{{ t('group.legend.ready') }}</span>
            <span><i class="gp-mk s-reading" aria-hidden="true" />{{ t('atlas.status.reading') }}</span>
            <span><i class="gp-mk s-read" aria-hidden="true" />{{ t('atlas.status.read') }}</span>
          </span>
        </div>
      </div>
      <div class="gp-map vp-raw" data-gp-map @click="onMapClick" @dblclick="onMapDblclick" @keydown="onMapKeydown">
        <LecSlot name="GroupMap" v-bind="mapProps" />
      </div>
    </section>

    <section class="gp-sec" :aria-label="t('group.lanes.title')" data-gp-section="lanes">
      <div class="gp-sec-head">
        <h2>{{ t('group.lanes.title') }}</h2>
        <span class="sub">{{ hasGraph ? t('group.lanes.sub', { n: lanes.length }) : t('group.lanes.subPlain') }}</span>
        <div class="tools">
          <span class="note">{{ t('group.lanes.note') }}</span>
          <button type="button" class="gp-tool-btn" :aria-pressed="batch" data-gp-batch-toggle @click="setBatch(!batch)">{{ t('group.batch.enter') }}</button>
        </div>
      </div>
      <p class="gp-live" role="status" aria-live="polite" data-gp-live>{{ live }}</p>
      <div v-if="batch" class="gp-batchbar" data-gp-batchbar>
        <span>{{ t('group.batch.info', { n: selected.size }) }}</span>
        <span class="acts">
          <button type="button" data-gp-batch="all" @click="selected = new Set(lectures.map((l) => l.id))">{{ t('group.batch.all') }}</button>
          <button type="button" data-gp-batch="read" :disabled="selected.size === 0" @click="applyBatch('read')">{{ t('group.panel.markRead') }}</button>
          <button type="button" data-gp-batch="reading" :disabled="selected.size === 0" @click="applyBatch('reading')">{{ t('group.batch.markReading') }}</button>
          <button type="button" data-gp-batch="unread" :disabled="selected.size === 0" @click="applyBatch('unread')">{{ t('group.panel.markUnread') }}</button>
          <button type="button" data-gp-batch="done" @click="setBatch(false)">{{ t('group.batch.done') }}</button>
        </span>
      </div>
      <div class="gp-map-wrap">
        <LaneMap
          ref="laneMap"
          :lanes="lanes"
          :roles="roles"
          :lock-id="lockId"
          :pre-ids="preIds"
          :post-ids="postIds"
          :batch="batch"
          :selected="selected"
          :pulse="pulse"
          :edge-style="edgeStyle"
          :notion-lang="notionLang"
          :root-name="rootName"
          :root-lang="rootLang"
          :badge-title="badgeTitle"
          @peek="onPeek"
          @click="onLaneClick"
          @dblclick="onLaneDblclick"
          @space="onLaneSpace"
          @blank="onBlank"
        />
        <RelationPanel
          :shown="shown"
          :locked="lockId !== null"
          :group-id="group.id"
          :index="index"
          :status-of="statusOf"
          :ready-of="readyOf"
          :has-graph="hasGraph"
          :desc-open="descOpen"
          :notion-lang="notionLang"
          @track="track"
          @untrack="lock(null)"
          @mark="mark"
          @update:desc-open="setDescOpen"
        />
      </div>
    </section>
  </div>
</template>
