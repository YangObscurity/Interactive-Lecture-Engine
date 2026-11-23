/**
 * theme/debug/flags.ts — typed feature flags.
 *
 * Resolution order for `isEnabled(name)`:
 *   1. localStorage `lecture:flags` (JSON object `{ [name]: boolean }`), written by
 *      `window.__LECTURE_DEBUG__.flags.set(name, bool)`;
 *   2. build-time env `VITE_FLAG_<NAME>=1` (accepted spellings for `aiScope`:
 *      `VITE_FLAG_AI_SCOPE` and `VITE_FLAG_AISCOPE`; values `1|true|on|yes` = on, `0|false|off|no` = off);
 *   3. default `false`.
 *
 * SSR-safe: no window/localStorage access at module top level; on the server only env/default apply.
 * No runtime dependencies.
 */

/** Flags known to the app today. Any other string is still accepted (generic flags). */
export const KNOWN_FLAGS = ['aiScope', 'aiUpload', 'newBoard'] as const

export type KnownFlag = (typeof KNOWN_FLAGS)[number]
// `string & {}` keeps autocomplete for known names while allowing arbitrary flags.
export type FlagName = KnownFlag | (string & {})

export const FLAGS_STORAGE_KEY = 'lecture:flags'
/** Fired on `window` after a local override changes (same tab). Other tabs get the `storage` event. */
export const FLAGS_CHANGED_EVENT = 'lecture:flags-changed'

export type FlagSource = 'override' | 'env' | 'default'

export interface FlagState {
  name: string
  enabled: boolean
  source: FlagSource
}

type EnvRecord = Record<string, unknown>

/**
 * Read Vite's `import.meta.env`. The literal expression must stay in the source: Vite only injects
 * the env where that exact text appears (an aliased `import.meta` leaves `env` undefined in the browser).
 */
export function readViteEnv(): EnvRecord {
  try {
    const env: unknown = import.meta.env
    return env && typeof env === 'object' ? (env as EnvRecord) : {}
  } catch {
    return {}
  }
}

/** Test seam: override the env source (pass `null` to restore). */
let envOverride: EnvRecord | null = null
export function __setFlagEnvForTests(env: EnvRecord | null): void {
  envOverride = env
}
const currentEnv = (): EnvRecord => envOverride ?? readViteEnv()

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}

/** `aiScope` -> ['AI_SCOPE', 'AISCOPE'] */
export function envKeysFor(name: string): string[] {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase()
  const flat = name.replace(/[^A-Za-z0-9]+/g, '').toUpperCase()
  return [...new Set([snake, flat])].map((k) => `VITE_FLAG_${k}`)
}

function parseBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(v)) return true
  if (['0', 'false', 'off', 'no', ''].includes(v)) return false
  return null
}

/** Local overrides (empty object when none / unreadable / SSR). */
export function readOverrides(): Record<string, boolean> {
  const storage = getStorage()
  if (!storage) return {}
  try {
    const raw = storage.getItem(FLAGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeOverrides(next: Record<string, boolean>): void {
  const storage = getStorage()
  if (!storage) return
  try {
    if (Object.keys(next).length === 0) storage.removeItem(FLAGS_STORAGE_KEY)
    else storage.setItem(FLAGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // quota / privacy mode: overrides simply do not persist
  }
  try {
    window.dispatchEvent(new CustomEvent(FLAGS_CHANGED_EVENT, { detail: { ...next } }))
  } catch {
    // CustomEvent unavailable: listeners will catch up on next read
  }
}

function envValue(name: string): boolean | null {
  const env = currentEnv()
  for (const key of envKeysFor(name)) {
    const parsed = parseBool(env[key])
    if (parsed !== null) return parsed
  }
  return null
}

export function getFlagState(name: FlagName): FlagState {
  const overrides = readOverrides()
  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    return { name, enabled: overrides[name] === true, source: 'override' }
  }
  const fromEnv = envValue(name)
  if (fromEnv !== null) return { name, enabled: fromEnv, source: 'env' }
  return { name, enabled: false, source: 'default' }
}

/** Main entry for app code: `if (isEnabled('aiScope')) { ... }` */
export function isEnabled(name: FlagName): boolean {
  return getFlagState(name).enabled
}

/** Set a local override; `null` removes the override (falls back to env/default). */
export function setFlag(name: FlagName, value: boolean | null): FlagState {
  const overrides = readOverrides()
  if (value === null) delete overrides[name]
  else overrides[name] = value
  writeOverrides(overrides)
  return getFlagState(name)
}

/** Remove all local overrides. */
export function resetFlags(): void {
  writeOverrides({})
}

/** Known flags plus any name that has an override or a VITE_FLAG_* env entry. */
export function listFlags(): FlagState[] {
  const names = new Set<string>(KNOWN_FLAGS)
  for (const k of Object.keys(readOverrides())) names.add(k)
  for (const k of Object.keys(currentEnv())) {
    if (!k.startsWith('VITE_FLAG_')) continue
    const flat = k.slice('VITE_FLAG_'.length)
    const known = [...names].find((n) => envKeysFor(n).includes(k))
    if (!known) names.add(flat.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()))
  }
  return [...names].map((n) => getFlagState(n))
}

/**
 * Subscribe to flag changes (same tab via custom event, other tabs via `storage`).
 * Returns an unsubscribe function. No-op on the server.
 */
export function onFlagsChange(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (e: StorageEvent): void => {
    if (e.key === FLAGS_STORAGE_KEY || e.key === null) listener()
  }
  window.addEventListener(FLAGS_CHANGED_EVENT, listener)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(FLAGS_CHANGED_EVENT, listener)
    window.removeEventListener('storage', onStorage)
  }
}
