<script setup lang="ts">
/**
 * DbUnavailable.vue — what a feature would show, why it cannot here, and what it needs (prototype items marked
 * "需要后端"). Never fake data: this block replaces the feature until the backend exists.
 */
import { useT } from '../../i18n/useT.ts'

defineProps<{ what: string; why: string; id?: string }>()
const { t } = useT()
</script>

<template>
  <div class="db-unavail" role="note" :data-dashboard-unavailable="id ?? ''">
    <span class="dm" data-k="off" aria-hidden="true"></span>
    <div>
      <div class="db-unavail-t">{{ t('dsh.common.unavailable', { what }) }}</div>
      <div class="db-unavail-d">{{ why }}</div>
    </div>
  </div>
</template>
