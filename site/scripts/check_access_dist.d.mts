export const DEFAULT_DIST: string
export const DEFAULT_MANIFEST: string
export class GateBroken extends Error {}
export function variantsOf(name: string): string[]
export interface AccessCheckResult {
  ok: boolean
  failures: string[]
  warnings: string[]
  notes: string[]
}
export function checkAccessDist(opts?: { dist?: string; manifest?: string; ignoreOutDir?: boolean }): AccessCheckResult
