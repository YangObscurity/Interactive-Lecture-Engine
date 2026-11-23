/**
 * core/lifecycle.ts — runs PageFeatures once per page visit and AppFeatures once per app.
 *
 * Contract (see core/types.ts):
 *   - `enter(path)` leaves the current visit (if any) and mounts every feature whose `when`
 *     accepts the path. Each visit owns one AbortController; `ctx.signal` aborts on leave.
 *   - Disposers registered with `ctx.defer` run LIFO on leave, each in its own try/catch.
 *   - Features run via Promise.allSettled: a throwing / rejecting feature is logged, never
 *     propagated, and never stops the others.
 *   - Generation counter: a late async mount from an old visit cannot touch the new visit —
 *     its `ctx.defer` runs the disposer immediately, and its timings are not recorded.
 *
 * Wiring (theme/index.ts): first load `onMounted(() => lc.enter(route.path))` (after hydration),
 * SPA navigation `watch(() => route.path, lc.enter, { flush: 'post' })` (after DOM patch).
 */
import type { AppFeature, PageContext, PageFeature } from './types'
import { normalisePath } from './route'

/**
 * Window event dispatched by the charts feature when every chart of the page has rendered
 * (or failed). `detail.path` is the normalised page path. Always dispatched asynchronously.
 */
export const CHARTS_SETTLED_EVENT = 'lecture:charts-settled'

export interface ChartsSettledDetail {
  path: string
}

export interface FeatureTiming {
  id: string
  status: 'mounted' | 'failed' | 'skipped' | 'stale'
  ms: number
  error?: string
}

export interface LifecycleState {
  path: string | null
  generation: number
  /** Number of `enter` calls so far (= generation). */
  visits: number
  /** Feature ids mounted successfully for the current visit. */
  mounted: string[]
  /** Disposers waiting for the current visit to end. */
  pendingDisposers: number
  appFeatures: string[]
  timings: FeatureTiming[]
}

export interface Lifecycle {
  enter(path: string): Promise<void>
  leave(): void
  state(): LifecycleState
  /** Leave the current visit and uninstall app features (HMR / tests). */
  destroy(): void
}

export interface LifecycleOptions {
  /** Path normaliser (default `normalisePath`). */
  normalise?: (path: string) => string
  /** Error sink (default `console.error`). */
  onError?: (featureId: string, error: unknown) => void
  now?: () => number
}

interface Visit {
  generation: number
  path: string
  controller: AbortController
  disposers: Array<() => void>
  mounted: string[]
  timings: FeatureTiming[]
  ended: boolean
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createLifecycle(
  features: readonly PageFeature[],
  appFeatures: readonly AppFeature[] = [],
  options: LifecycleOptions = {}
): Lifecycle {
  const normalise = options.normalise ?? ((p: string) => normalisePath(p))
  const onError =
    options.onError ??
    ((id: string, err: unknown) => {
      console.error(`[lifecycle] feature "${id}" failed:`, err)
    })
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))

  let generation = 0
  let current: Visit | null = null
  let appController: AbortController | null = null
  const installedApp: string[] = []

  function runDisposer(id: string, fn: () => void) {
    try {
      fn()
    } catch (err) {
      onError(id, err)
    }
  }

  function endVisit(visit: Visit) {
    if (visit.ended) return
    visit.ended = true
    visit.controller.abort()
    while (visit.disposers.length) {
      const fn = visit.disposers.pop() as () => void
      runDisposer('dispose', fn)
    }
  }

  function installApp() {
    if (appController) return
    appController = new AbortController()
    for (const f of appFeatures) {
      try {
        f.install(appController.signal)
        installedApp.push(f.id)
      } catch (err) {
        onError(f.id, err)
      }
    }
  }

  function leave() {
    if (current) endVisit(current)
    current = null
  }

  async function enter(rawPath: string): Promise<void> {
    installApp()
    leave()
    const visit: Visit = {
      generation: ++generation,
      path: normalise(rawPath),
      controller: new AbortController(),
      disposers: [],
      mounted: [],
      timings: [],
      ended: false,
    }
    current = visit

    const ctx: PageContext = {
      path: visit.path,
      signal: visit.controller.signal,
      defer(dispose) {
        // A late registration from a visit that already ended: release right away.
        if (visit.ended) runDisposer('dispose', dispose)
        else visit.disposers.push(dispose)
      },
    }

    const runs = features.map(async (f) => {
      const t0 = now()
      let accepted: boolean
      try {
        accepted = f.when ? f.when(visit.path) : true
      } catch (err) {
        onError(f.id, err)
        accepted = false
      }
      if (!accepted) {
        visit.timings.push({ id: f.id, status: 'skipped', ms: 0 })
        return
      }
      try {
        await f.mount(ctx)
        if (visit.ended) {
          visit.timings.push({ id: f.id, status: 'stale', ms: now() - t0 })
          return
        }
        visit.mounted.push(f.id)
        visit.timings.push({ id: f.id, status: 'mounted', ms: now() - t0 })
      } catch (err) {
        if (!visit.ended) onError(f.id, err)
        visit.timings.push({ id: f.id, status: 'failed', ms: now() - t0, error: errText(err) })
      }
    })
    await Promise.allSettled(runs)
  }

  function state(): LifecycleState {
    return {
      path: current?.path ?? null,
      generation,
      visits: generation,
      mounted: current ? [...current.mounted] : [],
      pendingDisposers: current ? current.disposers.length : 0,
      appFeatures: [...installedApp],
      timings: current ? current.timings.map((t) => ({ ...t, ms: Math.round(t.ms * 10) / 10 })) : [],
    }
  }

  function destroy() {
    leave()
    appController?.abort()
    appController = null
    installedApp.length = 0
  }

  return { enter, leave, state, destroy }
}
