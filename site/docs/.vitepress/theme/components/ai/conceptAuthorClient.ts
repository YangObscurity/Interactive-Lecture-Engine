/**
 * conceptAuthorClient.ts - Browser client for local Author Mode concept workflows.
 *
 * Online production mode never probes dev endpoints (returns `isLocalAuthor: false` immediately).
 */
import { normalizePromptLang } from '../../../prompts/companion.ts'
import type { AiFeatureContract, ContractRunResult } from '../../../prompts/contracts.ts'
import type { ConceptDraftPayload } from '../../../concepts/frontmatter.ts'
import type { OccurrenceCandidate } from '../../../concepts/sourceRewriter.ts'
import { normalizeConceptName } from '../../../concepts/names.ts'
import { isByokActive, readByokConfig } from './byokClient'

export interface DuplicateConceptMatch {
  slug: string
  term: string
  url: string
  status: 'draft' | 'published'
}

export interface DevAuthorSession {
  isLocalAuthor: boolean
  csrfToken: string
}

export interface ConceptListItem {
  slug: string
  term: string
  english: string
  aliases: string[]
  field: string
  groups: string[]
  summary: string
  status: 'draft' | 'published'
  isRevision?: boolean
  hasDraftRevision?: boolean
  generatedBy: string
  reviewedAt: string
  selectionSource?: string
  previewUrl: string
  occurrenceCount: number
  lectures: Array<{ lecturePath: string; code: string; title: string; count: number }>
  hasUnverified: boolean
  unverifiedLines: string[]
  sourcesCount: number
  body: string
  raw: string
  hasSelectionContext: boolean
}

export interface PreviewConfirmResponse {
  ok: boolean
  slug?: string
  error?: string
  canConfirm?: boolean
  blockedByUnverified?: boolean
  unverifiedLines?: string[]
  contractErrors?: string[]
  mountStatus?: 'ready' | 'needs_choice' | 'not_found' | 'no_mount'
  lecturePath?: string
  candidates?: OccurrenceCandidate[]
  recommendedIndex?: number | null
  chosenIndices?: number[]
  lecturePatch?: string
  conceptPatch?: string
  manualSyntax?: string
  /** Sent back with the confirm call so a write only happens for exactly the diff the author saw. */
  previewToken?: string
}

export interface DeleteImpactResponse {
  ok: boolean
  slug?: string
  term?: string
  totalLectures?: number
  totalOccurrences?: number
  impact?: Array<{
    lecturePath: string
    relDocsPath: string
    code: string
    title: string
    count: number
    patch: string
  }>
  previewToken?: string
  error?: string
}

export interface ParsedDiffLine {
  type: 'add' | 'del' | 'hunk' | 'ctx'
  text: string
}

let cachedDevSessionPromise: Promise<DevAuthorSession> | null = null

export function resetDevAuthorCacheForTest(): void {
  cachedDevSessionPromise = null
}

export async function probeLocalAuthorSession(force = false): Promise<DevAuthorSession> {
  if (!import.meta.env.DEV || typeof window === 'undefined' || typeof fetch !== 'function') {
    return { isLocalAuthor: false, csrfToken: '' }
  }
  if (force || !cachedDevSessionPromise) {
    cachedDevSessionPromise = (async () => {
      try {
        const base = ['/__lecture', '/api'].join('')
        const res = await fetch(`${base}/concepts/author`, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        })
        if (!res.ok) return { isLocalAuthor: false, csrfToken: '' }
        const json = (await res.json()) as { mode?: string; csrfToken?: string } | null
        if (json?.mode === 'dev' && typeof json.csrfToken === 'string' && json.csrfToken) {
          return { isLocalAuthor: true, csrfToken: json.csrfToken }
        }
        return { isLocalAuthor: false, csrfToken: '' }
      } catch {
        return { isLocalAuthor: false, csrfToken: '' }
      }
    })()
  }
  return cachedDevSessionPromise
}

