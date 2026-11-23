import { badRequest } from './errors.js'

/** List endpoints return at most this many rows unless `?limit=` asks for fewer/more (D-08). */
export const DEFAULT_LIST_LIMIT = 200
export const MAX_LIST_LIMIT = 1000

export interface Page {
  limit: number
  offset: number
}

function parseNonNegativeInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === '') return undefined
  if (!/^\d{1,9}$/.test(raw)) {
    throw badRequest('invalid_request', { message: `${name}_invalid` })
  }
  return Number(raw)
}

/** Parse `?limit=` (1..1000, default 200) and `?offset=` (>= 0, default 0). Bad values: 400 invalid_request. */
export function parsePage(limitRaw: string | undefined, offsetRaw: string | undefined): Page {
  const limit = parseNonNegativeInt(limitRaw, 'limit') ?? DEFAULT_LIST_LIMIT
  if (limit < 1 || limit > MAX_LIST_LIMIT) {
    throw badRequest('invalid_request', { message: 'limit_invalid' })
  }
  const offset = parseNonNegativeInt(offsetRaw, 'offset') ?? 0
  return { limit, offset }
}
