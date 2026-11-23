/**
 * progress/useProgress.ts — Vue composable over the progress store.
 *
 * Hydration: during SSR and the first client render `ready` is false and `statusOf` answers `not_started` for
 * everything, so server and client markup agree. The subscription starts in `onMounted`; from then on the refs
 * follow the store.
 */
import { getCurrentInstance, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import { progressStore } from './progressStore'
import type { ProgressMeta, ProgressStore, ProgressWrite } from './progressStore'
import type { ProgressEvent, ProgressStatus, SyncState } from './types'

export interface UseProgress {
  ready: Readonly<Ref<boolean>>
  /** Reactive: reading it inside a computed / render function tracks every change of the store. */
  statusOf(lectureId: string): ProgressStatus
  metaOf(lectureId: string): ProgressMeta
  /** Reactive. ISO time the lecture was completed, or null (see `ProgressStore.completedAtOf`). */
  completedAtOf(lectureId: string): string | null
  countCompleted(lectureIds: Iterable<string>): number
  set(lectureId: string, status: ProgressStatus, options?: { groupId?: string }): void
  setMany(items: readonly ProgressWrite[]): void
  syncState: Readonly<Ref<SyncState>>
  /** Number of writes waiting to be confirmed. */
  pending: Readonly<Ref<number>>
  /** Called when the backend refuses a write (the status has already rolled back). Removed with the component. */
  onRejected(listener: (event: { id: string; status: ProgressStatus }) => void): () => void
}

export function useProgress(store: ProgressStore = progressStore): UseProgress {
  const ready = ref(false)
  const syncState = shallowRef<SyncState>('idle')
  const pending = ref(0)
  /** Bumped on every change: reading it makes `statusOf` reactive. */
  const version = ref(0)
  const rejectedListeners = new Set<(event: { id: string; status: ProgressStatus }) => void>()

  const pull = (): void => {
    ready.value = store.isReady()
    syncState.value = store.syncState()
    pending.value = store.pending()
  }

  if (getCurrentInstance()) {
    const stops: Array<() => void> = []
    onMounted(() => {
      stops.push(
        store.subscribe((e: ProgressEvent) => {
          version.value++
          if (e.kind === 'rejected') for (const l of [...rejectedListeners]) l({ id: e.id, status: e.status })
          pull()
        }),
        store.subscribeSync(pull),
      )
      pull()
      version.value++
    })
    onBeforeUnmount(() => {
      for (const stop of stops) stop()
      rejectedListeners.clear()
    })
  }

  return {
    ready,
    statusOf(lectureId) {
      void version.value
      return ready.value ? store.statusOf(lectureId) : 'not_started'
    },
    metaOf(lectureId) {
      void version.value
      return store.metaOf(lectureId)
    },
    completedAtOf(lectureId) {
      void version.value
      return ready.value ? store.completedAtOf(lectureId) : null
    },
    countCompleted(ids) {
      void version.value
      if (!ready.value) return 0
      return store.countCompleted(ids)
    },
    set: (id, status, options) => store.set(id, status, options),
    setMany: (items) => store.setMany(items),
    syncState,
    pending,
    onRejected(listener) {
      rejectedListeners.add(listener)
      return () => {
        rejectedListeners.delete(listener)
      }
    },
  }
}