async function postDevJson<T>(subpath: string, csrfToken: string, body: Record<string, unknown>): Promise<T> {
  if (!import.meta.env.DEV || typeof fetch !== 'function') {
    throw new Error('dev_only')
  }
  const base = ['/__lecture', '/api'].join('')
  const res = await fetch(`${base}${subpath}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'x-lecture-dev-token': csrfToken,
    },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T
}

export async function fetchDevConceptsList(): Promise<ConceptListItem[]> {
  if (!import.meta.env.DEV || typeof fetch !== 'function') return []
  try {
    const base = ['/__lecture', '/api'].join('')
    const res = await fetch(`${base}/concepts`, { cache: 'no-store', credentials: 'same-origin' })
    if (!res.ok) return []
    const json = (await res.json()) as { ok?: boolean; items?: ConceptListItem[] }
    return Array.isArray(json.items) ? json.items : []
  } catch {
    return []
  }
}

export async function generateConceptDraftInDev(opts: {
  csrfToken: string
  mode: 'create' | 'edit' | 'supplement'
  lecturePath: string
  selectedText: string
  sectionHeading?: string
  beforeContext?: string
  afterContext?: string
  targetSlug?: string
  instruction?: string
  lang: string
}): Promise<{
  ok: boolean
  errorCode?: string
  existing?: DuplicateConceptMatch
  matches?: DuplicateConceptMatch[]
  slug?: string
  previewUrl?: string
  item?: ConceptListItem
  warnings?: string[]
  message?: string
  errors?: string[]
  contractVersion?: number
}> {
  if (!import.meta.env.DEV) return { ok: false, message: 'dev_only' }
  const byok = readByokConfig()
  const useBrowserByok = isByokActive(byok)
  const pLang = normalizePromptLang(opts.lang)

  // When browser BYOK is configured, execute the shared generic contract runner in browser
  // against the context read by dev middleware from disk, then persist only validated drafts!
  if (useBrowserByok) {
    const ctxRes = await postDevJson<{
      ok: boolean
      errorCode?: string
      existing?: DuplicateConceptMatch
      matches?: DuplicateConceptMatch[]
      context?: Record<string, unknown>
      selectionSource?: string
      contract?: AiFeatureContract
      companionSystem?: { zh: string; en: string }
      error?: string
    }>('/concepts/context', opts.csrfToken, {
      mode: opts.mode,
      lecturePath: opts.lecturePath,
      selectedText: opts.selectedText,
      sectionHeading: opts.sectionHeading,
      beforeContext: opts.beforeContext,
      afterContext: opts.afterContext,
      targetSlug: opts.targetSlug,
    })

    if (!ctxRes.ok && ctxRes.errorCode === 'DUPLICATE') {
      return {
        ok: false,
        errorCode: 'DUPLICATE',
        existing: ctxRes.existing,
        matches: ctxRes.matches,
        message: ctxRes.error || 'Duplicate concept matched',
      }
    }

    if (!ctxRes.ok || !ctxRes.contract || !ctxRes.context) {
      return { ok: false, message: ctxRes.error || 'Failed to load context' }
    }

    const existingList = Array.isArray(ctxRes.context.existingConcepts)
      ? (ctxRes.context.existingConcepts as Array<{ slug?: string; term?: string; aliases?: string[] }>)
      : []
    const existingSlugSet = new Set(existingList.map((e) => e.slug).filter((s): s is string => Boolean(s)))

    // loaded on demand: ajv must not ride along in the reading bundle
    const { runAiContract } = await import('../../../prompts/contracts.ts')
    const contractResult: ContractRunResult<ConceptDraftPayload> = await runAiContract<ConceptDraftPayload>({
      contract: ctxRes.contract,
      companionSystemPrompt: ctxRes.companionSystem?.[pLang] ?? '',
      lang: pLang,
      taskInput: {
        mode: opts.mode,
        instruction: opts.instruction ?? '',
        selectionSource: ctxRes.selectionSource ?? opts.lecturePath,
        ...ctxRes.context,
      },
      validateData: (candidate) => {
        const errs: string[] = []
        const candSlug = opts.targetSlug || candidate.slug
        if (opts.mode === 'create' && existingSlugSet.has(candSlug)) {
          errs.push(`slug "${candSlug}" already exists`)
        }
        const candNames = new Set(
          [candidate.term, candidate.english, ...(candidate.aliases ?? [])]
            .map((n) => normalizeConceptName(n))
            .filter(Boolean),
        )
        for (const ex of existingList) {
          if (!ex.slug || ex.slug === candSlug) continue
          for (const exName of [ex.term ?? '', ...(ex.aliases ?? [])]) {
            const norm = normalizeConceptName(exName)
            if (norm && candNames.has(norm)) {
              errs.push(`duplicate concept name/alias "${exName}" of ${ex.slug}`)
            }
          }
        }
        for (const rel of candidate.related ?? []) {
          if (rel.slug === candSlug) {
            errs.push(`related: "${rel.slug}" relates to itself`)
          } else if (!existingSlugSet.has(rel.slug)) {
            errs.push(`related: unknown concept "${rel.slug}"`)
          }
        }
        for (const para of candidate.paragraphs ?? []) {
          if (para.verified && (!para.sources || para.sources.length === 0)) {
            errs.push(`paragraph "${para.heading}" has empty sources while verified=true`)
          }
          if (!para.verified) {
            if (!para.unverifiedReason?.trim()) {
              errs.push(`paragraph "${para.heading}" verified=false requires unverifiedReason`)
            }
            if (!para.body.includes('\u5f85\u6838\u5b9e')) {
              errs.push(`paragraph "${para.heading}" verified=false requires literal unverified marker in body`)
            }
          }
          const linkRe = /\]\(concept:([a-z0-9-]+)\)/g
          let m: RegExpExecArray | null
          while ((m = linkRe.exec(para.body)) !== null) {
            const linked = m[1]!
            if (linked !== candSlug && !existingSlugSet.has(linked)) {
              errs.push(`unknown concept link "concept:${linked}"`)
            }
          }
        }
        return errs.length > 0 ? { ok: false, errors: errs } : { ok: true }
      },
      invokeModel: async (req) => {
        const base = byok.baseUrl.replace(/\/+$/, '')
        const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
        const sendReq = async (withFormat: boolean) =>
          fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${byok.apiKey}`,
            },
            body: JSON.stringify({
              model: byok.model,
              messages: req.messages,
              temperature: 0.2,
              ...(withFormat ? { response_format: req.responseFormat } : {}),
            }),
          })
        let res = await sendReq(true)
        if (res.status === 400) {
          const txt = await res.text().catch(() => '')
          if (/response_format|json_schema/i.test(txt)) {
            res = await sendReq(false)
          } else {
            throw new Error(`HTTP 400: ${txt.slice(0, 200)}`)
          }
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
        }
        const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        return json.choices?.[0]?.message?.content ?? ''
      },
    })

    if (!contractResult.ok) {
      return {
        ok: false,
        message: 'message' in contractResult ? contractResult.message : 'Invalid schema',
        errors: 'errors' in contractResult ? contractResult.errors : [],
        contractVersion: contractResult.contractVersion,
      }
    }

    return postDevJson('/concepts/draft', opts.csrfToken, {
      mode: opts.mode,
      lecturePath: opts.lecturePath,
      selectedText: opts.selectedText,
      sectionHeading: opts.sectionHeading,
      beforeContext: opts.beforeContext,
      afterContext: opts.afterContext,
      targetSlug: opts.targetSlug,
      lang: pLang,
      draftPayload: contractResult.data,
    })
  }

  return postDevJson('/concepts/draft', opts.csrfToken, {
    mode: opts.mode,
    lecturePath: opts.lecturePath,
    selectedText: opts.selectedText,
    sectionHeading: opts.sectionHeading,
    beforeContext: opts.beforeContext,
    afterContext: opts.afterContext,
    targetSlug: opts.targetSlug,
    instruction: opts.instruction,
    lang: pLang,
  })
}

