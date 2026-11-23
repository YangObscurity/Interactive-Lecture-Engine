<script setup lang="ts">
/**
 * AtlasMap.vue - the home overview map, "atlas" (P4a WP-H2; prototype v16 / v17, docs-dev/MAP.md and SLOTS.md).
 *
 * A two-sided horizontal mind map: centre > category > group > phase > lecture. The engine (this file and its siblings) owns
 * data, layout, expansion, hover highlight, search, clicks and the viewport; the shapes are slot components
 * (`AtlasCenter`, `AtlasCategory`, `AtlasGroup`, `AtlasPhase`, `AtlasLecture`, `AtlasLink`) that a theme may replace, and the text
 * is painted by the label layer of `MapStage`. Statuses come from the progress store (all "not read" until it is ready, as in
 * the server render); the text widths are estimated until mount, then measured with the theme's fonts.
 */
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Component, VNode } from 'vue'
import { useRouter, withBase } from 'vitepress'
import type { CurriculumData } from '../../../curriculum/data.ts'
import { getRaw, setRaw } from '../../core/storage'
import { useProgress } from '../../progress/useProgress'
import { slotRuntime } from '../../slots'
import type { AtlasStatus } from '../../slots/registry.ts'
import { useT } from '../../../i18n/useT.ts'
import MapInfoPanel from '../MapInfoPanel.vue'
import MapStage from '../MapStage.vue'
import { mapAriaLabel, mapSvgLabel } from '../aria'
import type { Label } from '../labels'
import { fitTransform } from '../geometry'
import { useClickRule } from '../useClickRule'
import { useInfoPanel } from '../useInfoPanel'
import type { MapInfoContent } from '../useInfoPanel'
import { ancestorsToOpen, computeFocus, matchRows, searchHits } from './focus.ts'
import { blockBox, createAtlasText, estimateTextWidth, layoutAtlas, screenOfNode } from './layout.ts'
import type { AtlasLabels, LaidNode } from './layout.ts'
import { ATLAS_PRESETS, DEFAULT_ATLAS_PRESET, buildAtlasTree, countStatuses, isAtlasPreset } from './model.ts'
import type { AtlasNode, AtlasPreset } from './model.ts'
import { canvasWidth, readFontFamilies } from './measure.ts'
import { categoryProps, centerProps, groupProps, lectureProps, linkProps, phaseProps } from './props.ts'
import type { PropsContext } from './props.ts'
import type { AtlasCategoryProps, AtlasGroupProps, AtlasLectureProps, AtlasLinkProps, AtlasPhaseProps } from '../../slots/registry.ts'
import { skinOfImpl } from './skins.ts'

const props = withDefaults(
  defineProps<{
    curriculum: CurriculumData
    siteName: string
    defaultPreset?: AtlasPreset
    /** URL of a group page (with the locale prefix and the base). */
    groupHref: (dir: string) => string
  }>(),
  { defaultPreset: DEFAULT_ATLAS_PRESET },
)

const { t, lang } = useT()
const router = useRouter()
const progress = useProgress()
const info = useInfoPanel()
const clicks = useClickRule()
slotRuntime.useActive()

const stage = ref<InstanceType<typeof MapStage> | null>(null)
const viewport = () => stage.value?.viewport.viewport.value ?? null
const deferLabels = (): void => { stage.value?.deferLabels() }

// ---- data -------------------------------------------------------------------------------------------------------

const tree = computed(() => buildAtlasTree(props.curriculum))
const statuses = computed(() => {
  const m = new Map<string, AtlasStatus>()
  for (const l of tree.value.lectures) {
    const s = progress.statusOf(l.id)
    m.set(l.id, s === 'completed' ? 'read' : s === 'in_progress' ? 'reading' : 'unread')
  }
  return m
})
const counts = computed(() => countStatuses(tree.value, statuses.value))

// ---- expansion --------------------------------------------------------------------------------------------------

const preset = ref<AtlasPreset>(props.defaultPreset)
const overrides = shallowRef<Record<string, boolean>>({})

