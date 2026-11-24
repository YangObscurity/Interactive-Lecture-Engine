/**
 * theme/api/auth.ts — WP-4 Auth, Passkey/WebAuthn, Personal Learning & Account Security API client.
 *
 * All network requests use `credentials: 'include'` and `cache: 'no-store'`, resolve URLs through
 * `resolveApiUrl` (admin.ts), and throw a typed `ApiHttpError` on non-2xx or network failures.
 * Every browser API (`window`, `navigator.credentials`, `PublicKeyCredential`) is SSR-guarded.
 */
import { resolveApiUrl } from './admin'

export class ApiHttpError extends Error {
  readonly status: number
  readonly error: string
  readonly details?: unknown

  constructor(status: number, error: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiHttpError'
    this.status = status
    this.error = error
    if (details !== undefined) {
      this.details = details
    }
  }
}

export interface AuthUserInfo {
  id: string
  username?: string
  name: string | null
  email: string | null
}

export interface AuthStatus {
  authAdapter: string
  authenticated: boolean
  needsBootstrap: boolean
  authSource: string
  authMethod: string
  rememberMe: boolean
  user: AuthUserInfo | null
  roles: string[]
  groups: string[]
  canAccessAdmin: boolean
  canAccessAuthor: boolean
  visibleSections: string[]
}

export interface AuthMethodInfo {
  id: string
  name: string
  description: string
  enabled: boolean
  implemented: boolean
  extensible: boolean
  endpoints?: Record<string, string>
}

export interface AuthLoginResult {
  ok: boolean
  authenticated: boolean
  user: AuthUserInfo
  roles: string[]
  groups: string[]
  canAccessAdmin: boolean
  canAccessAuthor: boolean
}

export interface MyOverviewSession {
  id: string
  lecture_id: string
  group_id: string
  title: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

export interface MyOverview {
  user: {
    id: string
    username: string
    displayName: string
    email: string | null
  }
  progress: {
    total: number
    completed: number
    in_progress: number
  }
  recentSessions: MyOverviewSession[]
  checklists: {
    total: number
    completed: number
  }
  passkeyCount: number
  currentSessionId: string | null
  authMethod: string
  rememberMe: boolean
}

export interface MyLearningExport {
  exportedAt: string
  profile: {
    id: string
    username: string
    displayName: string
    email: string | null
    createdAt?: string
  }
  progress: Array<Record<string, unknown>>
  aiSessions: Array<Record<string, unknown>>
  aiReviewChecklists: Array<Record<string, unknown>>
}

export interface MyCredential {
  id: string
  method: string
  credential_id: string
  algorithm: number
  label: string
  aaguid: string
  last_used_at: string | null
  created_at: string
}

export interface MyAuthSession {
  id: string
  auth_method: string
  remember_me: boolean
  user_agent: string
  ip_address: string
  expires_at: string
  created_at: string
  last_seen_at: string
  is_current: boolean
}

// ── Base64URL <-> ArrayBuffer helpers (pure RFC 4648, SSR-safe) ──────────────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function bufferToBase64url(input: ArrayBuffer | ArrayBufferView): string {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += B64_ALPHABET[(triple >> 18) & 0x3f]
    out += B64_ALPHABET[(triple >> 12) & 0x3f]
    if (b1 !== undefined) out += B64_ALPHABET[(triple >> 6) & 0x3f]
    if (b2 !== undefined) out += B64_ALPHABET[triple & 0x3f]
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_')
}

