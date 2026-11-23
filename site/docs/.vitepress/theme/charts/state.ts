/**
 * charts/state.ts — cross-module chart state that must outlive a single render call.
 *
 * Rule (review FE-026): no module-level *strong* collection keyed by DOM nodes. Everything that
 * hangs off a figure / body lives in a WeakMap, so a figure that leaves the DOM is collectable
 * even if nobody called dispose.
 */

export type Disposer = () => void

/** Minimal surface of an ECharts instance that the runtime touches. */
export interface EChartsInstanceLike {
  setOption(option: unknown, notMerge?: boolean): void
  resize(opts?: { width?: number; height?: number }): void
  dispose(): void
  dispatchAction(action: unknown): void
  isDisposed?(): boolean
}

/** Per-figure extras the full-screen modal and the print bus need. */
export interface FigExtra {
  chart?: EChartsInstanceLike
  resize?: () => void
}

/** figure → ECharts instance + resize (set by the echarts renderer, removed by its disposer). */
export const figExtras = new WeakMap<HTMLElement, FigExtra>()

/** figure → "re-fit inline SVG" (mermaid / wavedrom), V1 kept this on `fig.__fit_svg__`. */
export const svgFitters = new WeakMap<HTMLElement, () => void>()

/**
 * Shared sequence (V1 `zoomSeq`): inline figure ids (`inline_<n>`, pre-increment), mermaid render
 * ids (`m<n>_…`, post-increment) and wavedrom prefixes (`wd_<n>_`, post-increment) all draw from
 * the same counter, exactly as V1 did, so first-load ids / anchors stay byte-identical.
 */
let seq = 0
/** `seq++` (returns the value before incrementing). */
export function nextSeq(): number {
  return seq++
}
/** `++seq` (returns the value after incrementing). */
export function bumpSeq(): number {
  return ++seq
}

declare global {
  interface Window {
    /** true once the current page generation's charts have settled (export / audits poll this). */
    __CHARTS_DONE__?: boolean
    /** Export / print bus: resize every chart to `targetWidth` (or back to the container width). */
    __RESIZE_ALL_CHARTS__?: (targetWidth?: number) => void
    /** wavedrom's renderWaveForm reads the skin from here. */
    WaveSkin?: unknown
  }
}
