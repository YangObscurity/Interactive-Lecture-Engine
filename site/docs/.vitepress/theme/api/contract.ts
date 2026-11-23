/**
 * api/contract.ts — wire types of docs/backend-handoff/API_CONTRACT.md and their runtime guards.
 *
 * Wire = what the backend sends and receives (snake_case, Chinese status values). The rest adapter
 * (api/progress.ts) converts to and from the domain types; nothing else in the front end sees these.
 * The guards are lenient on optional fields (a V1 backend may omit them) and strict on the ones the
 * front end cannot work without.
 */
import { PROGRESS_WIRE_STATUS } from '../../site.config.mts'

export type WireStatus = (typeof PROGRESS_WIRE_STATUS)[keyof typeof PROGRESS_WIRE_STATUS]

export interface WireProgress {
  lecture_id: string
  group_id?: string | null
  status: WireStatus
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

const WIRE_STATUSES: readonly string[] = Object.values(PROGRESS_WIRE_STATUS)

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isOptionalString(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === 'string'
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
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
