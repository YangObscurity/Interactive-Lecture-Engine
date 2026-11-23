import { randomUUID } from 'node:crypto'
import { createOpenAI } from '@ai-sdk/openai'
import {
  isStepCount,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from 'ai'
import type { Context } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { HttpError, badRequest, payloadTooLarge, rateLimited } from '../../http/errors.js'
import { trimTrailingSlashes } from '../../http/url.js'
import { mintToolTicket } from '../../tools/ticket.js'
import { type AiCallRecord, type AiRuntime, getRequestUserId, hashUserId, writeAiAccessLog } from './runtime.js'
import { dataFrame, DifyFrameScanner, errorFrame, FrameBoundary, type SseErrorCode } from './sse.js'
import { proxyStream, type StreamAdapter } from './stream.js'
import {
  PromptAssemblyError,
  assembleDifyChatPayload,
  assembleOpenAiMessages,
  normalizePromptLang,
  PROMPT_LANGUAGES,
  type PromptLang,
} from '../../prompts/companion.js'

/** The only `inputs` keys the front end sends (see `useDifyChat.ts`). Anything else is dropped. */
export const ALLOWED_INPUT_KEYS = ['current_lecture', 'group', 'outline', 'selection'] as const
const MAX_FILES = 5
const MAX_CONVERSATION_ID_LENGTH = 128
const MAX_ACTION_ID_LENGTH = 64
/** The reader's selected passage is capped well below the total `inputs` budget. */
export const MAX_SELECTION_BYTES = 16384
const FILE_TYPES = new Set(['document', 'image', 'audio', 'video', 'custom'])

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
}

type AllowedInputs = Partial<Record<(typeof ALLOWED_INPUT_KEYS)[number], string>>

interface DifyFileRef {
  type: string
  transfer_method: 'local_file'
  upload_file_id: string
}

export interface ChatRequest {
  query: string
  actionId: string | null
  lang: PromptLang
  inputs: AllowedInputs
  files: DifyFileRef[]
  conversationId: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate and normalise the client body. Only whitelisted fields survive:
 *  - `query`: non-empty string, at most `aiQueryMaxBytes` UTF-8 bytes (else 413);
 *  - `inputs`: only `current_lecture|group|outline|selection`, each a string, total at most
 *    `aiInputsMaxBytes` (else 413); unknown keys (including any client `tool_ticket`) are dropped;
 *  - `files`: only `{ type, transfer_method: 'local_file', upload_file_id }` where the id was
 *    returned to this same user by `/api/ai/upload` (no `remote_url`);
 *  - `conversation_id`: kept only when this server issued/saw it for this user, else a new
 *    conversation is started (the stream carries the new id).
 */
export function parseChatRequest(
  body: unknown,
  config: AppConfig,
  rt: AiRuntime,
  userId: string,
): ChatRequest {
  if (!isPlainObject(body)) throw badRequest('invalid_request')

  const rawAction = body['action']
  let actionId: string | null = null
  if (rawAction !== undefined && rawAction !== null) {
    if (typeof rawAction !== 'string') throw badRequest('invalid_request', { message: 'action_must_be_string' })
    const trimmedAction = rawAction.trim()
    if (trimmedAction !== '') {
      if (trimmedAction.length > MAX_ACTION_ID_LENGTH) {
        throw badRequest('invalid_request', { message: 'unknown_action' })
      }
      actionId = trimmedAction
    }
  }

  const rawLang = body['lang']
  let lang: PromptLang = 'zh'
  if (rawLang !== undefined && rawLang !== null) {
    if (typeof rawLang !== 'string' || !(PROMPT_LANGUAGES as readonly string[]).includes(rawLang)) {
      throw badRequest('invalid_request', { message: 'invalid_lang' })
    }
    lang = normalizePromptLang(rawLang)
  }

  const rawQuery = body['query']
  let query = ''
  if (rawQuery !== undefined && rawQuery !== null) {
    if (typeof rawQuery !== 'string') throw badRequest('invalid_request')
    query = rawQuery.trim()
  }
  if (!actionId && query === '') {
    throw badRequest('invalid_request')
  }
  if (Buffer.byteLength(query, 'utf8') > config.aiQueryMaxBytes) {
    throw payloadTooLarge('query_too_long')
  }

  const inputs: AllowedInputs = {}
  const rawInputs = body['inputs']
  if (rawInputs !== undefined && rawInputs !== null) {
    if (!isPlainObject(rawInputs)) throw badRequest('invalid_request', { message: 'inputs_must_be_object' })
    let total = 0
    for (const key of ALLOWED_INPUT_KEYS) {
      const value = rawInputs[key]
      if (value === undefined) continue
      if (typeof value !== 'string') throw badRequest('invalid_request', { message: `inputs_${key}_must_be_string` })
      const bytes = Buffer.byteLength(value, 'utf8')
      if (key === 'selection' && bytes > MAX_SELECTION_BYTES) throw payloadTooLarge('selection_too_long')
      total += bytes
      inputs[key] = value
    }
    if (total > config.aiInputsMaxBytes) throw payloadTooLarge('inputs_too_long')
  }

  const files: DifyFileRef[] = []
  const rawFiles = body['files']
  if (rawFiles !== undefined && rawFiles !== null) {
    if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) {
      throw badRequest('invalid_request', { message: 'files_invalid' })
    }
    for (const f of rawFiles as unknown[]) {
      if (
        !isPlainObject(f) ||
        typeof f['type'] !== 'string' ||
        !FILE_TYPES.has(f['type']) ||
        f['transfer_method'] !== 'local_file' ||
        typeof f['upload_file_id'] !== 'string' ||
        f['upload_file_id'] === ''
      ) {
        throw badRequest('invalid_request', { message: 'files_invalid' })
      }
      if (!rt.files.has(userId, f['upload_file_id'])) {
        throw badRequest('invalid_request', { message: 'unknown_file' })
      }
      files.push({ type: f['type'], transfer_method: 'local_file', upload_file_id: f['upload_file_id'] })
    }
  }

