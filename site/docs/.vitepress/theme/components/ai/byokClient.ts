/**
 * byokClient.ts — Browser-direct OpenAI-compatible BYOK configuration & request builder (P6, spec board §02 & §14).
 *
 * Security invariants (D-01, D-14):
 *   - HTTPS endpoints only (`http://` refused).
 *   - "Remember on this device" (`remember`) is OFF by default:
 *       * `false` -> kept strictly in module memory (cleared on tab close; never in localStorage or sessionStorage)
 *       * `true`  -> persisted in localStorage; unchecking deletes stored credentials immediately
 *   - Never sent to any `/api/*` endpoint on our server.
 */
import { API_ENDPOINTS, STORAGE_KEYS } from '../../../site.config.mts'
import {
  assembleOpenAiMessages,
  type CompanionPromptsFile,
  type OpenAiHistoryTurn,
  type PromptLang,
} from '../../../prompts/companion.ts'
import { getCompanionPrompts } from '../../../prompts/store.ts'

export interface ByokConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
  remember: boolean
}

export type ByokVerifyStatus = 'unverified' | 'ok' | 'failed'

export interface ByokVerifyResult {
  status: ByokVerifyStatus
  ok: boolean
  httpStatus?: number
  message?: string
}

export const BYOK_CHANGED_EVENT = 'lecture:byok-changed'
export const BYOK_STATUS_EVENT = 'lecture:byok-status-changed'
export const DEFAULT_BYOK_TIMEOUT_MS = 60_000
export const BYOK_TEST_TIMEOUT_MS = 15_000

export const EMPTY_BYOK_CONFIG: Readonly<ByokConfig> = Object.freeze({
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  remember: false,
})

let memoryConfig: ByokConfig | null = null
let currentVerifyStatus: ByokVerifyStatus = 'unverified'
let lastVerifyError = ''
/** Credentials (endpoint|key|model) the current verify status was earned with; '' while unverified. */
let verifiedFingerprint = ''

function fingerprint(c: Pick<ByokConfig, 'baseUrl' | 'apiKey' | 'model'>): string {
  return `${c.baseUrl.trim()}|${c.apiKey.trim()}|${c.model.trim()}`
}

export function isValidByokUrl(raw: string): boolean {
  const trimmed = raw.trim()
  if (!trimmed) return false
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'https:' || !u.hostname) return false
    // never let the key ride to our own /api/* (same origin), even by typing the site's own address
    if (typeof window !== 'undefined' && u.origin === window.location.origin && /^\/api(?:\/|$)/i.test(u.pathname)) {
      return false
    }
    return true
  } catch {
    return false
  }
}

export function sanitizeByokConfig(raw: unknown, defaultRemember = false): ByokConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...EMPTY_BYOK_CONFIG }
  }
  const obj = raw as Record<string, unknown>
  return {
    enabled: obj.enabled === true,
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl.trim() : '',
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey.trim() : '',
    model: typeof obj.model === 'string' ? obj.model.trim() : '',
    remember: typeof obj.remember === 'boolean' ? obj.remember : defaultRemember,
  }
}

function removeStoredByok(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage?.removeItem(STORAGE_KEYS.companionByok)
  } catch {
    // ignore storage failure
  }
  try {
    window.sessionStorage?.removeItem(STORAGE_KEYS.companionByok)
  } catch {
    // ignore storage failure
  }
}

function emitByokChanged(cfg: ByokConfig): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(BYOK_CHANGED_EVENT, { detail: { ...cfg } }))
  } catch {
    // ignore
  }
}

export function getByokVerifyState(): { status: ByokVerifyStatus; error: string } {
  return { status: currentVerifyStatus, error: lastVerifyError }
}

export function setByokVerifyState(status: ByokVerifyStatus, error = ''): void {
  currentVerifyStatus = status
  lastVerifyError = error
  verifiedFingerprint = status === 'unverified' ? '' : fingerprint(readByokConfig())
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(BYOK_STATUS_EVENT, { detail: { status, error } }))
  } catch {
    // ignore
  }
}

export function resetByokRuntimeForTest(): void {
  memoryConfig = null
  currentVerifyStatus = 'unverified'
  lastVerifyError = ''
  verifiedFingerprint = ''
  removeStoredByok()
}

export function readByokConfig(): ByokConfig {
  if (memoryConfig !== null) {
    return { ...memoryConfig }
  }
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return { ...EMPTY_BYOK_CONFIG }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEYS.companionByok)
    if (!raw) return { ...EMPTY_BYOK_CONFIG }
    const parsed = sanitizeByokConfig(JSON.parse(raw), true)
    memoryConfig = parsed
    return { ...parsed }
  } catch {
    return { ...EMPTY_BYOK_CONFIG }
  }
}

