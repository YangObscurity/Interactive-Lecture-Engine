/**
 * The config tools run under plain `node` (`npm run doctor` / `setup` / `config:gen`: Node strips the types, it
 * does not resolve extensionless specifiers). Every relative import reachable from those entries must name its file
 * extension, or the CLI breaks while Vite and vitest (which do resolve them) stay green. This happened once: P3b's
 * access/tiers.ts imported '../theme/core/hash' and `npm run doctor` failed with ERR_MODULE_NOT_FOUND.
 * `import type` lines are erased before Node resolves anything, so they may stay extensionless.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SITE = resolve(__dirname, '../..')
const ENTRIES = ['scripts/config/doctor.mts', 'scripts/config/setup.mts', 'scripts/config/gen.mts', 'scripts/config/env.mts']
const RUNNABLE = /\.(?:ts|mts|mjs|js|json)$/

/** Relative specifiers of value imports / re-exports / dynamic imports (type-only imports are skipped). */
function relativeSpecifiers(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const out: string[] = []
  const stmt = /^\s*(import|export)\s+(type\s+)?[^'";]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/gm
  let m: RegExpExecArray | null
  while ((m = stmt.exec(code)) !== null) if (!m[2]) out.push(m[3] as string)
  const bare = /^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm
  while ((m = bare.exec(code)) !== null) out.push(m[1] as string)
  const dyn = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g
  while ((m = dyn.exec(code)) !== null) out.push(m[1] as string)
  return out
}

describe('node-run config tools: every reachable relative import names its extension', () => {
  it('crawls doctor / setup / gen / env and finds no extensionless runtime import', () => {
    const seen = new Set<string>()
    const offenders: string[] = []
    const queue = ENTRIES.map((e) => join(SITE, e)).filter((f) => existsSync(f))
    expect(queue.length).toBe(ENTRIES.length)
    while (queue.length) {
      const file = queue.shift() as string
      if (seen.has(file)) continue
      seen.add(file)
      for (const spec of relativeSpecifiers(readFileSync(file, 'utf8'))) {
        if (!RUNNABLE.test(spec)) {
          offenders.push(`${relative(SITE, file).replace(/\\/g, '/')}: '${spec}'`)
          continue
        }
        const target = resolve(dirname(file), spec)
        if (existsSync(target) && !target.includes('node_modules') && !spec.endsWith('.json')) queue.push(target)
      }
    }
    expect(offenders).toEqual([])
    expect(seen.size).toBeGreaterThan(ENTRIES.length) // the crawl actually followed imports
  })
})
