import type { Disposer } from '../state'

export interface RenderEnv {
  /** Aborted when the page (or this render pass) is left. Renderers check it after every await. */
  readonly signal: AbortSignal
}

/**
 * A renderer draws `code` into `fig .chart-body` and returns the disposer for everything it created
 * (instances, observers). It returns null when it was aborted before creating anything, and throws
 * on a render error (the caller shows the error and sets `data-chart-status="error"`).
 */
export type Renderer = (fig: HTMLElement, code: string, env: RenderEnv) => Promise<Disposer | null>
