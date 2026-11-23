<script lang="ts">
/** Engine default of the `AtlasLink` slot (v1): a curve in the category colour from parent to child. */
import { h } from 'vue'
import type { VNode } from 'vue'
import type { AtlasLinkProps } from '../registry.ts'

type DirectProps = AtlasLinkProps & { 'data-link'?: string; 'data-slot'?: string; 'data-slot-impl'?: string }

function AtlasLink(p: DirectProps): VNode {
  const m = (p.x2 - p.x1) / 2
  return h('path', {
    class: `am-link am-rlk am-l-${p.kind} am-c${p.slot}${p.on ? ' on' : ''}`,
    d: `M${p.x1} ${p.y1}C${p.x1 + m} ${p.y1} ${p.x2 - m} ${p.y2} ${p.x2} ${p.y2}`,
    'data-link': p['data-link'],
    'data-slot': p['data-slot'] ?? 'AtlasLink',
    'data-slot-impl': p['data-slot-impl'],
  })
}
AtlasLink.props = ['id', 'parentId', 'kind', 'side', 'slot', 'x1', 'y1', 'x2', 'y2', 'bus', 'on']
export default AtlasLink
</script>

<style>
.am-rlk { fill: none; stroke-linecap: round; }
.am-rlk.am-c1 { stroke: var(--lec-cat-1); }
.am-rlk.am-c2 { stroke: var(--lec-cat-2); }
.am-rlk.am-c3 { stroke: var(--lec-cat-3); }
.am-rlk.am-c4 { stroke: var(--lec-cat-4); }
.am-rlk.am-c5 { stroke: var(--lec-cat-5); }
.am-rlk.am-c6 { stroke: var(--lec-cat-6); }
.am-rlk.am-c7 { stroke: var(--lec-cat-7); }
.am-rlk.am-c8 { stroke: var(--lec-cat-8); }
.am-rlk.am-l-cat { stroke-width: 3.2; stroke-opacity: 0.8; }
.am-rlk.am-l-group { stroke-width: 2; stroke-opacity: 0.65; }
.am-rlk.am-l-stage { stroke-width: 1.3; stroke-opacity: 0.5; }
.am-rlk.am-l-lec { stroke-width: 1.1; stroke-opacity: 0.42; }
.am-rlk.on { stroke-opacity: 1; }
.am-rlk.am-l-lec.on, .am-rlk.am-l-stage.on { stroke-width: 2; }
.am-dim .am-rlk:not(.on) { opacity: 0.12; }
</style>
