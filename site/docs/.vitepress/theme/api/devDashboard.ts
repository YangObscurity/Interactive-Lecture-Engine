/**
 * theme/api/devDashboard.ts — client for the S4b dev-only Dashboard endpoints (`/__lecture/api/*`, dashboardDevPlugin.mts).
 * Every call returns null / an error object outside `vitepress dev`; writes and file reads carry the dev token.
 */
import type { CompanionPromptsFile } from '../../prompts/companion.ts'
import type { DevDashboardStatus } from './admin'
import { request } from './http'
import { currentLang, translate } from '../../i18n/index.ts'

const base = (): string => ['/__lecture', '/api'].join('')

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface CheckIssue {
  level: 'fail' | 'warn' | 'info'
  code: string
  file?: string
  line?: number
  message: string
}

export interface CheckReport {
  mode: string
  root: string
  counts: { groups: number; lectures: number; translations: number; charts: number; concepts: number; figures: number }
  totals: { fail: number; warn: number; info: number }
  issues: CheckIssue[]
  ok: boolean
}

export interface CheckRunPayload {
  at: string
  ms: number
  exitCode: number
  report: CheckReport | null
  error?: string
  doctor?: { ok: boolean; text: string; errors: string[]; warnings: string[] }
  authoringLocal?: string | null
  /** The categories the last run reran on top of the full report, null for a full run. */
  only?: string[] | null
}

async function get(pathname: string, token?: string): Promise<Record<string, unknown> | null> {
  if (!import.meta.env.DEV) return null
  const res = await request<unknown>('GET', `${base()}${pathname}`, token ? { headers: { 'x-lecture-dev-token': token } } : {})
  return res.ok && isRecord(res.data) ? res.data : null
}

async function writeJson(
  method: 'POST' | 'DELETE',
  pathname: string,
  token: string,
  body?: unknown,
  timeoutMs = 8000,
): Promise<{ ok: boolean; data: Record<string, unknown> | null; status?: number }> {
  if (!import.meta.env.DEV || typeof window === 'undefined' || typeof fetch !== 'function') {
    return { ok: false, data: null }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { accept: 'application/json', 'x-lecture-dev-token': token }
    let serialized: string | undefined
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      serialized = JSON.stringify(body)
    }
    const res = await fetch(`${base()}${pathname}`, {
      method,
      headers,
      body: serialized,
      signal: controller.signal,
      credentials: 'same-origin',
      redirect: 'manual',
    })
    let data: Record<string, unknown> | null = null
    try {
      const parsed: unknown = await res.json()
      if (isRecord(parsed)) data = parsed
    } catch {
      data = null
    }
    if (!res.ok) return { ok: false, data, status: res.status }
    return { ok: true, data }
  } catch {
    return { ok: false, data: null }
  } finally {
    clearTimeout(timer)
  }
}

async function post(pathname: string, token: string, body: unknown, timeoutMs?: number): Promise<{ ok: boolean; data: Record<string, unknown> | null; status?: number }> {
  return writeJson('POST', pathname, token, body, timeoutMs)
}

async function del(pathname: string, token: string): Promise<{ ok: boolean; data: Record<string, unknown> | null; status?: number }> {
  return writeJson('DELETE', pathname, token)
}

/** The last check run (null before the first run). */
export async function fetchLastCheck(): Promise<CheckRunPayload | null> {
  const d = await get('/check')
  return d && isRecord(d.run) ? (d.run as unknown as CheckRunPayload) : null
}

/** Run `check:content` and `doctor` now (takes a few seconds); with `only`, rerun those categories on top of the last report. */
export async function runCheckNow(token: string, only?: readonly string[]): Promise<CheckRunPayload | null> {
  const r = await post('/check', token, only && only.length ? { only } : {}, 200_000)
  return r.data && isRecord(r.data.run) ? (r.data.run as unknown as CheckRunPayload) : null
}

export interface Snippet {
  file: string
  from: number
  lines: string[]
  hit: number | null
  total: number
}

export async function fetchSnippet(token: string, file: string, line?: number): Promise<Snippet | null> {
  const q = new URLSearchParams({ path: file, ...(line ? { line: String(line) } : {}) })
  const d = await get(`/file?${q.toString()}`, token)
  return d && d.ok === true ? (d as unknown as Snippet) : null
}

