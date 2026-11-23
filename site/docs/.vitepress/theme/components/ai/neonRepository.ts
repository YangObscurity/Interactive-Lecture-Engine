/**
 * neonRepository.ts — Neon Serverless PostgreSQL 数据库 CRUD 仓储层
 * 
 * 核心职责：
 *   1. 统一管理 Neon PostgreSQL 云端数据表的完整 CRUD 仓储操作：
 *      - ai_sessions (讲义会话主表，按讲隔离，级联删除)
 *      - ai_messages (会话消息明细表，多轮问答持久化)
 *      - ai_review_checklists (考点复习清单表，批量导入与打卡)
 *      （讲次进度已迁出，见 theme/progress/ 与 theme/api/）
 *   2. 采用 SWR (Stale-While-Revalidate) 本地优先机制：
 *      - 本地缓存 0ms 极速响应，支持离线与即时刷新渲染；
 *      - 后台静默向同源 /api/db/* 接口校验并更新本地缓存；
 *   3. 严格 TypeScript 类型定义，与 schema/neon_schema.sql 100% 契合，坚决杜绝 any；
 *   4. 严格 SSR 安全保护，杜绝任何 Node.js 预渲染环境下的全局对象异常；
 *   5. 严守全站零 Emoji 铁律 (Zero-Emoji Policy)。
 */

import {
  API_ENDPOINTS,
  DB_CLIENT_DEFAULTS,
  DB_ROUTES,
  STORAGE_KEYS,
  STORAGE_KEYS_LEGACY,
  STORAGE_SUBKEYS,
} from '../../../site.config.mts'
import { currentLang, translate } from '../../../i18n/index.ts'

// ==============================================================================
// 1. 类型定义与数据契约 (Type Definitions)
// ==============================================================================

/**
 * 消息发送方角色
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * 静态 Notion 知识图谱节点契约（public/notion_knowledge_graph.json 的元素）
 * 真源规模：279 节点 / 已完成 24 / 学习中 4 / 未开始 251（19 个马来语节点已被上游剔除）。
 */
export interface NotionGraphNode {
  notionPageId?: string
  nodeId?: string
  title?: string
  category?: string
  groupId?: string
  lectureId?: string
  lecturePath?: string
  status?: string
  completedDate?: string | null
  prerequisites?: string[]
  subsequents?: string[]
}

/**
 * 2. 会话主表模型 (ai_sessions)
 */
export interface AiSession {
  id: string
  lecture_id: string
  group_id: string
  title: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

/**
 * 3. 消息明细模型 (ai_messages)
 */
export interface AiMessage {
  id: string
  session_id: string
  role: MessageRole
  content: string
  selected_context: string | null
  model: string
  prompt_tokens: number
  completion_tokens: number
  created_at: string
}

/**
 * 4. 考试复习考点清单模型 (ai_review_checklists)
 */
export interface AiReviewChecklist {
  id: string
  lecture_id: string
  group_id: string
  topic_title: string
  section_anchor: string | null
  is_completed: boolean
  pptx_source: string | null
  priority: number
  created_at: string
  updated_at: string
}

// ------------------------------------------------------------------------------
// 输入参数契约 (Input Payloads)
// ------------------------------------------------------------------------------

export interface CreateSessionParams {
  id?: string
  lecture_id: string
  group_id: string
  title?: string
}

export interface UpdateSessionParams {
  title?: string
  is_archived?: boolean
}

export interface AppendMessageParams {
  id?: string
  session_id: string
  role: MessageRole
  content: string
  selected_context?: string | null
  model?: string
  prompt_tokens?: number
  completion_tokens?: number
}

export interface UpdateMessageParams {
  content?: string
  completion_tokens?: number
}

export interface CreateChecklistItemParams {
  id?: string
  lecture_id: string
  group_id: string
  topic_title: string
  section_anchor?: string | null
  pptx_source?: string | null
  priority?: number
}

export interface SwrOptions<T> {
  onRevalidate?: (freshData: T) => void
  skipCache?: boolean
}

export interface RepositoryConfig {
  apiBaseUrl?: string
  storagePrefix?: string
  requestTimeoutMs?: number
}

// ==============================================================================
// 2. 辅助工具与 SSR 安全本地存储 (Storage & Utility)
// ==============================================================================

/**
 * 生成遵循 RFC 4122 标准的 UUID v4
 */
export function generateUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0
    const value = char === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

/**
 * SSR 安全的本地缓存适配器 (基于 localStorage，带内存降级兜底)
 */
class LocalStorageAdapter {
  private prefix: string
  private memoryFallback: Map<string, string> = new Map()