  let conversationId = ''
  const rawConv = body['conversation_id']
  if (typeof rawConv === 'string') {
    const cid = rawConv.trim()
    if (cid !== '' && cid.length <= MAX_CONVERSATION_ID_LENGTH && rt.conversations.has(userId, cid)) {
      conversationId = cid
    }
  }

  return { query, actionId, lang, inputs, files, conversationId }
}

function createDifyAdapter(onConversationId: (id: string) => void): StreamAdapter {
  const scanner = new DifyFrameScanner()
  let reported = false
  return {
    transform(chunk) {
      scanner.feed(chunk)
      if (!reported && scanner.conversationId !== null) {
        reported = true
        onConversationId(scanner.conversationId)
      }
      return [chunk]
    },
    flush: () => [],
    sawUpstreamError: () => scanner.sawErrorEvent,
    terminal: () => false,
  }
}

function fallbackRecord(rt: AiRuntime): AiCallRecord {
  return {
    route: 'chat',
    startedAt: rt.now(),
    bytesIn: 0,
    bytesOut: 0,
    status: 0,
    outcome: 'unknown',
    limit: null,
    deferred: true,
    logged: false,
  }
}

type NativeAbortCause = 'first_byte_timeout' | 'stream_timeout' | 'client_abort' | null

function createObservedFetch(onFirstByte: () => void): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init)
    if (!res.ok || !res.body) {
      return res
    }

    let seenFirstChunk = false
    const isSse = (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let lineBuffer = ''

    const normalizeSseLine = (line: string): string => {
      if (!line.startsWith('data:')) return line
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]' || payload[0] !== '{') return line
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        if (Array.isArray(parsed['choices'])) {
          let changed = false
          const fixedChoices = parsed['choices'].map((item, idx) => {
            if (isPlainObject(item) && typeof item['index'] !== 'number') {
              changed = true
              return { index: idx, ...item }
            }
            return item
          })
          if (changed) {
            return `data: ${JSON.stringify({ ...parsed, choices: fixedChoices })}`
          }
        }
      } catch {
        // leave malformed JSON untouched so downstream error handling behaves naturally
      }
      return line
    }

    const observedBody = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          if (!seenFirstChunk && chunk.byteLength > 0) {
            seenFirstChunk = true
            onFirstByte()
          }
          if (!isSse) {
            controller.enqueue(chunk)
            return
          }
          lineBuffer += decoder.decode(chunk, { stream: true })
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() ?? ''
          if (lines.length > 0) {
            const out = lines.map(normalizeSseLine).join('\n') + '\n'
            controller.enqueue(encoder.encode(out))
          }
        },
        flush(controller) {
          if (!isSse) return
          const tail = lineBuffer + decoder.decode()
          if (tail.length > 0) {
            controller.enqueue(encoder.encode(normalizeSseLine(tail)))
          }
        },
      }),
    )

    return new Response(observedBody, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}