// ---- text -------------------------------------------------------------------------------------------------------

const measured = ref(false)
const fontsTick = ref(0)
const text = computed(() => {
  void fontsTick.value
  return createAtlasText(measured.value ? canvasWidth(readFontFamilies()) : estimateTextWidth)
})
const labels = computed<AtlasLabels>(() => {
  void lang.value
  return {
    range: (from, to) => t('atlas.range', { from, to }),
    caption: (groups, read, total) => t('atlas.caption', { groups, read, total }),
    trunk: (n) => t('atlas.trunk', { n }),
    uncategorised: t('atlas.uncategorised'),
  }
})

// ---- layout -----------------------------------------------------------------------------------------------------

/**
 * The implementation of each atlas slot, resolved once for the whole map (not once per node): the same rule as `<LecSlot>`
 * (the site default theme's component for the server render and the first client render, the active theme's after mount),
 * without a wrapper component around each of the thousand nodes of a fully open map.
 */
const parts = computed(() => {
  const r = (name: 'AtlasCenter' | 'AtlasCategory' | 'AtlasGroup' | 'AtlasPhase' | 'AtlasLecture' | 'AtlasLink'): { component: Component; impl: string } => {
    const x = slotRuntime.resolve(name)
    if (!x) throw new Error(`[lecture-slots] ${name} has no implementation`)
    return x
  }
  return { center: r('AtlasCenter'), cat: r('AtlasCategory'), group: r('AtlasGroup'), phase: r('AtlasPhase'), lecture: r('AtlasLecture'), link: r('AtlasLink') }
})
const skin = computed(() => skinOfImpl(parts.value.center.impl))
const layout = computed(() =>
  layoutAtlas({
    tree: tree.value,
    skin: skin.value,
    text: text.value,
    counts: counts.value,
    expansion: { preset: preset.value, open: overrides.value },
    labels: labels.value,
  }),
)

// ---- hover, search ----------------------------------------------------------------------------------------------

const hoverKey = ref('')
const hoverId = ref<string | null>(null)
const focus = computed(() => (hoverId.value ? computeFocus(tree.value, layout.value, hoverId.value) : null))

const queryRaw = ref('')
const query = computed(() => queryRaw.value.trim().toLowerCase())
const hits = computed(() => searchHits(tree.value, query.value))
const matches = computed(() => matchRows(tree.value, layout.value, hits.value))
let hitIndex = -1
watch(query, () => {
  hitIndex = -1
  statusMsg.value = ''
})
const statusMsg = ref('')
let statusTimer: ReturnType<typeof setTimeout> | null = null
function say(msg: string): void {
  statusMsg.value = msg
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(() => (statusMsg.value = ''), 4000)
}

// ---- what the slots get -----------------------------------------------------------------------------------------

interface AtlasSlotAttrs {
  'data-node'?: string
  'data-link'?: string
  'data-slot'?: string
  'data-slot-impl'?: string
}
type LinkItem = AtlasLinkProps & AtlasSlotAttrs
type PhaseItem = AtlasPhaseProps & AtlasSlotAttrs
type LectureItem = AtlasLectureProps & AtlasSlotAttrs

function SlotList(p: {
  items: readonly object[]
  comp: Component
  keyOf: (item: AtlasSlotAttrs) => string
}): VNode[] {
  if (typeof p.comp === 'function') {
    const fn = p.comp as (props: object) => VNode
    const out: VNode[] = new Array(p.items.length)
    for (let i = 0; i < p.items.length; i++) {
      const item = p.items[i]!
      const vn = fn(item)
      vn.key = p.keyOf(item as AtlasSlotAttrs)
      out[i] = vn
    }
    return out
  }
  return p.items.map((item) => h(p.comp, { key: p.keyOf(item as AtlasSlotAttrs), ...item }))
}
SlotList.props = ['items', 'comp', 'keyOf']
const nodeKey = (p: AtlasSlotAttrs): string => p['data-node'] ?? ''
const linkKey = (p: AtlasSlotAttrs): string => p['data-link'] ?? ''

