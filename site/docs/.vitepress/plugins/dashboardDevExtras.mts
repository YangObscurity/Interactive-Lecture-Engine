/**
 * plugins/dashboardDevExtras.mts — the S4b helpers behind the dev-only Dashboard endpoints (dashboardDevPlugin.mts):
 * content check runs, file snippets, prompt history from git, reader limits, lecture-api status.
 *
 * Every function is read-only except `commitContentFile`, which commits ONE file and only when the content folder is the
 * top level of its own git repository (never into the engine repository or a repository that merely contains it).
 * Node only; never bundled into the site.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { ContentPaths } from '../content/paths.mts'

export interface CheckRun {
  at: string
  ms: number
  exitCode: number
  report: unknown
  error?: string
}

function run(cmd: string, args: readonly string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args as string[], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

/** `npm run check:content -- --json [--only a,b]` as a child process (the check loads engine modules with their own paths). */
export async function runContentCheckProcess(siteRoot: string, only: readonly CheckCategoryId[] | null = null): Promise<CheckRun> {
  const t0 = Date.now()
  const script = path.join(siteRoot, 'scripts', 'content', 'check.mts')
  const args = [script, '--json', ...(only && only.length ? ['--only', only.join(',')] : [])]
  const res = await run(process.execPath, args, siteRoot, 180_000)
  const ms = Date.now() - t0
  try {
    return { at: new Date().toISOString(), ms, exitCode: res.code, report: JSON.parse(res.stdout) as unknown }
  } catch {
    return { at: new Date().toISOString(), ms, exitCode: res.code, report: null, error: (res.stderr || res.stdout).slice(-2000) }
  }
}

/** The `--only` categories of check:content (scripts/content/check.mts CHECK_CATEGORIES; a unit test keeps them equal). */
export const CHECK_CATEGORY_IDS = ['group', 'lecture', 'link', 'chart', 'translation', 'concept', 'figure', 'graph', 'texts'] as const
export type CheckCategoryId = (typeof CHECK_CATEGORY_IDS)[number]

/**
 * The `only` of a POST /check body, checked against the whitelist: null (no `only`: run everything), the categories in
 * a fixed order, or 'invalid' (not a string or a list of strings, empty, more than the list, or a name not on it).
 */
export function checkOnlyFromBody(body: unknown): CheckCategoryId[] | null | 'invalid' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = (body as Record<string, unknown>).only
  if (raw === undefined || raw === null) return null
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null
  if (!list || list.length === 0 || list.length > CHECK_CATEGORY_IDS.length) return 'invalid'
  if (!list.every((x): x is CheckCategoryId => typeof x === 'string' && (CHECK_CATEGORY_IDS as readonly string[]).includes(x))) return 'invalid'
  return CHECK_CATEGORY_IDS.filter((c) => list.includes(c))
}

interface ReportLike {
  issues: Array<{ level: 'fail' | 'warn' | 'info'; code: string }>
  totals: Record<'fail' | 'warn' | 'info', number>
  ok: boolean
  only?: unknown
}
const isReportLike = (r: unknown): r is ReportLike =>
  !!r && typeof r === 'object' && Array.isArray((r as ReportLike).issues) && !!(r as ReportLike).totals && typeof (r as ReportLike).totals === 'object'

/**
 * A full report with the issues of `only` replaced by those of a partial run (`--only`): totals and ok are counted
 * again, counts stay from the full run, `only` is null again. Without a full report to merge into, the partial one.
 */
export function mergeCheckReport(prev: unknown, partial: unknown, only: readonly string[]): unknown {
  if (!isReportLike(prev) || !isReportLike(partial)) return partial
  const cat = (code: string) => code.split('.')[0] ?? code
  const issues = [...prev.issues.filter((i) => !only.includes(cat(i.code))), ...partial.issues.filter((i) => only.includes(cat(i.code)))]
  const totals = { fail: 0, warn: 0, info: 0 }
  for (const i of issues) if (i.level in totals) totals[i.level]++
  return { ...prev, issues, totals, ok: totals.fail === 0, only: null }
}

