// @vitest-environment happy-dom
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockLang = ref('zh-CN')
vi.mock('vitepress', () => ({
  useData: () => ({ lang: mockLang }),
}))

import ChatInput from '../../docs/.vitepress/theme/components/ai/ChatInput.vue'
import SelectionToolbar from '../../docs/.vitepress/theme/components/ai/SelectionToolbar.vue'
import { aiState } from '../../docs/.vitepress/theme/components/ai/aiState'
import { configureCompanionPrompts } from '../../docs/.vitepress/prompts/store.ts'
import { loadAndValidateSitePrompts } from '../../docs/.vitepress/prompts/load.mts'

describe('AI companion quick action components (WP-F7)', () => {
  beforeEach(() => {
    mockLang.value = 'zh-CN'
    configureCompanionPrompts(loadAndValidateSitePrompts().prompts)
    aiState.closeSidebar()
    aiState.clearQuotedText()
    aiState.consumePendingAction()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('disables selection-required actions without selection and enables all when text is selected', async () => {
    const wrapper = mount(ChatInput, {
      props: {
        lectureId: 'g05-L19',
        groupId: 'G05',
        selectedText: '',
      },
    })

    const explainBtn = wrapper.get('[data-ai-quick-action="explain"]')
    const exampleBtn = wrapper.get('[data-ai-quick-action="example"]')
    const quizBtn = wrapper.get('[data-ai-quick-action="quiz"]')
    const summarizeBtn = wrapper.get('[data-ai-quick-action="summarize"]')

    expect((explainBtn.element as HTMLButtonElement).disabled).toBe(true)
    expect((exampleBtn.element as HTMLButtonElement).disabled).toBe(true)
    expect((quizBtn.element as HTMLButtonElement).disabled).toBe(false)
    expect((summarizeBtn.element as HTMLButtonElement).disabled).toBe(false)

    expect(explainBtn.text()).toBe('解释这段')

    await quizBtn.trigger('click')
    const emittedNoSel = wrapper.emitted('send')
    expect(emittedNoSel?.[0]?.[0]).toMatchObject({ actionId: 'quiz', query: '' })

    await wrapper.setProps({ selectedText: 'FOREIGN KEY enforces referential integrity' })
    expect((explainBtn.element as HTMLButtonElement).disabled).toBe(false)
    expect((exampleBtn.element as HTMLButtonElement).disabled).toBe(false)

    await explainBtn.trigger('click')
    const emittedWithSel = wrapper.emitted('send')
    expect(emittedWithSel?.[1]?.[0]).toEqual({
      actionId: 'explain',
      query: '',
      scope: 'selection',
      selectedText: 'FOREIGN KEY enforces referential integrity',
    })

    mockLang.value = 'en'
    await wrapper.vm.$nextTick()
    expect(explainBtn.text()).toBe('Explain this passage')
    wrapper.unmount()
  })

  it('dispatches pending action when selection toolbar quick action is triggered', () => {
    const wrapper = mount(SelectionToolbar)
    expect(wrapper.exists()).toBe(true)
    aiState.dispatchAction('example', 'SELECT * FROM t')
    expect(aiState.isOpen).toBe(true)
    expect(aiState.quotedText).toBe('SELECT * FROM t')
    expect(aiState.consumePendingAction()).toEqual({
      actionId: 'example',
      selectedText: 'SELECT * FROM t',
    })
    wrapper.unmount()
  })

  it('shows quick actions only on their surfaces and hides disabled ones', async () => {
    const base = loadAndValidateSitePrompts().prompts
    configureCompanionPrompts({
      ...base,
      actions: base.actions.map((a) => {
        if (a.id === 'explain') return { ...a, surfaces: ['menu'] }
        if (a.id === 'example') return { ...a, surfaces: ['panel'] }
        if (a.id === 'quiz') return { ...a, enabled: false }
        return a
      }),
    })

    const input = mount(ChatInput, { props: { lectureId: 'g05-L19', groupId: 'G05', selectedText: 'x' } })
    const panelIds = input.findAll('[data-ai-quick-action]').map((el) => el.attributes('data-ai-quick-action'))
    expect(panelIds).toEqual(['example', 'summarize'])
    input.unmount()

    const toolbar = mount(SelectionToolbar)
    ;(toolbar.vm as unknown as { visible: boolean }).visible = true
    await toolbar.vm.$nextTick()
    const menuIds = Array.from(document.querySelectorAll('[data-ai-toolbar-action]')).map((el) => el.getAttribute('data-ai-toolbar-action'))
    expect(menuIds).toEqual(['explain', 'summarize'])
    toolbar.unmount()
  })
})
