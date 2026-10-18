/**
 * notionSync.ts — Notion 知识图谱三态进度安全队列同步器
 * 
 * 职责：
 *   1. 接收讲义打卡三态变更，排队异步回写至 Notion「学习节点知识图谱」；
 *   2. 严格单一属性白名单锁（Strict Whitelist Property Lock）：
 *      仅允许更新 properties.Status.status.name 为 '未开始' | '学习中' | '已完成'；
 *   3. 消峰限流队列（Rate-Limiter / Queue）：
 *      维持最小 350ms 严格调用间隔，彻底杜绝触发 Notion 官方 3 req/s 的 HTTP 429 速率限制；
 *   4. 指数退避重试（Exponential Backoff）：
 *      请求失败或遭遇 429 限流时，执行最多 3 次带随机抖动的指数退避重试；
 *   5. 客户端凭据零泄露（Zero-Token Client Security）：
 *      前端代码绝对不内嵌 Notion 令牌，同源分发至 /api/progress/notion-sync 服务端代理；
 *   6. 严格类型与 SSR 安全：
 *      零 any 类型声明，天然兼容 Node.js 预渲染与浏览器客户端环境。
 */

import { API_ENDPOINTS, NOTION_API } from '../../../site.config'

// ============================================================================
// 1. 类型定义与严格白名单常量
// ============================================================================

export type ProgressStatus = '未开始' | '学习中' | '已完成'

export const ALLOWED_NOTION_STATUSES: readonly ProgressStatus[] = Object.freeze([
  '未开始',
  '学习中',
  '已完成'
] as const)

export type SyncState = 'idle' | 'syncing' | 'throttling' | 'retrying' | 'error'

/**
 * Notion Status 属性专有载荷类型声明（白名单结构）
 */
export interface NotionStatusNameObject {
  name: ProgressStatus
}

export interface NotionStatusContainer {
  status?: NotionStatusNameObject
  select?: NotionStatusNameObject
}

export interface NotionPagePatchPayload {
  properties: {
    Status: NotionStatusContainer
  }
}

/**
 * 队列内部同步任务项
 */
export interface NotionSyncItem {
  lectureId: string
  status: ProgressStatus
  notionNodeId?: string
  notionPageId?: string
  retryCount: number
  maxRetries: number
  timestamp: number
  lastError?: string
}

/**
 * 队列运行指标与统计数据接口
 */
export interface NotionQueueStats {
  queued: number
  processing: boolean
  inFlight: boolean
  state: SyncState
  totalSuccess: number
  totalFailed: number
  totalRetried: number
  lastSyncTime: number | null
}

/**
 * 状态监听器函数类型
 */
export type NotionSyncListener = (state: SyncState, queueLen: number) => void

// ============================================================================
// 2. 安全审计防护一：严格白名单属性锁校验器与载荷构建器
// ============================================================================

/**
 * 运行时校验状态值是否属于法定三态之一
 */
export function isValidProgressStatus(val: unknown): val is ProgressStatus {
  return typeof val === 'string' && (ALLOWED_NOTION_STATUSES as readonly string[]).includes(val)
}

/**
 * 严格白名单载荷构建器：
 * 绝不允许注入任何除 properties.Status.select.name / status.name 之外的属性，并通过深度冻结防止篡改。
 */
export function buildNotionStatusPayload(status: ProgressStatus): Readonly<NotionPagePatchPayload> {
  if (!isValidProgressStatus(status)) {
    throw new Error(
      `Security Violation: Prohibited status value "${String(status)}". ` +
      `Only ['未开始', '学习中', '已完成'] are allowed.`
    )
  }

  return Object.freeze({
    properties: Object.freeze({
      Status: Object.freeze({
        select: Object.freeze({
          name: status
        })
      })
    })
  })
}

/**
 * 严格白名单结构完整性校验器：
 * 彻底审查载荷对象的所有键名与嵌套层次，杜绝任何原型污染、非法属性注入或提权改动。
 */
