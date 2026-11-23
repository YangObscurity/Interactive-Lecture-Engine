/**
 * access/store.ts - the access state of this page load (one per browser tab).
 *
 *   configureAccess({ siteData, withBase })   once, from `enhanceApp` (client and server render; no request is made)
 *   getAccess()                               the readable tiers; the first call starts the requests, later calls share them
 *   startAccess(...)                          from the theme `onMounted`: merge the slices into the site data and seed
 *                                             the progress store, now and whenever the reader's identity changes
 *
 * Merging is only ever done from `startAccess`, after hydration, so server and first client render agree.
 * `resolveAccess` makes no request when `themeConfig.lectureAccess.tiers` is empty (this site's normal builds).
 */
import type { Ref } from 'vue'
import { mergeSiteData } from '../../access/siteData'
import type { GraphNodeLike, SiteLike } from '../../access/siteData'
import type { LectureAccess } from '../../access/tiers'
import { currentSession, getSession, subscribeSession } from '../auth/session'
import type { SessionState } from '../auth/session'
import { EMPTY_ACCESS, loadMergedGraph, loadTierGraphs, resolveAccess } from './resolve'
import type { AccessDeps, AccessResult, GraphOptions } from './resolve'

/** What the store needs of VitePress' `siteData` ref (kept structural so tests need no VitePress). */
export interface SiteDataRef {
  value: unknown
}

export interface AccessConfig {
  siteData: Ref<unknown> | SiteDataRef
  withBase: (path: string) => string
  /** Test seam; default: the global `fetch` at call time. */
  fetch?: typeof fetch
}

/** `themeConfig.lectureAccess` of a site data object. */
export function lectureAccessOf(site: unknown): LectureAccess | undefined {
  const theme = (site as { themeConfig?: { lectureAccess?: unknown } } | null | undefined)?.themeConfig
  const la = theme?.lectureAccess as { inlineTier?: unknown; tiers?: unknown } | undefined
  if (!la || typeof la.inlineTier !== 'string' || !Array.isArray(la.tiers)) return undefined
  return { inlineTier: la.inlineTier, tiers: la.tiers.filter((t): t is string => typeof t === 'string') }
}

/** Who the reader is, for deciding whether to ask the gateway again: only a switch of signed-in user (or sign-in / sign-out) counts. */
export function identityKey(s: SessionState): string {
  return s.status === 'authenticated' ? `user:${s.user.id}` : 'none'
}

type Listener = (result: AccessResult) => void

let cfg: AccessConfig | null = null
let baseSite: unknown = null
let resolved: Promise<AccessResult> | null = null
let result: AccessResult = EMPTY_ACCESS
let version = 0
let tierGraphCache: { access: AccessResult; graphs: Promise<GraphNodeLike[][]> } | null = null
const listeners = new Set<Listener>()

/** The fetch / withBase pair the store was configured with (null before `configureAccess`, or without a global fetch). */
export function accessDeps(): AccessDeps | null {
  if (!cfg) return null
  const f = cfg.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
  return f ? { fetch: f, withBase: cfg.withBase } : null
}

/** Point the store at the site data. Calling again (tests) starts over. */
export function configureAccess(next: AccessConfig): void {
  cfg = next
  baseSite = next.siteData.value
  resolved = null
  result = EMPTY_ACCESS
  version = 0
  tierGraphCache = null
}

/** `themeConfig.lectureAccess` of the configured site data (undefined before `configureAccess`). */
export function currentAccessConfig(): LectureAccess | undefined {
  return lectureAccessOf(baseSite)
}

/** The inline site data as it came from the build (before any slice was merged). */
export function inlineSiteData(): unknown {
  return baseSite
}

/** Forget what was resolved and ask again on the next `getAccess()`. */
export function invalidateAccess(): void {
  resolved = null
}

/** The readable tiers. Never rejects. Without `configureAccess` (server render) or without restricted tiers: nothing, no request. */
export function getAccess(): Promise<AccessResult> {
  if (resolved) return resolved
  const d = accessDeps()
  if (!cfg || !d) return Promise.resolve(EMPTY_ACCESS)
  const p = resolveAccess(lectureAccessOf(baseSite), d).then(
    (r) => {
      if (resolved === p) {
        result = r
        version++
        for (const l of [...listeners]) {
          try {
            l(r)
          } catch {
            // one broken listener must not stop the others
          }
        }
      }
      return r
    },
    () => EMPTY_ACCESS,
  )
  resolved = p
  return p
}

/** The last result `getAccess()` produced, synchronously (nothing before the first one arrives). */
export function currentAccess(): AccessResult {
  return result
}

/** Bumped every time a (re)resolution finishes. */
export function accessVersion(): number {
  return version
}

/** Called after every resolution (including a re-resolution). Returns the unsubscribe function. */
export function subscribeAccess(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The tiers' `graph.json` files, fetched once per resolution however many consumers ask (home total, home map, group map, seed). */
function sharedTierGraphs(access: AccessResult): Promise<GraphNodeLike[][]> {
  const d = accessDeps()
  if (!d) return Promise.resolve([])
  if (tierGraphCache?.access !== access) tierGraphCache = { access, graphs: loadTierGraphs(access, d) }
  return tierGraphCache.graphs
}

/** Inline graph plus the graphs of the readable tiers (see `loadMergedGraph`). `null` when the inline file fails. */
export async function loadGraph(opts: GraphOptions = {}): Promise<unknown | null> {
  const d = accessDeps()
  if (!d) return null
  return loadMergedGraph(getAccess(), d, { ...opts, tierGraphs: sharedTierGraphs })
}

/** The nodes of the readable tiers' `graph.json` files only (for the progress seed). */
export async function loadReadableTierNodes(): Promise<GraphNodeLike[]> {
  return (await sharedTierGraphs(await getAccess())).flat()
}

/** The site data with the slices of `access` merged into the inline data. */
export function mergedSiteData(access: AccessResult): unknown {
  if (access.tiers.length === 0) return baseSite
  return mergeSiteData(baseSite as SiteLike, access.tiers.map((t) => t.slice))
}

export interface StartAccessOptions {
  /** Called with the seed nodes of the readable tiers after each resolution (the theme gives it `progressStore.extendSeed(buildSeed(...))`). */
  onTierNodes?: (nodes: GraphNodeLike[]) => void
}

/**
 * From the theme's `onMounted`: resolve, replace `siteData.value` with the merged data, hand the tiers' graph nodes to the
 * progress store, and do all of it again when the signed-in user changes. Returns the stop function.
 */
export function startAccess(opts: StartAccessOptions = {}): () => void {
  if (!cfg) return () => undefined
  const config = cfg
  if ((lectureAccessOf(baseSite)?.tiers.length ?? 0) === 0) return () => undefined
  let lastIdentity: string = identityKey(currentSession())
  let applied = false
  const apply = (r: AccessResult): void => {
    applied = true
    if (r.tiers.length > 0 || config.siteData.value !== baseSite) config.siteData.value = mergedSiteData(r)
    if (opts.onTierNodes && r.tiers.length > 0) void loadReadableTierNodes().then(opts.onTierNodes)
  }
  const stopListening = subscribeAccess(apply)
  // the answer may already be here (a component asked first): then no listener call is coming for it
  void getAccess().then((r) => {
    if (!applied) apply(r)
  })
  const stopSession = subscribeSession((s) => {
    const key = identityKey(s)
    if (key === lastIdentity) return
    lastIdentity = key
    invalidateAccess()
    void getAccess()
  })
  void getSession()
  return () => {
    stopListening()
    stopSession()
  }
}
