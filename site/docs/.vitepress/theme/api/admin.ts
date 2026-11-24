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
import { demoReadOnlyHint, type DevAccessSummary } from './devDashboard'

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
  autheliaPreviewNote?: { code: string; detail?: string } | null
  nodeVersion: string
  texts?: SiteTexts
  access?: DevAccessSummary
  demo?: boolean
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
  const res = await request<unknown>('GET', resolveApiUrl(endpoint), {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  })
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
  const res = await request<unknown>('GET', resolveApiUrl(endpoint), {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  })
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
 * (no content folder of its own yet). Shown in the save status instead of a bare "HTTP 409".
 */
function httpSaveError(res: { status?: number; kind: string }): string {
  if (res.status === 409) return demoReadOnlyHint()
  return res.status ? `HTTP ${res.status}` : res.kind
}

// ---------------------------------------------------------------------------
// WP-4: Online Admin & DB Engine API Client (credentials: 'include', non-throwing)
// ---------------------------------------------------------------------------

let configuredApiOrigin = ''

export function setApiOrigin(origin: string): void {
  configuredApiOrigin = origin.trim().replace(/\/+$/, '')
}

export function getApiOrigin(): string {
  if (configuredApiOrigin) return configuredApiOrigin
  if (typeof window !== 'undefined') {
    const win = window as unknown as { __LECTURE_API_ORIGIN__?: unknown }
    if (typeof win.__LECTURE_API_ORIGIN__ === 'string' && win.__LECTURE_API_ORIGIN__.trim()) {
      return win.__LECTURE_API_ORIGIN__.trim().replace(/\/+$/, '')
    }
  }
  return ''
}

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const normalized = path.startsWith('/') ? path : `/${path}`
  const origin = getApiOrigin()
  return origin ? `${origin}${normalized}` : normalized
}

export interface AdminApiError {
  status: number
  code: string
  message: string
  details?: unknown
}

export type AdminApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: AdminApiError }

export function isAdminOk<T>(res: AdminApiResult<T>): res is { ok: true; data: T } {
  return res.ok === true
}

export function isAdminError<T>(res: AdminApiResult<T>): res is { ok: false; error: AdminApiError } {
  return res.ok === false
}

export const DEFAULT_ADMIN_TIMEOUT_MS = 30_000

export function formatAdminError(err: AdminApiError | unknown): string {
  if (isRecord(err)) {
    const code = typeof err.code === 'string' ? err.code : typeof err.error === 'string' ? err.error : ''
    const message = typeof err.message === 'string' ? err.message : ''
    if (message && code && message !== code) return `${code}: ${message}`
    if (message) return message
    if (code) return code
  }
  if (err instanceof Error) return err.message
  return String(err ?? 'unknown_error')
}

async function adminFetch<T>(
  method: string,
  path: string,
  body?: unknown,
  fetchImpl?: typeof fetch,
  timeoutMs = DEFAULT_ADMIN_TIMEOUT_MS,
): Promise<AdminApiResult<T>> {
  const fetchFn =
    fetchImpl ?? (typeof window !== 'undefined' && typeof fetch === 'function' ? fetch : null)
  if (!fetchFn) {
    return {
      ok: false,
      error: { status: 0, code: 'network_unavailable', message: 'Fetch unavailable in current environment' },
    }
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  let serialized: string | undefined
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
    serialized = JSON.stringify(body)
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  let res: Response
  try {
    res = await fetchFn(resolveApiUrl(path), {
      method,
      headers,
      body: serialized,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (timedOut) {
      return {
        ok: false,
        error: { status: 0, code: 'timeout', message: 'Request timed out' },
      }
    }
    return {
      ok: false,
      error: {
        status: 0,
        code: 'network_error',
        message: err instanceof Error ? err.message : String(err),
      },
    }
  }

  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.redirected) {
    clearTimeout(timer)
    return {
      ok: false,
      error: {
        status: res.status || 302,
        code: 'auth_redirect',
        message: 'Request was redirected by gateway; please re-authenticate',
      },
    }
  }

  let text = ''
  try {
    text = await res.text()
  } catch (err) {
    return {
      ok: false,
      error: {
        status: res.status,
        code: timedOut ? 'timeout' : 'read_error',
        message: timedOut ? 'Request timed out' : err instanceof Error ? err.message : String(err),
      },
    }
  } finally {
    clearTimeout(timer)
  }

  let parsed: unknown = null
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        ok: false,
        error: {
          status: res.status,
          code: 'invalid_json',
          message: `HTTP ${res.status}`,
        },
      }
    }
  }

  if (!res.ok) {
    const rec = isRecord(parsed) ? parsed : {}
    const code = typeof rec.error === 'string' && rec.error ? rec.error : `http_${res.status}`
    const message = typeof rec.message === 'string' && rec.message ? rec.message : `HTTP ${res.status} (${code})`
    const details = rec.errors ?? rec.details
    return {
      ok: false,
      error: {
        status: res.status,
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    }
  }

  return { ok: true, data: parsed as T }
}