export function base64urlToUint8Array(b64url: string): Uint8Array<ArrayBuffer> {
  const clean = b64url.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (clean.length % 4 === 1 || !/^[A-Za-z0-9+/]*$/.test(clean)) {
    throw new Error('invalid_base64url')
  }
  const outLen = Math.floor((clean.length * 3) / 4)
  const out = new Uint8Array(new ArrayBuffer(outLen))
  let pos = 0
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_ALPHABET.indexOf(clean[i] ?? '')
    const c1 = B64_ALPHABET.indexOf(clean[i + 1] ?? '')
    const c2 = i + 2 < clean.length ? B64_ALPHABET.indexOf(clean[i + 2] ?? '') : -1
    const c3 = i + 3 < clean.length ? B64_ALPHABET.indexOf(clean[i + 3] ?? '') : -1
    if (c0 < 0 || c1 < 0) {
      throw new Error('invalid_base64url')
    }
    out[pos++] = (c0 << 2) | (c1 >> 4)
    if (c2 >= 0 && pos < outLen) out[pos++] = ((c1 & 0x0f) << 4) | (c2 >> 2)
    if (c3 >= 0 && pos < outLen) out[pos++] = ((c2 & 0x03) << 6) | c3
  }
  return out
}

export function isWebAuthnSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  if (typeof window.PublicKeyCredential === 'undefined') return false
  return (
    typeof navigator.credentials?.get === 'function' &&
    typeof navigator.credentials?.create === 'function'
  )
}

// ── Internal HTTP helpers ────────────────────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export const DEFAULT_AUTH_TIMEOUT_MS = 15_000

async function rawRequest(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
): Promise<{ res: Response; data: unknown }> {
  const fetchFn = typeof window !== 'undefined' && typeof fetch === 'function' ? fetch : null
  if (!fetchFn) {
    throw new ApiHttpError(0, 'network_unavailable', 'Fetch is unavailable in SSR environment')
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
      throw new ApiHttpError(0, 'timeout', 'Request timed out')
    }
    throw new ApiHttpError(
      0,
      'network_error',
      err instanceof Error ? err.message : String(err),
    )
  }

  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.redirected) {
    clearTimeout(timer)
    throw new ApiHttpError(
      res.status || 302,
      'auth_redirect',
      'Request was redirected by gateway; please re-authenticate',
    )
  }

  let text = ''
  try {
    text = await res.text()
  } catch (err) {
    if (timedOut) {
      throw new ApiHttpError(0, 'timeout', 'Request timed out')
    }
    throw new ApiHttpError(
      res.status,
      'read_error',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timer)
  }

  let parsed: unknown = null
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      if (!res.ok) {
        throw new ApiHttpError(res.status, `http_${res.status}`, `HTTP ${res.status}`)
      }
      throw new ApiHttpError(res.status, 'invalid_json', 'Server returned invalid JSON')
    }
  }

  if (!res.ok) {
    const rec = isObj(parsed) ? parsed : {}
    const code = typeof rec.error === 'string' && rec.error ? rec.error : `http_${res.status}`
    const msg = typeof rec.message === 'string' && rec.message ? rec.message : `HTTP ${res.status} (${code})`
    throw new ApiHttpError(res.status, code, msg, rec.errors ?? rec.details)
  }

  return { res, data: parsed }
}

async function apiJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await rawRequest(method, path, body)
  return data as T
}

// ── Public Auth APIs ─────────────────────────────────────────────────────────────────────────────

export function fetchAuthStatus(): Promise<AuthStatus> {
  return apiJson<AuthStatus>('GET', '/api/auth/status')
}

export async function fetchAuthMethods(): Promise<AuthMethodInfo[]> {
  const data = await apiJson<{ ok: boolean; methods: AuthMethodInfo[] }>('GET', '/api/auth/methods')
  return Array.isArray(data.methods) ? data.methods : []
}

export function bootstrapAdmin(payload: {
  username: string
  password: string
  displayName?: string
  email?: string
  rememberMe?: boolean
}): Promise<AuthLoginResult> {
  return apiJson<AuthLoginResult>('POST', '/api/auth/bootstrap', payload)
}

export function loginWithPassword(payload: {
  username: string
  password: string
  rememberMe?: boolean
}): Promise<AuthLoginResult> {
  return apiJson<AuthLoginResult>('POST', '/api/auth/login', payload)
}

