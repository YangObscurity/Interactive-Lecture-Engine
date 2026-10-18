/**
 * useDifyChat.ts - Dify Cloud Agent Beta SSE 流式通信与会话管理引擎
 *
 * 架构规范：
 * 1. 采用 Vue 3 Composable 规范，对外暴露响应式状态与会话控制器；
 * 2. 深度适配 Dify Cloud Agent Beta (Linux 沙箱环境) 标准 SSE 协议；
 * 3. 严格解析 event: message, event: agent_thought, event: error, event: message_end；
 * 4. 支持 AbortController 中途随时无损终止生成；
 * 5. 动态注入讲义上下文变量：current_lecture, group, selection, outline；
 * 6. 内置全功能降级 Mock 引擎，在网络离线或无后端反代时自动平滑自愈；
 * 7. 严格类型约束（Zero any），完备异常边界处理与 SSR 安全隔离；
 * 8. 严格遵守 Zero-Emoji 规范，全域禁止任何表情符号。
 */

import { ref, readonly, getCurrentInstance, onUnmounted, type Ref, type DeepReadonly } from 'vue'
// 注意：这里必须写**无扩展名**的 '../../../site.config'，不能写 '.mts'。
// 原因见 AGENTS.md §6.4：Vite SSR 构建会把 .mts externalize 成绝对 Windows 路径
// 写进产物，Node ESM 加载器会把 "G:" 当成 URL scheme 而抛
// ERR_UNSUPPORTED_ESM_URL_SCHEME。无扩展名写法由 Vite 正常内联打包。
// topic 文案（Mock 演示答案 / 思考步骤）一律来自 site.config.mts，本文件不内置领域内容。
import {
  API_ENDPOINTS,
  BRANDING,
  STORAGE_KEYS,
  AI_MOCK,
  storageKeysFor,
  readRawWithFallback,
  writeRawWithDualWrite,
} from '../../../site.config'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface AgentThought {
  id: string
  thought: string
  tool?: string
  toolInput?: string
  observation?: string
  position?: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  thought?: string
  thoughts?: AgentThought[]
  createdAt: number
  isStreaming?: boolean
  error?: string
  /** 划词引用上下文（与 types.ts 的 ChatMessage 对齐，供 ChatContainer 渲染引用卡片） */
  selectedText?: string
}

export interface DifyChatInputs {
  current_lecture?: string
  group?: string
  selection?: string
  outline?: string
  [key: string]: string | undefined
}

export interface DifyTokenUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  latency?: number
}

export interface UseDifyChatOptions {
  apiEndpoint?: string
  initialConversationId?: string
  defaultInputs?: DifyChatInputs
  userId?: string
  fallbackToMock?: boolean
  onMessage?: (message: ChatMessage) => void
  onThought?: (thought: AgentThought) => void
  onError?: (error: Error | string) => void
  onFinish?: (message: ChatMessage, usage?: DifyTokenUsage) => void
}

export interface UseDifyChatReturn {
  messages: Ref<ChatMessage[]>
  isStreaming: DeepReadonly<Ref<boolean>>
  error: DeepReadonly<Ref<string | null>>
  conversationId: DeepReadonly<Ref<string>>
  usage: DeepReadonly<Ref<DifyTokenUsage>>
  sendMessage: (query: string, customInputs?: Partial<DifyChatInputs>) => Promise<void>
  stopStreaming: () => void
  clearMessages: () => void
  setConversationId: (id: string) => void
  removeMessage: (id: string) => void
  retryLastMessage: () => Promise<void>
}

interface RawDifyMessageEvent {
  event: 'message' | 'agent_message'
  task_id?: string
  id?: string
  message_id?: string
  conversation_id?: string
  answer?: string
  created_at?: number
}

interface RawDifyThoughtEvent {
  event: 'agent_thought'
  id?: string
  task_id?: string
  message_id?: string
  position?: number
  thought?: string
  observation?: string
  tool?: string
  tool_input?: string
  created_at?: number
}

interface RawDifyMessageEndEvent {
  event: 'message_end'
  task_id?: string
  id?: string
  message_id?: string
  conversation_id?: string
  metadata?: {
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
      latency?: number
    }
  }
}

interface RawDifyMessageReplaceEvent {
  event: 'message_replace'
  task_id?: string
  message_id?: string
  conversation_id?: string
  answer?: string
}

