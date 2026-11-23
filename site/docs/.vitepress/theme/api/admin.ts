/**
 * theme/api/admin.ts — P6.5 Dashboard admin & dev API client.
 *
 * Uses `request<T>` (`./http`) so production requests carry `redirect: 'manual'`,
 * `credentials: 'same-origin'`, `cache: 'no-store'`, and structured `HttpResult<T>` outcomes.
 * Zero raw color literals or hardcoded UI CJK strings (PROGRESS_WIRE_STATUS imported from site.config).
 */
import { PROGRESS_WIRE_STATUS } from '../../site.config.mts'
import type { CompanionPromptsFile, PROMPT_LIMITS as PromptLimitsShape } from '../../prompts/companion.ts'
import type { SiteTexts } from '../../site-texts-schema.ts'
import { request, type HttpResult } from './http'
import { demoReadOnlyHint } from './devDashboard'

export interface AdminOverviewTotals {
  users: number
  progressRows: number
  completedLectures: number
  sessions: number
  messages: number
  checklistItems: number
  completedChecklistItems: number
}

export interface AdminOverviewGroupRow {
  group_id: string
  total_rows: number
  completed: number
  in_progress: number
  not_started: number
}

export interface AdminOverviewResponse {
  generatedAt: string
  totals: AdminOverviewTotals
  byStatus: Record<string, number>
  byGroup: AdminOverviewGroupRow[]
  recentActivity: {
    progressUpdatedLast24h: number
    sessionsCreatedLast24h: number
    messagesCreatedLast24h: number
  }
}

export interface AdminHealthResponse {
  ok: boolean
  service: string
  version: string
  time: string
  uptimeSeconds: number
  checks: {
    db: {
      status: 'ok' | 'degraded' | 'down'
      latencyMs: number
      migrations: {
        appliedCount: number
        pendingCount: number
        latestApplied: string | null
      }
    }
    ai: {
      provider: string
      configured: boolean
      status: 'off' | 'ok'
    }
    notion: {
      configured: boolean
      status: string
    }
  }
  runtime: {
    nodeVersion: string
    authAdapter: string
    headerPreset: string
    dbKind: string
  }
}

export interface DevSettingSummary {
  key: string
  module: string
  kind: 'site' | 'env' | 'secret'
  type: string
  status: string
  source: string
  displayValue: string
  secretSet?: boolean
  secretLength?: number
  descriptionZh: string
  descriptionEn: string
  probe?: { reachable: boolean; status?: number; error?: string; target?: string }
  error?: string
  warnings?: string[]
}

export interface DevDashboardStatus {
  mode: 'dev'
  csrfToken: string
  ok: boolean
  errors: string[]
  warnings: string[]
  inUseModules: string[]
  settings: DevSettingSummary[]
  themes: Array<{ id: string; builtin: boolean; enabled: boolean; engine: string | null; errors: string[] }>
  autheliaPreview: string
  nodeVersion: string
  texts?: SiteTexts
}

export const ADMIN_ENDPOINTS = {
  overview: '/api/admin/overview',
  health: '/api/admin/health',
} as const

