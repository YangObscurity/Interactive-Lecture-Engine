export class InvalidLectureIdError extends Error {
  readonly code = 'invalid_lecture_id'

  constructor(message = 'Invalid lecture_id format') {
    super(message)
    this.name = 'InvalidLectureIdError'
  }
}

export const AI_LECTURE_ID_RE = /^[a-z0-9][a-z0-9_-]*-l\d{2,}$/

export function normalizeAiLectureId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new InvalidLectureIdError('lecture_id must be a string')
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'global') {
    return 'global'
  }
  if (!AI_LECTURE_ID_RE.test(normalized)) {
    throw new InvalidLectureIdError(
      'Invalid lecture_id format; expected <group>-l<two or more digits> or global',
    )
  }
  return normalized
}

export function deriveAiGroupId(
  normalizedLectureId: string,
  explicitGroupId?: string | null,
): string {
  if (explicitGroupId !== undefined && explicitGroupId !== null && typeof explicitGroupId === 'string') {
    const trimmed = explicitGroupId.trim().toLowerCase()
    if (trimmed !== '') {
      return trimmed
    }
  }

  if (normalizedLectureId === 'global') {
    return 'global'
  }

  const idx = normalizedLectureId.lastIndexOf('-')
  if (idx <= 0) {
    return normalizedLectureId
  }
  return normalizedLectureId.slice(0, idx)
}

export function toIsoUtc(val: Date | string | number | null | undefined): string {
  if (!val) {
    return new Date().toISOString()
  }
  if (val instanceof Date) {
    return val.toISOString()
  }
  const d = new Date(val)
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

/**
 * Build a `LIMIT/OFFSET` suffix, appending the two values to `params`. Empty string when no page
 * is requested (repo callers that want every row, such as `db:reassign` tooling and unit tests).
 */
export function pageClause(params: unknown[], page?: { limit: number; offset: number }): string {
  if (!page) return ''
  params.push(page.limit)
  const limitIdx = params.length
  params.push(page.offset)
  const offsetIdx = params.length
  return `LIMIT $${limitIdx} OFFSET $${offsetIdx}`
}
