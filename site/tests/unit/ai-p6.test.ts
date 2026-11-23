// @vitest-environment happy-dom
/**
 * P6 unit tests: fail-closed Markdown sanitization, SSE parser, BYOK client,
 * sessionStore isolation/no-ghost-sessions, custom tint WCAG >= 4.5 guard,
 * theme JSON import validation, AI_MOCK renderTemplate, and notionSync secret boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { installHappyDomWhatwgShims } from '../setup/happyDomPurify'
import DOMPurify from 'dompurify'
import { STORAGE_KEYS } from '../../docs/.vitepress/site.config.mts'
import { assertNoMockFlagsInBuild } from '../../docs/.vitepress/config.v2.mts'
import {
  companionCapabilities,
  normalizeCompanionAdapter,
} from '../../docs/.vitepress/theme/components/ai/companionRuntime'
import {
  SANITIZE_CONFIG,
  escapeHtml,
  resolveDomPurifyFn,
  resolveDomPurifyInstance,
  sanitizeHtmlFailClosed,
  type DomPurifyInstance,
} from '../../docs/.vitepress/theme/components/ai/markdownSanitize'
import { createSseParser } from '../../docs/.vitepress/theme/components/ai/sseParser'
import {
  buildOpenAiChatRequest,
  clearByokConfig,
  extractEndpointHost,
  getByokVerifyState,
  isByokActive,
  isValidByokUrl,
  readByokConfig,
  resetByokRuntimeForTest,
  verifyByokConnection,
  writeByokConfig,
} from '../../docs/.vitepress/theme/components/ai/byokClient'
import {
  createSessionStore,
  type SessionRepoLike,
} from '../../docs/.vitepress/theme/components/ai/sessionStore'
import {
  NeonRepository,
  NeonWriteError,
  type AiMessage,
  type AiSession,
  type AppendMessageParams,
  type CreateSessionParams,
} from '../../docs/.vitepress/theme/components/ai/neonRepository'
import {
  applyCustomTintToRoot,
  computeCustomTint,
  validateThemeImportJson,
} from '../../docs/.vitepress/theme/tokens/customTint'
import * as notionSync from '../../docs/.vitepress/theme/components/ai/notionSync'
import { renderTemplate, useDifyChat } from '../../docs/.vitepress/theme/components/ai/useDifyChat'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetByokRuntimeForTest()
  notionSync.clearFailedQueue()
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('markdownSanitize (FE-001 / FE-002)', () => {
  it('excludes style and display from ADD_ATTR and forbids style in FORBID_TAGS/FORBID_ATTR', () => {
    expect(SANITIZE_CONFIG.ADD_ATTR).not.toContain('style')
    expect(SANITIZE_CONFIG.ADD_ATTR).not.toContain('display')
    expect(SANITIZE_CONFIG.FORBID_TAGS).toContain('style')
    expect(SANITIZE_CONFIG.FORBID_TAGS).toContain('script')
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('style')
    expect(SANITIZE_CONFIG.FORBID_ATTR).toContain('onerror')
  })

  it('fails closed to escaped pre block when purifier is null or throws', () => {
    const xss = '<img src=x onerror="alert(1)"><script>evil()</script>'
    const whenNull = sanitizeHtmlFailClosed(xss, null)
    expect(whenNull).toContain('<pre class="ai-sanitize-fallback">')
    expect(whenNull).not.toContain('<script>')
    expect(whenNull).toContain('&lt;script&gt;evil()&lt;/script&gt;')

    const whenThrows = sanitizeHtmlFailClosed('<b>hi</b>', () => {
      throw new Error('purify crashed')
    })
    expect(whenThrows).toBe(`<pre class="ai-sanitize-fallback">${escapeHtml('<b>hi</b>')}</pre>`)
  })

  it('resolves DOMPurify function shapes cleanly', () => {
    const fn = (s: string) => s
    expect(resolveDomPurifyFn({ sanitize: fn }, window)).toBe(fn)
    expect(resolveDomPurifyFn(() => ({ sanitize: fn }), window)).toBe(fn)
    expect(resolveDomPurifyFn({ sanitize: fn }, null)).toBeNull()
  })
})

describe('sseParser (FE-022 / BYOK OpenAI & Dify)', () => {
  it('parses chunked Dify SSE frames across CRLF boundaries and error events', () => {
    const parser = createSseParser()
    const chunk1 = 'event: ping\r\n\r\ndata: {"event":"agent_message","conversation_id":"c1","ans'
    const chunk2 = 'wer":"hello "}\r\n\r\ndata: {"event":"message_end","metadata":{"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}}\n\n'
    const evs1 = parser.feed(chunk1)
    expect(evs1).toEqual([])
    const evs2 = parser.feed(chunk2)
    expect(evs2).toEqual([
      { type: 'delta', text: 'hello ', conversationId: 'c1', messageId: undefined },
      { type: 'done', conversationId: undefined, messageId: undefined, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ])

    const errEvents = parser.feed('data: {"event":"error","message":"upstream 502"}\n\n')
    expect(errEvents).toEqual([{ type: 'error', message: 'upstream 502', code: undefined, status: undefined }])
  })

  it('parses OpenAI-compatible SSE stream and [DONE]', () => {
    const parser = createSseParser()
    const a = parser.feed('data: {"choices":[{"delta":{"content":"JOIN "}}]}\n\n')
    const b = parser.feed('data: {"choices":[{"delta":{"content":"rules"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n')
    const c = parser.feed('data: [DONE]\n\n')
    expect(a).toEqual([{ type: 'delta', text: 'JOIN ' }])
    expect(b).toEqual([{ type: 'delta', text: 'rules' }])
    expect(c).toEqual([{ type: 'done', usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }])
  })
})

describe('byokClient (spec board §02 / §14)', () => {
  it('validates active BYOK config, extracts host, and builds OpenAI chat payload', () => {
    writeByokConfig({
      enabled: true,
      baseUrl: 'https://openrouter.ai/api/v1/',
      apiKey: 'sk-test-123',
      model: 'gpt-4o-mini',
    })
    const cfg = readByokConfig()
    expect(isByokActive(cfg)).toBe(true)
    expect(extractEndpointHost(cfg.baseUrl)).toBe('openrouter.ai')

    const req = buildOpenAiChatRequest(
      cfg,
      'Explain ON vs WHERE',
      { current_lecture: 'g05-L19', outline: 'Joins' },
      [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    )
    expect(req.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const parsedBody = JSON.parse(String(req.init.body)) as { model: string; stream: boolean; messages: Array<{ role: string }> }
    expect(parsedBody.model).toBe('gpt-4o-mini')
    expect(parsedBody.stream).toBe(true)
    expect(parsedBody.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])

    const bad = { enabled: true, baseUrl: 'javascript:alert(1)', apiKey: 'sk', model: 'm', remember: false }
    expect(isByokActive(bad)).toBe(false)

    clearByokConfig()
    expect(isByokActive(readByokConfig())).toBe(false)
  })
})

describe('sessionStore (FE-004/006/007/008/009/012)', () => {
  function makeFakeRepo(): SessionRepoLike & {
    createdSessions: CreateSessionParams[]
    appendedMessages: AppendMessageParams[]
    seedSession: (sess: AiSession, msgs: AiMessage[]) => void
  } {
    const sessionsByLec = new Map<string, AiSession[]>()
    const msgsBySess = new Map<string, AiMessage[]>()
    const createdSessions: CreateSessionParams[] = []
    const appendedMessages: AppendMessageParams[] = []
    return {
      createdSessions,
      appendedMessages,
      seedSession(sess, msgs) {
        const cur = sessionsByLec.get(sess.lecture_id) || []
        sessionsByLec.set(sess.lecture_id, [sess, ...cur])
        msgsBySess.set(sess.id, msgs)
      },
      async getSessions(lectureId) {
        return sessionsByLec.get(lectureId) || []
      },
      async createSession(params) {
        createdSessions.push(params)
        const s: AiSession = {
          id: params.id || 's1',
          lecture_id: params.lecture_id,
          group_id: params.group_id,
          title: params.title || 'New session',
          is_archived: false,
          created_at: '2026-11-19T00:00:00.000Z',
          updated_at: '2026-11-19T00:00:00.000Z',
        }
        const cur = sessionsByLec.get(s.lecture_id) || []
        sessionsByLec.set(s.lecture_id, [s, ...cur])
        return s
      },
      async updateSessionTitle() {
        return true
      },
      async getMessages(sessionId) {
        return msgsBySess.get(sessionId) || []
      },
      async appendMessage(params) {
        appendedMessages.push(params)
        const m: AiMessage = {
          id: params.id || 'm',
          session_id: params.session_id,
          role: params.role,
          content: params.content,
          selected_context: params.selected_context ?? null,
          model: 'test',
          prompt_tokens: 0,
          completion_tokens: 0,
          created_at: '2026-11-19T00:00:00.000Z',
        }
        const cur = msgsBySess.get(params.session_id) || []
        msgsBySess.set(params.session_id, [...cur, m])
        return m
      },
      async clearSessions(lectureId) {
        sessionsByLec.set(lectureId, [])
        return true
      },
    }
  }

  it('never creates ghost sessions on visit or draft creation, and refuses mock/error writes', async () => {
    const repo = makeFakeRepo()
    const store = createSessionStore(repo, { purgeOnFirstLoad: false })

    await store.loadForLecture('g05-L19')
    expect(repo.createdSessions).toHaveLength(0)

    const draft = store.startNewDraft('g05-L19', 'g05', 'Draft')
    expect(repo.createdSessions).toHaveLength(0)

    const snapErr = store.beginTurn('g05-L19', 'g05', draft.title)
    const errRes = await store.commitTurn({
      snapshot: snapErr,
      sessionTitle: 'Q1',
      userMessage: { id: 'u1', role: 'user', content: 'Q1', createdAt: 1 },
      assistantMessage: { id: 'a1', role: 'assistant', content: '', createdAt: 2, isError: true },
    })
    expect(errRes).toEqual({ saved: false, reason: 'error' })
    expect(repo.createdSessions).toHaveLength(0)
    expect(repo.appendedMessages).toHaveLength(0)

    const snapMock = store.beginTurn('g05-L19', 'g05', draft.title)
    const mockRes = await store.commitTurn({
      snapshot: snapMock,
      sessionTitle: 'Q1',
      userMessage: { id: 'u2', role: 'user', content: 'Q1', createdAt: 1 },
      assistantMessage: { id: 'a2', role: 'assistant', content: '[Demo]', createdAt: 2, isMock: true },
    })
    expect(mockRes).toEqual({ saved: false, reason: 'mock' })
    expect(repo.createdSessions).toHaveLength(0)
    expect(repo.appendedMessages).toHaveLength(0)
  })

  it('isolates conversationId per session, preserves explicit cross-lecture choice, and blocks stale turns', async () => {
    const repo = makeFakeRepo()
    repo.seedSession(
      {
        id: 'sess_target',
        lecture_id: 'g02-L03',
        group_id: 'g02',
        title: 'Target session',
        is_archived: false,
        created_at: '2026-11-19T00:00:00.000Z',
        updated_at: '2026-11-19T00:00:00.000Z',
      },
      [{
        id: 'm1',
        session_id: 'sess_target',
        role: 'user',
        content: 'hello target',
        selected_context: null,
        model: 'm',
        prompt_tokens: 0,
        completion_tokens: 0,
        created_at: '2026-11-19T00:00:00.000Z',
      }],
    )
    repo.seedSession(
      {
        id: 'sess_first',
        lecture_id: 'g02-L03',
        group_id: 'g02',
        title: 'First session',
        is_archived: false,
        created_at: '2026-11-19T00:00:00.000Z',
        updated_at: '2026-11-19T01:00:00.000Z',
      },
      [],
    )

    const store = createSessionStore(repo, { purgeOnFirstLoad: false })
    await store.loadForLecture('g01-L01')
    const abortSpy = vi.fn()
    store.registerAbort(abortSpy)

    const snap = store.beginTurn('g01-L01', 'g01', 'Question')
    // User switches to explicit session on g02-L03 mid-stream
    store.markExplicitSelection({
      id: 'sess_target',
      lecture_id: 'g02-L03',
      group_id: 'g02',
      title: 'Target session',
      is_archived: false,
      created_at: '2026-11-19T00:00:00.000Z',
      updated_at: '2026-11-19T00:00:00.000Z',
    })
    const loaded = await store.loadForLecture('g02-L03')
    expect(abortSpy).toHaveBeenCalledOnce()
    expect(loaded.sessionId).toBe('sess_target')

    // Old turn finishes late -> must NOT persist into new lecture/session
    const lateRes = await store.commitTurn({
      snapshot: snap,
      sessionTitle: 'Late',
      userMessage: { id: 'u-late', role: 'user', content: 'Q', createdAt: 1 },
      assistantMessage: { id: 'a-late', role: 'assistant', content: 'A', createdAt: 2 },
    })
    expect(lateRes).toEqual({ saved: false, reason: 'stale_turn' })
    expect(repo.appendedMessages).toHaveLength(0)

    // Real turn on current session saves incrementally (only 2 messages)
    const snap2 = store.beginTurn('g02-L03', 'g02', 'Follow-up')
    const okRes = await store.commitTurn({
      snapshot: snap2,
      sessionTitle: 'Target session',
      userMessage: { id: 'u-ok', role: 'user', content: 'Real Q', createdAt: 3 },
      assistantMessage: { id: 'a-ok', role: 'assistant', content: 'Real A', createdAt: 4 },
      conversationId: 'conv-g02-target',
    })
    expect(okRes).toEqual({ saved: true, sessionId: 'sess_target' })
    expect(repo.appendedMessages.map((m) => m.id)).toEqual(['u-ok', 'a-ok'])
    expect(store.getConversationId('sess_target')).toBe('conv-g02-target')

    // New draft resets active conversationId
    const nextDraft = store.startNewDraft('g02-L03', 'g02', 'New draft')
    expect(store.getConversationId(nextDraft.id)).toBe('')
  })
})

describe('customTint & theme JSON validation (WP-A4)', () => {
  it('enforces WCAG >= 4.5:1 on custom reader tints and refuses low-contrast tints', () => {
    const bright = computeCustomTint(42, 95)
    expect(bright.pass).toBe(true)
    expect(bright.minRatio).toBeGreaterThanOrEqual(4.5)
    expect(applyCustomTintToRoot(document.documentElement, { hue: 42, lightness: 95 })).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--lec-bg')).toBe(bright.bgHex)

    const darkTint = computeCustomTint(42, 42)
    expect(darkTint.pass).toBe(false)
    expect(darkTint.minRatio).toBeLessThan(4.5)
    expect(applyCustomTintToRoot(document.documentElement, { hue: 42, lightness: 42 })).toBe(false)
    // Existing passing bg preserved
    expect(document.documentElement.style.getPropertyValue('--lec-bg')).toBe(bright.bgHex)
  })

  it('validates imported theme JSON against contrast & illegal CSS values', () => {
    const okJson = JSON.stringify({
      modes: {
        light: { bg: '#FDFBF7', text: '#1F2328', accent: '#2155C4' },
      },
    })
    expect(validateThemeImportJson(okJson)).toMatchObject({ ok: true, tokenCount: 3 })

    const lowContrast = JSON.stringify({
      modes: {
        light: { bg: '#222222', text: '#333333' },
      },
    })
    expect(validateThemeImportJson(lowContrast)).toMatchObject({ ok: false })

    const cssSmuggle = JSON.stringify({
      modes: {
        light: { bg: 'url(javascript:alert(1))' },
      },
    })
    expect(validateThemeImportJson(cssSmuggle)).toMatchObject({ ok: false })
  })
})

describe('notionSync & AI_MOCK security contracts (FE-017 / FE-024)', () => {
  it('removes client-side direct Notion PATCH helper', () => {
    expect('executeDirectNotionStatusPatch' in notionSync).toBe(false)
  })

  it('renderTemplate fills known keys and preserves unknown placeholders', () => {
    expect(renderTemplate('In [{lecture}] {unknown}', { lecture: 'G05-L19' })).toBe('In [G05-L19] {unknown}')
  })

  it('rejects non-2xx DB writes with NeonWriteError and leaves localStorage empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'db_unavailable' }), { status: 503 })),
    )
    const repo = new NeonRepository({ apiBaseUrl: '/api/db', storagePrefix: 'test_neon_' })
    await expect(
      repo.createSession({ lecture_id: 'g01-l01', group_id: 'g01', title: 'Test' }),
    ).rejects.toThrow(NeonWriteError)
    expect(localStorage.length).toBe(0)
  })

  it('stops retrying Notion sync on 403 and preserves error state + detail', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    notionSync.syncStatusToNotion('g01-l01', notionSync.ALLOWED_NOTION_STATUSES[2]!)
    await vi.waitFor(() => {
      expect(notionSync.getNotionQueueStats().state).toBe('error')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(notionSync.getLastNotionSyncError()).toBe('HTTP 403')
  })
})

describe('DOMPurify real XSS corpus (D-05 / D-06)', () => {
  it('blocks img/picture/script/style and enforces rel="noopener noreferrer" on every link', () => {
    // Instantiate a fresh DOMPurify bound to a WHATWG-aligned Window so happy-dom v20
    // Node.prototype.nodeName / live NodeIterator bugs do not bypass DOMPurify hooks.
    const shimmedWin = new Window()
    installHappyDomWhatwgShims(shimmedWin)
    const purifyFactory = DOMPurify as unknown as (w: Window) => DomPurifyInstance
    const purifier = resolveDomPurifyInstance(purifyFactory(shimmedWin), shimmedWin)
    expect(purifier).not.toBeNull()
    const corpus = [
      '<img src="https://evil.test/tracker.png" onerror="alert(1)">',
      '<picture><source srcset="https://evil.test/a.jpg"><img src="x"></picture>',
      '<script>window.__xss=1</script><style>body{display:none}</style>',
      '<div style="color:red" onclick="alert(2)">clean</div>',
      '<svg onload="alert(3)"><circle cx="5" cy="5" r="4"></circle></svg>',
      '<a href="javascript:alert(4)" target="_blank">js-bad</a>',
      '<a href="JaVaScRiPt:alert(5)">js-mixed</a>',
      '<a href="data:text/html,<script>1</script>">data-bad</a>',
      '<a href="https://example.com/docs" target="_blank">ext-blank</a>',
      '<a href="https://example.org/plain">ext-no-target</a>',
      '<a href="/g01/L01" target="_blank">rel-local</a>',
    ].join('')

    const sanitized = sanitizeHtmlFailClosed(corpus, purifier)
    const host = document.createElement('div')
    host.innerHTML = sanitized

    expect(host.querySelectorAll('img, picture, source, script, style')).toHaveLength(0)
    expect(sanitized).not.toMatch(/onerror|onload|onclick|javascript:/i)
    expect(host.querySelector('div')?.getAttribute('style')).toBeNull()

    const links = Array.from(host.querySelectorAll('a'))
    expect(links.length).toBeGreaterThanOrEqual(3)
    for (const a of links) {
      const href = a.getAttribute('href')
      if (!href) {
        expect(a.getAttribute('target')).toBeNull()
        continue
      }
      expect(href).not.toMatch(/^(?:javascript|data):/i)
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
      if (a.hasAttribute('target')) {
        expect(a.getAttribute('target')).toBe('_blank')
      }
    }
  })
})

describe('BYOK remember toggle, HTTPS enforcement & real verify (D-01 / D-03 / D-14)', () => {
  it('keeps keys out of localStorage/sessionStorage unless remember is checked, deletes on uncheck, and rejects http://', async () => {
    expect(isValidByokUrl('http://openrouter.ai/api/v1')).toBe(false)
    expect(isValidByokUrl('https://openrouter.ai/api/v1')).toBe(true)

    const memCfg = writeByokConfig({
      enabled: true,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-memory-only',
      model: 'gpt-4o-mini',
      remember: false,
    })
    expect(isByokActive(memCfg)).toBe(true)
    expect(localStorage.getItem(STORAGE_KEYS.companionByok)).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEYS.companionByok)).toBeNull()

    writeByokConfig({ remember: true })
    expect(localStorage.getItem(STORAGE_KEYS.companionByok)).toContain('sk-memory-only')
    expect(sessionStorage.getItem(STORAGE_KEYS.companionByok)).toBeNull()

    writeByokConfig({ remember: false })
    expect(localStorage.getItem(STORAGE_KEYS.companionByok)).toBeNull()
    expect(sessionStorage.getItem(STORAGE_KEYS.companionByok)).toBeNull()

    const badFetch = vi.fn(async () => new Response('{}', { status: 401 }))
    const failed = await verifyByokConnection(readByokConfig(), badFetch as unknown as typeof fetch)
    expect(failed.ok).toBe(false)
    expect(getByokVerifyState().status).toBe('failed')

    const okFetch = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }))
    const okRes = await verifyByokConnection(readByokConfig(), okFetch as unknown as typeof fetch)
    expect(okRes.ok).toBe(true)
    expect(getByokVerifyState().status).toBe('ok')
  })
})

describe('Plan B adapter gating, mock ban, SSE truncation & HTTP status handling (D-04 / D-07)', () => {
  it('maps companion adapters and aborts production build if VITE_AI_MOCK is set', () => {
    expect(normalizeCompanionAdapter('off')).toBe('off')
    expect(normalizeCompanionAdapter('proxy')).toBe('proxy')
    expect(normalizeCompanionAdapter('byok')).toBe('openai-compatible')
    expect(companionCapabilities('off')).toMatchObject({ enabled: false, showByokSection: false })
    expect(companionCapabilities('proxy')).toMatchObject({ enabled: true, allowProxy: true, showByokSection: true })
    expect(companionCapabilities('openai-compatible')).toMatchObject({ enabled: true, allowProxy: false, showByokSection: true })
    expect(() => assertNoMockFlagsInBuild([{ VITE_AI_MOCK: '1' }])).toThrow(/mock flag VITE_AI_MOCK/i)
    expect(() => assertNoMockFlagsInBuild([{ VITE_AI_MOCK: '0' }])).not.toThrow()
  })

  it('does not treat EOF after usage without [DONE]/message_end as complete', () => {
    const parser = createSseParser()
    parser.feed('data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"total_tokens":5}}\n\n')
    expect(parser.flush()).toEqual([])
    expect(parser.sawDone()).toBe(false)
    expect(parser.sawError()).toBe(false)
  })

  it('marks truncated/error SSE streams incomplete, strips client user field, and handles 429/413/403', async () => {
    const capturedBodies: Array<Record<string, unknown>> = []
    let mode: '429' | '413' | '403' | 'sse_err' | 'eof_cut' = '429'

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body && typeof init.body === 'string') {
          capturedBodies.push(JSON.parse(init.body) as Record<string, unknown>)
        }
        if (mode === '429') {
          return new Response(JSON.stringify({ error: 'rate_limited', retry_after: 17 }), {
            status: 429,
            headers: { 'retry-after': '17' },
          })
        }
        if (mode === '413') {
          return new Response(JSON.stringify({ error: 'payload_too_large' }), { status: 413 })
        }
        if (mode === '403') {
          return new Response(JSON.stringify({ error: 'anonymous_disabled' }), { status: 403 })
        }
        if (mode === 'sse_err') {
          return new Response(
            'data: {"event":"agent_message","answer":"half answer "}\n\nevent: error\ndata: {"event":"error","code":"stream_timeout","message":"timed out"}\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        return new Response('data: {"event":"agent_message","answer":"cut off mid sentence"}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }),
    )

    const onRateLimited = vi.fn()
    const chat = useDifyChat({ adapter: 'proxy', onRateLimited })

    const r429 = await chat.sendMessage('Q1')
    expect(r429?.ok).toBe(false)
    expect(onRateLimited).toHaveBeenCalledWith(17)
    expect(capturedBodies[0]).not.toHaveProperty('user')

    mode = '413'
    const r413 = await chat.sendMessage('Q2')
    expect(r413?.ok).toBe(false)
    expect(r413?.assistantMessage.isError).toBe(true)

    mode = '403'
    const r403 = await chat.sendMessage('Q3')
    expect(r403?.ok).toBe(false)
    expect(r403?.assistantMessage.isError).toBe(true)

    mode = 'sse_err'
    const rErr = await chat.sendMessage('Q4')
    expect(rErr?.ok).toBe(false)
    expect(rErr?.isIncomplete).toBe(true)
    expect(rErr?.assistantMessage.content).toContain('half answer')

    mode = 'eof_cut'
    const rCut = await chat.sendMessage('Q5')
    expect(rCut?.ok).toBe(false)
    expect(rCut?.isIncomplete).toBe(true)
    expect(rCut?.assistantMessage.isIncomplete).toBe(true)
  })

  it('refuses committing incomplete messages to sessionStore and supports dark custom tints', async () => {
    const created: CreateSessionParams[] = []
    const repo: SessionRepoLike = {
      async getSessions() { return [] },
      async createSession(p) {
        created.push(p)
        return {
          id: p.id || 's1',
          lecture_id: p.lecture_id,
          group_id: p.group_id,
          title: p.title || 'S',
          is_archived: false,
          created_at: '2026-11-21T00:00:00Z',
          updated_at: '2026-11-21T00:00:00Z',
        }
      },
      async updateSessionTitle() { return true },
      async getMessages() { return [] },
      async appendMessage(p) {
        return {
          id: p.id || 'm',
          session_id: p.session_id,
          role: p.role,
          content: p.content,
          selected_context: p.selected_context ?? null,
          model: 'm',
          prompt_tokens: 0,
          completion_tokens: 0,
          created_at: '2026-11-21T00:00:00Z',
        }
      },
      async clearSessions() { return true },
    }
    const store = createSessionStore(repo, { purgeOnFirstLoad: false })
    await store.loadForLecture('g01-l01')
    const snap = store.beginTurn('g01-l01', 'g01', 'Draft')
    const incRes = await store.commitTurn({
      snapshot: snap,
      sessionTitle: 'Draft',
      userMessage: { id: 'u-inc', role: 'user', content: 'hi', createdAt: 1 },
      assistantMessage: { id: 'a-inc', role: 'assistant', content: 'cut...', createdAt: 2, isIncomplete: true },
    })
    expect(incRes).toEqual({ saved: false, reason: 'incomplete' })
    expect(created).toHaveLength(0)

    const darkCustom = computeCustomTint(210, 12)
    expect(darkCustom.dark).toBe(true)
    expect(darkCustom.pass).toBe(true)
    expect(darkCustom.textRatio).toBeGreaterThanOrEqual(7.0)
    expect(darkCustom.minRatio).toBeGreaterThanOrEqual(4.5)

    const midFail = computeCustomTint(42, 42)
    expect(midFail.pass).toBe(false)
    expect(midFail.failReasons.length).toBeGreaterThan(0)
  })
})

describe('audit additions: own-origin /api endpoint ban and proxy status on SSE error frames', () => {
  it('refuses a BYOK endpoint that points at this site /api/*', () => {
    const happy = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM
    const before = window.location.href
    happy.setURL('https://lecture.example/')
    try {
      expect(isValidByokUrl('https://lecture.example/api/ai/chat')).toBe(false)
      expect(isValidByokUrl('https://lecture.example/apis/v1')).toBe(true)
      expect(isValidByokUrl('https://example.com/api/v1')).toBe(true)
    } finally {
      happy.setURL(before)
    }
  })

  it('reports the proxy as unavailable when an SSE error frame ends the stream, and not for 413', async () => {
    let mode: 'sse_err' | '413' = 'sse_err'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mode === '413'
          ? new Response(JSON.stringify({ error: 'payload_too_large' }), { status: 413 })
          : new Response(
              'event: error\ndata: {"event":"error","code":"upstream_error","message":"boom"}\n\n',
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
      ),
    )
    const onUnavailable = vi.fn()
    const chat = useDifyChat({ adapter: 'proxy', onUnavailable })
    const r = await chat.sendMessage('Q')
    expect(r?.ok).toBe(false)
    expect(onUnavailable).toHaveBeenCalledTimes(1)
    mode = '413'
    await chat.sendMessage('Q2')
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })

  it('keeps a Test-button result on Save for the same credentials and resets it when they change', async () => {
    resetByokRuntimeForTest()
    const draft = { enabled: true, baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-a', model: 'm1', remember: false }
    const okFetch = vi.fn(async () => new Response('{"id":"1"}', { status: 200 }))
    await verifyByokConnection(draft, okFetch as unknown as typeof fetch)
    expect(getByokVerifyState().status).toBe('ok')
    writeByokConfig(draft)
    expect(getByokVerifyState().status).toBe('ok')
    writeByokConfig({ model: 'm2' })
    expect(getByokVerifyState().status).toBe('unverified')
  })
})

describe('reader own-key tool loop and native tool_call SSE progress (WP-K3 Item 5)', () => {
  it('discovers tools, loops tool_calls via POST /api/tools/:name, emits UI progress without args/results, and streams final answer', async () => {
    resetByokRuntimeForTest()
    writeByokConfig({
      enabled: true,
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-reader-key',
      model: 'gpt-4o-mini',
      remember: false,
    })

    const calls: Array<{ url: string; method: string; body?: string; auth?: string | null }> = []
    let llmRound = 0
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? 'GET'
      const bodyStr = typeof init?.body === 'string' ? init.body : undefined
      const hdrs = new Headers(init?.headers)
      calls.push({ url, method, body: bodyStr, auth: hdrs.get('Authorization') })

      if (url === '/api/tools' && method === 'GET') {
        expect(hdrs.get('Authorization')).toBeNull()
        return new Response(
          JSON.stringify({
            maxSteps: 5,
            tools: [
              {
                name: 'search_concepts',
                description: 'Search concepts',
                parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      if (url === '/api/tools/search_concepts' && method === 'POST') {
        expect(hdrs.get('Authorization')).toBeNull()
        expect(JSON.parse(bodyStr ?? '{}')).toEqual({ query: '执行租约' })
        return new Response(JSON.stringify([{ slug: 'actuation-lease', term: '执行租约', summary: 'secret-summary' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (url === 'https://llm.example/v1/chat/completions' && method === 'POST') {
        llmRound++
        const parsedReq = JSON.parse(bodyStr ?? '{}') as {
          tools?: Array<{ type: string; function: { name: string } }>
          messages: Array<{ role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }>
        }
        expect(parsedReq.tools?.[0]).toMatchObject({ type: 'function', function: { name: 'search_concepts' } })
        if (llmRound === 1) {
          // Stream incremental tool_calls chunks across separate SSE frames
          const sse = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_99","type":"function","function":{"name":"search_concepts","arguments":""}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":\\"执行"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"租约\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            'data: [DONE]\n\n',
          ].join('')
          return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        expect(parsedReq.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_99' && m.content?.includes('actuation-lease'))).toBe(true)
        const finalSse = [
          'data: {"choices":[{"delta":{"content":"执行租约是一种限时授权凭证。"}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ].join('')
        return new Response(finalSse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      throw new Error(`Unexpected fetch ${method} ${url}`)
    })

    const chat = useDifyChat({ adapter: 'openai-compatible', fetchFn: mockFetch as unknown as typeof fetch })
    const res = await chat.sendMessage('什么是执行租约？')
    expect(res?.ok).toBe(true)
    expect(res?.assistantMessage.content).toBe('执行租约是一种限时授权凭证。')
    expect(res?.assistantMessage.toolCalls).toEqual([
      { id: 'call_99', name: 'search_concepts', state: 'done' },
    ])
    // Ensure args & results are NOT placed on UI ChatToolCall items
    expect(JSON.stringify(res?.assistantMessage.toolCalls)).not.toContain('secret-summary')
    expect(JSON.stringify(res?.assistantMessage.toolCalls)).not.toContain('query')
  })

  it('caps BYOK model calls at maxSteps', async () => {
    resetByokRuntimeForTest()
    writeByokConfig({
      enabled: true,
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-reader-key',
      model: 'gpt-4o-mini',
      remember: false,
    })

    let modelCalls = 0
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/tools' && (init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            maxSteps: 2,
            tools: [{ name: 'search_concepts', description: 'd', parameters: { type: 'object', properties: {} } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === '/api/tools/search_concepts') {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      modelCalls++
      const sse = [
        `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c_${modelCalls}","type":"function","function":{"name":"search_concepts","arguments":"{\\"query\\":\\"x\\"}"}}]}}]}\n\n`,
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })

    const chat = useDifyChat({ adapter: 'openai-compatible', fetchFn: mockFetch as unknown as typeof fetch })
    const res = await chat.sendMessage('无限递归测试')
    expect(res?.ok).toBe(true)
    expect(modelCalls).toBe(2)
    expect(chat.isStreaming.value).toBe(false)
  })

  it('feeds tool errors back as {error: code} messages and degrades cleanly without tools when GET /api/tools 404s', async () => {
    resetByokRuntimeForTest()
    writeByokConfig({
      enabled: true,
      baseUrl: 'https://llm.example/v1',
      apiKey: 'sk-reader-key',
      model: 'gpt-4o-mini',
      remember: false,
    })

    // Case 1: tool error forwarded to model
    let round = 0
    const errFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/tools') {
        return new Response(
          JSON.stringify({
            maxSteps: 4,
            tools: [{ name: 'get_concept', description: 'd', parameters: { type: 'object', properties: {} } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      if (url === '/api/tools/get_concept') {
        return new Response(JSON.stringify({ error: 'tool_disabled' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      round++
      if (round === 1) {
        return new Response(
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c_err","type":"function","function":{"name":"get_concept","arguments":"{\\"slug\\":\\"a\\"}"}}]}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      const reqJson = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content?: string }> }
      expect(reqJson.messages.some((m) => m.role === 'tool' && m.content === '{"error":"tool_disabled"}')).toBe(true)
      return new Response('data: {"choices":[{"delta":{"content":"工具暂未启用，直接基于讲义作答。"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const chat1 = useDifyChat({ adapter: 'openai-compatible', fetchFn: errFetch as unknown as typeof fetch })
    const out1 = await chat1.sendMessage('查概念')
    expect(out1?.assistantMessage.toolCalls).toEqual([{ id: 'c_err', name: 'get_concept', state: 'error' }])
    expect(out1?.assistantMessage.content).toContain('工具暂未启用')

    // Case 2: GET /api/tools 404 -> no tools sent in OpenAI payload
    const staticFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input)
      if (url === '/api/tools') {
        return new Response('Not Found', { status: 404 })
      }
      const reqJson = JSON.parse(String(init?.body ?? '{}')) as { tools?: unknown }
      expect(reqJson.tools).toBeUndefined()
      return new Response('data: {"choices":[{"delta":{"content":"纯静态回答"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const chat2 = useDifyChat({ adapter: 'openai-compatible', fetchFn: staticFetch as unknown as typeof fetch })
    const out2 = await chat2.sendMessage('无后端问答')
    expect(out2?.ok).toBe(true)
    expect(out2?.assistantMessage.content).toBe('纯静态回答')
    expect(out2?.assistantMessage.toolCalls).toEqual([])
  })

  it('tracks native SSE tool_call start/end events onto ChatMessage.toolCalls', async () => {
    const proxyFetch = vi.fn(async () => {
      const sse = [
        'data: {"event":"tool_call","name":"search_lectures","state":"start"}\n\n',
        'data: {"event":"tool_call","name":"search_lectures","state":"end","ok":true,"ms":12}\n\n',
        'data: {"event":"agent_message","conversation_id":"conv-1","message_id":"m-1","answer":"检索结果如上。"}\n\n',
        'data: {"event":"message_end","conversation_id":"conv-1","message_id":"m-1"}\n\n',
      ].join('')
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    const chat = useDifyChat({ adapter: 'proxy', fetchFn: proxyFetch as unknown as typeof fetch })
    const res = await chat.sendMessage('检索讲义')
    expect(res?.ok).toBe(true)
    expect(res?.assistantMessage.toolCalls).toHaveLength(1)
    expect(res?.assistantMessage.toolCalls?.[0]).toMatchObject({ name: 'search_lectures', state: 'done' })
  })
})
