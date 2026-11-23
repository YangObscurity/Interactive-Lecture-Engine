import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PromptAssemblyError,
  actionRequiresSelection,
  assembleDifyChatPayload,
  assembleOpenAiMessages,
  createServerPromptStore,
  resolveServerPromptsPath,
  validateCompanionPrompts,
  type CompanionPromptsFile,
} from '../../src/prompts/companion.js'

const VALID_PROMPTS: CompanionPromptsFile = {
  version: 2,
  system: {
    zh: '只根据当前讲义与选区回答问题，禁止编造。',
    en: 'Answer strictly from the supplied lecture context without guessing.',
  },
  actions: [
    {
      id: 'explain',
      label: { zh: '解释这段', en: 'Explain this passage' },
      template: {
        zh: '讲义 {lecture} ({group}) 小节 {outline} 选区：\n{selection}',
        en: 'Lecture {lecture} ({group}) section {outline} selection:\n{selection}',
      },
      needsSelection: true,
      surfaces: ['panel', 'menu'],
      enabled: true,
    },
    {
      id: 'summarize',
      label: { zh: '总结本节', en: 'Summarise section' },
      template: {
        zh: '总结 {lecture} ({group}) 的 {outline} 小节要点。',
        en: 'Summarise key points of {outline} in {lecture} ({group}).',
      },
      needsSelection: false,
      surfaces: ['panel'],
      enabled: true,
    },
  ],
}

