<script lang="ts">
/** datasheet implementation of the `AtlasLink` slot (v1): a right-angle trace, out of the parent, along a bus, into the child. */
import { h } from 'vue'
import type { VNode } from 'vue'
import type { AtlasLinkProps } from '../../../theme/slots/registry.ts'

type DirectProps = AtlasLinkProps & { 'data-link'?: string; 'data-slot'?: string; 'data-slot-impl'?: string }

function AtlasLink(p: DirectProps): VNode {
  return h('path', {
    class: `am-link am-dlk am-trace am-l-${p.kind}${p.on ? ' on' : ''}`,
    d: `M${p.x1} ${p.y1}H${p.bus}V${p.y2}H${p.x2}`,
    'data-link': p['data-link'],
    'data-slot': p['data-slot'] ?? 'AtlasLink',
    'data-slot-impl': p['data-slot-impl'],
  })
}
AtlasLink.props = ['id', 'parentId', 'kind', 'side', 'slot', 'x1', 'y1', 'x2', 'y2', 'bus', 'on']
export default AtlasLink
</script>

<style>
.am-dlk { fill: none; }
.am-dlk.am-trace { stroke: var(--lec-text-muted); stroke-opacity: 0.7; stroke-width: 1.1; stroke-linecap: butt; stroke-linejoin: miter; }
.am-dlk.am-trace.am-l-cat { stroke-width: 2; stroke-opacity: 0.8; }
.am-dlk.am-trace.on { stroke: var(--lec-accent); stroke-opacity: 1; stroke-width: 2; }
.am-dim .am-dlk:not(.on) { opacity: 0.12; }
</style>