interface RawDifyErrorEvent {
  event: 'error'
  task_id?: string
  id?: string
  message_id?: string
  status?: number
  code?: string
  message?: string
}

function generateId(prefix = 'msg'): string {
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${time}_${rand}`
}

function getStoredOrNewUserId(): string {
  if (typeof window === 'undefined') {
    return 'ssr_reader_guest'
  }
  const keys = storageKeysFor(STORAGE_KEYS.aiChatUserId)
  const stored = readRawWithFallback(keys)
  if (stored && stored.trim().length > 0) {
    return stored
  }
  const newId = `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  writeRawWithDualWrite(keys, newId)
  return newId
}

function parseSSEBlock(rawBlock: string): { event: string; data: string } | null {
  const lines = rawBlock.split(/\r?\n/)
  let eventType = 'message'
  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length === 0 && eventType === 'message') {
    return null
  }

  return {
    event: eventType,
    data: dataLines.join('\n')
  }
}

/**
 * 通用占位符渲染：把模板里的 `{name}` 替换成 vars 里对应的值。
 *
 * 稳健性约定（刻意如此，勿改成抛错）：**未知占位符原样保留**。
 * 第三方用户在 site.config.mts 里往模板写了没约定的占位符，
 * 或演示正文本身含花括号时，最坏结果只是把字面量显示出来，
 * 而不会让整个离线降级链路炸掉。
 *
 * 只替换 `{标识符}` 形态（字母/数字/下划线），因此不会误伤
 * 代码块里的 `${...}`、JSON 花括号等文本。
 */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole
  )
}

