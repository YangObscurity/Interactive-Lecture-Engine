/**
 * Self-contained wire validators for contract testing (Backend M4 / backend-v2).
 * These validators have ZERO dependency on site/ directory (resolving DEF-01).
 */

export const PROGRESS_WIRE_STATUS = {
  not_started: '未开始',
  in_progress: '学习中',
  completed: '已完成',
} as const

const WIRE_STATUSES: readonly string[] = Object.values(PROGRESS_WIRE_STATUS)

export interface WireProgress {
  lecture_id: string
  group_id?: string | null
  status: string
  completed_at?: string | null
  updated_at?: string | null
  notion_node_id?: string | null
  notion_page_id?: string | null
}

export interface WireSessionUser {
  id: string
  name?: string | null
  email?: string | null
}

export interface WireSession {
  authenticated: boolean
  user: WireSessionUser | null
  roles: string[]
  groups: string[]
  logoutUrl?: string | null
}

export interface WireAiSession {
  id: string
  lecture_id: string
  group_id: string
  title: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

export interface WireAiMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  selected_context: string | null
  model: string
  prompt_tokens: number
  completion_tokens: number
  created_at: string
}

export interface WireAiReviewChecklist {
  id: string
  lecture_id: string
  group_id: string
  topic_title: string
  section_anchor: string | null
  is_completed: boolean
  pptx_source: string | null
  priority: number
  created_at: string
  updated_at: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isOptionalString(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === 'string'
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isValidIsoDate(v: unknown): boolean {
  if (typeof v !== 'string' || v.trim() === '') return false
  return !Number.isNaN(Date.parse(v))
}

export function isWireProgress(v: unknown): v is WireProgress {
  if (!isRecord(v)) return false
  if (typeof v.lecture_id !== 'string' || v.lecture_id.trim() === '') return false
  if (typeof v.status !== 'string' || !WIRE_STATUSES.includes(v.status)) return false
  return (
    isOptionalString(v.group_id) &&
    isOptionalString(v.completed_at) &&
    isOptionalString(v.updated_at) &&
    isOptionalString(v.notion_node_id) &&
    isOptionalString(v.notion_page_id)
  )
}

export function isWireSession(v: unknown): v is WireSession {
  if (!isRecord(v)) return false
  if (typeof v.authenticated !== 'boolean') return false
  if (!isStringArray(v.roles) || !isStringArray(v.groups)) return false
  if (!isOptionalString(v.logoutUrl)) return false
  if (v.user === null) return !v.authenticated
  if (!isRecord(v.user)) return false
  if (typeof v.user.id !== 'string' || v.user.id === '') return false
  return isOptionalString(v.user.name) && isOptionalString(v.user.email)
}

export function isWireAiSession(v: unknown): v is WireAiSession {
  if (!isRecord(v)) return false
  if ('user_id' in v) return false // user_id must be omitted
  if (typeof v.id !== 'string' || v.id.trim() === '') return false
  if (typeof v.lecture_id !== 'string' || v.lecture_id.trim() === '') return false
  if (typeof v.group_id !== 'string' || v.group_id.trim() === '') return false
  if (typeof v.title !== 'string') return false
  if (typeof v.is_archived !== 'boolean') return false
  if (!isValidIsoDate(v.created_at) || !isValidIsoDate(v.updated_at)) return false
  return true
}

export function isWireAiMessage(v: unknown): v is WireAiMessage {
  if (!isRecord(v)) return false
  if ('user_id' in v) return false // user_id must be omitted
  if (typeof v.id !== 'string' || v.id.trim() === '') return false
  if (typeof v.session_id !== 'string' || v.session_id.trim() === '') return false
  if (v.role !== 'user' && v.role !== 'assistant' && v.role !== 'system') return false
  if (typeof v.content !== 'string') return false
  if (v.selected_context !== null && typeof v.selected_context !== 'string') return false
  if (typeof v.model !== 'string') return false
  if (typeof v.prompt_tokens !== 'number' || v.prompt_tokens < 0) return false
  if (typeof v.completion_tokens !== 'number' || v.completion_tokens < 0) return false
  if (!isValidIsoDate(v.created_at)) return false
  return true
}

export function isWireAiReviewChecklist(v: unknown): v is WireAiReviewChecklist {
  if (!isRecord(v)) return false
  if ('user_id' in v) return false // user_id must be omitted
  if (typeof v.id !== 'string' || v.id.trim() === '') return false
  if (typeof v.lecture_id !== 'string' || v.lecture_id.trim() === '') return false
  if (typeof v.group_id !== 'string' || v.group_id.trim() === '') return false
  if (typeof v.topic_title !== 'string' || v.topic_title.trim() === '') return false
  if (v.section_anchor !== null && typeof v.section_anchor !== 'string') return false
  if (typeof v.is_completed !== 'boolean') return false
  if (v.pptx_source !== null && typeof v.pptx_source !== 'string') return false
  if (typeof v.priority !== 'number') return false
  if (!isValidIsoDate(v.created_at) || !isValidIsoDate(v.updated_at)) return false
  return true
}
