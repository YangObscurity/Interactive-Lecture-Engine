<script lang="ts">
/** Engine default of the `AtlasLecture` slot (v1): a status dot (hollow, half, solid), the number and the name. */
import { h } from 'vue'
import type { VNode } from 'vue'
import type { AtlasLectureProps } from '../registry.ts'

type DirectProps = AtlasLectureProps & { 'data-node'?: string; 'data-slot'?: string; 'data-slot-impl'?: string }

function AtlasLecture(p: DirectProps): VNode {
  const cx = p.xi + p.side * 5
  const anchor = p.side > 0 ? 'start' : 'end'
  const hl = p.highlight ? (p.highlight === 'on' ? ' on' : ` on ${p.highlight}`) : ''
  const children: VNode[] = [
    h('rect', { class: 'lec-map-hit', x: p.x0 - 3, y: p.y - 10, width: p.w + 6, height: 20 }),
    h('circle', { class: 'dot', cx, cy: p.y, r: 4.3 }),
  ]
  if (p.status === 'reading') {
    children.push(h('path', { class: 'dot-half', d: `M${cx - 4.3} ${p.y}A4.3 4.3 0 0 0 ${cx + 4.3} ${p.y}Z` }))
  }
  children.push(
    h('text', { class: 'no', x: p.xi + p.side * 14, y: p.y + 4, 'text-anchor': anchor, 'data-label-kind': 'num' }, p.number),
    h('text', { class: 'label', x: p.labelX, y: p.y + 4.5, 'text-anchor': anchor, 'data-label-kind': 'name' }, p.label),
  )
  return h('g', {
    class: `am-node am-lec am-rl ${p.status}${hl}${p.match ? ' match' : ''}`,
    'data-node': p['data-node'],
    'data-slot': p['data-slot'] ?? 'AtlasLecture',
    'data-slot-impl': p['data-slot-impl'],
  }, children)
}
AtlasLecture.props = ['id', 'side', 'slot', 'highlight', 'match', 'xi', 'xo', 'x0', 'w', 'y', 'number', 'label', 'title', 'labelX', 'labelW', 'status']
export default AtlasLecture
</script>

<style>
.am-rl { cursor: pointer; }
.am-rl .label { font: 13px var(--lec-font-body); fill: var(--lec-text); }
.am-rl.unread .label { fill: var(--lec-text-muted); }
.am-rl.reading .label { font-weight: 600; }
.am-rl .no { font: 11px var(--lec-font-mono); fill: var(--lec-text-muted); }
.am-rl .dot { stroke: var(--lec-border); stroke-width: 1.5; fill: var(--lec-bg); }
.am-rl.read .dot { fill: var(--lec-done); stroke: var(--lec-done); }
.am-rl.reading .dot { stroke: var(--lec-accent); }
.am-rl .dot-half { fill: var(--lec-accent); stroke: none; }
.am-rl.hover .label { fill: var(--lec-accent); font-weight: 700; }
.am-rl.pre .label { fill: var(--lec-accent); }
.am-rl.post .label { fill: var(--lec-done-text); }
.am-rl.pre .dot { stroke: var(--lec-accent); stroke-width: 2.5; }
.am-rl.post .dot { stroke: var(--lec-done); stroke-width: 2.5; }
.am-rl.match .label { fill: var(--lec-accent); font-weight: 700; }
.am-dim .am-rl:not(.on) { opacity: 0.3; }
.am-searching .am-rl:not(.match):not(.cat-hit) { opacity: 0.35; }
</style>
