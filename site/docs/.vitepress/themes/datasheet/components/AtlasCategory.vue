<script setup lang="ts">
/**
 * datasheet implementation of the `AtlasCategory` slot (v1): a zone box (spec board 13) with the category name in its colour
 * and a caption on the top edge; the trunk of the centre's traces enters at the inner side with the lecture count.
 */
import { computed } from 'vue'

const props = defineProps<{
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
  label: string
  labelW: number
  groups: number
  total: number
  read: number
  innerX: number
  outerX: number
  zoneTop: number
  zoneH: number
  caption: string
  captionW: number
  trunk: string
}>()
const zone = computed(() => ({ x: Math.min(props.innerX, props.outerX), w: Math.abs(props.outerX - props.innerX) }))
const nameX = computed(() => (props.side > 0 ? props.innerX : props.innerX - props.captionW - 10 - props.labelW))
const ty = computed(() => props.zoneTop - 9)
</script>

<template>
  <g class="am-node cat-hit" :class="{ on: highlight !== '', hover: highlight === 'hover', match }" :data-cat="slot" data-slot="AtlasCategory">
    <rect class="zone-box" :x="zone.x" :y="zoneTop" :width="zone.w" :height="zoneH" />
    <text class="am-zone-t" :x="nameX" :y="ty" :style="{ fill: `var(--lec-cat-${slot})` }">{{ label }}</text>
    <text class="am-zone-c" :x="nameX + labelW + 10" :y="ty">{{ caption }}</text>
    <rect class="lec-map-hit" :x="nameX - 4" :y="zoneTop - 27" :width="labelW + captionW + 18" height="24" />
    <text class="am-trunk-c" :x="innerX - side * 6" :y="y - 6" :text-anchor="side > 0 ? 'end' : 'start'">{{ trunk }}</text>
  </g>
</template>

<style scoped>
.am-node { cursor: pointer; }
.zone-box { fill: none; stroke: var(--lec-border); stroke-width: 1.5; pointer-events: none; }
.am-zone-t { font: 700 15px var(--lec-font-heading); }
.am-zone-c, .am-trunk-c { font: 11px var(--lec-font-mono); fill: var(--lec-text-muted); }
.am-dim .zone-box { opacity: 0.45; }
</style>
