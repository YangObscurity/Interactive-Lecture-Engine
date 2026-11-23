/**
 * prompts/contracts.ts - Generic AI feature contract runner (WP-F9 / plan_v2_ai_oss_reuse.md §7).
 *
 * Works both on the Node dev middleware and inside the browser (BYOK):
 *   - Assembles: editable companion system prompt + locked contract instructions + input context
 *   - Passes OpenAI JSON Schema `response_format` when supported
 *   - Parses raw or markdown-fenced JSON responses tolerantly
 *   - Validates strictly with Ajv against `contract.schema`
 *   - Retries ONCE with Ajv validation errors before failing with "格式不符，未写入" (writes nothing)
 *   - Emits contract id + version log per call
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'

export interface LocalizedText {
  zh: string
  en: string
}

export interface LocalizedList {
  zh: string[]
  en: string[]
}

export interface AiFeatureContract {
  id: string
  version: number
  purpose: LocalizedText
  instructions: LocalizedList
  schema: Record<string, unknown>
  example: Record<string, unknown>
}

export interface ContractCallLog {
  contractId: string
  contractVersion: number
  attempt: 1 | 2
  ok: boolean
  errors?: string[]
}

export interface ContractMessage {
  role: 'system' | 'user'
  content: string
}

export interface ContractModelRequest {
  contractId: string
  contractVersion: number
  attempt: 1 | 2
  messages: ContractMessage[]
  responseFormat: {
    type: 'json_schema'
    json_schema: {
      name: string
      strict: boolean
      schema: Record<string, unknown>
    }
  }
}

export type ContractRunResult<T> =
  | {
      ok: true
      data: T
      contractId: string
      contractVersion: number
      attempts: 1 | 2
    }
  | {
      ok: false
      errorCode: 'SCHEMA_INVALID' | 'MODEL_ERROR'
      message: string
      errors: string[]
      contractId: string
      contractVersion: number
      attempts: 1 | 2
      rawOutput?: string
    }

const ajvInstance = new Ajv({
  allErrors: true,
  strict: false,
})

const validatorCache = new Map<string, ValidateFunction>()

export const CONTRACT_INVALID_MESSAGE_ZH = '格式不符，未写入'
export const CONTRACT_INVALID_MESSAGE_EN = 'Output did not match contract schema; nothing was written'

export function isValidAiContract(raw: unknown): raw is AiFeatureContract {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id.trim()) return false
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version) || obj.version < 1) return false
  const purpose = obj.purpose as Record<string, unknown> | undefined
  if (!purpose || typeof purpose.zh !== 'string' || typeof purpose.en !== 'string') return false
  const inst = obj.instructions as Record<string, unknown> | undefined
  if (
    !inst ||
    !Array.isArray(inst.zh) ||
    !Array.isArray(inst.en) ||
    inst.zh.length === 0 ||
    inst.en.length === 0
  ) {
    return false
  }
  if (!obj.schema || typeof obj.schema !== 'object' || Array.isArray(obj.schema)) return false
  if (!obj.example || typeof obj.example !== 'object' || Array.isArray(obj.example)) return false
  return true
}

function getValidator(contract: AiFeatureContract): ValidateFunction {
  const key = `${contract.id}@${contract.version}`
  let fn = validatorCache.get(key)
  if (!fn) {
    fn = ajvInstance.compile(contract.schema)
    validatorCache.set(key, fn)
  }
  return fn
}

export function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return ['Unknown schema validation error']
  return errors.map((e) => {
    const loc = e.instancePath ? e.instancePath : '/'
    const msg = e.message ?? 'invalid value'
    const extra = e.params && Object.keys(e.params).length > 0 ? ` (${JSON.stringify(e.params)})` : ''
    return `${loc}: ${msg}${extra}`
  })
}

export function validateContractOutput<T>(
  contract: AiFeatureContract,
  candidate: unknown,
): { ok: true; data: T } | { ok: false; errors: string[] } {
  const validate = getValidator(contract)
  if (validate(candidate)) {
    return { ok: true, data: candidate as T }
  }
  return { ok: false, errors: formatAjvErrors(validate.errors) }
}

/** Extract JSON object/array tolerating ```json fences or surrounding explanatory text. */
export function parseContractJsonResponse(rawText: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = (rawText ?? '').trim()
  if (!trimmed) {
    return { ok: false, error: 'Empty model output' }
  }

  const candidates: string[] = [trimmed]

  const fenceRe = /```(?:json|JSON)?\s*\r?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(trimmed)) !== null) {
    if (match[1]?.trim()) candidates.push(match[1].trim())
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1))
  }

  for (const cand of candidates) {
    try {
      return { ok: true, value: JSON.parse(cand) as unknown }
    } catch {
      // try next candidate
    }
  }
  return { ok: false, error: 'Response is not valid JSON' }
}

export interface AssembleContractMessagesOptions {
  contract: AiFeatureContract
  companionSystemPrompt: string
  lang: 'zh' | 'en'
  taskInput: Record<string, unknown>
  validationErrors?: readonly string[]
  previousOutput?: string
}

export function assembleContractMessages(opts: AssembleContractMessagesOptions): ContractMessage[] {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const rules = opts.contract.instructions[lang].map((line, i) => `${i + 1}. ${line}`).join('\n')

  const systemParts: string[] = []
  const companionSys = (opts.companionSystemPrompt ?? '').trim()
  if (companionSys) {
    systemParts.push(companionSys)
  }
  systemParts.push(
    lang === 'en'
      ? `[Locked Feature Contract: ${opts.contract.id} v${opts.contract.version}]\nPurpose: ${opts.contract.purpose.en}\nMandatory rules:\n${rules}`
      : `[锁定功能契约: ${opts.contract.id} v${opts.contract.version}]\n职责: ${opts.contract.purpose.zh}\n强制约束:\n${rules}`,
  )

  const inputJson = JSON.stringify(opts.taskInput, null, 2)
  const schemaJson = JSON.stringify(opts.contract.schema)

  const userLines: string[] = [
    lang === 'en' ? `Context & Task Input:\n${inputJson}` : `上下文与任务输入:\n${inputJson}`,
    lang === 'en' ? `Target JSON Schema:\n${schemaJson}` : `输出 JSON Schema:\n${schemaJson}`,
  ]

  if (opts.validationErrors && opts.validationErrors.length > 0) {
    const errText = opts.validationErrors.map((e) => `- ${e}`).join('\n')
    const prevSnippet = opts.previousOutput ? `\nPrevious invalid output:\n${opts.previousOutput.slice(0, 1200)}` : ''
    userLines.push(
      lang === 'en'
        ? `Your previous output failed validation. Fix ALL errors and return ONLY valid JSON:\n${errText}${prevSnippet}`
        : `上一次输出未通过校验。请逐条修正以下错误并只返回合规 JSON：\n${errText}${prevSnippet}`,
    )
  }

  return [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: userLines.join('\n\n') },
  ]
}

export function buildStructuredResponseFormat(contract: AiFeatureContract): ContractModelRequest['responseFormat'] {
  return {
    type: 'json_schema',
    json_schema: {
      name: `${contract.id}_v${contract.version}`,
      strict: false,
      schema: contract.schema,
    },
  }
}

export type ContractSemanticValidator<T> = (data: T) => { ok: true } | { ok: false; errors: string[] }

export interface RunAiContractOptions<T = unknown> {
  contract: AiFeatureContract
  companionSystemPrompt: string
  lang: 'zh' | 'en'
  taskInput: Record<string, unknown>
  invokeModel: (req: ContractModelRequest) => Promise<string>
  validateData?: ContractSemanticValidator<T>
  logger?: (entry: ContractCallLog) => void
}

export async function runAiContract<T>(opts: RunAiContractOptions<T>): Promise<ContractRunResult<T>> {
  const log = opts.logger ?? ((entry: ContractCallLog) => {
    console.warn(
      `[ai-contract] id=${entry.contractId} v=${entry.contractVersion} attempt=${entry.attempt} ok=${entry.ok}`,
      entry.errors && entry.errors.length > 0 ? entry.errors : '',
    )
  })
  const invalidMsg = opts.lang === 'en' ? CONTRACT_INVALID_MESSAGE_EN : CONTRACT_INVALID_MESSAGE_ZH
  const responseFormat = buildStructuredResponseFormat(opts.contract)

  let lastErrors: string[] = []
  let lastRaw = ''

  for (const attempt of [1, 2] as const) {
    const messages = assembleContractMessages({
      contract: opts.contract,
      companionSystemPrompt: opts.companionSystemPrompt,
      lang: opts.lang,
      taskInput: opts.taskInput,
      validationErrors: attempt === 2 ? lastErrors : undefined,
      previousOutput: attempt === 2 ? lastRaw : undefined,
    })

    let rawText = ''
    try {
      rawText = await opts.invokeModel({
        contractId: opts.contract.id,
        contractVersion: opts.contract.version,
        attempt,
        messages,
        responseFormat,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log({
        contractId: opts.contract.id,
        contractVersion: opts.contract.version,
        attempt,
        ok: false,
        errors: [msg],
      })
      return {
        ok: false,
        errorCode: 'MODEL_ERROR',
        message: msg,
        errors: [msg],
        contractId: opts.contract.id,
        contractVersion: opts.contract.version,
        attempts: attempt,
      }
    }

    lastRaw = rawText
    const parsed = parseContractJsonResponse(rawText)
    if (!parsed.ok) {
      lastErrors = ['error' in parsed ? parsed.error : 'Invalid JSON output']
      log({
        contractId: opts.contract.id,
        contractVersion: opts.contract.version,
        attempt,
        ok: false,
        errors: lastErrors,
      })
      continue
    }

    const validated = validateContractOutput<T>(opts.contract, parsed.value)
    if (validated.ok) {
      const semantic = opts.validateData ? opts.validateData(validated.data) : { ok: true as const }
      if (semantic.ok) {
        log({
          contractId: opts.contract.id,
          contractVersion: opts.contract.version,
          attempt,
          ok: true,
        })
        return {
          ok: true,
          data: validated.data,
          contractId: opts.contract.id,
          contractVersion: opts.contract.version,
          attempts: attempt,
        }
      }
      lastErrors = 'errors' in semantic ? semantic.errors : ['Validation failed']
      log({
        contractId: opts.contract.id,
        contractVersion: opts.contract.version,
        attempt,
        ok: false,
        errors: lastErrors,
      })
      continue
    }

    lastErrors = 'errors' in validated ? validated.errors : ['Schema validation failed']
    log({
      contractId: opts.contract.id,
      contractVersion: opts.contract.version,
      attempt,
      ok: false,
      errors: lastErrors,
    })
  }

  return {
    ok: false,
    errorCode: 'SCHEMA_INVALID',
    message: invalidMsg,
    errors: lastErrors,
    contractId: opts.contract.id,
    contractVersion: opts.contract.version,
    attempts: 2,
    rawOutput: lastRaw,
  }
}
