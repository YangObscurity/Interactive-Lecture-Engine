/**
 * tests/unit/ai-contracts.test.ts - Unit tests for AI feature contracts & concept-draft contract runner (WP-F9).
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAiContract } from '../../docs/.vitepress/prompts/loadContract.mts'
import {
  CONTRACT_INVALID_MESSAGE_ZH,
  assembleContractMessages,
  parseContractJsonResponse,
  runAiContract,
  validateContractOutput,
  type ContractCallLog,
} from '../../docs/.vitepress/prompts/contracts.ts'
import type { ConceptDraftPayload } from '../../docs/.vitepress/concepts/frontmatter.ts'
import { createDashboardDevHandler } from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'

const tempRoots: string[] = []
const servers: http.Server[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

function invokeHandler(
  handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>,
  opts: { method?: string; url: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = new EventEmitter() as IncomingMessage & EventEmitter
    req.method = opts.method ?? 'GET'
    req.url = opts.url
    req.headers = { host: '127.0.0.1:5174', ...opts.headers }
    req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']

    let rawBody = ''
    let statusCode = 200
    let headersSent = false
    const headers: Record<string, string> = {}
    const res = {
      get statusCode() {
        return statusCode
      },
      set statusCode(v: number) {
        statusCode = v
      },
      get headersSent() {
        return headersSent
      },
      writeHead(code: number, hdrs?: Record<string, string>) {
        statusCode = code
        if (hdrs) {
          for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v
        }
      },
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v
      },
      end(chunk?: string | Buffer) {
        headersSent = true
        if (chunk) rawBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
        resolve({ status: statusCode, json: JSON.parse(rawBody || '{}') as Record<string, unknown> })
      },
    } as unknown as ServerResponse

    void handler(req, res, () => resolve({ status: 404, json: {} }))
    if (opts.body !== undefined) {
      queueMicrotask(() => {
        req.emit('data', Buffer.from(JSON.stringify(opts.body), 'utf8'))
        req.emit('end')
      })
    } else {
      queueMicrotask(() => req.emit('end'))
    }
  })
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop()!
    await new Promise<void>((r) => srv.close(() => r()))
  }
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('AI feature contract & Ajv runner (WP-F9)', () => {
  it('validates site/ai-contracts/concept-draft.json v2, full-picture hints without fixed headings, and golden valid/invalid outputs', () => {
    const contract = loadAiContract('concept-draft')
    expect(contract.id).toBe('concept-draft')
    expect(contract.version).toBe(2)

    const zhInst = contract.instructions.zh.join('\n')
    const enInst = contract.instructions.en.join('\n')
    expect(zhInst).toContain('全貌')
    expect(zhInst).toContain('不要机械套用')
    expect(enInst).toContain('hints only')
    expect(enInst).not.toMatch(/\blicence\b|\blicense\b|\bcopyright\b/i)
    expect(contract.schema.required).toContain('related')

    const valid = validateContractOutput<ConceptDraftPayload>(contract, contract.example)
    expect(valid.ok).toBe(true)

    const bad = validateContractOutput<ConceptDraftPayload>(contract, {
      slug: 'BAD SLUG WITH SPACES',
      term: '',
    })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.errors.length).toBeGreaterThan(0)
    }

    // Invalid related rel enum & missing required related
    const ex = contract.example as Record<string, unknown>
    const badRel = validateContractOutput<ConceptDraftPayload>(contract, {
      ...ex,
      related: [{ slug: 'optimistic-concurrency-control', rel: 'invalid-rel' }],
    })
    expect(badRel.ok).toBe(false)
    const { related: _omit, ...withoutRelated } = ex
    expect(validateContractOutput<ConceptDraftPayload>(contract, withoutRelated).ok).toBe(false)
  })

  it('tolerates fenced JSON, logs contract version, and retries ONCE on Ajv errors', async () => {
    const contract = loadAiContract('concept-draft')
    const logs: ContractCallLog[] = []
    let attemptSeen = 0

    // Attempt 1 fails Ajv; attempt 2 returns fenced valid JSON -> passes!
    const recovered = await runAiContract<ConceptDraftPayload>({
      contract,
      companionSystemPrompt: 'Be concise and source-grounded.',
      lang: 'zh',
      taskInput: { selectedTerm: '执行租约' },
      logger: (entry) => logs.push(entry),
      invokeModel: async (req) => {
        attemptSeen++
        expect(req.responseFormat.type).toBe('json_schema')
        if (attemptSeen === 1) {
          return JSON.stringify({ slug: 'BAD_SLUG', term: 'x' })
        }
        expect(req.messages[1]?.content).toContain('/slug')
        return 'Here is the JSON:\n```json\n' + JSON.stringify(contract.example, null, 2) + '\n```'
      },
    })

    expect(recovered.ok).toBe(true)
    if (recovered.ok) {
      expect(recovered.attempts).toBe(2)
      expect(recovered.contractVersion).toBe(2)
      expect(recovered.data.slug).toBe('actuation-lease')
    }
    expect(logs.map((l) => ({ attempt: l.attempt, ok: l.ok, v: l.contractVersion }))).toEqual([
      { attempt: 1, ok: false, v: 2 },
      { attempt: 2, ok: true, v: 2 },
    ])
  })

  it('fails with "格式不符，未写入" after second invalid attempt and dev middleware writes nothing', async () => {
    const mockPort = await new Promise<number>((resolve) => {
      const srv = http.createServer((_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            choices: [{ message: { content: '```json\n{"slug":"INVALID SLUG","term":""}\n```' } }],
          }),
        )
      })
      servers.push(srv)
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as { port: number }
        resolve(addr.port)
      })
    })

    const tmpDocs = makeTempDir('f9-invalid-contract-')
    fs.mkdirSync(path.join(tmpDocs, 'g06'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDocs, 'g06', 'L01.md'),
      '---\ntitle: "第1讲 · 测试"\norder: 1\n---\n\n# 测试\n\n这里包含 测试术语 与 <span class="cite" data-cite="https://example.org">参考</span>。\n',
      'utf8',
    )
    const conceptsDir = path.join(tmpDocs, 'concepts')

    const handler = createDashboardDevHandler({
      token: 'tok-invalid-test',
      docsRoot: tmpDocs,
      conceptsDir,
    })

    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/draft',
      headers: { 'x-lecture-dev-token': 'tok-invalid-test' },
      body: {
        mode: 'create',
        lecturePath: '/g06/L01',
        selectedText: '测试术语',
        lang: 'zh',
        byok: {
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: 'mock-key',
          model: 'mock-model',
        },
      },
    })

    expect(res.status).toBe(422)
    expect(res.json.ok).toBe(false)
    expect(res.json.message).toBe(CONTRACT_INVALID_MESSAGE_ZH)
    expect(fs.existsSync(path.join(conceptsDir, '_drafts'))).toBe(false)
  })

  it('orders the messages: editable system prompt, then locked contract instructions, then the input and the schema', () => {
    const contract = loadAiContract('concept-draft')
    const [system, user] = assembleContractMessages({
      contract,
      companionSystemPrompt: 'EDITABLE-SYSTEM-PROMPT',
      lang: 'zh',
      taskInput: { selectedTerm: 'INPUT-TERM-XYZ' },
    })
    expect(system?.role).toBe('system')
    const systemContent = system!.content
    const editable = systemContent.indexOf('EDITABLE-SYSTEM-PROMPT')
    const locked = systemContent.indexOf('concept-draft v2')
    expect(editable).toBe(0)
    expect(locked).toBeGreaterThan(editable)
    expect(system!.content).toContain(contract.instructions.zh[0]!)
    expect(user?.role).toBe('user')
    expect(user!.content).toContain('INPUT-TERM-XYZ')
    expect(user!.content.indexOf('INPUT-TERM-XYZ')).toBeLessThan(user!.content.indexOf('"required"'))
    expect(system!.content).not.toContain('INPUT-TERM-XYZ')
  })

  it('sends the JSON Schema as structured output and falls back to plain JSON when the endpoint rejects response_format', async () => {
    const contract = loadAiContract('concept-draft')
    const seen: Array<{ hasFormat: boolean }> = []
    const mockPort = await new Promise<number>((resolve) => {
      const srv = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += String(c)))
        req.on('end', () => {
          const parsed = JSON.parse(body) as { response_format?: { type?: string; json_schema?: { schema?: unknown } } }
          seen.push({ hasFormat: Boolean(parsed.response_format) })
          if (parsed.response_format) {
            expect(parsed.response_format.type).toBe('json_schema')
            expect(parsed.response_format.json_schema?.schema).toEqual(contract.schema)
            res.statusCode = 400
            res.end('response_format json_schema is not supported by this model')
            return
          }
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(contract.example) + '\n```' } }] }))
        })
      })
      servers.push(srv)
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port))
    })
    const tmpDocs = makeTempDir('f9-fallback-')
    fs.mkdirSync(path.join(tmpDocs, 'g06'), { recursive: true })
    fs.writeFileSync(path.join(tmpDocs, 'g06', 'L01.md'), '---\ntitle: "第1讲 · 测试"\norder: 1\n---\n\n# 测试\n\n这里包含 测试术语 一次。\n', 'utf8')
    const conceptsDir = path.join(tmpDocs, 'concepts')
    fs.mkdirSync(conceptsDir, { recursive: true })
    fs.writeFileSync(
      path.join(conceptsDir, 'optimistic-concurrency-control.md'),
      '---\ntitle: "乐观并发控制"\nterm: "乐观并发控制"\nenglish: "Optimistic Concurrency Control"\naliases: []\nfield: "并发控制"\ngroups: ["G06"]\nsummary: "校验再提交的并发控制机制。"\nstatus: published\nreviewedAt: "2026-11-21"\ngeneratedBy: "seed"\n---\n\n# 乐观并发控制\n\n（出处：G06-L01）\n',
      'utf8',
    )
    const handler = createDashboardDevHandler({ token: 'tok-fallback', docsRoot: tmpDocs, conceptsDir })
    const res = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/draft',
      headers: { 'x-lecture-dev-token': 'tok-fallback' },
      body: {
        mode: 'create',
        lecturePath: '/g06/L01',
        selectedText: '测试术语',
        lang: 'zh',
        byok: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'mock-key', model: 'mock-model' },
      },
    })
    expect(res.status).toBe(200)
    expect(seen).toEqual([{ hasFormat: true }, { hasFormat: false }])
    expect(res.json.contractVersion).toBe(2)
    expect(fs.existsSync(path.join(conceptsDir, '_drafts', `${String(res.json.slug)}.md`))).toBe(true)
    const written = fs.readFileSync(path.join(conceptsDir, '_drafts', `${String(res.json.slug)}.md`), 'utf8')
    expect(written).toContain('related:')
    expect(written).toContain('optimistic-concurrency-control')
  })

  it('checks before writing on both model path (1 retry then fails) and draftPayload path (rejects without writing, returns unlinked warnings)', async () => {
    const tmpDocs = makeTempDir('k3-checks-')
    fs.mkdirSync(path.join(tmpDocs, 'g06'), { recursive: true })
    fs.writeFileSync(path.join(tmpDocs, 'g06', 'L01.md'), '---\ntitle: "第1讲 · 测试"\norder: 1\n---\n\n# 测试\n\n讨论 边界检查术语 与 既存概念。\n', 'utf8')
    const conceptsDir = path.join(tmpDocs, 'concepts')
    fs.mkdirSync(conceptsDir, { recursive: true })
    fs.writeFileSync(
      path.join(conceptsDir, 'existing-peer.md'),
      '---\ntitle: "既存概念"\nterm: "既存概念"\nenglish: "Existing Peer"\naliases: ["已有别名"]\nfield: "基础"\ngroups: ["G06"]\nsummary: "一个已发布的概念。"\nstatus: published\nreviewedAt: "2026-11-21"\ngeneratedBy: "seed"\n---\n\n# 既存概念\n\n（出处：G06-L01）\n',
      'utf8',
    )
    const handler = createDashboardDevHandler({ token: 'tok-k3-check', docsRoot: tmpDocs, conceptsDir })

    // 1. BYOK draftPayload path: rejects duplicate alias, unknown concept: link, unknown/self related -> writes nothing
    for (const badCase of [
      {
        slug: 'new-dup-alias',
        term: '新词一',
        aliases: ['已有别名'],
        related: [],
        body: '引用 [既存概念](concept:existing-peer)。',
      },
      {
        slug: 'new-bad-link',
        term: '新词二',
        aliases: [],
        related: [],
        body: '链接到 [不存在](concept:missing-slug)。',
      },
      {
        slug: 'new-bad-rel',
        term: '新词三',
        aliases: [],
        related: [{ slug: 'new-bad-rel', rel: 'prerequisite' }],
        body: '自身关联。',
      },
    ]) {
      const rejectRes = await invokeHandler(handler, {
        method: 'POST',
        url: '/__lecture/api/concepts/draft',
        headers: { 'x-lecture-dev-token': 'tok-k3-check' },
        body: {
          mode: 'create',
          lecturePath: '/g06/L01',
          selectedText: badCase.term,
          draftPayload: {
            slug: badCase.slug,
            term: badCase.term,
            english: 'Bad Case',
            aliases: badCase.aliases,
            field: '测试',
            groups: ['G06'],
            summary: '检查失败样例摘要。',
            related: badCase.related,
            paragraphs: [{ heading: '说明', body: badCase.body, sources: ['G06-L01'], verified: true }],
          },
        },
      })
      expect(rejectRes.status, badCase.slug).toBe(422)
      expect(rejectRes.json.message).toBe(CONTRACT_INVALID_MESSAGE_ZH)
      expect((rejectRes.json.errors as string[]).length).toBeGreaterThan(0)
      expect(fs.existsSync(path.join(conceptsDir, '_drafts', `${badCase.slug}.md`))).toBe(false)
    }

    // 2. Unlinked mention emits non-blocking warning and writes draft
    const warnRes = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/draft',
      headers: { 'x-lecture-dev-token': 'tok-k3-check' },
      body: {
        mode: 'create',
        lecturePath: '/g06/L01',
        selectedText: '未链接告警词',
        draftPayload: {
          slug: 'warn-only-concept',
          term: '未链接告警词',
          english: 'Warn Concept',
          aliases: [],
          field: '测试',
          groups: ['G06'],
          summary: '提到既存概念但未写概念链接。',
          related: [],
          paragraphs: [
            {
              heading: '说明',
              body: '这里顺便提到 既存概念 而没有加链接。',
              sources: ['G06-L01'],
              verified: true,
            },
          ],
        },
      },
    })
    expect(warnRes.status).toBe(200)
    expect((warnRes.json.warnings as string[]).some((w) => w.includes('既存概念'))).toBe(true)
    expect(fs.existsSync(path.join(conceptsDir, '_drafts', 'warn-only-concept.md'))).toBe(true)

    // 3. Model path: retries ONCE on K1 check error with error list appended, then recovers cleanly
    let callCount = 0
    const retryPort = await new Promise<number>((resolve) => {
      const srv = http.createServer((req, res) => {
        let reqBody = ''
        req.on('data', (c) => (reqBody += String(c)))
        req.on('end', () => {
          callCount++
          res.setHeader('Content-Type', 'application/json')
          if (callCount === 1) {
            res.end(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        slug: 'retry-concept',
                        term: '重试词条',
                        english: 'Retry Concept',
                        aliases: [],
                        field: '测试',
                        groups: ['G06'],
                        summary: '第一轮带未知链接触发一次重试。',
                        related: [],
                        paragraphs: [
                          {
                            heading: '定义',
                            body: '引用 [坏链](concept:does-not-exist)。',
                            sources: ['G06-L01'],
                            verified: true,
                          },
                        ],
                      }),
                    },
                  },
                ],
              }),
            )
            return
          }
          expect(reqBody).toContain('does-not-exist')
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      slug: 'retry-concept',
                      term: '重试词条',
                      english: 'Retry Concept',
                      aliases: [],
                      field: '测试',
                      groups: ['G06'],
                      summary: '第二轮修正为已知链接后通过检查。',
                      related: [{ slug: 'existing-peer', rel: 'prerequisite' }],
                      paragraphs: [
                        {
                          heading: '定义',
                          body: '依赖 [既存概念](concept:existing-peer)。',
                          sources: ['G06-L01'],
                          verified: true,
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
          )
        })
      })
      servers.push(srv)
      srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port))
    })

    const retried = await invokeHandler(handler, {
      method: 'POST',
      url: '/__lecture/api/concepts/draft',
      headers: { 'x-lecture-dev-token': 'tok-k3-check' },
      body: {
        mode: 'create',
        lecturePath: '/g06/L01',
        selectedText: '重试词条',
        lang: 'zh',
        byok: { baseUrl: `http://127.0.0.1:${retryPort}/v1`, apiKey: 'mock-key', model: 'mock-model' },
      },
    })
    expect(retried.status).toBe(200)
    expect(callCount).toBe(2)
    expect(fs.existsSync(path.join(conceptsDir, '_drafts', 'retry-concept.md'))).toBe(true)
  })

  it('parses valid raw or fenced JSON tolerantly via parseContractJsonResponse', () => {
    const fenced = parseContractJsonResponse('note before\n```json\n{"a":1,"b":"ok"}\n```\nnote after')
    expect(fenced).toEqual({ ok: true, value: { a: 1, b: 'ok' } })
    expect(parseContractJsonResponse('not json at all').ok).toBe(false)
  })
})