const drawn = computed(() => {
  const L = layout.value
  const rootCount = counts.value.get('root') ?? { read: 0, reading: 0 }
  const ctx: PropsContext = {
    layout: L,
    statuses: statuses.value,
    focus: focus.value,
    matches: matches.value,
    centerTitle: text.value.clip(props.siteName, L.metrics.rootW - 32, L.metrics.fonts.center),
    centerSubtitle: t('atlas.center.subtitle', { lectures: tree.value.lectures.length, read: rootCount.read, reading: rootCount.reading }),
    trunk: (n) => t('atlas.trunk', { n }),
  }
  const impl = parts.value
  const catImpl = impl.cat.impl
  const groupImpl = impl.group.impl
  const phaseImpl = impl.phase.impl
  const lecImpl = impl.lecture.impl
  const linkImpl = impl.link.impl
  const cats: Array<AtlasCategoryProps & { 'data-node': string; 'data-slot': string; 'data-slot-impl': string }> = []
  const groups: Array<AtlasGroupProps & { 'data-node': string; 'data-slot': string; 'data-slot-impl': string }> = []
  const phases: PhaseItem[] = []
  const lecs: LectureItem[] = []
  const bigs: Array<{ id: string; text: string; x: number; y: number; anchor: 'start' | 'end'; size: number }> = []
  for (const n of L.vis) {
    if (n.kind === 'cat') cats.push(Object.assign(categoryProps(n, ctx), { 'data-node': n.id, 'data-slot': 'AtlasCategory', 'data-slot-impl': catImpl }))
    else if (n.kind === 'group') {
      groups.push(Object.assign(groupProps(n, ctx), { 'data-node': n.id, 'data-slot': 'AtlasGroup', 'data-slot-impl': groupImpl }))
      if (n.bh > 160) {
        const fs = Math.min(150, n.bh * 0.3)
        bigs.push({ id: n.id, text: n.idText, x: Math.round((n.xi + n.side * 10) * 10) / 10, y: Math.round((n.y + fs * 0.35) * 10) / 10, anchor: n.side > 0 ? 'start' : 'end', size: Math.round(fs) })
      }
    } else if (n.kind === 'stage') {
      const d = phaseProps(n, ctx) as PhaseItem
      d['data-node'] = n.id
      d['data-slot'] = 'AtlasPhase'
      d['data-slot-impl'] = phaseImpl
      phases.push(d)
    } else if (n.kind === 'lec') {
      const d = lectureProps(n, ctx) as LectureItem
      d['data-node'] = n.id
      d['data-slot'] = 'AtlasLecture'
      d['data-slot-impl'] = lecImpl
      lecs.push(d)
    }
  }
  const links: LinkItem[] = new Array(L.links.length)
  for (let i = 0; i < L.links.length; i++) {
    const g = L.links[i]!
    const d = linkProps(g, ctx) as LinkItem
    d['data-link'] = `${g.parentId}>${g.id}`
    d['data-slot'] = 'AtlasLink'
    d['data-slot-impl'] = linkImpl
    links[i] = d
  }
  return { center: centerProps(ctx, rootCount.read, rootCount.reading, tree.value.lectures.length), cats, groups, phases, lecs, links, bigs }
})

const ariaLabel = computed(() => mapAriaLabel(lang.value, { groups: tree.value.groups.length, lectures: tree.value.lectures.length }))
const svgLabel = computed(() => mapSvgLabel(lang.value))

const labelsKey = computed(() =>
  [layout.value.key, parts.value.center.impl, parts.value.cat.impl, parts.value.group.impl, parts.value.phase.impl, parts.value.lecture.impl].join('|'),
)
const stageProps = computed(() => ({ ariaLabel: ariaLabel.value, svgLabel: svgLabel.value, labelsKey: labelsKey.value, labelOptions }))

