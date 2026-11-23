<script setup lang="ts">
/**
 * datasheet implementation of the `AtlasGroup` slot (v1): the group chip of spec board 12 / 13 with its two pads, the id,
 * the title and `DIP-n  read/total` (n = the lecture count made even); a square +/- and, collapsed, the strip of pads.
 */
import DsStrip from './parts/DsStrip.vue'

defineProps<{
  id: string
  side: -1 | 1
  slot: number
  highlight: '' | 'on' | 'hover' | 'pre' | 'post'
  match: boolean
  xi: number
  xo: number
  x0: number
  w: number
  y: number
  ticks: string
  stripFrom: number
  stripCol: number
  tick: number
  tickW: number
  groupId: string
  title: string
  idW: number
  titleW: number
  pkg: string
  progress: string
  progressW: number
  total: number
  read: number
  reading: number
  open: boolean
}>()

function toggleGlyph(cx: number, cy: number, r: number, open: boolean): string {
  const k = r * 0.55
  return `M${cx - k} ${cy}H${cx + k}${open ? '' : `M${cx} ${cy - k}V${cy + k}`}`
}
</script>

<template>
  <g :class="`am-node am-group am-dg${highlight ? (highlight === 'on' ? ' on' : ` on ${highlight}`) : ''}${match ? ' match' : ''}`" :data-g="groupId" data-slot="AtlasGroup">
    <rect class="am-pad" :x="side > 0 ? xi - 7 : xi" :y="y - 2.5" width="7" height="5" />
    <rect class="am-pad" :x="side > 0 ? xo : xo - 6" :y="y - 2.5" width="6" height="5" />
    <rect class="am-chip" :x="x0" :y="y - 20" :width="w" height="40" rx="2" />
    <circle class="chip-dot" :cx="x0 + 7" :cy="y - 13" r="2.2" />
    <text class="am-chip-id" :x="x0 + 15" :y="y - 1">{{ groupId }}</text>
    <text class="am-chip-t" :x="x0 + 15 + idW + 8" :y="y - 1">{{ title }}</text>
    <text class="am-chip-pkg" :x="x0 + 15" :y="y + 14">{{ pkg }}  {{ progress }}</text>
    <g :class="`am-tog am-dtog${open ? '' : ' shut'}`" data-atlas-part="toggle">
      <rect class="tg" :x="xo + side * 11.5 - 5.5" :y="y - 5.5" width="11" height="11" />
      <path class="tg-g" :d="toggleGlyph(xo + side * 11.5, y, 5.5, open)" />
      <circle class="tg-hit" :cx="xo + side * 11.5" :cy="y" r="10.5" />
    </g>
    <DsStrip v-if="!open" :side="side" :cy="y" :from="stripFrom" :col="stripCol" :tick="tick" :tick-w="tickW" :ticks="ticks" />
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
.am-dg { cursor: pointer; }
.am-dg .am-chip { fill: var(--lec-chip); stroke: var(--lec-chip-edge); }
.am-dg:hover .am-chip { stroke: var(--lec-accent); stroke-width: 2.5; }
.am-dg .chip-dot { fill: var(--lec-chip-text); opacity: 0.7; }
.am-dg .am-pad { fill: var(--lec-bg); stroke: var(--lec-text-muted); stroke-width: 1; }
.am-dg .am-chip-id { font: 900 15px var(--lec-font-heading); fill: var(--lec-chip-text); }
.am-dg .am-chip-t { font: 500 12.5px var(--lec-font-body); fill: var(--lec-chip-text); }
.am-dg .am-chip-pkg { font: 10.5px var(--lec-font-mono); fill: var(--lec-chip-text); opacity: 0.72; }
.am-dg.pre .am-chip { stroke: var(--lec-accent); stroke-width: 2.5; }
.am-dg.post .am-chip { stroke: var(--lec-done); stroke-width: 2.5; }
.am-dg.match .am-chip { stroke: var(--lec-accent); stroke-width: 3; }
.am-dim .am-dg:not(.on) { opacity: 0.3; }
.am-searching .am-dg:not(.match):not(.cat-hit) { opacity: 0.35; }
</style>
