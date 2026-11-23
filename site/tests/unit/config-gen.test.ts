import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS } from '../../config/schema.ts'
import { renderEnvExample, renderSchemaJson } from '../../scripts/config/gen.mts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../../../')
const schemaJsonPath = resolve(__dirname, '../../config/schema.json')
const envExamplePath = resolve(repoRoot, '.env.example')

describe('config generation and template invariants', () => {
  it('committed schema.json and .env.example equal the generated output', () => {
    const committedJson = readFileSync(schemaJsonPath, 'utf8')
    const committedEnv = readFileSync(envExamplePath, 'utf8')

    expect(committedJson).toBe(renderSchemaJson())
    expect(committedEnv).toBe(renderEnvExample())
  })

  it('every env/secret key appears exactly once in .env.example', () => {
    const envContent = renderEnvExample()
    const nonSiteSettings = SETTINGS.filter((s) => s.kind !== 'site')

    for (const s of nonSiteSettings) {
      // Matches lines like `KEY=` or `KEY=value`
      const regex = new RegExp(`^${s.key}=`, 'gm')
      const matches = envContent.match(regex)
      expect(matches, `Checking key ${s.key}`).not.toBeNull()
      expect(matches?.length, `Key ${s.key} should appear exactly once`).toBe(1)
    }
  })

  it('no secret has a non-empty value line', () => {
    const envContent = renderEnvExample()
    const secretSettings = SETTINGS.filter((s) => s.kind === 'secret')

    for (const s of secretSettings) {
      const regex = new RegExp(`^${s.key}=(.*)$`, 'm')
      const match = envContent.match(regex)
      expect(match, `Secret key ${s.key} should be present`).not.toBeNull()
      const value = match ? match[1] : ''
      expect(value, `Secret key ${s.key} must have empty value in .env.example`).toBe('')
    }
  })
})
