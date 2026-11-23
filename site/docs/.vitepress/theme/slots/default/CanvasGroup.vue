<script setup lang="ts">
/** Engine default of the `CanvasGroup` slot (v1): rounded course block with left category bar, title and progress. */
import type { CanvasGroupProps } from '../registry.ts'

defineProps<CanvasGroupProps>()
</script>

<template>
  <g class="cv-group g-hit" :class="{ on: active }" :data-g="id" data-slot="CanvasGroup">
    <rect class="g-box lec-map-hit" :x="x" :y="y" :width="w" :height="h" rx="10" />
    <rect class="g-bar" :x="x" :y="y" width="6" :height="h" rx="3" :style="{ fill: `var(--lec-cat-${cat})` }" />
    <text class="g-title" data-label-kind="mid" :x="x + 20" :y="y + 30">{{ title }}</text>
    <text class="g-meta" data-label-kind="mid" :x="x + w - 16" :y="y + 30" text-anchor="end">{{ progress }}</text>
  </g>
</template>

<style scoped>
.g-hit { cursor: pointer; }
.g-box { fill: var(--lec-bg); stroke: var(--lec-border); stroke-width: 1; }
.g-hit:hover .g-box { stroke: var(--lec-accent); }
.g-bar { stroke: none; }
.g-title { font: 700 17px var(--lec-font-heading); fill: var(--lec-text); }
.g-meta { font: 12px var(--lec-font-mono); fill: var(--lec-text-muted); }
:is(.cv-dim) .g-hit:not(.on) { opacity: 0.28; }
</style>
