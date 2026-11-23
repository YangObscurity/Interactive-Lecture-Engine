/**
 * store.ts — Reactive client store holding the site-managed AI prompts & quick actions.
 * Initialized once from `virtual:lecture-prompts` in `theme/index.ts` (and updated on dev save).
 */
import { ref } from 'vue'
import {
  validateCompanionPrompts,
  type CompanionPromptsFile,
  type QuickActionSpec,
} from './companion.ts'

const FALLBACK_PROMPTS: CompanionPromptsFile = {
  version: 1,
  system: {
    zh: '你是讲义站点的技术伴读助手。仅依据提供的讲义上下文作答；超出范围时明确说明，保持客观简明。',
    en: 'You are a technical reading companion for the lecture site. Answer from the supplied lecture context; state explicitly when something goes beyond it.',
  },
  actions: [
    {
      id: 'explain',
      label: { zh: '解释这段', en: 'Explain this passage' },
      template: {
        zh: '当前讲义：{lecture}（{group}），当前小节：{outline}。\n请结合讲义上下文解释以下选文：\n\n{selection}',
        en: 'Lecture: {lecture} ({group}), Section: {outline}.\nExplain the selected passage below using the lecture context:\n\n{selection}',
      },
      needsSelection: true,
      surfaces: ['panel', 'menu'],
      enabled: true,
    },
    {
      id: 'example',
      label: { zh: '举个例子', en: 'Give an example' },
      template: {
        zh: '当前讲义：{lecture}（{group}），当前小节：{outline}。\n针对以下选文给出一个具体示例：\n\n{selection}',
        en: 'Lecture: {lecture} ({group}), Section: {outline}.\nGive one concrete example illustrating the selected passage below:\n\n{selection}',
      },
      needsSelection: true,
      surfaces: ['panel', 'menu'],
      enabled: true,
    },
    {
      id: 'quiz',
      label: { zh: '出一道自测题', en: 'Make a self-test question' },
      template: {
        zh: '当前讲义：{lecture}（{group}），当前小节：{outline}。\n请基于当前小节出一道自测题并附答案与解析。',
        en: 'Lecture: {lecture} ({group}), Section: {outline}.\nCreate one self-test question covering the current section with answer and brief explanation.',
      },
      needsSelection: false,
      surfaces: ['panel', 'menu'],
      enabled: true,
    },
    {
      id: 'summarize',
      label: { zh: '总结这一节', en: 'Summarise this section' },
      template: {
        zh: '当前讲义：{lecture}（{group}），当前小节：{outline}。\n请分条总结本节的核心要点与边界条件。',
        en: 'Lecture: {lecture} ({group}), Section: {outline}.\nSummarise the core points and boundary conditions of this section in bullet points.',
      },
      needsSelection: false,
      surfaces: ['panel', 'menu'],
      enabled: true,
    },
  ],
}

export const companionPromptsRef = ref<CompanionPromptsFile>(FALLBACK_PROMPTS)

export function configureCompanionPrompts(raw: unknown): CompanionPromptsFile {
  const checked = validateCompanionPrompts(raw)
  if (checked.ok) {
    companionPromptsRef.value = checked.value
  }
  return companionPromptsRef.value
}

export function getCompanionPrompts(): CompanionPromptsFile {
  return companionPromptsRef.value
}

export function getQuickActions(): readonly QuickActionSpec[] {
  return companionPromptsRef.value.actions
}
