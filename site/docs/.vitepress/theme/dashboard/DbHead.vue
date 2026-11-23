<script setup lang="ts">
/** DbHead.vue — page header: title, one-line purpose, facts (file, version, time), and the read-only lock line online. */
import { useT } from '../../i18n/useT.ts'
import { isReadOnly } from './useDashboard'

defineProps<{ title: string; lead: string; meta?: ReadonlyArray<readonly [string, string]> }>()
const { t } = useT()
</script>

<template>
  <header class="db-ph">
    <h2>{{ title }}</h2>
    <p>{{ lead }}</p>
    <dl v-if="meta && meta.length" class="db-pm">
      <div v-for="[k, v] in meta" :key="k">
        <dt>{{ k }}</dt>
        <dd>{{ v }}</dd>
      </div>
    </dl>
  </header>
  <div v-if="isReadOnly" class="db-lockline" role="status" data-dashboard-lockline>
    <span class="db-lock" aria-hidden="true"></span>
    <span>{{ t('dsh.common.readOnlyLine') }}</span>
  </div>
</template>