export interface OnlinePersistenceInfo {
  mode: string
  effect?: string
  rebuildReason?: string
  filePath?: string
  updatedAt?: string
}

export interface OnlineCheckIssue {
  level: 'fail' | 'warn' | 'info'
  code: string
  message: string
  file?: string
}

export interface OnlineCheckReport {
  ok: boolean
  mode: 'online'
  root: string
  counts: {
    groups: number
    lectures: number
    translations: number
    charts: number
    concepts: number
    figures: number
  }
  totals: { fail: number; warn: number; info: number }
  issues: OnlineCheckIssue[]
}

export interface OnlineChecksPayload {
  ok: boolean
  report: OnlineCheckReport
  at: string
  ms?: number
  exitCode?: number
  only?: string[]
}

export function fetchOnlineChecks(): Promise<AdminApiResult<OnlineChecksPayload>> {
  return adminFetch<OnlineChecksPayload>('GET', '/api/admin/checks')
}

export function runOnlineChecks(only?: readonly string[]): Promise<AdminApiResult<OnlineChecksPayload>> {
  return adminFetch<OnlineChecksPayload>(
    'POST',
    '/api/admin/checks/run',
    only && only.length ? { only } : {},
  )
}

export interface OnlineFigureItem {
  id: string
  kind: 'figure' | 'chart' | 'concept'
  path: string
  sizeBytes: number
  updatedAt: string
}

export interface OnlineFiguresPayload {
  ok: boolean
  items: OnlineFigureItem[]
  warnings: string[]
  errors: string[]
}

export function fetchOnlineFigures(): Promise<AdminApiResult<OnlineFiguresPayload>> {
  return adminFetch<OnlineFiguresPayload>('GET', '/api/admin/figures')
}

export interface OnlineTextsPayload {
  ok: boolean
  texts: Record<string, unknown>
  persistence?: OnlinePersistenceInfo
}

export function fetchOnlineTexts(): Promise<AdminApiResult<OnlineTextsPayload>> {
  return adminFetch<OnlineTextsPayload>('GET', '/api/admin/texts')
}

export function saveOnlineTexts(texts: Record<string, unknown>): Promise<AdminApiResult<OnlineTextsPayload>> {
  return adminFetch<OnlineTextsPayload>('PUT', '/api/admin/texts', { texts })
}

export interface OnlineCompanionPayload {
  ok: boolean
  filePath: string | null
  source: string
  prompts: CompanionPromptsFile
  limits: typeof PromptLimitsShape
}

export interface OnlineCompanionSavePayload {
  ok: boolean
  prompts: CompanionPromptsFile
  persistence: OnlinePersistenceInfo
}

export interface OnlineCompanionHistoryItem {
  id?: number
  setting_key?: string
  previous_value?: unknown
  new_value?: unknown
  updated_by?: string
  updated_at?: string
}

export function fetchOnlineCompanion(): Promise<AdminApiResult<OnlineCompanionPayload>> {
  return adminFetch<OnlineCompanionPayload>('GET', '/api/admin/companion')
}

export function saveOnlineCompanion(prompts: CompanionPromptsFile): Promise<AdminApiResult<OnlineCompanionSavePayload>> {
  return adminFetch<OnlineCompanionSavePayload>('PUT', '/api/admin/companion', { prompts })
}

export function saveOnlineCompanionAction(
  name: string,
  action: Record<string, unknown> | null,
): Promise<AdminApiResult<{ ok: boolean; action: unknown; persistence: OnlinePersistenceInfo }>> {
  return adminFetch('PUT', `/api/admin/companion/prompts/${encodeURIComponent(name)}`, { action })
}

export function fetchOnlineCompanionHistory(): Promise<
  AdminApiResult<{ ok: boolean; history: OnlineCompanionHistoryItem[] }>
> {
  return adminFetch('GET', '/api/admin/companion/history')
}

export interface OnlineAccessPayload {
  ok: boolean
  access: Record<string, unknown>
  persistence?: OnlinePersistenceInfo
}

export function fetchOnlineAccess(): Promise<AdminApiResult<OnlineAccessPayload>> {
  return adminFetch<OnlineAccessPayload>('GET', '/api/admin/access')
}

