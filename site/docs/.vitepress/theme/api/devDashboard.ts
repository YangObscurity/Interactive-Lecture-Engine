/**
 * theme/api/devDashboard.ts — client for the S4b dev-only Dashboard endpoints (`/__lecture/api/*`, dashboardDevPlugin.mts).
 * Every call returns null / an error object outside `vitepress dev`; writes and file reads carry the dev token.
 */
import type { CompanionPromptsFile } from '../../prompts/companion.ts'
import { request } from './http'

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

async function post(pathname: string, token: string, body: unknown, timeoutMs?: number): Promise<{ ok: boolean; data: Record<string, unknown> | null; status?: number }> {
  if (!import.meta.env.DEV) return { ok: false, data: null }
  const res = await request<unknown>('POST', `${base()}${pathname}`, {
    headers: { 'x-lecture-dev-token': token },
    body,
    ...(timeoutMs ? { timeoutMs } : {}),
  })
  if (!res.ok) return { ok: false, data: null, ...(res.status ? { status: res.status } : {}) }
  return { ok: true, data: isRecord(res.data) ? res.data : null }
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

/** Save on/off switches only (engine tools, servers, server tools). */
export async function saveToolSwitches(
  token: string,
  sw: { engine: Record<string, boolean>; servers: Record<string, { enabled: boolean; tools: Record<string, boolean> }> },
): Promise<{ ok: true; tools: ToolsPayload } | { ok: false; error: string }> {
  const r = await post('/tools', token, sw)
  if (!r.ok || !r.data) return { ok: false, error: r.data && typeof r.data.error === 'string' ? r.data.error : r.status ? `HTTP ${r.status}` : 'network' }
  return { ok: true, tools: r.data as unknown as ToolsPayload }
}
