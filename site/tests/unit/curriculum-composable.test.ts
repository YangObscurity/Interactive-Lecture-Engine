// @vitest-environment happy-dom
import { createSSRApp, defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyCurriculum, type CurriculumData } from '../../docs/.vitepress/curriculum/data'

const localeIndex = ref('root')
const accessVersion = shallowRef(0)
const loadCurriculum = vi.fn(async (locale: string): Promise<CurriculumData> => ({ ...emptyCurriculum(locale), stats: { groups: accessVersion.value + 10, lectures: 0, edges: 0 } }))

vi.mock('vitepress', () => ({ useData: () => ({ localeIndex }) }))
vi.mock('../../docs/.vitepress/theme/access/useAccess', () => ({ useAccess: () => ({ version: accessVersion }) }))
vi.mock('../../docs/.vitepress/theme/curriculum/loader', () => ({ loadCurriculum: (locale: string) => loadCurriculum(locale) }))

import { useCurriculum, type UseCurriculumOptions } from '../../docs/.vitepress/theme/curriculum/useCurriculum'

const initial: CurriculumData = { ...emptyCurriculum('root'), stats: { groups: 1, lectures: 2, edges: 3 } }

function host(options: UseCurriculumOptions = {}) {
  let api!: ReturnType<typeof useCurriculum>
  const C = defineComponent({
    setup() {
      api = useCurriculum(options)
      return () => h('p', String(api.data.value?.stats.groups ?? 'none'))
    },
  })
  return { C, get api() { return api } }
}

const flush = async (): Promise<void> => {
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

afterEach(() => {
  loadCurriculum.mockClear()
  localeIndex.value = 'root'
  accessVersion.value = 0
})

describe('useCurriculum', () => {
  it('shows `initial` to the server render and the first client render, then the merged data after mount', async () => {
    const ssr = host({ initial })
    const html = await renderToString(createSSRApp(ssr.C))
    expect(html).toContain('>1<')
    expect(loadCurriculum).not.toHaveBeenCalled() // nothing is loaded on the server

    const h1 = host({ initial })
    const w = mount(h1.C)
    expect(w.text()).toBe('1') // the hydration render
    await flush()
    expect(loadCurriculum).toHaveBeenCalledWith('root')
    expect(w.text()).toBe('10')
    expect(h1.api.loaded.value).toBe(true)
    w.unmount()
  })

  it('is null before the first answer when there is no initial data', async () => {
    const h1 = host()
    const w = mount(h1.C)
    expect(h1.api.data.value).toBeNull()
    expect(h1.api.loaded.value).toBe(false)
    await flush()
    expect(h1.api.data.value).not.toBeNull()
    w.unmount()
  })

  it('loads again when the access answer changes (sign-in) or the locale changes, and the newest answer wins', async () => {
    const h1 = host()
    const w = mount(h1.C)
    await flush()
    expect(loadCurriculum).toHaveBeenCalledTimes(1)
    accessVersion.value = 1
    await flush()
    expect(loadCurriculum).toHaveBeenCalledTimes(2)
    expect(w.text()).toBe('11')
    localeIndex.value = 'en'
    await flush()
    expect(loadCurriculum).toHaveBeenLastCalledWith('en')
    expect(h1.api.data.value?.locale).toBe('en')

    // a slow older answer must not replace a newer one
    let release!: (d: CurriculumData) => void
    loadCurriculum.mockImplementationOnce(() => new Promise<CurriculumData>((r) => (release = r)))
    accessVersion.value = 2
    await nextTick()
    accessVersion.value = 3
    await flush()
    expect(w.text()).toBe('13')
    release({ ...emptyCurriculum('en'), stats: { groups: 999, lectures: 0, edges: 0 } })
    await flush()
    expect(w.text()).toBe('13')
    w.unmount()
  })

  it('takes a locale of its own (a ref or a value)', async () => {
    const h1 = host({ locale: 'en' })
    const w = mount(h1.C)
    await flush()
    expect(loadCurriculum).toHaveBeenCalledWith('en')
    w.unmount()
  })

  it('stops after unmount', async () => {
    const h1 = host()
    const w = mount(h1.C)
    await flush()
    w.unmount()
    loadCurriculum.mockClear()
    accessVersion.value = 5
    await flush()
    expect(loadCurriculum).not.toHaveBeenCalled()
  })
})