export function logoutSession(): Promise<{ ok: boolean; logoutUrl: string | null }> {
  return apiJson<{ ok: boolean; logoutUrl: string | null }>('POST', '/api/auth/logout', {})
}

interface PasskeyLoginStartOptions {
  challenge: string
  rpId?: string
  timeout?: number
  userVerification?: UserVerificationRequirement
  allowCredentials?: Array<{
    id: string
    type: 'public-key'
    transports?: AuthenticatorTransport[]
  }>
}

function wrapWebAuthnError(err: unknown): never {
  if (err instanceof ApiHttpError) throw err
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    const code =
      err.name === 'NotAllowedError' || err.name === 'AbortError'
        ? 'passkey_cancelled'
        : err.name === 'InvalidStateError'
          ? 'passkey_already_registered'
          : err.name === 'SecurityError'
            ? 'webauthn_security_error'
            : `webauthn_${err.name.toLowerCase()}`
    throw new ApiHttpError(0, code, err.message || err.name)
  }
  if (err instanceof Error) {
    throw new ApiHttpError(0, 'webauthn_error', err.message)
  }
  throw new ApiHttpError(0, 'webauthn_error', String(err))
}

export async function loginWithPasskey(options: {
  username?: string
  rememberMe?: boolean
} = {}): Promise<AuthLoginResult> {
  if (!isWebAuthnSupported()) {
    throw new ApiHttpError(0, 'webauthn_unsupported', 'WebAuthn / Passkey is not supported in this browser')
  }

  const startPayload = options.username?.trim() ? { username: options.username.trim() } : {}
  const serverOpts = await apiJson<PasskeyLoginStartOptions>(
    'POST',
    '/api/auth/methods/passkey/login/start',
    startPayload,
  )

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64urlToUint8Array(serverOpts.challenge),
    ...(serverOpts.rpId ? { rpId: serverOpts.rpId } : {}),
    ...(serverOpts.timeout ? { timeout: serverOpts.timeout } : {}),
    ...(serverOpts.userVerification ? { userVerification: serverOpts.userVerification } : {}),
    allowCredentials: (serverOpts.allowCredentials ?? []).map((item) => ({
      id: base64urlToUint8Array(item.id),
      type: 'public-key',
      ...(item.transports ? { transports: item.transports } : {}),
    })),
  }

  let cred: Credential | null
  try {
    cred = await navigator.credentials.get({ publicKey })
  } catch (err) {
    wrapWebAuthnError(err)
  }
  if (typeof cred !== 'object' || cred === null || !('response' in cred)) {
    throw new ApiHttpError(0, 'passkey_cancelled', 'Passkey authentication was cancelled')
  }

  const pkCred = cred as PublicKeyCredential
  const resp = pkCred.response as AuthenticatorAssertionResponse

  return apiJson<AuthLoginResult>('POST', '/api/auth/methods/passkey/login/finish', {
    id: pkCred.id,
    rawId: bufferToBase64url(pkCred.rawId),
    response: {
      clientDataJSON: bufferToBase64url(resp.clientDataJSON),
      authenticatorData: bufferToBase64url(resp.authenticatorData),
      signature: bufferToBase64url(resp.signature),
      ...(resp.userHandle && resp.userHandle.byteLength > 0
        ? { userHandle: bufferToBase64url(resp.userHandle) }
        : {}),
    },
    ...(options.rememberMe !== undefined ? { rememberMe: options.rememberMe } : {}),
  })
}