  constructor(prefix: string = STORAGE_KEYS.neonPrefix) {
    this.prefix = prefix
  }

  private isClient(): boolean {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  }

  get<T>(key: string): T | null {
    const rawKey = this.prefix + key
    if (this.isClient()) {
      try {
        const item = window.localStorage.getItem(rawKey)
        if (item) {
          return JSON.parse(item) as T
        }
      } catch {
        // 降级使用内存存储
      }
    }
    const memItem = this.memoryFallback.get(rawKey)
    if (memItem) {
      try {
        return JSON.parse(memItem) as T
      } catch {
        return null
      }
    }
    return null
  }

  set<T>(key: string, value: T): void {
    const rawKey = this.prefix + key
    try {
      const jsonStr = JSON.stringify(value)
      this.memoryFallback.set(rawKey, jsonStr)
      if (this.isClient()) {
        window.localStorage.setItem(rawKey, jsonStr)
      }
    } catch {
      // 本地存储异常通过 memoryFallback 兜底静默处理
    }
  }

  remove(key: string): void {
    const rawKey = this.prefix + key
    this.memoryFallback.delete(rawKey)
    if (this.isClient()) {
      try {
        window.localStorage.removeItem(rawKey)
      } catch {
        // 忽略移除异常
      }
    }
  }
}

export interface ApiOk<T> {
  ok: true
  status: number
  data: T
}

export interface ApiFail {
  ok: false
  status: number
  error: string
  message?: string
}

export type ApiResult<T> = ApiOk<T> | ApiFail

function unwrapApiResult<T>(res: ApiResult<T>): T {
  if (!res.ok) {
    const fail = res as ApiFail
    throw new NeonWriteError(fail.status, fail.error, fail.message)
  }
  return (res as ApiOk<T>).data
}

export class NeonWriteError extends Error {
  readonly status: number
  readonly errorCode: string

  constructor(status: number, errorCode: string, message?: string) {
    super(message || (status > 0 ? `HTTP ${status}: ${errorCode}` : errorCode))
    this.name = 'NeonWriteError'
    this.status = status
    this.errorCode = errorCode
  }
}

/**
 * HTTP 客户端包装器，统一处理同源网络请求与非 2xx 错误透传
 */
class ApiHttpClient {
  private baseUrl: string
  private timeoutMs: number
  private maxRetries: number
  /** 累计网络/HTTP 失败次数，只增不清零 */
  public networkFailures = 0

  constructor(
    baseUrl: string = API_ENDPOINTS.db,
    timeoutMs: number = DB_CLIENT_DEFAULTS.requestTimeoutMs,
    maxRetries: number = DB_CLIENT_DEFAULTS.maxRetries
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.maxRetries = Math.max(0, maxRetries)
  }