/** Which labels show at which scale (prototype v16 `visible`): big group ids far out, lecture names from 0.45, numbers and phase labels from 0.22. */
const labelOptions = {
  visible: (label: Label, k: number): boolean => {
    switch (label.kind) {
      case 'big':
        return k < 0.22
      case 'meta':
      case 'num':
        return k >= 0.22
      case 'name':
        return k >= 0.45
      default:
        return true
    }
  },
}

// ---- viewport helpers -------------------------------------------------------------------------------------------

let userChanged = false

/** The zoom label at the bottom left: scale and the label tier it shows (the same steps as `labelOptions`). */
const zoomK = ref(1)
function onCommit(tr: { k: number }): void {
  zoomK.value = tr.k
}
const zoomLabelText = computed(() => {
  const k = zoomK.value
  const tier = t(k < 0.22 ? 'canvas.zoom.far' : k < 0.45 ? 'canvas.zoom.mid' : 'canvas.zoom.near')
  return t('atlas.zoomLabel', { pct: Math.round(k * 100), tier })
})
/** Its own component, so that a zoom re-renders the label only, never the map. */
const ZoomLabel = defineComponent({
  name: 'AtlasZoomLabel',
  setup: () => () => h('div', { class: 'lec-map-panel am-zoomlabel', 'aria-hidden': 'true' }, zoomLabelText.value),
})

function stageSize(): { width: number; height: number } {
  const r = stage.value?.stage?.getBoundingClientRect()
  return { width: r?.width ?? 0, height: r?.height ?? 0 }
}

/** Keep `id` where it was on screen (`before`) after the layout changed. */
function keepAt(id: string, before: [number, number]): LaidNode | null {
  const vp = viewport()
  const L = layout.value.all.get(id)
  if (!vp || !L) return L ?? null
  const v = vp.view
  const after = screenOfNode(L, v)
  vp.setView({ k: v.k, x: v.x + before[0] - after[0], y: v.y + before[1] - after[1] })
  return L
}

/** After a branch opens, slide it into view if it fits at the current zoom (instant). */
function ensureInView(b: { x: number; y: number; w: number; h: number }): void {
  const vp = viewport()
  if (!vp) return
  const { width, height } = stageSize()
  const top = 56
  const bottom = 48
  const v = vp.view
  const sx0 = v.x + b.x * v.k
  const sy0 = v.y + b.y * v.k
  const sx1 = sx0 + b.w * v.k
  const sy1 = sy0 + b.h * v.k
  let dx = 0
  let dy = 0
  if (sy1 - sy0 <= height - top - bottom) {
    if (sy1 > height - bottom) dy = height - bottom - sy1
    if (sy0 + dy < top) dy = top - sy0
  }
  if (sx1 - sx0 <= width - 32) {
    if (sx1 > width - 16) dx = width - 16 - sx1
    if (sx0 + dx < 16) dx = 16 - sx0
  }
  if (Math.abs(dx) + Math.abs(dy) > 1) vp.setView({ k: v.k, x: v.x + dx, y: v.y + dy })
}

/** Zoom to a block, but never below the scale where lecture names read (2^-1/2); a taller block is shown from its top. */
function zoomReadable(b: { x: number; y: number; w: number; h: number }): void {
  const vp = viewport()
  if (!vp) return
  const { width, height } = stageSize()
  const ah = height - 56 - 48
  const aw = width - 32
  const kMin = Math.SQRT1_2
  const pad = 24
  let box = b
  if (Math.min(aw / (b.w + 2 * pad), ah / (b.h + 2 * pad)) < kMin && aw / (b.w + 2 * pad) >= kMin) box = { x: b.x, y: b.y, w: b.w, h: ah / kMin - 2 * pad - 1 }
  vp.zoomToBox(box)
}

function setOpen(changes: Record<string, boolean>): void {
  overrides.value = { ...overrides.value, ...changes }
}

function clearHover(): void {
  hoverId.value = null
  hoverKey.value = ''
  info.hide()
}

