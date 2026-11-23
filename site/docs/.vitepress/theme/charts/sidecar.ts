/**
 * charts/sidecar.ts — lazy loader for per-lecture chart sources (`<chartsDir>/<lecture>.json`).
 *
 * - URL = withBase(`${DATA_FILES.chartsDir}/${lecture}.json`) — V1 hard-coded `/charts/…` and broke
 *   under a non-root `base`.
 * - Successful payloads are cached by lecture id (a string key, not a DOM node); concurrent requests
 *   for the same lecture share one fetch. Failures are NOT cached (V1 semantics: the next visit retries).
 * - No dependency on `vitepress` here so it is unit-testable; the feature entry injects `withBase`.
 */
import { DATA_FILES } from '../../site.config.mts'

export interface ChartDef {
  type: string
  title?: string
  caption?: string
  code?: string
  options?: unknown
  option?: unknown
}
export type SidecarData = Record<string, ChartDef>

/** Return the textual chart definition, handling both `"code"` strings and inline `"options"`/`"option"` objects. */
export function chartSourceOf(def: ChartDef): string {
  if (typeof def.code === 'string') return def.code
  if (def.options !== undefined) return JSON.stringify(def.options, null, 2)
  if (def.option !== undefined) return JSON.stringify(def.option, null, 2)
  return ''
}

export interface SidecarLoaderOptions {
  /** Defaults to `DATA_FILES.chartsDir`. */
  dir?: string
  /** Base-path resolver (vitepress `withBase`). Defaults to identity. */
  withBase?: (path: string) => string
  /** Defaults to the global `fetch` at call time. */
  fetch?: typeof fetch
  /**
   * P3b: prefix of the page being shown (`''` or `/_access/<tier>`, see access/paths.ts `tierAssetPrefix`), put in front of
   * `dir`. Read on every call, because the page changes under a single-page navigation. Default: no prefix.
   */
  prefix?: () => string
}

export interface SidecarLoader {
  load(lecture: string): Promise<SidecarData | null>
  url(lecture: string): string
  has(lecture: string): boolean
  clear(): void
  readonly size: number
}

function isSidecarData(v: unknown): v is SidecarData {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function createSidecarLoader(opts: SidecarLoaderOptions = {}): SidecarLoader {
  const dir = (opts.dir ?? DATA_FILES.chartsDir).replace(/\/+$/, '')
  const resolve = opts.withBase ?? ((p: string) => p)
  const cache = new Map<string, SidecarData>()
  const inflight = new Map<string, Promise<SidecarData | null>>()

  const url = (lecture: string) => resolve(`${opts.prefix?.() ?? ''}${dir}/${lecture}.json`)

  async function fetchOnce(lecture: string): Promise<SidecarData | null> {
    const u = url(lecture)
    const f = opts.fetch ?? (typeof fetch === 'function' ? fetch : null)
    if (!f) {
      console.error('[chart] fetch unavailable:', u)
      return null
    }
    try {
      const res = await f(u, { credentials: 'same-origin' })
      if (!res.ok) {
        console.error('[chart] fetch non-200:', u, res.status)
        return null
      }
      const data: unknown = await res.json()
      if (!isSidecarData(data)) {
        console.error('[chart] sidecar is not an object:', u)
        return null
      }
      cache.set(lecture, data)
      return data
    } catch (e) {
      console.error('[chart] fetch threw:', u, e)
      return null
    }
  }

  return {
    url,
    load(lecture) {
      const hit = cache.get(lecture)
      if (hit) return Promise.resolve(hit)
      const pending = inflight.get(lecture)
      if (pending) return pending
      const p = fetchOnce(lecture).finally(() => inflight.delete(lecture))
      inflight.set(lecture, p)
      return p
    },
    has: (lecture) => cache.has(lecture),
    clear() {
      cache.clear()
      inflight.clear()
    },
    get size() {
      return cache.size
    },
  }
}
