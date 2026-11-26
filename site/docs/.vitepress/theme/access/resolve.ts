/**
 * access/resolve.ts - the client side of the access tiers (docs-dev/ACCESS.md).
 *
 * The build puts everything of a restricted tier under `/_access/<tier>/`; an authenticating gateway in front of the
 * site answers 200 for the tiers the reader may see and 401 / 403 / a redirect for the others. This module asks, and
 * believes the answer: a tier is readable only when its `site-data.json` came back with 200 and a valid slice. The front
 * end never infers a permission.
 *
 * Pure: everything environmental (`fetch`, `withBase`) is passed in, so it is unit-tested without a browser. Only
 * lightweight helpers of `access/` are imported (`mergeGraph`, `isTierSlice`, `tierBasePath`); never the config
 * validation of `access/tiers.ts` (nothing here may pull `config/schema.ts` into the page bundle).
 */
import { isTierSlice, mergeGraph } from '../../access/siteData'
import type { GraphNodeLike, TierSlice } from '../../access/siteData'
import { tierBasePath } from '../../access/tiers'
import type { LectureAccess } from '../../access/tiers'

export interface AccessDeps {
  /** The global `fetch` (or a stub). */
  fetch: typeof fetch
  /** vitepress `withBase`. */
  withBase: (path: string) => string
}

export interface ReadableTier {
  id: string
  slice: TierSlice
}

export interface AccessResult {
  /** The tiers the gateway let through, in the order of `lectureAccess.tiers`. */
  tiers: ReadableTier[]
  /** Tiers whose `site-data.json` check encountered a transient network/5xx fault (not normal 401/403 denial). */
  failedTiers?: string[]
}

export const EMPTY_ACCESS: AccessResult = { tiers: [] }

/** The URL of a file of a tier (`/_access/<tier>/<file>`), base included. */
export function tierUrl(deps: Pick<AccessDeps, 'withBase'>, tier: string, file: string): string {
  return deps.withBase(`${tierBasePath(tier)}/${file}`)
}

async function fetchTierJsonWithStatus(
  deps: Pick<AccessDeps, 'fetch'>,
  url: string,
): Promise<{ json: unknown | undefined; transientError: boolean }> {
  try {
    const res = await deps.fetch(url, { redirect: 'manual', credentials: 'same-origin', cache: 'no-store' })
    if (res.status >= 500) return { json: undefined, transientError: true }
    if (res.status !== 200) return { json: undefined, transientError: false }
    return { json: (await res.json()) as unknown, transientError: false }
  } catch (err) {
    // Only treat network/fetch rejections as transient errors (syntax/HTML parse failure is an auth redirect body).
    const isSyntax = err instanceof SyntaxError
    return { json: undefined, transientError: !isSyntax }
  }
}

/**
 * GET a file of a tier. The answer counts only on a 200 whose body is JSON: a redirect (`redirect: 'manual'` gives an
 * opaque redirect with status 0), 401 / 403, any other status, a network error and a body that is not JSON all give
 * `undefined`.
 */
export async function fetchTierJson(deps: Pick<AccessDeps, 'fetch'>, url: string): Promise<unknown | undefined> {
  return (await fetchTierJsonWithStatus(deps, url)).json
}

/** Ask the gateway which restricted tiers the reader may read. No restricted tier configured: no request at all. */
export async function resolveAccess(lectureAccess: LectureAccess | undefined, deps: AccessDeps): Promise<AccessResult> {
  const ids = lectureAccess?.tiers ?? []
  if (ids.length === 0) return EMPTY_ACCESS
  const slices = await Promise.all(
    ids.map(async (id) => ({ id, ...(await fetchTierJsonWithStatus(deps, tierUrl(deps, id, 'site-data.json'))) })),
  )
  const tiers: ReadableTier[] = []
  const failedTiers: string[] = []
  for (const { id, json, transientError } of slices) {
    if (isTierSlice(json) && json.tier === id) tiers.push({ id, slice: json })
    else if (transientError) failedTiers.push(id)
  }
  return failedTiers.length > 0 ? { tiers, failedTiers } : { tiers }
}

/** The nodes of the `graph.json` of each readable tier (a tier whose file does not arrive or is not an array adds nothing). */
export async function loadTierGraphs(access: AccessResult, deps: AccessDeps): Promise<GraphNodeLike[][]> {
  const parts = await Promise.all(
    access.tiers.map(async (t) => {
      const json = await fetchTierJson(deps, tierUrl(deps, t.id, 'graph.json'))
      return Array.isArray(json) ? (json as GraphNodeLike[]) : []
    }),
  )
  return parts
}

export interface GraphOptions {
  /** How the readable tiers' graphs are loaded (the store passes a loader that shares one fetch per resolution). Default: `loadTierGraphs`. */
  tierGraphs?: (access: AccessResult) => Promise<GraphNodeLike[][]>
  /** Fetch the inline graph the way the maps do: `?v=<now>` and `cache: 'no-store'`. Default: a plain GET. */
  fresh?: boolean
  /** Test seam for `Date.now()`. */
  now?: () => number
}

/**
 * The inline graph (`/notion_knowledge_graph.json`) plus the `graph.json` of every readable tier, merged with
 * `mergeGraph`. `null` when the inline file does not arrive (not 200, network error, not JSON), as the consumers
 * treated their own failed fetch. A body that is not an array is returned as it is (the consumer decides what it means).
 */
export async function loadMergedGraph(access: Promise<AccessResult> | AccessResult, deps: AccessDeps, opts: GraphOptions = {}): Promise<unknown | null> {
  const inlineUrl = deps.withBase('/notion_knowledge_graph.json')
  const inlineReq = opts.fresh
    ? deps.fetch(`${inlineUrl}?v=${(opts.now ?? Date.now)()}`, { cache: 'no-store' })
    : deps.fetch(inlineUrl)
  let inline: unknown
  try {
    const res = await inlineReq
    if (!res.ok) return null
    inline = (await res.json()) as unknown
  } catch {
    return null
  }
  if (!Array.isArray(inline)) return inline
  const readable = await access
  if (readable.tiers.length === 0) return inline
  return mergeGraph(inline as GraphNodeLike[], await (opts.tierGraphs ?? ((a) => loadTierGraphs(a, deps)))(readable))
}
