<script setup lang="ts">
/**
 * RelationPanel.vue - the panel beside the lecture map (P4a WP-H3; prototype `panelHtml`): a preview of the lecture under the
 * pointer or focus, or the tracked lecture. It shows the Notion fields (difficulty, minutes, material link, the collapsible
 * description), the three actions (open, track, mark read / unread), and the lecture's prerequisites and follow-ups in this group and
 * in others. Every item is a real link to the lecture with its own "track" button; a cross-group item goes to its group page.
 * The page keeps the panel in the window (sticky) and moves it above the map on a narrow container (group.css).
 */
import { computed, nextTick, ref, watch } from 'vue'
import { withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import { byOrder, closure } from './model'
import type { CurrIndex, LecInfo, LecStatus } from './model'
import type { GroupLecture } from './types'

const props = defineProps<{
  /** The lecture shown (hovered, focused or tracked), or null for the hint. */
  shown: GroupLecture | null
  locked: boolean
  groupId: string
  index: CurrIndex
  /** Status and readiness of any lecture of the site (the progress store through the page). */
  statusOf: (id: string) => LecStatus
  readyOf: (id: string) => boolean
  hasGraph: boolean
  descOpen: boolean
  /** Language of the Notion texts when it differs from the page's ('' otherwise). */
  notionLang: string
}>()

const emit = defineEmits<{
  track: [id: string]
  untrack: []
  mark: [id: string, status: LecStatus]
}>()

const { t } = useT()

// decision 2026-11-23 21:47: a new tracked lecture is shown from the top of the panel (its title and actions), not at the
// scroll position the previous one was left at
const root = ref<HTMLElement | null>(null)
watch(
  () => (props.locked ? (props.shown?.id ?? null) : null),
  (id, prev) => {
    if (id !== null && id !== prev) void nextTick(() => root.value?.scrollTo({ top: 0 }))
  },
)

const info = computed<LecInfo | null>(() => (props.shown ? (props.index.lec.get(props.shown.id) ?? null) : null))
const order = computed(() => byOrder(props.index))
const pres = computed(() => (props.shown ? [...(props.index.rel.pre.get(props.shown.id) ?? [])].sort(order.value) : []))
const posts = computed(() => (props.shown ? [...(props.index.rel.post.get(props.shown.id) ?? [])].sort(order.value) : []))
const groupOf = (id: string): string | undefined => props.index.lec.get(id)?.groupId
const inPre = computed(() => pres.value.filter((p) => groupOf(p) === props.groupId))
const xPre = computed(() => pres.value.filter((p) => groupOf(p) !== props.groupId))
const inPost = computed(() => posts.value.filter((p) => groupOf(p) === props.groupId))
const xPost = computed(() => posts.value.filter((p) => groupOf(p) !== props.groupId))
const earlier = computed(() => {
  if (!props.shown) return []
  return closure(props.shown.id, props.index.rel.pre, groupOf, props.groupId)
    .filter((v) => !inPre.value.includes(v))
    .sort(order.value)
})
const later = computed(() => {
  if (!props.shown) return []
  return closure(props.shown.id, props.index.rel.post, groupOf, props.groupId)
    .filter((v) => !inPost.value.includes(v))
    .sort(order.value)
})
const readDone = computed(() => pres.value.filter((p) => props.statusOf(p) === 'read').length)
const status = computed<LecStatus>(() => (props.shown ? props.statusOf(props.shown.id) : 'unread'))

const statusText = (s: LecStatus): string => t(s === 'read' ? 'atlas.status.read' : s === 'reading' ? 'atlas.status.reading' : 'atlas.status.unread')
const markCls = (id: string): string => {
  const s = props.statusOf(id)
  return s === 'read' ? 's-read' : s === 'reading' ? 's-reading' : props.readyOf(id) ? 's-ready' : ''
}
const nameOf = (id: string): string => {
  const x = props.index.lec.get(id)
  return x ? t('card.lectureLine', { n: x.n, title: x.title }) : id
}
const missing = (id: string): number => (props.index.rel.pre.get(id) ?? []).filter((p) => props.statusOf(p) !== 'read').length
const groupLabel = (id: string): string => props.index.lec.get(id)?.groupId ?? ''
const hrefOf = (id: string): string => withBase(props.index.lec.get(id)?.link ?? '/')

const readiness = computed(() => {
  if (!props.hasGraph || !props.shown) return ''
  if (pres.value.length === 0) return t('group.panel.noPre')
  let s = t('group.panel.readiness', { done: readDone.value, total: pres.value.length })
  if (status.value === 'unread') s += readDone.value === pres.value.length ? t('group.panel.readinessReady') : t('group.panel.readinessMissing', { n: pres.value.length - readDone.value })
  return s
})
</script>

<template>
  <aside ref="root" class="gp-panel" :aria-label="t('group.panel.label')" data-gp-panel>
    <div v-if="!shown" class="gp-hint">
      <template v-if="hasGraph">
        <p>
          <b>{{ t('group.panel.hint.hoverB') }}</b
          >{{ t('group.panel.hint.hover') }}
        </p>
        <p>
          <b>{{ t('group.panel.hint.trackB') }}</b
          >{{ t('group.panel.hint.track') }}
        </p>
        <p>
          <b>{{ t('group.panel.hint.openB') }}</b
          >{{ t('group.panel.hint.open') }}
        </p>
      </template>
      <p v-else>{{ t('group.panel.hint.noGraph') }}</p>
    </div>

    <template v-else>
      <div class="gp-p-h">
        <span class="gp-p-tag">{{ locked ? t('group.panel.tracking') : t('group.panel.preview') }}</span>
        <div class="gp-p-t">
          <i class="gp-mk" :class="markCls(shown.id)" aria-hidden="true" />
          <span>{{ t('card.lectureLine', { n: shown.n, title: shown.title }) }}</span>
        </div>
        <div class="gp-p-m">
          {{ statusText(status) }}<template v-if="info?.category">{{ t('group.sep.semi') }}<span :lang="notionLang || undefined">{{ t('group.panel.category', { name: info.category }) }}</span></template
          ><template v-if="info?.node">{{ t('group.sep.semi') }}{{ t('group.panel.node') }} <code>{{ info.node }}</code></template>
        </div>
        <div v-if="readiness" class="gp-p-r">{{ readiness }}</div>
        <div v-if="info && (info.diff || info.min || info.url)" class="gp-p-n">
          <template v-if="info.diff"
            >{{ t('group.panel.difficulty') }}
            <span class="stars" role="img" :aria-label="t('group.panel.stars', { n: info.diff })">{{ '★'.repeat(info.diff) }}<s>{{ '★'.repeat(Math.max(0, 5 - info.diff)) }}</s></span></template
          ><template v-if="info.min">{{ info.diff ? t('group.sep.semi') : '' }}{{ t('group.panel.minutes', { n: info.min }) }}</template
          ><template v-if="info.url">{{ info.diff || info.min ? t('group.sep.semi') : '' }}<a :href="info.url" target="_blank" rel="noopener">{{ t('group.panel.link') }}</a></template>
        </div>
        <div class="gp-p-acts">
          <a class="pri" :href="withBase(shown.href)" data-gp-act="open">{{ t('group.panel.open') }}</a>
          <button v-if="!locked" type="button" data-gp-act="track" @click="emit('track', shown.id)">{{ t('group.panel.track') }}</button>
          <button v-else type="button" data-gp-act="untrack" @click="emit('untrack')">{{ t('group.panel.untrack') }}</button>
          <button type="button" data-gp-act="mark" @click="emit('mark', shown.id, status === 'read' ? 'unread' : 'read')">
            {{ status === 'read' ? t('group.panel.markUnread') : t('group.panel.markRead') }}
          </button>
        </div>
      </div>

      <section v-if="info?.desc" class="gp-p-s gp-p-desc">
        <!-- keyed by lecture: each lecture opens at the 说明默认展开 setting, not at the last hand toggle (S6Y audit-group #10) -->
        <details :key="shown.id" :open="descOpen">
          <summary>{{ t('group.panel.desc') }}</summary>
          <p :lang="notionLang || undefined" data-gp-desc>{{ info.desc }}</p>
        </details>
      </section>

      <template v-if="hasGraph">
        <section class="gp-p-s" data-gp-list="pre">
          <h4>{{ t('group.panel.pre') }}<span>{{ inPre.length }}</span></h4>
          <ul v-if="inPre.length">
            <li v-for="id in inPre" :key="id">
              <i class="gp-mk" :class="markCls(id)" aria-hidden="true" />
              <a :href="hrefOf(id)">{{ nameOf(id) }}</a>
              <button type="button" class="trk" :aria-label="t('group.panel.trackItem', { name: nameOf(id) })" @click="emit('track', id)">{{ t('group.panel.track') }}</button>
            </li>
          </ul>
          <p v-else class="none">{{ t('group.panel.noDirectPre') }}</p>
        </section>
        <section class="gp-p-s" data-gp-list="post">
          <h4>{{ t('group.panel.post') }}<span>{{ inPost.length }}</span></h4>
          <ul v-if="inPost.length">
            <li v-for="id in inPost" :key="id">
              <i class="gp-mk" :class="markCls(id)" aria-hidden="true" />
              <a :href="hrefOf(id)">
                {{ nameOf(id) }}
                <em v-if="statusOf(id) === 'unread'" :class="{ ok: missing(id) === 0 }">{{ missing(id) ? t('group.panel.stillNeed', { n: missing(id) }) : t('group.panel.canStart') }}</em>
              </a>
              <button type="button" class="trk" :aria-label="t('group.panel.trackItem', { name: nameOf(id) })" @click="emit('track', id)">{{ t('group.panel.track') }}</button>
            </li>
          </ul>
          <p v-else class="none">{{ t('group.panel.noDirectPost') }}</p>
        </section>
        <section v-if="xPre.length" class="gp-p-s" data-gp-list="xpre">
          <h4>{{ t('group.panel.crossPre') }}<span>{{ xPre.length }}</span></h4>
          <ul>
            <li v-for="id in xPre" :key="id">
              <i class="gp-mk" :class="markCls(id)" aria-hidden="true" />
              <a :href="hrefOf(id)"><b>{{ groupLabel(id) }}</b>{{ nameOf(id) }}</a>
              <button type="button" class="trk" :aria-label="t('group.panel.trackItem', { name: groupLabel(id) + ' ' + nameOf(id) })" @click="emit('track', id)">{{ t('group.panel.track') }}</button>
            </li>
          </ul>
        </section>
        <section v-if="xPost.length" class="gp-p-s" data-gp-list="xpost">
          <h4>{{ t('group.panel.crossPost') }}<span>{{ xPost.length }}</span></h4>
          <ul>
            <li v-for="id in xPost" :key="id">
              <i class="gp-mk" :class="markCls(id)" aria-hidden="true" />
              <a :href="hrefOf(id)">
                <b>{{ groupLabel(id) }}</b>{{ nameOf(id) }}
                <em v-if="statusOf(id) === 'unread'" :class="{ ok: missing(id) === 0 }">{{ missing(id) ? t('group.panel.stillNeed', { n: missing(id) }) : t('group.panel.canStart') }}</em>
              </a>
              <button type="button" class="trk" :aria-label="t('group.panel.trackItem', { name: groupLabel(id) + ' ' + nameOf(id) })" @click="emit('track', id)">{{ t('group.panel.track') }}</button>
            </li>
          </ul>
        </section>
        <section v-if="earlier.length || later.length" class="gp-p-s">
          <details v-if="earlier.length">
            <summary>{{ t('group.panel.earlier', { n: earlier.length }) }}</summary>
            <ul>
              <li v-for="id in earlier" :key="id">
                <i class="gp-mk" :class="markCls(id)" aria-hidden="true" />
                <a :href="hrefOf(id)">{{ nameOf(id) }}</a>
                <button type="button" class="trk" :aria-label="t('group.panel.trackItem', { name: nameOf(id) })" @click="emit('track', id)">{{ t('group.panel.track') }}</button>
              </li>
            </ul>
          </details>
          <details v-if="later.length">
            <summary>{{ t('group.panel.later', { n: later.length }) }}</summary>
            <ul>
              <li v-for="id in later" :key="id">
                <i class="gp-mk" :class="markCls(id)" aria-hidden="true" />
                <a :href="hrefOf(id)">{{ nameOf(id) }}</a>
                <button type="button" class="trk" :aria-label="t('group.panel.trackItem', { name: nameOf(id) })" @click="emit('track', id)">{{ t('group.panel.track') }}</button>
              </li>
            </ul>
          </details>
        </section>
      </template>
    </template>
  </aside>
</template>
