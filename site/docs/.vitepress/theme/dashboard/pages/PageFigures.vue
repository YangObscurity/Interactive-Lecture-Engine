<script setup lang="ts">
/**
 * PageFigures.vue — 图与概念: the figure gallery (view only: source and where it is used; hanging figures is the coding
 * agent's job, §3.3) and the concept drafts (compare, confirm, return, delete).
 */
import { useT } from '../../../i18n/useT.ts'
import DashboardGalleryPanel from '../DashboardGalleryPanel.vue'
import DashboardConceptsPanel from '../DashboardConceptsPanel.vue'
import DbHead from '../DbHead.vue'
import DbTabs from '../DbTabs.vue'
import { dashboardState, tabOf } from '../useDashboard'

defineEmits<{ tab: [tab: string] }>()
const { t } = useT()
</script>

<template>
  <div class="db-page" data-page="figures">
    <DbHead :title="t('dsh.nav.figures')" :lead="t('dsh.fig.lead')" />
    <DbTabs
      page="figures"
      :label="t('dsh.nav.figures')"
      :items="[
        ['gallery', t('dsh.fig.tabGallery')],
        ['drafts', t('dsh.fig.tabDrafts')],
      ]"
      @select="$emit('tab', $event)"
    />
    <div v-if="tabOf('figures') === 'gallery'" data-dashboard-pane="gallery">
      <div class="db-banner"><span class="db-info" aria-hidden="true"></span><span>{{ t('dsh.fig.banner') }}</span></div>
      <DashboardGalleryPanel :is-dev-mode="dashboardState.mode === 'dev'" />
    </div>
    <div v-else data-dashboard-pane="concepts">
      <DashboardConceptsPanel :is-dev-mode="dashboardState.mode === 'dev'" :csrf-token="dashboardState.token" />
    </div>
  </div>
</template>
