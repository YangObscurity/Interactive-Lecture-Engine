<script setup lang="ts">
/** Engine default of the `AtlasCenter` slot (v1): the box in the middle, site name and totals. */
import type { AtlasCenterProps } from '../registry.ts'

defineProps<AtlasCenterProps>()
</script>

<template>
  <g class="am-root" data-slot="AtlasCenter">
    <rect class="am-root-box" :x="x" :y="y" :width="w" :height="h" rx="16" />
    <text class="am-root-t" :x="x + w / 2" :y="y + h / 2 + 2" text-anchor="middle">{{ title }}</text>
    <text class="am-root-s" :x="x + w / 2" :y="y + h / 2 + 28" text-anchor="middle">{{ subtitle }}</text>
  </g>
</template>

<style scoped>
.am-root { cursor: pointer; }
.am-root-box { fill: var(--lec-surface); stroke: var(--lec-border); stroke-width: 1.5; }
.am-root-t { font: 800 24px var(--lec-font-heading); fill: var(--lec-text); }
.am-root-s { font: 12px var(--lec-font-mono); fill: var(--lec-text-muted); }
</style>
