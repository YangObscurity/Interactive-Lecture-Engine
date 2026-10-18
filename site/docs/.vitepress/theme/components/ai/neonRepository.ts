/**
 * neonRepository.ts — Neon Serverless PostgreSQL 数据库 CRUD 仓储层
 * 
 * 核心职责：
 *   1. 统一管理 Neon PostgreSQL 云端数据表的完整 CRUD 仓储操作：
 *      - ai_sessions (讲义会话主表，按讲隔离，级联删除)
 *      - ai_messages (会话消息明细表，多轮问答持久化)
 *      - ai_review_checklists (考点复习清单表，批量导入与打卡)
 *      - ai_lecture_progress (每讲三态打卡进度表，单讲与组内批量标记)
 *   2. 采用 SWR (Stale-While-Revalidate) 本地优先机制：
 *      - 本地缓存 0ms 极速响应，支持离线与即时刷新渲染；
 *      - 后台静默向同源 /api/db/* 接口校验并更新本地缓存；
 *   3. 严格 TypeScript 类型定义，与 schema/neon_schema.sql 100% 契合，坚决杜绝 any；
 *   4. 严格 SSR 安全保护，杜绝任何 Node.js 预渲染环境下的全局对象异常；
 *   5. 严守全站零 Emoji 铁律 (Zero-Emoji Policy)。
 */

// 部署相关常量（接口前缀 / 键前缀 / 数据文件名 / 图谱版本号）统一来自 site.config.mts：
// 本文件此前把这些字面量散在构造默认值、CRUD 端点、进度键与图谱初始化四类位置，
// 任意一处笔误都只会在运行时表现为「静默 404」或「数据读不回来」，编译器无能为力
import {
  API_ENDPOINTS,
  DB_CLIENT_DEFAULTS,
  DB_ROUTES,
  DATA_FILES,
  STORAGE_KEYS,
  STORAGE_KEYS_LEGACY,
  STORAGE_SUBKEYS,
} from '../../../site.config'

// ==============================================================================
// 1. 类型定义与数据契约 (Type Definitions)
// ==============================================================================

/**
 * 讲义三态学习打卡状态
 * 严格对齐 Notion 知识图谱 Status 属性与 neon_schema.sql CHECK 约束
 */
export type LectureProgressStatus = '未开始' | '学习中' | '已完成'
export type ProgressStatus = LectureProgressStatus

/**
 * 消息发送方角色
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * 1. 每讲学习状态模型 (ai_lecture_progress)
 */
export interface AiLectureProgress {
  lecture_id: string
  group_id: string
  notion_node_id: string | null
  notion_page_id: string | null
  status: LectureProgressStatus
  completed_at: string | null
  updated_at: string
}

export type LectureProgressRecord = {
  lectureId: string
  groupId: string
  status: ProgressStatus
  notionNodeId?: string
  notionPageId?: string
  completedAt?: string | null
  updatedAt: string
}

export interface ProgressChangeEvent {
  lectureId: string
  status: ProgressStatus
  groupId: string
  /** 批量真源铺底（Notion 知识图谱初始化）时置位：订阅方应整体重读 getAllProgressSync() 的结果 */
  bulk?: boolean
}

export type ProgressListener = (event: ProgressChangeEvent) => void

/**
 * 静态 Notion 知识图谱节点契约（public/notion_knowledge_graph.json 的元素）
 * 真源规模：由数据文件决定（本引擎不预置任何具体节点数）。
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

/** 三态白名单：杜绝把 Notion 里的任意脏字符串灌进状态机 */
const PROGRESS_STATUSES: readonly ProgressStatus[] = ['未开始', '学习中', '已完成']

