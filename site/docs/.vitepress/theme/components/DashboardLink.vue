<script setup lang="ts">
/**
 * DashboardLink.vue - the top-bar entry to the Dashboard (before the settings button; inside the mobile menu on narrow screens).
 *
 * Shown only when `showDashboardEntry` says so (any signed-in user online, or local author mode in development): everyone else gets no
 * element at all, so nothing is reserved for them. The session arrives after mount (SSR and hydration render nothing), so the link
 * appears at the end of the button group and moves only the settings button after it, by its own width.
 * Style: only `--lec-*` tokens.
 */
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { useData, withBase } from 'vitepress'
import { useT } from '../../i18n/useT.ts'
import { localePrefix } from '../core/langLinks'
import { currentSession, subscribeSession } from '../auth/session'
import type { SessionState } from '../auth/session'
import { showDashboardEntry } from '../auth/dashboardEntry'

defineProps<{ screen?: boolean }>()

const { localeIndex } = useData()
const { t } = useT()

const session = shallowRef<SessionState>({ status: 'unknown' })
const devAuthor = shallowRef(false)
const visible = computed(() => showDashboardEntry(session.value, devAuthor.value))
const href = computed(() => withBase(`${localePrefix(localeIndex.value === 'root' ? '' : localeIndex.value)}/dashboard`))

let stop: (() => void) | null = null
onMounted(() => {
  session.value = currentSession()
  stop = subscribeSession((s) => {
    session.value = s
  })
  // local author mode: the same probe the Dashboard page uses (the module is only loaded in development)
  if (import.meta.env.DEV) {
    void import('../api/admin').then((m) => m.fetchDevDashboardStatus()).then((s) => {
      devAuthor.value = s !== null
    }).catch(() => {})
  }
})
onBeforeUnmount(() => stop?.())
</script>

<template>
  <a v-if="visible" class="dashboard-link" :class="{ 'is-screen': screen }" :href="href" data-lec-dashboard-link :title="t('nav.dashboardTitle')">{{ t('nav.dashboard') }}</a>
</template>

<style scoped>
.dashboard-link {
  display: inline-flex;
  align-items: center;
  height: 28px;
  margin-left: 8px;
  padding: 0 10px;
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  color: var(--lec-text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  text-decoration: none;
}
.dashboard-link:hover {
  border-color: var(--lec-accent);
  color: var(--lec-accent);
}
.dashboard-link.is-screen {
  margin: 12px 0 0;
}
/* below the hamburger breakpoint the entry lives in the mobile menu only (the bar is full) */
@media (max-width: 767px) {
  .dashboard-link:not(.is-screen) {
    display: none;
  }
}
</style>
