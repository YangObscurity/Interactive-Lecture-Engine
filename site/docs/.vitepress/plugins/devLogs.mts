/**
 * plugins/devLogs.mts — the dev server's log ring for the Dashboard page "运行状态 › 终端日志" (S4b).
 *
 * Lines are redacted BEFORE they are stored: user names, e-mail addresses, IP addresses, bearer tokens, API keys and the
 * values of secret-looking variables never enter the ring, so nothing unmasked can be served. The ring lives on globalThis
 * so a VitePress restart (config change) keeps the history and does not add a second capture. Node only.
 */

export type DevLogSource = 'dev' | 'sync' | 'build' | 'api'
export type DevLogLevel = 'info' | 'warn' | 'err'

export interface DevLogLine {
  seq: number
  /** ISO time. */
  t: string
  src: DevLogSource
  lv: DevLogLevel
  msg: string
}

const MAX_LINES = 500
const KEY = Symbol.for('lecture.devLogs')

interface Ring {
  seq: number
  lines: DevLogLine[]
}

function ring(): Ring {
  const g = globalThis as { [KEY]?: Ring }
  if (!g[KEY]) g[KEY] = { seq: 0, lines: [] }
  return g[KEY]
}

// ANSI colour codes from Vite's logger
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g

const SECRET_NAME = '(?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|SESSION)[A-Z0-9_]*)'

/** Mask personal data and secrets in one log line. Exported for tests. */
export function redactLogLine(raw: string): string {
  let s = raw.replace(ANSI_RE, '')
  // NAME=value / NAME: value for secret-looking names
  s = s.replace(new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|\\S+)`, 'gi'), (_m, name: string, sep: string) => `${name}${sep}***`)
  // Authorization headers and bearer tokens
  s = s.replace(/\b(authorization\s*[:=]\s*)(bearer|basic)?\s*\S+/gi, (_m, head: string, scheme?: string) => `${head}${scheme ? `${scheme} ` : ''}***`)
  s = s.replace(/\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
  // key-shaped strings (sk-..., app-..., ghp_..., xox..., long hex / base64 runs)
  s = s.replace(/\b(?:sk|pk|rk|app|key|ghp|gho|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}\b/g, (m) => `${m.slice(0, 4)}***`)
  s = s.replace(/\b[A-Fa-f0-9]{32,}\b/g, '***')
  // user identities: user=..., Remote-User: ..., x-forwarded-user: ...
  s = s.replace(/\b((?:remote|x-forwarded|x-auth|x-webauth)-user\s*[:=]\s*)\S+/gi, '$1***')
  s = s.replace(/\b(user(?:name|_?id)?\s*[=:]\s*)("[^"]*"|[^\s,;&]+)/gi, (_m, head: string, v: string) => `${head}${v.replace(/^"|"$/g, '').slice(0, 1)}***`)
  // e-mail, IPv4, IPv6
  s = s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***:***@') // user:password@ in URLs
  s = s.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '$1***@***')
  // the account name inside home-folder paths (Windows "Users" folders, macOS "Users", Linux "home")
  s = s.replace(/\b([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\s"'`]+/gi, '$1***')
  s = s.replace(/(^|[\s"'`(=])(\/(?:Users|home)\/)[^/\s"'`]+/g, '$1$2***')
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => (ip === '127.0.0.1' || ip === '0.0.0.0' ? ip : '*.*.*.*'))
  s = s.replace(/(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, (ip) =>
    // clock times (22:18:03) and plain numbers stay: an IPv6 address has a hex letter or "::"
    ip === '::1' || !(/[a-f]/i.test(ip) || ip.includes('::')) ? ip : '****:****',
  )
  return s.replace(/[\r\n]+/g, ' ').trim()
}

/** Store one line (redacted). Empty lines are dropped. */
export function pushDevLog(src: DevLogSource, lv: DevLogLevel, raw: string, now: Date = new Date()): void {
  const msg = redactLogLine(raw)
  if (!msg) return
  const r = ring()
  r.seq += 1
  r.lines.push({ seq: r.seq, t: now.toISOString(), src, lv, msg: msg.length > 2000 ? `${msg.slice(0, 2000)} …` : msg })
  if (r.lines.length > MAX_LINES) r.lines.splice(0, r.lines.length - MAX_LINES)
}

/** Lines after `after` (a seq), oldest first. */
export function readDevLogs(after = 0): { lines: DevLogLine[]; last: number } {
  const r = ring()
  return { lines: r.lines.filter((l) => l.seq > after), last: r.seq }
}

/** Tests only. */
export function clearDevLogs(): void {
  const r = ring()
  r.lines = []
}

interface LoggerLike {
  info: (msg: string, options?: never) => void
  warn: (msg: string, options?: never) => void
  warnOnce?: (msg: string, options?: never) => void
  error: (msg: string, options?: never) => void
}

const WRAPPED = Symbol.for('lecture.devLogs.wrapped')

/** Copy every message of the Vite dev server logger into the ring (once per logger object). */
export function captureViteLogger(logger: LoggerLike): void {
  const l = logger as LoggerLike & { [WRAPPED]?: true }
  if (l[WRAPPED]) return
  l[WRAPPED] = true
  const wrap = (name: 'info' | 'warn' | 'warnOnce' | 'error', lv: DevLogLevel) => {
    const orig = l[name]
    if (typeof orig !== 'function') return
    l[name] = (msg: string, options?: never) => {
      try {
        const text = String(msg)
        // the content watcher reports through the same logger, tagged `[content:watch]` / `[content:sync]`
        pushDevLog(/\[content:(?:watch|sync)\]/.test(text) ? 'sync' : 'dev', lv, text)
      } catch {
        // logging must never break the server
      }
      orig.call(logger, msg, options)
    }
  }
  wrap('info', 'info')
  wrap('warn', 'warn')
  wrap('warnOnce', 'warn')
  wrap('error', 'err')
}
