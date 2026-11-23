<script setup lang="ts">
/** The enlarge icon of a figure (hover only; the styles are `figure.chart .chart-enlarge` in styles/base.css). The click is handled by charts/toolbar.ts (`data-act`). */
defineProps<{ title: string }>()
</script>

<template>
  <button type="button" class="chart-enlarge" data-act="expand" :title="title" :aria-label="title">
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5l-4.5 4.5M6.5 13.5h-4v-4M2.5 13.5L7 9" />
    </svg>
  </button>
</template>
