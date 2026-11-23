<script setup lang="ts">
/** Engine default of the `AtlasCategory` slot (v1): the category name with a coloured underline. */
import type { AtlasCategoryProps } from '../registry.ts'

defineProps<AtlasCategoryProps>()
</script>

<template>
  <g class="am-node cat-hit" :class="{ on: highlight !== '', hover: highlight === 'hover', match }" :data-cat="slot" data-slot="AtlasCategory">
    <rect class="lec-map-hit" :x="x0 - 4" :y="y - 14" :width="w + 8" height="30" />
    <text class="am-cat-t" :x="x0" :y="y + 5" :style="{ fill: `var(--lec-cat-${slot})` }">{{ label }}</text>
    <path class="am-ul" :d="`M${xi} ${y + 10}H${xo}`" :style="{ stroke: `var(--lec-cat-${slot})` }" />
  </g>
</template>

<style scoped>
.am-node { cursor: pointer; }
.am-cat-t { font: 800 17px var(--lec-font-heading); }
.am-ul { fill: none; stroke-linecap: round; stroke-width: 2.6; }
.am-dim .am-node:not(.on) { opacity: 0.3; }
.am-searching .am-node:not(.match):not(.cat-hit) { opacity: 0.35; }
</style>