export function saveOnlineAccess(access: Record<string, unknown>): Promise<AdminApiResult<OnlineAccessPayload>> {
  return adminFetch<OnlineAccessPayload>('PUT', '/api/admin/access', { access })
}

export interface OnlineLookPayload {
  ok: boolean
  look: Record<string, unknown>
  persistence?: OnlinePersistenceInfo
}

export function fetchOnlineLook(): Promise<AdminApiResult<OnlineLookPayload>> {
  return adminFetch<OnlineLookPayload>('GET', '/api/admin/look')
}

export function saveOnlineLook(look: Record<string, unknown>): Promise<AdminApiResult<OnlineLookPayload>> {
  return adminFetch<OnlineLookPayload>('PUT', '/api/admin/look', { look })
}

export interface OnlineRuntimePayload {
  ok: boolean
  nodeVersion: string
  uptimeSeconds: number
  memory: Record<string, number>
  authAdapter: string
  pid: number
}

export interface OnlineLogEntry {
  id?: string | number
  timestamp: string
  level: string
  category: string
  message: string
}

export function fetchOnlineRuntime(): Promise<AdminApiResult<OnlineRuntimePayload>> {
  return adminFetch<OnlineRuntimePayload>('GET', '/api/admin/runtime')
}

export function reloadOnlineRuntime(): Promise<AdminApiResult<{ ok: boolean; reloadedAt: string }>> {
  return adminFetch('POST', '/api/admin/runtime/reload', {})
}

export function fetchOnlineLogs(params?: {
  limit?: number
  level?: string
  category?: string
}): Promise<AdminApiResult<{ ok: boolean; logs: OnlineLogEntry[]; total: number }>> {
  const qs = new URLSearchParams()
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  if (params?.level) qs.set('level', params.level)
  if (params?.category) qs.set('category', params.category)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return adminFetch('GET', `/api/admin/logs${suffix}`)
}

export interface OnlineBackupEntry {
  filename: string
  sizeBytes: number
  sha256: string | null
  createdAt: string
}

export interface OnlineBackupSnapshot {
  filename: string
  checksumFilename: string
  sha256: string
  sizeBytes: number
  tableCounts: Record<string, number>
  createdAt: string
}

export interface OnlineBackupRestoreResult {
  ok: boolean
  dryRun: boolean
  filename: string
  verifiedChecksum: boolean
  tableCounts: Record<string, number>
  message: string
}

export function fetchOnlineBackups(): Promise<
  AdminApiResult<{ ok: boolean; backupDir: string; backups: OnlineBackupEntry[] }>
> {
  return adminFetch('GET', '/api/admin/backups')
}

export function createOnlineBackup(): Promise<AdminApiResult<{ ok: boolean; snapshot: OnlineBackupSnapshot }>> {
  return adminFetch('POST', '/api/admin/backups', {})
}

export function restoreOnlineBackup(payload: {
  filename?: string
  archivePath?: string
  dryRun?: boolean
}): Promise<AdminApiResult<OnlineBackupRestoreResult>> {
  return adminFetch('POST', '/api/admin/backups/restore', payload)
}

export function fetchOnlineSetting<T = unknown>(
  key: string,
): Promise<AdminApiResult<{ ok: boolean; key: string; value: T }>> {
  return adminFetch('GET', `/api/admin/settings/${encodeURIComponent(key)}`)
}

export function saveOnlineSetting<T = unknown>(
  key: string,
  value: T,
): Promise<AdminApiResult<{ ok: boolean; key: string; value: T }>> {
  return adminFetch('PUT', `/api/admin/settings/${encodeURIComponent(key)}`, { value })
}

export interface OnlineAiToolsPayload {
  mcpEndpoint: { enabled: boolean; path: string }
  engineTools: Array<{ name: string; enabled: boolean; calls7d: number; errors7d: number }>
  mcpServers: Array<{
    id: string
    name: string
    host: string
    enabled: boolean
    connectionState: string
    tools: Array<{ name: string; enabled: boolean; calls7d: number; errors7d: number }>
  }>
  settings?: {
    provider: string
    maxSteps: number
    timeoutMs: number
    maxResultBytes: number
    mcpTokenSet: boolean
    ticketSecretSet: boolean
    source: string
  }
  statsSource: string
  toolCallCounts7d: Record<string, { calls: number; errors: number }>
}

export function fetchOnlineAiTools(): Promise<AdminApiResult<OnlineAiToolsPayload>> {
  return adminFetch<OnlineAiToolsPayload>('GET', '/api/admin/ai-tools')
}

