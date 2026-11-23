// @vitest-environment happy-dom
/**
 * Companion page (v3.4 Dashboard › 伴读) as a component: the save path that the retired DashboardPromptsPanel test covered.
 * An unknown placeholder blocks saving, a valid edit unlocks it, per-action switches (enabled, surfaces) reach the POST
 * body, the dev token goes in the header, and the saved version is shown.
 */
import { ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockLang = ref('zh-CN')
vi.mock('vitepress', () => ({
  useData: () => ({ lang: mockLang, theme: ref({}), site: ref({ base: '/' }) }),
  withBase: (p: string) => p,
}))

import PageCompanion from '../../docs/.vitepress/theme/dashboard/pages/PageCompanion.vue'
import PlaceholderEditor from '../../docs/.vitepress/theme/dashboard/PlaceholderEditor.vue'
import { dashboardState } from '../../docs/.vitepress/theme/dashboard/useDashboard'
import { configureCompanionPrompts } from '../../docs/.vitepress/prompts/store.ts'
import { loadAndValidateSitePrompts } from '../../docs/.vitepress/prompts/load.mts'
import { dashboardZhCN } from '../../docs/.vitepress/i18n/dashboard.zh-CN.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Dashboard › companion page saves prompts (v3.4)', () => {
  beforeEach(() => {
    mockLang.value = 'zh-CN'
    configureCompanionPrompts(loadAndValidateSitePrompts().prompts)
    dashboardState.mode = 'dev'
    dashboardState.token = 'dev-token-ui-test'
    dashboardState.tabs = { companion: 'prompt' }
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    dashboardState.mode = 'loading'
    dashboardState.token = ''
    dashboardState.tabs = {}
  })

  it('blocks an unknown placeholder, posts per-action switches with the dev token, and shows the new version', async () => {
    const initial = loadAndValidateSitePrompts().prompts
    let posted: { prompts: typeof initial; message: string } | null = null
    let postedToken = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = init?.method ?? 'GET'
        if (url.endsWith('/prompts') && method === 'GET') return json({ ok: true, filePath: 'content/prompts/companion.json', source: 'default', prompts: initial, defaults: initial })
        if (url.endsWith('/prompts') && method === 'POST') {
          posted = JSON.parse(String(init?.body ?? '{}'))
          postedToken = new Headers(init?.headers).get('x-lecture-dev-token') ?? ''
          return json({ ok: true, prompts: { ...(posted as { prompts: typeof initial }).prompts, version: initial.version + 1 }, commit: { committed: false, reason: 'not_own_repo' } })
        }
        return json({ ok: false }, 404)
      }),
    )

    const wrapper = mount(PageCompanion, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.text()).toContain(`v${initial.version}`)
    const saveBtn = () => wrapper.get('[data-companion-save]').element as HTMLButtonElement
    expect(saveBtn().disabled).toBe(true)

    // an unknown placeholder is flagged and blocks saving
    const editor = wrapper.getComponent(PlaceholderEditor)
    editor.vm.$emit('update:modelValue', '禁止未定义占位符 {invalid_placeholder}')
    await flushPromises()
    expect(wrapper.find('[data-companion-errors]').exists()).toBe(true)
    expect(saveBtn().disabled).toBe(true)

    // a valid edit unlocks saving
    editor.vm.$emit('update:modelValue', '更新后的伴读系统提示词，严格依据讲义作答。')
    await flushPromises()
    expect(wrapper.find('[data-companion-errors]').exists()).toBe(false)
    expect(saveBtn().disabled).toBe(false)

    // quick actions: switch off the third one, take the first one off the selection menu
    dashboardState.tabs = { companion: 'actions' }
    await flushPromises()
    await wrapper.get('[data-qa-enable="2"]').trigger('click')
    await wrapper.get('[data-qa-open="0"]').trigger('click')
    const menuBox = wrapper
      .get(`[data-qa="${initial.actions[0]?.id}"]`)
      .findAll('label.db-ck')
      .find((l) => l.text().trim() === dashboardZhCN['dsh.cp.surfaceMenu'])
      ?.find('input[type="checkbox"]')
    expect(menuBox?.exists()).toBe(true)
    await menuBox?.setValue(false)

    await wrapper.get('[data-companion-save]').trigger('click')
    await flushPromises()
    expect(postedToken).toBe('dev-token-ui-test')
    const sent = (posted as unknown as { prompts: typeof initial }).prompts
    expect(sent.system.zh).toBe('更新后的伴读系统提示词，严格依据讲义作答。')
    expect(sent.actions[2]).toMatchObject({ id: initial.actions[2]?.id, enabled: false })
    expect(sent.actions[0]?.surfaces).toEqual((initial.actions[0]?.surfaces ?? []).filter((s) => s !== 'menu'))
    expect(wrapper.get('[data-companion-status]').text()).toContain(`v${initial.version + 1}`)
    expect(saveBtn().disabled).toBe(true)
    wrapper.unmount()
  })
})
