<script setup lang="ts">
/** Engine default of the `CanvasEdge` slot (v1): rounded intra-group edges, purple group bundles, and interactive trace links. */
import type { CanvasEdgeProps } from '../registry.ts'

defineProps<CanvasEdgeProps>()
</script>

<template>
  <path
    v-if="kind === 'intra'"
    class="ie"
    :d="d"
    :transform="`translate(${tx} ${ty})`"
    marker-end="url(#cv-ah)"
    data-slot="CanvasEdge"
  />
  <g
    v-else-if="kind === 'bundle'"
    class="bundle-g"
    :class="{ on: active, hot }"
    :data-pair="pairKey"
    data-slot="CanvasEdge"
  >
    <path class="bundle" :d="d" :style="{ '--w': weight }" marker-end="url(#cv-ah-b)" />
    <path class="hitline" :d="d" />
  </g>
  <g
    v-else
    class="lk"
    :class="[kind === 'trace-pre' ? 'pre' : 'post', { hot }]"
    data-slot="CanvasEdge"
  >
    <path class="hl" :d="d" :marker-end="kind === 'trace-pre' ? 'url(#cv-ah-pre)' : 'url(#cv-ah-post)'" />
    <path class="hitline" :d="d" />
  </g>
</template>

<style scoped>
.ie { fill: none; stroke: var(--lec-text-muted); stroke-opacity: 0.55; stroke-width: 1.2; }
.ie:hover { stroke: var(--lec-accent); stroke-width: 2; stroke-opacity: 1; }
.bundle-g { cursor: pointer; }
.bundle { fill: none; stroke: var(--lec-cat-4); stroke-opacity: 0.32; stroke-linecap: round; stroke-width: calc(var(--w, 1) * 1px / var(--k, 1)); }
.bundle-g.hot .bundle, .bundle-g.on .bundle { stroke-opacity: 0.9; }
.hitline { fill: none; stroke: transparent; stroke-width: calc(16px / var(--k, 1)); pointer-events: stroke; cursor: pointer; }
.lk .hl { fill: none; stroke-width: calc(2.5px / var(--k, 1)); }
.lk.pre .hl { stroke: var(--lec-accent); }
.lk.post .hl { stroke: var(--lec-done); stroke-dasharray: calc(7px / var(--k, 1)) calc(5px / var(--k, 1)); }
.lk.hot .hl { stroke-width: calc(5px / var(--k, 1)); }
:is(.cv-dim) .ie, :is(.cv-dim) .bundle { opacity: 0.12; }
:is(.cv-dim) .bundle-g.on .bundle { opacity: 1; }
</style>
