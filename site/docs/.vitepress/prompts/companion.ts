/**
 * companion.ts — Pure schema validator, template renderer, prompt assembler, and line diff helper
 * for site-managed AI companion prompts (WP-F7).
 *
 * ZERO Node builtins, ZERO DOM assumptions, erasable TypeScript syntax only:
 * runs identically in Node CLI tools (`config:check`, `doctor`), Vite plugins, and browser BYOK.
 * The assembly half is duplicated in `server/src/prompts/companion.ts` (the server package cannot import from the site);
 * `site/tests/fixtures/prompt-assembly.json` is the golden fixture both unit suites read, so the copies cannot drift.
 */

export const PROMPT_LANGUAGES = ['zh', 'en'] as const
export type PromptLang = (typeof PROMPT_LANGUAGES)[number]

export const ALLOWED_PROMPT_PLACEHOLDERS = ['lecture', 'group', 'outline', 'selection'] as const
export type PromptPlaceholder = (typeof ALLOWED_PROMPT_PLACEHOLDERS)[number]

export const PROMPT_LIMITS = {
  maxSystemChars: 4000,
  maxActionIdChars: 32,
  maxActionLabelChars: 40,
  maxActionTemplateChars: 2000,
  minActions: 1,
  maxActions: 6,
} as const

export const ACTION_ID_RE = /^[a-z][a-z0-9_-]*$/
const PLACEHOLDER_TOKEN_RE = /\{([^{}]*)\}/g
const ALLOWED_PLACEHOLDER_SET: ReadonlySet<string> = new Set(ALLOWED_PROMPT_PLACEHOLDERS)
/** Legacy 'no selection' labels some clients still send; treated as an empty selection (same list on server and site). */
const SELECTION_SENTINELS: ReadonlySet<string> = new Set(['无', 'None'])

export interface LocalizedPromptText {
  zh: string
  en: string
}

export const QUICK_ACTION_SURFACES = ['panel', 'menu'] as const
export type QuickActionSurface = (typeof QUICK_ACTION_SURFACES)[number]

export interface QuickActionSpec {
  id: string
  label: LocalizedPromptText
  template: LocalizedPromptText
  /** The action only makes sense with a selected passage (the template uses `{selection}`). */
  needsSelection: boolean
  /** Where readers see it: the companion panel input area, the text-selection menu, or both. */
  surfaces: QuickActionSurface[]
  /** Disabled actions are hidden from readers and rejected by the server. */
  enabled: boolean
}

export interface CompanionPromptsFile {
  version: number
  system: LocalizedPromptText
  actions: QuickActionSpec[]
}

export interface PromptValidationSuccess {
  ok: true
  value: CompanionPromptsFile
  errors: []
}

export interface PromptValidationFailure {
  ok: false
  errors: string[]
}

export type PromptValidationResult = PromptValidationSuccess | PromptValidationFailure

export interface PromptAssemblyInputs {
  current_lecture?: string
  group?: string
  outline?: string
  selection?: string
}

export interface NormalizedPromptInputs {
  current_lecture: string
  group: string
  outline: string
  selection: string
}

export interface OpenAiHistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type PromptAssemblyErrorCode = 'unknown_action' | 'selection_required' | 'empty_query'

export class PromptAssemblyError extends Error {
  readonly code: PromptAssemblyErrorCode

  constructor(code: PromptAssemblyErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'PromptAssemblyError'
    this.code = code
  }
}

export interface AssembledOpenAiChat {
  messages: OpenAiMessage[]
  version: number
  actionId: string | null
  userContent: string
}

export interface AssembledDifyChat {
  query: string
  inputs: PromptAssemblyInputs
  version: number
  actionId: string | null
}

