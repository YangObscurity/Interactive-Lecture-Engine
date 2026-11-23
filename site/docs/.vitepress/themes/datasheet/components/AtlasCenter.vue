<script setup lang="ts">
/**
 * datasheet implementation of the `AtlasCenter` slot (v1): the main chip of spec board 12 / 13, solid body, notch at the
 * top, pin-1 dot, one pad per category on each side where the traces leave.
 */
defineProps<{
  id: string
  x: number
  y: number
  w: number
  h: number
  title: string
  subtitle: string
  read: number
  reading: number
  total: number
  pads: ReadonlyArray<{ side: -1 | 1; y: number }>
}>()
</script>

<template>
  <g class="am-root" data-slot="AtlasCenter">
    <rect v-for="(p, i) in pads" :key="i" class="am-pad" :x="p.side > 0 ? x + w : x - 10" :y="p.y - 2.5" width="10" height="5" />
    <rect class="am-chip" :x="x" :y="y" :width="w" :height="h" rx="3" />
    <path class="am-notch" :d="`M${x + w / 2 - 12} ${y}A12 12 0 0 0 ${x + w / 2 + 12} ${y}Z`" />
    <circle class="chip-dot" :cx="x + 16" :cy="y + 16" r="5" />
    <text class="am-root-chip" :x="x + w / 2" :y="y + h / 2 + 8" text-anchor="middle">{{ title }}</text>
    <text class="am-chip-pkg" :x="x + w / 2" :y="y + h / 2 + 40" text-anchor="middle">{{ subtitle }}</text>
  </g>
</template>

<style scoped>
.am-root { cursor: pointer; }
.am-chip { fill: var(--lec-chip); stroke: var(--lec-chip-edge); }
.am-notch { fill: var(--lec-bg); }
.chip-dot { fill: var(--lec-chip-text); opacity: 0.7; }
.am-pad { fill: var(--lec-bg); stroke: var(--lec-text-muted); stroke-width: 1; }
.am-root-chip { font: 900 28px var(--lec-font-heading); fill: var(--lec-chip-text); }
.am-chip-pkg { font: 10.5px var(--lec-font-mono); fill: var(--lec-chip-text); opacity: 0.72; }
</style>
