/**
 * useDifyChat.ts — AI companion streaming composable (P6, FE-003/006/022/024, port ledger §3.2).
 *
 * Responsibilities:
 *   - Supports two real transport paths: same-origin proxy (`API_ENDPOINTS.aiChat`, Dify SSE) and
 *     browser-direct BYOK OpenAI-compatible endpoint (`byokClient.ts`, OpenAI SSE).
 *   - Parses SSE streams cleanly via `sseParser.ts` (handles arbitrary chunks and `event: error`).
 *   - Offline truth (`FE-003`): never hides failures behind fake mock responses; mock fallback runs
 *     only when `fallbackToMock` is explicitly true (`VITE_AI_MOCK === '1'` or option override),
 *     using domain-neutral templates from `AI_MOCK` (`site.config.mts`) labeled as demo output.
 */

import { ref, readonly, type Ref, type DeepReadonly } from 'vue'
import { AI_MOCK, API_ENDPOINTS, BRANDING } from '../../../site.config.mts'
import { currentLang, translate, type LangCode } from '../../../i18n/index.ts'
import { normalizePromptLang } from '../../../prompts/companion.ts'
import { getQuickActions } from '../../../prompts/store.ts'
import { isEnabled } from '../../debug/flags'
import {
  buildOpenAiChatRequest,
  buildOpenAiInitialMessages,
  createOpenAiToolCallAccumulator,
  DEFAULT_BYOK_TIMEOUT_MS,
  executeReaderToolCall,
  fetchReaderTools,
  isByokActive,
  readByokConfig,
  setByokVerifyState,
  toOpenAiTools,
  type OpenAiChatLoopMessage,
  type OpenAiHistoryTurn,
  type OpenAiToolCall,
} from './byokClient'
import { companionRuntime, type CompanionAdapter } from './companionRuntime'
import { createSseParser, type ParsedSseEvent } from './sseParser'
import type { ChatToolCall } from './types'

export type MessageRole = 'user' | 'assistant' | 'system'

