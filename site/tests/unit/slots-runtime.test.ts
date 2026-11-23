// @vitest-environment happy-dom
/**
 * Component slots, runtime side (P2e): `<LecSlot>` resolves the implementation for the active theme, falls back to the
 * default, and swaps after mount once the other theme's component is loaded. The first render always equals the
 * server render (site default theme's implementation).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, type Component } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { renderToString } from 'vue/server-renderer'
import { createSlotRuntime, type SlotRuntime, type SlotTable } from '../../docs/.vitepress/theme/slots/runtime.ts'
import { createLecSlot, type LecSlotComponent } from '../../docs/.vitepress/theme/slots/LecSlot.ts'

function pad(shape: string): Component {
  return defineComponent({
    props: { status: { type: String, required: true }, current: { type: Boolean, required: true }, label: { type: String, required: true } },
    setup(props) {
      return () => h('span', { 'data-slot': 'SidebarStatus', 'data-status': props.status, 'data-shape': shape, role: 'img', 'aria-label': props.label })
    },
  })
}

const DEFAULT_IMPL = pad('default')
const DATASHEET_IMPL = pad('datasheet')
const PACK_IMPL = pad('pack')

interface Harness {
  runtime: SlotRuntime
  LecSlot: LecSlotComponent
  loads: string[]
  release: (name: string) => void
}

/** Site default theme: datasheet (static). `reader` = engine default (lazy), `pack` = third-party (lazy, gated by `release`). */
function harness(defaultTheme: 'datasheet' | 'reader' = 'datasheet'): Harness {
  const loads: string[] = []
  const gates = new Map<string, () => void>()
  const gated = (name: string, c: Component) => () => {
    loads.push(name)
    return new Promise<Component>((resolve) => gates.set(name, () => resolve(c)))
  }
  const immediate = (name: string, c: Component) => () => {
    loads.push(name)
    return Promise.resolve(c)
  }
  const table: SlotTable =
    defaultTheme === 'datasheet'
      ? {
          datasheet: { SidebarStatus: { impl: 'datasheet', load: immediate('datasheet', DATASHEET_IMPL) } },
          reader: { SidebarStatus: { impl: 'default', load: immediate('default', DEFAULT_IMPL) } },
          pack: { SidebarStatus: { impl: 'pack', load: gated('pack', PACK_IMPL) } },
          bare: { SidebarStatus: { impl: 'default', load: immediate('default', DEFAULT_IMPL) } },
        }
      : {
          reader: { SidebarStatus: { impl: 'default', load: immediate('default', DEFAULT_IMPL) } },
          datasheet: { SidebarStatus: { impl: 'datasheet', load: immediate('datasheet', DATASHEET_IMPL) } },
        }
  const runtime = createSlotRuntime({
    defaultTheme,
    table,
    staticImpls: { SidebarStatus: defaultTheme === 'datasheet' ? { impl: 'datasheet', component: DATASHEET_IMPL } : { impl: 'default', component: DEFAULT_IMPL } },
  })
  return { runtime, LecSlot: createLecSlot(runtime), loads, release: (n) => gates.get(n)?.() }
}

function mountSlot(slot: LecSlotComponent, p: Record<string, unknown>) {
  return mount(slot as unknown as Component, { props: p })
}

const props = { status: 'in_progress', current: false, label: 'Reading' } as const

function setTheme(theme: string | null): void {
  if (theme === null) document.documentElement.removeAttribute('data-lec-theme')
  else document.documentElement.setAttribute('data-lec-theme', theme)
}

beforeEach(() => setTheme(null))
afterEach(() => setTheme(null))

