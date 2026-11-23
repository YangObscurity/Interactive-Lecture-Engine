<script lang="ts">
/**
 * datasheet implementation of the `AtlasPhase` slot (v1): a port label `PA0-3` in the mono face (spec board 13), a square
 * +/- and, collapsed, the strip of pads.
 */
import { h } from 'vue'
import type { VNode } from 'vue'
import type { AtlasPhaseProps } from '../../../theme/slots/registry.ts'
import DsStrip from './parts/DsStrip.vue'

function toggleGlyph(cx: number, cy: number, r: number, open: boolean): string {
  const k = r * 0.55
  return `M${cx - k} ${cy}H${cx + k}${open ? '' : `M${cx} ${cy - k}V${cy + k}`}`
}

type DirectProps = AtlasPhaseProps & { 'data-node'?: string; 'data-slot'?: string; 'data-slot-impl'?: string }

function AtlasPhase(p: DirectProps): VNode {
  const hl = p.highlight ? (p.highlight === 'on' ? ' on' : ` on ${p.highlight}`) : ''
  const cx = p.xo + p.side * 10.5
  const cy = p.y
  const children: VNode[] = [
    h('rect', { class: 'lec-map-hit', x: p.side > 0 ? p.xi - 6 : p.xo - 4, y: cy - 10, width: p.w + 10, height: 20 }),
    h('text', { class: 'am-port', x: p.xi, y: cy + 4, 'text-anchor': p.side > 0 ? 'start' : 'end', 'data-label-kind': 'meta' }, p.label),
    h('g', { class: `am-tog am-dtog${p.open ? '' : ' shut'}`, 'data-atlas-part': 'toggle' }, [
      h('rect', { class: 'tg', x: cx - 5.5, y: cy - 5.5, width: 11, height: 11 }),
      h('path', { class: 'tg-g', d: toggleGlyph(cx, cy, 5.5, p.open) }),
      h('circle', { class: 'tg-hit', cx, cy, r: 10.5 }),
    ]),
  ]
  if (!p.open) {
    children.push(
      h(DsStrip, { side: p.side, cy, from: p.stripFrom, col: p.stripCol, tick: p.tick, tickW: p.tickW, ticks: p.ticks }),
    )
  }
  return h('g', {
    class: `am-node am-stage am-dp${hl}${p.match ? ' match' : ''}`,
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
.am-dp { cursor: pointer; }
.am-dp .am-port { font: 11.5px var(--lec-font-mono); fill: var(--lec-text-muted); }
.am-dp.pre .am-port { fill: var(--lec-accent); }
.am-dp.post .am-port { fill: var(--lec-done-text); }
.am-dp.match .am-port { fill: var(--lec-accent); font-weight: 700; }
.am-dim .am-dp:not(.on) { opacity: 0.3; }
.am-searching .am-dp:not(.match):not(.cat-hit) { opacity: 0.35; }
</style>