/** Open or close one branch; the node stays exactly where it was on screen. */
function toggle(node: AtlasNode, value?: boolean): void {
  const before = layout.value.all.get(node.id)
  if (!before) return
  const prevKey = layout.value.key
  const at = screenOfNode(before, (viewport()?.view ?? { k: 1, x: 0, y: 0 }))
  userChanged = true
  clearHover()
  setOpen({ [node.id]: value === undefined ? !before.open : value })
  if (layout.value.key !== prevKey) deferLabels()
  const L = keepAt(node.id, at)
  if (L?.open) ensureInView(blockBox(L, layout.value.ox))
}

function zoomToNode(node: AtlasNode): void {
  const prevKey = layout.value.key
  userChanged = true
  if (node.kind === 'group' || node.kind === 'stage') {
    const before = layout.value.all.get(node.id)
    const at = before ? screenOfNode(before, viewport()?.view ?? { k: 1, x: 0, y: 0 }) : ([0, 0] as [number, number])
    const open: Record<string, boolean> = { [node.id]: true }
    for (const k of node.kids) if (k.kind === 'stage') open[k.id] = true
    clearHover()
    setOpen(open)
    if (layout.value.key !== prevKey) deferLabels()
    keepAt(node.id, at)
  }
  const L = layout.value.all.get(node.id)
  if (L) zoomReadable(blockBox(L, layout.value.ox))
}

function fit(): void {
  viewport()?.fit()
}

/**
 * Fit the NEW layout right now, before Vue patches the svg: the viewport's own `fit` reads the stage size after the
 * patch and so forces a layout of the whole new svg inside the event; this one reads it while the DOM is still clean.
 */
function fitNow(): void {
  const vp = viewport()
  const { width, height } = stageSize()
  if (!vp || width === 0) return
  vp.setView(fitTransform({ width: layout.value.width, height: layout.value.height }, { width, height }))
}

// ---- events (one delegate for the whole map) --------------------------------------------------------------------

function hit(ev: Event): { node: AtlasNode; part: string | null } | null {
  const el = ev.target
  if (!(el instanceof Element)) return null
  const holder = el.closest('[data-node]')
  if (!holder) return null
  const node = tree.value.byId.get(holder.getAttribute('data-node') ?? '')
  if (!node) return null
  return { node, part: el.closest('[data-atlas-part]')?.getAttribute('data-atlas-part') ?? null }
}

function openLecture(node: AtlasNode): void {
  if (node.lecture) void router.go(withBase(node.lecture.link))
}

function onClick(ev: MouseEvent): void {
  if (viewport()?.wasDragged) return
  const h = hit(ev)
  if (!h) return
  const { node, part } = h
  if (part === 'toggle') {
    clicks.cancel()
    toggle(node)
    return
  }
  if (part === 'strip') {
    clicks.cancel()
    toggle(node, true)
    return
  }
  switch (node.kind) {
    case 'lec':
      clicks.click(() => openLecture(node))
      break
    case 'group':
      clicks.click(() => {
        if (node.group) void router.go(props.groupHref(node.group.dir))
      })
      break
    case 'stage':
      clicks.cancel()
      toggle(node)
      break
    case 'cat': {
      clicks.cancel()
      const L = layout.value.all.get(node.id)
      userChanged = true
      if (L) viewport()?.zoomToBox(blockBox(L, layout.value.ox))
      break
    }
    case 'root':
      // the centre fits the whole map (prototype: root click -> fit(); its tooltip says so)
      clicks.cancel()
      fit()
      break
    default:
      break
  }
}

function onDblclick(ev: MouseEvent): void {
  const h = hit(ev)
  if (!h || h.part) return
  const { node } = h
  clicks.dblclick(() => {
    if (node.kind === 'lec') {
      const up = node.parent?.kind === 'stage' ? node.parent.parent : node.parent
      const L = up ? layout.value.all.get(up.id) : null
      if (L) zoomReadable(blockBox(L, layout.value.ox))
    } else if (node.kind === 'group' || node.kind === 'stage') zoomToNode(node)
  })
}

