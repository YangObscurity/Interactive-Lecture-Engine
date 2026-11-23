<script setup lang="ts">
/** datasheet implementation of the `CanvasEdge` slot (v1): inter-unit PCB orthogonal buses (with tags shown only when active) and dashed orthogonal trace links. */
import type { CanvasEdgeProps } from '../../../theme/slots/registry.ts'

defineProps<CanvasEdgeProps>()
</script>

<template>
  <g v-if="kind === 'intra'" class="cv-empty" data-slot="CanvasEdge" />
  <g
    v-else-if="kind === 'bundle'"
    class="bundle-g"
    :class="{ on: active, hot }"
    :data-pair="pairKey"
    data-slot="CanvasEdge"
  >
    <template v-for="(s, i) in segments" :key="`s${i}`">
      <path class="trace-pcb" :d="s.d" :style="{ '--w': s.weight }" />
      <text
        v-for="(tg, ti) in s.tags"
        :key="`t${ti}`"
        class="ann ann-tag"
        data-label-kind="ann"
        :x="tg.x"
        :y="tg.y"
        >{{ tg.text }}</text
      >
    </template>
    <path class="hitline" :d="d" />
  </g>
  <g
    v-else
    class="lk ds-lk"
    :class="[kind === 'trace-pre' ? 'pre' : 'post', { hot }]"
    data-slot="CanvasEdge"
  >
    <path class="hl" :d="d" :marker-end="kind === 'trace-pre' ? 'url(#cv-ah-pre)' : 'url(#cv-ah-post)'" />
    <path class="hitline" :d="d" />
  </g>
</template>

<style scoped>
.bundle-g { cursor: pointer; }
.trace-pcb { fill: none; stroke: var(--lec-cat-4); stroke-linejoin: round; stroke-width: calc(var(--w, 1) * 1px / var(--k, 1)); opacity: 0.6; }
.bundle-g.hot .trace-pcb, .bundle-g.on .trace-pcb { opacity: 1; stroke-width: calc(2.5px / var(--k, 1)); }
.ann { display: none; font: 600 12.5px var(--lec-font-body); fill: var(--lec-cat-4); paint-order: stroke; stroke: var(--lec-bg); stroke-width: 5px; }
.bundle-g.on .ann { display: block; }
.hitline { fill: none; stroke: transparent; stroke-width: calc(16px / var(--k, 1)); pointer-events: stroke; cursor: pointer; }
.lk .hl { fill: none; stroke-width: calc(2.5px / var(--k, 1)); stroke-linejoin: round; }
.lk.pre .hl { stroke: var(--lec-accent); stroke-dasharray: calc(6px / var(--k, 1)) calc(4px / var(--k, 1)); }
.lk.post .hl { stroke: var(--lec-done); stroke-dasharray: calc(2px / var(--k, 1)) calc(4px / var(--k, 1)); }
.lk.hot .hl { stroke-width: calc(5px / var(--k, 1)); }
:is(.cv-dim) .trace-pcb, :is(.cv-dim) .ann { opacity: 0.12; }
:is(.cv-dim) .bundle-g.on .trace-pcb, :is(.cv-dim) .bundle-g.on .ann { opacity: 1; }
</style>
