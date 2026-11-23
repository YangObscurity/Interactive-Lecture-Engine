<script setup lang="ts">
/**
 * `<LectureFigure>` — group-managed figure & table renderer (WP-F8).
 * Receives pre-resolved, per-page serialized props compiled at build time from `figures.json`.
 * Delegates frame & caption chrome to `<LecSlot name="FigureFrame">`, keeping both skins distinct.
 */
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import type { ResolvedFigureMountProps } from '../../figures/types.ts'
import { endBodyHydration } from '../core/bodyHydration'
import { openUnifiedViewer, preloadViewer } from '../charts/modal'
import { LecSlot } from '../slots'

const props = defineProps<{
  encoded: string
}>()

const { t } = useT()
// the first mounted instance releases the body-hydration gate (index.ts); later calls are no-ops
onMounted(() => {
  endBodyHydration()
  preloadViewer()
})
const rootEl = ref<HTMLElement | null>(null)

const decoded = computed<ResolvedFigureMountProps | null>(() => {
  if (!props.encoded) return null
  try {
    return JSON.parse(decodeURIComponent(props.encoded)) as ResolvedFigureMountProps
  } catch {
    return null
  }
})

const items = computed(() => decoded.value?.items ?? [])
const isGallery = computed(() => items.value.length > 1)
const primary = computed(() => items.value[0] ?? null)

const figureLabel = computed(() => {
  const first = primary.value
  if (!first) return ''
  if (!isGallery.value) {
    return first.kind === 'table'
      ? t('lecture.table.captionLabel', { i: first.num })
      : t('lecture.fig.captionLabel', { i: first.num })
  }
  const last = items.value[items.value.length - 1]!
  const range = first.num === last.num ? String(first.num) : `${first.num}–${last.num}`
  return first.kind === 'table'
    ? t('lecture.table.captionLabel', { i: range })
    : t('lecture.fig.captionLabel', { i: range })
})

const captionText = computed(() => {
  if (!items.value.length) return ''
  if (!isGallery.value) return primary.value?.caption ?? ''
  return items.value.map((it) => `${it.label}: ${it.caption}`).join(' · ')
})

const sourceText = computed(() => {
  if (!items.value.length) return ''
  if (!isGallery.value) return primary.value?.sourceText ?? ''
  const unique = Array.from(new Set(items.value.map((it) => it.sourceText).filter(Boolean)))
  return unique.join(' / ')
})

const mergedBacklinks = computed(() => {
  if (!items.value.length) return []
  const seen = new Set<string>()
  const out: { anchorId: string; label: string }[] = []
  for (const it of items.value) {
    for (const bl of it.backlinks) {
      if (seen.has(bl.anchorId)) continue
      seen.add(bl.anchorId)
      out.push(bl)
    }
  }
  return out
})

const expandButtons = computed(() => [
  {
    act: 'expand',
    title: t('chart.tool.expand'),
    label: t('chart.tool.expand'),
  },
])

function isSvgFile(src: string): boolean {
  return src.toLowerCase().split(/[?#]/, 1)[0]!.endsWith('.svg')
}

function slidePayload(item: (typeof items.value)[number]) {
  return JSON.stringify({
    kind: 'figure' as const,
    id: item.id,
    title: `${item.label} · ${item.caption}`,
    src: withBase(item.src),
    width: item.width,
    height: item.height,
    caption: item.caption,
    sourceText: item.sourceText,
    originalUrl: item.originalSrc ? withBase(item.originalSrc) : undefined,
  })
}

function openViewerAt(itemIndex: number, ev: Event): void {
  const targetEl = (ev.currentTarget as HTMLElement | null) ?? rootEl.value
  const item = items.value[itemIndex]
  if (!item) return
  openUnifiedViewer(
    {
      kind: 'figure',
      id: item.id,
      title: `${item.label} · ${item.caption}`,
      src: withBase(item.src),
      width: item.width,
      height: item.height,
      caption: item.caption,
      sourceText: item.sourceText,
      originalUrl: item.originalSrc ? withBase(item.originalSrc) : undefined,
      originEl: targetEl,
    },
    targetEl,
  )
}

function onFigureClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null
  if (!target) return
  const expandBtn = target.closest('.chart-enlarge')
  if (expandBtn) {
    ev.preventDefault()
    openViewerAt(0, ev)
  }
}
</script>

<template>
  <figure
    v-if="decoded && items.length"
    :id="items.length === 1 ? `fig-${items[0]!.id}` : undefined"
    ref="rootEl"
    class="lec-fig"
    :class="[
      `lec-fig--size-${decoded.size}`,
      `lec-fig--float-${decoded.float}`,
      { 'lec-fig--gallery': isGallery },
    ]"
    :data-group="decoded.group"
    :data-size="decoded.size"
    :data-float="decoded.float"
    @click="onFigureClick"
  >
    <div class="lec-fig-grid" :style="{ '--fig-cols': String(Math.min(items.length, 3)) } as Record<string, string>">
      <div
        v-for="(item, idx) in items"
        :key="item.id"
        :id="items.length > 1 ? `fig-${item.id}` : undefined"
        class="lec-fig-item"
        :data-fig-id="item.id"
        :data-lec-fig-slide="slidePayload(item)"
      >
        <div
          class="lec-fig-media"
          role="button"
          tabindex="0"
          :aria-label="`${item.label}: ${t('chart.tool.expand')}`"
          :data-format="isSvgFile(item.src) ? 'svg' : 'raster'"
          :style="{ aspectRatio: `${item.width} / ${item.height}` }"
          @click="openViewerAt(idx, $event)"
          @keydown.enter.prevent="openViewerAt(idx, $event)"
          @keydown.space.prevent="openViewerAt(idx, $event)"
        >
          <img
            :src="withBase(item.src)"
            :width="item.width"
            :height="item.height"
            :alt="item.caption"
            loading="lazy"
            decoding="async"
          />
        </div>
      </div>
    </div>
    <LecSlot
      name="FigureFrame"
      type="figure"
      tag-label=""
      :figure-label="figureLabel"
      :title="''"
      :caption="captionText"
      :source="sourceText"
      :backlinks="mergedBacklinks"
      :buttons="expandButtons"
    />
  </figure>
</template>
