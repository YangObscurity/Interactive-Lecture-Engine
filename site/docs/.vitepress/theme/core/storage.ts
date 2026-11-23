/**
 * core/storage.ts — typed localStorage helpers for V2 modules.
 *
 * Built on the site.config fallback helpers (`readRawWithFallback` / `writeRawWithDualWrite` /
 * `removeRawWithFallback`): reads try the current key first and then legacy keys, writes go to all
 * of them. Key NAMES come from `STORAGE_KEYS` and are never changed here — they live in users'
 * browsers (`lecture-reading-mode`, `lecture-read-pos`, …).
 *
 * Everything is SSR-safe and never throws: unavailable storage (private mode, quota) degrades to
 * "nothing stored".
 */
import {
  STORAGE_KEYS,
  storageKeysFor,
  readRawWithFallback,
  writeRawWithDualWrite,
  removeRawWithFallback,
} from '../../site.config.mts'

export type StorageKeyName = keyof typeof STORAGE_KEYS

/**
 * Legacy aliases per key, newest first (read fallback + dual write). Empty today: no V1 key has
 * been renamed. Add an alias here instead of renaming a value in `STORAGE_KEYS`.
 */
let LEGACY_ALIASES: Partial<Record<StorageKeyName, readonly string[]>> = {}

/** Test seam: install legacy aliases (pass `null` to restore the defaults). */
export function __setLegacyAliasesForTests(aliases: Partial<Record<StorageKeyName, readonly string[]>> | null): void {
  LEGACY_ALIASES = aliases ?? {}
}

/** Candidate key list for a named key: current key first, then legacy aliases. */
export function keysOf(name: StorageKeyName): string[] {
  return storageKeysFor(STORAGE_KEYS[name], LEGACY_ALIASES[name] ?? [])
}

export function getRaw(name: StorageKeyName): string | null {
  return readRawWithFallback(keysOf(name))
}

export function setRaw(name: StorageKeyName, value: string): void {
  writeRawWithDualWrite(keysOf(name), value)
}

export function remove(name: StorageKeyName): void {
  removeRawWithFallback(keysOf(name))
}

/**
 * Read and parse JSON. Returns `fallback` when missing, unparseable, or rejected by `validate`.
 */
export function getJson<T>(name: StorageKeyName, fallback: T, validate?: (value: unknown) => value is T): T {
  const raw = getRaw(name)
  if (raw === null) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (validate && !validate(parsed)) return fallback
    return parsed as T
  } catch {
    return fallback
  }
}

export function setJson(name: StorageKeyName, value: unknown): void {
  let raw: string
  try {
    raw = JSON.stringify(value)
  } catch {
    return
  }
  setRaw(name, raw)
}

/** Boolean flags are stored V1-style as `'1'` / `'0'`. */
export function getFlag(name: StorageKeyName): boolean {
  return getRaw(name) === '1'
}

export function setFlag(name: StorageKeyName, on: boolean): void {
  setRaw(name, on ? '1' : '0')
}
