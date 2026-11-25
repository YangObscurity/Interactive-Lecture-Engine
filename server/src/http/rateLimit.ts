/**
 * Per-user request limits (in-memory, single process).
 *
 * lecture-api runs as one Node process behind nginx, so plain Maps are enough: the counters are
 * lost on restart and are NOT shared between processes. If the service is ever scaled out, move
 * the counters to a shared store (or keep the nginx `limit_req` zones as the coarse outer cap).
 *
 * Three independent mechanisms, all keyed by the effective user id:
 *   - TokenBucket: requests per minute, with a burst equal to the per-minute rate;
 *   - DailyCounter: requests per UTC calendar day;
 *   - ConcurrencyGate: simultaneously open streams / uploads.
 */

export type Clock = () => number

export interface TokenTake {
  ok: boolean
  /** Whole seconds until at least one token is available again (>= 1 when `ok` is false). */
  retryAfterSec: number
}

interface BucketState {
  tokens: number
  updatedAt: number
}

const PRUNE_THRESHOLD = 5000

export class TokenBucket {
  private readonly buckets = new Map<string, BucketState>()
  private readonly capacity: number
  private readonly refillPerMs: number

  constructor(
    ratePerMinute: number,
    private readonly now: Clock = Date.now,
  ) {
    this.capacity = ratePerMinute
    this.refillPerMs = ratePerMinute / 60_000
  }

  take(key: string): TokenTake {
    const t = this.now()
    let b = this.buckets.get(key)
    if (!b) {
      this.prune(t)
      b = { tokens: this.capacity, updatedAt: t }
      this.buckets.set(key, b)
    } else {
      const elapsed = Math.max(0, t - b.updatedAt)
      b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerMs)
      b.updatedAt = t
    }
    if (b.tokens >= 1) {
      b.tokens -= 1
      return { ok: true, retryAfterSec: 0 }
    }
    const missing = 1 - b.tokens
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(missing / this.refillPerMs / 1000)) }
  }

  /** Drop buckets that have been idle long enough to be full again. */
  private prune(t: number): void {
    if (this.buckets.size < PRUNE_THRESHOLD) return
    const fullAfterMs = this.capacity / this.refillPerMs
    for (const [k, b] of this.buckets) {
      if (t - b.updatedAt >= fullAfterMs) this.buckets.delete(k)
    }
  }
}

function utcDayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10)
}

function secondsToUtcMidnight(t: number): number {
  const d = new Date(t)
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - t) / 1000))
}

export class DailyCounter {
  private readonly counts = new Map<string, { day: string; count: number }>()

  constructor(
    private readonly limit: number,
    private readonly now: Clock = Date.now,
  ) {}

  /** Count one request; `ok: false` when the daily cap is already used up. */
  take(key: string): TokenTake {
    const t = this.now()
    const day = utcDayKey(t)
    let c = this.counts.get(key)
    if (!c || c.day !== day) {
      if (this.counts.size >= PRUNE_THRESHOLD) {
        for (const [k, v] of this.counts) {
          if (v.day !== day) this.counts.delete(k)
        }
      }
      c = { day, count: 0 }
      this.counts.set(key, c)
    }
    if (c.count >= this.limit) {
      return { ok: false, retryAfterSec: secondsToUtcMidnight(t) }
    }
    c.count += 1
    return { ok: true, retryAfterSec: 0 }
  }
}

export class ConcurrencyGate {
  private readonly active = new Map<string, number>()

  constructor(private readonly max: number) {}

  /** Returns a release function (idempotent), or null when the user is at the cap. */
  acquire(key: string): (() => void) | null {
    const n = this.active.get(key) ?? 0
    if (n >= this.max) return null
    this.active.set(key, n + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const cur = this.active.get(key) ?? 0
      if (cur <= 1) this.active.delete(key)
      else this.active.set(key, cur - 1)
    }
  }
}

export type LimitKind = 'rate' | 'daily' | 'concurrency' | 'upload_concurrency' | 'write_rate' | 'auth_rate'

export interface LimitDecision {
  ok: boolean
  kind?: LimitKind
  retryAfterSec: number
}

export interface AiLimitOptions {
  /**
   * Skip the per-day cap (and do not count the request toward it). Set for authors and admins: the daily cap
   * protects the budget from readers, and an author must not be locked out by a number only readers should hit.
   * The per-minute bucket still applies to everyone.
   */
  exemptDaily?: boolean
}

/** Requests-per-minute plus per-day cap for `/api/ai/*`. A request refused by the minute bucket does not use up the daily quota. */
export class AiRequestLimiter {
  private readonly bucket: TokenBucket
  private readonly daily: DailyCounter