export interface HistoryCommit {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export interface HistoryPayload {
  file: string
  ownRepo: boolean
  commits: HistoryCommit[]
}

export async function fetchPromptsHistory(): Promise<HistoryPayload | null> {
  const d = await get('/prompts/history')
  return d && Array.isArray(d.commits) ? (d as unknown as HistoryPayload) : null
}

/** The prompts file at a revision (`<hash>` or `<hash>^`); `missing` when that revision has no such file. */
export async function fetchPromptsAt(token: string, rev: string): Promise<{ text: string; prompts: CompanionPromptsFile | null } | 'missing' | null> {
  if (!import.meta.env.DEV) return null
  const res = await request<unknown>('GET', `${base()}/prompts/at?rev=${encodeURIComponent(rev)}`, { headers: { 'x-lecture-dev-token': token } })
  if (!res.ok) return res.status === 404 ? 'missing' : null
  if (!isRecord(res.data) || typeof res.data.text !== 'string') return null
  return { text: res.data.text, prompts: isRecord(res.data.prompts) ? (res.data.prompts as unknown as CompanionPromptsFile) : null }
}

export interface ReaderLimitRow {
  key: string
  value: number
  source: 'server/.env' | 'default'
  min: number
  max: number
}

export interface RuntimePayload {
  limits: { file: string; exists: boolean; limits: ReaderLimitRow[] }
  processes: { devServer: { up: boolean; port: number | null }; contentWatch: 'watching' | 'off' | 'in-place'; lastBuild: string | null; lectureApi: { up: boolean; port: number; status?: number } }
}

export async function fetchRuntime(): Promise<RuntimePayload | null> {
  const d = await get('/runtime')
  return d && isRecord(d.limits) ? (d as unknown as RuntimePayload) : null
}

export interface DevLogLine {
  seq: number
  t: string
  src: 'dev' | 'sync' | 'build' | 'api'
  lv: 'info' | 'warn' | 'err'
  msg: string
}

export async function fetchDevLogs(token: string, after: number): Promise<{ lines: DevLogLine[]; last: number } | null> {
  const d = await get(`/logs?after=${after}`, token)
  return d && Array.isArray(d.lines) ? (d as unknown as { lines: DevLogLine[]; last: number }) : null
}

export interface SavePromptsResult {
  ok: boolean
  prompts?: CompanionPromptsFile
  errors?: string[]
  error?: string
  commit?: { committed: boolean; hash?: string; reason?: string }
}

/** Save the prompts file with a commit message (the commit happens only when the content folder is its own repository). */
export async function savePromptsWithMessage(token: string, prompts: CompanionPromptsFile, message: string): Promise<SavePromptsResult> {
  const r = await post('/prompts', token, { prompts, message })
  if (!r.data) return { ok: false, error: r.status ? `HTTP ${r.status}` : 'network' }
  return {
    ok: r.data.ok !== false,
    ...(isRecord(r.data.prompts) ? { prompts: r.data.prompts as unknown as CompanionPromptsFile } : {}),
    ...(Array.isArray(r.data.errors) ? { errors: r.data.errors.filter((x): x is string => typeof x === 'string') } : {}),
    ...(typeof r.data.error === 'string' ? { error: r.data.error } : {}),
    ...(isRecord(r.data.commit) ? { commit: r.data.commit as SavePromptsResult['commit'] } : {}),
  }
}

export interface ChangeCommit {
  hash: string
  short: string
  date: string
  subject: string
  files: string[]
}

/** Recent commits that touched the content folder (empty when it is not in a git repository). */
export async function fetchChanges(): Promise<ChangeCommit[] | null> {
  const d = await get('/changes')
  return d && Array.isArray(d.commits) ? (d.commits as ChangeCommit[]) : null
}

export interface DevAccessGroup {
  id: string
  read: 'public' | 'authenticated' | string[]
  own: boolean
}

export interface DevAccessSummary {
  default: 'public' | 'authenticated'
  enforcement: 'none' | 'gateway'
  groups: DevAccessGroup[]
  configFile: string
  accessFile?: {
    path: string
    exists: boolean
    savedAt: string | null
  }
  rawAccess?: Record<string, unknown>
}

export interface SaveAccessResult {
  ok: boolean
  access?: unknown
  accessFile?: {
    path: string
    exists: boolean
    savedAt: string | null
  }
  status?: DevDashboardStatus
  autheliaPreview?: string
  autheliaPreviewNote?: { code: string; detail?: string } | null
  error?: string
}

export async function saveDevAccess(token: string, access: unknown): Promise<SaveAccessResult> {
  const r = await post('/access', token, { access })
  if (!r.ok || !r.data) {
    const error =
      r.data && typeof r.data.error === 'string'
        ? r.data.error
        : r.status === 409
          ? demoReadOnlyHint()
          : r.status
            ? `HTTP ${r.status}`
            : 'network'
    return { ok: false, error }
  }
  return {
    ok: true,
    access: r.data.access,
    accessFile: r.data.accessFile as SaveAccessResult['accessFile'],
    ...(isRecord(r.data.status) ? { status: r.data.status as unknown as DevDashboardStatus } : {}),
    ...(typeof r.data.autheliaPreview === 'string' ? { autheliaPreview: r.data.autheliaPreview } : {}),
    ...(r.data.autheliaPreviewNote !== undefined ? { autheliaPreviewNote: r.data.autheliaPreviewNote as SaveAccessResult['autheliaPreviewNote'] } : {}),
  }
}

export interface PreviewAccessResult {
  ok: boolean
  autheliaPreview?: string
  autheliaPreviewNote?: { code: string; detail?: string } | null
  error?: string
}

export async function previewDevAccess(token: string, access: unknown): Promise<PreviewAccessResult> {
  const r = await post('/access/preview', token, { access })
  if (!r.ok || !r.data) {
    return { ok: false, error: r.data && typeof r.data.error === 'string' ? r.data.error : 'network' }
  }
  return {
    ok: true,
    autheliaPreview: typeof r.data.autheliaPreview === 'string' ? r.data.autheliaPreview : '',
    autheliaPreviewNote: r.data.autheliaPreviewNote as PreviewAccessResult['autheliaPreviewNote'],
  }
}

export interface ToolsServer {
  id: string
  name: string
  url: string
  enabled: boolean
  headers: Array<{ name: string; env: string; set: boolean }>
  tools: Record<string, boolean>
  timeoutMs: number | null
}

export interface ToolsPayload {
  file: string
  exists: boolean
  source: 'content' | 'example' | 'none'
  engine: Record<string, boolean>
  servers: ToolsServer[]
  settings: { provider: string; maxSteps: number; timeoutMs: number; maxResultBytes: number; mcpTokenSet: boolean; ticketSecretSet: boolean; source: 'server/.env' | 'default' }
}

/** content/ai-tools.json as the companion › tools tab shows it (no secret values: only whether a header variable is set). */
export async function fetchTools(): Promise<ToolsPayload | null> {
  const d = await get('/tools')
  return d && isRecord(d.engine) ? (d as unknown as ToolsPayload) : null
}

/** Save on/off switches, additions or removals (engine tools, servers, server tools). */
export async function saveToolSwitches(
  token: string,
  sw: {
    engine?: Record<string, boolean>
    servers?:
      | Record<string, { enabled?: boolean; tools?: Record<string, boolean> }>
      | Array<{
          id: string
          name?: string
          url?: string
          enabled?: boolean
          headers?: Array<{ name: string; env: string }>
          headerEnv?: Record<string, string>
          tools?: Record<string, boolean | { enabled: boolean }>
          timeoutMs?: number | null
        }>
  },
): Promise<{ ok: true; tools: ToolsPayload } | { ok: false; error: string }> {
  const r = await post('/tools', token, sw)
  if (!r.ok || !r.data) {
    const error = r.data && typeof r.data.error === 'string' ? r.data.error : r.status === 409 ? demoReadOnlyHint() : r.status ? `HTTP ${r.status}` : 'network'
    return { ok: false, error }
  }
  return { ok: true, tools: r.data as unknown as ToolsPayload }
}

export async function addExternalMcpServer(
  token: string,
  server: { id?: string; name: string; url: string; hdr?: string; env: string },
): Promise<{ ok: true; server: ToolsServer; tools: ToolsPayload } | { ok: false; error: string; field?: string }> {
  const r = await post('/tools/servers', token, server)
  if (!r.ok || !r.data) {
    const error = r.data && typeof r.data.error === 'string' ? r.data.error : r.status === 409 ? demoReadOnlyHint() : r.status ? `HTTP ${r.status}` : 'network'
    const field = r.data && typeof r.data.field === 'string' ? r.data.field : undefined
    return { ok: false, error, ...(field ? { field } : {}) }
  }
  return { ok: true, server: r.data.server as unknown as ToolsServer, tools: r.data.tools as unknown as ToolsPayload }
}

export async function deleteExternalMcpServer(
  token: string,
  serverId: string,
): Promise<{ ok: true; tools: ToolsPayload } | { ok: false; error: string }> {
  const r = await del(`/tools/servers/${encodeURIComponent(serverId)}`, token)
  if (!r.ok || !r.data) {
    const error = r.data && typeof r.data.error === 'string' ? r.data.error : r.status === 409 ? demoReadOnlyHint() : r.status ? `HTTP ${r.status}` : 'network'
    return { ok: false, error }
  }
  return { ok: true, tools: r.data.tools as unknown as ToolsPayload }
}

export interface ThemeView {
  file: string
  exists: boolean
  skin: 'reader' | 'datasheet'
  base: 'paper' | 'sepia' | 'green' | 'dark' | 'custom'
  custom: string
}

export async function fetchThemeConfig(): Promise<ThemeView | null> {
  const d = await get('/theme')
  return d && isRecord(d.theme) ? (d.theme as unknown as ThemeView) : null
}

export async function saveThemeConfig(
  token: string,
  theme: { skin: 'reader' | 'datasheet'; base: 'paper' | 'sepia' | 'green' | 'dark' | 'custom'; custom: string },
): Promise<{ ok: true; theme: ThemeView } | { ok: false; error: string; reason?: string }> {
  const r = await post('/theme', token, theme)
  if (!r.ok || !r.data) {
    const error = r.data && typeof r.data.error === 'string' ? r.data.error : r.status === 409 ? demoReadOnlyHint() : r.status ? `HTTP ${r.status}` : 'network'
    const reason = r.data && typeof r.data.reason === 'string' ? r.data.reason : undefined
    return { ok: false, error, ...(reason ? { reason } : {}) }
  }
  return { ok: true, theme: r.data.theme as unknown as ThemeView }
}

/**
 * S6 decision B: the dev server answers 409 to every content write while the site shows the engine's demo content
 * (no content folder of its own yet). Shown in the save status instead of a bare "HTTP 409".
 */
export function demoReadOnlyHint(): string {
  return translate(currentLang(), 'dsh.demoReadOnly')
}