  private async requestOnce<T>(url: string, init: RequestInit | undefined): Promise<ApiResult<T>> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null

    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...((init?.headers as Record<string, string>) || {}),
        },
        signal: controller ? controller.signal : undefined,
      })

      if (!response.ok) {
        let errorCode = `http_${response.status}`
        let message = `HTTP ${response.status}`
        try {
          const errJson = (await response.json()) as { error?: unknown; message?: unknown } | null
          if (errJson && typeof errJson === 'object') {
            if (typeof errJson.error === 'string' && errJson.error) errorCode = errJson.error
            if (typeof errJson.message === 'string' && errJson.message) message = errJson.message
          }
        } catch {
          // ignore non-JSON error body
        }
        return { ok: false, status: response.status, error: errorCode, message }
      }

      if (response.status === 204) {
        return { ok: true, status: 204, data: true as unknown as T }
      }

      const json = (await response.json()) as T
      return { ok: true, status: response.status, data: json }
    } catch (err: unknown) {
      return {
        ok: false,
        status: 0,
        error: 'network_error',
        message: err instanceof Error ? err.message : 'network_error',
      }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async requestResult<T>(endpoint: string, init?: RequestInit): Promise<ApiResult<T>> {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') {
      return { ok: false, status: 0, error: 'ssr_unavailable', message: 'Browser fetch unavailable' }
    }

    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
    const method = (init?.method || 'GET').toUpperCase()

    let result = await this.requestOnce<T>(url, init)

    // 仅对幂等读请求或瞬时网络/5xx 做单次退避重试
    if (!result.ok && method === 'GET' && (result.status === 0 || result.status >= 500) && this.maxRetries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 600))
      if (typeof window !== 'undefined' && typeof fetch !== 'undefined') {
        result = await this.requestOnce<T>(url, init)
      }
    }

    if (!result.ok) {
      this.networkFailures += 1
    }

    return result
  }

  async request<T>(endpoint: string, init?: RequestInit): Promise<T | null> {
    const res = await this.requestResult<T>(endpoint, init)
    return res.ok ? res.data : null
  }
}

// ==============================================================================
// 3. Neon 数据库 CRUD 仓储实现 (Repository Implementation)
// ==============================================================================

export class NeonRepository {
  private storage: LocalStorageAdapter
  private client: ApiHttpClient
  /** localStorage 键前缀（与 LocalStorageAdapter 一致，供 getAllSessions 跨前缀扫描） */
  public readonly storagePrefix: string

  constructor(config?: RepositoryConfig) {
    this.storagePrefix = config?.storagePrefix ?? STORAGE_KEYS.neonPrefix
    this.storage = new LocalStorageAdapter(this.storagePrefix)
    this.client = new ApiHttpClient(
      config?.apiBaseUrl ?? API_ENDPOINTS.db,
      config?.requestTimeoutMs ?? DB_CLIENT_DEFAULTS.requestTimeoutMs
    )
  }

  /** SSR 环境守卫 */
  private isClient(): boolean {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  }

  // ----------------------------------------------------------------------------
  // 3.2 会话管理 (ai_sessions)
  // ----------------------------------------------------------------------------

  /**
   * 创建新会话 (服务端确认后再更新本地缓存，禁止失败时假写入)
   */
  async createSession(
    paramsOrLectureId: CreateSessionParams | string,
    groupId?: string,
    title?: string
  ): Promise<AiSession> {
    const defaultTitle = translate(currentLang(), 'ai.userSessionDefault')
    const params: CreateSessionParams =
      typeof paramsOrLectureId === 'string'
        ? {
            lecture_id: paramsOrLectureId,
            group_id: groupId || '',
            title: title || defaultTitle,
          }
        : paramsOrLectureId

    const now = new Date().toISOString()
    const candidate: AiSession = {
      id: params.id || generateUuid(),
      lecture_id: params.lecture_id,
      group_id: params.group_id,
      title: params.title || defaultTitle,
      is_archived: false,
      created_at: now,
      updated_at: now,
    }

    const res = await this.client.requestResult<AiSession>(DB_ROUTES.sessions, {
      method: 'POST',
      body: JSON.stringify(candidate),
    })
    const resData = unwrapApiResult(res)

    const session: AiSession =
      resData && typeof resData === 'object' && typeof resData.id === 'string' ? resData : candidate

    this.storage.set(`${STORAGE_SUBKEYS.sessionLecturePrefix}${session.id}`, session.lecture_id)
    const key = `${STORAGE_SUBKEYS.sessionsPrefix}${session.lecture_id}`
    const list = this.storage.get<AiSession[]>(key) || []
    this.storage.set(key, [session, ...list.filter((s) => s.id !== session.id)])

    return session
  }

