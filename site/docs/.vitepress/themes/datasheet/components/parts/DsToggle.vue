<script setup lang="ts">
/**
 * datasheet atlas part: the square +/- button of a group chip or a port label. Open = bare square with a minus, shut = chip
 * colour with a plus. The engine handles the click through `data-atlas-part="toggle"`.
 */
defineProps<{ cx: number; cy: number; r: number; open: boolean }>()
function glyphD(cx: number, cy: number, r: number, open: boolean): string {
  const k = r * 0.55
  return `M${cx - k} ${cy}H${cx + k}${open ? '' : `M${cx} ${cy - k}V${cy + k}`}`
}
</script>

<template>
  <g class="am-tog am-dtog" :class="{ shut: !open }" data-atlas-part="toggle">
    <rect class="tg" :x="cx - r" :y="cy - r" :width="2 * r" :height="2 * r" />
    <path class="tg-g" :d="glyphD(cx, cy, r, open)" />
    <circle class="tg-hit" :cx="cx" :cy="cy" :r="r + 5" />
  </g>
</template>

<style>
.am-dtog { cursor: pointer; }
.am-dtog .tg { fill: var(--lec-bg); stroke: var(--lec-text-muted); stroke-width: 1.2; }
.am-dtog .tg-g { fill: none; stroke: var(--lec-text-muted); stroke-width: 1.6; stroke-linecap: round; }
.am-dtog.shut .tg { fill: var(--lec-chip); stroke: var(--lec-chip-edge); }
.am-dtog.shut .tg-g { stroke: var(--lec-chip-text); }
.am-dtog:hover .tg { stroke: var(--lec-accent); stroke-width: 2; }
.am-dtog .tg-hit { fill: transparent; stroke: none; }
</style>
