/**
 * Node >= 25 ships a global `localStorage` that is backed by nothing unless
 * `--localstorage-file` is given, and it shadows happy-dom's Storage.
 * Install a spec-shaped in-memory Storage before every test so DOM tests get a
 * working, isolated localStorage / sessionStorage.
 */
import { beforeEach } from 'vitest'
import { loadAndValidateSitePrompts } from '../../docs/.vitepress/prompts/load.mts'
import { configureCompanionPrompts } from '../../docs/.vitepress/prompts/store.ts'

class MemoryStorage implements Storage {
  #map = new Map<string, string>()
  get length(): number {
    return this.#map.size
  }
  clear(): void {
    this.#map.clear()
  }
  getItem(key: string): string | null {
    return this.#map.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.#map.delete(key)
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, String(value))
  }
}

function install(name: 'localStorage' | 'sessionStorage'): void {
  const store = new MemoryStorage()
  Object.defineProperty(globalThis, name, { value: store, configurable: true, writable: true })
  if (typeof window !== 'undefined' && window !== globalThis) {
    Object.defineProperty(window, name, { value: store, configurable: true, writable: true })
  }
}

beforeEach(() => {
  install('localStorage')
  install('sessionStorage')
  try {
    configureCompanionPrompts(loadAndValidateSitePrompts().prompts)
  } catch {
    // Allow isolated tests to fall back cleanly
  }
})
