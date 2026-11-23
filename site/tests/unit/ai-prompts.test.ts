import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_PROMPTS } from '../../docs/.vitepress/site.config.mts'
import {
  actionRequiresSelection,
  actionsForSurface,
  assembleDifyChatPayload,
  assembleOpenAiMessages,
  bumpPromptsVersion,
  computePromptsDiffLines,
  validateCompanionPrompts,
  type CompanionPromptsFile,
} from '../../docs/.vitepress/prompts/companion.ts'
import { loadAndValidateSitePrompts } from '../../docs/.vitepress/prompts/load.mts'
import { resolveContent } from '../../docs/.vitepress/content/paths.mts'
import { buildOpenAiChatRequest, type ByokConfig } from '../../docs/.vitepress/theme/components/ai/byokClient'
import { createDashboardDevHandler } from '../../docs/.vitepress/plugins/dashboardDevPlugin.mts'
import { runCli as runConfigCli } from '../../scripts/config/gen.mts'

const SAMPLE_PROMPTS: CompanionPromptsFile = {
  version: 1,
  system: {
    zh: '你是讲义伴读助手，只依据上下文回答。',
    en: 'You are a lecture reading companion. Answer only from context.',
  },
  actions: [
    {
      id: 'explain',
      label: { zh: '解释这段', en: 'Explain this passage' },
      template: {
        zh: '讲义 {lecture}（{group}）小节 {outline} 选文：\n{selection}',
        en: 'Lecture {lecture} ({group}) section {outline} passage:\n{selection}',
      },
      needsSelection: true,
      surfaces: ['panel', 'menu'],
      enabled: true,
    },
    {
      id: 'quiz',
      label: { zh: '出题', en: 'Quiz me' },
      template: {
        zh: '围绕 {lecture} 的 {outline} 出一道题目。',
        en: 'Create one question on {outline} in {lecture}.',
      },
      needsSelection: false,
      surfaces: ['panel'],
      enabled: true,
    },
  ],
}

