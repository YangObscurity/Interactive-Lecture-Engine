/**
 * access/useAccess.ts - Vue composable over the access store.
 *
 * Server render and the hydration render see `ready = false` and no readable tier; the real answer is read after mount
 * (the same rule as `useSession`), so both renders agree. `loadGraph` is the one loader of the knowledge graph.
 */
import { getCurrentInstance, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { AccessResult, GraphOptions } from './resolve'
import { getAccess, loadGraph, subscribeAccess } from './store'

export interface UseAccess {
  /** True once the gateway has been asked (immediately after mount when no restricted tier exists). */
  ready: Readonly<Ref<boolean>>
  /** Ids of the restricted tiers the reader may read. */
  readable: Readonly<Ref<readonly string[]>>
  /** 0 until the first answer; +1 for every later (re-)resolution. Watch it to load what depends on the readable tiers. */
  version: Readonly<Ref<number>>
  /** `/notion_knowledge_graph.json` merged with the readable tiers' `graph.json`; null when the inline file fails. */
  loadGraph(opts?: GraphOptions): Promise<unknown | null>
}

export function useAccess(): UseAccess {
  const ready = shallowRef(false)
  const readable = shallowRef<readonly string[]>([])
  const version = shallowRef(0)
  if (getCurrentInstance()) {
    let stop: (() => void) | null = null
    const apply = (r: AccessResult): void => {
      readable.value = r.tiers.map((t) => t.id)
      ready.value = true
      version.value++
    }
    onMounted(() => {
      stop = subscribeAccess(apply)
      void getAccess().then((r) => {
        if (!ready.value) apply(r)
      })
    })
    onBeforeUnmount(() => stop?.())
  }
  return { ready, readable, version, loadGraph }
}
