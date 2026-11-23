/**
 * theme/debug/registry.ts — browser debug console `window.__LECTURE_DEBUG__`.
 *
 * Enabled when ANY of:
 *   - `import.meta.env.DEV` (vitepress dev);
 *   - URL has `?debug=1` (persists opt-in to localStorage `lecture:debug=1`, works in production);
 *   - localStorage `lecture:debug` === '1'.
 * `?debug=0` removes the persisted opt-in and disables the console for this load (even in DEV).
 *
 * Modules register panels at any time (before or after `exposeDebug()`):
 *   registerDebugPanel('progress', { describe: () => store.snapshot(), actions: { flush: () => store.flush() } })
 *
 * SSR-safe: nothing touches `window` at module top level. No runtime dependencies.
 * Privacy: the fetch log stores method / url / status / duration only — never bodies or headers.
 */

import {
  FLAGS_STORAGE_KEY,
  getFlagState,
  listFlags,
  readViteEnv,
  resetFlags,
  setFlag,
  type FlagName,
  type FlagState,
} from './flags'

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type DebugAction = (...args: unknown[]) => unknown

export interface DebugPanel {
  /** Return a JSON-friendly snapshot of the module's state. Must not throw (errors are caught anyway). */
  describe(): unknown
  /** Named operations callable via `__LECTURE_DEBUG__.run(id, name, ...args)`. */
  actions?: Record<string, DebugAction>
}

export interface ApiLogEntry {
  at: string
  method: string
  url: string
  status: number | null
  ms: number
  scenario: string | null
  error?: string
}

export interface StorageSnapshot {
  schema: 'lecture-debug-storage/1'
  exportedAt: string
  origin: string
  entries: Record<string, string>
}

export interface StorageImportOptions {
  /** Remove existing lecture-related keys before importing (default false = merge). */
  replace?: boolean
}

export interface LectureDebugApi {
  readonly version: 1
  readonly enabledBy: DebugEnableReason
  help(): Array<{ panel: string; actions: string }>
  state(): Record<string, unknown>
  panel(id: string): unknown
  panels(): string[]
  run(id: string, action: string, ...args: unknown[]): unknown
  flags: {
    get(name: FlagName): boolean
    set(name: FlagName, value: boolean | null): FlagState
    list(): FlagState[]
    reset(): void
  }
  api: {
    readonly log: ApiLogEntry[]
    clear(): void
    /** Get (no arg), set (name) or clear (null / 'default') the mock scenario. */
    scenario(name?: string | null): string | null
    /** GET /__debug/api/state of the dev API-mode plugin (mock state, mode, origin). */
    serverState(): Promise<unknown>
    /** POST /__debug/api/reset (mock mode only). */
    serverReset(): Promise<unknown>
  }
  storage: {
    dump(prefix?: string): Record<string, unknown>
    export(): StorageSnapshot
    import(json: string | StorageSnapshot | Record<string, string>, options?: StorageImportOptions): number
    keys(): string[]
  }
}

export type DebugEnableReason = 'dev' | 'query' | 'localStorage' | 'disabled'