describe('<LecSlot>', () => {
  it('server render uses the site default theme implementation and sets data-slot / data-slot-impl', async () => {
    const h1 = harness('datasheet')
    setTheme('reader') // SSR never looks at the DOM
    const html = await renderToString(h(h1.LecSlot, { name: 'SidebarStatus', ...props }))
    expect(html).toContain('data-shape="datasheet"')
    expect(html).toContain('data-slot="SidebarStatus"')
    expect(html).toContain('data-slot-impl="datasheet"')
    expect(html).toContain('data-status="in_progress"')
    expect(html).toContain('aria-label="Reading"')
    expect(h1.loads).toEqual([])
  })

  it('passes the slot props through and renders the default theme implementation first, whatever the preference', async () => {
    setTheme('reader')
    const { LecSlot } = harness('datasheet')
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    // the first render happens before mount: no theme read yet -> default theme implementation (equals SSR)
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('datasheet')
    expect(w.get('[data-slot]').attributes('data-status')).toBe('in_progress')
    w.unmount()
  })

  it('swaps to the implementation of the active theme after mount (engine default for a theme without components)', async () => {
    setTheme('reader')
    const { LecSlot, loads } = harness('datasheet')
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    await flushPromises()
    await nextTick()
    const root = w.get('[data-slot]')
    expect(root.attributes('data-slot-impl')).toBe('default')
    expect(root.attributes('data-shape')).toBe('default')
    expect(root.attributes('data-status')).toBe('in_progress')
    expect(root.attributes('aria-label')).toBe('Reading')
    expect(loads).toEqual(['default'])
    w.unmount()
  })

  it('stays on the default theme implementation when the preference is the default theme (nothing is loaded)', async () => {
    setTheme('datasheet')
    const { LecSlot, loads } = harness('datasheet')
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    await flushPromises()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('datasheet')
    expect(loads).toEqual([])
    w.unmount()
  })

  it('keeps showing the current implementation until the other theme component has loaded, then replaces it', async () => {
    setTheme('pack')
    const { LecSlot, release, loads } = harness('datasheet')
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    await flushPromises()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('datasheet')
    expect(loads).toEqual(['pack'])
    release('pack')
    await flushPromises()
    await nextTick()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('pack')
    expect(w.get('[data-slot]').attributes('data-shape')).toBe('pack')
    w.unmount()
  })

  it('follows data-lec-theme changes after mount and loads each component once', async () => {
    setTheme('datasheet')
    const { LecSlot, loads } = harness('datasheet')
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    await flushPromises()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('datasheet')
    setTheme('reader')
    await flushPromises()
    await nextTick()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('default')
    setTheme('datasheet')
    await flushPromises()
    await nextTick()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('datasheet')
    setTheme('reader')
    await flushPromises()
    await nextTick()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('default')
    expect(loads).toEqual(['default'])
    w.unmount()
  })

  it('a theme with the same implementation as the default one (both engine default) loads nothing', async () => {
    setTheme('reader')
    const { LecSlot, loads } = harness('reader')
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    await flushPromises()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('default')
    expect(loads).toEqual([])
    w.unmount()
  })

  it('an unknown theme id falls back to the default theme implementation', async () => {
    setTheme('nobody')
    const { LecSlot, loads } = harness('datasheet')
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    await flushPromises()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('datasheet')
    expect(loads).toEqual([])
    w.unmount()
  })

  it('all instances follow one observer, which is released with the last instance', async () => {
    setTheme('datasheet')
    const { LecSlot, runtime } = harness('datasheet')
    const a = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    const b = mountSlot(LecSlot, { name: 'SidebarStatus', ...props, status: 'completed' })
    await flushPromises()
    expect(runtime.activeTheme.value).toBe('datasheet')
    setTheme('reader')
    await flushPromises()
    await nextTick()
    expect(a.get('[data-slot]').attributes('data-slot-impl')).toBe('default')
    expect(b.get('[data-slot]').attributes('data-slot-impl')).toBe('default')
    expect(b.get('[data-slot]').attributes('data-status')).toBe('completed')
    a.unmount()
    b.unmount()
    // stopped: a later change is not picked up
    setTheme('datasheet')
    await flushPromises()
    expect(runtime.activeTheme.value).toBe('reader')
  })

  it('a failing load keeps the default implementation and does not retry', async () => {
    setTheme('reader')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const runtime = createSlotRuntime({
      defaultTheme: 'datasheet',
      table: {
        reader: {
          SidebarStatus: {
            impl: 'default',
            load: () => {
              calls++
              return Promise.reject(new Error('boom'))
            },
          },
        },
      },
      staticImpls: { SidebarStatus: { impl: 'datasheet', component: DATASHEET_IMPL } },
    })
    const LecSlot = createLecSlot(runtime)
    const w = mountSlot(LecSlot, { name: 'SidebarStatus', ...props })
    await flushPromises()
    setTheme('reader')
    await flushPromises()
    expect(w.get('[data-slot]').attributes('data-slot-impl')).toBe('datasheet')
    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    w.unmount()
  })
})