export function writeByokConfig(patch: Partial<ByokConfig>): ByokConfig {
  const prev = readByokConfig()
  const next = sanitizeByokConfig({ ...prev, ...patch }, patch.remember ?? prev.remember)
  memoryConfig = next

  if (next.remember) {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEYS.companionByok, JSON.stringify(next))
      } catch {
        // ignore storage failure; memoryConfig still holds the value for this session
      }
    }
    try {
      window.sessionStorage?.removeItem(STORAGE_KEYS.companionByok)
    } catch {
      // ignore
    }
  } else {
    removeStoredByok()
  }

  // a real request (Test button or a chat) earned the status for exactly these credentials: keep it on Save
  if (!next.enabled || fingerprint(next) !== verifiedFingerprint) {
    setByokVerifyState('unverified', '')
  }
  emitByokChanged(next)
  return { ...next }
}

export function clearByokConfig(): ByokConfig {
  memoryConfig = { ...EMPTY_BYOK_CONFIG }
  removeStoredByok()
  setByokVerifyState('unverified', '')
  emitByokChanged({ ...EMPTY_BYOK_CONFIG })
  return { ...EMPTY_BYOK_CONFIG }
}

export function isByokActive(cfg: ByokConfig): boolean {
  return (
    cfg.enabled &&
    isValidByokUrl(cfg.baseUrl) &&
    cfg.apiKey.trim().length > 0 &&
    cfg.model.trim().length > 0
  )
}

export function extractEndpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).host
  } catch {
    return baseUrl.trim().replace(/^https?:\/\//i, '').split('/')[0] || ''
  }
}

export function buildOpenAiChatUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, '')
  if (clean.endsWith('/chat/completions')) {
    return clean
  }
  return `${clean}/chat/completions`
}

export interface OpenAiRequestInputs {
  current_lecture?: string
  group?: string
  outline?: string
  selection?: string
}

export type { OpenAiHistoryTurn }

export interface BuildOpenAiChatOptions {
  actionId?: string
  lang?: PromptLang
  prompts?: CompanionPromptsFile
  tools?: readonly OpenAiToolDefinition[]
  messagesOverride?: readonly OpenAiChatLoopMessage[]
}

export interface ReaderToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ReaderToolsCatalog {
  maxSteps: number
  tools: ReaderToolDefinition[]
}

