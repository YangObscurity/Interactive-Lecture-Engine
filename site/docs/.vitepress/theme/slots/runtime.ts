/**
 * theme/slots/runtime.ts - which implementation a slot renders, and when it changes (P2e, plan section 2.4).
 *
 * Rules (hydration comes first):
 *   - SSR and the first client render use the site default theme's implementation (it is imported statically, so the
 *     server renders it and the client's first render equals the server markup);
 *   - after mount the runtime reads `<html data-lec-theme>` (set by the inline head script of theme/tokens/prefs.ts)
 *     and watches it. When the active theme differs from the default and covers the slot with a different
 *     implementation, that implementation is loaded and swapped in once it is there; until then the default one stays;
 *   - a theme that does not cover a slot already maps to the engine default (decided at build time).
 *
 * Pure of the build: the table comes from `virtual:lecture-components` (see ./index.ts), tests pass their own.
 */
import { onBeforeUnmount, onMounted, ref, shallowReactive, type Component, type Ref } from 'vue'
import type { SlotName } from './contract.ts'

export interface SlotImpl {
  /** Theme id that provides the component, or `default` for the engine implementation. */
  impl: string
  load: () => Promise<Component>
}
export type SlotTable = Record<string, Partial<Record<SlotName, SlotImpl>>>
export interface StaticImpl {
  impl: string
  component: Component
}

export interface SlotRuntimeInit {
  defaultTheme: string
  table: SlotTable
  /** The default theme's implementation per slot, already in the bundle (rendered by SSR and the first client frame). */
  staticImpls: Partial<Record<SlotName, StaticImpl>>
}

export interface ResolvedSlot {
  impl: string
  component: Component
}

export interface SlotRuntime {
  /** `null` until the first slot component has mounted. */
  activeTheme: Readonly<Ref<string | null>>
  resolve(slot: SlotName): ResolvedSlot | null
  /** Start following `data-lec-theme` (reference counted); returns the matching stop function. */
  start(): () => void
  /** Composable for components: starts on mount, stops on unmount. */
  useActive(): void
  /** Resolve once all currently requested alternate-theme slot chunks finish loading (with timeout warning). */
  whenSettled(timeoutMs?: number): Promise<void>
}

export const SWAP_MARK_START = 'lec-slot:start'
export const SWAP_MARK_DONE = 'lec-slot:swapped'

function mark(name: string): void {
  try {
    if (typeof performance !== 'undefined') performance.mark(name)
  } catch {
    // marks are diagnostics only
  }
}

export function createSlotRuntime(init: SlotRuntimeInit): SlotRuntime {
  const active = ref<string | null>(null)
  const loaded = shallowReactive(new Map<string, Component>())
  const requested = new Set<string>()
  const pendingLoads = new Set<Promise<void>>()
  let users = 0
  let observer: MutationObserver | null = null

  const readTheme = (): string | null => document.documentElement.getAttribute('data-lec-theme')

  function start(): () => void {
    if (typeof document === 'undefined') return () => {}
    users++
    if (users === 1) {
      mark(SWAP_MARK_START)
      active.value = readTheme()
      observer = new MutationObserver(() => {
        active.value = readTheme()
      })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-lec-theme'] })
    } else if (active.value === null) {
      active.value = readTheme()
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      users--
      if (users === 0) {
        observer?.disconnect()
        observer = null
      }
    }
  }

  function ensureLoaded(key: string, entry: SlotImpl): void {
    if (requested.has(key)) return
    requested.add(key)
    const task = entry
      .load()
      .then((component) => {
        loaded.set(key, component)
        mark(SWAP_MARK_DONE)
      })
      .catch((error: unknown) => {
        // keep showing the default implementation; a retry would only repeat the failure
        console.warn(`[lecture-slots] could not load ${key}:`, error)
      })
      .finally(() => {
        pendingLoads.delete(task)
      })
    pendingLoads.add(task)
  }

  async function whenSettled(timeoutMs = 5000): Promise<void> {
    if (pendingLoads.size === 0) return
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity
    while (pendingLoads.size > 0) {
      const batch = Promise.all([...pendingLoads])
      if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
        await batch
        continue
      }
      const left = deadline - Date.now()
      if (left <= 0) {
        console.warn(`[lecture-slots] timed out after ${timeoutMs}ms waiting for ${pendingLoads.size} slot(s)`)
        return
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      const expired = await Promise.race([
        batch.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), left)
        }),
      ])
      if (timer !== null) clearTimeout(timer)
      if (expired) {
        console.warn(`[lecture-slots] timed out after ${timeoutMs}ms waiting for ${pendingLoads.size} slot(s)`)
        return
      }
    }
  }

  function resolve(slot: SlotName): ResolvedSlot | null {
    const stat = init.staticImpls[slot]
    if (!stat) return null
    const theme = active.value
    if (theme === null || theme === init.defaultTheme) return { impl: stat.impl, component: stat.component }
    const entry = init.table[theme]?.[slot]
    if (!entry || entry.impl === stat.impl) return { impl: stat.impl, component: stat.component }
    const key = `${theme}:${slot}`
    const ready = loaded.get(key)
    if (ready) return { impl: entry.impl, component: ready }
    ensureLoaded(key, entry)
    return { impl: stat.impl, component: stat.component }
  }

  function useActive(): void {
    let stop: (() => void) | null = null
    onMounted(() => {
      stop = start()
    })
    onBeforeUnmount(() => stop?.())
  }

  return { activeTheme: active, resolve, start, useActive, whenSettled }
}