export function validateNotionPayloadWhitelist(payload: unknown): payload is NotionPagePatchPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false
  }

  const root = payload as Record<string, unknown>
  const rootKeys = Object.keys(root)
  if (rootKeys.length !== 1 || rootKeys[0] !== 'properties') {
    return false
  }

  const props = root['properties']
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return false
  }

  const propKeys = Object.keys(props as Record<string, unknown>)
  if (propKeys.length !== 1 || propKeys[0] !== 'Status') {
    return false
  }

  const statusObj = (props as Record<string, unknown>)['Status']
  if (!statusObj || typeof statusObj !== 'object' || Array.isArray(statusObj)) {
    return false
  }

  const statusKeys = Object.keys(statusObj as Record<string, unknown>)
  if (statusKeys.length !== 1 || (statusKeys[0] !== 'select' && statusKeys[0] !== 'status')) {
    return false
  }

  const innerObj = (statusObj as Record<string, unknown>)[statusKeys[0]]
  if (!innerObj || typeof innerObj !== 'object' || Array.isArray(innerObj)) {
    return false
  }

  const innerKeys = Object.keys(innerObj as Record<string, unknown>)
  if (innerKeys.length !== 1 || innerKeys[0] !== 'name') {
    return false
  }

  const nameVal = (innerObj as Record<string, unknown>)['name']
  return isValidProgressStatus(nameVal)
}

// ============================================================================
// 3. 队列调度、限流器与重试控制核心
// ============================================================================

const THROTTLE_INTERVAL_MS = 350
const MAX_DEFAULT_RETRIES = 3
const BASE_RETRY_DELAY_MS = 700
// 同步端点从 site.config.mts 取：主端点用于常规回写，备用端点是主端点 404 时的降级路由
// （两者都是同源反代，前端永不直连 Notion，也不持有令牌）
const PRIMARY_SYNC_ENDPOINT = API_ENDPOINTS.notionSyncPrimary
const FALLBACK_SYNC_ENDPOINT = API_ENDPOINTS.notionSyncFallback

const syncQueue: NotionSyncItem[] = []
const failedQueue: NotionSyncItem[] = []
let inFlightTask: NotionSyncItem | null = null
let isProcessing = false
let currentSyncState: SyncState = 'idle'
let lastRequestEndTime = 0
let totalSuccessCount = 0
let totalFailedCount = 0
let totalRetriedCount = 0
let lastSyncTimestamp: number | null = null

const stateListeners = new Set<NotionSyncListener>()

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.fetch === 'function'
}

function notifyState(): void {
  const currentLen = syncQueue.length + (inFlightTask ? 1 : 0)
  for (const listener of stateListeners) {
    try {
      listener(currentSyncState, currentLen)
    } catch {
      // 隔离单个外部监听器异常，保障主循环连续性
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setTimeout !== 'undefined') {
      setTimeout(resolve, Math.max(0, ms))
    } else {
      resolve()
    }
  })
}

/**
 * 计算带微抖动的指数退避时长
 */
function calculateBackoffDelay(retryCount: number): number {
  const exponential = BASE_RETRY_DELAY_MS * Math.pow(2, retryCount)
  const jitter = Math.floor(Math.random() * 120)
  return exponential + jitter
}

/**
 * 解析 HTTP 429 响应中的 Retry-After 标头
 */
function parseRetryAfterMs(response: Response): number | null {
  try {
    let retryHeader: string | null = null
    if (response.headers && typeof response.headers.get === 'function') {
      retryHeader = response.headers.get('Retry-After')
    }
    if (!retryHeader) return null

    const parsedSeconds = parseFloat(retryHeader)
    if (!isNaN(parsedSeconds) && parsedSeconds > 0) {
      return Math.ceil(parsedSeconds * 1000)
    }

    const parsedDate = Date.parse(retryHeader)
    if (!isNaN(parsedDate)) {
      const diff = parsedDate - Date.now()
      return diff > 0 ? diff : null
    }
  } catch {
    // 忽略标头解析异常
  }

  return null
}

/**
 * 单项网络分发（零凭据同源请求）
 */
