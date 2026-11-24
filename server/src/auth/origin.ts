import type { AppConfig } from '../config/schema.js'

export function isOriginAllowed(
  clientOrigin: string,
  cfg: AppConfig,
  reqUrl: string,
  host?: string,
  headers?: (name: string) => string | undefined,
): boolean {
  if (!clientOrigin) return false
  let clientUrl: URL
  try {
    clientUrl = new URL(clientOrigin.trim())
  } catch {
    return false
  }
  if (clientUrl.protocol !== 'http:' && clientUrl.protocol !== 'https:') {
    return false
  }
  const cleanClientOrigin = clientUrl.origin.toLowerCase()

  // Strict configured allowlist (supports comma-separated origins) — no fallthrough on mismatch
  if (cfg.webauthnOrigin && cfg.webauthnOrigin.trim() !== '') {
    const allowed = cfg.webauthnOrigin
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const rawAllowed of allowed) {
      try {
        if (new URL(rawAllowed).origin.toLowerCase() === cleanClientOrigin) {
          return true
        }
      } catch {
        // ignore invalid configured origin
      }
    }
    return false
  }

  let parsedReqUrl: URL | null = null
  const rawProto = headers?.('x-forwarded-proto')
  const forwardedProto = rawProto?.split(',')[0]?.trim().toLowerCase()
  try {
    parsedReqUrl = new URL(reqUrl)
    if (cleanClientOrigin === parsedReqUrl.origin.toLowerCase()) {
      return true
    }
    // Support TLS-terminating reverse proxies forwarding https over http loopback
    if ((cfg.authCookieSecure === 'true' || forwardedProto === 'https') && parsedReqUrl.host) {
      if (`https://${parsedReqUrl.host}`.toLowerCase() === cleanClientOrigin) {
        return true
      }
    }
  } catch {
    parsedReqUrl = null
  }

  if (host && host.trim() !== '') {
    const cleanHost = host.trim()
    if (!/[\s/@\\]/.test(cleanHost)) {
      const proto =
        cfg.authCookieSecure === 'true' || forwardedProto === 'https'
          ? 'https:'
          : (parsedReqUrl?.protocol ?? 'http:')
      try {
        const hostOrigin = new URL(`${proto}//${cleanHost}`).origin.toLowerCase()
        if (hostOrigin === cleanClientOrigin) {
          return true
        }
      } catch {
        // ignore invalid host
      }
    }
  }

  return false
}
