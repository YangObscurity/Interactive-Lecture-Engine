<script setup lang="ts">
/**
 * Reader atlas part: the round +/- button of a group or phase (spec: prototype v16 `toggleBtn`). The engine handles the
 * click through `data-atlas-part="toggle"`. Open = outline with a minus, shut = filled with a plus, in the category colour.
 */
defineProps<{ cx: number; cy: number; r: number; open: boolean; cat: number }>()
function glyphD(cx: number, cy: number, r: number, open: boolean): string {
  const k = r * 0.55
  return `M${cx - k} ${cy}H${cx + k}${open ? '' : `M${cx} ${cy - k}V${cy + k}`}`
}
</script>

<template>
  <g class="am-tog am-rtog" :class="[`am-c${cat}`, { shut: !open }]" data-atlas-part="toggle">
    <circle class="tg" :cx="cx" :cy="cy" :r="r" />
    <path class="tg-g" :d="glyphD(cx, cy, r, open)" />
    <circle class="tg-hit" :cx="cx" :cy="cy" :r="r + 5" />
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
</style>