export interface OpenAiToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type OpenAiChatLoopMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export function toOpenAiTools(tools: readonly ReaderToolDefinition[]): OpenAiToolDefinition[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

export function buildOpenAiInitialMessages(
  query: string,
  inputs: OpenAiRequestInputs,
  history: readonly OpenAiHistoryTurn[] = [],
  options: Pick<BuildOpenAiChatOptions, 'actionId' | 'lang' | 'prompts'> = {},
): OpenAiChatLoopMessage[] {
  const assembled = assembleOpenAiMessages({
    prompts: options.prompts ?? getCompanionPrompts(),
    lang: options.lang ?? 'zh',
    query,
    actionId: options.actionId,
    inputs,
    history,
  })
  return assembled.messages.map((m) => ({ role: m.role, content: m.content }))
}

export async function fetchReaderTools(
  fetchFn: typeof fetch = fetch,
  endpoint: string = API_ENDPOINTS.aiTools,
  signal?: AbortSignal,
): Promise<ReaderToolsCatalog> {
  try {
    const res = await fetchFn(endpoint, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) {
      return { maxSteps: 1, tools: [] }
    }
    const json = (await res.json()) as {
      maxSteps?: unknown
      tools?: Array<{ name?: unknown; description?: unknown; parameters?: unknown }>
    } | null
    if (!json || !Array.isArray(json.tools)) {
      return { maxSteps: 1, tools: [] }
    }
    const tools: ReaderToolDefinition[] = []
    for (const item of json.tools) {
      if (
        item &&
        typeof item.name === 'string' &&
        item.name.trim() &&
        item.parameters &&
        typeof item.parameters === 'object' &&
        !Array.isArray(item.parameters)
      ) {
        tools.push({
          name: item.name.trim(),
          description: typeof item.description === 'string' ? item.description : '',
          parameters: item.parameters as Record<string, unknown>,
        })
      }
    }
    const rawSteps = typeof json.maxSteps === 'number' && Number.isFinite(json.maxSteps) ? Math.floor(json.maxSteps) : 5
    return {
      maxSteps: Math.max(1, Math.min(20, rawSteps)),
      tools,
    }
  } catch {
    return { maxSteps: 1, tools: [] }
  }
}

export async function executeReaderToolCall(
  name: string,
  rawArgs: string,
  fetchFn: typeof fetch = fetch,
  baseEndpoint: string = API_ENDPOINTS.aiTools,
  signal?: AbortSignal,
): Promise<{ ok: boolean; content: string }> {
  // the name comes from the model: only a plain tool identifier may become a path segment ("." or ".." would leave /api/tools/)
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
    return { ok: false, content: JSON.stringify({ error: 'unknown_tool' }) }
  }
  let parsedArgs: Record<string, unknown>
  const trimmed = (rawArgs ?? '').trim()
  if (!trimmed) {
    parsedArgs = {}
  } else {
    try {
      const val = JSON.parse(trimmed) as unknown
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        return { ok: false, content: JSON.stringify({ error: 'invalid_arguments' }) }
      }
      parsedArgs = val as Record<string, unknown>
    } catch {
      return { ok: false, content: JSON.stringify({ error: 'invalid_arguments' }) }
    }
  }

  try {
    const cleanBase = baseEndpoint.replace(/\/+$/, '')
    const res = await fetchFn(`${cleanBase}/${encodeURIComponent(name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(parsedArgs),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok) {
      let code = `http_${res.status}`
      try {
        const errBody = (await res.json()) as { error?: unknown } | null
        if (errBody && typeof errBody.error === 'string' && errBody.error.trim()) {
          code = errBody.error.trim()
        }
      } catch {
        // keep http_<status> fallback
      }
      return { ok: false, content: JSON.stringify({ error: code }) }
    }
    const data = (await res.json()) as unknown
    return { ok: true, content: JSON.stringify(data) }
  } catch {
    return { ok: false, content: JSON.stringify({ error: 'network_error' }) }
  }
}

export interface OpenAiToolCallAccumulator {
  pushDelta(delta: {
    index: number
    id?: string
    callType?: string
    name?: string
    argumentsChunk?: string
  }): void
  finalize(): OpenAiToolCall[]
}

export function createOpenAiToolCallAccumulator(): OpenAiToolCallAccumulator {
  const byIndex = new Map<number, { id: string; name: string; args: string }>()
  return {
    pushDelta(delta) {
      const idx = Number.isInteger(delta.index) && delta.index >= 0 ? delta.index : 0
      const slot = byIndex.get(idx) ?? { id: '', name: '', args: '' }
      if (delta.id && !slot.id) {
        slot.id = delta.id
      }
      if (delta.name && !slot.name) {
        slot.name = delta.name
      }
      if (typeof delta.argumentsChunk === 'string' && delta.argumentsChunk.length > 0) {
        slot.args += delta.argumentsChunk
      }
      byIndex.set(idx, slot)
    },
    finalize() {
      return [...byIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, slot]) => slot.name.trim().length > 0)
        .map(([idx, slot]) => ({
          id: slot.id || `call_${idx + 1}`,
          type: 'function' as const,
          function: {
            name: slot.name.trim(),
            arguments: slot.args,
          },
        }))
    },
  }
}

export function buildOpenAiChatRequest(
  cfg: ByokConfig,
  query: string,
  inputs: OpenAiRequestInputs,
  history: readonly OpenAiHistoryTurn[] = [],
  options: BuildOpenAiChatOptions = {},
): { url: string; init: RequestInit } {
  const messages =
    options.messagesOverride ??
    buildOpenAiInitialMessages(query, inputs, history, options)

  const payload: Record<string, unknown> = {
    model: cfg.model.trim(),
    stream: true,
    stream_options: { include_usage: true },
    messages,
  }
  if (options.tools && options.tools.length > 0) {
    payload.tools = options.tools
  }

  return {
    url: buildOpenAiChatUrl(cfg.baseUrl),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify(payload),
    },
  }
}

/**
 * Probe the reader's BYOK endpoint with a real minimal request. Updates `getByokVerifyState()`.
 */
export async function verifyByokConnection(
  cfg: ByokConfig,
  fetchFn: typeof fetch = fetch,
): Promise<ByokVerifyResult> {
  if (!isValidByokUrl(cfg.baseUrl) || !cfg.apiKey.trim() || !cfg.model.trim()) {
    const res: ByokVerifyResult = { status: 'failed', ok: false, message: 'invalid_config' }
    setByokVerifyState('failed', res.message)
    return res
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), BYOK_TEST_TIMEOUT_MS) : null
  try {
    const response = await fetchFn(buildOpenAiChatUrl(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: cfg.model.trim(),
        stream: false,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!response.ok) {
      const msg = `HTTP ${response.status}`
      setByokVerifyState('failed', msg)
      verifiedFingerprint = fingerprint(cfg)
      return { status: 'failed', ok: false, httpStatus: response.status, message: msg }
    }
    setByokVerifyState('ok', '')
    verifiedFingerprint = fingerprint(cfg)
    return { status: 'ok', ok: true, httpStatus: response.status }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err || 'network_error')
    setByokVerifyState('failed', msg)
    verifiedFingerprint = fingerprint(cfg)
    return { status: 'failed', ok: false, message: msg }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
