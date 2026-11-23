import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readViteEnv } from '../../docs/.vitepress/theme/debug/flags'

const THEME_DIR = join(__dirname, '../../docs/.vitepress/theme')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|vue)$/.test(name)) out.push(full)
  }
  return out
}

describe('Vite env access', () => {
  it('readViteEnv returns the real import.meta.env (vitest provides MODE and DEV)', () => {
    const env = readViteEnv()
    expect(typeof env.MODE).toBe('string')
    expect(typeof env.DEV).toBe('boolean')
  })

  it('the theme never aliases import.meta (Vite only replaces the literal `import.meta.env`)', () => {
    const offenders = sourceFiles(THEME_DIR)
      .filter((f) => !f.endsWith('.d.ts'))
      .filter((f) => {
        const code = readFileSync(f, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
        // every `import.meta` must be followed directly by `.env` or `.hot`/`.glob`/`.url`
        return /import\.meta(?!\.(env|hot|glob|url)\b)/.test(code)
      })
    expect(offenders).toEqual([])
  })

  it('flags.ts contains the literal import.meta.env expression', () => {
    const code = readFileSync(join(THEME_DIR, 'debug/flags.ts'), 'utf8')
    expect(code).toMatch(/import\.meta\.env\b/)
  })
})
