import type { AppConfig } from '../../config/schema.js'
import { HttpError } from '../../http/errors.js'
import { type AiCallRecord, type AiRuntime, writeAiAccessLog } from './runtime.js'
import { errorFrame, FrameBoundary, type SseErrorCode } from './sse.js'

/** Converts upstream bytes into the frames forwarded to the browser. */
export interface StreamAdapter {
  transform(chunk: Uint8Array): Uint8Array[]
  /** Frames to append when the upstream ended normally. */
  flush(): Uint8Array[]
  /** The upstream reported an error event or object inside an otherwise healthy stream. */
  sawUpstreamError(): boolean
  /** Stop reading and close with an error frame (the adapter already saw a fatal upstream error). */
  terminal(): boolean
}

export interface ProxyStreamArgs {
  config: AppConfig
  rt: AiRuntime
  userId: string
  record: AiCallRecord
  clientSignal: AbortSignal
  url: string
  headers: Record<string, string>
  body: string
  adapter: StreamAdapter
  /** Releases the per-user concurrency slot; called exactly once when the call ends. */
  release: () => void
}

type Cause = 'first_byte_timeout' | 'stream_timeout' | 'client_abort'

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
}

/**
 * Open the upstream request and relay it as an SSE response.
 *
 * Timeouts (D-07):
 *   - `AI_UPSTREAM_TIMEOUT_MS` is a connect + first-byte timeout, cleared as soon as the first
 *     body chunk arrives. Failing it (or any other failure before the first byte) is a plain
 *     `502 ai_upstream_error`, because nothing has been sent to the client yet.
 *   - `AI_STREAM_MAX_MS` caps the whole stream.
 * Once the stream has started, any upstream failure, timeout or abort writes exactly one
 * `event: error` frame and closes. A client disconnect writes nothing.
 */
export async function proxyStream(a: ProxyStreamArgs): Promise<Response> {
  const { config, rt, record, adapter } = a
  record.deferred = true

  const ctrl = new AbortController()
  let cause: Cause | null = null
  let finished = false
  let reading = false
  let streamCtl: ReadableStreamDefaultController<Uint8Array> | null = null
  const boundary = new FrameBoundary()
  const decoder = new TextDecoder()

  const finish = (outcome: string, ok: boolean | null, status: number): void => {
    if (finished) return
    finished = true
    clearTimeout(firstTimer)
    clearTimeout(capTimer)
    a.clientSignal.removeEventListener('abort', onClientAbort)
    a.release()
    if (ok !== null) rt.recorder.record(ok, ok ? undefined : status)
    record.outcome = outcome
    record.status = status
    writeAiAccessLog(config, rt, a.userId, record)
  }

  const codeFor = (): SseErrorCode =>
    cause === 'stream_timeout' ? 'stream_timeout' : cause === 'first_byte_timeout' ? 'upstream_timeout' : 'upstream_error'

  const failStream = (code: SseErrorCode): void => {
    if (finished) return
    const ctl = streamCtl
    if (ctl) {
      try {
        const frame = errorFrame(code, boundary.atBoundary)
        ctl.enqueue(frame)
        record.bytesOut += frame.byteLength
        ctl.close()
      } catch {
        // stream already closed or cancelled
      }
    }
    finish(code, false, 200)
  }

  const abort = (why: Cause): void => {
    if (cause === null) cause = why
    ctrl.abort()
  }
  const onClientAbort = (): void => abort('client_abort')

  const firstTimer = setTimeout(() => abort('first_byte_timeout'), config.aiUpstreamTimeoutMs)
  const capTimer = setTimeout(() => {
    abort('stream_timeout')
    // No read pending (consumer is slow or gone): close the stream here instead of waiting for pull().
    if (!reading && streamCtl) failStream('stream_timeout')
  }, config.aiStreamMaxMs)
  if (a.clientSignal.aborted) abort('client_abort')
  else a.clientSignal.addEventListener('abort', onClientAbort, { once: true })

  function failBeforeStream(): never {
    if (cause === 'client_abort') finish('client_abort', null, 499)
    else finish(cause === 'first_byte_timeout' ? 'upstream_timeout' : 'upstream_error', false, 502)
    throw new HttpError(502, 'ai_upstream_error')
  }

  let res: Response
  try {
    res = await fetch(a.url, { method: 'POST', headers: a.headers, body: a.body, signal: ctrl.signal })
  } catch {
    failBeforeStream()
  }
  if (!res.ok || !res.body) {
    void res.body?.cancel().catch(() => {})
    failBeforeStream()
  }

  const reader = res.body.getReader()
  let first: Awaited<ReturnType<typeof reader.read>>
  try {
    first = await reader.read()
  } catch {
    failBeforeStream()
  }
  // First byte (or clean end) arrived: the connect/first-byte timeout no longer applies.
  clearTimeout(firstTimer)

  const emit = (ctl: ReadableStreamDefaultController<Uint8Array>, chunks: Uint8Array[]): boolean => {
    for (const ch of chunks) {
      ctl.enqueue(ch)
      record.bytesOut += ch.byteLength
      boundary.feed(decoder.decode(ch, { stream: true }))
    }
    return chunks.length > 0
  }

  const endNormally = (ctl: ReadableStreamDefaultController<Uint8Array>): void => {
    emit(ctl, adapter.flush())
    ctl.close()
    if (adapter.sawUpstreamError()) finish('upstream_error_event', false, 200)
    else finish('ok', true, 200)
  }

  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      streamCtl = ctl
      if (first.done) {
        endNormally(ctl)
        return
      }
      emit(ctl, adapter.transform(first.value))
      if (adapter.terminal()) {
        void reader.cancel().catch(() => {})
        failStream('upstream_error')
      }
    },
    async pull(ctl) {
      if (finished) return
      reading = true
      try {
        for (;;) {
          const r = await reader.read()
          if (finished) return
          if (r.done) {
            endNormally(ctl)
            return
          }
          if (emit(ctl, adapter.transform(r.value))) {
            if (adapter.terminal()) {
              void reader.cancel().catch(() => {})
              failStream('upstream_error')
            }
            return
          }
        }
      } catch {
        if (cause === 'client_abort') {
          finish('client_abort', null, 200)
        } else {
          failStream(codeFor())
        }
      } finally {
        reading = false
      }
    },
    cancel() {
      abort('client_abort')
      void reader.cancel().catch(() => {})
      finish('client_abort', null, 200)
    },
  })

  return new Response(body, { status: 200, headers: { ...STREAM_HEADERS, Date: new Date().toUTCString() } })
}
