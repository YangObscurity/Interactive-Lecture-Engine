/**
 * api/progress.ts — progress backends (plan_v2_p3 §3.2).
 *
 *   createLocalBackend()   nothing on a server; `send` succeeds at once with records made from the operations.
 *   createRestBackend()    the docs/backend-handoff/API_CONTRACT.md protocol (§2.2 - §2.4).
 *
 * This is the only module that converts between domain statuses and the Chinese wire values.
 * Neither backend throws; failures come back as `{ ok: false, error }`.
 */
import { DB_ROUTES, PROGRESS_WIRE_STATUS } from '../../site.config.mts'
import { fnv1a } from '../core/hash'
import { fromLegacyStatus, groupOfLecture, normaliseLectureId } from '../progress/types'
import type { OutboxOp, ProgressRecord } from '../progress/types'
import { isWireProgress } from './contract'
import type { WireProgress } from './contract'
import { request } from './http'
import type { HttpResult } from './http'

export interface SendError {
  retryable: boolean
  status?: number
  retryAfterMs?: number
}

export type FetchAllResult =
  | { ok: true; records: ProgressRecord[]; serverDate: number | null; unfilteredGet: boolean }
  | { ok: false; error: SendError }

export type SendResult =
  | { ok: true; records: ProgressRecord[]; serverDate: number | null }
  | { ok: false; error: SendError }

export interface ProgressBackend {
  readonly kind: 'local' | 'rest'
  /** All records of the current user (local: none). */
  fetchAll(signal?: AbortSignal): Promise<FetchAllResult>
  /** One operation goes as PATCH, two or more as POST /batch in chunks of `BATCH_SIZE`. */
  send(ops: OutboxOp[], signal?: AbortSignal): Promise<SendResult>
}

/** Backend limit per batch request (API_CONTRACT.md §2.4). */
export const BATCH_SIZE = 200

// ---------------------------------------------------------------------------------------------------
// wire <-> domain
// ---------------------------------------------------------------------------------------------------

/** The request item for one operation (PATCH body and batch item). */
export function toWireWrite(op: Pick<OutboxOp, 'lectureId' | 'groupId' | 'status' | 'at'>): WireProgress {
  return {
    lecture_id: op.lectureId,
    group_id: op.groupId,
    status: PROGRESS_WIRE_STATUS[op.status],
    updated_at: new Date(op.at).toISOString(),
  }
}

/** Wire record -> domain record; null when the status is not one of the three wire values. */
export function fromWireRecord(wire: WireProgress): ProgressRecord | null {
  const status = fromLegacyStatus(wire.status)
  if (!status) return null
  const lectureId = normaliseLectureId(wire.lecture_id)
  return {
    lectureId,
    groupId: wire.group_id ? normaliseLectureId(wire.group_id) : groupOfLecture(lectureId),
    status,
    completedAt: wire.completed_at ?? null,
    updatedAt: wire.updated_at ?? null,
    notionNodeId: wire.notion_node_id ?? null,
    notionPageId: wire.notion_page_id ?? null,
  }
}

/** The record the local backend (and a lenient rest reply) derives from an operation. */
export function recordFromOp(op: OutboxOp, updatedAt: string | null): ProgressRecord {
  return {
    lectureId: op.lectureId,
    groupId: op.groupId,
    status: op.status,
    completedAt: op.status === 'completed' ? new Date(op.at).toISOString() : null,
    updatedAt,
    notionNodeId: null,
    notionPageId: null,
  }
}

