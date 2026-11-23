import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

export type ApiMode = 'off' | 'mock' | 'proxy'

export declare const DEFAULT_FIXTURES_DIR: string
export declare const API_MODES: readonly ApiMode[]
export declare const SCENARIOS: Readonly<Record<string, string>>

export interface ApiHandlerOptions {
  mode: ApiMode
  fixturesDir?: string
  origin?: string
  defaultScenario?: string
  sseFrameDelayMs?: number
  slowMs?: number
  /** Clock in ms (default Date.now): drives the `Date` header, server `updated_at` and Idempotency-Key expiry. */
  now?: () => number
  log?: (line: string) => void
}

export interface ApiHandler {
  (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void | Promise<void>
  readonly mode: ApiMode
  /** Deep copy of the mock state (null outside mock mode). */
  state(): Record<string, unknown> | null
  /** Reload mock state from fixtures. */
  reset(): void
}

export declare function resolveApiMode(env?: Record<string, string | undefined>): ApiMode
export declare function parseOrigin(origin: string | undefined): URL
export declare function pickScenario(req: IncomingMessage, url: URL, fallback?: string): string
export declare function createApiHandler(options: ApiHandlerOptions): ApiHandler
export declare function apiModePlugin(opts?: {
  env?: Record<string, string | undefined>
  fixturesDir?: string
}): Plugin
export default apiModePlugin