  /**
   * 判定会话是否包含有效消息（过滤掉仅翻页触发、无真正对话交互的空会话）
   */
  public hasValidMessages(sessionId: string): boolean {
    if (!sessionId) return false
    const msgs = this.storage.get<AiMessage[]>(`${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`)
    if (Array.isArray(msgs) && msgs.length > 0) return true

    if (this.isClient()) {
      try {
        const legacy = window.localStorage.getItem(`${STORAGE_KEYS_LEGACY.tutorialAiMessagesPrefix}${sessionId}`)
        if (legacy) {
          const parsed = JSON.parse(legacy) as unknown
          if (Array.isArray(parsed) && parsed.length > 0) return true
        }
      } catch {
        // ignore
      }
    }
    return false
  }

  /**
   * 深度清洗超过宽限期的历史空会话（FE-009：保留正在使用或刚创建的会话）
   */
  public purgeEmptySessions(excludeSessionId?: string, minAgeMs = 60 * 60 * 1000): number {
    if (!this.isClient()) return 0
    let purgedCount = 0
    const now = Date.now()
    const prefixes = [
      STORAGE_KEYS_LEGACY.tutorialAiSessionsPrefix,
      `${this.storagePrefix}${STORAGE_SUBKEYS.sessionsPrefix}`,
    ]
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (k && prefixes.some((p) => k.startsWith(p))) {
          const raw = window.localStorage.getItem(k)
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as unknown
              if (Array.isArray(parsed)) {
                const filtered = (parsed as AiSession[]).filter((s) => {
                  if (!s || !s.id) return false
                  if (excludeSessionId && s.id === excludeSessionId) return true
                  if (this.hasValidMessages(s.id)) return true
                  const ts = Date.parse(s.updated_at || s.created_at || '')
                  if (Number.isFinite(ts) && now - ts < minAgeMs) return true
                  return false
                })
                if (filtered.length !== parsed.length) {
                  purgedCount += parsed.length - filtered.length
                  window.localStorage.setItem(k, JSON.stringify(filtered))
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return purgedCount
  }

  /**
   * 按讲读取会话列表 (SWR 策略：先出本地缓存，后台静默云端比对)
   */
  async getSessionsByLecture(
    lectureId: string,
    options?: SwrOptions<AiSession[]>
  ): Promise<AiSession[]> {
    if (!lectureId) return []
    const key = `${STORAGE_SUBKEYS.sessionsPrefix}${lectureId}`
    const cached = this.storage.get<AiSession[]>(key)

    // 过滤掉无消息空会话，并做本地自愈回写
    let validCached: AiSession[] | null = null
    if (cached && Array.isArray(cached)) {
      validCached = cached.filter((s) => this.hasValidMessages(s.id))
      if (validCached.length !== cached.length) {
        this.storage.set(key, validCached)
      }
    }

    const revalidate = async (): Promise<AiSession[]> => {
      const remote = await this.client.request<AiSession[]>(
        `${DB_ROUTES.sessions}?lecture_id=${encodeURIComponent(lectureId)}`,
        { method: 'GET' }
      )
      if (remote && Array.isArray(remote)) {
        const validRemote = remote.filter((s) => s && typeof s.id === 'string')
        this.storage.set(key, validRemote)
        for (const s of validRemote) {
          this.storage.set(`${STORAGE_SUBKEYS.sessionLecturePrefix}${s.id}`, s.lecture_id)
        }
        if (options?.onRevalidate) {
          options.onRevalidate(validRemote)
        }
        return validRemote
      }
      return validCached || []
    }

    if (validCached && !options?.skipCache) {
      void revalidate()
      return validCached
    }

    return await revalidate()
  }

  /**
   * 别名方法，与既有组件调用保持兼容
   */
  async getSessions(lectureId: string, options?: SwrOptions<AiSession[]>): Promise<AiSession[]> {
    return this.getSessionsByLecture(lectureId, options)
  }

  /**
   * 更新会话标题或归档状态 (SWR 本地先改，异步 PATCH 云端)
   */
  async updateSession(
    sessionId: string,
    updates: UpdateSessionParams,
    lectureIdHint?: string
  ): Promise<AiSession | null> {
    if (!sessionId) return null
    const lectureId =
      lectureIdHint || this.storage.get<string>(`${STORAGE_SUBKEYS.sessionLecturePrefix}${sessionId}`)
    if (!lectureId) {
      return null
    }

    const key = `${STORAGE_SUBKEYS.sessionsPrefix}${lectureId}`
    const list = this.storage.get<AiSession[]>(key) || []
    const index = list.findIndex((s) => s.id === sessionId)
    if (index === -1) return null

    const current = list[index]
    if (!current) return null
    const updated: AiSession = {
      ...current,
      title: updates.title !== undefined ? updates.title : current.title,
      is_archived: updates.is_archived !== undefined ? updates.is_archived : current.is_archived,
      updated_at: new Date().toISOString(),
    }

    const res = await this.client.requestResult<AiSession>(`${DB_ROUTES.sessions}/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: updates.title,
        is_archived: updates.is_archived,
        updated_at: updated.updated_at,
      }),
    })
    const resData = unwrapApiResult(res)

    const canonical: AiSession =
      resData && typeof resData === 'object' && typeof resData.id === 'string' ? resData : updated
    list[index] = canonical
    this.storage.set(key, list)

    return canonical
  }

  /**
   * 便捷重命名会话标题
   */
  async updateSessionTitle(
    sessionId: string,
    title: string,
    lectureIdHint?: string
  ): Promise<boolean> {
    const res = await this.updateSession(sessionId, { title }, lectureIdHint)
    return res !== null
  }

  /**
   * 删除会话 (服务端确认后级联清理本地会话、索引与关联消息)
   */
  async deleteSession(sessionId: string, lectureIdHint?: string): Promise<boolean> {
    if (!sessionId) return false

    const res = await this.client.requestResult<boolean>(`${DB_ROUTES.sessions}/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })
    unwrapApiResult(res)

    const lectureId =
      lectureIdHint || this.storage.get<string>(`${STORAGE_SUBKEYS.sessionLecturePrefix}${sessionId}`)

    this.storage.remove(`${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`)
    this.storage.remove(`${STORAGE_SUBKEYS.sessionLecturePrefix}${sessionId}`)

    if (lectureId) {
      const key = `${STORAGE_SUBKEYS.sessionsPrefix}${lectureId}`
      const list = this.storage.get<AiSession[]>(key) || []
      this.storage.set(
        key,
        list.filter((s) => s.id !== sessionId)
      )
    }

    return true
  }

  /**
   * 清空指定讲次的所有会话（服务端确认后清理本地）
   */
  async clearSessions(lectureId: string): Promise<boolean> {
    if (!lectureId) return false

    const res = await this.client.requestResult<boolean>(
      `${DB_ROUTES.sessions}?lecture_id=${encodeURIComponent(lectureId)}`,
      { method: 'DELETE' }
    )
    unwrapApiResult(res)

    const key = `${STORAGE_SUBKEYS.sessionsPrefix}${lectureId}`
    const list = this.storage.get<AiSession[]>(key) || []

    for (const s of list) {
      this.storage.remove(`${STORAGE_SUBKEYS.messagesPrefix}${s.id}`)
      this.storage.remove(`${STORAGE_SUBKEYS.sessionLecturePrefix}${s.id}`)
    }
    this.storage.set(key, [])

    return true
  }

  /**
   * 获取全站所有历史会话 (按更新时间倒序，供历史抽屉分层展示)
   */
  async getAllSessions(): Promise<AiSession[]> {
    if (!this.isClient()) return []
    const all: AiSession[] = []
    const prefixes = [
      STORAGE_KEYS_LEGACY.tutorialAiSessionsPrefix,
      `${this.storagePrefix}${STORAGE_SUBKEYS.sessionsPrefix}`,
    ]
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i)
        if (k && prefixes.some((p) => k.startsWith(p))) {
          const raw = window.localStorage.getItem(k)
          if (raw) {
            try {
              const parsed = JSON.parse(raw) as unknown
              if (Array.isArray(parsed)) {
                all.push(...(parsed as AiSession[]))
              } else if (parsed && typeof parsed === 'object' && 'id' in (parsed as object)) {
                // 单对象容错（历史遗留写入形态）
                all.push(parsed as AiSession)
              }
            } catch {
              // 单键解析失败不影响其它键
            }
          }
        }
      }
    } catch {
      // 容错降级
    }
    const seen = new Set<string>()
    return all
      .filter((s) => {
        if (!s || typeof s.id !== 'string' || seen.has(s.id)) return false
        // 门禁：仅保留存在真正交互问答的有效会话（彻底消除翻页产生的空记录）
        if (!this.hasValidMessages(s.id)) {
          return false
        }
        seen.add(s.id)
        return true
      })
      .sort((a, b) => {
        const ta = new Date(a.updated_at || a.created_at).getTime()
        const tb = new Date(b.updated_at || b.created_at).getTime()
        return tb - ta
      })
  }

  // ----------------------------------------------------------------------------
  // 3.3 消息明细管理 (ai_messages)
  // ----------------------------------------------------------------------------

  /**
   * 追加单条消息 (服务端确认后再写入本地缓存，禁止失败时假写入)
   */
  async appendMessage(params: AppendMessageParams): Promise<AiMessage> {
    const now = new Date().toISOString()
    const candidate: AiMessage = {
      id: params.id || generateUuid(),
      session_id: params.session_id,
      role: params.role,
      content: params.content,
      selected_context: params.selected_context ?? null,
      model: params.model || 'proxy',
      prompt_tokens: params.prompt_tokens ?? 0,
      completion_tokens: params.completion_tokens ?? 0,
      created_at: now,
    }

    const res = await this.client.requestResult<AiMessage>(DB_ROUTES.messages, {
      method: 'POST',
      body: JSON.stringify(candidate),
    })
    const resData = unwrapApiResult(res)

    const message: AiMessage =
      resData && typeof resData === 'object' && typeof resData.id === 'string' ? resData : candidate

    const key = `${STORAGE_SUBKEYS.messagesPrefix}${params.session_id}`
    const list = this.storage.get<AiMessage[]>(key) || []
    this.storage.set(key, [...list, message])

    return message
  }

  /**
   * 读取会话全部历史消息 (SWR 策略：本地先出，后台静默拉取)
   */
  async getMessagesBySession(
    sessionId: string,
    options?: SwrOptions<AiMessage[]>
  ): Promise<AiMessage[]> {
    if (!sessionId) return []
    const key = `${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`
    const cached = this.storage.get<AiMessage[]>(key)

    const revalidate = async (): Promise<AiMessage[]> => {
      const remote = await this.client.request<AiMessage[]>(
        `${DB_ROUTES.messages}?session_id=${encodeURIComponent(sessionId)}`,
        { method: 'GET' }
      )
      if (remote && Array.isArray(remote)) {
        this.storage.set(key, remote)
        if (options?.onRevalidate) {
          options.onRevalidate(remote)
        }
        return remote
      }
      return cached || []
    }

    if (cached && !options?.skipCache) {
      void revalidate()
      return cached
    }

    return await revalidate()
  }

  /**
   * 别名方法，与既有组件保持兼容
   */
  async getMessages(
    sessionId: string,
    options?: SwrOptions<AiMessage[]>
  ): Promise<AiMessage[]> {
    return this.getMessagesBySession(sessionId, options)
  }

  /**
   * 更新消息内容 (例如流式输出打字机定稿或 Token 消耗更新)
   */
  async updateMessage(
    messageId: string,
    updates: UpdateMessageParams,
    sessionId?: string
  ): Promise<AiMessage | null> {
    if (!messageId) return null
    if (!sessionId) {
      return null
    }

    const key = `${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`
    const list = this.storage.get<AiMessage[]>(key) || []
    const index = list.findIndex((m) => m.id === messageId)
    if (index === -1) return null

    const current = list[index]
    if (!current) return null
    const updated: AiMessage = {
      ...current,
      content: updates.content !== undefined ? updates.content : current.content,
      completion_tokens:
        updates.completion_tokens !== undefined
          ? updates.completion_tokens
          : current.completion_tokens,
    }

    const res = await this.client.requestResult<AiMessage>(`${DB_ROUTES.messages}/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        content: updates.content,
        completion_tokens: updates.completion_tokens,
      }),
    })
    const resData = unwrapApiResult(res)

    const canonical: AiMessage =
      resData && typeof resData === 'object' && typeof resData.id === 'string' ? resData : updated
    list[index] = canonical
    this.storage.set(key, list)

    return canonical
  }

  /**
   * 删除单条消息
   */
  async deleteMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (!messageId) return false

    const res = await this.client.requestResult<boolean>(`${DB_ROUTES.messages}/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    })
    unwrapApiResult(res)

    if (sessionId) {
      const key = `${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`
      const list = this.storage.get<AiMessage[]>(key) || []
      this.storage.set(
        key,
        list.filter((m) => m.id !== messageId)
      )
    }

    return true
  }

  /**
   * 清空单会话所有消息
   */
  async clearMessages(sessionId: string): Promise<boolean> {
    if (!sessionId) return false

    const res = await this.client.requestResult<boolean>(
      `${DB_ROUTES.messages}?session_id=${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' }
    )
    unwrapApiResult(res)

    this.storage.remove(`${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`)

    return true
  }

  // ----------------------------------------------------------------------------
  // 3.4 考点复习清单管理 (ai_review_checklists)
  // ----------------------------------------------------------------------------

  /**
   * 批量导入考点清单 (服务端确认后再写入本地)
   */
  async batchAddChecklistItems(
    items: CreateChecklistItemParams[]
  ): Promise<AiReviewChecklist[]> {
    const first = items[0]
    if (!first) return []
    const now = new Date().toISOString()
    const lectureId = first.lecture_id

    const createdList: AiReviewChecklist[] = items.map((item) => ({
      id: item.id || generateUuid(),
      lecture_id: item.lecture_id,
      group_id: item.group_id,
      topic_title: item.topic_title,
      section_anchor: item.section_anchor ?? null,
      is_completed: false,
      pptx_source: item.pptx_source ?? null,
      priority: item.priority ?? 1,
      created_at: now,
      updated_at: now,
    }))

    const res = await this.client.requestResult<AiReviewChecklist[]>(DB_ROUTES.reviewChecklists, {
      method: 'POST',
      body: JSON.stringify({ items: createdList }),
    })
    const resData = unwrapApiResult(res)

    const persistedList = Array.isArray(resData) && resData.length > 0 ? resData : createdList

    const key = `checklist_${lectureId}`
    const existing = this.storage.get<AiReviewChecklist[]>(key) || []
    const merged = [...existing, ...persistedList]
    this.storage.set(key, merged)

    for (const it of persistedList) {
      this.storage.set(`chk_lec_${it.id}`, it.lecture_id)
    }

    return persistedList
  }

  /**
   * 获取某讲考点清单 (SWR 策略)
   */
  async getChecklistByLecture(
    lectureId: string,
    options?: SwrOptions<AiReviewChecklist[]>
  ): Promise<AiReviewChecklist[]> {
    if (!lectureId) return []
    const key = `checklist_${lectureId}`
    const cached = this.storage.get<AiReviewChecklist[]>(key)

    const revalidate = async (): Promise<AiReviewChecklist[]> => {
      const remote = await this.client.request<AiReviewChecklist[]>(
        `${DB_ROUTES.reviewChecklists}?lecture_id=${encodeURIComponent(lectureId)}`,
        { method: 'GET' }
      )
      if (remote && Array.isArray(remote)) {
        this.storage.set(key, remote)
        for (const item of remote) {
          this.storage.set(`chk_lec_${item.id}`, item.lecture_id)
        }
        if (options?.onRevalidate) {
          options.onRevalidate(remote)
        }
        return remote
      }
      return cached || []
    }

    if (cached && !options?.skipCache) {
      void revalidate()
      return cached
    }

    return await revalidate()
  }

  /**
   * 别名方法，获取考点清单
   */
  async getChecklist(
    lectureId: string,
    options?: SwrOptions<AiReviewChecklist[]>
  ): Promise<AiReviewChecklist[]> {
    return this.getChecklistByLecture(lectureId, options)
  }

  /**
   * 切换考点掌握状态 (打勾/取消打勾)
   */
  async toggleChecklistItem(
    itemId: string,
    isCompleted: boolean,
    lectureIdHint?: string
  ): Promise<AiReviewChecklist | null> {
    if (!itemId) return null
    const lectureId = lectureIdHint || this.storage.get<string>(`chk_lec_${itemId}`)
    if (!lectureId) {
      return null
    }

    const key = `checklist_${lectureId}`
    const list = this.storage.get<AiReviewChecklist[]>(key) || []
    const index = list.findIndex((it) => it.id === itemId)
    if (index === -1) return null

    const current = list[index]
    if (!current) return null
    const updated: AiReviewChecklist = {
      ...current,
      is_completed: isCompleted,
      updated_at: new Date().toISOString(),
    }

    const res = await this.client.requestResult<AiReviewChecklist>(
      `${DB_ROUTES.reviewChecklists}/${encodeURIComponent(itemId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          is_completed: isCompleted,
          updated_at: updated.updated_at,
        }),
      },
    )
    const resData = unwrapApiResult(res)

    const canonical =
      resData && typeof resData === 'object' && typeof resData.id === 'string' ? resData : updated
    list[index] = canonical
    this.storage.set(key, list)

    return canonical
  }

  /**
   * 删除考点项
   */
  async deleteChecklistItem(itemId: string, lectureIdHint?: string): Promise<boolean> {
    if (!itemId) return false

    const res = await this.client.requestResult<boolean>(
      `${DB_ROUTES.reviewChecklists}/${encodeURIComponent(itemId)}`,
      { method: 'DELETE' },
    )
    unwrapApiResult(res)

    const lectureId = lectureIdHint || this.storage.get<string>(`chk_lec_${itemId}`)
    this.storage.remove(`chk_lec_${itemId}`)

    if (lectureId) {
      const key = `checklist_${lectureId}`
      const list = this.storage.get<AiReviewChecklist[]>(key) || []
      this.storage.set(
        key,
        list.filter((it) => it.id !== itemId)
      )
    }

    return true
  }
}

