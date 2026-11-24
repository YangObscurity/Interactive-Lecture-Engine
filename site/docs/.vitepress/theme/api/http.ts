/**
 * api/http.ts — the one place that talks to `fetch` for the progress / session code.
 *
 * `request()` never throws and never rejects. SSR (no `window`) and a missing `fetch` come back as
 * `kind: 'network'`. Every outcome carries `serverDate` (the response `Date` header in ms, or null) so the
 * caller can estimate clock skew (API_CONTRACT.md §2.5).
 *
 * Redirects are NOT followed (`redirect: 'manual'`). Behind a forward-auth gateway (Authelia) an expired sign-in
 * answers API calls with a redirect to the login page; following it would turn a write that never reached the
 * backend into a "200 OK" HTML page. A redirect comes back as `kind: 'redirect'` instead.
 *
 * Logging: `fetch` is looked up at call time, so when the debug console is on, its fetch wrapper
 * (debug/registry.ts) records one line per same-origin `/api/**` request — method, path, status, duration,
 * never bodies or headers — and adds the mock scenario header. Nothing is logged here.
 */

export const DEFAULT_TIMEOUT_MS = 8000

export type HttpResult<T> =
  | { ok: true; status: number; data: T; serverDate: number | null }
  | {
      ok: false
      /** `redirect`: the server (usually the auth gateway) answered with a redirect, e.g. an expired sign-in. */
      kind: 'network' | 'timeout' | 'http' | 'parse' | 'redirect'
      /** HTTP status; present for `http`, and for `parse` (a 2xx whose body was not valid JSON). */
      status?: number
      /** From the `Retry-After` header, when present and valid. */
      retryAfterMs?: number
      serverDate: number | null
    }

export interface HttpRequestOptions {
  body?: unknown
  headers?: Record<string, string>
  credentials?: RequestCredentials
  timeoutMs?: number
  signal?: AbortSignal
  /** Test seam; default: the global `fetch` (resolved at call time). */
  fetchImpl?: typeof fetch
  /** Test seam for `Retry-After` given as an HTTP date. */
  now?: () => number
}

/** `Date` header -> ms, or null. */
export function parseServerDate(value: string | null): number | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isNaN(t) ? null : t
}

/** `Retry-After` (delta-seconds or HTTP date) -> ms, or undefined. */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (value.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : Math.max(0, t - now)
}

export async function request<T>(method: string, url: string, options: HttpRequestOptions = {}): Promise<HttpResult<T>> {
  const fetchFn = options.fetchImpl ?? (typeof window !== 'undefined' && typeof fetch === 'function' ? fetch : null)
  if (!fetchFn) return { ok: false, kind: 'network', serverDate: null }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const external = options.signal
  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers }
    let body: string | undefined
    if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }
    let res: Response
    try {
      res = await fetchFn(url, {
        method,
        headers,
        body,
        signal: controller.signal,
        credentials: options.credentials ?? 'same-origin',
        redirect: 'manual',
      })
    } catch {
      return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate: null }
    }
    // opaque redirect (redirect: 'manual'), a 3xx some fetch implementations surface, or one that was followed anyway
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.redirected) {
      return { ok: false, kind: 'redirect', serverDate: null }
    }
    const serverDate = parseServerDate(res.headers.get('date'))
    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'), (options.now ?? Date.now)())
      return { ok: false, kind: 'http', status: res.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), serverDate }
    }
    let text: string
    try {
      text = await res.text()
    } catch {
      return { ok: false, kind: timedOut ? 'timeout' : 'network', serverDate }
    }
    try {
      const data: unknown = text.trim() === '' ? null : JSON.parse(text)
      return { ok: true, status: res.status, data: data as T, serverDate }
    } catch {
      return { ok: false, kind: 'parse', status: res.status, serverDate }
    }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}