function recordsFromWire(data: unknown): ProgressRecord[] {
  const items: unknown[] = Array.isArray(data) ? data : [data]
  const out: ProgressRecord[] = []
  for (const item of items) {
    if (!isWireProgress(item)) continue
    const rec = fromWireRecord(item)
    if (rec) out.push(rec)
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------

/**
 * Retry network failures, timeouts, 5xx, 408 and 429; everything else is a business refusal.
 * A redirect (the auth gateway sending an expired sign-in to its login page) is retried too: the write never reached
 * the backend, and it goes out once the reader has signed in again. It carries `status: 0` (opaque redirect), so the
 * store reports `retrying` rather than `offline`.
 */
export function toSendError(result: Extract<HttpResult<unknown>, { ok: false }>): SendError {
  if (result.kind === 'redirect') return { retryable: true, status: 0 }
  const status = result.status
  const retryable =
    result.kind === 'network' ||
    result.kind === 'timeout' ||
    // a 2xx that is not JSON (e.g. a proxy serving index.html for an unrouted /api path): the backend never saw it
    result.kind === 'parse' ||
    (result.kind === 'http' && status !== undefined && (status >= 500 || status === 408 || status === 429))
  return {
    retryable,
    ...(status !== undefined ? { status } : {}),
    ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------
// local
// ---------------------------------------------------------------------------------------------------

export function createLocalBackend(): ProgressBackend {
  return {
    kind: 'local',
    async fetchAll() {
      return { ok: true, records: [], serverDate: null, unfilteredGet: true }
    },
    async send(ops) {
      return { ok: true, records: ops.map((op) => recordFromOp(op, new Date(op.at).toISOString())), serverDate: null }
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// rest
// ---------------------------------------------------------------------------------------------------

export interface RestBackendOptions {
  /** Base path, e.g. `/api/db`; `/progress` and `/progress/batch` are appended. */
  endpoint: string
  /** Group ids for the per-group fallback read (called when needed, so the list can arrive late). */
  groupIds: () => readonly string[]
  timeoutMs?: number
  /** Test seam. */
  fetchImpl?: typeof fetch
}

/** `Idempotency-Key` of a batch: stable across retries of the same operations, independent of their order. */
export function batchIdempotencyKey(ops: readonly Pick<OutboxOp, 'id'>[]): string {
  return `batch-${fnv1a(ops.map((o) => o.id).sort().join(','))}`
}

/** A backend that cannot list everything unfiltered answers with one of these. */
const UNFILTERED_UNSUPPORTED = new Set([400, 404, 422])

/**
 * A 2xx with an empty body or with JSON that is not the contract's record (a legacy backend) is a success: the
 * backend took the writes. A 2xx whose body is not JSON at all is NOT: that is typically an HTML page served by
 * something in front of the backend, and treating it as success would drop writes that never arrived.
 * The result keeps the order of `sent`, with the operation itself standing in for a missing record.
 */
function settle(r: HttpResult<unknown>, sent: readonly OutboxOp[]): SendResult {
  if (!r.ok) return { ok: false, error: toSendError(r) }
  const byId = new Map(recordsFromWire(r.data).map((rec) => [rec.lectureId, rec]))
  return { ok: true, records: sent.map((op) => byId.get(op.lectureId) ?? recordFromOp(op, null)), serverDate: r.serverDate }
}

export function createRestBackend(opts: RestBackendOptions): ProgressBackend {
  const base = opts.endpoint.replace(/\/+$/, '')
  const progressUrl = `${base}${DB_ROUTES.progress}`
  const batchUrl = `${base}${DB_ROUTES.progressBatch}`
  const common = { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl }

  return {
    kind: 'rest',

    async fetchAll(signal) {
      const first = await request<unknown>('GET', progressUrl, { ...common, signal })
      if (first.ok) {
        return { ok: true, records: recordsFromWire(first.data), serverDate: first.serverDate, unfilteredGet: true }
      }
      if (!(first.kind === 'http' && first.status !== undefined && UNFILTERED_UNSUPPORTED.has(first.status))) {
        return { ok: false, error: toSendError(first) }
      }
      // legacy backend: one request per group
      const groups = [...new Set(opts.groupIds().map((g) => normaliseLectureId(g)).filter(Boolean))]
      const results = await Promise.all(
        groups.map((g) => request<unknown>('GET', `${progressUrl}?group_id=${encodeURIComponent(g)}`, { ...common, signal })),
      )
      const records = new Map<string, ProgressRecord>()
      let serverDate: number | null = first.serverDate
      for (const r of results) {
        if (r.serverDate !== null) serverDate = r.serverDate
        if (r.ok) {
          for (const rec of recordsFromWire(r.data)) records.set(rec.lectureId, rec)
        } else if (!(r.kind === 'http' && r.status === 404)) {
          return { ok: false, error: toSendError(r) }
        }
      }
      return { ok: true, records: [...records.values()], serverDate, unfilteredGet: false }
    },

    async send(ops, signal) {
      const [only] = ops
      if (only === undefined) return { ok: true, records: [], serverDate: null }

      if (ops.length === 1) {
        const r = await request<unknown>('PATCH', `${progressUrl}/${encodeURIComponent(only.lectureId)}`, {
          ...common,
          signal,
          headers: { 'idempotency-key': only.id },
          body: toWireWrite(only),
        })
        return settle(r, ops)
      }

      const records: ProgressRecord[] = []
      let serverDate: number | null = null
      for (let i = 0; i < ops.length; i += BATCH_SIZE) {
        const chunk = ops.slice(i, i + BATCH_SIZE)
        const r = await request<unknown>('POST', batchUrl, {
          ...common,
          signal,
          headers: { 'idempotency-key': batchIdempotencyKey(chunk) },
          body: { items: chunk.map(toWireWrite) },
        })
        const settled = settle(r, chunk)
        if (!settled.ok) return settled
        records.push(...settled.records)
        if (settled.serverDate !== null) serverDate = settled.serverDate
      }
      return { ok: true, records, serverDate }
    },
  }
}