export interface DiffLine {
  type: 'ctx' | 'del' | 'add'
  text: string
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function findUnknownPlaceholders(text: string): string[] {
  const bad: string[] = []
  const re = new RegExp(PLACEHOLDER_TOKEN_RE.source, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const token = match[1] ?? ''
    if (!ALLOWED_PLACEHOLDER_SET.has(token)) {
      bad.push(`{${token}}`)
    }
  }
  return bad
}

function validateLocalizedField(
  raw: unknown,
  path: string,
  maxChars: number,
  checkPlaceholders: boolean,
  errors: string[],
): LocalizedPromptText | null {
  if (!isPlainRecord(raw)) {
    errors.push(`${path} must be an object with zh and en strings`)
    return null
  }
  const out: Partial<LocalizedPromptText> = {}
  for (const lang of PROMPT_LANGUAGES) {
    const val = raw[lang]
    if (typeof val !== 'string') {
      errors.push(`${path}.${lang} must be a string`)
      continue
    }
    const trimmed = val.trim()
    if (!trimmed) {
      errors.push(`${path}.${lang} must not be empty`)
      continue
    }
    if (trimmed.length > maxChars) {
      errors.push(`${path}.${lang} exceeds max length (${trimmed.length} > ${maxChars})`)
    }
    if (checkPlaceholders) {
      const unknown = findUnknownPlaceholders(trimmed)
      if (unknown.length > 0) {
        errors.push(
          `${path}.${lang} uses unknown placeholder(s) ${unknown.join(', ')} (allowed: ${ALLOWED_PROMPT_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')})`,
        )
      }
    }
    out[lang] = trimmed
  }
  if (typeof out.zh === 'string' && typeof out.en === 'string') {
    return { zh: out.zh, en: out.en }
  }
  return null
}

export function validateCompanionPrompts(raw: unknown): PromptValidationResult {
  const errors: string[] = []
  if (!isPlainRecord(raw)) {
    return { ok: false, errors: ['Prompt config must be a JSON object'] }
  }

  const rawVersion = raw.version
  if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 1) {
    errors.push('version must be an integer >= 1')
  }

  const system = validateLocalizedField(raw.system, 'system', PROMPT_LIMITS.maxSystemChars, true, errors)

  const actions: QuickActionSpec[] = []
  if (!Array.isArray(raw.actions)) {
    errors.push('actions must be an array')
  } else {
    if (raw.actions.length < PROMPT_LIMITS.minActions) {
      errors.push(`actions must contain at least ${PROMPT_LIMITS.minActions} item(s)`)
    }
    if (raw.actions.length > PROMPT_LIMITS.maxActions) {
      errors.push(`actions must contain at most ${PROMPT_LIMITS.maxActions} items (got ${raw.actions.length})`)
    }

    const seenIds = new Set<string>()
    for (let i = 0; i < raw.actions.length; i++) {
      const item = raw.actions[i]
      const itemPath = `actions[${i}]`
      if (!isPlainRecord(item)) {
        errors.push(`${itemPath} must be an object`)
        continue
      }
      const rawId = item.id
      let validId = ''
      if (typeof rawId !== 'string' || !rawId.trim()) {
        errors.push(`${itemPath}.id must be a non-empty string`)
      } else {
        const id = rawId.trim()
        if (id.length > PROMPT_LIMITS.maxActionIdChars) {
          errors.push(`${itemPath}.id exceeds max length (${id.length} > ${PROMPT_LIMITS.maxActionIdChars})`)
        } else if (!ACTION_ID_RE.test(id)) {
          errors.push(`${itemPath}.id "${id}" must match ${ACTION_ID_RE.source}`)
        } else if (seenIds.has(id)) {
          errors.push(`${itemPath}.id "${id}" is duplicated`)
        } else {
          seenIds.add(id)
          validId = id
        }
      }

      const label = validateLocalizedField(
        item.label,
        `${itemPath}.label`,
        PROMPT_LIMITS.maxActionLabelChars,
        false,
        errors,
      )
      const template = validateLocalizedField(
        item.template,
        `${itemPath}.template`,
        PROMPT_LIMITS.maxActionTemplateChars,
        true,
        errors,
      )

      const rawNeeds = item.needsSelection
      let needsSelection = template ? template.zh.includes('{selection}') || template.en.includes('{selection}') : false
      if (rawNeeds !== undefined) {
        if (typeof rawNeeds !== 'boolean') {
          errors.push(`${itemPath}.needsSelection must be a boolean`)
        } else {
          if (!rawNeeds && needsSelection) {
            errors.push(`${itemPath}.needsSelection must be true because the template uses {selection}`)
          }
          needsSelection = rawNeeds
        }
      }

      let surfaces: QuickActionSurface[] = [...QUICK_ACTION_SURFACES]
      const rawSurfaces = item.surfaces
      if (rawSurfaces !== undefined) {
        const picked: QuickActionSurface[] = []
        if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
          errors.push(`${itemPath}.surfaces must be a non-empty array of ${QUICK_ACTION_SURFACES.join(', ')}`)
        } else {
          for (const s of rawSurfaces) {
            const surface = QUICK_ACTION_SURFACES.find((known) => known === s)
            if (!surface) {
              errors.push(`${itemPath}.surfaces contains unknown surface ${JSON.stringify(s)} (allowed: ${QUICK_ACTION_SURFACES.join(', ')})`)
            } else if (!picked.includes(surface)) {
              picked.push(surface)
            }
          }
          surfaces = picked
        }
      }

      let enabled = true
      const rawEnabled = item.enabled
      if (rawEnabled !== undefined) {
        if (typeof rawEnabled !== 'boolean') {
          errors.push(`${itemPath}.enabled must be a boolean`)
        } else {
          enabled = rawEnabled
        }
      }

      if (validId && label && template) {
        actions.push({ id: validId, label, template, needsSelection, surfaces, enabled })
      }
    }
  }

  if (errors.length > 0 || !system || typeof rawVersion !== 'number') {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      version: rawVersion,
      system,
      actions,
    },
    errors: [],
  }
}