const SNIPPET_EXTENSIONS = new Set(['.md', '.json', '.ts', '.mmd', '.txt', '.yml', '.yaml'])

export type SnippetResult =
  | { ok: true; file: string; from: number; lines: string[]; hit: number | null; total: number }
  | { ok: false; status: number; error: string }

/**
 * Lines around `line` of a file INSIDE the content root (a path relative to it). Refuses absolute paths, `..`,
 * symlinks out of the root, other file types and files over 2 MB.
 */
export function readContentSnippet(paths: Pick<ContentPaths, 'root'>, rel: string, line: number | null, context = 6): SnippetResult {
  const clean = rel.replace(/\\/g, '/').trim()
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) {
    return { ok: false, status: 400, error: 'invalid_path' }
  }
  if (!SNIPPET_EXTENSIONS.has(path.extname(clean).toLowerCase())) return { ok: false, status: 400, error: 'unsupported_type' }
  const abs = path.resolve(paths.root, ...clean.split('/'))
  let realRoot: string
  let realFile: string
  try {
    realRoot = fs.realpathSync(paths.root)
    realFile = fs.realpathSync(abs)
  } catch {
    return { ok: false, status: 404, error: 'not_found' }
  }
  const relReal = path.relative(realRoot, realFile)
  if (relReal === '' || relReal.startsWith('..') || path.isAbsolute(relReal)) return { ok: false, status: 403, error: 'outside_content' }
  const st = fs.statSync(realFile)
  if (!st.isFile()) return { ok: false, status: 404, error: 'not_found' }
  if (st.size > 2 * 1024 * 1024) return { ok: false, status: 413, error: 'too_large' }
  const all = fs.readFileSync(realFile, 'utf8').split(/\r?\n/)
  const hit = line && line >= 1 && line <= all.length ? line : null
  const from = hit ? Math.max(1, hit - context) : 1
  const to = hit ? Math.min(all.length, hit + context) : Math.min(all.length, context * 2 + 1)
  return { ok: true, file: clean, from, lines: all.slice(from - 1, to).map((l) => (l.length > 400 ? `${l.slice(0, 400)} …` : l)), hit, total: all.length }
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

const REV_RE = /^[0-9a-f]{7,40}\^?$/

async function gitTop(dir: string): Promise<string | null> {
  const res = await run('git', ['rev-parse', '--show-toplevel'], dir, 10_000)
  return res.code === 0 ? res.stdout.trim() : null
}

