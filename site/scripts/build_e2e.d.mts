export const E2E_CONTENT_DIR: string
export const E2E_ROOT: string
export const E2E_CONTENT_COPY: string
export const E2E_DIST: string
export const E2E_MANIFEST: string
export const E2E_OUT_ROOTS: string[]
export function prepareDemoCopy(copyDir?: string): string
export function demoEnv(extra?: Record<string, string>): NodeJS.ProcessEnv
export function syncDemo(extra?: Record<string, string>, args?: string[]): number
export function restoreOwnContent(): Promise<number>
export function assertE2eOutDir(outDir: string): string
export function buildDemo(options?: { outDir?: string; manifestOut?: string; extra?: Record<string, string> }): Promise<number>
