<script setup lang="ts">
/**
 * Reader atlas part: the status strip of a collapsed group or phase, one mark per lecture in a column shared by all rows
 * of the depth. Three heights tell the status without colour (spec board 13.1): read tall, reading middle, unread short.
 * The engine handles the click through `data-atlas-part="strip"` (it opens the branch).
 */
const props = defineProps<{ side: -1 | 1; cy: number; from: number; col: number; tick: number; tickW: number; ticks: string; cat: number }>()
function stripMarks() {
  const marks: Array<{ status: string; h: number; x: number }> = []
  for (let i = 0; i < props.ticks.length; i++) {
    const c = props.ticks[i]
    const status = c === 'r' ? 'read' : c === 'g' ? 'reading' : 'unread'
    const h = status === 'read' ? 11 : status === 'reading' ? 7 : 4
    const x = props.side > 0 ? props.col + i * props.tick : props.col - i * props.tick - props.tickW
    marks.push({ status, h, x })
  }
  return marks
}
function stripEnd(): number {
  const n = Math.max(0, props.ticks.length - 1)
  return props.side > 0 ? props.col + n * props.tick + props.tickW : props.col - n * props.tick - props.tickW
}
function hitLeft(): number {
  return Math.min(props.from, stripEnd()) - (props.side < 0 ? 4 : 0)
}
function hitWidth(): number {
  return Math.max(props.from, stripEnd()) + (props.side > 0 ? 4 : 0) - hitLeft()
}
</script>

<template>
  <g class="am-strip am-rstrip" data-atlas-part="strip">
    <path class="am-link am-l-comb" :class="`am-c${cat}`" :d="`M${from} ${cy}H${stripEnd()}`" />
    <rect v-for="(m, i) in stripMarks()" :key="i" class="tk" :class="m.status" :x="m.x" :y="cy - m.h" :width="tickW" :height="m.h" />
    <rect class="lec-map-hit" :x="hitLeft()" :y="cy - 12" :width="hitWidth()" height="24" />
  </g>
</template>

<style>
.am-rstrip .am-link { fill: none; stroke-linecap: round; stroke-width: 1; stroke-opacity: 0.35; }
.am-rstrip .am-c1 { stroke: var(--lec-cat-1); }
.am-rstrip .am-c2 { stroke: var(--lec-cat-2); }
.am-rstrip .am-c3 { stroke: var(--lec-cat-3); }
.am-rstrip .am-c4 { stroke: var(--lec-cat-4); }
.am-rstrip .am-c5 { stroke: var(--lec-cat-5); }
.am-rstrip .am-c6 { stroke: var(--lec-cat-6); }
.am-rstrip .am-c7 { stroke: var(--lec-cat-7); }
.am-rstrip .am-c8 { stroke: var(--lec-cat-8); }
.am-rstrip .tk { stroke: none; }
.am-rstrip .tk.read { fill: var(--lec-done); }
.am-rstrip .tk.reading { fill: var(--lec-accent); }
.am-rstrip .tk.unread { fill: var(--lec-text-muted); fill-opacity: 0.5; }
</style>