export async function saveDraftMarkdownInDev(
  csrfToken: string,
  slug: string,
  markdownOverride: string,
): Promise<{ ok: boolean; hasUnverified?: boolean; item?: ConceptListItem; message?: string }> {
  if (!import.meta.env.DEV) return { ok: false, message: 'dev_only' }
  return postDevJson('/concepts/draft', csrfToken, {
    mode: 'edit',
    selectedText: slug,
    targetSlug: slug,
    markdownOverride,
  })
}

export async function previewConfirmInDev(
  csrfToken: string,
  payload: {
    slug: string
    lecturePath?: string
    selectedText?: string
    selectedOffsets?: number[]
    allOccurrences?: boolean
    skipMount?: boolean
  },
): Promise<PreviewConfirmResponse> {
  if (!import.meta.env.DEV) return { ok: false, error: 'dev_only' }
  return postDevJson('/concepts/preview-confirm', csrfToken, payload)
}

export async function confirmConceptInDev(
  csrfToken: string,
  payload: {
    slug: string
    lecturePath?: string
    selectedText?: string
    selectedOffsets?: number[]
    allOccurrences?: boolean
    skipMount?: boolean
    expectedPreviewToken?: string
  },
): Promise<{ ok: boolean; slug?: string; url?: string; updatedLecture?: string | null; error?: string }> {
  if (!import.meta.env.DEV) return { ok: false, error: 'dev_only' }
  return postDevJson('/concepts/confirm', csrfToken, payload)
}

export async function discardDraftInDev(csrfToken: string, slug: string): Promise<{ ok: boolean; slug?: string }> {
  if (!import.meta.env.DEV) return { ok: false }
  return postDevJson('/concepts/discard', csrfToken, { slug })
}

export async function previewDeleteInDev(csrfToken: string, slug: string): Promise<DeleteImpactResponse> {
  if (!import.meta.env.DEV) return { ok: false, error: 'dev_only' }
  return postDevJson('/concepts/preview-delete', csrfToken, { slug })
}

export async function deleteConceptInDev(
  csrfToken: string,
  slug: string,
  expectedPreviewToken?: string,
): Promise<{ ok: boolean; slug?: string; unlinkedLectures?: number; unlinkedOccurrences?: number; error?: string }> {
  if (!import.meta.env.DEV) return { ok: false, error: 'dev_only' }
  return postDevJson('/concepts/delete', csrfToken, { slug, expectedPreviewToken })
}

export function parseUnifiedDiffLines(patch: string): ParsedDiffLine[] {
  if (!patch) return []
  return patch.split(/\r?\n/).map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) return { type: 'add', text: line }
    if (line.startsWith('-') && !line.startsWith('---')) return { type: 'del', text: line }
    if (line.startsWith('@@')) return { type: 'hunk', text: line }
    return { type: 'ctx', text: line }
  })
}