export interface AgentThought {
  id: string
  thought: string
  observation?: string
  tool?: string
  toolInput?: string
  position?: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  thought?: string
  thoughts?: AgentThought[]
  toolCalls?: ChatToolCall[]
  createdAt: number
  isStreaming?: boolean
  isError?: boolean
  isIncomplete?: boolean
  isMock?: boolean
  error?: string
  errorDetail?: string
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

export interface SendMessageOutcome {
  ok: boolean
  isError: boolean
  isIncomplete?: boolean
  isMock: boolean
  conversationId: string
  userMessage: ChatMessage
  assistantMessage: ChatMessage
}

export interface UseDifyChatOptions {
  apiEndpoint?: string
  toolsEndpoint?: string
  fetchFn?: typeof fetch
  adapter?: CompanionAdapter
  initialConversationId?: string
  defaultInputs?: DifyChatInputs
  fallbackToMock?: boolean
  timeoutMs?: number
  onMessage?: (message: ChatMessage) => void
  onThought?: (thought: AgentThought) => void
  onError?: (error: Error | string) => void
  onFinish?: (message: ChatMessage, usage?: DifyTokenUsage) => void
  onRateLimited?: (retryAfterSec: number) => void
  onUnconfigured?: () => void
  onUnavailable?: (detail: string) => void
  onProxyOk?: () => void
}

export interface SendChatMessageOptions {
  actionId?: string
  displayLabel?: string
  lang?: LangCode
}

export interface UseDifyChatReturn {
  messages: Ref<ChatMessage[]>
  isStreaming: DeepReadonly<Ref<boolean>>
  error: DeepReadonly<Ref<string | null>>
  conversationId: DeepReadonly<Ref<string>>
  usage: DeepReadonly<Ref<DifyTokenUsage>>
  sendMessage: (
    query: string,
    customInputs?: Partial<DifyChatInputs>,
    sendOptions?: SendChatMessageOptions,
  ) => Promise<SendMessageOutcome | null>
  stopStreaming: () => void
  clearMessages: () => void
  setConversationId: (id: string) => void
  removeMessage: (id: string) => void
  retryLastMessage: () => Promise<SendMessageOutcome | null>
}

function generateId(prefix = 'msg'): string {
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${time}_${rand}`
}

/**
 * Pure literal placeholder substitution (`AI_MOCK` templates leave unknown `{tokens}` intact).
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match
  )
}

function sanitizeTemplatePlaceholders(text: string, inputs?: DifyChatInputs): string {
  if (!text) return ''
  const lang = currentLang()
  const lecture = inputs?.current_lecture || translate(lang, 'ai.globalContextName')
  const group = inputs?.group || translate(lang, 'ai.globalGroupName')
  const outline = inputs?.outline || translate(lang, 'ai.lectureOutlineName')
  const selection = inputs?.selection || translate(lang, 'ai.noSelection')

  return text
    .replace(/\{\{\s*current_lecture\s*\}\}/gi, lecture)
    .replace(/\{\{\s*group\s*\}\}/gi, group)
    .replace(/\{\{\s*outline\s*\}\}/gi, outline)
    .replace(/\{\{\s*selection\s*\}\}/gi, selection)
}

function isDebugMockRequested(explicitOption?: boolean): boolean {
  if (explicitOption === true) return true
  if (explicitOption === false) return false
  try {
    return isEnabled('aiMock')
  } catch {
    return false
  }
}

function parseRetryAfterSeconds(response: Response, bodyText: string): number {
  const rawHeader = response.headers?.get?.('retry-after')
  if (rawHeader) {
    const asNum = Number(rawHeader.trim())
    if (Number.isFinite(asNum) && asNum > 0) return Math.max(1, Math.ceil(asNum))
    const asDate = Date.parse(rawHeader)
    if (Number.isFinite(asDate)) {
      const diff = Math.ceil((asDate - Date.now()) / 1000)
      if (diff > 0) return diff
    }
  }
  try {
    const json = JSON.parse(bodyText) as { retry_after?: unknown } | null
    if (json && typeof json.retry_after === 'number' && Number.isFinite(json.retry_after) && json.retry_after > 0) {
      return Math.max(1, Math.ceil(json.retry_after))
    }
  } catch {
    // ignore non-JSON body
  }
  return 10
}

export function useDifyChat(options: UseDifyChatOptions = {}): UseDifyChatReturn {
  const apiEndpoint = options.apiEndpoint || API_ENDPOINTS.aiChat
  const toolsEndpoint = options.toolsEndpoint || API_ENDPOINTS.aiTools
  const fetchImpl: typeof fetch = options.fetchFn ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? DEFAULT_BYOK_TIMEOUT_MS

  const messages = ref<ChatMessage[]>([])
  const isStreaming = ref<boolean>(false)
  const error = ref<string | null>(null)
  const conversationId = ref<string>(options.initialConversationId || '')
  const usage = ref<DifyTokenUsage>({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  })

  let abortController: AbortController | null = null
  let lastUserQuery = ''
  let lastInputs: Partial<DifyChatInputs> | undefined
  let lastSendOptions: SendChatMessageOptions | undefined

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
    conversationId.value = ''
    usage.value = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
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
    assistantMsg.isMock = true
    const lectureTitle = inputs.current_lecture || BRANDING.unknownLectureName
    const vars: Record<string, string> = {
      lecture: lectureTitle,
      group: inputs.group || BRANDING.genericGroupName,
      outline: inputs.outline || BRANDING.wholeOutlineName,
      selection: inputs.selection || '',
      query,
    }

    const sectionHint = inputs.outline
      ? renderTemplate(AI_MOCK.sectionHintWithOutline, vars)
      : AI_MOCK.sectionHintWithoutOutline
    const selectionQuote =
      inputs.selection && inputs.selection !== BRANDING.noSelectionName && inputs.selection !== translate(currentLang(), 'ai.noSelection')
        ? renderTemplate(AI_MOCK.selectionQuoteTemplate, { text: inputs.selection })
        : ''
    const demoText = renderTemplate(AI_MOCK.demoAnswer, vars)
    const bodyText = renderTemplate(AI_MOCK.replyTemplate, {
      lecture: lectureTitle,
      section: sectionHint,
      selection: selectionQuote,
      demo: demoText,
    })

    for (let i = 0; i < AI_MOCK.thinkingSteps.length; i++) {
      if (signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, 60))
      if (signal.aborted) return

      const step = AI_MOCK.thinkingSteps[i]!
      const thoughtText = renderTemplate(step.thought, vars)
      const thoughtItem: AgentThought = {
        id: `mock_thought_${i}_${Date.now()}`,
        thought: thoughtText,
        tool: 'tool' in step ? step.tool : undefined,
        toolInput: 'toolInput' in step ? renderTemplate(step.toolInput, vars) : undefined,
        observation: 'obs' in step ? renderTemplate(step.obs, vars) : undefined,
        position: i + 1,
      }
      if (!assistantMsg.thoughts) assistantMsg.thoughts = []
      assistantMsg.thoughts.push(thoughtItem)
      assistantMsg.thought = thoughtText
      options.onThought?.(thoughtItem)
    }

    const prefix = translate(currentLang(), 'ai.mockLabel')
    const fullText = prefix + bodyText
    const chunks = fullText.match(/.{1,12}/gu) || [fullText]
    for (const chunk of chunks) {
      if (signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, 15))
      if (signal.aborted) return
      assistantMsg.content += chunk
      options.onMessage?.(assistantMsg)
    }

    if (signal.aborted) return
    usage.value = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    assistantMsg.isStreaming = false
    isStreaming.value = false
    options.onFinish?.(assistantMsg, usage.value)
  }

  interface SseStepState {
    stepText: string
    finishReason: string
    toolAcc: ReturnType<typeof createOpenAiToolCallAccumulator>
    deferFinalizeOnDone?: boolean
    prependParagraphBreak?: boolean
  }

  const applyParsedEvent = (
    ev: ParsedSseEvent,
    assistantMsg: ChatMessage,
    inputs: DifyChatInputs,
    stepState?: SseStepState,
  ): void => {
    if (ev.type === 'tool_call') {
      if (!assistantMsg.toolCalls) assistantMsg.toolCalls = []
      if (ev.state === 'start') {
        assistantMsg.toolCalls.push({
          id: generateId('tc'),
          name: ev.name,
          state: 'running',
        })
      } else {
        const runningMatch = [...assistantMsg.toolCalls]
          .reverse()
          .find((item) => item.name === ev.name && item.state === 'running')
        if (runningMatch) {
          runningMatch.state = ev.ok === false ? 'error' : 'done'
        } else {
          assistantMsg.toolCalls.push({
            id: generateId('tc'),
            name: ev.name,
            state: ev.ok === false ? 'error' : 'done',
          })
        }
      }
      options.onMessage?.(assistantMsg)
      return
    }

    if (ev.type === 'tool_call_delta') {
      stepState?.toolAcc.pushDelta(ev)
      return
    }

    if (ev.type === 'finish_reason') {
      if (stepState) stepState.finishReason = ev.reason
      return
    }

    if (ev.type === 'thought') {
      if (ev.conversationId) conversationId.value = ev.conversationId
      const item: AgentThought = {
        id: ev.messageId || generateId('thought'),
        thought: sanitizeTemplatePlaceholders(ev.thought, inputs),
        observation: ev.observation,
        tool: ev.tool,
        toolInput: ev.toolInput,
      }
      if (!assistantMsg.thoughts) assistantMsg.thoughts = []
      assistantMsg.thoughts.push(item)
      assistantMsg.thought = item.thought
      options.onThought?.(item)
      return
    }

    if (ev.type === 'delta') {
      if (ev.conversationId) conversationId.value = ev.conversationId
      const clean = sanitizeTemplatePlaceholders(ev.text, inputs)
      if (stepState) {
        if (stepState.prependParagraphBreak && clean.length > 0 && assistantMsg.content.length > 0) {
          assistantMsg.content += '\n\n'
          stepState.prependParagraphBreak = false
        }
        stepState.stepText += clean
      }
      assistantMsg.content += clean
      options.onMessage?.(assistantMsg)
      return
    }

    if (ev.type === 'done') {
      if (ev.conversationId) conversationId.value = ev.conversationId
      if (ev.usage) {
        usage.value = {
          promptTokens: ev.usage.prompt_tokens ?? usage.value.promptTokens,
          completionTokens: ev.usage.completion_tokens ?? usage.value.completionTokens,
          totalTokens: ev.usage.total_tokens ?? usage.value.totalTokens,
        }
      }
      if (!stepState?.deferFinalizeOnDone) {
        assistantMsg.isStreaming = false
        isStreaming.value = false
        options.onFinish?.(assistantMsg, usage.value)
      }
      return
    }

    if (ev.type === 'error') {
      throw new Error(ev.message)
    }
  }

  const readSSEStream = async (
    response: Response,
    assistantMsg: ChatMessage,
    inputs: DifyChatInputs,
    signal: AbortSignal,
    resetTimeout?: () => void,
    stepState?: SseStepState,
  ): Promise<{ completedCleanly: boolean; sawError: boolean }> => {
    const ctype = response.headers?.get?.('content-type')?.toLowerCase() ?? ''
    if (ctype.includes('application/json')) {
      const json = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }
          finish_reason?: string | null
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      resetTimeout?.()
      const choice = json.choices?.[0]
      const msgText = choice?.message?.content
      if (typeof msgText === 'string' && msgText.length > 0) {
        applyParsedEvent({ type: 'delta', text: msgText }, assistantMsg, inputs, stepState)
      }
      const rawCalls = choice?.message?.tool_calls
      if (Array.isArray(rawCalls) && stepState) {
        rawCalls.forEach((tc, idx) => {
          stepState.toolAcc.pushDelta({
            index: idx,
            id: tc.id,
            callType: tc.type,
            name: tc.function?.name,
            argumentsChunk: tc.function?.arguments ?? '',
          })
        })
      }
      if (typeof choice?.finish_reason === 'string' && stepState) {
        stepState.finishReason = choice.finish_reason
      }
      applyParsedEvent({ type: 'done', usage: json.usage }, assistantMsg, inputs, stepState)
      return { completedCleanly: true, sawError: false }
    }

    const parser = createSseParser()
    if (!response.body) {
      const text = await response.text()
      resetTimeout?.()
      for (const ev of [...parser.feed(text), ...parser.flush()]) {
        applyParsedEvent(ev, assistantMsg, inputs, stepState)
      }
      return { completedCleanly: parser.sawDone(), sawError: parser.sawError() }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    try {
      while (true) {
        if (signal.aborted) break
        const { done, value } = await reader.read()
        if (done) break
        resetTimeout?.()
        if (value) {
          const text = decoder.decode(value, { stream: true })
          for (const ev of parser.feed(text)) {
            applyParsedEvent(ev, assistantMsg, inputs, stepState)
          }
        }
      }
      const tail = decoder.decode()
      for (const ev of [...parser.feed(tail), ...parser.flush()]) {
        applyParsedEvent(ev, assistantMsg, inputs, stepState)
      }
      return { completedCleanly: parser.sawDone(), sawError: parser.sawError() }
    } finally {
      reader.releaseLock()
    }
  }

  const sendMessage = async (
    query: string,
    customInputs?: Partial<DifyChatInputs>,
    sendOptions?: SendChatMessageOptions,
  ): Promise<SendMessageOutcome | null> => {
    const trimmedQuery = query.trim()
    const actionId = sendOptions?.actionId?.trim() || undefined
    if (!trimmedQuery && !actionId) return null

    const runtimeAdapter = options.adapter ?? companionRuntime().adapter
    if (runtimeAdapter === 'off') {
      return null
    }

    if (isStreaming.value) {
      stopStreaming()
    }

    lastUserQuery = trimmedQuery
    lastInputs = customInputs
    lastSendOptions = sendOptions
    error.value = null

    const mergedInputs: DifyChatInputs = {
      ...options.defaultInputs,
      ...customInputs,
    }

    const rawSel = (mergedInputs.selection || '').trim()
    const cleanSel =
      rawSel && rawSel !== translate(currentLang(), 'ai.noSelection') && rawSel !== BRANDING.noSelectionName
        ? rawSel
        : undefined

    const activeLang = sendOptions?.lang ?? currentLang()
    const promptLang = normalizePromptLang(activeLang)
    const actionSpec = actionId ? getQuickActions().find((a) => a.id === actionId) : undefined
    const visibleUserContent = trimmedQuery || sendOptions?.displayLabel || actionSpec?.label[promptLang] || actionId || ''

    const priorHistory: OpenAiHistoryTurn[] = messages.value
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.isError && !m.isIncomplete && !m.isMock && m.content.trim().length > 0)
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      }))

    const userMsg: ChatMessage = {
      id: generateId('user'),
      role: 'user',
      content: visibleUserContent,
      selectedText: cleanSel,
      createdAt: Date.now(),
    }
    messages.value.push(userMsg)

    const liveAssistantMsg: ChatMessage = {
      id: generateId('assistant'),
      role: 'assistant',
      content: '',
      thoughts: [],
      toolCalls: [],
      createdAt: Date.now(),
      isStreaming: true,
    }
    messages.value.push(liveAssistantMsg)
    const reactiveAssistantMsg = messages.value[messages.value.length - 1] ?? liveAssistantMsg
    isStreaming.value = true

    abortController = new AbortController()
    const signal = abortController.signal
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let timedOut = false
    const clearTimer = () => {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
    }
    const armTimeout = () => {
      clearTimer()
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true
          abortController?.abort()
        }, timeoutMs)
      }
    }

    const byok = readByokConfig()
    const useByok = isByokActive(byok)
    // true once the proxy status callbacks have seen this failure (HTTP error or fetch failure)
    let proxyStatusHandled = false

    const handleCancelled = (): SendMessageOutcome => {
      reactiveAssistantMsg.isStreaming = false
      isStreaming.value = false
      return {
        ok: false,
        isError: true,
        isMock: false,
        conversationId: conversationId.value,
        userMessage: userMsg,
        assistantMessage: reactiveAssistantMsg,
      }
    }

    const handleIncomplete = (msg: string): SendMessageOutcome => {
      reactiveAssistantMsg.isStreaming = false
      reactiveAssistantMsg.isIncomplete = true
      reactiveAssistantMsg.isError = true
      reactiveAssistantMsg.error = msg
      reactiveAssistantMsg.errorDetail = msg
      error.value = msg
      isStreaming.value = false
      if (useByok) setByokVerifyState('failed', 'incomplete_stream')
      else options.onUnavailable?.('incomplete_stream')
      options.onError?.(msg)
      return {
        ok: false,
        isError: true,
        isIncomplete: true,
        isMock: false,
        conversationId: conversationId.value,
        userMessage: userMsg,
        assistantMessage: reactiveAssistantMsg,
      }
    }

    const executeFetch = async (fetchUrl: string, fetchInit: RequestInit): Promise<Response> => {
      let response: Response
      try {
        response = await fetchImpl(fetchUrl, fetchInit)
      } catch (fetchErr: unknown) {
        clearTimer()
        if (signal.aborted && !timedOut) {
          throw Object.assign(new Error('aborted'), { __lecAborted: true })
        }
        if (useByok) {
          const msg = timedOut ? 'timeout' : fetchErr instanceof Error ? fetchErr.message : 'network_error'
          setByokVerifyState('failed', msg)
        } else {
          proxyStatusHandled = true
          options.onUnavailable?.(fetchErr instanceof Error ? fetchErr.message : 'network_error')
        }
        throw fetchErr
      }

      if (!response.ok) {
        clearTimer()
        const errorText = await response.text().catch(() => '')
        let friendlyMsg = ''
        proxyStatusHandled = true
        const errLang = sendOptions?.lang ?? currentLang()
        if (useByok) {
          const msg = `HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 160)}` : ''}`
          setByokVerifyState('failed', `HTTP ${response.status}`)
          friendlyMsg = msg
        } else if (response.status === 429) {
          const waitSec = parseRetryAfterSeconds(response, errorText)
          options.onRateLimited?.(waitSec)
          friendlyMsg = translate(errLang, 'ai.errRateLimited', { seconds: waitSec })
        } else if (response.status === 413) {
          friendlyMsg = translate(errLang, 'ai.errPayloadTooLarge')
        } else if (response.status === 403) {
          friendlyMsg = translate(errLang, 'ai.errAnonymousDisabled')
        } else if (response.status === 401) {
          friendlyMsg = translate(errLang, 'ai.errUnauthorized')
        } else if (response.status === 503) {
          options.onUnconfigured?.()
          friendlyMsg = translate(errLang, 'ai.errNotConfigured')
        } else {
          const detail = `HTTP ${response.status}${errorText ? `: ${errorText.slice(0, 120)}` : ''}`
          options.onUnavailable?.(detail)
          friendlyMsg = translate(errLang, 'ai.errUpstream', { detail })
        }
        throw new Error(friendlyMsg)
      }
      return response
    }

    try {
      const lang = sendOptions?.lang ?? currentLang()
      const requestPromptLang = normalizePromptLang(lang)

      if (runtimeAdapter === 'openai-compatible' && !useByok && !isDebugMockRequested(options.fallbackToMock)) {
        throw new Error(translate(lang, 'ai.byokRequiredNotice'))
      }

      if (isDebugMockRequested(options.fallbackToMock) && !useByok) {
        await streamFromMock(visibleUserContent, mergedInputs, reactiveAssistantMsg, signal)
        return {
          ok: true,
          isError: false,
          isMock: true,
          conversationId: conversationId.value,
          userMessage: userMsg,
          assistantMessage: reactiveAssistantMsg,
        }
      }

      if (useByok) {
        const catalog = await fetchReaderTools(fetchImpl, toolsEndpoint, signal)
        if (signal.aborted && !timedOut) return handleCancelled()

        const openAiTools = catalog.tools.length > 0 ? toOpenAiTools(catalog.tools) : []
        const maxModelCalls = openAiTools.length > 0 ? catalog.maxSteps : 1
        const loopMessages: OpenAiChatLoopMessage[] = buildOpenAiInitialMessages(
          trimmedQuery,
          mergedInputs,
          priorHistory,
          { actionId, lang: requestPromptLang },
        )

        for (let step = 1; step <= maxModelCalls; step++) {
          const req = buildOpenAiChatRequest(byok, trimmedQuery, mergedInputs, priorHistory, {
            actionId,
            lang: requestPromptLang,
            messagesOverride: loopMessages,
            ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
          })
          armTimeout()
          const response = await executeFetch(req.url, { ...req.init, signal })

          const stepState: SseStepState = {
            stepText: '',
            finishReason: '',
            toolAcc: createOpenAiToolCallAccumulator(),
            deferFinalizeOnDone: true,
            prependParagraphBreak: step > 1 && reactiveAssistantMsg.content.trim().length > 0,
          }
          const streamResult = await readSSEStream(
            response,
            reactiveAssistantMsg,
            mergedInputs,
            signal,
            armTimeout,
            stepState,
          )
          clearTimer()

          if (signal.aborted && !timedOut) return handleCancelled()
          if (!streamResult.completedCleanly) {
            return handleIncomplete(translate(lang, 'ai.incompleteBanner'))
          }

          const toolCalls = stepState.toolAcc.finalize()
          const wantsToolLoop =
            openAiTools.length > 0 &&
            toolCalls.length > 0 &&
            (stepState.finishReason === 'tool_calls' || !stepState.finishReason || stepState.stepText === '')

          if (wantsToolLoop && step < maxModelCalls) {
            loopMessages.push({
              role: 'assistant',
              content: stepState.stepText || null,
              tool_calls: toolCalls,
            })
            for (const tc of toolCalls) {
              if (signal.aborted && !timedOut) return handleCancelled()
              if (!reactiveAssistantMsg.toolCalls) reactiveAssistantMsg.toolCalls = []
              const entry: ChatToolCall = {
                id: tc.id || generateId('tc'),
                name: tc.function.name,
                state: 'running',
              }
              reactiveAssistantMsg.toolCalls.push(entry)
              const reactiveEntry =
                reactiveAssistantMsg.toolCalls[reactiveAssistantMsg.toolCalls.length - 1] ?? entry
              options.onMessage?.(reactiveAssistantMsg)

              const toolRes = await executeReaderToolCall(
                tc.function.name,
                tc.function.arguments,
                fetchImpl,
                toolsEndpoint,
                signal,
              )
              if (signal.aborted && !timedOut) return handleCancelled()
              reactiveEntry.state = toolRes.ok ? 'done' : 'error'
              options.onMessage?.(reactiveAssistantMsg)
              loopMessages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: toolRes.content,
              })
            }
            continue
          }

          reactiveAssistantMsg.isStreaming = false
          isStreaming.value = false
          setByokVerifyState('ok', '')
          options.onFinish?.(reactiveAssistantMsg, usage.value)
          return {
            ok: true,
            isError: false,
            isIncomplete: false,
            isMock: false,
            conversationId: conversationId.value,
            userMessage: userMsg,
            assistantMessage: reactiveAssistantMsg,
          }
        }
      }

      const requestPayload = {
        inputs: mergedInputs,
        query: trimmedQuery,
        ...(actionId ? { action: actionId } : {}),
        lang: requestPromptLang,
        response_mode: 'streaming',
        conversation_id: conversationId.value || '',
      }
      const response = await executeFetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(requestPayload),
        signal,
      })

      const streamResult = await readSSEStream(response, reactiveAssistantMsg, mergedInputs, signal)
      clearTimer()

      if (signal.aborted && !timedOut) return handleCancelled()
      if (!streamResult.completedCleanly || reactiveAssistantMsg.isStreaming) {
        return handleIncomplete(translate(lang, 'ai.incompleteBanner'))
      }

      options.onProxyOk?.()
      return {
        ok: true,
        isError: false,
        isIncomplete: false,
        isMock: Boolean(reactiveAssistantMsg.isMock),
        conversationId: conversationId.value,
        userMessage: userMsg,
        assistantMessage: reactiveAssistantMsg,
      }
    } catch (err: unknown) {
      clearTimer()
      if ((err as { __lecAborted?: boolean } | null)?.__lecAborted || (signal.aborted && !timedOut)) {
        return handleCancelled()
      }

      const detail = err instanceof Error ? err.message : String(err || translate(currentLang(), 'ai.networkError'))
      error.value = detail
      if (reactiveAssistantMsg.content.trim().length > 0) {
        reactiveAssistantMsg.isIncomplete = true
      }
      reactiveAssistantMsg.isError = true
      reactiveAssistantMsg.error = detail
      reactiveAssistantMsg.errorDetail = detail
      reactiveAssistantMsg.isStreaming = false
      isStreaming.value = false
      if (useByok) setByokVerifyState('failed', detail)
      else if (!proxyStatusHandled) options.onUnavailable?.(detail) // SSE `error` frame after the stream started
      options.onError?.(detail)
      return {
        ok: false,
        isError: true,
        isIncomplete: Boolean(reactiveAssistantMsg.isIncomplete),
        isMock: false,
        conversationId: conversationId.value,
        userMessage: userMsg,
        assistantMessage: reactiveAssistantMsg,
      }
    } finally {
      clearTimer()
      if (abortController?.signal === signal) {
        abortController = null
      }
    }
  }

  const retryLastMessage = async (): Promise<SendMessageOutcome | null> => {
    if ((!lastUserQuery && !lastSendOptions?.actionId) || isStreaming.value) {
      return null
    }
    const lastMsg = messages.value[messages.value.length - 1]
    if (lastMsg && lastMsg.role === 'assistant') {
      messages.value.pop()
    }
    const prevUserMsg = messages.value[messages.value.length - 1]
    if (prevUserMsg && prevUserMsg.role === 'user') {
      messages.value.pop()
    }
    return sendMessage(lastUserQuery, lastInputs, lastSendOptions)
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
    retryLastMessage,
  }
}
