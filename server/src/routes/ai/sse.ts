const encoder = new TextEncoder()

export type SseErrorCode = 'upstream_timeout' | 'stream_timeout' | 'upstream_error'

const ERROR_MESSAGES: Record<SseErrorCode, string> = {
  upstream_timeout: 'The AI service did not answer in time.',
  stream_timeout: 'The answer took too long and was cut off.',
  upstream_error: 'The AI service stopped unexpectedly.',
}

/**
 * The single terminal error frame written when the upstream fails after the stream has started:
 *
 *   event: error
 *   data: {"event":"error","code":"upstream_error","message":"..."}
 *
 * A leading blank line is added when the last forwarded bytes did not end on a frame boundary,
 * so a half-written frame cannot swallow the error frame.
 */
export function errorFrame(code: SseErrorCode, lastBytesEndedFrame: boolean): Uint8Array {
  const body = `event: error\ndata: ${JSON.stringify({ event: 'error', code, message: ERROR_MESSAGES[code] })}\n\n`
  return encoder.encode(lastBytesEndedFrame ? body : `\n\n${body}`)
}

export function dataFrame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
}

/** Tracks whether a byte stream currently ends on an SSE frame boundary (blank line). */
export class FrameBoundary {
  private tail = ''
  /** True before anything was written. */
  get atBoundary(): boolean {
    return this.tail === '' || /\n\r?\n$/.test(this.tail)
  }
  feed(text: string): void {
    this.tail = (this.tail + text).slice(-4)
  }
}

/**
 * Line scanner over a Dify SSE byte stream: extracts the first conversation id and flags
 * upstream `error` events, without altering the bytes that are forwarded.
 */
export class DifyFrameScanner {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  conversationId: string | null = null
  sawErrorEvent = false

  feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    if (this.buffer.length > 65536) this.buffer = ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload[0] !== '{') continue
      try {
        const parsed = JSON.parse(payload) as { event?: unknown; conversation_id?: unknown }
        if (this.conversationId === null && typeof parsed.conversation_id === 'string' && parsed.conversation_id !== '') {
          this.conversationId = parsed.conversation_id.slice(0, 128)
        }
        if (parsed.event === 'error') this.sawErrorEvent = true
      } catch {
        // partial or non-JSON frame: ignore
      }
    }
  }
}
