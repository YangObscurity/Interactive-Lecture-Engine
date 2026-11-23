<script setup lang="ts">
/** Engine default of the `CanvasNode` slot (v1): rounded lecture block with status dot, two-digit number and clipped title. */
import type { CanvasNodeProps } from '../registry.ts'

defineProps<CanvasNodeProps>()
</script>

<template>
  <g
    class="cv-node n"
    :class="[status, { hover, locked, on: active, match }]"
    :data-id="id"
    data-slot="CanvasNode"
  >
    <rect class="n-box lec-map-hit" :x="x" :y="y" :width="w" :height="h" rx="5" />
    <circle class="dot" :cx="x + 11" :cy="y + h / 2" r="4.5" />
    <path
      v-if="status === 'reading'"
      class="dot-half"
      :d="`M${x + 6.5} ${y + h / 2}A4.5 4.5 0 0 0 ${x + 15.5} ${y + h / 2}Z`"
    />
    <text class="no" data-label-kind="num" :x="x + 22" :y="y + 20">{{ number }}</text>
    <text class="label" data-label-kind="name" :x="x + 44" :y="y + 20">{{ label }}</text>
  </g>
</template>

<style scoped>
.n { cursor: pointer; }
.n:focus-visible { outline: var(--lec-line-heavy, 2px) solid var(--lec-accent); outline-offset: 2px; }
.n:focus-visible .n-box { stroke: var(--lec-accent); stroke-width: var(--lec-line-heavy, 2px); }
.n-box { fill: var(--lec-bg); stroke: var(--lec-border); stroke-width: 1; }
.n.read .n-box { fill: color-mix(in srgb, var(--lec-done) 11%, var(--lec-bg)); stroke: color-mix(in srgb, var(--lec-done) 48%, var(--lec-border)); }
.n.reading .n-box { fill: var(--lec-accent-tint); stroke: var(--lec-accent); stroke-width: 1.5; }
.n.hover .n-box { stroke: var(--lec-accent); stroke-width: 1.5; }
.n.locked .n-box { stroke: var(--lec-accent); stroke-width: 3; }
.n.match .n-box { stroke: var(--lec-accent); stroke-width: 2.5; fill: var(--lec-accent-tint); }
.dot { fill: var(--lec-bg); stroke: var(--lec-border); stroke-width: 1.5; }
.n.read .dot { fill: var(--lec-done); stroke: var(--lec-done); }
.n.reading .dot { fill: var(--lec-bg); stroke: var(--lec-accent); }
.dot-half { fill: var(--lec-accent); pointer-events: none; }
.no { font: 11px var(--lec-font-mono); fill: var(--lec-text-muted); pointer-events: none; }
.label { font: 400 12px var(--lec-font-body); fill: var(--lec-text); pointer-events: none; }
.n.unread .label { fill: var(--lec-text-muted); }
.n.reading .label { font-weight: 600; }
:is(.cv-dim) .n:not(.on) { opacity: 0.28; }
:is(.cv-searching) .n:not(.match) { opacity: 0.3; }
</style>
