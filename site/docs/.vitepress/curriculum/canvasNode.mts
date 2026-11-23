/**
 * curriculum/canvasNode.mts - Node-only launcher for canvasWorker.mjs (P4b, docs-dev/MAP.md).
 *
 * Every distinct worker input is solved in a fresh child Node process (`execFileSync`) so libavoid WASM heap order
 * is identical across runs and builds. Results for identical inputs within the same process are cached by SHA-256.
 * Never imported by browser bundles.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AccessPlan } from '../access/tiers.ts'
import type { CurriculumData, CurriculumGroup } from './data.ts'
import { isCanvasBundle } from './canvasTypes.ts'
import type { CanvasBundle, CanvasTierSlice, CanvasWorkerGroupInput, CanvasWorkerInput } from './canvasTypes.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CANVAS_WORKER_PATH = path.join(here, 'canvasWorker.mjs')
export const CANVAS_DISK_CACHE_DIR = path.resolve(here, '../cache/canvas')

const cache = new Map<string, CanvasBundle>()

export interface RunCanvasWorkerOptions {
  noCache?: boolean
  cacheDir?: string
  workerPath?: string
}

function stableGroups(groups: readonly CurriculumGroup[]): CanvasWorkerGroupInput[] {
  return groups.map((g) => ({
    id: g.id,
    dir: g.dir,
    catSlot: g.catSlot,
    ...(g.map === false ? { map: false } : {}),
    lectures: g.lectures.map((l) => ({ id: l.id, n: l.n })).sort((a, b) => a.n - b.n || a.id.localeCompare(b.id)),
  }))
}

export function canvasInputFromCurriculum(cur: Pick<CurriculumData, 'groups' | 'edges'>, offMapIds?: readonly string[]): CanvasWorkerInput {
  return {
    groups: stableGroups(cur.groups),
    edges: cur.edges.map((e) => [e[0], e[1]] as const),
    ...(offMapIds ? { offMapIds: [...offMapIds] } : {}),
  }
}

export function canvasCacheKey(json: string, workerPath: string = CANVAS_WORKER_PATH): string {
  const workerHash = createHash('sha256').update(fs.readFileSync(workerPath)).digest('hex')
  return createHash('sha256').update(workerHash).update('\0').update(json).digest('hex')
}

function spawnCanvasWorkerOnce(workerPath: string, json: string): string {
  const res = spawnSync(process.execPath, [workerPath], {
    input: json,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (res.stderr) process.stderr.write(res.stderr)
  if (res.error) throw new Error(`canvasWorker spawn failed: ${res.error.message}${res.stderr ? `\n${res.stderr}` : ''}`)
  if (res.status !== 0) {
    throw new Error(
      `canvasWorker exited with status=${res.status ?? 'null'} signal=${res.signal ?? 'none'}${res.stderr ? `\n${res.stderr}` : ''}`,
    )
  }
  return res.stdout
}

/** Run `canvasWorker.mjs` in a fresh child Node process (or return cached result for the same worker+input SHA-256). */
export function runCanvasWorker(input: CanvasWorkerInput, options: RunCanvasWorkerOptions = {}): CanvasBundle {
  const t0 = performance.now()
  const workerPath = options.workerPath ?? CANVAS_WORKER_PATH
  const cacheDir = options.cacheDir ?? CANVAS_DISK_CACHE_DIR
  const json = JSON.stringify(input)
  const key = canvasCacheKey(json, workerPath)

  if (!options.noCache) {
    const hit = cache.get(key)
    if (hit) {
      const ms = Math.round(performance.now() - t0)
      process.stdout.write(`[canvas] layout ${ms}ms (memory cache hit, groups=${input.groups.length})\n`)
      return hit
    }
    const cacheFile = path.join(cacheDir, `${key}.json`)
    if (fs.existsSync(cacheFile)) {
      try {
        const raw = fs.readFileSync(cacheFile, 'utf8')
        const parsed: unknown = JSON.parse(raw)
        if (isCanvasBundle(parsed)) {
          cache.set(key, parsed)
          const ms = Math.round(performance.now() - t0)
          process.stdout.write(`[canvas] layout ${ms}ms (disk cache hit, groups=${input.groups.length})\n`)
          return parsed
        }
      } catch {
        // corrupt cache entry; fall through to recompute
      }
    }
  }

  let stdout = ''
  let parsed: unknown
  let lastErr: unknown
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      stdout = spawnCanvasWorkerOnce(workerPath, json)
      parsed = JSON.parse(stdout)
      if (!isCanvasBundle(parsed)) throw new Error('canvasWorker returned an invalid CanvasBundle')
      lastErr = undefined
      break
    } catch (err) {
      lastErr = err
      if (attempt === 1) {
        console.warn(`[canvas] worker attempt 1 failed, retrying once: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if (lastErr || !isCanvasBundle(parsed)) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'canvasWorker failed'))
  }

  if (!options.noCache) {
    cache.set(key, parsed)
    try {
      fs.mkdirSync(cacheDir, { recursive: true })
      const cacheFile = path.join(cacheDir, `${key}.json`)
      const tmp = `${cacheFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      fs.writeFileSync(tmp, stdout, 'utf8')
      fs.renameSync(tmp, cacheFile)
    } catch (err) {
      console.warn(`[canvas] could not write disk cache: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const ms = Math.round(performance.now() - t0)
  process.stdout.write(`[canvas] layout ${ms}ms (worker, groups=${input.groups.length})\n`)
  return parsed
}

/** Build the pre-computed bundle for the root / given curriculum. */
export function buildCanvasFromCurriculum(cur: Pick<CurriculumData, 'groups' | 'edges'>): CanvasBundle {
  return runCanvasWorker(canvasInputFromCurriculum(cur))
}

/**
 * Restricted tier slice `/_access/<tierId>/canvas.json`:
 *   - `boardWithInline`: exact ELK + libavoid board for `[inlineGroups..., tierGroups...]` (never includes other restricted tiers);
 *   - `tierOwn`: pre-computed intra-group layouts + DIP units for ONLY this tier's groups (used when >= 2 restricted tiers are composed client-side).
 */
export function canvasSliceOf(full: CurriculumData, plan: AccessPlan, tierId: string): CanvasTierSlice {
  const tierGroup = (id: string): string => plan.tierOfGroup[id] ?? plan.inlineTier
  const inlineGroups = full.groups.filter((g) => tierGroup(g.id) === plan.inlineTier)
  const ownGroups = full.groups.filter((g) => tierGroup(g.id) === tierId)

  const combinedGroups = [...inlineGroups, ...ownGroups]
  const combinedLec = new Set(combinedGroups.flatMap((g) => g.lectures.map((l) => l.id)))
  const combinedEdges = full.edges.filter(([a, b]) => combinedLec.has(a) && combinedLec.has(b))

  const ownLec = new Set(ownGroups.flatMap((g) => g.lectures.map((l) => l.id)))
  const ownEdges = full.edges.filter(([a, b]) => ownLec.has(a) && ownLec.has(b))

  return {
    version: 1,
    tier: tierId,
    boardWithInline: runCanvasWorker(canvasInputFromCurriculum({ groups: combinedGroups, edges: combinedEdges })),
    tierOwn: runCanvasWorker(canvasInputFromCurriculum({ groups: ownGroups, edges: ownEdges })),
  }
}
