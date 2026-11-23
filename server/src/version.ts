import { readFileSync } from 'node:fs'

export const SERVICE_NAME = 'lecture-api'

/**
 * Single version source: `server/package.json`. Both `src/version.ts` (tsx / vitest) and
 * `dist/version.js` (built) sit one directory below `server/`, so the same relative path works.
 */
function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version !== '') return parsed.version
  } catch {
    // fall through
  }
  return '0.0.0-unknown'
}

export const SERVICE_VERSION: string = readPackageVersion()
