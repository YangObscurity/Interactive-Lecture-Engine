/** Types of scripts/figures/check_figures.mjs (used by scripts/content/check.mts). */
export interface FiguresCheckResult {
  ok: boolean
  errors: string[]
  warnings: string[]
  gallery: { usedIn: unknown[] }[]
  registries: Map<string, unknown>
}

export function runFiguresCheck(): Promise<FiguresCheckResult>

export function runConceptsCheck(): Promise<{ concepts: number; errors: string[]; warnings: string[] }>