export const WIRE_STATUS_KEYS = {
  notStarted: PROGRESS_WIRE_STATUS.not_started,
  inProgress: PROGRESS_WIRE_STATUS.in_progress,
  completed: PROGRESS_WIRE_STATUS.completed,
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isAdminOverview(v: unknown): v is AdminOverviewResponse {
  if (!isRecord(v) || typeof v.generatedAt !== 'string') return false
  if (!isRecord(v.totals) || !isRecord(v.byStatus) || !Array.isArray(v.byGroup) || !isRecord(v.recentActivity)) {
    return false
  }
  return typeof v.totals.users === 'number' && typeof v.totals.progressRows === 'number'
}

export function isAdminHealth(v: unknown): v is AdminHealthResponse {
  if (!isRecord(v) || typeof v.ok !== 'boolean' || typeof v.service !== 'string') return false
  return isRecord(v.checks) && isRecord(v.checks.db) && isRecord(v.runtime)
}

export async function fetchAdminOverview(
  endpoint = ADMIN_ENDPOINTS.overview,
  signal?: AbortSignal,
): Promise<HttpResult<AdminOverviewResponse>> {
  const res = await request<unknown>('GET', endpoint, { ...(signal ? { signal } : {}) })
  if (!res.ok) return res
  if (!isAdminOverview(res.data)) {
    return { ok: false, kind: 'parse', serverDate: res.serverDate }
  }
  return { ...res, data: res.data }
}

export async function fetchAdminHealth(
  endpoint = ADMIN_ENDPOINTS.health,
  signal?: AbortSignal,
): Promise<HttpResult<AdminHealthResponse>> {
  const res = await request<unknown>('GET', endpoint, { ...(signal ? { signal } : {}) })
  if (!res.ok) return res
  if (!isAdminHealth(res.data)) {
    return { ok: false, kind: 'parse', serverDate: res.serverDate }
  }
  return { ...res, data: res.data }
}

export function computeTranslationSummary(
  groups: ReadonlyArray<{ id?: string; dir?: string; title?: string; i18n?: { en?: { title?: string } } }>,
  i18nPages: Readonly<Record<string, unknown>> | undefined,
  lecturesByGroup?: ReadonlyMap<string, number>,
): Array<{ groupId: string; dir: string; title: string; enTitle: string; total: number; translated: number }> {
  const pages = Object.keys(i18nPages ?? {})
  return groups
    .filter((g) => typeof g.id === 'string' && typeof g.dir === 'string')
    .map((g) => {
      const id = g.id as string
      const dir = g.dir as string
      const prefix = `/${dir}/`
      const translated = pages.filter((p) => p.startsWith(prefix) && /^L\d+$/.test(p.slice(prefix.length))).length
      const total = lecturesByGroup?.get(id) ?? 0
      return {
        groupId: id,
        dir,
        title: typeof g.title === 'string' ? g.title : id,
        enTitle: typeof g.i18n?.en?.title === 'string' ? g.i18n.en.title : '',
        total,
        translated,
      }
    })
}

export async function fetchDevDashboardStatus(): Promise<DevDashboardStatus | null> {
  if (!import.meta.env.DEV) return null
  const base = ['/__lecture', '/api'].join('')
  const res = await request<unknown>('GET', `${base}/status`)
  if (!res.ok || !isRecord(res.data) || res.data.mode !== 'dev') return null
  return res.data as unknown as DevDashboardStatus
}

export async function runDevDashboardProbe(csrfToken: string): Promise<DevDashboardStatus | null> {
  if (!import.meta.env.DEV) return null
  const base = ['/__lecture', '/api'].join('')
  const res = await request<unknown>('POST', `${base}/probe`, {
    headers: { 'x-lecture-dev-token': csrfToken },
    body: {},
    timeoutMs: 15_000,
  })
  if (!res.ok || !isRecord(res.data) || res.data.mode !== 'dev') return null
  return res.data as unknown as DevDashboardStatus
}

export async function saveDevEnvSetting(
  csrfToken: string,
  key: string,
  value: string,
): Promise<{ ok: boolean; status?: DevDashboardStatus; error?: string }> {
  if (!import.meta.env.DEV) return { ok: false, error: 'dev_only' }
  const base = ['/__lecture', '/api'].join('')
  const res = await request<unknown>('POST', `${base}/env`, {
    headers: { 'x-lecture-dev-token': csrfToken },
    body: { key, value },
  })
  if (!res.ok) {
    return { ok: false, error: res.status ? `HTTP ${res.status}` : res.kind }
  }
  if (!isRecord(res.data)) return { ok: false, error: 'invalid_response' }
  const status = isRecord(res.data.status) ? (res.data.status as unknown as DevDashboardStatus) : undefined
  return { ok: res.data.ok !== false, ...(status ? { status } : {}), ...(typeof res.data.error === 'string' ? { error: res.data.error } : {}) }
}

export interface DevPromptsPayload {
  ok: boolean
  filePath: string
  source: string
  prompts: CompanionPromptsFile
  limits: typeof PromptLimitsShape
}

export async function fetchDevCompanionPrompts(): Promise<DevPromptsPayload | null> {
  if (!import.meta.env.DEV) return null
  const base = ['/__lecture', '/api'].join('')
  const res = await request<unknown>('GET', `${base}/prompts`)
  if (!res.ok || !isRecord(res.data) || res.data.ok !== true) return null
  return res.data as unknown as DevPromptsPayload
}

export async function saveDevCompanionPrompts(
  csrfToken: string,
  prompts: CompanionPromptsFile,
): Promise<{ ok: boolean; prompts?: CompanionPromptsFile; filePath?: string; error?: string; errors?: string[] }> {
  if (!import.meta.env.DEV) return { ok: false, error: 'dev_only' }
  const base = ['/__lecture', '/api'].join('')
  const res = await request<unknown>('POST', `${base}/prompts`, {
    headers: { 'x-lecture-dev-token': csrfToken },
    body: { prompts },
  })
  if (!res.ok) {
    return { ok: false, error: httpSaveError(res) }
  }
  if (!isRecord(res.data)) return { ok: false, error: 'invalid_response' }
  return {
    ok: res.data.ok !== false,
    ...(isRecord(res.data.prompts) ? { prompts: res.data.prompts as unknown as CompanionPromptsFile } : {}),
    ...(typeof res.data.filePath === 'string' ? { filePath: res.data.filePath } : {}),
    ...(typeof res.data.error === 'string' ? { error: res.data.error } : {}),
    ...(Array.isArray(res.data.errors) ? { errors: res.data.errors.filter((x): x is string => typeof x === 'string') } : {}),
  }
}

export async function saveDevSiteTexts(
  csrfToken: string,
  texts: SiteTexts,
): Promise<{ ok: boolean; texts?: SiteTexts; error?: string; errors?: string[] }> {
  if (!import.meta.env.DEV) return { ok: false, error: 'dev_only' }
  const base = ['/__lecture', '/api'].join('')
  const res = await request<unknown>('POST', `${base}/texts`, {
    headers: { 'x-lecture-dev-token': csrfToken },
    body: { texts },
  })
  if (!res.ok) {
    return { ok: false, error: httpSaveError(res) }
  }
  if (!isRecord(res.data)) return { ok: false, error: 'invalid_response' }
  const saved = isRecord(res.data.texts) ? (res.data.texts as unknown as SiteTexts) : undefined
  return {
    ok: res.data.ok === true,
    ...(saved ? { texts: saved } : {}),
    ...(Array.isArray(res.data.errors) ? { errors: res.data.errors as string[] } : {}),
    ...(typeof res.data.error === 'string' ? { error: res.data.error } : {}),
  }
}

/**
 * S6 decision B: the dev server answers 409 to every content write while the site shows the engine's demo content
 * (no content folder of its own yet). Shown in the save status instead of a bare "HTTP 409" (dsh.demoReadOnly).
 */
function httpSaveError(res: { status?: number; kind: string }): string {
  if (res.status === 409) return demoReadOnlyHint()
  return res.status ? `HTTP ${res.status}` : res.kind
}
