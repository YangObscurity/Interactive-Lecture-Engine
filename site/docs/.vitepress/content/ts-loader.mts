/**
 * content/ts-loader.mts - the one place that loads TypeScript config files (`site.config.ts`, `lecture.config.ts`,
 * `groups.ts`, `groups.mts`) at runtime. Node only.
 *
 * Why jiti: plain `import()` of `.ts` / `.mts` fails on Node 20 (ERR_UNKNOWN_FILE_EXTENSION) and the files may
 * import each other without extensions; jiti (maintained, MIT) covers both on every Node version and reports
 * errors against the real file and line. Module and file caches are off, so a reload (`content:watch`, tests,
 * a second call) always reads the file as it is on disk.
 */
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, interopDefault: false })

/** Load a TypeScript module asynchronously (use this wherever the caller can await). */
export async function loadTsModule<T = Record<string, unknown>>(file: string): Promise<T> {
  return (await jiti.import(file)) as T
}

/** Load a TypeScript module synchronously (config values read at module level; the file must not use top-level await). */
export function loadTsModuleSync<T = Record<string, unknown>>(file: string): T {
  return jiti(file) as T
}
