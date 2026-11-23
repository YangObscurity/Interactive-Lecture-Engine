/**
 * map/useLabelLayer.ts - the canvas label layer (labels.ts) as a composable (P4a WP-H1).
 *
 * Call it after `useMapViewport` in the same component. On mount it creates the layer over the stage, draws on every
 * placement of the viewport and resizes with the window. The svg text is collected again whenever `source` changes
 * (after the DOM update); call `collect()` yourself after a re-render that `source` does not cover.
 */
import { onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import type { Ref, ShallowRef, WatchSource } from 'vue'
import { LabelLayer } from './labels'
import type { LabelLayerOptions } from './labels'
import type { MapViewport } from './viewport'

export interface UseLabelLayerOptions {
  stage: Readonly<Ref<HTMLElement | null>>
  svg: Readonly<Ref<SVGSVGElement | null>>
  /** The canvas element rendered by the component (see `LabelLayerOptions.canvas`). */
  canvas?: Readonly<Ref<HTMLCanvasElement | null>>
  viewport: Readonly<ShallowRef<MapViewport | null>>
  /** Collect the svg texts again after this changes (and the DOM has updated). */
  source?: WatchSource
  /** Passed through to the layer (visibility rule, label kinds, test seams). */
  layer?: Omit<LabelLayerOptions, 'stage' | 'svg' | 'canvas'>
}

export interface UseLabelLayer {
  /** The layer (null on the server and before mount). */
  layer: Readonly<ShallowRef<LabelLayer | null>>
  /** Collect the svg texts again and redraw. */
  collect(): void
}

export function useLabelLayer(options: UseLabelLayerOptions): UseLabelLayer {
  const layer = shallowRef<LabelLayer | null>(null)
  const stops: Array<() => void> = []

  const collect = (): void => {
    const l = layer.value
    if (!l) return
    l.collect()
    const vp = options.viewport.value
    if (vp) l.draw({ transform: vp.view, ladder: false })
  }

  onMounted(() => {
    const stage = options.stage.value
    const svg = options.svg.value
    if (!stage || !svg) return
    const l = new LabelLayer({ ...options.layer, stage, svg, ...(options.canvas?.value ? { canvas: options.canvas.value } : {}) })
    layer.value = l
    const vp = options.viewport.value
    if (vp) {
      stops.push(
        vp.on('place', (view) => l.draw(view)),
        vp.on('resize', () => l.resize()),
      )
    }
    collect()
    if (options.source) stops.push(watch(options.source, collect, { flush: 'post' }))
  })

  onBeforeUnmount(() => {
    for (const s of stops.splice(0)) s()
    layer.value?.destroy()
    layer.value = null
  })

  return { layer, collect }
}