function nodeName(node: AtlasNode): string {
  if (node.kind === 'cat') return node.name || t('atlas.uncategorised')
  if (node.kind === 'group') return t('atlas.node.group', { id: node.id, title: node.name })
  if (node.kind === 'stage') return t('atlas.node.stage', { id: node.group?.id ?? '', label: layout.value.all.get(node.id)?.label ?? node.name })
  return t('atlas.node.lecture', { group: node.group?.id ?? '', n: node.lecture?.n ?? 0, title: node.name })
}

function depSection(ids: readonly string[], tone: 'pre' | 'post'): MapInfoContent['sections'] {
  if (ids.length === 0) return []
  const items = ids.slice(0, 6).map((id) => {
    const o = tree.value.byId.get(id)
    return o ? nodeName(o) : id
  })
  if (ids.length > 6) items.push(t('atlas.more', { n: ids.length }))
  return [{ heading: t(tone === 'pre' ? 'atlas.pre' : 'atlas.post'), tone, items }]
}

function infoFor(node: AtlasNode, part: string | null): MapInfoContent {
  const L = layout.value.all.get(node.id)
  const open = L?.open === true
  const action = t(open ? 'atlas.act.close' : 'atlas.act.open')
  const counts0 = counts.value.get(node.id) ?? { read: 0, reading: 0 }
  if (part === 'toggle' || part === 'strip') {
    return { title: nodeName(node), lines: [t(node.kind === 'group' ? 'atlas.tip.toggleGroup' : 'atlas.tip.toggleStage', { action })] }
  }
  if (node.kind === 'lec') {
    const pre = tree.value.pre.get(node.id) ?? []
    const post = tree.value.post.get(node.id) ?? []
    const status = t(`atlas.status.${statuses.value.get(node.id) ?? 'unread'}` as 'atlas.status.read')
    const line = pre.length + post.length > 0 ? t('atlas.tip.lecture', { status, pre: pre.length, post: post.length }) : t('atlas.tip.lectureNone', { status })
    return { title: nodeName(node), lines: [line], sections: [...(depSection(pre, 'pre') ?? []), ...(depSection(post, 'post') ?? [])] }
  }
  if (node.kind === 'group') {
    const line = counts0.reading
      ? t('atlas.tip.groupReading', { n: node.lec.length, read: counts0.read, reading: counts0.reading, action })
      : t('atlas.tip.group', { n: node.lec.length, read: counts0.read, action })
    return { title: nodeName(node), lines: [line] }
  }
  if (node.kind === 'stage') return { title: nodeName(node), lines: [t('atlas.tip.stage', { read: counts0.read, n: node.lec.length, action })] }
  if (node.kind === 'cat') return { title: nodeName(node), lines: [t('atlas.tip.category', { groups: node.kids.length, n: node.lec.length, read: counts0.read })] }
  return { title: props.siteName, lines: [t('atlas.tip.center')] }
}

function onOver(ev: PointerEvent): void {
  if (viewport()?.isMoving) return
  const h = hit(ev)
  if (!h || h.node.kind === 'root') {
    if (hoverKey.value) clearHover()
    return
  }
  const key = `${h.node.id}|${h.part ?? ''}`
  if (key === hoverKey.value) return
  hoverKey.value = key
  hoverId.value = h.node.id
  info.show(infoFor(h.node, h.part))
}

// ---- toolbar ----------------------------------------------------------------------------------------------------

function choosePreset(p: AtlasPreset): void {
  const prevKey = layout.value.key
  preset.value = p
  overrides.value = {}
  setRaw('atlasExpand', p)
  clearHover()
  userChanged = false
  // a new way of expanding always shows the whole new map (prototype: redraw, then fit), also after the reader moved it
  if (layout.value.key !== prevKey) deferLabels()
  fitNow()
}