export function useDifyChat(options: UseDifyChatOptions = {}): UseDifyChatReturn {
  // 默认端点来自 site.config.mts：换后端反代部署时只改配置，不必翻本文件
  const apiEndpoint = options.apiEndpoint || API_ENDPOINTS.aiChat
  // 调用方显式传 fallbackToMock 时以调用方为准；否则看 AI_MOCK.enabled（默认 true，
  // 因此不传参时的行为与历史版本逐字节一致）
  const fallbackToMock =
    options.fallbackToMock !== undefined ? options.fallbackToMock : AI_MOCK.enabled

  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref<boolean>(false)
  const error = ref<string | null>(null)
  const conversationId = ref<string>(options.initialConversationId || '')
  const usage = ref<DifyTokenUsage>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latency: 0
  })

  let abortController: AbortController | null = null
  let lastUserQuery = ''
  let lastInputs: DifyChatInputs = {}

  if (getCurrentInstance()) {
    onUnmounted(() => {
      stopStreaming()
    })
  }

  const stopStreaming = (): void => {
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    if (isStreaming.value) {
      isStreaming.value = false
      const lastMsg = messages.value[messages.value.length - 1]
      if (lastMsg && lastMsg.role === 'assistant' && lastMsg.isStreaming) {
        lastMsg.isStreaming = false
      }
    }
  }

  const clearMessages = (): void => {
    stopStreaming()
    messages.value = []
    error.value = null
  }

  const setConversationId = (id: string): void => {
    conversationId.value = id
  }

  const removeMessage = (id: string): void => {
    messages.value = messages.value.filter((m) => m.id !== id)
  }

  const streamFromMock = async (
    query: string,
    inputs: DifyChatInputs,
    assistantMsg: ChatMessage,
    signal: AbortSignal
  ): Promise<void> => {
    const lectureTitle = inputs.current_lecture || BRANDING.unknownLectureName

    // 演示文案整体外置在 site.config.mts 的 AI_MOCK 中。
    // 本文件只负责「取模板 → 填占位符 → 打字机输出」，保持领域中立。
    const templateVars: Record<string, string> = {
      lecture: lectureTitle,
      section: inputs.outline
        ? renderTemplate(AI_MOCK.sectionHintWithOutline, { outline: inputs.outline })
        : AI_MOCK.sectionHintWithoutOutline,
      selection: inputs.selection
        ? renderTemplate(AI_MOCK.selectionQuoteTemplate, { text: inputs.selection })
        : '',
      demo: AI_MOCK.demoAnswer,
      group: inputs.group || BRANDING.genericGroupName,
      query,
    }

    const thoughtSteps: Array<{ thought: string; tool?: string; toolInput?: string; obs?: string }> =
      AI_MOCK.thinkingSteps.map((step) => ({
        thought: renderTemplate(step.thought, templateVars),
        tool: 'tool' in step ? step.tool : undefined,
        toolInput: 'toolInput' in step ? renderTemplate(step.toolInput, templateVars) : undefined,
        obs: 'obs' in step ? renderTemplate(step.obs, templateVars) : undefined
      }))

    for (let i = 0; i < thoughtSteps.length; i++) {
      if (signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, 180))
      if (signal.aborted) return

      const step = thoughtSteps[i]
      const thoughtItem: AgentThought = {
        id: `mock_thought_${i}_${Date.now()}`,
        thought: step.thought,
        tool: step.tool,
        toolInput: step.toolInput,
        observation: step.obs,
        position: i + 1
      }

      if (!assistantMsg.thoughts) {
        assistantMsg.thoughts = []
      }
      assistantMsg.thoughts.push(thoughtItem)
      assistantMsg.thought = step.thought
      options.onThought?.(thoughtItem)
    }

    const mockResponseText = renderTemplate(AI_MOCK.replyTemplate, templateVars)

    const chunks = mockResponseText.match(/.{1,4}/gu) || [mockResponseText]

    for (const chunk of chunks) {
      if (signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, 35))
      if (signal.aborted) return

      assistantMsg.content += chunk
      options.onMessage?.(assistantMsg)
    }

    if (signal.aborted) return

    usage.value = {
      promptTokens: 320,
      completionTokens: 180,
      totalTokens: 500,
      latency: 0.85
    }

    if (!conversationId.value) {
      conversationId.value = `mock_conv_${Date.now().toString(36)}`
    }

    assistantMsg.isStreaming = false
    isStreaming.value = false
    options.onFinish?.(assistantMsg, usage.value)
  }

  /** 模板占位符净化：兜底替换模型可能直接输出的未解析 {{variable}} 变量 */
  const sanitizeTemplatePlaceholders = (text: string, inputs?: DifyChatInputs): string => {
    if (!text) return ''
    const lecture = inputs?.current_lecture || BRANDING.knowledgeBaseName
    const group = inputs?.group || BRANDING.allGroupsName
    const outline = inputs?.outline || BRANDING.wholeOutlineName
    const selection = inputs?.selection || BRANDING.noSelectionName

    return text
      .replace(/\{\{\s*current_lecture\s*\}\}/gi, lecture)
      .replace(/\{\{\s*group\s*\}\}/gi, group)
      .replace(/\{\{\s*outline\s*\}\}/gi, outline)
      .replace(/\{\{\s*selection\s*\}\}/gi, selection)
  }

  const handleSSEEvent = (
    eventType: string,
    dataStr: string,
    assistantMsg: ChatMessage
  ): void => {
    if (!dataStr || dataStr === '[DONE]') {
      return
    }

    let parsedJson: Record<string, unknown>
    try {
      parsedJson = JSON.parse(dataStr) as Record<string, unknown>
    } catch {
      return
    }

    const eventName = (typeof parsedJson.event === 'string' ? parsedJson.event : eventType) || 'message'

    switch (eventName) {
      case 'message':
      case 'agent_message': {
        const payload = parsedJson as unknown as RawDifyMessageEvent
        if (payload.answer) {
          assistantMsg.content += sanitizeTemplatePlaceholders(payload.answer, lastInputs)
          options.onMessage?.(assistantMsg)
        }
        if (payload.conversation_id && !conversationId.value) {
          conversationId.value = payload.conversation_id
        }
        break
      }

      case 'agent_thought': {
        const payload = parsedJson as unknown as RawDifyThoughtEvent
        const thoughtItem: AgentThought = {
          id: payload.id || generateId('thought'),
          thought: payload.thought || '',
          tool: payload.tool,
          toolInput: payload.tool_input,
          observation: payload.observation,
          position: payload.position
        }

        if (!assistantMsg.thoughts) {
          assistantMsg.thoughts = []
        }

        const existingIdx = assistantMsg.thoughts.findIndex((t) => t.id === thoughtItem.id)
        if (existingIdx >= 0) {
          assistantMsg.thoughts[existingIdx] = thoughtItem
        } else {
          assistantMsg.thoughts.push(thoughtItem)
        }

        if (thoughtItem.thought) {
          assistantMsg.thought = thoughtItem.thought
        }

        options.onThought?.(thoughtItem)
        break
      }

      case 'message_replace': {
        const payload = parsedJson as unknown as RawDifyMessageReplaceEvent
        if (typeof payload.answer === 'string') {
          assistantMsg.content = sanitizeTemplatePlaceholders(payload.answer, lastInputs)
          options.onMessage?.(assistantMsg)
        }
        break
      }

      case 'message_end': {
        const payload = parsedJson as unknown as RawDifyMessageEndEvent
        if (payload.conversation_id) {
          conversationId.value = payload.conversation_id
        }

        const rawUsage = payload.metadata?.usage
        if (rawUsage) {
          usage.value = {
            promptTokens: rawUsage.prompt_tokens ?? 0,
            completionTokens: rawUsage.completion_tokens ?? 0,
            totalTokens: rawUsage.total_tokens ?? 0,
            latency: rawUsage.latency ?? 0
          }
        }

        assistantMsg.isStreaming = false
        isStreaming.value = false
        options.onFinish?.(assistantMsg, usage.value)
        break
      }

      case 'error': {
        const payload = parsedJson as unknown as RawDifyErrorEvent
        const errMsg = payload.message || payload.code || 'Dify API 执行发生异常'
        error.value = errMsg
        assistantMsg.error = errMsg
        assistantMsg.isStreaming = false
        isStreaming.value = false
        options.onError?.(errMsg)
        break
      }

      case 'ping':
      default:
        break
    }
  }

  const readSSEStream = async (
    response: Response,
    assistantMsg: ChatMessage,
    signal: AbortSignal
  ): Promise<void> => {
    if (!response.body) {
      throw new Error('响应体为空，无法建立流式传输')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    try {
      while (true) {
        if (signal.aborted) {
          await reader.cancel().catch(() => {})
          break
        }

        const { done, value } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })

        let boundaryIndex = buffer.search(/\r?\n\r?\n/)
        while (boundaryIndex !== -1) {
          const rawBlock = buffer.slice(0, boundaryIndex)
          const match = buffer.slice(boundaryIndex).match(/^\r?\n\r?\n/)
          const delimLen = match ? match[0].length : 2
          buffer = buffer.slice(boundaryIndex + delimLen)

          const trimmed = rawBlock.trim()
          if (trimmed) {
            const parsed = parseSSEBlock(trimmed)
            if (parsed) {
              handleSSEEvent(parsed.event, parsed.data, assistantMsg)
            }
          }

          boundaryIndex = buffer.search(/\r?\n\r?\n/)
        }
      }

      buffer += decoder.decode()
      if (buffer.trim()) {
        const parsed = parseSSEBlock(buffer.trim())
        if (parsed) {
          handleSSEEvent(parsed.event, parsed.data, assistantMsg)
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  const sendMessage = async (
    query: string,
    customInputs: Partial<DifyChatInputs> = {}
  ): Promise<void> => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) {
      return
    }

    if (isStreaming.value) {
      stopStreaming()
    }

    error.value = null
    lastUserQuery = trimmedQuery

    const mergedInputs: DifyChatInputs = {
      ...(options.defaultInputs || {}),
      ...customInputs
    }
    lastInputs = mergedInputs

    const rawSel = (customInputs.selection || '').trim()
    const validSelection = rawSel && rawSel !== BRANDING.noSelectionName ? rawSel : undefined

    const userMessage: ChatMessage = {
      id: generateId('usr'),
      role: 'user',
      content: trimmedQuery,
      selectedText: validSelection,
      createdAt: Date.now()
    }
    const assistantMessage: ChatMessage = {
      id: generateId('ast'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      isStreaming: true
    }

    messages.value.push(userMessage)
    messages.value.push(assistantMessage)
    // 关键响应式守卫：从 Proxy 数组中获取已代理的响应式引用，确保每个分块追加即时驱动 Vue 3 视图打字机渲染
    const liveAssistantMsg = messages.value[messages.value.length - 1]
    isStreaming.value = true

    abortController = new AbortController()
    const signal = abortController.signal

    const userId = options.userId || getStoredOrNewUserId()

    // 上下文注入双重保障：
    // 1. 在 requestPayload.inputs 依然传递 mergedInputs（标准 Dify 变量协议）；
    // 2. 针对 Dify 后台可能未显式声明变量导致的 inputs 丢失，将上下文元数据作为结构化隐式提示置入 query 头部，
    //    确保大模型能无损感知讲义、课程组、小节与选区。用户界面上保持 userMessage.content 为用户原话。
    const hasContext = Boolean(mergedInputs.current_lecture || mergedInputs.group)
    let queryForModel = trimmedQuery
    if (hasContext) {
      const secPart = mergedInputs.outline && mergedInputs.outline !== BRANDING.wholeOutlineName ? ` | 当前小节: ${mergedInputs.outline}` : ''
      const selPart = mergedInputs.selection && mergedInputs.selection !== BRANDING.noSelectionName ? ` | 划选内容: "${mergedInputs.selection}"` : ''
      const ctxPrefix = `[系统注入上下文 | 讲义: ${mergedInputs.current_lecture || BRANDING.siteWideLectureName} | 课程组: ${mergedInputs.group || BRANDING.genericGroupName}${secPart}${selPart}]\n\n`
      queryForModel = `${ctxPrefix}${trimmedQuery}`
    }

    const requestPayload = {
      inputs: mergedInputs,
      query: queryForModel,
      response_mode: 'streaming',
      conversation_id: conversationId.value || '',
      user: userId
    }

    try {
      let response: Response | null = null

      try {
        response = await fetch(apiEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream'
          },
          body: JSON.stringify(requestPayload),
          signal
        })
      } catch (fetchErr: unknown) {
        if (signal.aborted) {
          return
        }
        if (fallbackToMock) {
          await streamFromMock(trimmedQuery, mergedInputs, liveAssistantMsg, signal)
          return
        }
        throw fetchErr
      }

      if (!response.ok) {
        // Mock 降级白名单：dev 无反代(404) / 网关坏网关(502/503) / 未认证被认证网关拦截(401) / 禁止访问(403)
        // 生产实测（task-3 T4）：匿名 POST /api/ai/chat 返回 401，故 401 必须纳入降级而非抛错白屏。
        if (
          fallbackToMock &&
          (response.status === 404 ||
            response.status === 401 ||
            response.status === 403 ||
            response.status === 502 ||
            response.status === 503)
        ) {
          await streamFromMock(trimmedQuery, mergedInputs, liveAssistantMsg, signal)
          return
        }
        const errorText = await response.text().catch(() => '')
        throw new Error(`HTTP ${response.status}: ${errorText || response.statusText}`)
      }

      await readSSEStream(response, liveAssistantMsg, signal)

      if (liveAssistantMsg.isStreaming) {
        liveAssistantMsg.isStreaming = false
        isStreaming.value = false
        options.onFinish?.(liveAssistantMsg, usage.value)
      }
    } catch (err: unknown) {
      if (signal.aborted) {
        liveAssistantMsg.isStreaming = false
        isStreaming.value = false
        return
      }

      const errMsg = err instanceof Error ? err.message : String(err)
      error.value = errMsg
      liveAssistantMsg.error = errMsg
      if (!liveAssistantMsg.content) {
        liveAssistantMsg.content = `[提示] ${errMsg}`
      }
      liveAssistantMsg.isStreaming = false
      isStreaming.value = false
      options.onError?.(errMsg)
    } finally {
      if (abortController?.signal === signal) {
        abortController = null
      }
    }
  }

  const retryLastMessage = async (): Promise<void> => {
    if (!lastUserQuery || isStreaming.value) {
      return
    }

    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg && lastMsg.role === 'assistant') {
      messages.value.pop()
    }
    const prevUserMsg = messages.value[messages.value.length - 1]
    if (prevUserMsg && prevUserMsg.role === 'user') {
      messages.value.pop()
    }

    await sendMessage(lastUserQuery, lastInputs)
  }

  return {
    messages,
    isStreaming: readonly(isStreaming),
    error: readonly(error),
    conversationId: readonly(conversationId),
    usage: readonly(usage),
    sendMessage,
    stopStreaming,
    clearMessages,
    setConversationId,
    removeMessage,
    retryLastMessage
  }
}
