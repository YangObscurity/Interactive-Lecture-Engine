/**
 * progress/v1Migration.ts — one-time import of V1 progress (plan_v2_p3 §3.3 "V1 迁移").
 *
 * V1 kept progress in two places under the `tut_neon_` prefix: one record per lecture (`progress_<id>`) and a map of
 * all of them (`progress_all_map`). The union of both is read (ids lower-cased, the newer `updated_at` wins).
 * A record whose status equals the seed is ignored (V1 wrote the seed into its own storage on every load); the
 * others become pending operations stamped with the V1 `updated_at`, and the load-time arbitration decides
 * whether the server already knows better. V1 keys are only ever READ here, never changed or removed: a V1 site on
 * the same domain keeps working, and rolling back loses nothing.
 */
import { STORAGE_KEYS, STORAGE_SUBKEYS } from '../../site.config.mts'
import { fromLegacyStatus, groupOfLecture, normaliseLectureId } from './types'
import type { OutboxOp, ProgressRecord, ProgressStatus } from './types'

/** What the migration needs from a Storage. */
export type MigrationStorage = Pick<Storage, 'getItem' | 'key' | 'length'>

export interface V1Progress {
  lectureId: string
  groupId: string
  status: ProgressStatus
  /** ms since epoch; 0 when V1 did not record a usable time. */
  updatedAt: number
}

function parseRecord(value: unknown, fallbackId: string | null): V1Progress | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const status = fromLegacyStatus(v.status)
  const rawId = typeof v.lecture_id === 'string' && v.lecture_id.trim() !== '' ? v.lecture_id : fallbackId
  if (!status || !rawId) return null
  const lectureId = normaliseLectureId(rawId)
  const groupId = typeof v.group_id === 'string' && v.group_id.trim() !== '' ? normaliseLectureId(v.group_id) : groupOfLecture(lectureId)
  const t = typeof v.updated_at === 'string' ? Date.parse(v.updated_at) : Number.NaN
  return { lectureId, groupId, status, updatedAt: Number.isNaN(t) ? 0 : t }
}

function readJson(storage: MigrationStorage, key: string): unknown {
  try {
    const raw = storage.getItem(key)
    return raw === null ? undefined : JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Read the union of V1's per-lecture records and its map from `storage`. Never writes. */
export function readV1Progress(storage: MigrationStorage, prefix: string = STORAGE_KEYS.neonPrefix): V1Progress[] {
  const out = new Map<string, V1Progress>()
  const take = (rec: V1Progress | null): void => {
    if (!rec) return
    const have = out.get(rec.lectureId)
    if (!have || rec.updatedAt > have.updatedAt) out.set(rec.lectureId, rec)
  }

  const mapKey = prefix + STORAGE_SUBKEYS.progressAllMap
  const itemPrefix = prefix + STORAGE_SUBKEYS.progressPrefix
  const map = readJson(storage, mapKey)
  if (typeof map === 'object' && map !== null && !Array.isArray(map)) {
    for (const [id, value] of Object.entries(map)) take(parseRecord(value, id))
  }
  const keys: string[] = []
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i)
      if (k !== null && k !== mapKey && k.startsWith(itemPrefix)) keys.push(k)
    }
  } catch {
    // storage not enumerable: the map alone has to do
  }
  for (const k of keys) take(parseRecord(readJson(storage, k), k.slice(itemPrefix.length)))
  return [...out.values()]
}

export interface MigrationInput {
  v1: readonly V1Progress[]
  /** Seed lookup: V1 records with the same status are ignored. A lecture without a seed entry counts as not started. */
  seed: ReadonlyMap<string, ProgressRecord>
  /** Lectures that already have a pending operation: those win, V1 is skipped for them. */
  skip?: ReadonlySet<string>
  now: number
  newId: () => string
}

/** Pure: V1 records -> pending operations (sorted by lecture id, so the result does not depend on key order). */
export function planV1Migration(input: MigrationInput): OutboxOp[] {
  const ops: OutboxOp[] = []
  for (const rec of [...input.v1].sort((a, b) => (a.lectureId < b.lectureId ? -1 : a.lectureId > b.lectureId ? 1 : 0))) {
    if (input.skip?.has(rec.lectureId)) continue
    const base: ProgressStatus = input.seed.get(rec.lectureId)?.status ?? 'not_started'
    if (rec.status === base) continue
    const at = rec.updatedAt > 0 ? rec.updatedAt : input.now
    ops.push({ id: input.newId(), lectureId: rec.lectureId, groupId: rec.groupId, status: rec.status, at, attempts: 0, nextAt: input.now })
  }
  return ops
}