describe('Server companion prompt validation & assembly (WP-F7)', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true })
    }
  })

  it('validates schema rules: version, empty fields, unknown placeholders, lengths, duplicate IDs', () => {
    expect(validateCompanionPrompts(VALID_PROMPTS).ok).toBe(true)

    expect(
      validateCompanionPrompts({ ...VALID_PROMPTS, version: 0 }).errors.join('\n'),
    ).toContain('version must be an integer >= 1')

    expect(
      validateCompanionPrompts({
        ...VALID_PROMPTS,
        system: { zh: '   ', en: 'ok' },
      }).errors.join('\n'),
    ).toContain('system.zh must not be empty')

    expect(
      validateCompanionPrompts({
        ...VALID_PROMPTS,
        actions: [
          {
            id: 'bad_ph',
            label: { zh: '坏', en: 'Bad' },
            template: { zh: 'Hello {unknown_var}', en: 'Hello {lecture}' },
          },
        ],
      }).errors.join('\n'),
    ).toContain('{unknown_var}')

    expect(
      validateCompanionPrompts({
        ...VALID_PROMPTS,
        system: { zh: 'x'.repeat(4001), en: 'ok' },
      }).errors.join('\n'),
    ).toContain('exceeds max length')

    expect(
      validateCompanionPrompts({
        ...VALID_PROMPTS,
        actions: [VALID_PROMPTS.actions[0], VALID_PROMPTS.actions[0]],
      }).errors.join('\n'),
    ).toContain('duplicated')
  })

  it('reads selection requirement from the needsSelection field and defaults missing fields', () => {
    expect(actionRequiresSelection(VALID_PROMPTS.actions[0]!)).toBe(true)
    expect(actionRequiresSelection(VALID_PROMPTS.actions[1]!)).toBe(false)

    const legacy = validateCompanionPrompts({
      version: 1,
      system: VALID_PROMPTS.system,
      actions: [{ id: 'explain', label: VALID_PROMPTS.actions[0]!.label, template: VALID_PROMPTS.actions[0]!.template }],
    })
    expect(legacy.ok).toBe(true)
    expect(legacy.ok && legacy.value.actions[0]).toMatchObject({ needsSelection: true, surfaces: ['panel', 'menu'], enabled: true })
  })

  it('validates needsSelection, surfaces, enabled and the 6-action limit', () => {
    const errorsFor = (patch: Record<string, unknown>) =>
      validateCompanionPrompts({
        ...VALID_PROMPTS,
        actions: [{ ...VALID_PROMPTS.actions[0], ...patch }],
      }).errors.join('\n')

    expect(errorsFor({ needsSelection: false })).toContain('needsSelection must be true')
    expect(errorsFor({ surfaces: [] })).toContain('surfaces must be a non-empty array')
    expect(errorsFor({ surfaces: ['sidebar'] })).toContain('unknown surface')
    expect(errorsFor({ enabled: 'yes' })).toContain('enabled must be a boolean')

    const seven = Array.from({ length: 7 }, (_, i) => ({ ...VALID_PROMPTS.actions[1]!, id: `a${i}` }))
    expect(validateCompanionPrompts({ ...VALID_PROMPTS, actions: seven }).errors.join('\n')).toContain('at most 6')
  })

  it('treats a disabled action as unknown', () => {
    const prompts: CompanionPromptsFile = {
      ...VALID_PROMPTS,
      actions: [{ ...VALID_PROMPTS.actions[1]!, enabled: false }],
    }
    expect(() => assembleOpenAiMessages({ prompts, query: '', actionId: 'summarize' })).toThrowError(/Unknown quick action/)
  })

  it('assembles exactly the golden fixture shared with the site (proxy and BYOK must match)', () => {
    const fixturePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../site/tests/fixtures/prompt-assembly.json')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
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

    for (const c of fixture.cases) {
      const args = { prompts: checked.value, lang: c.lang, query: c.query, actionId: c.action || undefined, inputs: c.inputs }
      if (c.expect.error) {
        expect(() => assembleOpenAiMessages(args), c.name).toThrowError(expect.objectContaining({ code: c.expect.error }))
        expect(() => assembleDifyChatPayload(args), c.name).toThrowError(expect.objectContaining({ code: c.expect.error }))
        continue
      }
      const openai = assembleOpenAiMessages({ ...args, history: c.history })
      expect(openai.messages, c.name).toEqual(c.expect.openai)
      expect(openai.actionId, c.name).toBe(c.expect.actionId)
      const dify = assembleDifyChatPayload(args)
      expect({ query: dify.query, inputs: dify.inputs }, c.name).toEqual(c.expect.dify)
    }
  })

  it('fills placeholders in single pass (no double substitution of user text) and enforces selection / action checks', () => {
    const assembled = assembleOpenAiMessages({
      prompts: VALID_PROMPTS,
      lang: 'en',
      query: '',
      actionId: 'explain',
      inputs: {
        current_lecture: 'G05-L19',
        group: 'G05',
        outline: 'Joins',
        selection: 'literal {lecture} token in SQL note',
      },
    })

    expect(assembled.version).toBe(2)
    expect(assembled.actionId).toBe('explain')
    expect(assembled.messages[0]?.role).toBe('system')
    expect(assembled.messages[0]?.content).toContain(VALID_PROMPTS.system.en)
    expect(assembled.messages[0]?.content).toContain('Lecture: G05-L19')
    expect(assembled.messages[0]?.content).toContain('Group: G05')
    // Must not expand `{lecture}` inside user's selection!
    expect(assembled.messages[1]?.content).toContain('literal {lecture} token in SQL note')
    expect(assembled.messages[1]?.content).toContain('Lecture G05-L19 (G05) section Joins selection:')

    expect(() =>
      assembleOpenAiMessages({
        prompts: VALID_PROMPTS,
        lang: 'en',
        query: '',
        actionId: 'explain',
        inputs: { current_lecture: 'G05-L19', selection: '   ' },
      }),
    ).toThrowError(PromptAssemblyError)

    try {
      assembleDifyChatPayload({
        prompts: VALID_PROMPTS,
        query: '',
        actionId: 'nonexistent',
      })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(PromptAssemblyError)
      expect((e as PromptAssemblyError).code).toBe('unknown_action')
    }
  })

  it('assembles Dify payload with prepended versioned instructions and 4-key inputs whitelist', () => {
    const dify = assembleDifyChatPayload({
      prompts: VALID_PROMPTS,
      lang: 'zh',
      query: '请补充说明',
      actionId: 'summarize',
      inputs: {
        current_lecture: 'L19',
        group: 'G05',
        outline: 'SQL JOIN',
        selection: '',
      },
    })

    expect(dify.query.startsWith('[Site Instructions v2]')).toBe(true)
    expect(dify.query).toContain(VALID_PROMPTS.system.zh)
    expect(dify.query).toContain('[User Request]')
    expect(dify.query).toContain('总结 L19 (G05) 的 SQL JOIN 小节要点。')
    expect(dify.query).toContain('请补充说明')
    expect(dify.inputs).toEqual({
      current_lecture: 'L19',
      group: 'G05',
      outline: 'SQL JOIN',
      selection: '',
    })
  })

  it('resolves prompt path precedence and reloads when file mtime updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lecture-prompts-'))
    dirs.push(dir)
    const serverRoot = join(dir, 'server')
    const sitePrompts = join(dir, 'site', 'prompts')
    mkdirSync(join(serverRoot, 'prompts'), { recursive: true })
    mkdirSync(sitePrompts, { recursive: true })

    const fallbackFile = join(sitePrompts, 'companion.json')
    writeFileSync(fallbackFile, JSON.stringify(VALID_PROMPTS), 'utf8')
    expect(resolveServerPromptsPath(null, { serverRoot, cwd: serverRoot })).toBe(fallbackFile)

    const localFile = join(serverRoot, 'prompts', 'companion.json')
    writeFileSync(localFile, JSON.stringify({ ...VALID_PROMPTS, version: 5 }), 'utf8')
    expect(resolveServerPromptsPath(null, { serverRoot, cwd: serverRoot })).toBe(localFile)

    const store = createServerPromptStore(
      { aiProvider: 'dify', aiPromptsFile: null },
      { serverRoot, cwd: serverRoot },
    )
    expect(store.require().version).toBe(5)
  })
})
