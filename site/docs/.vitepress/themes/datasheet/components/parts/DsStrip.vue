<script setup lang="ts">
/**
 * datasheet atlas part: the status strip of a collapsed group or port, a row of pads, one per lecture, on a trace.
 * Read = solid, reading = half filled from the bottom, unread = hollow. The engine handles the click through
 * `data-atlas-part="strip"` (it opens the branch).
 */
const props = defineProps<{ side: -1 | 1; cy: number; from: number; col: number; tick: number; tickW: number; ticks: string }>()
function stripMarks() {
  const marks: Array<{ status: string; x: number }> = []
  for (let i = 0; i < props.ticks.length; i++) {
    const c = props.ticks[i]
    const status = c === 'r' ? 'read' : c === 'g' ? 'reading' : 'unread'
    const x = props.side > 0 ? props.col + i * props.tick : props.col - i * props.tick - props.tickW
    marks.push({ status, x })
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
  <g class="am-strip am-dstrip" data-atlas-part="strip">
    <path class="am-link am-trace am-l-comb" :d="`M${from} ${cy}H${col}`" />
    <template v-for="(m, i) in stripMarks()" :key="i">
      <rect class="pd" :class="m.status" :x="m.x" :y="cy - 5" :width="tickW" height="10" />
      <rect v-if="m.status === 'reading'" class="pd-half" :x="m.x" :y="cy" :width="tickW" height="5" />
    </template>
    <rect class="lec-map-hit" :x="hitLeft()" :y="cy - 12" :width="hitWidth()" height="24" />
  </g>
</template>

<style>
.am-dstrip .am-link { fill: none; }
.am-dstrip .am-trace { stroke: var(--lec-text-muted); stroke-opacity: 0.5; stroke-width: 1.1; stroke-linecap: butt; stroke-linejoin: miter; }
.am-dstrip .pd { stroke-width: 1; }
.am-dstrip .pd.read { fill: var(--lec-done); stroke: var(--lec-done); }
.am-dstrip .pd.reading { fill: var(--lec-bg); stroke: var(--lec-done); }
.am-dstrip .pd-half { fill: var(--lec-done); stroke: none; }
.am-dstrip .pd.unread { fill: var(--lec-bg); stroke: var(--lec-text-muted); stroke-opacity: 0.75; }
</style>
