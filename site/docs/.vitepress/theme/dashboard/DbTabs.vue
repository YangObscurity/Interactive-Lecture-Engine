<script setup lang="ts">
/** DbTabs.vue — page tabs (`role="tablist"`), arrow keys move between them; the selection lives in the URL hash. */
import { useT } from '../../i18n/useT.ts'
import { isPageDirty, tabOf, type DashboardPageId } from './useDashboard'

const props = defineProps<{ page: DashboardPageId; label: string; items: ReadonlyArray<readonly [string, string]>; dirtyTabs?: readonly string[] }>()
const emit = defineEmits<{ select: [tab: string] }>()
const { t } = useT()

function onKey(e: KeyboardEvent, i: number): void {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
  e.preventDefault()
  const n = props.items.length
  const next = props.items[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]
  if (!next) return
  emit('select', next[0])
  const host = (e.currentTarget as HTMLElement).parentElement
  setTimeout(() => host?.querySelector<HTMLElement>(`[data-dashboard-subtab="${next[0]}"]`)?.focus(), 0)
}
</script>

<template>
  <div class="db-tabs" role="tablist" :aria-label="label">
    <button
      v-for="([id, text], i) in items"
      :key="id"
      type="button"
      role="tab"
      :aria-selected="tabOf(page) === id"
      :tabindex="tabOf(page) === id ? 0 : -1"
      :data-dashboard-subtab="id"
      @click="emit('select', id)"
      @keydown="onKey($event, i)"
    >
      {{ text }}<span v-if="dirtyTabs?.includes(id) && isPageDirty(page)" class="db-unsaved">{{ t('dsh.common.unsaved') }}</span>
    </button>
  </div>
</template>
