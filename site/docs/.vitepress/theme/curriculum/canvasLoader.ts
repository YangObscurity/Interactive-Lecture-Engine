/**
 * curriculum/canvasLoader.ts - lazy client loader of the pre-computed dependency canvas bundle (P4b).
 *
 * Uses dynamic `import('./canvas.data.mts')` so the canvas coordinates live in their own async chunk (never bloated into
 * lecture pages or initial atlas renders). Merges readable restricted-tier `/_access/<tier>/canvas.json` slices when
 * P3b tiers are configured; makes zero requests when no restricted tier is readable.
 */
import type { CanvasBundle, CanvasTierSlice } from '../../curriculum/canvasTypes'
import { emptyCanvasBundle, isCanvasBundle, isCanvasTierSlice } from '../../curriculum/canvasTypes'
import { fetchTierJson, tierUrl } from '../access/resolve'
import type { AccessDeps, AccessResult } from '../access/resolve'
import { accessDeps, getAccess } from '../access/store'
import { composeCanvas } from './canvasCompose'

export interface CanvasLoadDeps {
  inline: () => Promise<CanvasBundle>
  access: () => Promise<AccessResult>
  http: () => AccessDeps | null
}

async function loadInlineCanvas(deps: Pick<CanvasLoadDeps, 'inline'>): Promise<CanvasBundle> {
  try {
    const b = await deps.inline()
    return isCanvasBundle(b) ? b : emptyCanvasBundle()
  } catch {
    return emptyCanvasBundle()
  }
}

async function loadCanvasSlices(deps: Pick<CanvasLoadDeps, 'access' | 'http'>): Promise<CanvasTierSlice[]> {
  const access = await deps.access()
  if (access.tiers.length === 0) return []
  const http = deps.http()
  if (!http) return []
  const parts = await Promise.all(
    access.tiers.map(async (t) => {
      const json = await fetchTierJson(http, tierUrl(http, t.id, 'canvas.json'))
      return isCanvasTierSlice(json) && json.tier === t.id ? json : null
    }),
  )
  return parts.filter((s): s is CanvasTierSlice => s !== null)
}

export async function loadCanvasWith(
  deps: CanvasLoadDeps,
  mergedEdges: ReadonlyArray<readonly [string, string]>,
): Promise<CanvasBundle> {
  const [inline, slices] = await Promise.all([loadInlineCanvas(deps), loadCanvasSlices(deps)])
  return composeCanvas(inline, slices, mergedEdges)
}

const realDeps: CanvasLoadDeps = {
  inline: () => import('./canvas.data.mts').then((m) => m.data),
  access: () => getAccess(),
  http: () => accessDeps(),
}

let cached: { access: AccessResult; edgesLen: number; promise: Promise<CanvasBundle> } | null = null

export async function loadCanvas(mergedEdges: ReadonlyArray<readonly [string, string]>): Promise<CanvasBundle> {
  const access = await getAccess()
  if (cached && cached.access === access && cached.edgesLen === mergedEdges.length) return cached.promise
  const promise = loadCanvasWith({ ...realDeps, access: () => Promise.resolve(access) }, mergedEdges)
  cached = { access, edgesLen: mergedEdges.length, promise }
  return promise
}
