/**
 * map/useMapViewport.ts - the map viewport (viewport.ts) as a composable (P4a WP-H1).
 *
 * Create it in the component that owns the stage: it builds the `MapViewport` on mount (never on the server), tears
 * it down before unmount, and exposes the state as refs and the commands as plain functions (no-ops before mount).
 */
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'
import type { Box, Size, Transform } from './geometry'
import { MapViewport } from './viewport'
import type { MapViewportOptions } from './viewport'

export interface UseMapViewportOptions extends Omit<MapViewportOptions, 'stage' | 'svg' | 'content'> {
  stage: Readonly<Ref<HTMLElement | null>>
  svg: Readonly<Ref<SVGSVGElement | null>>
  /** Size of the content in canvas units; a getter, so it may follow reactive state. */
  content: () => Size
  /** Fit the whole content right after mount (default true). */
  fitOnMount?: boolean
}

export interface UseMapViewport {
  /** The viewport object (null on the server and before mount): the label layer subscribes to it. */
  viewport: Readonly<ShallowRef<MapViewport | null>>
  /** The settled view; updated when a movement ends (not on every frame). */
  transform: Readonly<ShallowRef<Transform>>
  /** The reader has clicked the map: the wheel zooms. */
  active: Readonly<Ref<boolean>>
  /** The reader has dragged, zoomed or jumped at least once. */
  touched: Readonly<Ref<boolean>>
  /** The view is moving right now (a drag, a wheel gesture or an animation). */
  moving: Readonly<Ref<boolean>>
  fit(): void
  zoomBy(factor: number): void
  zoomAt(factor: number, cx: number, cy: number): void
  panBy(dx: number, dy: number): void
  panTo(cx: number, cy: number): void
  zoomToBox(box: Box, options?: { panelOpen?: boolean }): void
  setView(t: Transform): void
}

export function useMapViewport(options: UseMapViewportOptions): UseMapViewport {
  const viewport = shallowRef<MapViewport | null>(null)
  const transform = shallowRef<Transform>({ k: 1, x: 0, y: 0 })
  const active = shallowRef(false)
  const touched = shallowRef(false)
  const moving = shallowRef(false)
  const stops: Array<() => void> = []

  onMounted(() => {
    const stage = options.stage.value
    const svg = options.svg.value
    if (!stage || !svg) return
    const { stage: _stage, svg: _svg, fitOnMount, ...rest } = options
    const vp = new MapViewport({ ...rest, stage, svg })
    const sync = (): void => {
      active.value = vp.active
      touched.value = vp.touched
      moving.value = vp.isMoving
    }
    stops.push(
      vp.on('state', sync),
      vp.on('commit', (t) => {
        transform.value = t
      }),
    )
    viewport.value = vp
    if (fitOnMount !== false && options.content().width > 0) vp.fit()
    sync()
  })

  onBeforeUnmount(() => {
    for (const s of stops.splice(0)) s()
    viewport.value?.destroy()
    viewport.value = null
  })

  return {
    viewport,
    transform,
    active,
    touched,
    moving,
    fit: () => viewport.value?.fit(),
    zoomBy: (f) => viewport.value?.zoomBy(f),
    zoomAt: (f, cx, cy) => viewport.value?.zoomAt(f, cx, cy),
    panBy: (dx, dy) => viewport.value?.panBy(dx, dy),
    panTo: (cx, cy) => viewport.value?.panTo(cx, cy),
    zoomToBox: (box, o) => viewport.value?.zoomToBox(box, o),
    setView: (t) => viewport.value?.setView(t),
  }
}
