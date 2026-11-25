/**
 * Shared fakes for the progress / session unit tests: a clock, a scheduler, a lock manager, a storage, a scripted
 * backend and a scripted `fetch`. Nothing here touches the network or real timers.
 */
import type { FetchAllResult, ProgressBackend, SendResult } from '../../docs/.vitepress/theme/api/progress'
import type { KeyValueStorage, LockManagerLike, Scheduler } from '../../docs/.vitepress/theme/progress/progressStore'
import type { OutboxOp, ProgressRecord, ProgressStatus } from '../../docs/.vitepress/theme/progress/types'

export class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>()
  failWrites = false
  get length(): number {
    return this.map.size
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('QuotaExceededError')
    this.map.set(key, String(value))
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

export class FakeClock {
  constructor(public t = Date.parse('2026-11-18T08:00:00.000Z')) {}
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
  iso(offsetMs = 0): string {
    return new Date(this.t + offsetMs).toISOString()
  }
}

export class FakeScheduler implements Scheduler {
  readonly timers: Array<{ id: number; fn: () => void; ms: number }> = []
  readonly delays: number[] = []
  private seq = 0
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.timers.push({ id, fn, ms })
    this.delays.push(ms)
    return id
  }
  clear(handle: unknown): void {
    const i = this.timers.findIndex((t) => t.id === handle)
    if (i >= 0) this.timers.splice(i, 1)
  }
  get lastDelay(): number | undefined {
    return this.delays.at(-1)
  }
}

export class FakeLocks implements LockManagerLike {
  readonly names: string[] = []
  async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    this.names.push(name)
    return callback()
  }
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

export function rec(lectureId: string, status: ProgressStatus, extra: Partial<ProgressRecord> = {}): ProgressRecord {
  const group = lectureId.slice(0, lectureId.lastIndexOf('-'))
  return {
    lectureId,
    groupId: group,
    status,
    completedAt: status === 'completed' ? '2026-11-01T00:00:00.000Z' : null,
    updatedAt: null,
    notionNodeId: null,
    notionPageId: null,
    ...extra,
  }
}

export function op(lectureId: string, status: ProgressStatus, at: number, extra: Partial<OutboxOp> = {}): OutboxOp {
  return { id: `op-${lectureId}-${at}`, lectureId, groupId: lectureId.slice(0, lectureId.lastIndexOf('-')), status, at, attempts: 0, nextAt: at, ...extra }
}

/** A backend whose answers are scripted; `sent` records every `send` call. */
export class ScriptedBackend implements ProgressBackend {
  readonly sent: OutboxOp[][] = []
  fetchAllCalls = 0
  fetchAllResult: FetchAllResult = { ok: true, records: [], serverDate: null, unfilteredGet: true }
  /** Optional scripted results for successive `fetchAll` calls; falls back to `fetchAllResult`. */
  fetchAllResults: Array<FetchAllResult | Promise<FetchAllResult>> = []
  /** Results returned by successive `send` calls; when exhausted, `defaultSend` runs. */
  sendResults: Array<SendResult | Promise<SendResult>> = []
  readonly sendSignals: AbortSignal[] = []
  readonly fetchSignals: AbortSignal[] = []
  get lastSendSignal(): AbortSignal | undefined {
    return this.sendSignals.at(-1)
  }
  get lastFetchSignal(): AbortSignal | undefined {
    return this.fetchSignals.at(-1)
  }

  constructor(
    public kind: 'local' | 'rest' = 'rest',
    private readonly clock: FakeClock = new FakeClock(),
  ) {}
  async fetchAll(signal?: AbortSignal): Promise<FetchAllResult> {
    this.fetchAllCalls++
    if (signal) this.fetchSignals.push(signal)
    const next = this.fetchAllResults.shift()
    return next ?? this.fetchAllResult
  }
  async send(ops: OutboxOp[], signal?: AbortSignal): Promise<SendResult> {
    this.sent.push(ops)
    if (signal) this.sendSignals.push(signal)
    const next = this.sendResults.shift()
    if (next) return next
    return { ok: true, records: ops.map((o) => rec(o.lectureId, o.status, { groupId: o.groupId, updatedAt: this.clock.iso() })), serverDate: null }
  }
}

export interface FakeRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}
export type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> } | Error

/** A scripted `fetch`; `calls` records the requests it saw. */
export function fakeFetch(handler: (req: FakeRequest, index: number) => FakeReply | Promise<FakeReply>): { fetch: typeof fetch; calls: FakeRequest[] } {
  const calls: FakeRequest[] = []
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    const req: FakeRequest = { method: init?.method ?? 'GET', url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, headers, body }
    calls.push(req)
    const reply = await handler(req, calls.length - 1)
    if (reply instanceof Error) throw reply
    const text = reply.body === undefined ? null : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body)
    return new Response(text, { status: reply.status, headers: reply.headers })
  }
  return { fetch: impl as typeof fetch, calls }
}

/** Let queued promise callbacks run. */
export async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}
