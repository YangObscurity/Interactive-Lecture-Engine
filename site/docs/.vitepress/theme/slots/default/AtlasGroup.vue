<script setup lang="ts">
/** Engine default of the `AtlasGroup` slot (v1): id, title and read count over a coloured underline, a round +/- and, collapsed, the status strip. */
import type { AtlasGroupProps } from '../registry.ts'
import ReaderStrip from './parts/ReaderStrip.vue'

defineProps<AtlasGroupProps>()
function toggleGlyph(cx: number, cy: number, r: number, open: boolean): string {
  const k = r * 0.55
  return `M${cx - k} ${cy}H${cx + k}${open ? '' : `M${cx} ${cy - k}V${cy + k}`}`
}
</script>

<template>
  <g :class="`am-node am-group am-rg${highlight ? (highlight === 'on' ? ' on' : ` on ${highlight}`) : ''}${match ? ' match' : ''}`" :data-g="groupId" data-slot="AtlasGroup">
    <rect class="lec-map-hit" :x="x0 - 4" :y="y - 14" :width="w + 8" height="28" />
    <text class="am-g-id" :x="x0" :y="y + 5">{{ groupId }}</text>
    <text class="am-g-t" :x="x0 + idW + 8" :y="y + 5">{{ title }}</text>
    <text class="am-g-p" :x="x0 + idW + 8 + titleW + 10" :y="y + 5">{{ progress }}</text>
    <path :class="`am-ul am-c${slot}`" :d="`M${xi} ${y + 10}H${xo}`" />
    <g :class="`am-tog am-rtog am-c${slot}${open ? '' : ' shut'}`" data-atlas-part="toggle">
      <circle class="tg" :cx="xo + side * 11" :cy="y + 10" r="6.5" />
      <path class="tg-g" :d="toggleGlyph(xo + side * 11, y + 10, 6.5, open)" />
      <circle class="tg-hit" :cx="xo + side * 11" :cy="y + 10" r="11.5" />
    </g>
    <ReaderStrip v-if="!open" :side="side" :cy="y + 10" :from="stripFrom" :col="stripCol" :tick="tick" :tick-w="tickW" :ticks="ticks" :cat="slot" />
  </g>
</template>

<style>
.am-rtog { cursor: pointer; }
.am-rtog .tg { fill: var(--lec-bg); stroke-width: 1.5; }
.am-rtog .tg-g { fill: none; stroke: var(--lec-bg); stroke-width: 1.6; stroke-linecap: round; }
.am-rtog.am-c1 .tg, .am-rtog.am-c1:not(.shut) .tg-g { stroke: var(--lec-cat-1); }
.am-rtog.am-c1.shut .tg { fill: var(--lec-cat-1); }
.am-rtog.am-c2 .tg, .am-rtog.am-c2:not(.shut) .tg-g { stroke: var(--lec-cat-2); }
.am-rtog.am-c2.shut .tg { fill: var(--lec-cat-2); }
.am-rtog.am-c3 .tg, .am-rtog.am-c3:not(.shut) .tg-g { stroke: var(--lec-cat-3); }
.am-rtog.am-c3.shut .tg { fill: var(--lec-cat-3); }
.am-rtog.am-c4 .tg, .am-rtog.am-c4:not(.shut) .tg-g { stroke: var(--lec-cat-4); }
.am-rtog.am-c4.shut .tg { fill: var(--lec-cat-4); }
.am-rtog.am-c5 .tg, .am-rtog.am-c5:not(.shut) .tg-g { stroke: var(--lec-cat-5); }
.am-rtog.am-c5.shut .tg { fill: var(--lec-cat-5); }
.am-rtog.am-c6 .tg, .am-rtog.am-c6:not(.shut) .tg-g { stroke: var(--lec-cat-6); }
.am-rtog.am-c6.shut .tg { fill: var(--lec-cat-6); }
.am-rtog.am-c7 .tg, .am-rtog.am-c7:not(.shut) .tg-g { stroke: var(--lec-cat-7); }
.am-rtog.am-c7.shut .tg { fill: var(--lec-cat-7); }
.am-rtog.am-c8 .tg, .am-rtog.am-c8:not(.shut) .tg-g { stroke: var(--lec-cat-8); }
.am-rtog.am-c8.shut .tg { fill: var(--lec-cat-8); }
.am-rtog:hover .tg { stroke-width: 2.6; }
.am-rtog .tg-hit { fill: transparent; stroke: none; }
.am-rg { cursor: pointer; }
.am-rg .am-g-id { font: 800 15px var(--lec-font-heading); fill: var(--lec-text); }
.am-rg .am-g-t { font: 500 14px var(--lec-font-body); fill: var(--lec-text); }
.am-rg .am-g-p { font: 11.5px var(--lec-font-mono); fill: var(--lec-text-muted); }
.am-rg .am-ul { fill: none; stroke-linecap: round; stroke-width: 1.8; }
.am-rg .am-c1 { stroke: var(--lec-cat-1); }
.am-rg .am-c2 { stroke: var(--lec-cat-2); }
.am-rg .am-c3 { stroke: var(--lec-cat-3); }
.am-rg .am-c4 { stroke: var(--lec-cat-4); }
.am-rg .am-c5 { stroke: var(--lec-cat-5); }
.am-rg .am-c6 { stroke: var(--lec-cat-6); }
.am-rg .am-c7 { stroke: var(--lec-cat-7); }
.am-rg .am-c8 { stroke: var(--lec-cat-8); }
.am-rg.pre .am-g-t { fill: var(--lec-accent); }
.am-rg.post .am-g-t { fill: var(--lec-done-text); }
.am-rg.match .am-g-t { fill: var(--lec-accent); font-weight: 700; }
.am-dim .am-rg:not(.on) { opacity: 0.3; }
.am-searching .am-rg:not(.match):not(.cat-hit) { opacity: 0.35; }
</style>
