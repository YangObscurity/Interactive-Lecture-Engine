/**
 * progress/types.ts — domain types of the progress store (plan_v2_p3 §3.3).
 *
 * The engine speaks `not_started | in_progress | completed`. The Chinese wire values (`PROGRESS_WIRE_STATUS` in
 * site.config.mts) appear only at the protocol boundary: the rest adapter, the V1 migration and the Notion bridge.
 * `toLegacyStatus` / `fromLegacyStatus` are the two conversion points for callers outside the adapter.
 */
import { PROGRESS_WIRE_STATUS } from '../../site.config.mts'

export type ProgressStatus = 'not_started' | 'in_progress' | 'completed'

export const PROGRESS_STATUSES: readonly ProgressStatus[] = ['not_started', 'in_progress', 'completed']

/** The legacy (V1 / wire / Notion) spelling of a status. */
export type LegacyProgressStatus = (typeof PROGRESS_WIRE_STATUS)[ProgressStatus]

export interface ProgressRecord {
  /** Lower-case, e.g. `g05-l19`. */
  lectureId: string
  groupId: string
  status: ProgressStatus
  completedAt: string | null
  updatedAt: string | null
  notionNodeId: string | null
  notionPageId: string | null
}

/** One write waiting to be sent (or being sent). */
export interface OutboxOp {
  /** Stable id; the `Idempotency-Key` of a single-operation request. */
  id: string
  lectureId: string
  groupId: string
  status: ProgressStatus
  /** Client time (ms since epoch) at which the reader made the change. */
  at: number
  attempts: number
  /** Earliest time (ms since epoch) of the next send attempt. */
  nextAt: number
}

export type ProgressEvent =
  /** `origin: 'user'` = made through `set` / `setMany` on this page; otherwise a load / sync result. */
  | { kind: 'change'; ids: string[]; origin?: 'user' }
  /** Everything may have changed (load finished, identity switch, another tab wrote, debug reset). */
  | { kind: 'reset' }
  /** The backend refused a write; the lecture is back at its previous status. */
  | { kind: 'rejected'; id: string; status: ProgressStatus }

export type ProgressListener = (event: ProgressEvent) => void

export type SyncState = 'idle' | 'sending' | 'retrying' | 'offline'

export function isProgressStatus(value: unknown): value is ProgressStatus {
  return typeof value === 'string' && (PROGRESS_STATUSES as readonly string[]).includes(value)
}

export function toLegacyStatus(status: ProgressStatus): LegacyProgressStatus {
  return PROGRESS_WIRE_STATUS[status]
}

/** Legacy spelling -> domain value; null for anything else. */
export function fromLegacyStatus(value: unknown): ProgressStatus | null {
  for (const key of PROGRESS_STATUSES) {
    if (PROGRESS_WIRE_STATUS[key] === value) return key
  }
  return null
}

/** `G05-L19` / ` g05-l19 ` -> `g05-l19`. */
export function normaliseLectureId(id: string): string {
  return id.trim().toLowerCase()
}

/** Group id from a lecture id (`g05-l19` -> `g05`); used only when nothing better is known. */
/**
 * Group id of a group directory: its LAST segment, lower-cased (`courses/g01` → `g01`, `G05` → `g05`), the same rule
 * as `core/route.ts` and API_CONTRACT.md §2.1. Accepts a plain group id too (no slash → itself, lower-cased).
 */
export function groupOfDir(dir: string): string {
  const last = String(dir ?? '').split('/').filter((s) => s.trim() !== '').pop() ?? ''
  return normaliseLectureId(last)
}

export function groupOfLecture(lectureId: string): string {
  const i = lectureId.lastIndexOf('-')
  return i > 0 ? lectureId.slice(0, i) : lectureId
}
