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

export interface AiGlobalState {
  isOpen: boolean
  activeScope: ScopeType
  quotedText: string
  currentSessionId: string | null
  isStreaming: boolean
  openSidebar: (quote?: string) => void
  closeSidebar: () => void
  toggleSidebar: () => void
  setQuotedText: (text: string) => void
  clearQuotedText: () => void
  setScope: (scope: ScopeType) => void
}

export const aiState = reactive<AiGlobalState>({
  isOpen: false,
  activeScope: 'lecture',
  quotedText: '',
  currentSessionId: null,
  isStreaming: false,

  openSidebar(quote?: string) {
    aiState.isOpen = true
    if (quote && quote.trim()) {
      aiState.quotedText = quote.trim()
      aiState.activeScope = 'selection'
    }
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