/** `git log` of one file (newest first). Empty when the file is not in a git repository. */
export async function gitLogFile(file: string, limit = 30): Promise<GitCommit[]> {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) return []
  const res = await run('git', ['log', `-n${Math.max(1, Math.min(100, limit))}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s', '--', path.basename(file)], dir, 15_000)
  if (res.code !== 0) return []
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', short = '', author = '', date = '', subject = ''] = line.split('\x1f')
      return { hash, short, author, date, subject }
    })
}

/** The file as it was at `rev` (`<hash>` or `<hash>^`); null when that revision has no such file. */
export async function gitShowFile(file: string, rev: string): Promise<string | null> {
  if (!REV_RE.test(rev)) return null
  const dir = path.dirname(file)
  const top = await gitTop(dir)
  if (!top) return null
  const rel = path.relative(fs.realpathSync(top), fs.realpathSync(file)).replace(/\\/g, '/')
  if (rel.startsWith('..')) return null
  const res = await run('git', ['show', `${rev}:${rel}`], top, 15_000)
  return res.code === 0 ? res.stdout : null
}

/** Is `dir` the top level of its own git repository (not a folder inside the engine checkout)? */
export async function isOwnRepo(dir: string): Promise<boolean> {
  const top = await gitTop(dir)
  if (!top) return false
  try {
    return path.resolve(fs.realpathSync(top)) === path.resolve(fs.realpathSync(dir))
  } catch {
    return false
  }
}

export interface DirCommit {
  hash: string
  short: string
  date: string
  subject: string
  /** Paths relative to `dir`, at most 12. */
  files: string[]
}

/** Recent commits that touched `dir` (newest first), with the files under it; empty outside a git repository. */
export async function gitLogDir(dir: string, limit = 8): Promise<DirCommit[]> {
  if (!fs.existsSync(dir)) return []
  const res = await run('git', ['log', `-n${Math.max(1, Math.min(50, limit))}`, '--name-only', '--relative', '--format=%x1e%H%x1f%h%x1f%aI%x1f%s', '--', '.'], dir, 15_000)
  if (res.code !== 0) return []
  return res.stdout
    .split('\x1e')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [head = '', ...rest] = chunk.split('\n')
      const [hash = '', short = '', date = '', subject = ''] = head.split('\x1f')
      const files = rest.map((f) => f.trim()).filter(Boolean)
      return { hash, short, date, subject, files: files.slice(0, 12) }
    })
}

export type CommitResult = { committed: true; hash: string } | { committed: false; reason: 'not_own_repo' | 'no_git' | 'nothing_to_commit' | 'failed'; detail?: string }

/**
 * Commit `file` (and nothing else) with `message`, only when the content root is the top level of its own repository.
 * In the current mixed repository (content/ inside the engine checkout) nothing is committed: the Dashboard says so.
 */
export async function commitContentFile(paths: Pick<ContentPaths, 'root' | 'mode'>, file: string, message: string): Promise<CommitResult> {
  if (paths.mode !== 'content') return { committed: false, reason: 'not_own_repo' }
  const top = await gitTop(paths.root)
  if (!top) return { committed: false, reason: 'no_git' }
  if (path.resolve(fs.realpathSync(top)) !== path.resolve(fs.realpathSync(paths.root))) return { committed: false, reason: 'not_own_repo' }
  const rel = path.relative(paths.root, file).replace(/\\/g, '/')
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { committed: false, reason: 'failed', detail: 'outside_content' }
  const add = await run('git', ['add', '--', rel], paths.root, 15_000)
  if (add.code !== 0) return { committed: false, reason: 'failed', detail: add.stderr.slice(0, 300) }
  const msg = message.replace(/[\r\n]+/g, ' ').slice(0, 200) || 'Dashboard edit'
  const commit = await run('git', ['commit', '-m', msg, '--', rel], paths.root, 30_000)
  if (commit.code !== 0) {
    return /nothing (added )?to commit|no changes added/i.test(commit.stdout + commit.stderr)
      ? { committed: false, reason: 'nothing_to_commit' }
      : { committed: false, reason: 'failed', detail: (commit.stderr || commit.stdout).slice(0, 300) }
  }
  const head = await run('git', ['rev-parse', '--short', 'HEAD'], paths.root, 10_000)
  return { committed: true, hash: head.stdout.trim() }
}

export const LIMIT_KEYS = [
  { key: 'AI_DAILY_LIMIT', def: 300, min: 1, max: 100000 },
  { key: 'AI_RATE_PER_MINUTE', def: 20, min: 1, max: 600 },
  { key: 'AI_MAX_CONCURRENT', def: 2, min: 1, max: 20 },
] as const

export interface ReaderLimit {
  key: string
  value: number
  source: 'server/.env' | 'default'
  min: number
  max: number
}

/** The reader limits lecture-api enforces, read (not written) from `server/.env`; integers only, defaults otherwise. */
export function readServerLimits(repoRoot: string): { file: string; exists: boolean; limits: ReaderLimit[]; port: number } {
  const file = path.join(repoRoot, 'server', '.env')
  const exists = fs.existsSync(file)
  const text = exists ? fs.readFileSync(file, 'utf8') : ''
  const get = (key: string): number | null => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"?(\\d+)"?\\s*(?:#.*)?$`, 'm').exec(text)
    return m ? Number(m[1]) : null
  }
  const limits = LIMIT_KEYS.map((k) => {
    const v = get(k.key)
    return { key: k.key, value: v ?? k.def, source: v === null ? ('default' as const) : ('server/.env' as const), min: k.min, max: k.max }
  })
  return { file: 'server/.env', exists, limits, port: get('PORT') ?? 8100 }
}

