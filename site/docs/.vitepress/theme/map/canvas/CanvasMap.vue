<script setup lang="ts">
/**
 * CanvasMap.vue - global dependency canvas (`graph` mode, P4b, docs-dev/MAP.md).
 *
 * Lazily loads pre-computed ELK + libavoid coordinates from `canvasLoader` (plus readable P3b `/_access/<tier>/canvas.json`
 * slices), delegates rendering to the four canvas theme slots (`CanvasBackdrop`, `CanvasGroup`, `CanvasNode`,
 * `CanvasEdge`), and reuses `MapStage`, `MapViewport`, `LabelLayer`, `MapInfoPanel`, and `useClickRule`.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRouter, withBase } from 'vitepress'
import { useT } from '../../../i18n/useT'
import type { CanvasBundle, CanvasDatasheetMode } from '../../../curriculum/canvasTypes'
import { emptyCanvasBundle } from '../../../curriculum/canvasTypes'
import type { CurriculumData } from '../../../curriculum/data'
import { loadCanvas } from '../../curriculum/canvasLoader'
import { getRaw, setRaw } from '../../core/storage'
import { useProgress } from '../../progress/useProgress'
import { slotRuntime } from '../../slots'
import type { AtlasStatus, CanvasNodeProps } from '../../slots/registry'
import MapInfoPanel from '../MapInfoPanel.vue'
import MapStage from '../MapStage.vue'
import { mapAriaLabel, mapSvgLabel } from '../aria'
import type { Insets, Transform } from '../geometry'
import { DEFAULT_INSETS } from '../geometry'
import type { Label } from '../labels'
import { useClickRule } from '../useClickRule'
import { useInfoPanel } from '../useInfoPanel'
import { pad2 } from '../atlas/model'
import CanvasTracePanel, { type CanvasLockTarget, type TraceLectureView } from './CanvasTracePanel.vue'
import { canvasNodeCenter, isCanvasArrowKey, pickNextCanvasNode } from './keyboard'
import {
  buildCanvasBoardView,
  buildCanvasIndex,
  canvasLectureMatches,
  unionBoxes,
  type CanvasFocusState,
  type CanvasSkinId,
} from './model'

const props = defineProps<{
  curriculum: CurriculumData
  groupHref: (dir: string) => string
}>()

const { t, lang } = useT()
const router = useRouter()
const progress = useProgress()
const clicks = useClickRule()
const tip = useInfoPanel()
slotRuntime.useActive()

const stage = ref<InstanceType<typeof MapStage> | null>(null)
const bundle = shallowRef<CanvasBundle | null>(null)
const bundleVersion = ref(0)
const dsMode = ref<CanvasDatasheetMode>('compact')
const zoomK = ref(1)
const queryRaw = ref('')

const lock = ref<CanvasLockTarget | null>(null)
const hoverNodeId = ref<string | null>(null)
const hotPairKey = ref<string | null>(null)
const hotTraceKey = ref<string | null>(null)
const hotPanelNodeId = ref<string | null>(null)
const activeNodeId = ref<string | null>(null)

const backdropPart = computed(() => slotRuntime.resolve('CanvasBackdrop'))
const groupPart = computed(() => slotRuntime.resolve('CanvasGroup'))
const nodePart = computed(() => slotRuntime.resolve('CanvasNode'))
const edgePart = computed(() => slotRuntime.resolve('CanvasEdge'))

const skin = computed<CanvasSkinId>(() =>
  groupPart.value?.impl === 'datasheet' ? 'datasheet' : 'reader',
)

let loadSeq = 0
async function refreshBundle(): Promise<void> {
  const seq = ++loadSeq
  const loaded = await loadCanvas(props.curriculum.edges)
  if (seq !== loadSeq) return
  const firstLoad = bundle.value === null
  bundle.value = loaded
  bundleVersion.value++
  if (firstLoad) {
    await nextTick()
    stage.value?.viewport?.fit()
    const k = stage.value?.viewport?.transform?.value?.k
    if (typeof k === 'number') zoomK.value = k
  }
}

function onWindowKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape' || ev.defaultPrevented) return
  if (lock.value !== null) {
    clearLock()
    ev.preventDefault()
  }
}

onMounted(() => {
  const storedMode = getRaw('canvasDsMode')
  if (storedMode === 'compact' || storedMode === 'zones') dsMode.value = storedMode
  void refreshBundle()
  window.addEventListener('keydown', onWindowKeydown)
})

function chooseDsMode(mode: CanvasDatasheetMode): void {
  dsMode.value = mode
  setRaw('canvasDsMode', mode)
}

watch(
  () => props.curriculum.edges,
  () => {
    void refreshBundle()
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  clicks.cancel()
})

watch([skin, dsMode], async () => {
  if (!bundle.value) return
  await nextTick()
  stage.value?.viewport?.fit()
  const k = stage.value?.viewport?.transform?.value?.k
  if (typeof k === 'number') zoomK.value = k
})

const statuses = computed(() => {
  const m = new Map<string, AtlasStatus>()
  for (const g of props.curriculum.groups) {
    for (const l of g.lectures) {
      const s = progress.statusOf(l.id)
      m.set(l.id, s === 'completed' ? 'read' : s === 'in_progress' ? 'reading' : 'unread')
    }
  }
  return m
})

const activeBundle = computed<CanvasBundle>(() => bundle.value ?? emptyCanvasBundle())

const graphIndex = computed(() =>
  buildCanvasIndex(props.curriculum, activeBundle.value.reader.edges.length > 0 ? activeBundle.value.reader.edges : undefined),
)

const query = computed(() => queryRaw.value.trim().toLowerCase())

const matches = computed(() => {
  const set = new Set<string>()
  const q = query.value
  if (!q) return set
  for (const g of props.curriculum.groups) {
    for (const l of g.lectures) {
      if (canvasLectureMatches(l, g.id, q)) set.add(l.id)
    }
  }
  return set
})

const pairKeyOf = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

const effectiveHoverNodeId = computed<string | null>(() => {
  if (hoverNodeId.value) return hoverNodeId.value
  if (lock.value?.type === 'node' && hotPanelNodeId.value) return hotPanelNodeId.value
  return null
})

const focus = computed<CanvasFocusState>(() => {
  const idx = graphIndex.value
  const lk = lock.value
  if (lk?.type === 'node') {
    const id = lk.id
    const preIds = idx.pre.get(id) ?? []
    const postIds = idx.post.get(id) ?? []
    const activeNodes = new Set<string>([id, ...preIds, ...postIds])
    const activeGroups = new Set<string>()
    for (const nid of activeNodes) {
      const gid = idx.byId.get(nid)?.groupId
      if (gid) activeGroups.add(gid)
    }
    return {
      activeNodes,
      activeGroups,
      lockedId: id,
      activePairKey: null,
      preEdges: preIds.map((s) => [s, id] as const),
      postEdges: postIds.map((p) => [id, p] as const),
    }
  }
  if (lk?.type === 'pair') {
    const activeNodes = new Set<string>()
    for (const [s, t] of lk.edges) {
      activeNodes.add(s)
      activeNodes.add(t)
    }
    return {
      activeNodes,
      activeGroups: new Set([lk.a, lk.b]),
      lockedId: null,
      activePairKey: pairKeyOf(lk.a, lk.b),
      preEdges: lk.edges,
      postEdges: [],
    }
  }
  return {
    activeNodes: new Set(),
    activeGroups: new Set(),
    lockedId: null,
    activePairKey: null,
    preEdges: [],
    postEdges: [],
  }
})

const effectiveHotTraceKey = computed<string | null>(() => {
  if (hotTraceKey.value) return hotTraceKey.value
  const lk = lock.value
  if (lk?.type === 'node' && hotPanelNodeId.value) {
    const target = hotPanelNodeId.value
    if (focus.value.preEdges.some(([s, t]) => s === target && t === lk.id)) {
      return `trace-pre:${target}>${lk.id}`
    }
    if (focus.value.postEdges.some(([s, t]) => s === lk.id && t === target)) {
      return `trace-post:${lk.id}>${target}`
    }
  }
  return null
})

const view = computed(() =>
  buildCanvasBoardView({
    bundle: activeBundle.value,
    skin: skin.value,
    dsMode: dsMode.value,
    curriculum: props.curriculum,
    index: graphIndex.value,
    statuses: statuses.value,
    focus: focus.value,
    hoverNodeId: effectiveHoverNodeId.value,
    hotPairKey: hotPairKey.value,
    hotTraceKey: effectiveHotTraceKey.value,
    matches: matches.value,
    labels: {
      uncategorised: t('atlas.uncategorised'),
      toUnit: (target, count) => t('canvas.toUnit', { unit: target, n: count }),
      fromUnit: (source, count) => t('canvas.fromUnit', { unit: source, n: count }),
    },
  }),
)

const isDimmed = computed(() => lock.value !== null)
const lodFar = computed(() => zoomK.value < 0.22)
const lodMid = computed(() => zoomK.value >= 0.22 && zoomK.value < 0.45)

const totalLectures = computed(() =>
  props.curriculum.groups.reduce((sum, g) => sum + g.lectures.length, 0),
)
const stageAria = computed(() =>
  mapAriaLabel(lang.value, {
    groups: props.curriculum.groups.length,
    lectures: totalLectures.value,
    edges: props.curriculum.edges.length,
  }),
)
const svgAria = computed(() => mapSvgLabel(lang.value))

const labelsKey = computed(() =>
  [
    backdropPart.value?.impl ?? '',
    groupPart.value?.impl ?? '',
    nodePart.value?.impl ?? '',
    edgePart.value?.impl ?? '',
    skin.value,
    dsMode.value,
    lang.value,
    view.value.width,
    view.value.height,
    bundleVersion.value,
  ].join('|'),
)

const stageProps = computed(() => ({
  ariaLabel: stageAria.value,
  svgLabel: svgAria.value,
  labelsKey: labelsKey.value,
  labelOptions,
  insets: stageInsets,
  onEscape,
}))

const labelOptions = {
  visible(label: Label, k: number): boolean {
    if (label.kind === 'ann') return k >= 0.22 && Boolean(label.el.closest('.bundle-g.on'))
    if (label.kind === 'big') return k < 0.22
    if (label.kind === 'mid' || label.kind === 'num') return k >= 0.22
    if (label.kind === 'name' || label.kind === 'nc') return k >= 0.45
    return true
  },
}

const stageInsets = (panelOpen: boolean): Insets => {
  const width = stage.value?.stage?.clientWidth ?? 1440
  if (width <= 700) {
    return {
      ...DEFAULT_INSETS,
      top: 56,
      left: 16,
      right: 16,
      bottom: panelOpen ? 240 : 40,
    }
  }
  return {
    ...DEFAULT_INSETS,
    top: 56,
    left: panelOpen ? 404 : 16,
    right: 24,
    bottom: 32,
  }
}

const edgeInfoText = computed(() => {
  const drawn = activeBundle.value.reader.edges.reduce((n, e) => n + (e[2] ? 1 : 0), 0)
  const main = t('canvas.edgeInfo', { drawn })
  const off = activeBundle.value.reader.offMap
  if (off.length === 0) return main
  return `${main}; ${t('canvas.edgeInfoOff', { groups: off.join(t('canvas.listSep')) })}`
})

const zoomLabelText = computed(() => {
  if (zoomK.value < 0.22) return t('canvas.zoom.far')
  if (zoomK.value < 0.45) return t('canvas.zoom.mid')
  return t('canvas.zoom.near')
})

function traceLectureOf(id: string): TraceLectureView | null {
  const l = graphIndex.value.byId.get(id)
  if (!l) return null
  return {
    id: l.id,
    label: `${l.groupId} ${t('card.lectureLine', { n: pad2(l.n), title: l.title })}`,
    href: withBase(l.link),
    status: statuses.value.get(l.id) ?? 'unread',
  }
}

const lockedLecture = computed(() =>
  lock.value?.type === 'node' ? traceLectureOf(lock.value.id) : null,
)

const preLectures = computed<TraceLectureView[]>(() => {
  if (lock.value?.type !== 'node') return []
  return (graphIndex.value.pre.get(lock.value.id) ?? [])
    .map(traceLectureOf)
    .filter((v): v is TraceLectureView => v !== null)
})

const postLectures = computed<TraceLectureView[]>(() => {
  if (lock.value?.type !== 'node') return []
  return (graphIndex.value.post.get(lock.value.id) ?? [])
    .map(traceLectureOf)
    .filter((v): v is TraceLectureView => v !== null)
})

const pairItems = computed(() => {
  if (lock.value?.type !== 'pair') return []
  const items: Array<{ traceKey: string; targetId: string; from: TraceLectureView; to: TraceLectureView }> = []
  for (const [s, toId] of lock.value.edges) {
    const from = traceLectureOf(s)
    const to = traceLectureOf(toId)
    if (!from || !to) continue
    items.push({
      traceKey: `trace-pre:${s}>${toId}`,
      targetId: toId,
      from,
      to,
    })
  }
  return items
})

const traceLabels = computed(() => ({
  ariaLabel: t('canvas.trace.aria'),
  tracing: t('canvas.trace.tracing'),
  exit: t('canvas.trace.exit'),
  open: t('canvas.trace.open'),
  traceBtn: t('canvas.trace.btn'),
  preHeading: (n: number) => t('canvas.trace.pre', { n }),
  postHeading: (n: number) => t('canvas.trace.post', { n }),
  nonePre: t('canvas.trace.nonePre'),
  nonePost: t('canvas.trace.nonePost'),
  nodeHint: t('canvas.trace.nodeHint'),
  pairHeading: (a: string, b: string, n: number) => t('canvas.trace.pairHeading', { a, b, n }),
  pairHint: t('canvas.trace.pairHint'),
}))

const traceEdgesByKey = computed(() => {
  const m = new Map<string, { from: string; to: string; kind: 'trace-pre' | 'trace-post' }>()
  for (const te of view.value.traceEdges) {
    m.set(te.key, { from: te.from, to: te.to, kind: te.props.kind === 'trace-pre' ? 'trace-pre' : 'trace-post' })
  }
  return m
})

function onCommit(tr: Transform): void {
  zoomK.value = tr.k
}

function clearLock(): void {
  lock.value = null
  hotPairKey.value = null
  hotTraceKey.value = null
  hotPanelNodeId.value = null
}

function onEscape(): boolean {
  if (lock.value !== null) {
    clearLock()
    return true
  }
  if (queryRaw.value !== '') {
    queryRaw.value = ''
    return true
  }
  return false
}

async function lockOnNode(id: string): Promise<void> {
  if (!graphIndex.value.byId.has(id)) return
  hoverNodeId.value = null
  hotPairKey.value = null
  hotTraceKey.value = null
  hotPanelNodeId.value = null
  tip.hide()
  lock.value = { type: 'node', id }
  await nextTick()
  const preIds = graphIndex.value.pre.get(id) ?? []
  const postIds = graphIndex.value.post.get(id) ?? []
  const box = unionBoxes([id, ...preIds, ...postIds].map((nid) => view.value.nodeBoxOf(nid)))
  if (box) stage.value?.viewport?.zoomToBox(box, { panelOpen: true })
}

async function lockOnPair(pairKey: string): Promise<void> {
  const [a = '', b = ''] = pairKey.split('|')
  if (!a || !b) return
  const edges = graphIndex.value.pairEdges.get(pairKey) ?? []
  hoverNodeId.value = null
  hotPairKey.value = null
  hotTraceKey.value = null
  hotPanelNodeId.value = null
  tip.hide()
  lock.value = { type: 'pair', a, b, edges }
  await nextTick()
  const box = unionBoxes([view.value.groupBoxOf(a), view.value.groupBoxOf(b)])
  if (box) stage.value?.viewport?.zoomToBox(box, { panelOpen: true })
}

function openUrl(href: string): void {
  void router.go(href)
}

function jumpToMatch(): void {
  const first = matches.value.values().next().value as string | undefined
  if (!first) return
  void lockOnNode(first)
  const pt = view.value.focusPointOf(first)
  if (pt && !lock.value) stage.value?.viewport?.panTo(pt[0], pt[1])
}

function onPanelHover(val: string | null): void {
  if (val === null) {
    hotPanelNodeId.value = null
    hotTraceKey.value = null
    return
  }
  if (lock.value?.type === 'pair') {
    hotTraceKey.value = val
    hotPanelNodeId.value = null
  } else {
    hotPanelNodeId.value = val
    hotTraceKey.value = null
  }
}

function showNodeTip(id: string): void {
  const l = graphIndex.value.byId.get(id)
  if (!l) return
  const st = t(`atlas.status.${statuses.value.get(id) ?? 'unread'}` as 'atlas.status.read')
  const preN = (graphIndex.value.pre.get(id) ?? []).length
  const postN = (graphIndex.value.post.get(id) ?? []).length
  tip.show({
    title: `${l.groupId} ${t('card.lectureLine', { n: pad2(l.n), title: l.title })}`,
    lines: [t('canvas.tip.lecture', { status: st, pre: preN, post: postN })],
  })
}

function showBundleTip(pairKey: string): void {
  const [a = '', b = ''] = pairKey.split('|')
  const edges = graphIndex.value.pairEdges.get(pairKey) ?? []
  const preview = edges.slice(0, 6).map(([s, tId]) => {
    const ls = graphIndex.value.byId.get(s)
    const lt = graphIndex.value.byId.get(tId)
    return `${ls ? `${ls.groupId}-${pad2(ls.n)}` : s} → ${lt ? `${lt.groupId}-${pad2(lt.n)}` : tId}`
  })
  if (edges.length > 6) preview.push(t('canvas.tip.bundleMore', { n: edges.length - 6 }))
  tip.show({
    title: t('canvas.tip.bundleTitle', { a, b, n: edges.length }),
    lines: preview,
    sections: [{ text: t('canvas.tip.bundleHint') }],
  })
}

function showTraceTip(traceKey: string): void {
  const te = traceEdgesByKey.value.get(traceKey)
  if (!te) return
  const ls = graphIndex.value.byId.get(te.from)
  const lt = graphIndex.value.byId.get(te.to)
  const isPre = te.kind === 'trace-pre'
  tip.show({
    title: `${ls ? `${ls.groupId} ${pad2(ls.n)} ${ls.title}` : te.from} → ${lt ? `${lt.groupId} ${pad2(lt.n)} ${lt.title}` : te.to}`,
    lines: [
      isPre ? t('canvas.tip.linkPre') : t('canvas.tip.linkPost'),
      isPre ? t('canvas.tip.linkMovePre') : t('canvas.tip.linkMovePost'),
    ],
  })
}

function clearHover(): void {
  hoverNodeId.value = null
  hotPairKey.value = null
  hotTraceKey.value = null
  tip.hide()
}

const vp = () => stage.value?.viewport?.viewport.value ?? null

function onOver(ev: PointerEvent): void {
  if (vp()?.isMoving) return
  const target = ev.target as Element | null
  if (!target) {
    clearHover()
    return
  }
  const lkEl = target.closest('.lk')
  if (lkEl) {
    const tk = lkEl.getAttribute('data-trace-key') ?? ''
    if (tk) {
      hoverNodeId.value = null
      hotPairKey.value = null
      hotTraceKey.value = tk
      showTraceTip(tk)
    }
    return
  }
  const nodeEl = target.closest('.cv-node')
  if (nodeEl) {
    const id = nodeEl.getAttribute('data-id') ?? ''
    if (id) {
      hotTraceKey.value = null
      hotPairKey.value = null
      hoverNodeId.value = id
      showNodeTip(id)
    }
    return
  }
  const bundleEl = target.closest('.bundle-g')
  if (bundleEl) {
    const pk = bundleEl.getAttribute('data-pair') ?? ''
    if (pk) {
      hoverNodeId.value = null
      hotTraceKey.value = null
      hotPairKey.value = pk
      showBundleTip(pk)
    }
    return
  }
  clearHover()
}

function onLayerClick(ev: MouseEvent): void {
  if (vp()?.wasDragged) return
  const target = ev.target as Element | null
  if (!target) return

  const lkEl = target.closest('.lk')
  if (lkEl) {
    const tk = lkEl.getAttribute('data-trace-key') ?? ''
    const te = traceEdgesByKey.value.get(tk)
    if (te) {
      clicks.cancel()
      const nextId =
        lock.value?.type === 'pair'
          ? te.to
          : te.kind === 'trace-pre'
            ? te.from
            : te.to
      void lockOnNode(nextId)
    }
    return
  }

  const nodeEl = target.closest('.cv-node')
  if (nodeEl) {
    const id = nodeEl.getAttribute('data-id') ?? ''
    const l = graphIndex.value.byId.get(id)
    if (l) clicks.click(() => void router.go(withBase(l.link)))
    return
  }

  const bundleEl = target.closest('.bundle-g')
  if (bundleEl) {
    const pk = bundleEl.getAttribute('data-pair') ?? ''
    if (pk) {
      clicks.cancel()
      void lockOnPair(pk)
    }
    return
  }

  const grpEl = target.closest('.g-hit')
  if (grpEl) {
    const gId = grpEl.getAttribute('data-g') ?? ''
    const cg = graphIndex.value.groupsById.get(gId)
    if (cg) clicks.click(() => void router.go(props.groupHref(cg.dir)))
  }
}

function onLayerDblclick(ev: MouseEvent): void {
  const target = ev.target as Element | null
  if (!target) return

  const nodeEl = target.closest('.cv-node')
  if (nodeEl) {
    ev.preventDefault()
    ev.stopPropagation()
    const id = nodeEl.getAttribute('data-id') ?? ''
    clicks.dblclick(() => {
      if (id) void lockOnNode(id)
    })
    return
  }

  const grpEl = target.closest('.g-hit')
  if (grpEl) {
    ev.preventDefault()
    ev.stopPropagation()
    const gId = grpEl.getAttribute('data-g') ?? ''
    clicks.dblclick(() => {
      const box = view.value.groupBoxOf(gId)
      if (box) stage.value?.viewport?.zoomToBox(box, { panelOpen: lock.value !== null })
    })
  }
}

function onStageClick(ev: MouseEvent): void {
  if (vp()?.wasDragged) return
  const target = ev.target as Element | null
  if (!target) return
  if (target.closest('.lec-map-hud, .lec-map-panel, .cv-node, .g-hit, .bundle-g, .lk')) return
  if (lock.value !== null) {
    clicks.cancel()
    clearLock()
  }
}

const rovingNodeId = computed<string | null>(() => {
  const nodes = view.value.nodes
  if (nodes.length === 0) return null
  if (activeNodeId.value && nodes.some((n) => n.id === activeNodeId.value)) return activeNodeId.value
  const lk = lock.value
  if (lk?.type === 'node' && nodes.some((n) => n.id === lk.id)) return lk.id
  return nodes[0]!.id
})

function nodeAriaLabel(n: CanvasNodeProps): string {
  const l = graphIndex.value.byId.get(n.id)
  const group = l?.groupId ?? n.id.split('-')[0]?.toUpperCase() ?? ''
  const title = l?.title ?? n.label
  const status = t(`atlas.status.${n.status}` as 'atlas.status.read')
  return t('canvas.node.aria', { group, no: n.number, title, status })
}

function ensureNodeVisible(id: string): void {
  const viewport = vp()
  const el = stage.value?.stage
  if (!viewport || !el) return
  const node = view.value.nodes.find((n) => n.id === id)
  if (!node) return
  const c = canvasNodeCenter(node, skin.value)
  const tr = viewport.view
  const sx = tr.x + c.x * tr.k
  const sy = tr.y + c.y * tr.k
  const ins = stageInsets(lock.value !== null)
  const w = el.clientWidth || 1440
  const h = el.clientHeight || 900
  let dx = 0
  let dy = 0
  if (sx < ins.left + 20) dx = ins.left + 40 - sx
  else if (sx > w - ins.right - 20) dx = w - ins.right - 40 - sx
  if (sy < ins.top + 20) dy = ins.top + 40 - sy
  else if (sy > h - ins.bottom - 20) dy = h - ins.bottom - 40 - sy
  if (dx !== 0 || dy !== 0) viewport.panBy(dx, dy)
}

function onNodeFocus(id: string): void {
  activeNodeId.value = id
}

async function focusCanvasNode(id: string): Promise<void> {
  activeNodeId.value = id
  await nextTick()
  const safe = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&')
  const target = stage.value?.svg?.querySelector<SVGGElement>(`.cv-node[data-id="${safe}"]`)
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true })
  ensureNodeVisible(id)
}

function onNodeKeydown(ev: KeyboardEvent, id: string): void {
  if (ev.key === 'Enter') {
    ev.preventDefault()
    ev.stopPropagation()
    clicks.cancel()
    const l = graphIndex.value.byId.get(id)
    if (l) void router.go(withBase(l.link))
    return
  }
  if (isCanvasArrowKey(ev.key)) {
    ev.preventDefault()
    ev.stopPropagation()
    const positions = view.value.nodes.map((n) => canvasNodeCenter(n, skin.value))
    const nextId = pickNextCanvasNode(positions, id, ev.key)
    if (nextId) void focusCanvasNode(nextId)
  }
}
</script>

<template>
  <MapStage
    ref="stage"
    class="cv-stage"
    :class="`cv-stage--${skin}`"
    :data-canvas-ready="bundle ? 'true' : undefined"
    :width="view.width"
    :height="view.height"
    v-bind="stageProps"
    @commit="onCommit"
    @fit="clearLock"
    @click="onStageClick"
  >
    <template #defs>
      <marker id="cv-ah" viewBox="0 0 8 6" refX="7" refY="3" markerWidth="6" markerHeight="4.5" orient="auto">
        <path d="M0 0.5L7 3L0 5.5Z" class="cv-m-ie" />
      </marker>
      <marker id="cv-ah-b" viewBox="0 0 8 6" refX="7" refY="3" markerWidth="5" markerHeight="3.8" orient="auto">
        <path d="M0 0.5L7 3L0 5.5Z" class="cv-m-b" />
      </marker>
      <marker id="cv-ah-pre" viewBox="0 0 8 6" refX="7" refY="3" markerWidth="6" markerHeight="4.5" orient="auto">
        <path d="M0 0.5L7 3L0 5.5Z" class="cv-m-pre" />
      </marker>
      <marker id="cv-ah-post" viewBox="0 0 8 6" refX="7" refY="3" markerWidth="6" markerHeight="4.5" orient="auto">
        <path d="M0 0.5L7 3L0 5.5Z" class="cv-m-post" />
      </marker>
    </template>

    <template #hud>
      <input
        v-model="queryRaw"
        class="cv-search"
        type="search"
        :aria-label="t('canvas.search.label')"
        :placeholder="t('canvas.search.placeholder')"
        autocomplete="off"
        @keydown.enter.prevent="jumpToMatch"
      />
      <div class="cv-legend" aria-hidden="true">
        <span class="lg"><i class="lg-dot unread" />{{ t('canvas.legend.unread') }}</span>
        <span class="lg"><i class="lg-dot reading" />{{ t('canvas.legend.reading') }}</span>
        <span class="lg"><i class="lg-dot read" />{{ t('canvas.legend.read') }}</span>
        <span class="lg"><i class="lg-line pre" />{{ t('canvas.legend.pre') }}</span>
        <span class="lg"><i class="lg-line post" />{{ t('canvas.legend.post') }}</span>
      </div>
      <div
        v-if="skin === 'datasheet'"
        id="dslayout"
        class="cv-layout-sw"
        role="group"
        :aria-label="t('canvas.layout.group')"
      >
        <button
          type="button"
          data-l="compact"
          :aria-pressed="dsMode === 'compact'"
          @click="chooseDsMode('compact')"
        >
          {{ t('canvas.layout.compact') }}
        </button>
        <button
          type="button"
          data-l="zones"
          :aria-pressed="dsMode === 'zones'"
          @click="chooseDsMode('zones')"
        >
          {{ t('canvas.layout.zones') }}
        </button>
      </div>
      <span v-if="bundle" id="edgeinfo" class="cv-edgeinfo">{{ edgeInfoText }}</span>
    </template>

    <g
      class="cv-layer"
      :class="{
        'cv-dim': isDimmed,
        'cv-searching': query !== '',
        'lod-far': lodFar,
        'lod-mid': lodMid,
      }"
      @click="onLayerClick"
      @dblclick="onLayerDblclick"
      @pointerover="onOver"
      @pointerleave="clearHover"
    >
      <component
        :is="backdropPart.component"
        v-if="backdropPart"
        v-bind="view.backdrop"
        data-slot="CanvasBackdrop"
        :data-slot-impl="backdropPart.impl"
      />
      <template v-if="edgePart">
        <component
          :is="edgePart.component"
          v-for="(ie, idx) in view.intraEdges"
          :key="`ie-${idx}`"
          v-bind="ie"
          data-slot="CanvasEdge"
          :data-slot-impl="edgePart.impl"
        />
        <component
          :is="edgePart.component"
          v-for="be in view.bundleEdges"
          :key="`be-${be.pairKey}`"
          v-bind="be"
          data-slot="CanvasEdge"
          :data-slot-impl="edgePart.impl"
        />
      </template>
      <template v-if="groupPart">
        <component
          :is="groupPart.component"
          v-for="g in view.groups"
          :key="g.id"
          v-bind="g"
          data-slot="CanvasGroup"
          :data-slot-impl="groupPart.impl"
        />
      </template>
      <template v-if="nodePart">
        <component
          :is="nodePart.component"
          v-for="n in view.nodes"
          :key="n.id"
          v-bind="n"
          :tabindex="n.id === rovingNodeId ? 0 : -1"
          role="button"
          :aria-label="nodeAriaLabel(n)"
          data-slot="CanvasNode"
          :data-slot-impl="nodePart.impl"
          @focus="onNodeFocus(n.id)"
          @keydown="onNodeKeydown($event, n.id)"
        />
      </template>
      <template v-if="edgePart">
        <component
          :is="edgePart.component"
          v-for="te in view.traceEdges"
          :key="te.key"
          v-bind="te.props"
          :data-trace-key="te.key"
          data-slot="CanvasEdge"
          :data-slot-impl="edgePart.impl"
        />
      </template>
      <text
        v-for="b in view.bigLabels"
        :key="`big-${b.id}`"
        class="cv-big"
        data-label-kind="big"
        text-anchor="middle"
        :x="b.x"
        :y="b.y"
        :style="{ fontSize: `${b.size}px` }"
      >
        {{ b.id }}
      </text>
    </g>

    <template #overlay>
      <div id="zoomlabel" class="lec-map-panel cv-zoomlabel" aria-live="polite">{{ zoomLabelText }}</div>
      <MapInfoPanel :content="tip.content.value" :open="tip.open.value" />
      <CanvasTracePanel
        :lock="lock"
        :locked-lecture="lockedLecture"
        :pre-lectures="preLectures"
        :post-lectures="postLectures"
        :pair-items="pairItems"
        :labels="traceLabels"
        @exit="clearLock"
        @open="openUrl"
        @trace="lockOnNode"
        @hover-item="onPanelHover"
      />
    </template>
  </MapStage>
</template>

<style scoped>
.cv-stage {
  user-select: none;
  -webkit-user-select: none;
}
.cv-stage--reader {
  background-image: radial-gradient(color-mix(in srgb, var(--lec-border) 55%, transparent) 1px, transparent 1px);
  background-size: 20px 20px;
}
.cv-stage--datasheet {
  background-image: none;
}
.cv-search {
  width: 190px;
  height: 30px;
  padding: 0 10px;
  color: var(--lec-text);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1, 4px);
  font-size: 13px;
  user-select: text;
  -webkit-user-select: text;
}
.cv-search:focus-visible {
  outline: 2px solid var(--lec-accent);
  outline-offset: 1px;
}
.cv-legend {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  height: 30px;
  background: color-mix(in srgb, var(--lec-bg) 90%, transparent);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1, 4px);
  font-size: 12px;
  color: var(--lec-text-muted);
}
.cv-legend .lg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.lg-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--lec-status-radius, 50%);
  border: 1.5px solid var(--lec-border);
  background: var(--lec-bg);
}
.lg-dot.reading {
  border-color: var(--lec-accent);
  background: linear-gradient(to top, var(--lec-accent) 50%, transparent 50%);
}
.lg-dot.read {
  background: var(--lec-done);
  border-color: var(--lec-done);
}
.lg-line {
  width: 14px;
  height: 0;
  border-top: 2px solid var(--lec-accent);
}
.lg-line.post {
  border-top-color: var(--lec-done);
  border-top-style: dashed;
}
.cv-layout-sw {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.cv-layout-sw button {
  height: 30px;
  padding: 0 10px;
  font-size: 12.5px;
  color: var(--lec-text);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1, 4px);
  cursor: pointer;
}
.cv-layout-sw button:hover {
  color: var(--lec-accent);
  border-color: var(--lec-accent);
}
.cv-layout-sw button[aria-pressed='true'] {
  color: var(--lec-bg);
  background: var(--lec-text);
  border-color: var(--lec-text);
}
.cv-edgeinfo {
  font-size: 12px;
  color: var(--lec-text-muted);
  padding: 2px 6px;
  background: color-mix(in srgb, var(--lec-bg) 85%, transparent);
  border-radius: var(--lec-radius-1, 4px);
}
.cv-zoomlabel {
  position: absolute;
  z-index: 2;
  left: 12px;
  bottom: 12px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--lec-text-muted);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1, 4px);
  pointer-events: none;
}
.cv-big {
  font-family: var(--lec-font-heading);
  font-weight: 800;
  fill: var(--lec-text);
  opacity: 0.72;
  paint-order: stroke;
  stroke: var(--lec-bg);
  stroke-width: 6px;
  pointer-events: none;
}
.cv-layer.lod-far :deep(.ie) {
  opacity: 0.16;
}
.cv-layer.lod-far :deep(.cv-node:not(.on)) {
  opacity: 0.22;
}
.cv-m-ie {
  fill: var(--lec-text-muted);
  fill-opacity: 0.7;
}
.cv-m-b {
  fill: var(--lec-cat-4);
  fill-opacity: 0.75;
}
.cv-m-pre {
  fill: var(--lec-accent);
}
.cv-m-post {
  fill: var(--lec-done);
}
@media (max-width: 700px) {
  .cv-legend,
  .cv-edgeinfo {
    display: none;
  }
}
</style>
