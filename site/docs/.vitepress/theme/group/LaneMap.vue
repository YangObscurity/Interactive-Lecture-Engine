<script setup lang="ts">
/**
 * LaneMap.vue - the lecture map of the group page (P4a WP-H3; spec board 12.1 `buildLanes`, prototype `mapHtml` / `applyRoles` /
 * `drawEdges`): the lectures of the group in lanes, one lane per Notion category, every lecture a chip that is a real link.
 * Shared by both themes: the DOM and the layout are the same, `theme.css` (and `layout.edges`) draw the difference.
 *
 * This component draws and reports; the page decides. It reports (as events) what the pointer and keys did on a chip:
 * `peek` (hover / focus), `click`, `dblclick`, `space`, and `blank` (a click on the map outside any chip). While a lecture is
 * tracked, the direct prerequisites and follow-ups of the group get a line each (measured from the DOM, so it is client-only),
 * and every chip carries `data-role` (`self`, `pre`, `post`, `pre2`, `post2`) for the theme to dim or outline.
 *
 * The map carries `vp-raw`: VitePress intercepts every plain click on a link at the window (capture phase) and navigates at once,
 * which would defeat "single click opens after the double-click window". With `vp-raw` the router leaves these links alone and
 * the page opens the lecture itself (a modified click is still the browser's). The chips have the ids `track-<lecture id>`, so
 * a `#track-<id>` URL also scrolls to the chip by itself.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { withBase } from 'vitepress'
import type { GroupLecture, LaneView } from './types'
import { edgePath } from './model'
import type { Box, EdgeStyle, Role } from './model'

const props = defineProps<{
  lanes: readonly LaneView[]
  /** Roles of the group's lectures while one is tracked; null otherwise. */
  roles: ReadonlyMap<string, Role> | null
  /** The tracked lecture, and its direct relations inside the group (for the lines). */
  lockId: string | null
  preIds: readonly string[]
  postIds: readonly string[]
  batch: boolean
  selected: ReadonlySet<string>
  pulse: ReadonlySet<string>
  edgeStyle: EdgeStyle
  /** Language code of Notion text on an English page ('' on a page in the root language). */
  notionLang: string
  rootName: string
  rootLang: string
  badgeTitle: string
}>()

const emit = defineEmits<{
  peek: [id: string | null]
  click: [id: string, event: MouseEvent]
  dblclick: [id: string]
  space: [id: string]
  blank: []
}>()

const root = ref<HTMLElement | null>(null)
const size = ref({ w: 0, h: 0 })
const lines = ref<Array<{ kind: 'pre' | 'post'; d: string }>>([])

function chip(id: string): HTMLElement | null {
  return root.value?.querySelector<HTMLElement>(`[data-lecture="${id}"]`) ?? null
}

function box(el: Element, base: DOMRect): Box {
  const r = el.getBoundingClientRect()
  return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height }
}

function redraw(): void {
  const el = root.value
  if (!el) return
  const base = el.getBoundingClientRect()
  size.value = { w: Math.ceil(base.width), h: Math.ceil(base.height) }
  const out: Array<{ kind: 'pre' | 'post'; d: string }> = []
  const me = props.lockId ? chip(props.lockId) : null
  if (me) {
    const mb = box(me, base)
    for (const id of props.preIds) {
      const c = chip(id)
      if (c) out.push({ kind: 'pre', d: edgePath(box(c, base), mb, props.edgeStyle) })
    }
    for (const id of props.postIds) {
      const c = chip(id)
      if (c) out.push({ kind: 'post', d: edgePath(mb, box(c, base), props.edgeStyle) })
    }
  }
  lines.value = out
}

let pending = false
function schedule(): void {
  if (pending) return
  pending = true
  void nextTick(() => {
    pending = false
    redraw()
  })
}

let observer: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver(() => schedule())
    observer.observe(root.value)
  }
  if (typeof document !== 'undefined' && document.fonts) {
    void document.fonts.ready.then(schedule)
    // a font slice arriving late changes the size of the chips (their text wraps differently), and so where the lines end
    document.fonts.addEventListener('loadingdone', schedule)
  }
  schedule()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (typeof document !== 'undefined') document.fonts?.removeEventListener('loadingdone', schedule)
})
watch(() => [props.lockId, props.edgeStyle, props.lanes, props.preIds, props.postIds] as const, schedule, { flush: 'post' })

