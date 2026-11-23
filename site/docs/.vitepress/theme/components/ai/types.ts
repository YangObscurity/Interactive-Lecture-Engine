/**
 * types.ts — AI 伴读侧边栏核心类型定义
 * 
 * 严格遵循 TypeScript 契约，零 any 滥用。
 */

export type ScopeType = 'lecture' | 'group' | 'all' | 'selection'

export interface ChatToolCall {
  id: string
  name: string
  state: 'running' | 'done' | 'error'
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  selectedText?: string
  scope?: ScopeType
  toolCalls?: ChatToolCall[]
  isStreaming?: boolean
  isError?: boolean
  isIncomplete?: boolean
  isMock?: boolean
  error?: string
  errorDetail?: string
}

export interface SendPayload {
  query: string
  scope: ScopeType
  selectedText?: string
  actionId?: string
}

export interface ScopeChipItem {
  id: ScopeType
  label: string
  icon: string
  description?: string
  disabled?: boolean
}
