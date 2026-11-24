/**
 * auth/session.ts — session client (plan_v2_p3 §3.4).
 *
 * `getSession()` asks the backend once per page load who the reader is and keeps the answer in memory.
 * P3a only the progress store uses it (to keep one reader's data away from the next); sign-in UI and the
 * "permission needed" page come with P3b / P6.5.
 *
 *   adapter 'none'                  no request; anonymous, source 'none'
 *   anything else                   GET {sessionEndpoint}; 404 -> unavailable/not_found, network trouble ->
 *                                   unavailable/network, bad body -> unavailable/invalid,
 *                                   401 or a redirect -> unavailable/unauthorized
 *
 * Only an explicit `{ authenticated: false }` from the backend means "signed out" (anonymous/server). The session
 * endpoint is public by contract (API_CONTRACT.md §1.1), so a 401 or a redirect means the auth gateway intercepted
 * the call (typically an expired sign-in). Treating that as signed out would make the progress store clear the
 * reader's pending writes; `unavailable` leaves them alone.
 *
 * Nothing here touches `window` at import time.
 */
import { isWireSession } from '../api/contract'
import { request } from '../api/http'
import type { HttpResult } from '../api/http'

export interface SessionUser {
  id: string
  name: string | null
  email: string | null
}

export type SessionState =
  | { status: 'unknown' }
  | { status: 'anonymous'; source: 'none' | 'server' }
  | { status: 'authenticated'; user: SessionUser; roles: string[]; groups: string[]; logoutUrl: string | null }
  | { status: 'unavailable'; reason: 'not_found' | 'network' | 'invalid' | 'unauthorized' }

export const DEFAULT_SESSION_ENDPOINT = '/api/auth/session'

/** Pure: an HTTP outcome of `GET {sessionEndpoint}` -> a session state. */
export function parseSession(result: HttpResult<unknown>): SessionState {
  if (result.ok) {
    const body = result.data
    if (!isWireSession(body)) return { status: 'unavailable', reason: 'invalid' }
    if (!body.authenticated || body.user === null) return { status: 'anonymous', source: 'server' }
    return {
      status: 'authenticated',
      user: { id: body.user.id, name: body.user.name ?? null, email: body.user.email ?? null },
      roles: [...body.roles],
      groups: [...body.groups],
      logoutUrl: body.logoutUrl ?? null,
    }
  }
  if (result.kind === 'parse') return { status: 'unavailable', reason: 'invalid' }
  if (result.kind === 'redirect') return { status: 'unavailable', reason: 'unauthorized' }
  if (result.kind === 'http') {
    if (result.status === 401) return { status: 'unavailable', reason: 'unauthorized' }
    if (result.status === 404) return { status: 'unavailable', reason: 'not_found' }
  }
  return { status: 'unavailable', reason: 'network' }
}

export interface SessionClientOptions {
  adapter: string
  endpoint?: string
  timeoutMs?: number
  /** Test seam. */
  fetchImpl?: typeof fetch
}

export interface SessionClient {
  /** The session of this page load; the request is made once, later calls share the answer. */
  getSession(): Promise<SessionState>
  /** Forget the cached answer (tests, sign-in flows). */
  reset(): void
}

export function createSessionClient(opts: SessionClientOptions): SessionClient {
  let cached: Promise<SessionState> | null = null
  const fetchOnce = async (): Promise<SessionState> => {
    if (opts.adapter === 'none') return { status: 'anonymous', source: 'none' }
    const result = await request<unknown>('GET', opts.endpoint ?? DEFAULT_SESSION_ENDPOINT, {
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
    })
    return parseSession(result)
  }
  return {
    getSession() {
      cached ??= fetchOnce()
      return cached
    },
    reset() {
      cached = null
    },
  }
}

// ---- site singleton --------------------------------------------------------------------------------

let siteClient: SessionClient = createSessionClient({ adapter: 'none' })
let current: SessionState = { status: 'unknown' }
const listeners = new Set<(s: SessionState) => void>()

/**
 * Point the site session client at the configured adapter (`themeConfig.lectureModules.auth`).
 * Call before the first `getSession()`; calling again with a different setup starts over.
 */
export function configureSession(auth: { adapter: string; sessionEndpoint?: string }): void {
  siteClient = createSessionClient({ adapter: auth.adapter, endpoint: auth.sessionEndpoint })
  current = { status: 'unknown' }
}

/** The session of this page load (one request, cached in memory). Never rejects. */
export async function getSession(): Promise<SessionState> {
  const state = await siteClient.getSession()
  if (state !== current) {
    current = state
    for (const l of listeners) {
      try {
        l(state)
      } catch {
        // one broken listener must not stop the others
      }
    }
  }
  return state
}

/** The last session `getSession()` produced, or `{ status: 'unknown' }`. Synchronous. */
export function currentSession(): SessionState {
  return current
}

export function subscribeSession(listener: (s: SessionState) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Forget the cached answer (tests). */
export function resetSession(): void {
  siteClient.reset()
  current = { status: 'unknown' }
}

/** Synchronize session state pushed from another surface (e.g. Dashboard login/logout) to all listeners. */
export function publishSession(state: SessionState): void {
  siteClient.reset()
  const changed =
    current.status !== state.status ||
    JSON.stringify(current) !== JSON.stringify(state)
  current = state
  if (changed) {
    for (const l of listeners) {
      try {
        l(state)
      } catch {
        // one broken listener must not stop the others
      }
    }
  }
}
