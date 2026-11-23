/**
 * progress/seed.ts — turns the Notion knowledge-graph export into seed records (pure, testable).
 *
 * The seed is what the site ships as "the initial status of each lecture". It only applies to lectures that have
 * neither a server record nor a pending operation (plan_v2_p3 §3.3 read rule), so a new seed can never overwrite
 * anything the reader or the backend knows. `version` is a hash of the content, used for diagnostics only.
 *
 * Node and browser safe; no imports besides types and the hash. `seed.data.mts` (a VitePress data loader) calls it.
 */
import { fnv1a } from '../core/hash'
import { fromLegacyStatus, groupOfLecture, normaliseLectureId } from './types'
import type { ProgressRecord } from './types'

export interface SeedData {
  version: string
  records: ProgressRecord[]
}

export const EMPTY_SEED: SeedData = { version: 'empty', records: [] }

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * Knowledge-graph nodes -> seed. Nodes without a lecture id or with an unknown status are skipped; when a lecture
 * appears twice the later node wins. Records are sorted by lecture id so the version does not depend on file order.
 */
export function buildSeed(nodes: unknown): SeedData {
  if (!Array.isArray(nodes)) return EMPTY_SEED
  const byId = new Map<string, ProgressRecord>()
  for (const raw of nodes) {
    if (typeof raw !== 'object' || raw === null) continue
    const node = raw as Record<string, unknown>
    const rawId = str(node.lectureId)
    const status = fromLegacyStatus(node.status)
    if (!rawId || !status) continue
    const lectureId = normaliseLectureId(rawId)
    const groupRaw = str(node.groupId)
    byId.set(lectureId, {
      lectureId,
      groupId: groupRaw ? normaliseLectureId(groupRaw) : groupOfLecture(lectureId),
      status,
      completedAt: status === 'completed' ? str(node.completedDate) : null,
      updatedAt: null,
      notionNodeId: str(node.nodeId),
      notionPageId: str(node.notionPageId),
    })
  }
  const records = [...byId.values()].sort((a, b) => (a.lectureId < b.lectureId ? -1 : a.lectureId > b.lectureId ? 1 : 0))
  if (records.length === 0) return EMPTY_SEED
  return { version: fnv1a(JSON.stringify(records)), records }
}

/** Lookup table of a seed. */
export function seedIndex(seed: SeedData): Map<string, ProgressRecord> {
  return new Map(seed.records.map((r) => [r.lectureId, r]))
}