describe('site-managed AI companion prompts & BYOK parity (WP-F7)', () => {
  const dirs: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env[AI_PROMPTS.envKey]
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  })

  it('validates real site/prompts/companion.json and companion.example.json', () => {
    const live = loadAndValidateSitePrompts()
    expect(live.prompts.version).toBeGreaterThanOrEqual(1)
    expect(live.prompts.actions.length).toBeGreaterThanOrEqual(4)

    const example = loadAndValidateSitePrompts({ configuredPath: resolveContent().promptsExample })
    expect(validateCompanionPrompts(example.prompts).ok).toBe(true)
  })

  it('rejects unknown placeholders, empty templates, and over-long text via schema validator & config:check', () => {
    expect(
      validateCompanionPrompts({
        ...SAMPLE_PROMPTS,
        actions: [
          {
            id: 'bad',
            label: { zh: '坏', en: 'Bad' },
            template: { zh: '包含非法 {unknown_var}', en: 'Valid {lecture}' },
          },
        ],
      }),
    ).toMatchObject({ ok: false })

    expect(
      validateCompanionPrompts({
        ...SAMPLE_PROMPTS,
        actions: [
          {
            id: 'empty',
            label: { zh: '空', en: 'Empty' },
            template: { zh: '   ', en: 'Valid {lecture}' },
          },
        ],
      }),
    ).toMatchObject({ ok: false })

    expect(
      validateCompanionPrompts({
        ...SAMPLE_PROMPTS,
        system: { zh: 'x'.repeat(4001), en: 'ok' },
      }),
    ).toMatchObject({ ok: false })

    const dir = mkdtempSync(join(tmpdir(), 'site-prompts-check-'))
    dirs.push(dir)
    const badPath = join(dir, 'bad.json')
    writeFileSync(
      badPath,
      JSON.stringify({
        ...SAMPLE_PROMPTS,
        actions: [
          {
            id: 'bad',
            label: { zh: '错', en: 'Bad' },
            template: { zh: 'Unknown {not_allowed}', en: 'Ok {lecture}' },
          },
        ],
      }),
      'utf8',
    )
    process.env[AI_PROMPTS.envKey] = badPath
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runConfigCli(['--check'])).toBe(1)
  })

  it('produces identical OpenAI messages between BYOK client and shared assembler (parity)', () => {
    const byokCfg: ByokConfig = {
      enabled: true,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-test-parity',
      model: 'gpt-4o-mini',
      remember: false,
    }
    const inputs = {
      current_lecture: 'G05-L19: Joins',
      group: 'G05: SQL',
      outline: 'LEFT JOIN filtering',
      selection: 'WHERE filters after the join completes',
    }
    const history = [
      { role: 'user' as const, content: '先看外键' },
      { role: 'assistant' as const, content: '外键只做引用校验。' },
    ]

    for (const lang of ['zh', 'en'] as const) {
      const req = buildOpenAiChatRequest(byokCfg, '补充说明差异', inputs, history, {
        actionId: 'explain',
        lang,
        prompts: SAMPLE_PROMPTS,
      })
      const parsed = JSON.parse(String(req.init.body)) as { messages: Array<{ role: string; content: string }> }
      const expected = assembleOpenAiMessages({
        prompts: SAMPLE_PROMPTS,
        lang,
        query: '补充说明差异',
        actionId: 'explain',
        inputs,
        history,
      })
      expect(parsed.messages).toEqual(expected.messages)
      expect(parsed.messages[0]?.content).toContain(SAMPLE_PROMPTS.system[lang])
      expect(parsed.messages[0]?.content).toContain('Lecture: G05-L19: Joins')
      expect(parsed.messages[0]?.content).toContain('Group: G05: SQL')
      expect(parsed.messages[3]?.content).toContain(inputs.selection)
    }

    expect(actionRequiresSelection(SAMPLE_PROMPTS.actions[0]!)).toBe(true)
    expect(actionRequiresSelection(SAMPLE_PROMPTS.actions[1]!)).toBe(false)
  })

  it('BYOK request and Dify payload match the golden fixture the server test also reads', () => {
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, '../fixtures/prompt-assembly.json'), 'utf8'),
    ) as {
      prompts: unknown
      cases: Array<{
        name: string
        lang: 'zh' | 'en'
        action: string
        query: string
        inputs: Record<string, string>
        history: Array<{ role: 'user' | 'assistant'; content: string }>
        expect: { openai?: unknown; dify?: unknown; actionId?: string | null; error?: string }
      }>
    }
    const checked = validateCompanionPrompts(fixture.prompts)
    if (!checked.ok) throw new Error(checked.errors.join('; '))
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20)
    const byokCfg: ByokConfig = { enabled: true, baseUrl: 'https://example.test/v1', apiKey: 'sk-test', model: 'm', remember: false }

    for (const c of fixture.cases) {
      const actionId = c.action || undefined
      if (c.expect.error) {
        expect(() => buildOpenAiChatRequest(byokCfg, c.query, c.inputs, c.history, { actionId, lang: c.lang, prompts: checked.value }), c.name).toThrowError(
          expect.objectContaining({ code: c.expect.error }),
        )
        continue
      }
      const req = buildOpenAiChatRequest(byokCfg, c.query, c.inputs, c.history, { actionId, lang: c.lang, prompts: checked.value })
      const sent = JSON.parse(String(req.init.body)) as { messages: unknown }
      expect(sent.messages, c.name).toEqual(c.expect.openai)
      const dify = assembleDifyChatPayload({ prompts: checked.value, lang: c.lang, query: c.query, actionId, inputs: c.inputs })
      expect({ query: dify.query, inputs: dify.inputs }, c.name).toEqual(c.expect.dify)
    }
  })

  it('validates needsSelection, surfaces, enabled, the 6-action limit and filters actions per surface', () => {
    const errorsFor = (patch: Record<string, unknown>) =>
      validateCompanionPrompts({ ...SAMPLE_PROMPTS, actions: [{ ...SAMPLE_PROMPTS.actions[0], ...patch }] }).errors.join('\n')
    expect(errorsFor({ needsSelection: false })).toContain('needsSelection must be true')
    expect(errorsFor({ surfaces: [] })).toContain('surfaces must be a non-empty array')
    expect(errorsFor({ surfaces: ['sidebar'] })).toContain('unknown surface')
    expect(errorsFor({ enabled: 'yes' })).toContain('enabled must be a boolean')
    const seven = Array.from({ length: 7 }, (_, i) => ({ ...SAMPLE_PROMPTS.actions[1]!, id: `a${i}` }))
    expect(validateCompanionPrompts({ ...SAMPLE_PROMPTS, actions: seven }).errors.join('\n')).toContain('at most 6')

    const mixed: CompanionPromptsFile = {
      ...SAMPLE_PROMPTS,
      actions: [
        SAMPLE_PROMPTS.actions[0]!,
        SAMPLE_PROMPTS.actions[1]!,
        { ...SAMPLE_PROMPTS.actions[1]!, id: 'off', enabled: false },
      ],
    }
    expect(actionsForSurface(mixed, 'panel').map((a) => a.id)).toEqual(['explain', 'quiz'])
    expect(actionsForSurface(mixed, 'menu').map((a) => a.id)).toEqual(['explain'])

    // Defaults for files written before these fields existed, and a lossless clone / version bump
    const legacy = validateCompanionPrompts({
      version: 1,
      system: SAMPLE_PROMPTS.system,
      actions: [{ id: 'quiz', label: SAMPLE_PROMPTS.actions[1]!.label, template: SAMPLE_PROMPTS.actions[1]!.template }],
    })
    expect(legacy.ok && legacy.value.actions[0]).toMatchObject({ needsSelection: false, surfaces: ['panel', 'menu'], enabled: true })
    expect(bumpPromptsVersion(mixed).actions).toEqual(mixed.actions)
  })

  it('computes line diffs and bumps version monotonically in dashboardDevPlugin GET/POST /prompts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-prompts-api-'))
    dirs.push(dir)
    const promptFile = join(dir, 'companion.json')
    writeFileSync(promptFile, JSON.stringify(SAMPLE_PROMPTS, null, 2), 'utf8')

    const handler = createDashboardDevHandler({
      token: 'dev-secret-token',
      allowNonLoopbackForTests: true,
      promptsFilePath: promptFile,
    })

    const invoke = (opts: { method: string; url: string; headers?: Record<string, string>; body?: string }) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = new EventEmitter() as IncomingMessage & EventEmitter
        req.method = opts.method
        req.url = opts.url
        req.headers = { host: '127.0.0.1:5173', ...(opts.headers || {}) }
        req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket']

        let status = 200
        let raw = ''
        const res = {
          writeHead(code: number) {
            status = code
            return this
          },
          end(chunk?: string) {
            if (chunk) raw += String(chunk)
            resolve({ status, body: raw })
          },
        } as unknown as ServerResponse

        void handler(req, res, () => resolve({ status: 404, body: '' }))
        process.nextTick(() => {
          if (opts.body) req.emit('data', Buffer.from(opts.body, 'utf8'))
          req.emit('end')
        })
      })

    const getRes = await invoke({ method: 'GET', url: '/__lecture/api/prompts' })
    expect(getRes.status).toBe(200)
    expect((JSON.parse(getRes.body) as { prompts: CompanionPromptsFile }).prompts.version).toBe(1)

    // Missing CSRF token -> 403
    const noTokenRes = await invoke({
      method: 'POST',
      url: '/__lecture/api/prompts',
      body: JSON.stringify(SAMPLE_PROMPTS),
    })
    expect(noTokenRes.status).toBe(403)

    // Invalid schema -> 400 and disk file unchanged
    const badSave = await invoke({
      method: 'POST',
      url: '/__lecture/api/prompts',
      headers: { 'x-lecture-dev-token': 'dev-secret-token' },
      body: JSON.stringify({
        prompts: {
          ...SAMPLE_PROMPTS,
          actions: [
            {
              id: 'oops',
              label: { zh: '坏', en: 'Bad' },
              template: { zh: 'bad {nope}', en: 'ok' },
            },
          ],
        },
      }),
    })
    expect(badSave.status).toBe(400)
    expect((JSON.parse(readFileSync(promptFile, 'utf8')) as CompanionPromptsFile).version).toBe(1)

    // Valid edit + diff check + version bump 1 -> 2
    const edited = {
      ...SAMPLE_PROMPTS,
      system: { zh: '更新后的站内系统提示词。', en: 'Updated system prompt.' },
    }
    const bumpedPreview = bumpPromptsVersion(edited, SAMPLE_PROMPTS.version)
    expect(bumpedPreview.version).toBe(2)
    const diff = computePromptsDiffLines(SAMPLE_PROMPTS, bumpedPreview)
    expect(diff.some((l) => l.type === 'del' && l.text.includes('"version": 1'))).toBe(true)
    expect(diff.some((l) => l.type === 'add' && l.text.includes('"version": 2'))).toBe(true)

    const okSave = await invoke({
      method: 'POST',
      url: '/__lecture/api/prompts',
      headers: { 'x-lecture-dev-token': 'dev-secret-token' },
      body: JSON.stringify({ prompts: edited }),
    })
    expect(okSave.status).toBe(200)
    const okParsed = JSON.parse(okSave.body) as { ok: boolean; prompts: CompanionPromptsFile }
    expect(okParsed.ok).toBe(true)
    expect(okParsed.prompts.version).toBe(2)
    expect((JSON.parse(readFileSync(promptFile, 'utf8')) as CompanionPromptsFile).version).toBe(2)
  })
})
