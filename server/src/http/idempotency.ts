import type { Db, DbClient } from '../db/types.js'

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface IdempotencyResult<T = unknown> {
  statusCode: number
  body: T
  replayed: boolean
}

/**
 * Canonical JSON with object keys sorted recursively for stable hashing.
 * Arrays maintain their original order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  )
}

/**
 * Deterministic request fingerprint: `${METHOD} ${normalizedPath} ${canonicalJson(body)}`.
 */
export function computeFingerprint(method: string, path: string, body: unknown): string {
  const normPath = path.length > 1 ? path.replace(/\/+$/, '') : path
  return `${method.toUpperCase()} ${normPath} ${canonicalJson(body ?? {})}`
}

interface RawIdempotencyRow {
  user_id: string
  key: string
  fingerprint: string
  status_code: number
  response: unknown
  created_at: Date | string
}

/**
 * Executes an operation with transactional idempotency guarantees according to API Contract §2:
 * - Scoped per (user_id, key)
 * - 24-hour TTL (older records purged during write)
 * - Row-level locking on idempotency_keys prevents concurrent execution of the same key
 * - Cached responses replayed with Idempotency-Replayed: true
 * - Different payload reusing same key returns HTTP 422 idempotency_key_reused
 * - Only 2xx responses are remembered
 */
export async function executeIdempotent<T>(
  db: Db,
  userId: string,
  rawKey: string | null | undefined,
  fingerprint: string,
  now: Date,
  handler: (txClient: DbClient) => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotencyResult<T>> {
  const key = rawKey?.trim()

  // If no idempotency key provided, execute inside a fresh transaction without caching
  if (!key) {
    return db.tx(async (txClient) => {
      const res = await handler(txClient)
      return {
        statusCode: res.statusCode,
        body: res.body,
        replayed: false,
      }
    })
  }

  const nowIso = now.toISOString()
  const cutoffIso = new Date(now.getTime() - IDEMPOTENCY_TTL_MS).toISOString()

  return db.tx(async (txClient) => {
    // 1. Purge expired keys (> 24 hours)
    await txClient.query(
      'DELETE FROM idempotency_keys WHERE created_at < $1',
      [cutoffIso],
    )

    // 2. Lock or create placeholder row (status_code = 0)
    const insertRes = await txClient.query<RawIdempotencyRow>(
      `INSERT INTO idempotency_keys (
        user_id,
        key,
        fingerprint,
        status_code,
        response,
        created_at
      )
      VALUES ($1, $2, $3, 0, '{}'::jsonb, $4::timestamptz)
      ON CONFLICT (user_id, key) DO UPDATE SET key = EXCLUDED.key
      RETURNING user_id, key, fingerprint, status_code, response, created_at`,
      [userId, key, fingerprint, nowIso],
    )

    const row = insertRes.rows[0]
    if (!row) {
      throw new Error('Failed to acquire idempotency row lock')
    }

    // 3. Row already completed by previous transaction
    if (row.status_code !== 0) {
      if (row.fingerprint !== fingerprint) {
        return {
          statusCode: 422,
          body: {
            error: 'idempotency_key_reused',
            message: 'this Idempotency-Key was used for a different request',
          } as unknown as T,
          replayed: false,
        }
      }
      return {
        statusCode: row.status_code,
        body: row.response as T,
        replayed: true,
      }
    }

    // 4. We hold the lock: execute handler
    const res = await handler(txClient)

    // 5. Cache ONLY 2xx responses. The first response is the stored copy read back, so it is byte-identical to every
    //    replay: jsonb reorders object keys, and the contract promises the replay returns the same body.
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const stored = await txClient.query<{ response: unknown }>(
        `UPDATE idempotency_keys
         SET status_code = $3,
             response = $4::jsonb,
             fingerprint = $5,
             created_at = $6::timestamptz
         WHERE user_id = $1 AND key = $2
         RETURNING response`,
        [userId, key, res.statusCode, JSON.stringify(res.body), fingerprint, nowIso],
      )
      const row = stored.rows[0]
      return { statusCode: res.statusCode, body: (row ? row.response : res.body) as T, replayed: false }
    } else {
      // Non-2xx response: remove placeholder so subsequent requests can retry
      await txClient.query(
        'DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2',
        [userId, key],
      )
    }

    return {
      statusCode: res.statusCode,
      body: res.body,
      replayed: false,
    }
  })
}