/** Scroll a lecture's chip into the middle of the window (the chip may be in a lane far below). */
function reveal(id: string, smooth: boolean): void {
  chip(id)?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
}
defineExpose({ reveal, chip })

// ---- events: one set of listeners on the map, the chip found with closest() ----------------------------------------------

const idOf = (t: EventTarget | null): string | null => (t instanceof Element ? (t.closest<HTMLElement>('[data-lecture]')?.dataset.lecture ?? null) : null)

function onClick(e: MouseEvent): void {
  const id = idOf(e.target)
  if (id === null) {
    emit('blank')
    return
  }
  // a modified click (new tab, new window, download) is the browser's
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  emit('click', id, e)
}
function onDblclick(e: MouseEvent): void {
  const id = idOf(e.target)
  if (id === null) return
  e.preventDefault()
  emit('dblclick', id)
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return
  const id = idOf(e.target)
  if (id === null) return
  e.preventDefault()
  emit('space', id)
}
function onOver(e: Event): void {
  const id = idOf(e.target)
  if (id !== null) emit('peek', id)
}
function onOut(e: MouseEvent): void {
  const el = root.value
  if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return
  if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
  if (el.contains(document.activeElement)) return
  emit('peek', null)
}

const statusMark = (l: GroupLecture): string => (l.status === 'read' ? 's-read' : l.status === 'reading' ? 's-reading' : l.ready ? 's-ready' : '')
const doneOf = (lane: LaneView): number => lane.lectures.filter((l) => l.status === 'read').length
</script>

<template>
  <div
    ref="root"
    class="gp-lanes vp-raw"
    :class="{ 'is-tracking': lockId !== null, 'is-batch': batch }"
    @click="onClick"
    @dblclick="onDblclick"
    @keydown="onKeydown"
    @mouseover="onOver"
    @focusin="onOver"
    @mouseout="onOut"
  >
    <section v-for="lane in lanes" :id="`gp-lane-${lane.index}`" :key="lane.index" class="gp-lane" :aria-label="lane.name">
      <h3 class="gp-lane-h">
        <span :lang="lane.notion && notionLang ? notionLang : undefined">{{ lane.name }}</span>
        <span class="meta">{{ doneOf(lane) }} / {{ lane.lectures.length }}</span>
      </h3>
      <div class="gp-chips">
        <a
          v-for="l in lane.lectures"
          :id="`track-${l.id}`"
          :key="l.id"
          class="gp-lc"
          :class="{ 'is-pulse': pulse.has(l.id) }"
          :href="withBase(l.href)"
          :data-lecture="l.id"
          :data-n="l.n"
          :data-status="l.status"
          :data-ready="l.ready ? '' : undefined"
          :data-role="roles?.get(l.id)"
          :data-sel="batch && selected.has(l.id) ? '' : undefined"
          :aria-label="l.label"
          :title="l.title"
        >
          <i class="gp-mk" :class="statusMark(l)" aria-hidden="true" />
          <span class="no">{{ String(l.n).padStart(2, '0') }}</span>
          <span class="t" :lang="l.untranslated ? rootLang : undefined">{{ l.title }}</span>
          <span v-if="l.untranslated" class="gp-lang" role="img" :lang="rootLang" :title="badgeTitle" :aria-label="badgeTitle">{{ rootName }}</span>
        </a>
      </div>
    </section>
    <svg class="gp-edges" :width="size.w" :height="size.h" aria-hidden="true">
      <defs>
        <marker id="gp-ar-pre" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" /></marker>
        <marker id="gp-ar-post" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" /></marker>
      </defs>
      <path v-for="(ln, i) in lines" :key="i" :class="ln.kind === 'pre' ? 'e-pre' : 'e-post'" :marker-end="ln.kind === 'pre' ? 'url(#gp-ar-pre)' : 'url(#gp-ar-post)'" :d="ln.d" />
    </svg>
  </div>
</template>
