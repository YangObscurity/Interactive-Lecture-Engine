<script setup lang="ts">
/** datasheet implementation of the `CanvasNode` slot (v1): DIP package pin, counter-clockwise pin number and horizontal lecture title. */
import type { CanvasNodeProps } from '../../../theme/slots/registry.ts'

defineProps<CanvasNodeProps>()
</script>

<template>
  <g
    class="cv-node n"
    :class="[status, traceRole ? `trace-${traceRole}` : '', { hover, locked, on: active, match }]"
    :data-id="id"
    data-slot="CanvasNode"
  >
    <rect class="pin-hit lec-map-hit" :x="hitX" :y="pinY - 11" :width="hitW" height="22" />
    <rect class="p h" :x="Math.min(pinX, tipX)" :y="pinY - 4.5" :width="legLen" height="9" />
    <rect
      v-if="status === 'reading'"
      class="p-half"
      :x="pinSide > 0 ? pinX : pinX - legLen / 2"
      :y="pinY - 4.5"
      :width="legLen / 2"
      height="9"
    />
    <text class="pn no" data-label-kind="num" :x="pinX + pinSide * 3" :y="pinY - 7" :text-anchor="pinSide < 0 ? 'end' : 'start'">{{ pinNumber }}</text>
    <text class="pname label" data-label-kind="name" :x="nameX" :y="pinY + 4.5" :text-anchor="pinSide < 0 ? 'end' : 'start'">{{ label }}</text>
  </g>
</template>

<style scoped>
.n { cursor: pointer; }
.n:focus-visible { outline: var(--lec-line-heavy, 2px) solid var(--lec-accent); outline-offset: 2px; }
.n:focus-visible .p { stroke: var(--lec-accent); stroke-width: var(--lec-line-heavy, 2px); }
.n:focus-visible .pname { fill: var(--lec-accent); font-weight: 700; }
.pin-hit { fill: transparent; stroke: none; }
.p { fill: var(--lec-bg); stroke: var(--lec-border); stroke-width: 1.5; }
.n.read .p { fill: var(--lec-done); stroke: var(--lec-done); }
.n.reading .p { fill: var(--lec-bg); stroke: var(--lec-done); }
.p-half { fill: var(--lec-done); stroke: none; pointer-events: none; }
.pn { font: 11px var(--lec-font-mono); fill: var(--lec-text-muted); pointer-events: none; }
.pname { font: 13px var(--lec-font-body); fill: var(--lec-text-muted); pointer-events: none; }
.n.read .pname, .n.reading .pname { fill: var(--lec-text); }
.n.on,
.n.locked,
.n.match,
.n.trace-pre,
.n.trace-post {
  opacity: 1 !important;
}
.n.on .p {
  stroke: var(--lec-accent);
  stroke-width: 2.5;
}
.n.on .pname,
.n.on .pn {
  fill: var(--lec-text);
  font-weight: 600;
}
.n.trace-pre .p-half,
.n.trace-post .p-half,
.n.locked .p-half { display: none; }
.n.trace-pre .p {
  fill: var(--lec-accent);
  stroke: var(--lec-accent);
}
.n.trace-pre .pname {
  fill: var(--lec-accent);
}
.n.trace-post .p {
  fill: var(--lec-done);
  stroke: var(--lec-done);
}
.n.trace-post .pname {
  fill: var(--lec-done-text, var(--lec-done));
}
.n.locked .p { fill: var(--lec-accent); stroke: var(--lec-accent); stroke-width: 2.5; }
.n.locked .pname { fill: var(--lec-accent); font-weight: 700; text-decoration: underline; }
.n.match .p { stroke: var(--lec-accent); stroke-width: 3; }
.n.match .pname { fill: var(--lec-accent); font-weight: 700; }
.n.hover .p { stroke: var(--lec-accent); stroke-width: 2.5; }
.n.hover .pname { fill: var(--lec-accent); text-decoration: underline; }
:is(.cv-dim) .n:not(.on) { opacity: 0.28; }
:is(.cv-searching) .n:not(.match) { opacity: 0.3; }
</style>
