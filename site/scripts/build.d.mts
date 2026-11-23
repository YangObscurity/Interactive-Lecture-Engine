export const DEFAULT_BUILD_HEAP_MB: number
export function parseBuildArgs(argv: string[], env?: Record<string, string | undefined>): { rest: string[]; env: Record<string, string | undefined> }
export function resolveBuildHeap(
  env?: Record<string, string | undefined>,
  totalMemBytes?: number,
): {
  args: string[]
  requestedMb: number | null
  source: string
  totalMb: number
  warning: string | null
}