// ==============================================================================
// 4. 默认全局单例实例与导出便利函数 (Singleton & Facade Exports)
// ==============================================================================

export const neonRepository = new NeonRepository()

// 会话与消息操作兼容导出函数
export async function getSessions(lectureId: string, options?: SwrOptions<AiSession[]>): Promise<AiSession[]> {
  return neonRepository.getSessions(lectureId, options)
}

export async function saveSession(session: CreateSessionParams | AiSession): Promise<AiSession> {
  return neonRepository.createSession(session)
}

export async function getMessages(sessionId: string, options?: SwrOptions<AiMessage[]>): Promise<AiMessage[]> {
  return neonRepository.getMessages(sessionId, options)
}

export async function saveMessages(sessionId: string, messages: AppendMessageParams[]): Promise<AiMessage[]> {
  const res: AiMessage[] = []
  for (const m of messages) {
    res.push(await neonRepository.appendMessage(m))
  }
  return res
}

export async function deleteSessionCascade(sessionId: string): Promise<boolean> {
  return neonRepository.deleteSession(sessionId)
}

export async function clearAllSessionsForLecture(lectureId: string): Promise<boolean> {
  return neonRepository.clearSessions(lectureId)
}

export async function getAllSessions(): Promise<AiSession[]> {
  return neonRepository.getAllSessions()
}

export function purgeEmptySessions(excludeSessionId?: string, minAgeMs?: number): number {
  return neonRepository.purgeEmptySessions(excludeSessionId, minAgeMs)
}