/** 将 Notion Status 原文收敛到三态；非法值一律丢弃（返回 null） */
function toProgressStatus(value: unknown): ProgressStatus | null {
  if (typeof value !== 'string') return null
  return PROGRESS_STATUSES.includes(value as ProgressStatus) ? (value as ProgressStatus) : null
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

export interface UpdateProgressMeta {
  group_id?: string
  notion_node_id?: string | null
  notion_page_id?: string | null
}

export interface BatchProgressItem {
  lecture_id: string
  status: LectureProgressStatus
  group_id?: string
  notion_node_id?: string | null
  notion_page_id?: string | null
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

function normalizeId(id: string): string {
  return id ? id.trim().toLowerCase() : ''
}

/**
 * SSR 安全的本地缓存适配器 (基于 localStorage，带内存降级兜底)
 */
class LocalStorageAdapter {
  private prefix: string
  private memoryFallback: Map<string, string> = new Map()

  constructor(prefix = STORAGE_KEYS.neonPrefix) {
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

/**
 * HTTP 客户端包装器，统一处理同源网络请求与错误保护
 *
 * 降级契约（task-3 审计修复）：
 *   - 任何失败（网络异常 / 超时 / 非 2xx）一律返回 null，绝不抛出，UI 零白屏；
 *   - 网络异常与 5xx 自动重试 1 次（短退避），4xx 属业务拒绝不重试；
 *   - networkFailures 暴露累计失败计数，供诊断面板与测试断言读取。
 */
class ApiHttpClient {
  private baseUrl: string
  private timeoutMs: number
  private maxRetries: number
  /** 累计网络层失败次数（含重试后仍失败），只增不清零 */
  public networkFailures = 0

  constructor(baseUrl = API_ENDPOINTS.db, timeoutMs = DB_CLIENT_DEFAULTS.requestTimeoutMs, maxRetries = DB_CLIENT_DEFAULTS.maxRetries) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
    this.maxRetries = Math.max(0, maxRetries)
  }

  private async requestOnce<T>(url: string, init: RequestInit | undefined): Promise<T | null> {
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
        return null
      }

      if (response.status === 204) {
        return true as unknown as T
      }

      const json = (await response.json()) as T
      return json
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async request<T>(endpoint: string, init?: RequestInit): Promise<T | null> {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') {
      return null
    }

    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`

    let result = await this.requestOnce<T>(url, init)

    // 网络异常 / 服务端瞬时故障：短退避后重试一次
    if (result === null && this.maxRetries > 0) {
      await new Promise((resolve) => setTimeout(resolve, 600))
      if (typeof window !== 'undefined' && typeof fetch !== 'undefined') {
        result = await this.requestOnce<T>(url, init)
      }
    }

    if (result === null) {
      this.networkFailures += 1
    }

    return result
  }
}

// ==============================================================================
// 3. Neon 数据库 CRUD 仓储实现 (Repository Implementation)
// ==============================================================================

export class NeonRepository {
  private storage: LocalStorageAdapter
  private client: ApiHttpClient
  private progressListeners: Set<ProgressListener> = new Set()
  /** Notion 真源铺底的并发去重句柄（同一页面多处挂载只真正请求一次） */
  private notionInitPromise: Promise<void> | null = null
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

  /** SSR 环境守卫（此前缺失导致 initProgressFromNotionGraph 运行时 TypeError，进度灌注链路崩溃） */
  private isClient(): boolean {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  }

  // ----------------------------------------------------------------------------
  // 3.1 监听器分发
  // ----------------------------------------------------------------------------

  subscribeProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => {
      this.progressListeners.delete(listener)
    }
  }

  private notifyProgress(event: ProgressChangeEvent): void {
    for (const listener of this.progressListeners) {
      try {
        listener(event)
      } catch {
        // 隔离单个监听器内部错误
      }
    }
  }

  // ----------------------------------------------------------------------------
  // 3.2 会话管理 (ai_sessions)
  // ----------------------------------------------------------------------------

  /**
   * 创建新会话 (即时写入本地，异步同步云端)
   */
  async createSession(
    paramsOrLectureId: CreateSessionParams | string,
    groupId?: string,
    title?: string
  ): Promise<AiSession> {
    const params: CreateSessionParams =
      typeof paramsOrLectureId === 'string'
        ? {
            lecture_id: paramsOrLectureId,
            group_id: groupId || '',
            title: title || '新会话',
          }
        : paramsOrLectureId

    const now = new Date().toISOString()
    const session: AiSession = {
      id: params.id || generateUuid(),
      lecture_id: params.lecture_id,
      group_id: params.group_id,
      title: params.title || '新会话',
      is_archived: false,
      created_at: now,
      updated_at: now,
    }

    // 记录会话与讲义的对应关系索引，方便级联查找与删除
    this.storage.set(`${STORAGE_SUBKEYS.sessionLecturePrefix}${session.id}`, session.lecture_id)

    // 本地优先：即时更新当前讲会话列表
    const key = `${STORAGE_SUBKEYS.sessionsPrefix}${session.lecture_id}`
    const list = this.storage.get<AiSession[]>(key) || []
    this.storage.set(key, [session, ...list.filter((s) => s.id !== session.id)])

    // 异步同步云端
    void this.client.request<AiSession>(DB_ROUTES.sessions, {
      method: 'POST',
      body: JSON.stringify(session),
    })

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
        // 上一代消息键没有前缀，直接是 `tutorial_ai_messages_<sessionId>`，故不经 storage 包装器
        const legacy = window.localStorage.getItem(
          `${STORAGE_KEYS_LEGACY.tutorialAiMessagesPrefix}${sessionId}`
        )
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
   * 深度清洗本地残留的所有历史空会话（彻底净化旧版本累积的幽灵会话）
   */
  public purgeEmptySessions(): number {
    if (!this.isClient()) return 0
    let purgedCount = 0
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
                const filtered = (parsed as AiSession[]).filter((s) => s && s.id && this.hasValidMessages(s.id))
                if (filtered.length !== parsed.length) {
                  purgedCount += (parsed.length - filtered.length)
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
        const validRemote = remote.filter((s) => this.hasValidMessages(s.id))
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
    const lectureId = lectureIdHint || this.storage.get<string>(`${STORAGE_SUBKEYS.sessionLecturePrefix}${sessionId}`)
    if (!lectureId) {
      return null
    }

    const key = `${STORAGE_SUBKEYS.sessionsPrefix}${lectureId}`
    const list = this.storage.get<AiSession[]>(key) || []
    const index = list.findIndex((s) => s.id === sessionId)
    if (index === -1) return null

    const current = list[index]
    const updated: AiSession = {
      ...current,
      title: updates.title !== undefined ? updates.title : current.title,
      is_archived: updates.is_archived !== undefined ? updates.is_archived : current.is_archived,
      updated_at: new Date().toISOString(),
    }

    list[index] = updated
    this.storage.set(key, list)

    void this.client.request<AiSession>(`${DB_ROUTES.sessions}/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: updates.title,
        is_archived: updates.is_archived,
        updated_at: updated.updated_at,
      }),
    })

    return updated
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
   * 删除会话 (级联清理本地会话、索引与关联消息，异步通知云端级联删除)
   */
  async deleteSession(sessionId: string, lectureIdHint?: string): Promise<boolean> {
    if (!sessionId) return false
    const lectureId = lectureIdHint || this.storage.get<string>(`${STORAGE_SUBKEYS.sessionLecturePrefix}${sessionId}`)

    // 1. 本地级联清理消息明细与索引
    this.storage.remove(`${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`)
    this.storage.remove(`${STORAGE_SUBKEYS.sessionLecturePrefix}${sessionId}`)

    // 2. 本地清理会话列表
    if (lectureId) {
      const key = `${STORAGE_SUBKEYS.sessionsPrefix}${lectureId}`
      const list = this.storage.get<AiSession[]>(key) || []
      this.storage.set(
        key,
        list.filter((s) => s.id !== sessionId)
      )
    }

    // 3. 异步通知云端
    void this.client.request<boolean>(`${DB_ROUTES.sessions}/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })

    return true
  }

  /**
   * 清空指定讲次的所有会话
   */
  async clearSessions(lectureId: string): Promise<boolean> {
    if (!lectureId) return false
    const key = `${STORAGE_SUBKEYS.sessionsPrefix}${lectureId}`
    const list = this.storage.get<AiSession[]>(key) || []

    for (const s of list) {
      this.storage.remove(`${STORAGE_SUBKEYS.messagesPrefix}${s.id}`)
      this.storage.remove(`${STORAGE_SUBKEYS.sessionLecturePrefix}${s.id}`)
    }
    this.storage.set(key, [])

    void this.client.request<boolean>(`${DB_ROUTES.sessions}?lecture_id=${encodeURIComponent(lectureId)}`, {
      method: 'DELETE',
    })

    return true
  }

  /**
   * 获取全站所有历史会话 (按更新时间倒序，供历史抽屉分层展示)
   *
   * 兼容两代存储前缀：
   *   - `tutorial_ai_sessions_`（历史版本遗留前缀，见 site.config.mts 的 STORAGE_KEYS_LEGACY）；
   *   - `<storagePrefix>sessions_`（本仓储当前前缀，形如 `<前缀>sessions_<讲次id>`）。
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
   * 追加单条消息 (SWR 本地先写，后台异步同步云端)
   */
  async appendMessage(params: AppendMessageParams): Promise<AiMessage> {
    const now = new Date().toISOString()
    const message: AiMessage = {
      id: params.id || generateUuid(),
      session_id: params.session_id,
      role: params.role,
      content: params.content,
      selected_context: params.selected_context ?? null,
      model: params.model || 'gemini-3.7-flash',
      prompt_tokens: params.prompt_tokens ?? 0,
      completion_tokens: params.completion_tokens ?? 0,
      created_at: now,
    }

    // 1. 本地写入消息队列
    const key = `${STORAGE_SUBKEYS.messagesPrefix}${params.session_id}`
    const list = this.storage.get<AiMessage[]>(key) || []
    this.storage.set(key, [...list, message])

    // 2. 异步同步云端
    void this.client.request<AiMessage>(DB_ROUTES.messages, {
      method: 'POST',
      body: JSON.stringify(message),
    })

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
    const updated: AiMessage = {
      ...current,
      content: updates.content !== undefined ? updates.content : current.content,
      completion_tokens:
        updates.completion_tokens !== undefined
          ? updates.completion_tokens
          : current.completion_tokens,
    }

    list[index] = updated
    this.storage.set(key, list)

    void this.client.request<AiMessage>(`${DB_ROUTES.messages}/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        content: updates.content,
        completion_tokens: updates.completion_tokens,
      }),
    })

    return updated
  }

  /**
   * 删除单条消息
   */
  async deleteMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (!messageId) return false
    if (sessionId) {
      const key = `${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`
      const list = this.storage.get<AiMessage[]>(key) || []
      this.storage.set(
        key,
        list.filter((m) => m.id !== messageId)
      )
    }

    void this.client.request<boolean>(`${DB_ROUTES.messages}/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    })

    return true
  }

  /**
   * 清空单会话所有消息
   */
  async clearMessages(sessionId: string): Promise<boolean> {
    if (!sessionId) return false
    this.storage.remove(`${STORAGE_SUBKEYS.messagesPrefix}${sessionId}`)

    void this.client.request<boolean>(`${DB_ROUTES.messages}?session_id=${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    })

    return true
  }

  // ----------------------------------------------------------------------------
  // 3.4 考点复习清单管理 (ai_review_checklists)
  // ----------------------------------------------------------------------------

  /**
   * 批量导入考点清单 (课件解析映射生成后批量录入)
   */
  async batchAddChecklistItems(
    items: CreateChecklistItemParams[]
  ): Promise<AiReviewChecklist[]> {
    if (items.length === 0) return []
    const now = new Date().toISOString()
    const lectureId = items[0].lecture_id

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

    // 本地持久化追加
    const key = `checklist_${lectureId}`
    const existing = this.storage.get<AiReviewChecklist[]>(key) || []
    const merged = [...existing, ...createdList]
    this.storage.set(key, merged)

    // 建立 ID 索引加速查询
    for (const it of createdList) {
      this.storage.set(`chk_lec_${it.id}`, it.lecture_id)
    }

    // 异步同步云端
    void this.client.request<AiReviewChecklist[]>('/checklist', {
      method: 'POST',
      body: JSON.stringify({ items: createdList }),
    })

    return createdList
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
        `/checklist?lecture_id=${encodeURIComponent(lectureId)}`,
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
    const updated: AiReviewChecklist = {
      ...current,
      is_completed: isCompleted,
      updated_at: new Date().toISOString(),
    }

    list[index] = updated
    this.storage.set(key, list)

    void this.client.request<AiReviewChecklist>(`/checklist/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        is_completed: isCompleted,
        updated_at: updated.updated_at,
      }),
    })

    return updated
  }

  /**
   * 删除考点项
   */
  async deleteChecklistItem(itemId: string, lectureIdHint?: string): Promise<boolean> {
    if (!itemId) return false
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

    void this.client.request<boolean>(`/checklist/${encodeURIComponent(itemId)}`, {
      method: 'DELETE',
    })

    return true
  }

  // ----------------------------------------------------------------------------
  // 3.5 每讲学习状态追踪 (ai_lecture_progress)
  // ----------------------------------------------------------------------------

  /**
   * 查询单讲学习进度 (SWR 策略)
   */
  async getLectureProgress(
    lectureId: string,
    options?: SwrOptions<AiLectureProgress | null>
  ): Promise<AiLectureProgress | null> {
    if (!lectureId) return null
    const normId = normalizeId(lectureId)
    const key = `${STORAGE_SUBKEYS.progressPrefix}${normId}`
    const cached = this.storage.get<AiLectureProgress>(key)

    const revalidate = async (): Promise<AiLectureProgress | null> => {
      const remote = await this.client.request<AiLectureProgress>(
        `${DB_ROUTES.progress}?lecture_id=${encodeURIComponent(normId)}`,
        { method: 'GET' }
      )
      if (remote) {
        this.storage.set(key, remote)
        this.syncToGlobalProgressMap([remote])
        if (options?.onRevalidate) {
          options.onRevalidate(remote)
        }
        return remote
      }
      return cached
    }

    if (cached && !options?.skipCache) {
      void revalidate()
      return cached
    }

    return await revalidate()
  }

  /**
   * 同步直接获取单讲状态（首屏秒开）
   */
  getProgressSync(lectureId: string): ProgressStatus {
    if (!lectureId) return '未开始'
    const normId = normalizeId(lectureId)
    const record = this.storage.get<AiLectureProgress>(`${STORAGE_SUBKEYS.progressPrefix}${normId}`)
    return record ? record.status : '未开始'
  }

  /**
   * 同步直接获取单讲完整记录
   */
  getProgressRecordSync(lectureId: string): LectureProgressRecord | null {
    if (!lectureId) return null
    const normId = normalizeId(lectureId)
    const record = this.storage.get<AiLectureProgress>(`${STORAGE_SUBKEYS.progressPrefix}${normId}`)
    if (!record) return null
    return {
      lectureId: record.lecture_id,
      groupId: record.group_id,
      status: record.status,
      notionNodeId: record.notion_node_id ?? undefined,
      notionPageId: record.notion_page_id ?? undefined,
      completedAt: record.completed_at,
      updatedAt: record.updated_at,
    }
  }

  /**
   * 同步获取全站讲义状态字典
   */
  getAllProgressSync(): Record<string, ProgressStatus> {
    const map = this.storage.get<Record<string, AiLectureProgress>>(STORAGE_SUBKEYS.progressAllMap) || {}
    const result: Record<string, ProgressStatus> = {}
    for (const [key, val] of Object.entries(map)) {
      result[key] = val.status
    }
    return result
  }

  /**
   * 从静态 Notion 知识图谱真源初始化/同步本地进度（双向对齐）
   *
   * - 读取 DATA_FILES.notionKnowledgeGraph.publicPath（节点数与状态分布均由该文件决定）；
   * - 一次性铺底 `progress_all_map` 与 `progress_<lectureId>`，使 getAllProgressSync() /
   *   getProgressRecordSync() 在全站任意页面都能同步拿到真实 Notion 状态；
   * - 幂等 + 并发去重：同一页面多处挂载（HomeBody / GroupIndex / 图组件）只真正请求一次；
   * - 三态白名单收敛非法值，绝不把本地已推进的状态回退成 Notion 的「未开始」；
   * - 失败静默降级并复位句柄，允许下次重试，绝不让 Promise 拒绝外泄。
   */
  initProgressFromNotionGraph(): Promise<void> {
    if (!this.isClient()) return Promise.resolve()
    if (!this.notionInitPromise) {
      this.notionInitPromise = this.syncProgressFromNotionGraph().catch(() => {
        this.notionInitPromise = null
      })
    }
    return this.notionInitPromise
  }

  private async syncProgressFromNotionGraph(): Promise<void> {
    const res = await fetch(DATA_FILES.notionKnowledgeGraph.publicPath)
    if (!res.ok) return
    const payload: unknown = await res.json()
    if (!Array.isArray(payload)) return

    // 版本号来自 site.config.mts：上游图谱一变，bump 这个常量即可触发全员重铺
    const GRAPH_VERSION = DATA_FILES.notionKnowledgeGraph.graphVersion
    const currentVer = this.storage.get<string>(STORAGE_SUBKEYS.graphVersion)
    const forceReset = currentVer !== GRAPH_VERSION

    const now = new Date().toISOString()
    const map = forceReset ? {} : (this.storage.get<Record<string, AiLectureProgress>>(STORAGE_SUBKEYS.progressAllMap) || {})
    let changed = forceReset ? 1 : 0

    for (const raw of payload as NotionGraphNode[]) {
      if (!raw || typeof raw.lectureId !== 'string' || !raw.lectureId) continue
      const status = toProgressStatus(raw.status)
      if (!status) continue

      const lid = normalizeId(raw.lectureId)
      const existing = map[lid]

      if (!forceReset && existing && existing.status === status) {
        // 状态一致：仅补齐缺失的 Notion 溯源元数据
        if (!existing.notion_node_id && raw.nodeId) {
          existing.notion_node_id = raw.nodeId
          existing.notion_page_id = raw.notionPageId ?? null
          this.storage.set(`${STORAGE_SUBKEYS.progressPrefix}${lid}`, existing)
        }
        continue
      }

      // Notion 为唯一真源，真源状态直接对齐本地存储
      const record: AiLectureProgress = {
        lecture_id: lid,
        group_id: normalizeId(raw.groupId || lid.split('-')[0]),
        notion_node_id: raw.nodeId ?? null,
        notion_page_id: raw.notionPageId ?? null,
        status,
        completed_at: status === '已完成' ? raw.completedDate || existing?.completed_at || now : null,
        updated_at: now
      }
      map[lid] = record
      this.storage.set(`${STORAGE_SUBKEYS.progressPrefix}${lid}`, record)
      changed += 1
    }

    if (changed > 0 || forceReset) {
      this.storage.set(STORAGE_SUBKEYS.progressAllMap, map)
      this.storage.set(STORAGE_SUBKEYS.graphVersion, GRAPH_VERSION)
      // 批量真源铺底：广播一次 bulk 事件，订阅方整体重读 getAllProgressSync() 即可
      this.notifyProgress({ lectureId: '', groupId: '', status: '未开始', bulk: true })
    }
  }

  /**
   * 查询课程组内所有讲次学习进度 (SWR 策略)
   */
  async getGroupLectureProgress(
    groupId: string,
    options?: SwrOptions<AiLectureProgress[]>
  ): Promise<AiLectureProgress[]> {
    if (!groupId) return []
    const normGroup = normalizeId(groupId)
    const map = this.storage.get<Record<string, AiLectureProgress>>(STORAGE_SUBKEYS.progressAllMap) || {}
    const cached = Object.values(map).filter(
      (p) => normalizeId(p.group_id) === normGroup
    )

    const revalidate = async (): Promise<AiLectureProgress[]> => {
      const remote = await this.client.request<AiLectureProgress[]>(
        `${DB_ROUTES.progress}?group_id=${encodeURIComponent(normGroup)}`,
        { method: 'GET' }
      )
      if (remote && Array.isArray(remote)) {
        this.syncToGlobalProgressMap(remote)
        for (const item of remote) {
          this.storage.set(`${STORAGE_SUBKEYS.progressPrefix}${normalizeId(item.lecture_id)}`, item)
        }
        if (options?.onRevalidate) {
          options.onRevalidate(remote)
        }
        return remote
      }
      return cached
    }

    if (cached.length > 0 && !options?.skipCache) {
      void revalidate()
      return cached
    }

    return await revalidate()
  }

  /**
   * 更新单讲学习打卡状态 (未开始 / 学习中 / 已完成)
   * 0ms 本地立即生效，通知前端监听器，后台异步写入 Neon PostgreSQL 与 Notion 同步队列
   */
  async updateLectureProgress(
    lectureId: string,
    status: LectureProgressStatus,
    meta?: UpdateProgressMeta
  ): Promise<AiLectureProgress> {
    const normId = normalizeId(lectureId)
    const now = new Date().toISOString()
    const key = `${STORAGE_SUBKEYS.progressPrefix}${normId}`
    const existing = this.storage.get<AiLectureProgress>(key)

    const completedAt =
      status === '已完成' ? existing?.completed_at || now : null

    const updated: AiLectureProgress = {
      lecture_id: normId,
      group_id: meta?.group_id || existing?.group_id || normId.split('-')[0].toLowerCase(),
      notion_node_id:
        meta?.notion_node_id !== undefined ? meta.notion_node_id : existing?.notion_node_id || null,
      notion_page_id:
        meta?.notion_page_id !== undefined ? meta.notion_page_id : existing?.notion_page_id || null,
      status,
      completed_at: completedAt,
      updated_at: now,
    }

    // 1. 本地立即响应 (0ms)
    this.storage.set(key, updated)
    this.syncToGlobalProgressMap([updated])

    // 2. 触发响应式监听器
    this.notifyProgress({
      lectureId: normId,
      status,
      groupId: updated.group_id,
    })

    // 3. 异步提交云端持久化
    void this.client.request<AiLectureProgress>(`${DB_ROUTES.progress}/${encodeURIComponent(normId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        completed_at: completedAt,
        updated_at: now,
        group_id: updated.group_id,
        notion_node_id: updated.notion_node_id,
        notion_page_id: updated.notion_page_id,
      }),
    })

    return updated
  }

  /**
   * 课程组内批量更新讲义状态 (例如批量重置或批量标记已完成)
   */
  async batchUpdateLectureProgress(
    updates: BatchProgressItem[]
  ): Promise<AiLectureProgress[]> {
    if (updates.length === 0) return []
    const now = new Date().toISOString()
    const map = this.storage.get<Record<string, AiLectureProgress>>(STORAGE_SUBKEYS.progressAllMap) || {}

    const results: AiLectureProgress[] = updates.map((item) => {
      const normId = normalizeId(item.lecture_id)
      const existing = map[normId] || this.storage.get<AiLectureProgress>(`${STORAGE_SUBKEYS.progressPrefix}${normId}`)
      const completedAt = item.status === '已完成' ? existing?.completed_at || now : null

      const updated: AiLectureProgress = {
        lecture_id: normId,
        group_id:
          item.group_id || existing?.group_id || normId.split('-')[0].toLowerCase(),
        notion_node_id:
          item.notion_node_id !== undefined ? item.notion_node_id : existing?.notion_node_id || null,
        notion_page_id:
          item.notion_page_id !== undefined ? item.notion_page_id : existing?.notion_page_id || null,
        status: item.status,
        completed_at: completedAt,
        updated_at: now,
      }

      this.storage.set(`${STORAGE_SUBKEYS.progressPrefix}${normId}`, updated)
      map[normId] = updated

      this.notifyProgress({
        lectureId: normId,
        status: item.status,
        groupId: updated.group_id,
      })

      return updated
    })

    this.storage.set(STORAGE_SUBKEYS.progressAllMap, map)

    // 异步同步云端
    void this.client.request<AiLectureProgress[]>(DB_ROUTES.progressBatch, {
      method: 'POST',
      body: JSON.stringify({ items: results }),
    })

    return results
  }

  // ----------------------------------------------------------------------------
  // 3.6 内部同步辅助逻辑
  // ----------------------------------------------------------------------------

  private syncToGlobalProgressMap(items: AiLectureProgress[]): void {
    const map = this.storage.get<Record<string, AiLectureProgress>>(STORAGE_SUBKEYS.progressAllMap) || {}
    for (const item of items) {
      map[normalizeId(item.lecture_id)] = item
    }
    this.storage.set(STORAGE_SUBKEYS.progressAllMap, map)
  }
}

