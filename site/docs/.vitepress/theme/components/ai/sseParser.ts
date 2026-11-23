/**
 * sseParser.ts — Streaming Server-Sent Events parser for both Dify proxy and OpenAI-compatible streams.
 * Pure, chunk-boundary safe (handles CRLF/LF and arbitrary splits), SSR safe.
 */

export interface SseUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

export type ParsedSseEvent =
  | {
      type: 'thought'
      thought: string
      tool?: string
      toolInput?: string
      observation?: string
      conversationId?: string
      messageId?: string
    }
  | {
      type: 'tool_call'
      name: string
      state: 'start' | 'end'
      ok?: boolean
      ms?: number
    }
  | {
      type: 'tool_call_delta'
      index: number
      id?: string
      callType?: string
      name?: string
      argumentsChunk?: string
    }
  | {
      type: 'finish_reason'
      reason: string
    }
  | {
      type: 'delta'
      text: string
      conversationId?: string
      messageId?: string
    }
  | {
      type: 'done'
      conversationId?: string
      messageId?: string
      usage?: SseUsage
    }
  | {
      type: 'error'
      message: string
      code?: string
      status?: number
    }

interface RawSseToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

interface RawSsePayload {
  event?: string
  name?: string
  state?: string
  ok?: boolean
  ms?: number
  conversation_id?: string
  message_id?: string
  answer?: string
  thought?: string
  tool?: string
  tool_input?: string
  observation?: string
  message?: string
  code?: string
  status?: number
  metadata?: {
    usage?: SseUsage
  }
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      tool_calls?: RawSseToolCallDelta[]
    }
    finish_reason?: string | null
  }>
  usage?: SseUsage
  error?:
    | string
    | {
        message?: string
        code?: string
        status?: number
      }
}

export interface SseParser {
  feed(chunk: string): ParsedSseEvent[]
  flush(): ParsedSseEvent[]
  sawDone(): boolean
  sawError(): boolean
}

