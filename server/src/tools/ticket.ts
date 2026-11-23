import { createHmac, timingSafeEqual } from 'node:crypto'

export const DEFAULT_TICKET_TTL_MS = 10 * 60 * 1000

export interface ToolTicketPayload {
  tiers: string[]
  uh: string | null
  exp: number
}

export interface VerifiedTicket {
  valid: boolean
  tiers: string[]
  uh: string | null
}

function signPayload(secret: string, encodedPayload: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest()
}

export function mintToolTicket(
  secret: string,
  payload: { tiers: readonly string[]; uh: string | null },
  now: () => number = Date.now,
  ttlMs: number = DEFAULT_TICKET_TTL_MS,
): string {
  const uniqueTiers = [...new Set(payload.tiers.map((t) => t.trim()).filter(Boolean))]
  if (!uniqueTiers.includes('public')) {
    uniqueTiers.unshift('public')
  }
  const body: ToolTicketPayload = {
    tiers: uniqueTiers,
    uh: payload.uh,
    exp: Math.floor(now()) + ttlMs,
  }
  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  const sig = signPayload(secret, encoded).toString('base64url')
  return `${encoded}.${sig}`
}

export function verifyToolTicket(
  secret: string | null | undefined,
  ticket: string | null | undefined,
  now: () => number = Date.now,
): VerifiedTicket {
  const fallback: VerifiedTicket = { valid: false, tiers: ['public'], uh: null }

  if (!secret || secret.trim() === '' || typeof ticket !== 'string') {
    return fallback
  }

  const trimmed = ticket.trim()
  const dot = trimmed.indexOf('.')
  if (dot <= 0 || dot === trimmed.length - 1 || trimmed.indexOf('.', dot + 1) !== -1) {
    return fallback
  }

  const encoded = trimmed.slice(0, dot)
  const providedSigB64 = trimmed.slice(dot + 1)

  try {
    const expectedSig = signPayload(secret, encoded)
    const providedSig = Buffer.from(providedSigB64, 'base64url')
    if (expectedSig.length !== providedSig.length || !timingSafeEqual(expectedSig, providedSig)) {
      return fallback
    }

    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<ToolTicketPayload>
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.tiers) ||
      typeof parsed.exp !== 'number' ||
      !Number.isFinite(parsed.exp)
    ) {
      return fallback
    }

    if (parsed.exp <= now()) {
      return fallback
    }

    const tiers = [
      ...new Set(
        parsed.tiers.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()),
      ),
    ]
    if (!tiers.includes('public')) {
      tiers.unshift('public')
    }

    const uh = typeof parsed.uh === 'string' ? parsed.uh : null
    return { valid: true, tiers, uh }
  } catch {
    return fallback
  }
}
