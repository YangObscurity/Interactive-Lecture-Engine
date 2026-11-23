<script setup lang="ts">
/** datasheet implementation of the `CanvasBackdrop` slot (v1): category zone boxes and titles for `zones` layout. */
import type { CanvasBackdropProps } from '../../../theme/slots/registry.ts'

defineProps<CanvasBackdropProps>()
</script>

<template>
  <g class="cv-backdrop" data-slot="CanvasBackdrop">
    <g v-for="z in zones" :key="z.cat" class="cv-zone">
      <rect class="zone-box" :x="z.x + 0.5" :y="z.y + 0.5" :width="z.w" :height="z.h" rx="2" />
      <text class="zone-name" data-label-kind="always" :x="z.x + 16" :y="z.y + 30" :style="{ fill: `var(--lec-cat-${z.cat})` }">{{ z.name }}</text>
    </g>
  </g>
</template>

<style scoped>
.zone-box { fill: none; stroke: var(--lec-border); stroke-width: 1.5; }
.zone-name { font: 700 22px var(--lec-font-heading); }
:is(.cv-dim) .zone-box { opacity: 0.4; }
</style>