export function saveOnlineAiTools(payload: {
  engine?: Record<string, boolean>
  servers?: Array<{ id: string; enabled?: boolean; tools?: Record<string, boolean> }>
}): Promise<AdminApiResult<OnlineAiToolsPayload & { ok: boolean; persistence?: OnlinePersistenceInfo }>> {
  return adminFetch('PUT', '/api/admin/ai-tools', payload)
}

// ── Admin Users ──────────────────────────────────────────────────────────────────────────────────

export type UserRole = 'reader' | 'author' | 'admin'

export interface AdminUser {
  id: string
  username: string
  email: string | null
  displayName: string
  roles: UserRole[]
  disabled: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export function fetchAdminUsers(): Promise<AdminApiResult<AdminUser[]>> {
  return adminFetch<AdminUser[]>('GET', '/api/admin/users')
}

export function createAdminUser(payload: {
  username: string
  password: string | null
  displayName?: string
  email?: string | null
  roles?: UserRole[]
  disabled?: boolean
}): Promise<AdminApiResult<AdminUser>> {
  return adminFetch<AdminUser>('POST', '/api/admin/users', payload)
}

export function updateAdminUser(
  id: string,
  payload: {
    displayName?: string
    email?: string | null
    roles?: UserRole[]
    disabled?: boolean
    password?: string
  },
): Promise<AdminApiResult<AdminUser>> {
  return adminFetch<AdminUser>('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, payload)
}

export function resetAdminUserPassword(
  id: string,
  newPassword: string,
): Promise<AdminApiResult<{ ok: boolean }>> {
  return adminFetch('PUT', `/api/admin/users/${encodeURIComponent(id)}/password`, { newPassword })
}

export function updateAdminUserRoles(
  id: string,
  roles: UserRole[],
): Promise<AdminApiResult<{ ok: boolean; roles: UserRole[] }>> {
  return adminFetch('PUT', `/api/admin/users/${encodeURIComponent(id)}/roles`, { roles })
}

export function updateAdminUserStatus(
  id: string,
  disabled: boolean,
): Promise<AdminApiResult<{ ok: boolean; disabled: boolean }>> {
  return adminFetch('PUT', `/api/admin/users/${encodeURIComponent(id)}/status`, { disabled })
}

export function deleteAdminUser(id: string): Promise<AdminApiResult<{ ok: boolean }>> {
  return adminFetch('DELETE', `/api/admin/users/${encodeURIComponent(id)}`)
}

// ── Admin Database Engine & 6-Table CRUD ─────────────────────────────────────────────────────────

export type DbCrudTableName =
  | 'progress'
  | 'ai_sessions'
  | 'ai_messages'
  | 'ai_review_checklists'
  | 'auth_users'
  | 'site_settings'

export interface DbConfigResponse {
  ok: boolean
  kind: 'pglite' | 'pg' | string
  databaseUrl: string | null
  databaseUrlDirect: string | null
  pgliteDir: string | null
  envFilePath: string | null
  envWritable: boolean
  migrations: {
    applied: number
    pending: number
    total: number
  }
  tableCounts: Record<string, number | null>
}

export interface DbTestResponse {
  ok: boolean
  kind?: string
  serverVersion?: string | null
  latencyMs: number
  migrationsApplied?: number
  migrationsPending?: number
  targetRedacted: string | null
  error?: string
}

export interface DbMigrateResponse {
  ok: boolean
  dryRun: boolean
  applied: string[]
  pending: string[]
  dryRunSql: string
}

export interface DbSwitchDryRunResponse {
  ok: boolean
  dryRun: true
  sameTarget: boolean
  previousKind: string
  targetKind: string
  migrationsApplied: number
  migrationsPending: string[]
  dryRunSql: string
  envWritable: boolean
  databaseUrl: string | null
}

export interface DbSwitchApplyResponse {
  ok: boolean
  dryRun?: false
  previousKind: string
  currentKind: string
  migrationsApplied: string[]
  envUpdated: boolean
  backupPath: string | null
  databaseUrl: string | null
}

export type DbSwitchResponse = DbSwitchDryRunResponse | DbSwitchApplyResponse

export function isDbSwitchDryRun(res: DbSwitchResponse): res is DbSwitchDryRunResponse {
  return res.dryRun === true
}

export interface DbTransferDryRunResponse {
  ok: boolean
  dryRun: true
  direction: 'push' | 'pull'
  tables: Array<{
    table: string
    sourceCount: number | null
    targetCount: number | null
  }>
}

export interface DbTransferApplyResponse {
  ok: boolean
  dryRun: false
  direction: 'push' | 'pull'
  conflictStrategy: 'upsert' | 'skip'
  results: Array<{
    table: string
    sourceCount: number
    transferredCount: number
    targetCount: number
  }>
}

export type DbTransferResponse = DbTransferDryRunResponse | DbTransferApplyResponse

export function isDbTransferDryRun(res: DbTransferResponse): res is DbTransferDryRunResponse {
  return res.dryRun === true
}

export interface DbTableMeta {
  name: DbCrudTableName
  pkColumns: string[]
  columns: string[]
  readOnlyColumns: string[]
  editableColumns: string[]
  searchableColumns: string[]
  defaultSort: string
  rowCount: number | null
}

export interface DbTableRowsResponse {
  ok: boolean
  table: DbCrudTableName
  rows: Array<Record<string, unknown>>
  total: number
  limit: number
  offset: number
  sort: string
  order: 'asc' | 'desc'
}

export function fetchDbConfig(): Promise<AdminApiResult<DbConfigResponse>> {
  return adminFetch<DbConfigResponse>('GET', '/api/admin/db/config')
}

export function testDbConnection(payload: {
  targetUrl: string
  targetDirectUrl?: string | null
}): Promise<AdminApiResult<DbTestResponse>> {
  return adminFetch<DbTestResponse>('POST', '/api/admin/db/test', payload)
}

export function initDb(payload?: {
  targetUrl?: string | null
  targetDirectUrl?: string | null
  dryRun?: boolean
}): Promise<AdminApiResult<DbMigrateResponse>> {
  return adminFetch<DbMigrateResponse>('POST', '/api/admin/db/init', payload ?? {})
}

export function migrateDb(payload?: {
  targetUrl?: string | null
  targetDirectUrl?: string | null
  dryRun?: boolean
}): Promise<AdminApiResult<DbMigrateResponse>> {
  return adminFetch<DbMigrateResponse>('POST', '/api/admin/db/migrate', payload ?? {})
}

export function switchDb(payload: {
  targetUrl: string
  targetDirectUrl?: string | null
  dryRun?: boolean
  autoMigrate?: boolean
  updateEnv?: boolean
}): Promise<AdminApiResult<DbSwitchResponse>> {
  return adminFetch<DbSwitchResponse>('POST', '/api/admin/db/switch', payload)
}

export function transferDb(payload: {
  targetUrl: string
  targetDirectUrl?: string | null
  direction: 'push' | 'pull'
  conflictStrategy?: 'upsert' | 'skip'
  dryRun?: boolean
  migrateTarget?: boolean
}): Promise<AdminApiResult<DbTransferResponse>> {
  return adminFetch<DbTransferResponse>('POST', '/api/admin/db/transfer', payload)
}

export function fetchDbTables(): Promise<AdminApiResult<{ ok: boolean; tables: DbTableMeta[] }>> {
  return adminFetch('GET', '/api/admin/db/tables')
}

export function fetchDbTableRows(
  table: DbCrudTableName,
  params?: {
    limit?: number
    offset?: number
    sort?: string
    order?: 'asc' | 'desc'
    q?: string
  },
): Promise<AdminApiResult<DbTableRowsResponse>> {
  const qs = new URLSearchParams()
  if (params?.limit !== undefined) qs.set('limit', String(params.limit))
  if (params?.offset !== undefined) qs.set('offset', String(params.offset))
  if (params?.sort) qs.set('sort', params.sort)
  if (params?.order) qs.set('order', params.order)
  if (params?.q) qs.set('q', params.q)
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return adminFetch<DbTableRowsResponse>('GET', `/api/admin/db/tables/${encodeURIComponent(table)}/rows${suffix}`)
}

export function createDbTableRow(
  table: DbCrudTableName,
  row: Record<string, unknown>,
): Promise<AdminApiResult<{ ok: boolean; table: DbCrudTableName; row: Record<string, unknown> }>> {
  return adminFetch('POST', `/api/admin/db/tables/${encodeURIComponent(table)}/rows`, row)
}

export function updateDbTableRow(
  table: DbCrudTableName,
  pk: string | Record<string, string>,
  data: Record<string, unknown>,
): Promise<AdminApiResult<{ ok: boolean; table: DbCrudTableName; row: Record<string, unknown> }>> {
  return adminFetch('PATCH', `/api/admin/db/tables/${encodeURIComponent(table)}/rows`, { pk, data })
}

export function deleteDbTableRow(
  table: DbCrudTableName,
  pk: string | Record<string, string>,
): Promise<AdminApiResult<{ ok: boolean; table: DbCrudTableName; deleted: Record<string, unknown> }>> {
  return adminFetch('DELETE', `/api/admin/db/tables/${encodeURIComponent(table)}/rows`, { pk })
}
