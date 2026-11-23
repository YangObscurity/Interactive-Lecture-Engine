<script setup lang="ts">
/**
 * MapStage.vue - the stage of a map: the pan / zoom viewport, the canvas label layer, the zoom buttons and the
 * "how to use" hint, around the svg a map draws (P4a WP-H1; API in docs-dev/MAP.md).
 *
 * The default slot is the content of the svg (in canvas units, `width` x `height`); `defs` is for `<defs>`; `hud` is the
 * top-left row (search, legend), `overlay` is for anything else on the stage (the info panel, a side panel). Elements
 * of the HUD and the overlays carry the class `lec-map-hud` / `lec-map-panel`, so a press or wheel on them is not the
 * map's. Every `<text>` of the svg is painted by the label layer: give each one a hit shape with the class `lec-map-hit`.
 *
 * SSR: the server renders the stage and the svg; the viewport and the label layer start on mount.
 * Style: only `--lec-*` tokens.
 */
import { ref, watch } from 'vue'
import type { Insets, Transform } from './geometry'
import type { LabelLayerOptions } from './labels'
import MapControls from './MapControls.vue'
import { BUTTON_ZOOM } from './geometry'
import { useLabelLayer } from './useLabelLayer'
import { useMapViewport } from './useMapViewport'
import { useT } from '../../i18n/useT.ts'

const props = withDefaults(
  defineProps<{
    /** Content size in canvas units. */
    width: number
    height: number
    /** `aria-label` of the stage (see `mapAriaLabel`). */
    ariaLabel: string
    /** `aria-label` of the svg. */
    svgLabel?: string
    /** Selector of the HUD and panels. */
    ignore?: string
    /** Esc: return true when something else took the key (see `MapViewportOptions.onEscape`). */
    onEscape?: () => boolean
    /** Collect the svg texts again whenever this changes. */
    labelsKey?: unknown
    /** Label layer options (visibility rule, kinds). */
    labelOptions?: Omit<LabelLayerOptions, 'stage' | 'svg' | 'canvas'>
    /** Hide the built-in zoom buttons and hint (the page supplies its own). */
    bare?: boolean
    /** Custom HUD insets (screen pixels) passed to `MapViewport`. */
    insets?: (panelOpen: boolean) => Insets
  }>(),
  { svgLabel: '', ignore: '.lec-map-hud, .lec-map-panel', onEscape: undefined, labelsKey: undefined, labelOptions: undefined, bare: false, insets: undefined },
)

const emit = defineEmits<{ (e: 'commit', t: Transform): void; (e: 'fit'): void; (e: 'ready'): void }>()

const { t } = useT()
const stageEl = ref<HTMLElement | null>(null)
const svgEl = ref<SVGSVGElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

const vp = useMapViewport({
  stage: stageEl,
  svg: svgEl,
  content: () => ({ width: props.width, height: props.height }),
  ignore: props.ignore,
  onEscape: () => props.onEscape?.() === true,
  ...(props.insets ? { insets: props.insets } : {}),
})
const labels = useLabelLayer({
  stage: stageEl,
  svg: svgEl,
  canvas: canvasEl,
  viewport: vp.viewport,
  source: () => props.labelsKey,
  // `ready`: the label layer has painted every visible label with its real font (or given up waiting for it, labels.ts)
  layer: {
    ...props.labelOptions,
    onReady: () => {
      props.labelOptions?.onReady?.()
      emit('ready')
    },
  },
})

defineExpose({
  /** The viewport commands (`fit`, `zoomBy`, `panTo`, `zoomToBox`, `setView`, ...) and state refs. */
  viewport: vp,
  /** The label layer; `collectLabels()` after a re-render that `labelsKey` does not cover. */
  labels,
  collectLabels: labels.collect,
  deferLabels: (): void => labels.layer.value?.deferUntilCollect(),
  stage: stageEl,
  svg: svgEl,
})

const { active, touched } = vp
watch(vp.transform, (tr) => emit('commit', tr))
</script>

<template>
  <section ref="stageEl" class="lec-map" tabindex="0" :aria-label="ariaLabel">
    <div v-if="$slots.hud" class="lec-map-hud lec-map-hud-tl"><slot name="hud" /></div>
    <svg ref="svgEl" class="lec-map-svg" role="img" :aria-label="svgLabel || undefined">
      <defs><slot name="defs" /></defs>
      <g><slot /></g>
    </svg>
    <canvas ref="canvasEl" class="lec-map-labels" />
    <MapControls v-if="!bare" @zoom-in="vp.zoomBy(BUTTON_ZOOM)" @zoom-out="vp.zoomBy(1 / BUTTON_ZOOM)" @fit="() => { emit('fit'); vp.fit() }" />
    <div v-if="!bare" class="lec-map-hint" :class="{ 'lec-map-hint-off': active || touched }" aria-hidden="true">{{ t('map.hint.activate') }}</div>
    <slot name="overlay" />
  </section>
</template>

<style>
.lec-map {
  position: relative;
  height: min(78vh, 760px);
  min-height: 420px;
  overflow: hidden;
  background: var(--lec-bg);
  border-top: 1px solid var(--lec-border);
  border-bottom: 1px solid var(--lec-border);
  touch-action: none;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}
.lec-map.lec-map--dragging { cursor: grabbing; }
.lec-map.lec-map--active { box-shadow: inset 0 0 0 2px var(--lec-accent); }
.lec-map:focus-visible { outline: 2px solid var(--lec-accent); outline-offset: -2px; }

/* the view is a CSS transform on the svg itself: no SVG relayout */
.lec-map-svg { position: absolute; left: 0; top: 0; display: block; transform-origin: 0 0; overflow: visible; }
/* every label is painted by the canvas layer; the svg text stays in the DOM for classes, rules and data */
.lec-map-svg text { display: none !important; }
.lec-map-labels { position: absolute; left: 0; top: 0; z-index: 1; pointer-events: none; }
/* the clickable area of a label (the text itself is not rendered) */
.lec-map-hit { fill: transparent; stroke: none; }

.lec-map-hud { position: absolute; z-index: 2; display: flex; align-items: center; gap: 6px; }
.lec-map-hud-tl { top: 12px; left: 12px; flex-wrap: wrap; max-width: calc(100% - 24px); }
.lec-map-hint {
  position: absolute;
  z-index: 3;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  max-width: calc(100% - 200px);
  padding: 8px 14px;
  font-size: 13px;
  color: var(--lec-text-muted);
  background: var(--lec-bg);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-2, 6px);
  pointer-events: none;
}
.lec-map-hint-off { visibility: hidden; }
@media (prefers-reduced-motion: reduce) {
  .lec-map * { transition: none !important; }
}
</style>