export function normalizePromptLang(rawLang?: string): PromptLang {
  if (typeof rawLang === 'string' && rawLang.toLowerCase().startsWith('en')) {
    return 'en'
  }
  return 'zh'
}

export function actionRequiresSelection(action: Pick<QuickActionSpec, 'needsSelection'>): boolean {
  return action.needsSelection
}

/** Actions a reader may use on one surface: enabled and listed for it, in file order. */
export function actionsForSurface(
  prompts: Pick<CompanionPromptsFile, 'actions'>,
  surface: QuickActionSurface,
): QuickActionSpec[] {
  return prompts.actions.filter((a) => a.enabled && a.surfaces.includes(surface))
}

export function normalizePromptInputs(inputs?: PromptAssemblyInputs): NormalizedPromptInputs {
  const lecture = typeof inputs?.current_lecture === 'string' ? inputs.current_lecture.trim() : ''
  const group = typeof inputs?.group === 'string' ? inputs.group.trim() : ''
  const outline = typeof inputs?.outline === 'string' ? inputs.outline.trim() : ''
  let selection = typeof inputs?.selection === 'string' ? inputs.selection.trim() : ''
  if (selection && SELECTION_SENTINELS.has(selection)) {
    selection = ''
  }
  return {
    current_lecture: lecture,
    group,
    outline,
    selection,
  }
}

export function renderPromptTemplate(template: string, inputs: NormalizedPromptInputs): string {
  return template
    .replace(/\{(lecture|group|outline|selection)\}/g, (_full, key: PromptPlaceholder) => {
      if (key === 'lecture') return inputs.current_lecture
      if (key === 'group') return inputs.group
      if (key === 'outline') return inputs.outline
      return inputs.selection
    })
    .trim()
}

function buildContextBlock(inputs: NormalizedPromptInputs): string[] {
  const parts: string[] = []
  if (inputs.current_lecture) parts.push(`Lecture: ${inputs.current_lecture}`)
  if (inputs.group) parts.push(`Group: ${inputs.group}`)
  if (inputs.outline) parts.push(`Context:\n${inputs.outline}`)
  if (inputs.selection) parts.push(`Selection:\n${inputs.selection}`)
  return parts
}

function resolveActionAndUserText(options: {
  prompts: CompanionPromptsFile
  lang?: PromptLang
  query: string
  actionId?: string
  inputs?: PromptAssemblyInputs
}): {
  lang: PromptLang
  cleanInputs: NormalizedPromptInputs
  systemText: string
  action: QuickActionSpec | null
  userText: string
} {
  const lang = normalizePromptLang(options.lang)
  const cleanInputs = normalizePromptInputs(options.inputs)
  const cleanQuery = options.query.trim()
  const rawActionId = typeof options.actionId === 'string' ? options.actionId.trim() : ''

  let action: QuickActionSpec | null = null
  if (rawActionId !== '') {
    action = options.prompts.actions.find((a) => a.id === rawActionId && a.enabled) ?? null
    if (!action) {
      throw new PromptAssemblyError('unknown_action', `Unknown quick action: ${rawActionId}`)
    }
    if (actionRequiresSelection(action) && !cleanInputs.selection) {
      throw new PromptAssemblyError('selection_required', `Action "${action.id}" requires non-empty selection`)
    }
  } else if (!cleanQuery) {
    throw new PromptAssemblyError('empty_query', 'Query must not be empty when no action is selected')
  }

  const systemText = renderPromptTemplate(options.prompts.system[lang], cleanInputs)
  let userText: string
  if (action) {
    const renderedAction = renderPromptTemplate(action.template[lang], cleanInputs)
    userText = cleanQuery ? `${renderedAction}\n\n${cleanQuery}` : renderedAction
  } else {
    userText = cleanQuery
  }

  return { lang, cleanInputs, systemText, action, userText }
}