  constructor(ratePerMinute: number, dailyLimit: number, now: Clock = Date.now) {
    this.bucket = new TokenBucket(ratePerMinute, now)
    this.daily = new DailyCounter(dailyLimit, now)
  }

  check(userId: string, options: AiLimitOptions = {}): LimitDecision {
    const rate = this.bucket.take(userId)
    if (!rate.ok) return { ok: false, kind: 'rate', retryAfterSec: rate.retryAfterSec }
    if (options.exemptDaily) return { ok: true, retryAfterSec: 0 }
    const day = this.daily.take(userId)
    if (!day.ok) return { ok: false, kind: 'daily', retryAfterSec: day.retryAfterSec }
    return { ok: true, retryAfterSec: 0 }
  }
}

/** Requests-per-minute bucket for write endpoints. */
export class WriteRateLimiter {
  private readonly bucket: TokenBucket

  constructor(ratePerMinute: number, now: Clock = Date.now) {
    this.bucket = new TokenBucket(ratePerMinute, now)
  }

  check(userId: string): LimitDecision {
    const r = this.bucket.take(userId)
    return r.ok ? { ok: true, retryAfterSec: 0 } : { ok: false, kind: 'write_rate', retryAfterSec: r.retryAfterSec }
  }
}

/** Bounded per-user set of ids issued by this server (conversation ids, uploaded file ids). */
export class OwnedIdTracker {
  private readonly byUser = new Map<string, Set<string>>()

  constructor(
    private readonly perUserCap = 200,
    private readonly maxUsers = 5000,
  ) {}

  add(userId: string, id: string): void {
    if (!id) return
    let set = this.byUser.get(userId)
    if (!set) {
      if (this.byUser.size >= this.maxUsers) {
        const oldest = this.byUser.keys().next().value
        if (oldest !== undefined) this.byUser.delete(oldest)
      }
      set = new Set<string>()
      this.byUser.set(userId, set)
    } else {
      // refresh recency of this user
      this.byUser.delete(userId)
      this.byUser.set(userId, set)
    }
    set.delete(id)
    set.add(id)
    if (set.size > this.perUserCap) {
      const first = set.values().next().value
      if (first !== undefined) set.delete(first)
    }
  }

  has(userId: string, id: string): boolean {
    return this.byUser.get(userId)?.has(id) ?? false
  }
}

interface FailedLoginEntry {
  failures: number
  blockedUntil: number
  lastFailAt: number
}

/**
 * Account-keyed failed login exponential backoff.
 *
 * Tracks failed authentication attempts by normalized username, independent of client IP.
 * Once failures reach freeAttempts, blocks subsequent attempts with exponential cooldown
 * (baseMs * 2^(failures - freeAttempts), capped at maxMs).
 * Successful logins reset the counter immediately.
 */
export class FailedLoginBackoff {
  private readonly entries = new Map<string, FailedLoginEntry>()
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly resetAfterMs: number
  private readonly maxEntries: number

  constructor(
    private readonly freeAttempts: number,
    private readonly now: Clock = Date.now,
    options?: { baseMs?: number; maxMs?: number; resetAfterMs?: number; maxEntries?: number },
  ) {
    this.baseMs = options?.baseMs ?? 1000
    this.maxMs = options?.maxMs ?? 30_000
    this.resetAfterMs = options?.resetAfterMs ?? 15 * 60_000
    this.maxEntries = options?.maxEntries ?? 5000
  }

  check(key: string): LimitDecision {
    const t = this.now()
    const entry = this.entries.get(key)
    if (!entry) return { ok: true, retryAfterSec: 0 }
    if (t - entry.lastFailAt >= this.resetAfterMs) {
      this.entries.delete(key)
      return { ok: true, retryAfterSec: 0 }
    }
    if (t < entry.blockedUntil) {
      return {
        ok: false,
        kind: 'auth_rate',
        retryAfterSec: Math.max(1, Math.ceil((entry.blockedUntil - t) / 1000)),
      }
    }
    return { ok: true, retryAfterSec: 0 }
  }

  recordFailure(key: string): void {
    const t = this.now()
    let entry = this.entries.get(key)
    if (!entry || t - entry.lastFailAt >= this.resetAfterMs) {
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined) this.entries.delete(oldest)
      }
      entry = { failures: 0, blockedUntil: 0, lastFailAt: t }
      this.entries.set(key, entry)
    }
    entry.failures += 1
    entry.lastFailAt = t
    if (entry.failures >= this.freeAttempts) {
      const exponent = Math.min(10, entry.failures - this.freeAttempts)
      const delay = Math.min(this.maxMs, this.baseMs * 2 ** exponent)
      entry.blockedUntil = t + delay
    }
  }

  reset(key: string): void {
    this.entries.delete(key)
  }
}