async function dispatchSyncRequest(task: NotionSyncItem): Promise<{ ok: boolean; status: number; retryAfterMs: number | null }> {
  const validatedPayload = buildNotionStatusPayload(task.status)

  const bodyContent = JSON.stringify({
    lecture_id: task.lectureId,
    status: task.status,
    notion_node_id: task.notionNodeId || '',
    notion_page_id: task.notionPageId || '',
    payload: validatedPayload,
    timestamp: task.timestamp
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }

  let res: Response
  try {
    res = await fetch(PRIMARY_SYNC_ENDPOINT, {
      method: 'POST',
      headers,
      body: bodyContent
    })

    // 若主端点 404，尝试平滑降级至备用路由
    if (res.status === 404) {
      try {
        const fallbackRes = await fetch(FALLBACK_SYNC_ENDPOINT, {
          method: 'PATCH',
          headers,
          body: bodyContent
        })
        if (fallbackRes.ok || fallbackRes.status !== 404) {
          res = fallbackRes
        }
      } catch {
        // 维持主响应
      }
    }
  } catch {
    return { ok: false, status: 0, retryAfterMs: null }
  }

  const retryAfter = res.status === 429 ? parseRetryAfterMs(res) : null
  return {
    ok: res.ok,
    status: res.status,
    retryAfterMs: retryAfter
  }
}

/**
 * 队列调度处理器（严格单例循环，消峰限流，自动重试）
 */
async function processQueue(): Promise<void> {
  if (isProcessing || !isBrowser()) return
  isProcessing = true
  currentSyncState = 'syncing'
  notifyState()

  try {
    while (syncQueue.length > 0) {
      // 1. 严格 350ms 节流拦截：确保两次 API 调用间隔永远 >= 350ms，彻底避免 3 req/s 触发 429
      const now = Date.now()
      const timeSinceLast = now - lastRequestEndTime
      if (timeSinceLast < THROTTLE_INTERVAL_MS) {
        currentSyncState = 'throttling'
        notifyState()
        await sleep(THROTTLE_INTERVAL_MS - timeSinceLast)
      }

      const task = syncQueue.shift()
      if (!task) continue

      inFlightTask = task
      currentSyncState = 'syncing'
      notifyState()

      // 2. 执行网络请求与指数退避重试循环
      let isSuccess = false
      while (task.retryCount <= task.maxRetries) {
        const result = await dispatchSyncRequest(task)
        lastRequestEndTime = Date.now()

        if (result.ok) {
          // 请求成功
          isSuccess = true
          totalSuccessCount++
          lastSyncTimestamp = Date.now()
          break
        } else {
          // 请求遇到错误（如 429、500 或网络断连）
          task.lastError = `HTTP ${result.status}`
          if (task.retryCount < task.maxRetries) {
            task.retryCount++
            totalRetriedCount++
            currentSyncState = 'retrying'
            notifyState()

            const backoffDelay = result.retryAfterMs ?? calculateBackoffDelay(task.retryCount - 1)
            await sleep(backoffDelay)
          } else {
            break
          }
        }
      }

      if (!isSuccess) {
        totalFailedCount++
        failedQueue.push({ ...task })
        currentSyncState = 'error'
        notifyState()
      }

      inFlightTask = null
      currentSyncState = syncQueue.length > 0 ? 'syncing' : 'idle'
      notifyState()
    }
  } finally {
    inFlightTask = null
    isProcessing = false
    currentSyncState = syncQueue.length > 0 ? 'syncing' : 'idle'
    notifyState()
  }
}

// ============================================================================
// 4. 对外导出的统一服务接口
// ============================================================================

/**
 * 订阅 Notion 同步队列状态变更
 */
export function subscribeNotionSyncState(listener: NotionSyncListener): () => void {
  stateListeners.add(listener)
  try {
    const queueLen = syncQueue.length + (inFlightTask ? 1 : 0)
    listener(currentSyncState, queueLen)
  } catch {
    // 忽略初次通知异常
  }
  return () => {
    stateListeners.delete(listener)
  }
}

/**
 * 查询当前待同步任务数量（含正在飞行的任务）
 */
export function getNotionSyncQueueLength(): number {
  return syncQueue.length + (inFlightTask ? 1 : 0)
}

/**
 * 查询当前是否正在进行同步
 */
export function isNotionSyncing(): boolean {
  return isProcessing || syncQueue.length > 0 || inFlightTask !== null
}

/**
 * 获取队列详细运行指标
 */
export function getNotionQueueStats(): NotionQueueStats {
  return {
    queued: syncQueue.length,
    processing: isProcessing,
    inFlight: inFlightTask !== null,
    state: currentSyncState,
    totalSuccess: totalSuccessCount,
    totalFailed: totalFailedCount,
    totalRetried: totalRetriedCount,
    lastSyncTime: lastSyncTimestamp
  }
}

/**
 * 清除已失败的任务记录
 */
export function clearFailedQueue(): void {
  failedQueue.length = 0
}

/**
 * 获取所有因重试超限而失败的任务列表
 */
export function getFailedTasks(): readonly NotionSyncItem[] {
  return Object.freeze([...failedQueue])
}

/**
 * 内部辅助：将单项讲义状态推入队列或合并防抖
 */
function enqueueItem(
  normId: string,
  status: ProgressStatus,
  notionNodeId?: string,
  notionPageId?: string
): void {
  // 若正在飞行的任务与当前讲义相同但目标状态变更，需确保等待队列追加补齐最终状态
  if (inFlightTask && inFlightTask.lectureId === normId) {
    const pending = syncQueue.find((item) => item.lectureId === normId)
    if (pending) {
      pending.status = status
      pending.timestamp = Date.now()
      if (notionNodeId) pending.notionNodeId = notionNodeId
      if (notionPageId) pending.notionPageId = notionPageId
      pending.retryCount = 0
    } else if (inFlightTask.status !== status) {
      syncQueue.push({
        lectureId: normId,
        status,
        notionNodeId: notionNodeId || inFlightTask.notionNodeId,
        notionPageId: notionPageId || inFlightTask.notionPageId,
        retryCount: 0,
        maxRetries: MAX_DEFAULT_RETRIES,
        timestamp: Date.now()
      })
    }
    return
  }

  // 正常等待队列去重与合并：若队列已有未发送项，原地更新状态
  const existingIndex = syncQueue.findIndex((item) => item.lectureId === normId)
  if (existingIndex >= 0) {
    const existing = syncQueue[existingIndex]
    if (existing) {
      existing.status = status
      existing.timestamp = Date.now()
      if (notionNodeId) existing.notionNodeId = notionNodeId
      if (notionPageId) existing.notionPageId = notionPageId
      existing.retryCount = 0
    }
  } else {
    syncQueue.push({
      lectureId: normId,
      status,
      notionNodeId,
      notionPageId,
      retryCount: 0,
      maxRetries: MAX_DEFAULT_RETRIES,
      timestamp: Date.now()
    })
  }
}

/**
 * 推送单讲状态至 Notion 队列（合并防抖去重）
 */
export function syncStatusToNotion(
  lectureId: string,
  status: ProgressStatus,
  notionNodeId?: string,
  notionPageId?: string
): void {
  if (!isBrowser() || !lectureId) return

  const normId = lectureId.trim().toLowerCase()
  if (!isValidProgressStatus(status)) {
    return
  }

  enqueueItem(normId, status, notionNodeId, notionPageId)
  notifyState()
  void processQueue()
}

/**
 * 批量推送讲次状态至 Notion 队列（适用于组目录一键标记）
 */
export function batchSyncStatusToNotion(
  items: Array<{
    lectureId: string
    status: ProgressStatus
    notionNodeId?: string
    notionPageId?: string
  }>
): void {
  if (!isBrowser() || !items || items.length === 0) return

  for (const item of items) {
    if (!item.lectureId || !isValidProgressStatus(item.status)) continue
    const normId = item.lectureId.trim().toLowerCase()
    enqueueItem(normId, item.status, item.notionNodeId, item.notionPageId)
  }

  notifyState()
  void processQueue()
}

// ============================================================================
// 5. 后端 Worker 适配助手（当在服务端环境运行直接直连 Notion 时使用）
// ============================================================================

export interface DirectNotionUpdateParams {
  notionPageId: string
  status: ProgressStatus
  token: string
  notionVersion?: string
}

/**
 * 服务端直接执行 Notion 更新函数：
 * 接收环境变量注入的凭据，执行严格白名单锁定的 PATCH /v1/pages/{page_id}。
 * 客户端严禁传入或调用包含 token 的逻辑。
 */
export async function executeDirectNotionStatusPatch(
  params: DirectNotionUpdateParams
): Promise<{ ok: boolean; status: number; error?: string }> {
  const { notionPageId, status, token, notionVersion = NOTION_API.version } = params

  if (!token || !notionPageId) {
    return { ok: false, status: 400, error: 'Missing token or notionPageId' }
  }

  if (!isValidProgressStatus(status)) {
    return { ok: false, status: 400, error: 'Prohibited status value' }
  }

  const payload = buildNotionStatusPayload(status)
  if (!validateNotionPayloadWhitelist(payload)) {
    return { ok: false, status: 403, error: 'Whitelist validation failed' }
  }

  try {
    const url = `${NOTION_API.baseUrl}/pages/${encodeURIComponent(notionPageId)}`
    const res = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': notionVersion,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })

    return {
      ok: res.ok,
      status: res.status,
      error: res.ok ? undefined : `Notion API returned status ${res.status}`
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, error: msg }
  }
}
