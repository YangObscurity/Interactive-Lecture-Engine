<script lang="ts">
/**
 * datasheet implementation of the `AtlasLecture` slot (v1): a horizontal pin (spec board 12 / 13) with the number and the
 * name. Read = solid, reading = half filled (the half nearer the chip), unread = hollow.
 */
import { h } from 'vue'
import type { VNode } from 'vue'
import type { AtlasLectureProps } from '../../../theme/slots/registry.ts'

type DirectProps = AtlasLectureProps & { 'data-node'?: string; 'data-slot'?: string; 'data-slot-impl'?: string }

function AtlasLecture(p: DirectProps): VNode {
  const anchor = p.side > 0 ? 'start' : 'end'
  const hl = p.highlight ? (p.highlight === 'on' ? ' on' : ` on ${p.highlight}`) : ''
  const children: VNode[] = [
    h('rect', { class: 'lec-map-hit', x: p.x0 - 3, y: p.y - 9.5, width: p.w + 6, height: 19 }),
    h('rect', { class: 'p', x: p.side > 0 ? p.xi : p.xi - 16, y: p.y - 3, width: 16, height: 6 }),
  ]
  if (p.status === 'reading') {
    children.push(h('rect', { class: 'p-half', x: p.side > 0 ? p.xi : p.xi - 8, y: p.y - 3, width: 8, height: 6 }))
  }
  children.push(
    h('text', { class: 'no', x: p.xi + p.side * 22, y: p.y + 4, 'text-anchor': anchor, 'data-label-kind': 'num' }, p.number),
    h('text', { class: 'pname', x: p.labelX, y: p.y + 4.5, 'text-anchor': anchor, 'data-label-kind': 'name' }, p.label),
  )
  return h('g', {
    class: `am-node am-lec am-dl ${p.status}${hl}${p.match ? ' match' : ''}`,
    'data-node': p['data-node'],
    'data-slot': p['data-slot'] ?? 'AtlasLecture',
    'data-slot-impl': p['data-slot-impl'],
  }, children)
}
AtlasLecture.props = ['id', 'side', 'slot', 'highlight', 'match', 'xi', 'xo', 'x0', 'w', 'y', 'number', 'label', 'title', 'labelX', 'labelW', 'status']
export default AtlasLecture
</script>

<style>
.am-dl { cursor: pointer; }
.am-dl .p { fill: var(--lec-bg); stroke: var(--lec-border); stroke-width: 1; }
.am-dl.read .p { fill: var(--lec-done); stroke: var(--lec-done); }
.am-dl.reading .p { stroke: var(--lec-done); }
.am-dl .p-half { fill: var(--lec-done); stroke: none; }
.am-dl .no { font: 11px var(--lec-font-mono); fill: var(--lec-text-muted); }
.am-dl .pname { font: 12.5px var(--lec-font-body); fill: var(--lec-text-muted); }
.am-dl.read .pname, .am-dl.reading .pname { fill: var(--lec-text); }
.am-dl.hover .pname { fill: var(--lec-accent); font-weight: 700; }
.am-dl.pre .pname { fill: var(--lec-accent); }
.am-dl.post .pname { fill: var(--lec-done-text); }
.am-dl.pre .p { stroke: var(--lec-accent); stroke-width: 2.5; }
.am-dl.post .p { stroke: var(--lec-done); stroke-width: 2.5; }
.am-dl.match .p { stroke: var(--lec-accent); stroke-width: 3; }
.am-dl.match .pname { fill: var(--lec-accent); font-weight: 700; }
.am-dim .am-dl:not(.on) { opacity: 0.3; }
.am-searching .am-dl:not(.match):not(.cat-hit) { opacity: 0.35; }
</style>