function jump(): void {
  if (hits.value.length === 0) {
    if (query.value) say(t('atlas.noHit'))
    return
  }
  hitIndex = (hitIndex + 1) % hits.value.length
  const node = tree.value.byId.get(hits.value[hitIndex] as string)
  if (!node) return
  userChanged = true
  clearHover()
  const prevKey = layout.value.key
  const open: Record<string, boolean> = {}
  for (const id of ancestorsToOpen(node)) open[id] = true
  setOpen(open)
  if (layout.value.key !== prevKey) deferLabels()
  const L = layout.value.all.get(node.id)
  if (L) {
    const cx = L.xi + (L.side * L.w) / 2
    viewport()?.zoomToBox({ x: cx - 520, y: L.y - 200, w: 1040, h: 400 })
  }
  say(t('atlas.hit', { i: hitIndex + 1, n: hits.value.length, name: nodeName(node) }))
}

// ---- lifecycle --------------------------------------------------------------------------------------------------

let fontHandler: (() => void) | null = null

onMounted(() => {
  const stored = getRaw('atlasExpand')
  if (isAtlasPreset(stored)) preset.value = stored
  measured.value = true
  const fonts = document.fonts
  if (fonts) {
    void fonts.ready.then(() => fontsTick.value++)
    fontHandler = () => fontsTick.value++
    fonts.addEventListener('loadingdone', fontHandler)
  }
})

onBeforeUnmount(() => {
  if (fontHandler) document.fonts?.removeEventListener('loadingdone', fontHandler)
  if (statusTimer) clearTimeout(statusTimer)
})

// the map of a reader who has not touched it follows what changes on its own (measured fonts, progress, a new language)
watch(
  () => layout.value.key,
  () => {
    const vp = viewport()
    if (vp && !userChanged && !vp.touched) {
      deferLabels()
      fitNow()
    }
  },
)

defineExpose({ layout, preset, choosePreset, fit })
</script>

<template>
  <MapStage ref="stage" class="am-map" :width="layout.width" :height="layout.height" v-bind="stageProps" @commit="onCommit">
    <template #hud>
      <input v-model="queryRaw" class="am-search" type="search" :aria-label="t('atlas.search.label')" :placeholder="t('atlas.search.placeholder')" autocomplete="off" @keydown.enter.prevent="jump" />
      <span class="am-expand" role="group" :aria-label="t('atlas.expand.group')">
        <label>{{ t('atlas.expand.label') }}</label>
        <button v-for="p in ATLAS_PRESETS" :key="p" type="button" :data-x="p" :aria-pressed="preset === p" :title="t(`atlas.expand.${p}Tip` as 'atlas.expand.readingTip')" @click="choosePreset(p)">
          {{ t(`atlas.expand.${p}` as 'atlas.expand.reading') }}
        </button>
      </span>
      <span class="am-legend" aria-hidden="true">
        <span class="am-lg"><i class="am-lg-dot" />{{ t('canvas.legend.unread') }}</span>
        <span class="am-lg"><i class="am-lg-dot reading" />{{ t('canvas.legend.reading') }}</span>
        <span class="am-lg"><i class="am-lg-dot read" />{{ t('canvas.legend.read') }}</span>
        <span class="am-lg"><i class="am-lg-line" />{{ t('canvas.legend.pre') }}</span>
        <span class="am-lg"><i class="am-lg-line post" />{{ t('canvas.legend.post') }}</span>
      </span>
      <span class="am-lg am-info">{{ t('atlas.info') }}</span>
      <span class="am-status" role="status" aria-live="polite">{{ statusMsg }}</span>
    </template>
    <g class="am-layer" :class="{ 'am-dim': focus !== null, 'am-searching': query !== '' }" @click="onClick" @dblclick="onDblclick" @pointerover="onOver" @pointerleave="clearHover">
      <component :is="parts.cat.component" v-for="p in drawn.cats" :key="p.id" v-memo="[parts.cat.impl, p.x0, p.xi, p.xo, p.w, p.y, p.label, p.labelW, p.caption, p.captionW, p.trunk, p.read, p.total, p.groups, p.innerX, p.outerX, p.zoneTop, p.zoneH, p.highlight, p.match]" v-bind="p" />
      <SlotList :items="drawn.links" :comp="parts.link.component" :key-of="linkKey" />
      <component :is="parts.center.component" v-bind="drawn.center" data-node="root" data-slot="AtlasCenter" :data-slot-impl="parts.center.impl" />
      <component :is="parts.group.component" v-for="p in drawn.groups" :key="p.id" v-memo="[parts.group.impl, p.x0, p.xi, p.xo, p.w, p.y, p.title, p.progress, p.ticks, p.stripFrom, p.stripCol, p.open, p.read, p.reading, p.highlight, p.match]" v-bind="p" />
      <SlotList :items="drawn.phases" :comp="parts.phase.component" :key-of="nodeKey" />
      <SlotList :items="drawn.lecs" :comp="parts.lecture.component" :key-of="nodeKey" />
      <text v-for="b in drawn.bigs" :key="b.id" v-memo="[b.x, b.y, b.anchor, b.size, b.text]" class="am-big" data-label-kind="big" :x="b.x" :y="b.y" :text-anchor="b.anchor" :style="{ fontSize: `${b.size}px` }">{{ b.text }}</text>
    </g>
    <template #overlay>
      <ZoomLabel />
      <MapInfoPanel :content="info.content.value" :open="info.open.value" />
    </template>
  </MapStage>