interface PasskeyRegisterStartOptions {
  challenge: string
  rp: { id?: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: PublicKeyCredentialParameters[]
  timeout?: number
  attestation?: AttestationConveyancePreference
  excludeCredentials?: Array<{
    id: string
    type: 'public-key'
    transports?: AuthenticatorTransport[]
  }>
  authenticatorSelection?: AuthenticatorSelectionCriteria
}

export async function registerPasskey(
  options: { label?: string } = {},
): Promise<{ ok: boolean; credentialId: string; label: string }> {
  if (!isWebAuthnSupported()) {
    throw new ApiHttpError(0, 'webauthn_unsupported', 'WebAuthn / Passkey is not supported in this browser')
  }

  const serverOpts = await apiJson<PasskeyRegisterStartOptions>(
    'POST',
    '/api/me/passkeys/register/start',
    {},
  )

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: base64urlToUint8Array(serverOpts.challenge),
    rp: serverOpts.rp,
    user: {
      id: base64urlToUint8Array(serverOpts.user.id),
      name: serverOpts.user.name,
      displayName: serverOpts.user.displayName,
    },
    pubKeyCredParams: serverOpts.pubKeyCredParams,
    ...(serverOpts.timeout ? { timeout: serverOpts.timeout } : {}),
    ...(serverOpts.attestation ? { attestation: serverOpts.attestation } : {}),
    ...(serverOpts.authenticatorSelection ? { authenticatorSelection: serverOpts.authenticatorSelection } : {}),
    excludeCredentials: (serverOpts.excludeCredentials ?? []).map((item) => ({
      id: base64urlToUint8Array(item.id),
      type: 'public-key',
      ...(item.transports ? { transports: item.transports } : {}),
    })),
  }

  let cred: Credential | null
  try {
    cred = await navigator.credentials.create({ publicKey })
  } catch (err) {
    wrapWebAuthnError(err)
  }
  if (typeof cred !== 'object' || cred === null || !('response' in cred)) {
    throw new ApiHttpError(0, 'passkey_cancelled', 'Passkey registration was cancelled')
  }

  const pkCred = cred as PublicKeyCredential
  const resp = pkCred.response as AuthenticatorAttestationResponse & {
    getTransports?: () => string[]
  }
  const transports = typeof resp.getTransports === 'function' ? resp.getTransports() : []

  return apiJson<{ ok: boolean; credentialId: string; label: string }>(
    'POST',
    '/api/me/passkeys/register/finish',
    {
      id: pkCred.id,
      rawId: bufferToBase64url(pkCred.rawId),
      response: {
        clientDataJSON: bufferToBase64url(resp.clientDataJSON),
        attestationObject: bufferToBase64url(resp.attestationObject),
        transports,
      },
      ...(options.label?.trim() ? { label: options.label.trim() } : {}),
    },
  )
}

// ── Personal Learning & Account Security (/api/me/*) ─────────────────────────────────────────────

export function fetchMyOverview(): Promise<MyOverview> {
  return apiJson<MyOverview>('GET', '/api/me/overview')
}

export async function downloadMyExport(): Promise<{ data: MyLearningExport; filename: string }> {
  const { res, data } = await rawRequest('GET', '/api/me/export')
  const disp = res.headers.get('content-disposition') ?? ''
  const match = /filename="?([^";]+)"?/i.exec(disp)
  const filename = match?.[1]?.trim() || 'my-learning-export.json'
  return { data: data as MyLearningExport, filename }
}

export async function deleteMyAiSession(sessionId: string): Promise<void> {
  await rawRequest('DELETE', `/api/db/sessions/${encodeURIComponent(sessionId)}`)
}

export function changeMyPassword(payload: {
  currentPassword?: string
  newPassword: string
}): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>('PUT', '/api/me/password', payload)
}

export function fetchMyCredentials(): Promise<MyCredential[]> {
  return apiJson<MyCredential[]>('GET', '/api/me/credentials')
}

export function deleteMyCredential(id: string): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>('DELETE', `/api/me/credentials/${encodeURIComponent(id)}`)
}

export function fetchMySessions(): Promise<MyAuthSession[]> {
  return apiJson<MyAuthSession[]>('GET', '/api/me/sessions')
}

export function revokeMySession(id: string): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>('DELETE', `/api/me/sessions/${encodeURIComponent(id)}`)
}
