<script lang="ts">
/** Engine default of the `AtlasPhase` slot (v1): the label of a stage with a thin underline, a +/- and, collapsed, the status strip. */
import { h } from 'vue'
import type { VNode } from 'vue'
import type { AtlasPhaseProps } from '../registry.ts'
import ReaderStrip from './parts/ReaderStrip.vue'

function toggleGlyph(cx: number, cy: number, r: number, open: boolean): string {
  const k = r * 0.55
  return `M${cx - k} ${cy}H${cx + k}${open ? '' : `M${cx} ${cy - k}V${cy + k}`}`
}

type DirectProps = AtlasPhaseProps & { 'data-node'?: string; 'data-slot'?: string; 'data-slot-impl'?: string }

function AtlasPhase(p: DirectProps): VNode {
  const hl = p.highlight ? (p.highlight === 'on' ? ' on' : ` on ${p.highlight}`) : ''
  const cx = p.xo + p.side * 9
  const cy = p.y + 8
  const children: VNode[] = [
    h('rect', { class: 'lec-map-hit', x: p.x0 - 4, y: p.y - 11, width: p.w + 8, height: 22 }),
    h('text', { class: 'am-st-t', x: p.x0, y: p.y + 4, 'data-label-kind': 'meta' }, p.label),
    h('path', { class: `am-ul am-c${p.slot}`, d: `M${p.xi} ${cy}H${p.xo}` }),
    h('g', { class: `am-tog am-rtog am-c${p.slot}${p.open ? '' : ' shut'}`, 'data-atlas-part': 'toggle' }, [
      h('circle', { class: 'tg', cx, cy, r: 5.5 }),
      h('path', { class: 'tg-g', d: toggleGlyph(cx, cy, 5.5, p.open) }),
      h('circle', { class: 'tg-hit', cx, cy, r: 10.5 }),
    ]),
  ]
  if (!p.open) {
    children.push(
      h(ReaderStrip, { side: p.side, cy, from: p.stripFrom, col: p.stripCol, tick: p.tick, tickW: p.tickW, ticks: p.ticks, cat: p.slot }),
    )
  }
  return h('g', {
    class: `am-node am-stage am-rp${hl}${p.match ? ' match' : ''}`,
    'data-st': p.id,
    'data-node': p['data-node'],
    'data-slot': p['data-slot'] ?? 'AtlasPhase',
    'data-slot-impl': p['data-slot-impl'],
  }, children)
}
AtlasPhase.props = ['id', 'side', 'slot', 'highlight', 'match', 'xi', 'xo', 'x0', 'w', 'y', 'ticks', 'stripFrom', 'stripCol', 'tick', 'tickW', 'label', 'labelW', 'total', 'read', 'reading', 'open']
export default AtlasPhase
</script>

<style>
.am-rp { cursor: pointer; }
.am-rp .am-st-t { font: 500 12.5px var(--lec-font-body); fill: var(--lec-text-muted); }
.am-rp .am-ul { fill: none; stroke-linecap: round; stroke-width: 1.1; stroke-opacity: 0.6; }
.am-rp .am-c1 { stroke: var(--lec-cat-1); }
.am-rp .am-c2 { stroke: var(--lec-cat-2); }
.am-rp .am-c3 { stroke: var(--lec-cat-3); }
.am-rp .am-c4 { stroke: var(--lec-cat-4); }
.am-rp .am-c5 { stroke: var(--lec-cat-5); }
.am-rp .am-c6 { stroke: var(--lec-cat-6); }
.am-rp .am-c7 { stroke: var(--lec-cat-7); }
.am-rp .am-c8 { stroke: var(--lec-cat-8); }
.am-rp.pre .am-st-t { fill: var(--lec-accent); }
.am-rp.post .am-st-t { fill: var(--lec-done-text); }
.am-rp.match .am-st-t { fill: var(--lec-accent); font-weight: 700; }
.am-dim .am-rp:not(.on) { opacity: 0.3; }
.am-searching .am-rp:not(.match):not(.cat-hit) { opacity: 0.35; }
</style>
