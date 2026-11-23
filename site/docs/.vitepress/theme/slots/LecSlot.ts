/**
 * theme/slots/LecSlot.ts - `<LecSlot name="SidebarStatus" v-bind="props" />` (P2e, plan section 2.4).
 *
 * Renders the implementation the runtime picks for the slot and passes the slot props through. It sets `data-slot`
 * and `data-slot-impl` itself (attribute fall-through to the component's root), so the contract tests can tell the
 * implementations apart even if a theme component forgets them. Everything else on the root (`data-status`, the
 * accessible name) is the component's job, see docs-dev/SLOTS.md.
 */
import { defineComponent, h, type PropType } from 'vue'
import type { SlotName } from './contract.ts'
import type { SlotProps } from './registry.ts'
import type { SlotRuntime } from './runtime.ts'

/** Typed constructor view of the component: `name` selects the slot, the other props come from `SlotProps[name]`. */
export interface LecSlotComponent {
  new <N extends SlotName>(): { $props: { name: N } & SlotProps[N] }
}

export function createLecSlot(runtime: SlotRuntime): LecSlotComponent {
  const component = defineComponent({
    name: 'LecSlot',
    inheritAttrs: false,
    props: { name: { type: String as PropType<SlotName>, required: true } },
    setup(props, { attrs }) {
      runtime.useActive()
      return () => {
        const r = runtime.resolve(props.name)
        if (!r) return null
        return h(r.component, { ...attrs, 'data-slot': props.name, 'data-slot-impl': r.impl })
      }
    },
  })
  return component as unknown as LecSlotComponent
}
