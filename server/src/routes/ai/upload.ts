import type { Context } from 'hono'
import type { AppEnv } from '../../app.js'
import type { AppConfig } from '../../config/schema.js'
import { HttpError, rateLimited } from '../../http/errors.js'
import { trimTrailingSlashes } from '../../http/url.js'
import { type AiCallRecord, getRequestUserId, type AiRuntime } from './runtime.js'

type Signature = 'pdf' | 'png' | 'jpeg' | 'gif' | 'webp' | 'zip' | 'ole' | 'text'

/** Allowed extensions and the content signature each one must carry. */
const EXTENSION_SIGNATURES: Record<string, Signature> = {
  '.pdf': 'pdf',
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
  '.pptx': 'zip',
  '.docx': 'zip',
  '.xlsx': 'zip',
  '.ppt': 'ole',
  '.doc': 'ole',
  '.xls': 'ole',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
}

function startsWith(buf: Uint8Array, bytes: readonly number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false
  return bytes.every((b, i) => buf[offset + i] === b)
}

/**
 * Check the leading bytes of the file against the signature its extension promises.
 * `text` accepts only valid UTF-8 without NUL bytes (checked over the first 8 KB).
 */
export function matchesSignature(head: Uint8Array, kind: Signature): boolean {
  switch (kind) {
    case 'pdf':
      return startsWith(head, [0x25, 0x50, 0x44, 0x46]) // %PDF
    case 'png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff])
    case 'gif':
      return startsWith(head, [0x47, 0x49, 0x46, 0x38]) // GIF8
    case 'webp':
      return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8) // RIFF....WEBP
    case 'zip':
      return startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])
    case 'ole':
      return startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])
    case 'text': {
      if (head.includes(0)) return false
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true })
        return true
      } catch {
        return false
      }
    }
  }
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function fallbackRecord(rt: AiRuntime): AiCallRecord {
  return {
    route: 'upload',
    startedAt: rt.now(),
    bytesIn: 0,
    bytesOut: 0,
    status: 0,
    outcome: 'unknown',
    limit: null,
    deferred: false,
    logged: false,
  }
}

/**
 * `POST /api/ai/upload`. The multipart body is buffered in memory (`c.req.formData()`): it is
 * bounded by `AI_UPLOAD_MAX_BYTES` (default 20 MB) and by a fixed limit of one concurrent upload
 * per user, which keeps the worst case at one buffer per active user. The file is not streamed
 * to Dify, because the magic-byte check needs the leading bytes before anything is forwarded.
 */
export function createUploadHandler(config: AppConfig, rt: AiRuntime) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    c.header('Date', new Date().toUTCString())

    if (config.aiProvider === 'off') {
      return c.json({ error: 'ai_not_configured' }, 503)
    }

    if (config.aiProvider === 'openai') {
      return c.json({ error: 'upload_unsupported_for_provider' }, 501)
    }

    const userId = getRequestUserId(c)
    if (!userId) {
      return c.json({ error: 'unauthenticated' }, 401)
    }

    const contentType = c.req.header('content-type') || ''
    if (!contentType.includes('multipart/form-data')) {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const record = c.get('aiCall') ?? fallbackRecord(rt)
    const release = rt.uploadGate.acquire(userId)
    if (!release) {
      record.limit = 'upload_concurrency'
      throw rateLimited('upload_concurrency', 5)
    }

    try {
      let formData: FormData
      try {
        formData = await c.req.formData()
      } catch {
        return c.json({ error: 'invalid_request' }, 400)
      }

      const file = formData.get('file')
      if (!file || !(file instanceof File) || file.size === 0) {
        return c.json({ error: 'invalid_request' }, 400)
      }

      const fileName = file.name || ''
      const signature = EXTENSION_SIGNATURES[extensionOf(fileName)]
      if (!signature) {
        return c.json({ error: 'invalid_file_type' }, 400)
      }

      if (file.size > config.aiUploadMaxBytes) {
        c.header('Connection', 'close')
        return c.json({ error: 'payload_too_large' }, 413)
      }
      record.bytesIn = Math.max(record.bytesIn, file.size)

      const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer())
      if (!matchesSignature(head, signature)) {
        throw new HttpError(400, 'invalid_file_type', { message: 'file_content_mismatch' })
      }

      const outgoingFormData = new FormData()
      outgoingFormData.append('file', file, fileName)
      outgoingFormData.append('user', userId)

      const url = `${trimTrailingSlashes(config.difyApiBase)}/files/upload`
      let upstreamRes: Response
      try {
        upstreamRes = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.difyApiKey ?? ''}`,
          },
          body: outgoingFormData,
          signal: AbortSignal.timeout(config.aiUpstreamTimeoutMs),
        })
      } catch {
        rt.recorder.record(false, 502)
        return c.json({ error: 'ai_upstream_error' }, 502)
      }

      if (!upstreamRes.ok) {
        rt.recorder.record(false, 502)
        return c.json({ error: 'ai_upstream_error' }, 502)
      }

      const data = (await upstreamRes.json().catch(() => null)) as Record<string, unknown> | null
      if (!data || typeof data !== 'object') {
        rt.recorder.record(false, 502)
        return c.json({ error: 'ai_upstream_error' }, 502)
      }

      const id = typeof data['id'] === 'string' ? data['id'] : ''
      if (id !== '') rt.files.add(userId, id)
      rt.recorder.record(true)

      const result = {
        id,
        name: typeof data['name'] === 'string' ? data['name'] : fileName,
        size: typeof data['size'] === 'number' ? data['size'] : file.size,
        extension: typeof data['extension'] === 'string'
          ? data['extension']
          : fileName.split('.').pop() ?? '',
        mime_type: typeof data['mime_type'] === 'string'
          ? data['mime_type']
          : file.type || 'application/octet-stream',
        created_at: typeof data['created_at'] === 'number'
          ? data['created_at']
          : Math.floor(Date.now() / 1000),
      }

      return c.json(result, 201)
    } finally {
      // Non-streamed: the router middleware writes the access-log line after this returns.
      release()
    }
  }
}
