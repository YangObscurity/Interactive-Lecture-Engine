/**
 * aiState.ts — AI 伴读侧边栏与划词系统全局响应式状态桥接
 * 
 * 职责：
 *   提供轻量级、无第三方依赖的单例响应式状态管理，协调侧边栏展开/收起、
 *   划词文字注入、引用范围切换与当前会话切换。
 * 
 * 严格遵循 SSR 保护与单一职责规范。
 */

import { reactive } from 'vue'

export type ScopeType = 'lecture' | 'group' | 'all' | 'selection'

export interface PendingQuickAction {
  actionId: string
  selectedText?: string
}

export interface PendingConceptAction {
  mode: 'create' | 'attach' | 'edit' | 'supplement' | 'delete'
  selectedText: string
  targetSlug?: string
  lecturePath: string
  sectionHeading: string
  beforeContext: string
  afterContext: string
}

export interface AiGlobalState {
  isOpen: boolean
  activeScope: ScopeType
  quotedText: string
  currentSessionId: string | null
  isStreaming: boolean
  pendingAction: PendingQuickAction | null
  conceptAction: PendingConceptAction | null
  openSidebar: (quote?: string) => void
  dispatchAction: (actionId: string, quote?: string) => void
  consumePendingAction: () => PendingQuickAction | null
  openConceptTask: (task: PendingConceptAction) => void
  clearConceptTask: () => void
  closeSidebar: () => void
  toggleSidebar: () => void
  setQuotedText: (text: string) => void
  clearQuotedText: () => void
  setScope: (scope: ScopeType) => void
}

export const aiState: AiGlobalState = reactive<AiGlobalState>({
  isOpen: false,
  activeScope: 'lecture',
  quotedText: '',
  currentSessionId: null,
  isStreaming: false,
  pendingAction: null,
  conceptAction: null,

  openSidebar(quote?: string): void {
    aiState.isOpen = true
    aiState.conceptAction = null
    if (quote && quote.trim()) {
      aiState.quotedText = quote.trim()
      aiState.activeScope = 'selection'
    }
  },

  dispatchAction(actionId: string, quote?: string): void {
    const cleanQuote = quote?.trim() || ''
    aiState.conceptAction = null
    if (cleanQuote) {
      aiState.quotedText = cleanQuote
      aiState.activeScope = 'selection'
    }
    aiState.pendingAction = {
      actionId,
      ...(cleanQuote ? { selectedText: cleanQuote } : {}),
    }
    aiState.isOpen = true
  },

  openConceptTask(task: PendingConceptAction): void {
    aiState.conceptAction = task
    if (task.selectedText.trim()) {
      aiState.quotedText = task.selectedText.trim()
      aiState.activeScope = 'selection'
    }
    aiState.isOpen = true
  },

  clearConceptTask(): void {
    aiState.conceptAction = null
  },

  consumePendingAction(): PendingQuickAction | null {
    const next: PendingQuickAction | null = aiState.pendingAction
    aiState.pendingAction = null
    return next
  },

  closeSidebar() {
    aiState.isOpen = false
  },

  toggleSidebar() {
    aiState.isOpen = !aiState.isOpen
  },

  setQuotedText(text: string) {
    aiState.quotedText = text.trim()
    if (aiState.quotedText) {
      aiState.activeScope = 'selection'
    }
  },

  clearQuotedText() {
    aiState.quotedText = ''
    if (aiState.activeScope === 'selection') {
      aiState.activeScope = 'lecture'
    }
  },

  setScope(scope: ScopeType) {
    aiState.activeScope = scope
  }
})