/** Is lecture-api answering on this machine? One GET of /api/health with a short timeout; never throws. */
export function probeLectureApi(port: number, timeoutMs = 1200): Promise<{ up: boolean; status?: number }> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve({ up: true, status: res.statusCode })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ up: false })
    })
    req.on('error', () => resolve({ up: false }))
  })
}

/** Time of the last production build (the access manifest every build writes), or null. */
export function lastBuildTime(siteRoot: string): string | null {
  const manifest = path.join(siteRoot, '.lecture-build', 'access-manifest.json')
  try {
    return fs.statSync(manifest).mtime.toISOString()
  } catch {
    return null
  }
}

// ---- companion › tools: content/ai-tools.json (engine tool switches, external MCP servers) ----

export const ENGINE_TOOL_IDS = ['search_concepts', 'get_concept', 'get_concept_graph', 'search_lectures', 'get_lecture_summary'] as const

export interface ToolsView {
  file: string
  exists: boolean
  /** Where the switches come from: the content file, the engine example (nothing saved yet), or nothing. */
  source: 'content' | 'example' | 'none'
  engine: Record<string, boolean>
  servers: Array<{ id: string; name: string; url: string; enabled: boolean; headers: Array<{ name: string; env: string; set: boolean }>; tools: Record<string, boolean>; timeoutMs: number | null }>
  /** lecture-api settings that shape the tool loop, read (never written) from server/.env. */
  settings: { provider: string; maxSteps: number; timeoutMs: number; maxResultBytes: number; mcpTokenSet: boolean; ticketSecretSet: boolean; source: 'server/.env' | 'default' }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function envTextOf(repoRoot: string): string {
  return ['.env', path.join('server', '.env')]
    .map((f) => {
      try {
        return fs.readFileSync(path.join(repoRoot, f), 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

/** Is `NAME=<something>` set in the repository or server .env? Only the yes/no leaves this function. */
function envIsSet(text: string, name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return false
  return new RegExp(`^\\s*${name}\\s*=\\s*\\S`, 'm').test(text)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function readToolsView(paths: Pick<ContentPaths, 'aiToolsFile' | 'aiToolsExample' | 'repoRoot'>): ToolsView {
  const exists = fs.existsSync(paths.aiToolsFile)
  const raw = exists ? readJsonObject(paths.aiToolsFile) : fs.existsSync(paths.aiToolsExample) ? readJsonObject(paths.aiToolsExample) : null
  const env = envTextOf(paths.repoRoot)
  const engineRaw = isObj(raw?.engineTools) ? raw.engineTools : {}
  const engine: Record<string, boolean> = {}
  for (const id of ENGINE_TOOL_IDS) {
    const e = engineRaw[id]
    // lecture-api (server/src/tools/mcpConfig.ts) treats a missing engine tool as switched on
    engine[id] = isObj(e) ? e.enabled !== false : true
  }
  const servers = (Array.isArray(raw?.mcpServers) ? raw.mcpServers : []).filter(isObj).map((s) => ({
    id: String(s.id ?? ''),
    name: String(s.name ?? s.id ?? ''),
    url: String(s.url ?? ''),
    enabled: s.enabled === true,
    headers: Object.entries(isObj(s.headerEnv) ? s.headerEnv : {}).map(([name, envName]) => ({ name, env: String(envName), set: envIsSet(env, String(envName)) })),
    tools: Object.fromEntries(Object.entries(isObj(s.tools) ? s.tools : {}).map(([k, v]) => [k, isObj(v) && v.enabled === true])),
    timeoutMs: typeof s.timeoutMs === 'number' ? s.timeoutMs : null,
  }))
  const num = (key: string, def: number): number => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"?(\\d+)"?\\s*(?:#.*)?$`, 'm').exec(env)
    return m ? Number(m[1]) : def
  }
  const prov = /^\s*AI_PROVIDER\s*=\s*"?([a-z]+)"?/m.exec(env)?.[1] ?? 'off'
  const anySet = /^\s*AI_(?:PROVIDER|TOOL_MAX_STEPS|TOOL_TIMEOUT_MS|TOOL_MAX_RESULT_BYTES)\s*=/m.test(env)
  return {
    file: path.relative(paths.repoRoot, paths.aiToolsFile).replace(/\\/g, '/'),
    exists,
    source: exists ? 'content' : raw ? 'example' : 'none',
    engine,
    servers,
    settings: {
      provider: prov,
      maxSteps: num('AI_TOOL_MAX_STEPS', 5),
      timeoutMs: num('AI_TOOL_TIMEOUT_MS', 8000),
      maxResultBytes: num('AI_TOOL_MAX_RESULT_BYTES', 24000),
      mcpTokenSet: envIsSet(env, 'AI_MCP_TOKEN'),
      ticketSecretSet: envIsSet(env, 'AI_MCP_TICKET_SECRET'),
      source: anySet ? 'server/.env' : 'default',
    },
  }
}

export interface ToolSwitches {
  engine?: Record<string, boolean>
  servers?: Record<string, { enabled?: boolean; tools?: Record<string, boolean> }>
}

/**
 * Apply on/off switches to content/ai-tools.json and write it (from the engine example when the file does not exist
 * yet). Only booleans of known entries change: no server, url, header or tool is added, renamed or removed here.
 */
export function writeToolSwitches(paths: Pick<ContentPaths, 'aiToolsFile' | 'aiToolsExample'>, sw: ToolSwitches): { ok: true } | { ok: false; error: string } {
  const base = fs.existsSync(paths.aiToolsFile) ? readJsonObject(paths.aiToolsFile) : readJsonObject(paths.aiToolsExample)
  if (!base) return { ok: false, error: 'tools_file_unreadable' }
  const next = JSON.parse(JSON.stringify(base)) as Record<string, unknown>
  if (sw.engine) {
    const eng = isObj(next.engineTools) ? next.engineTools : (next.engineTools = {})
    for (const [id, on] of Object.entries(sw.engine)) {
      if (!(ENGINE_TOOL_IDS as readonly string[]).includes(id) || typeof on !== 'boolean') return { ok: false, error: `unknown_engine_tool:${id}` }
      const cur = (eng as Record<string, unknown>)[id]
      ;(eng as Record<string, unknown>)[id] = { ...(isObj(cur) ? cur : {}), enabled: on }
    }
  }
  if (sw.servers) {
    const list = Array.isArray(next.mcpServers) ? next.mcpServers.filter(isObj) : []
    for (const [id, s] of Object.entries(sw.servers)) {
      const srv = list.find((x) => x.id === id)
      if (!srv) return { ok: false, error: `unknown_server:${id}` }
      if (s.enabled !== undefined) {
        if (typeof s.enabled !== 'boolean') return { ok: false, error: 'invalid_switch' }
        srv.enabled = s.enabled
      }
      for (const [k, on] of Object.entries(s.tools ?? {})) {
        const tools = isObj(srv.tools) ? srv.tools : null
        if (!tools || !(k in tools) || typeof on !== 'boolean') return { ok: false, error: `unknown_tool:${id}/${k}` }
        tools[k] = { ...(isObj(tools[k]) ? (tools[k] as Record<string, unknown>) : {}), enabled: on }
      }
    }
  }
  fs.mkdirSync(path.dirname(paths.aiToolsFile), { recursive: true })
  fs.writeFileSync(paths.aiToolsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return { ok: true }
}