async function runNativeOpenAiStream(params: {
  config: AppConfig
  rt: AiRuntime
  userId: string
  record: AiCallRecord
  clientSignal: AbortSignal
  instructions: string
  messages: ModelMessage[]
  tools: ToolSet
  conversationId: string
  messageId: string
  release: () => void
}): Promise<Response> {
  const { config, rt, userId, record, clientSignal, instructions, messages, tools, conversationId, messageId, release } = params
  record.deferred = true

  const ctrl = new AbortController()
  let cause: NativeAbortCause = null
  let finished = false
  let upstreamOpened = false
  let streamStarted = false

  const abort = (why: Exclude<NativeAbortCause, null>): void => {
    if (cause === null) cause = why
    ctrl.abort()
  }

  const onClientAbort = (): void => abort('client_abort')
  if (clientSignal.aborted) abort('client_abort')
  else clientSignal.addEventListener('abort', onClientAbort, { once: true })

  const firstTimer = setTimeout(() => abort('first_byte_timeout'), config.aiUpstreamTimeoutMs)
  const capTimer = setTimeout(() => abort('stream_timeout'), config.aiStreamMaxMs)

  const finish = (outcome: string, ok: boolean | null, status: number): void => {
    if (finished) return
    finished = true
    clearTimeout(firstTimer)
    clearTimeout(capTimer)
    clientSignal.removeEventListener('abort', onClientAbort)
    release()
    if (ok !== null) rt.recorder.record(ok, ok ? undefined : status)
    record.outcome = outcome
    record.status = status
    writeAiAccessLog(config, rt, userId, record)
  }

  const codeFor = (): SseErrorCode =>
    cause === 'stream_timeout'
      ? 'stream_timeout'
      : cause === 'first_byte_timeout'
        ? 'upstream_timeout'
        : 'upstream_error'

  const model: LanguageModel = rt.modelFactory
    ? rt.modelFactory(config)
    : createOpenAI({
        baseURL: trimTrailingSlashes(config.openaiApiBase),
        apiKey: config.openaiApiKey ?? '',
        fetch: createObservedFetch(() => {
          upstreamOpened = true
          clearTimeout(firstTimer)
        }),
      }).chat(config.openaiModel)

  const toolExecutionMsById = new Map<string, number>()
  const toolStartById = new Map<string, number>()

  const result = streamText({
    model,
    instructions,
    messages,
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
    stopWhen: isStepCount(config.aiToolMaxSteps),
    maxRetries: 0,
    abortSignal: ctrl.signal,
    timeout: {
      totalMs: config.aiStreamMaxMs,
      firstChunkMs: config.aiUpstreamTimeoutMs,
      toolMs: config.aiToolTimeoutMs,
    },
    onToolExecutionEnd: (event) => {
      toolExecutionMsById.set(event.toolCall.toolCallId, Math.max(0, Math.round(event.toolExecutionMs)))
    },
    onError: () => {
      // Errors are delivered cleanly on fullStream and converted to 502 or SSE error frames.
    },
  })

  const iter = result.fullStream[Symbol.asyncIterator]()
  let bufferedFirst: IteratorResult<TextStreamPart<ToolSet>> | null = null

  while (true) {
    let next: IteratorResult<TextStreamPart<ToolSet>>
    try {
      next = await iter.next()
    } catch {
      if (cause === 'client_abort') {
        finish('client_abort', null, 499)
        return new Response(null, { status: 499 })
      }
      if (!upstreamOpened) {
        finish(cause === 'first_byte_timeout' ? 'upstream_timeout' : 'upstream_error', false, 502)
        throw new HttpError(502, 'ai_upstream_error')
      }
      bufferedFirst = { done: false, value: { type: 'error', error: new Error('upstream_error') } }
      break
    }

    if (next.done) {
      bufferedFirst = next
      break
    }

    const part = next.value
    if (part.type === 'start' || part.type === 'start-step') {
      continue
    }

    if (part.type === 'error') {
      if (cause === 'client_abort') {
        finish('client_abort', null, 499)
        return new Response(null, { status: 499 })
      }
      if (!upstreamOpened) {
        finish(cause === 'first_byte_timeout' ? 'upstream_timeout' : 'upstream_error', false, 502)
        throw new HttpError(502, 'ai_upstream_error')
      }
    }

    bufferedFirst = next
    break
  }

  clearTimeout(firstTimer)
  streamStarted = true

  const boundary = new FrameBoundary()
  const decoder = new TextDecoder()
  let emittedError = false
  let emittedFinish = false

  const emitFrames = (ctl: ReadableStreamDefaultController<Uint8Array>, frames: Uint8Array[]): void => {
    for (const f of frames) {
      ctl.enqueue(f)
      record.bytesOut += f.byteLength
      boundary.feed(decoder.decode(f, { stream: true }))
    }
  }

  const handlePart = (ctl: ReadableStreamDefaultController<Uint8Array>, part: TextStreamPart<ToolSet>): boolean => {
    switch (part.type) {
      case 'text-delta': {
        if (part.text.length > 0) {
          emitFrames(ctl, [
            dataFrame({
              event: 'agent_message',
              conversation_id: conversationId,
              message_id: messageId,
              answer: part.text,
            }),
          ])
        }
        return true
      }
      case 'tool-call': {
        toolStartById.set(part.toolCallId, rt.now())
        emitFrames(ctl, [
          dataFrame({
            event: 'tool_call',
            name: part.toolName,
            state: 'start',
          }),
        ])
        return true
      }
      case 'tool-result':
      case 'tool-error': {
        const startedAt = toolStartById.get(part.toolCallId) ?? rt.now()
        const measured = toolExecutionMsById.get(part.toolCallId) ?? Math.max(0, Math.round(rt.now() - startedAt))
        emitFrames(ctl, [
          dataFrame({
            event: 'tool_call',
            name: part.toolName,
            state: 'end',
            ok: part.type === 'tool-result',
            ms: measured,
          }),
        ])
        return true
      }
      case 'finish': {
        if (emittedError || emittedFinish) return false
        emittedFinish = true
        const promptTokens = part.totalUsage.inputTokens ?? 0
        const completionTokens = part.totalUsage.outputTokens ?? 0
        const totalTokens = part.totalUsage.totalTokens ?? promptTokens + completionTokens
        emitFrames(ctl, [
          dataFrame({
            event: 'message_end',
            conversation_id: conversationId,
            message_id: messageId,
            metadata: {
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: totalTokens,
              },
            },
          }),
        ])
        return false
      }
      case 'error': {
        if (!emittedError && cause !== 'client_abort') {
          emittedError = true
          const code = codeFor()
          const frame = errorFrame(code, boundary.atBoundary)
          ctl.enqueue(frame)
          record.bytesOut += frame.byteLength
        }
        return false
      }
      case 'abort': {
        return false
      }
      default:
        return true
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async start(ctl) {
      try {
        if (bufferedFirst && !bufferedFirst.done) {
          const keepGoing = handlePart(ctl, bufferedFirst.value)
          if (!keepGoing) {
            if (emittedError) {
              ctl.close()
              finish(codeFor(), false, 200)
              return
            }
            if (emittedFinish) {
              ctl.close()
              finish('ok', true, 200)
              return
            }
          }
        }

        if (!bufferedFirst?.done) {
          while (!finished) {
            const next = await iter.next()
            if (next.done) break
            const keepGoing = handlePart(ctl, next.value)
            if (!keepGoing) break
          }
        }

        if (cause === 'client_abort') {
          try {
            ctl.close()
          } catch {
            // already closed
          }
          finish('client_abort', null, 499)
          return
        }

        if (emittedError || cause === 'stream_timeout') {
          if (!emittedError) {
            emittedError = true
            const frame = errorFrame(codeFor(), boundary.atBoundary)
            ctl.enqueue(frame)
            record.bytesOut += frame.byteLength
          }
          try {
            ctl.close()
          } catch {
            // already closed
          }
          finish(codeFor(), false, 200)
          return
        }

        if (!emittedFinish) {
          emittedFinish = true
          emitFrames(ctl, [
            dataFrame({
              event: 'message_end',
              conversation_id: conversationId,
              message_id: messageId,
              metadata: {
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                },
              },
            }),
          ])
        }

        try {
          ctl.close()
        } catch {
          // already closed
        }
        finish('ok', true, 200)
      } catch {
        if (cause === 'client_abort') {
          try {
            ctl.close()
          } catch {
            // already closed
          }
          finish('client_abort', null, 499)
          return
        }
        if (!emittedError) {
          emittedError = true
          const frame = errorFrame(codeFor(), boundary.atBoundary)
          try {
            ctl.enqueue(frame)
            record.bytesOut += frame.byteLength
          } catch {
            // already closed
          }
        }
        try {
          ctl.close()
        } catch {
          // already closed
        }
        finish(codeFor(), false, 200)
      }
    },
    cancel() {
      abort('client_abort')
      if (streamStarted && !finished) {
        void iter.return?.(undefined)
        finish('client_abort', null, 499)
      }
    },
  })

  return new Response(body, { status: 200, headers: STREAM_HEADERS })
}