</template>

<style>
.am-big { font-family: var(--lec-font-heading); font-weight: 900; paint-order: stroke; stroke: var(--lec-bg); stroke-width: 6px; fill: var(--lec-text); pointer-events: none; }
.am-search { width: 190px; height: 30px; padding: 0 10px; color: var(--lec-text); background: var(--lec-bg); border: 1px solid var(--lec-border); border-radius: var(--lec-radius-1, 4px); user-select: text; -webkit-user-select: text; }
.am-search:focus-visible { outline: 2px solid var(--lec-accent); outline-offset: 1px; }
.am-expand { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--lec-text-muted); }
.am-expand button { height: 30px; padding: 0 10px; color: var(--lec-text); background: var(--lec-bg); border: 1px solid var(--lec-border); border-radius: var(--lec-radius-1, 4px); cursor: pointer; }
.am-expand button:hover { color: var(--lec-accent); border-color: var(--lec-accent); }
.am-expand button[aria-pressed='true'] { color: var(--lec-bg); background: var(--lec-text); border-color: var(--lec-text); }
.am-expand button:focus-visible { outline: 2px solid var(--lec-accent); outline-offset: 1px; }
.am-status { padding: 4px 8px; font-size: 12.5px; color: var(--lec-text); }
.am-status:empty { display: none; }
/* legend chips, the how-to chip and the zoom label (home-canvas prototype `.chip`: 12px, 3px 8px, 1px border, --lec-bg) */
.am-legend { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.am-lg { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px; font-size: 12px; line-height: 1.6; color: var(--lec-text-muted); background: var(--lec-bg); border: 1px solid var(--lec-border); border-radius: var(--lec-radius-1, 4px); white-space: nowrap; }
.am-lg-dot { width: 9px; height: 9px; border-radius: var(--lec-status-radius, 50%); border: 1.5px solid var(--lec-border); background: var(--lec-bg); }
.am-lg-dot.reading { border-color: var(--lec-accent); background: linear-gradient(to top, var(--lec-accent) 50%, transparent 50%); }
.am-lg-dot.read { border-color: var(--lec-done); background: var(--lec-done); }
.am-lg-line { width: 20px; height: 0; border-top: 2px solid var(--lec-accent); }
.am-lg-line.post { border-top: 2px dashed var(--lec-done); }
.am-info { white-space: normal; }
.am-zoomlabel { position: absolute; z-index: 2; left: 12px; bottom: 12px; padding: 3px 9px; font-size: 12px; line-height: 1.6; color: var(--lec-text-muted); background: var(--lec-bg); border: 1px solid var(--lec-border); border-radius: var(--lec-radius-1, 4px); pointer-events: none; }
@media (max-width: 700px) {
  .am-legend, .am-info { display: none; }
}
</style>
