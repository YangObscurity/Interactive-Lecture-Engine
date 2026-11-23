<script setup lang="ts">
/** datasheet implementation of the `CanvasGroup` slot (v1): solid DIP / SOIC package unit(s), bus pads, NC pins and intra-group unit buses. */
import type { CanvasGroupProps } from '../../../theme/slots/registry.ts'

defineProps<CanvasGroupProps>()
</script>

<template>
  <g class="cv-group g-hit" :class="{ on: active }" :data-g="id" data-slot="CanvasGroup">
    <path v-for="(ub, i) in unitBuses" :key="`ub${i}`" class="trace-pcb" :d="ub.d" :style="{ '--w': ub.weight }" />
    <template v-for="u in units" :key="u.uid">
      <text v-if="u.showCatTag" class="cat-tag" data-label-kind="always" :x="u.x - 26" :y="u.y + 6" text-anchor="end" :style="{ fill: `var(--lec-cat-${cat})` }">{{ catName }}</text>
      <rect v-for="(pt, pi) in u.ports" :key="`p${pi}`" class="bus-pin" :x="pt.x - 4" :y="pt.out ? u.y + u.h : pt.y" width="8" height="16" />
      <g v-for="(nc, ni) in u.ncPins" :key="`nc${ni}`" class="nc">
        <rect class="p" :x="Math.min(nc.x, nc.tipX)" :y="nc.y - 4.5" width="18" height="9" />
        <text class="pn" data-label-kind="nc" :x="nc.x + nc.side * 3" :y="nc.y - 7" :text-anchor="nc.side < 0 ? 'end' : 'start'">NC</text>
      </g>
      <rect class="chip lec-map-hit" :x="u.x" :y="u.y" :width="u.w" :height="u.h" rx="4" />
      <circle class="chip-dot" :cx="u.x + 16" :cy="u.y + 16" r="5" />
      <text class="chip-lbl chip-id" data-label-kind="always" :x="u.x + u.w / 2" :y="u.y + u.h / 2 - 6" text-anchor="middle">{{ id + u.part }}</text>
      <text class="chip-lbl chip-name" data-label-kind="always" :x="u.x + u.w / 2" :y="u.y + u.h / 2 + 20" text-anchor="middle">{{ title }}</text>
      <text class="chip-lbl chip-pkg" data-label-kind="mid" :x="u.x + u.w / 2" :y="u.y + u.h - 16" text-anchor="middle">{{ u.pkg }}{{ u.of > 1 ? `  ${u.part}/${u.of}` : '' }}  {{ progress }}</text>
    </template>
  </g>
</template>

<style scoped>
.g-hit { cursor: pointer; }
.chip { fill: var(--lec-chip); stroke: var(--lec-chip-edge); stroke-width: 1; }
.g-hit:hover .chip { stroke: var(--lec-accent); stroke-width: 3; }
.chip-dot { fill: var(--lec-chip-text); opacity: 0.7; pointer-events: none; }
.chip-lbl { fill: var(--lec-chip-text); pointer-events: none; }
.chip-id { font: 900 40px var(--lec-font-heading); letter-spacing: 0.02em; }
.chip-name { font: 500 16px var(--lec-font-body); }
.chip-pkg { font: 13px var(--lec-font-mono); opacity: 0.7; }
.cat-tag { font: 700 14px var(--lec-font-heading); pointer-events: none; }
.bus-pin { fill: var(--lec-bg); stroke: var(--lec-cat-4); stroke-width: 1.5; }
.trace-pcb { fill: none; stroke: var(--lec-cat-4); stroke-linejoin: round; stroke-width: calc(var(--w, 1) * 1px / var(--k, 1)); opacity: 0.6; }
.nc .p { fill: none; stroke: var(--lec-border); stroke-width: 1; stroke-dasharray: 3 3; }
.nc .pn { font: 11px var(--lec-font-mono); fill: var(--lec-text-muted); opacity: 0.7; pointer-events: none; }
:is(.cv-dim) .g-hit:not(.on) { opacity: 0.28; }
:is(.cv-dim) .nc { opacity: 0.4; }
:is(.cv-dim) .trace-pcb { opacity: 0.12; }
</style>