/**
 * Assemble OpenAI-compatible `messages[]` identically for server proxy (`AI_PROVIDER=openai`)
 * and browser BYOK (`byokClient.ts`).
 */
export function assembleOpenAiMessages(options: {
  prompts: CompanionPromptsFile
  lang?: PromptLang
  query: string
  actionId?: string
  inputs?: PromptAssemblyInputs
  history?: readonly OpenAiHistoryTurn[]
}): AssembledOpenAiChat {
  const { cleanInputs, systemText, action, userText } = resolveActionAndUserText(options)
  const messages: OpenAiMessage[] = []
  const systemParts = [systemText, ...buildContextBlock(cleanInputs)].filter((s) => s.length > 0)
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') })
  }

  for (const turn of (options.history ?? []).slice(-8)) {
    if (turn.content.trim()) {
      messages.push({ role: turn.role, content: turn.content })
    }
  }

  messages.push({ role: 'user', content: userText })

  return {
    messages,
    version: options.prompts.version,
    actionId: action ? action.id : null,
    userContent: userText,
  }
}

/**
 * Assemble Dify `/chat-messages` payload: prepends the site-owned versioned instruction block
 * to `query` while preserving the 4-key `inputs` whitelist.
 */
export function assembleDifyChatPayload(options: {
  prompts: CompanionPromptsFile
  lang?: PromptLang
  query: string
  actionId?: string
  inputs?: PromptAssemblyInputs
}): AssembledDifyChat {
  const { systemText, action, userText } = resolveActionAndUserText(options)
  const whitelistedInputs: PromptAssemblyInputs = {}
  if (options.inputs) {
    if (typeof options.inputs.current_lecture === 'string') {
      whitelistedInputs.current_lecture = options.inputs.current_lecture
    }
    if (typeof options.inputs.group === 'string') {
      whitelistedInputs.group = options.inputs.group
    }
    if (typeof options.inputs.outline === 'string') {
      whitelistedInputs.outline = options.inputs.outline
    }
    if (typeof options.inputs.selection === 'string') {
      whitelistedInputs.selection = options.inputs.selection
    }
  }

  const query = `[Site Instructions v${options.prompts.version}]\n${systemText}\n\n[User Request]\n${userText}`
  return {
    query,
    inputs: whitelistedInputs,
    version: options.prompts.version,
    actionId: action ? action.id : null,
  }
}

/** Deep copy of a prompts file; copies every field, so new fields cannot be lost on a round trip. */
export function clonePrompts(src: CompanionPromptsFile): CompanionPromptsFile {
  return {
    version: src.version,
    system: { ...src.system },
    actions: src.actions.map((a) => ({
      id: a.id,
      label: { ...a.label },
      template: { ...a.template },
      needsSelection: a.needsSelection,
      surfaces: [...a.surfaces],
      enabled: a.enabled,
    })),
  }
}

export function bumpPromptsVersion(
  prompts: CompanionPromptsFile,
  previousVersion?: number,
): CompanionPromptsFile {
  const base = typeof previousVersion === 'number' && previousVersion >= prompts.version
    ? previousVersion
    : prompts.version
  return { ...clonePrompts(prompts), version: base + 1 }
}

export function computePromptsDiffLines(
  prev: CompanionPromptsFile | null,
  next: CompanionPromptsFile,
): DiffLine[] {
  const oldLines = prev ? JSON.stringify(prev, null, 2).split('\n') : []
  const newLines = JSON.stringify(next, null, 2).split('\n')
  const n = oldLines.length
  const m = newLines.length

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
      }
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: 'ctx', text: oldLines[i]! })
      i++
      j++
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ type: 'del', text: oldLines[i]! })
      i++
    } else {
      out.push({ type: 'add', text: newLines[j]! })
      j++
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: oldLines[i]! })
    i++
  }
  while (j < m) {
    out.push({ type: 'add', text: newLines[j]! })
    j++
  }
  return out
}
