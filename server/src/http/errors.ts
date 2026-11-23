import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ErrorKey =
  | 'invalid_lecture_id'
  | 'invalid_status'
  | 'too_many_items'
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'payload_too_large'
  | 'rate_limited'
  | 'idempotency_key_reused'
  | 'internal_error'

export interface ErrorResponseBody {
  error: ErrorKey | string
  message?: string
  [key: string]: unknown
}

export class HttpError extends Error {
  readonly status: number
  readonly errorKey: ErrorKey | string
  readonly headers?: Record<string, string>
  readonly extra?: Record<string, unknown>

  constructor(
    status: number,
    errorKey: ErrorKey | string,
    options?: {
      message?: string
      headers?: Record<string, string>
      extra?: Record<string, unknown>
    },
  ) {
    super(options?.message ?? errorKey)
    this.name = 'HttpError'
    this.status = status
    this.errorKey = errorKey
    this.headers = options?.headers
    this.extra = options?.extra
  }

  toResponse(): ErrorResponseBody {
    return {
      error: this.errorKey,
      ...(this.message && this.message !== this.errorKey ? { message: this.message } : {}),
      ...(this.extra ?? {}),
    }
  }
}

export function badRequest(
  errorKey: 'invalid_lecture_id' | 'invalid_status' | 'too_many_items' | 'invalid_request',
  options?: { message?: string; extra?: Record<string, unknown> },
): HttpError {
  return new HttpError(400, errorKey, options)
}

export function unauthenticated(message?: string): HttpError {
  return new HttpError(401, 'unauthenticated', { message })
}

export function forbidden(message?: string): HttpError {
  return new HttpError(403, 'forbidden', { message })
}

export function notFound(message?: string): HttpError {
  return new HttpError(404, 'not_found', { message })
}

export function methodNotAllowed(allow = 'GET'): HttpError {
  return new HttpError(405, 'method_not_allowed', { headers: { Allow: allow } })
}

export function payloadTooLarge(message?: string): HttpError {
  return new HttpError(413, 'payload_too_large', { message })
}

/** 429 with `Retry-After`; `limit` names which cap was hit (`rate`, `daily`, `concurrency`, ...). */
export function rateLimited(limit: string, retryAfterSec: number): HttpError {
  return new HttpError(429, 'rate_limited', {
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) },
    extra: { limit, retry_after: Math.max(1, Math.ceil(retryAfterSec)) },
  })
}

export function idempotencyKeyReused(message = 'this Idempotency-Key was used for a different request'): HttpError {
  return new HttpError(422, 'idempotency_key_reused', { message })
}

export function internalError(message?: string): HttpError {
  return new HttpError(500, 'internal_error', { message })
}

/**
 * Handles errors caught by Hono and returns the standard error JSON envelope.
 * Always attaches Date header, and ensures no request payload or internal stack is leaked.
 */
export function handleAppError(err: unknown, c: Context): Response {
  c.header('Date', new Date().toUTCString())
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    c.header('Cache-Control', 'no-store')
  }

  if (err instanceof HttpError) {
    if (err.headers) {
      for (const [k, v] of Object.entries(err.headers)) {
        c.header(k, v)
      }
    }
    return c.json(err.toResponse(), err.status as ContentfulStatusCode)
  }

  if (err instanceof SyntaxError) {
    return c.json({ error: 'invalid_request' }, 400)
  }

  // Never leak secret or stack traces to client
  console.error('[server error]', err instanceof Error ? err.message : err)
  return c.json({ error: 'internal_error' }, 500)
}