export function createChatHandler(config: AppConfig, rt: AiRuntime) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Date', new Date().toUTCString())

    if (config.aiProvider === 'off') {
      return c.json({ error: 'ai_not_configured' }, 503)
    }

    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const req = parseChatRequest(rawBody, config, rt, userId)
    const prompts = rt.prompts.require()

    const record = c.get('aiCall') ?? fallbackRecord(rt)
    record.promptVersion = prompts.version

    if (config.aiProvider === 'dify') {
      let assembled
      try {
        assembled = assembleDifyChatPayload({
          prompts,
          lang: req.lang,
          query: req.query,
          actionId: req.actionId ?? undefined,
          inputs: req.inputs,
        })
      } catch (err) {
        if (err instanceof PromptAssemblyError) {
          if (err.code === 'unknown_action') throw badRequest('invalid_request', { message: 'unknown_action' })
          if (err.code === 'selection_required') throw badRequest('invalid_request', { message: 'selection_required' })
          throw badRequest('invalid_request')
        }
        throw err
      }

      const difyInputs: Record<string, string> = { ...assembled.inputs }
      if (config.aiMcpTicketSecret && config.aiMcpTicketSecret.trim() !== '') {
        const readableTiers = rt.toolEngine.resolveTiersForCaller(c.get('session'))
        difyInputs['tool_ticket'] = mintToolTicket(
          config.aiMcpTicketSecret,
          { tiers: readableTiers, uh: hashUserId(userId) },
          rt.now,
        )
      }

      const release = rt.chatGate.acquire(userId)
      if (!release) {
        record.limit = 'concurrency'
        throw rateLimited('concurrency', 5)
      }

      const payload = {
        inputs: difyInputs,
        query: assembled.query,
        response_mode: 'streaming',
        conversation_id: req.conversationId,
        user: userId,
        ...(req.files.length > 0 ? { files: req.files } : {}),
      }
      return proxyStream({
        config,
        rt,
        userId,
        record,
        clientSignal: c.req.raw.signal,
        url: `${trimTrailingSlashes(config.difyApiBase)}/chat-messages`,
        headers: {
          Authorization: `Bearer ${config.difyApiKey ?? ''}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(payload),
        adapter: createDifyAdapter((id) => rt.conversations.add(userId, id)),
        release,
      })
    }

    // Native AI SDK v7 channel (`AI_PROVIDER=openai`)
    let assembledOpenAi
    try {
      assembledOpenAi = assembleOpenAiMessages({
        prompts,
        lang: req.lang,
        query: req.query,
        actionId: req.actionId ?? undefined,
        inputs: req.inputs,
      })
    } catch (err) {
      if (err instanceof PromptAssemblyError) {
        if (err.code === 'unknown_action') throw badRequest('invalid_request', { message: 'unknown_action' })
        if (err.code === 'selection_required') throw badRequest('invalid_request', { message: 'selection_required' })
        throw badRequest('invalid_request')
      }
      throw err
    }

    const aiToolsCfg = await rt.mcpManager.loadConfig()
    const readableTiers = rt.toolEngine.resolveTiersForCaller(c.get('session'))
    const engineTools = rt.toolEngine.toAiSdkTools(
      { readableTiers, channel: 'native', userId },
      aiToolsCfg.engineTools,
    )
    const externalTools = await rt.mcpManager.getEnabledSdkTools(
      userId,
      'native',
      new Set(Object.keys(engineTools)),
    )
    const combinedTools: ToolSet = { ...engineTools, ...externalTools }

    const release = rt.chatGate.acquire(userId)
    if (!release) {
      record.limit = 'concurrency'
      throw rateLimited('concurrency', 5)
    }

    const conversationId = req.conversationId !== '' ? req.conversationId : `conv_${randomUUID()}`
    rt.conversations.add(userId, conversationId)
    const messageId = `msg_${randomUUID()}`

    const [systemMsg, ...userMsgs] = assembledOpenAi.messages
    const instructions = systemMsg?.content ?? ''
    const modelMessages: ModelMessage[] = userMsgs.map((m) => ({
      role: m.role === 'system' ? 'user' : m.role,
      content: m.content,
    }))

    return runNativeOpenAiStream({
      config,
      rt,
      userId,
      record,
      clientSignal: c.req.raw.signal,
      instructions,
      messages: modelMessages,
      tools: combinedTools,
      conversationId,
      messageId,
      release,
    })
  }
}