declare global {
  interface Window {
    __LECTURE_DEBUG__?: LectureDebugApi
  }
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const DEBUG_STORAGE_KEY = 'lecture:debug'
export const SCENARIO_STORAGE_KEY = 'lecture:api-scenario'
export const SCENARIO_HEADER = 'x-lecture-scenario'
export const SCENARIO_COOKIE = 'lecture-scenario'
export const API_LOG_LIMIT = 200

/** localStorage keys that belong to the lecture site (export / import / dump scope). */
export const LECTURE_STORAGE_PREFIXES = [
  'lecture-',
  'lecture:',
  'tut_neon_',
  'tut:',
  'dify_chat_user_id',
  'tutorial_ai_',
] as const

// ---------------------------------------------------------------------------
// panel registry (module state, SSR-safe)
// ---------------------------------------------------------------------------

const panels = new Map<string, DebugPanel>()

/**
 * Register (or replace) a debug panel. Returns an unregister function.
 * Safe to call during SSR and when debug is disabled (it is just a Map insert).
 */
export function registerDebugPanel(id: string, panel: DebugPanel): () => void {
  panels.set(id, panel)
  return () => {
    if (panels.get(id) === panel) panels.delete(id)
  }
}

export function getRegisteredPanels(): string[] {
  return [...panels.keys()].sort()
}

function safeDescribe(panel: DebugPanel): unknown {
  try {
    return panel.describe()
  } catch (err) {
    return { __error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// enable detection
// ---------------------------------------------------------------------------

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

/** Test seam for `import.meta.env.DEV`. */
let devOverride: boolean | null = null
export function __setDevForTests(value: boolean | null): void {
  devOverride = value
}

function isDevBuild(): boolean {
  if (devOverride !== null) return devOverride
  return readViteEnv().DEV === true
}

/**
 * Decide whether the console is enabled. Side effect: `?debug=1` persists the opt-in,
 * `?debug=0` clears it.
 */
export function resolveDebugEnabled(): DebugEnableReason {
  if (typeof window === 'undefined') return 'disabled'
  const storage = getStorage()
  let query: string | null = null
  try {
    query = new URLSearchParams(window.location.search).get('debug')
  } catch {
    query = null
  }
  if (query === '0') {
    storage?.removeItem(DEBUG_STORAGE_KEY)
    return 'disabled'
  }
  if (query === '1') {
    try {
      storage?.setItem(DEBUG_STORAGE_KEY, '1')
    } catch {
      // ignore quota errors; enabled for this load anyway
    }
    return 'query'
  }
  if (isDevBuild()) return 'dev'
  if (storage?.getItem(DEBUG_STORAGE_KEY) === '1') return 'localStorage'
  return 'disabled'
}

// ---------------------------------------------------------------------------
// fetch instrumentation
// ---------------------------------------------------------------------------

const apiLog: ApiLogEntry[] = []
let originalFetch: typeof fetch | null = null

function currentScenario(): string | null {
  return getStorage()?.getItem(SCENARIO_STORAGE_KEY) ?? null
}

function writeScenarioCookie(name: string | null): void {
  if (typeof document === 'undefined') return
  try {
    document.cookie = name
      ? `${SCENARIO_COOKIE}=${encodeURIComponent(name)}; path=/; SameSite=Lax`
      : `${SCENARIO_COOKIE}=; path=/; Max-Age=0; SameSite=Lax`
  } catch {
    // cookies disabled: header path still works for fetch
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Same-origin `/api/**` only; absolute URLs to other origins are never touched. */
function isLectureApi(rawUrl: string): { match: boolean; display: string } {
  try {
    const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
    const u = new URL(rawUrl, base)
    const sameOrigin = typeof window === 'undefined' || u.origin === window.location.origin
    const match = sameOrigin && (u.pathname === '/api' || u.pathname.startsWith('/api/'))
    return { match, display: u.pathname + u.search }
  } catch {
    return { match: false, display: rawUrl }
  }
}

function pushLog(entry: ApiLogEntry): void {
  apiLog.push(entry)
  if (apiLog.length > API_LOG_LIMIT) apiLog.splice(0, apiLog.length - API_LOG_LIMIT)
}

function installFetchWrapper(): void {
  if (originalFetch || typeof window === 'undefined' || typeof window.fetch !== 'function') return
  const base = window.fetch.bind(window)
  originalFetch = window.fetch
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = requestUrl(input)
    const { match, display } = isLectureApi(rawUrl)
    if (!match) return base(input, init)

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const scenario = currentScenario()
    let nextInit = init
    if (scenario) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      headers.set(SCENARIO_HEADER, scenario)
      nextInit = { ...init, headers }
    }
    const started = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const elapsed = (): number =>
      Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started)
    try {
      const res = await base(input, nextInit)
      pushLog({ at: new Date().toISOString(), method, url: display, status: res.status, ms: elapsed(), scenario })
      return res
    } catch (err) {
      pushLog({
        at: new Date().toISOString(),
        method,
        url: display,
        status: null,
        ms: elapsed(),
        scenario,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
      throw err
    }
  }
  window.fetch = wrapped as typeof fetch
}

function uninstallFetchWrapper(): void {
  if (originalFetch && typeof window !== 'undefined') window.fetch = originalFetch
  originalFetch = null
}

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

export function isLectureKey(key: string): boolean {
  return LECTURE_STORAGE_PREFIXES.some((p) => key === p || key.startsWith(p))
}

function lectureKeys(storage: Storage): string[] {
  const out: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k !== null && isLectureKey(k)) out.push(k)
  }
  return out.sort()
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
  )
}

function normaliseImport(input: string | StorageSnapshot | Record<string, string>): Record<string, string> {
  const parsed: unknown = typeof input === 'string' ? JSON.parse(input) : input
  if (parsed && typeof parsed === 'object' && 'entries' in parsed) {
    const entries = (parsed as { entries: unknown }).entries
    if (isRecordOfStrings(entries)) return entries
    throw new TypeError('storage.import: snapshot.entries must be Record<string, string>')
  }
  if (isRecordOfStrings(parsed)) return parsed
  throw new TypeError('storage.import: expected a StorageSnapshot or Record<string, string>')
}

// ---------------------------------------------------------------------------
// public API object
// ---------------------------------------------------------------------------

async function debugEndpoint(path: string, method: 'GET' | 'POST'): Promise<unknown> {
  const f = originalFetch ?? (typeof fetch === 'function' ? fetch : null)
  if (!f) throw new Error('fetch unavailable')
  const res = await f(path, { method })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} (is the dev server running with LECTURE_API_MODE=mock|proxy?)`)
  }
  return tryParse(text)
}

function createApi(enabledBy: DebugEnableReason): LectureDebugApi {
  const requireStorage = (): Storage => {
    const s = getStorage()
    if (!s) throw new Error('localStorage unavailable')
    return s
  }

  const api: LectureDebugApi = {
    version: 1,
    enabledBy,
    help() {
      const rows = getRegisteredPanels().map((id) => ({
        panel: id,
        actions: Object.keys(panels.get(id)?.actions ?? {}).join(', ') || '-',
      }))
      const methods = [
        'help()', 'state()', 'panel(id)', 'panels()', 'run(id, action, ...args)',
        'flags.get(name) / flags.set(name, bool|null) / flags.list() / flags.reset()',
        'api.log / api.clear() / api.scenario(name|null) / api.serverState() / api.serverReset()',
        'storage.dump(prefix?) / storage.export() / storage.import(json, {replace}) / storage.keys()',
      ]
      /* eslint-disable no-console */
      console.info('[__LECTURE_DEBUG__] enabled by: %s', enabledBy)
      if (rows.length) console.table(rows)
      else console.info('[__LECTURE_DEBUG__] no panels registered yet')
      console.info('[__LECTURE_DEBUG__] methods:\n  ' + methods.join('\n  '))
      /* eslint-enable no-console */
      return rows
    },
    state() {
      const out: Record<string, unknown> = {}
      for (const id of getRegisteredPanels()) {
        const p = panels.get(id)
        if (p) out[id] = safeDescribe(p)
      }
      return out
    },
    panel(id) {
      const p = panels.get(id)
      if (!p) throw new Error(`unknown panel "${id}"; registered: ${getRegisteredPanels().join(', ') || '(none)'}`)
      return safeDescribe(p)
    },
    panels: getRegisteredPanels,
    run(id, action, ...args) {
      const p = panels.get(id)
      if (!p) throw new Error(`unknown panel "${id}"`)
      const fn = p.actions?.[action]
      if (!fn) {
        throw new Error(`panel "${id}" has no action "${action}"; available: ${Object.keys(p.actions ?? {}).join(', ') || '(none)'}`)
      }
      return fn(...args)
    },
    flags: {
      get: (name) => getFlagState(name).enabled,
      set: (name, value) => setFlag(name, value),
      list: listFlags,
      reset: resetFlags,
    },
    api: {
      get log() {
        return apiLog.slice()
      },
      clear() {
        apiLog.length = 0
      },
      scenario(name) {
        if (name === undefined) return currentScenario()
        const storage = getStorage()
        if (name === null || name === '' || name === 'default') {
          storage?.removeItem(SCENARIO_STORAGE_KEY)
          writeScenarioCookie(null)
          return null
        }
        storage?.setItem(SCENARIO_STORAGE_KEY, name)
        writeScenarioCookie(name)
        return name
      },
      serverState: () => debugEndpoint('/__debug/api/state', 'GET'),
      serverReset: () => debugEndpoint('/__debug/api/reset', 'POST'),
    },
    storage: {
      keys() {
        return lectureKeys(requireStorage())
      },
      dump(prefix) {
        const s = requireStorage()
        const out: Record<string, unknown> = {}
        for (const k of lectureKeys(s)) {
          if (prefix && !k.startsWith(prefix)) continue
          const raw = s.getItem(k)
          if (raw !== null) out[k] = tryParse(raw)
        }
        return out
      },
      export() {
        const s = requireStorage()
        const entries: Record<string, string> = {}
        for (const k of lectureKeys(s)) {
          const raw = s.getItem(k)
          if (raw !== null) entries[k] = raw
        }
        return {
          schema: 'lecture-debug-storage/1',
          exportedAt: new Date().toISOString(),
          origin: typeof window !== 'undefined' ? window.location.origin : '',
          entries,
        }
      },
      import(json, options) {
        const s = requireStorage()
        const entries = normaliseImport(json)
        if (options?.replace) for (const k of lectureKeys(s)) s.removeItem(k)
        let written = 0
        for (const [k, v] of Object.entries(entries)) {
          if (!isLectureKey(k)) continue // never write foreign keys
          s.setItem(k, v)
          written++
        }
        return written
      },
    },
  }
  return api
}

// built-in panel describing the console itself
registerDebugPanel('debug', {
  describe: () => ({
    scenario: currentScenario(),
    apiLogSize: apiLog.length,
    fetchWrapped: originalFetch !== null,
    flags: listFlags(),
    flagsKey: FLAGS_STORAGE_KEY,
  }),
  actions: {
    scenario: (name: unknown) =>
      window.__LECTURE_DEBUG__?.api.scenario(typeof name === 'string' || name === null ? name : undefined),
    clearLog: () => {
      apiLog.length = 0
    },
  },
})

/**
 * Install `window.__LECTURE_DEBUG__` if enabled. Idempotent; call once on the client
 * (e.g. from theme `enhanceApp` or a client-only `onMounted`). Returns the API or null.
 */
export function exposeDebug(): LectureDebugApi | null {
  if (typeof window === 'undefined') return null
  const reason = resolveDebugEnabled()
  if (reason === 'disabled') {
    // ?debug=0 after a previous enable in the same page: tear down
    if (window.__LECTURE_DEBUG__) teardownDebug()
    return null
  }
  if (window.__LECTURE_DEBUG__) return window.__LECTURE_DEBUG__
  installFetchWrapper()
  // re-sync cookie so XHR uploads also carry the scenario after a reload
  writeScenarioCookie(currentScenario())
  const api = createApi(reason)
  window.__LECTURE_DEBUG__ = api
  return api
}

/** Remove the console and restore `window.fetch`. Mainly for tests. */
export function teardownDebug(): void {
  uninstallFetchWrapper()
  apiLog.length = 0
  if (typeof window !== 'undefined') delete window.__LECTURE_DEBUG__
}
