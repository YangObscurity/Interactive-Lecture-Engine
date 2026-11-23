/**
 * auth/useSession.ts — Vue composable over the session client.
 *
 * SSR and the hydration render see `{ status: 'unknown' }`; the real session is fetched in `onMounted`
 * (so server and first client render agree), and the ref follows later changes.
 */
import { getCurrentInstance, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import type { Ref } from 'vue'
import { getSession, subscribeSession } from './session'
import type { SessionState } from './session'

export function useSession(): Readonly<Ref<SessionState>> {
  const state = shallowRef<SessionState>({ status: 'unknown' })
  if (getCurrentInstance()) {
    let stop: (() => void) | null = null
    onMounted(() => {
      stop = subscribeSession((s) => {
        state.value = s
      })
      void getSession().then((s) => {
        state.value = s
      })
    })
    onBeforeUnmount(() => stop?.())
  }
  return state
}