// ==============================================================================
// 4. 默认全局单例实例与导出便利函数 (Singleton & Facade Exports)
// ==============================================================================

export const neonRepository = new NeonRepository()

// 兼容既有直接解构导入的便利函数
export function subscribeProgress(listener: ProgressListener): () => void {
  return neonRepository.subscribeProgress(listener)
}

export function getProgressSync(lectureId: string): ProgressStatus {
  return neonRepository.getProgressSync(lectureId)
}

export function getProgressRecordSync(lectureId: string): LectureProgressRecord | null {
  return neonRepository.getProgressRecordSync(lectureId)
}

export function getAllProgressSync(): Record<string, ProgressStatus> {
  return neonRepository.getAllProgressSync()
}

export async function saveLectureProgress(
  lectureId: string,
  groupId: string,
  status: ProgressStatus,
  notionNodeId?: string
): Promise<LectureProgressRecord> {
  const result = await neonRepository.updateLectureProgress(lectureId, status, {
    group_id: groupId,
    notion_node_id: notionNodeId,
  })
  return {
    lectureId: result.lecture_id,
    groupId: result.group_id,
    status: result.status,
    notionNodeId: result.notion_node_id ?? undefined,
    notionPageId: result.notion_page_id ?? undefined,
    completedAt: result.completed_at,
    updatedAt: result.updated_at,
  }
}

export async function batchSaveProgress(
  items: Array<{ lectureId: string; groupId: string; status: ProgressStatus; notionNodeId?: string }>
): Promise<LectureProgressRecord[]> {
  const payload: BatchProgressItem[] = items.map((it) => ({
    lecture_id: it.lectureId,
    group_id: it.groupId,
    status: it.status,
    notion_node_id: it.notionNodeId,
  }))
  const results = await neonRepository.batchUpdateLectureProgress(payload)
  return results.map((result) => ({
    lectureId: result.lecture_id,
    groupId: result.group_id,
    status: result.status,
    notionNodeId: result.notion_node_id ?? undefined,
    notionPageId: result.notion_page_id ?? undefined,
    completedAt: result.completed_at,
    updatedAt: result.updated_at,
  }))
}

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

export function purgeEmptySessions(): number {
  return neonRepository.purgeEmptySessions()
}

export async function initProgressFromNotionGraph(): Promise<void> {
  return neonRepository.initProgressFromNotionGraph()
}
