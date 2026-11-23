/**
 * Safe relative path and external URL guards for figure registries and gallery inputs.
 * Rejects protocols, `//`, `..` / `.` segments, backslashes, leading slashes, Windows drives,
 * query/hash strings, control characters, and repeated/invalid percent-encoding.
 */

export const DEFAULT_FIGURE_EXTS = ['.svg', '.webp', '.png', '.jpg', '.jpeg'] as const
export const ORIGINAL_FIGURE_EXTS = ['.pdf', '.svg', '.webp', '.png', '.jpg', '.jpeg'] as const

const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/
const DRIVE_RE = /^[a-zA-Z]:/
const PCT_TOKEN_RE = /%[0-9a-fA-F]{2}/

export interface PathGuardOptions {
  allowedExts?: readonly string[]
}

export type PathGuardResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: string }

function hasControlChar(candidate: string): boolean {
  for (let i = 0; i < candidate.length; i++) {
    const code = candidate.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function hasUnsafeSyntax(candidate: string): string | null {
  if (!candidate) return 'empty path'
  if (hasControlChar(candidate)) return 'control character in path'
  if (candidate.includes('\\')) return 'backslash is not allowed'
  if (candidate.includes('?') || candidate.includes('#')) return 'query or fragment is not allowed'
  if (candidate.startsWith('/')) return 'absolute leading slash is not allowed'
  if (DRIVE_RE.test(candidate)) return 'drive prefix is not allowed'
  if (SCHEME_RE.test(candidate)) return 'URL scheme is not allowed'
  if (candidate.includes('//')) return 'double slash is not allowed'
  const parts = candidate.split('/')
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return 'empty, `.` or `..` path segment is not allowed'
  }
  return null
}

/**
 * Validate a relative asset path inside `<figuresDir>/<group>/`.
 */
export function validateSafeFigureRelPath(raw: unknown, opts: PathGuardOptions = {}): PathGuardResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'path must be a string' }
  let cur: string = raw
  const trimmed = cur.trim()
  if (!trimmed || trimmed !== cur) return { ok: false, reason: 'path must not be empty or padded with whitespace' }

  const rawIssue = hasUnsafeSyntax(cur)
  if (rawIssue) return { ok: false, reason: rawIssue }

  if (cur.includes('%')) {
    // Reject repeated percent-encoding (`%25...`) or malformed escapes.
    let decoded: string
    try {
      decoded = decodeURIComponent(cur)
    } catch {
      return { ok: false, reason: 'malformed percent-encoding' }
    }
    if (decoded !== cur && (decoded.includes('%') || PCT_TOKEN_RE.test(decoded))) {
      return { ok: false, reason: 'repeated percent-encoding is not allowed' }
    }
    const decodedIssue = hasUnsafeSyntax(decoded)
    if (decodedIssue) return { ok: false, reason: `decoded path invalid: ${decodedIssue}` }
    cur = decoded
  }

  const allowed = opts.allowedExts ?? DEFAULT_FIGURE_EXTS
  const lower = cur.toLowerCase()
  const extOk = allowed.some((ext) => lower.endsWith(ext))
  if (!extOk) return { ok: false, reason: `unsupported file extension (allowed: ${allowed.join(', ')})` }

  return { ok: true, normalized: cur }
}

/** Validate optional external reference URLs (`http:` / `https:` only). */
export function validateExternalUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

/** Validate optional DOI string (`10.<registrant>/<suffix>` without whitespace or URL prefix). */
export function validateDoi(raw: unknown): boolean {
  if (typeof raw !== 'string' || !raw.trim()) return false
  return /^10\.\d{4,9}\/\S+$/.test(raw) && !hasControlChar(raw)
}