export function createSseParser(): SseParser {
  let lineBuffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let openAiUsage: SseUsage | undefined
  let doneEmitted = false
  let errorSeen = false

  function resetFrame(): void {
    eventName = ''
    dataLines = []
  }

  function dispatchFrame(): ParsedSseEvent[] {
    if (dataLines.length === 0 && !eventName) {
      return []
    }

    const payloadRaw = dataLines.join('\n').trim()
    const currentEvent = eventName.trim()
    resetFrame()

    if (!payloadRaw) {
      if (currentEvent === 'ping') return []
      return []
    }

    if (payloadRaw === '[DONE]') {
      doneEmitted = true
      return [{ type: 'done', usage: openAiUsage }]
    }

    let parsed: RawSsePayload
    try {
      parsed = JSON.parse(payloadRaw) as RawSsePayload
    } catch {
      return []
    }

    if (!parsed || typeof parsed !== 'object') {
      return []
    }

    const ev = (parsed.event || currentEvent || '').trim()

    if (parsed.usage && typeof parsed.usage === 'object') {
      openAiUsage = parsed.usage
    }

    // Upstream error (Dify event: error or OpenAI {"error": ...})
    if (ev === 'error' || parsed.error) {
      errorSeen = true
      const errObj = typeof parsed.error === 'object' && parsed.error !== null ? parsed.error : null
      const msg =
        (errObj?.message) ||
        (typeof parsed.error === 'string' ? parsed.error : undefined) ||
        parsed.message ||
        'SSE stream error'
      return [{
        type: 'error',
        message: msg,
        code: errObj?.code || parsed.code,
        status: errObj?.status || parsed.status,
      }]
    }

    // Native tool_call progress event emitted by lecture-api (WP-K2)
    if (ev === 'tool_call' && typeof parsed.name === 'string' && parsed.name.trim()) {
      return [{
        type: 'tool_call',
        name: parsed.name.trim(),
        state: parsed.state === 'end' ? 'end' : 'start',
        ...(typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {}),
        ...(typeof parsed.ms === 'number' ? { ms: parsed.ms } : {}),
      }]
    }

    // Dify thought frame
    if (ev === 'agent_thought' || typeof parsed.thought === 'string') {
      return [{
        type: 'thought',
        thought: parsed.thought || '',
        tool: parsed.tool,
        toolInput: parsed.tool_input,
        observation: parsed.observation,
        conversationId: parsed.conversation_id,
        messageId: parsed.message_id,
      }]
    }

    // Dify message / agent_message frame
    if (typeof parsed.answer === 'string') {
      const out: ParsedSseEvent[] = [{
        type: 'delta',
        text: parsed.answer,
        conversationId: parsed.conversation_id,
        messageId: parsed.message_id,
      }]
      if (ev === 'message_end') {
        doneEmitted = true
        out.push({
          type: 'done',
          conversationId: parsed.conversation_id,
          messageId: parsed.message_id,
          usage: parsed.metadata?.usage ?? openAiUsage,
        })
      }
      return out
    }

    if (ev === 'message_end') {
      doneEmitted = true
      return [{
        type: 'done',
        conversationId: parsed.conversation_id,
        messageId: parsed.message_id,
        usage: parsed.metadata?.usage ?? openAiUsage,
      }]
    }

    // OpenAI Chat Completions SSE delta frame
    if (Array.isArray(parsed.choices)) {
      const events: ParsedSseEvent[] = []
      const choice = parsed.choices[0]
      const reasoning = choice?.delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        events.push({ type: 'thought', thought: reasoning })
      }
      const deltaText = choice?.delta?.content
      if (typeof deltaText === 'string' && deltaText.length > 0) {
        events.push({ type: 'delta', text: deltaText })
      }
      if (Array.isArray(choice?.delta?.tool_calls)) {
        for (const tc of choice.delta.tool_calls) {
          events.push({
            type: 'tool_call_delta',
            index: typeof tc.index === 'number' ? tc.index : 0,
            ...(typeof tc.id === 'string' && tc.id ? { id: tc.id } : {}),
            ...(typeof tc.type === 'string' && tc.type ? { callType: tc.type } : {}),
            ...(typeof tc.function?.name === 'string' && tc.function.name ? { name: tc.function.name } : {}),
            ...(typeof tc.function?.arguments === 'string' ? { argumentsChunk: tc.function.arguments } : {}),
          })
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
        events.push({ type: 'finish_reason', reason: choice.finish_reason })
      }
      return events
    }

    return []
  }

  function processCompleteLine(line: string, out: ParsedSseEvent[]): void {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line
    if (clean === '') {
      out.push(...dispatchFrame())
      return
    }
    if (clean.startsWith(':')) {
      return
    }
    if (clean.startsWith('event:')) {
      eventName = clean.slice(6).trim()
      return
    }
    if (clean.startsWith('data:')) {
      const val = clean.slice(5)
      dataLines.push(val.startsWith(' ') ? val.slice(1) : val)
    }
  }

  return {
    feed(chunk: string): ParsedSseEvent[] {
      const normalized = chunk.replace(/\r\n/g, '\n')
      lineBuffer += normalized
      const out: ParsedSseEvent[] = []
      let idx = lineBuffer.indexOf('\n')
      while (idx !== -1) {
        const line = lineBuffer.slice(0, idx)
        lineBuffer = lineBuffer.slice(idx + 1)
        processCompleteLine(line, out)
        idx = lineBuffer.indexOf('\n')
      }
      return out
    },
    flush(): ParsedSseEvent[] {
      const out: ParsedSseEvent[] = []
      if (lineBuffer.length > 0) {
        processCompleteLine(lineBuffer, out)
        lineBuffer = ''
      }
      out.push(...dispatchFrame())
      // Do NOT synthesize 'done' purely from openAiUsage without explicit [DONE] or message_end:
      // an upstream connection cut after sending usage must still be treated as incomplete (D-07).
      return out
    },
    sawDone(): boolean {
      return doneEmitted
    },
    sawError(): boolean {
      return errorSeen
    },
  }
}
