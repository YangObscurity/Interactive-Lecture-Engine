/**
 * S6: the e2e demo build empties and writes its output folder, so it may only write below site/.e2e-demo/ or
 * site/.access-e2e/ (never site/ itself, docs/.vitepress/dist, the roots themselves or anything outside site/).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertE2eOutDir, E2E_CONTENT_COPY, E2E_CONTENT_DIR, prepareDemoCopy } from '../../scripts/build_e2e.mjs'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('build_e2e outDir guard', () => {
  it('accepts folders below the two e2e roots', () => {
    expect(assertE2eOutDir(path.join(SITE, '.e2e-demo', 'dist'))).toBe(path.join(SITE, '.e2e-demo', 'dist'))
    expect(assertE2eOutDir('.access-e2e/dist')).toBe(path.join(SITE, '.access-e2e', 'dist'))
    expect(assertE2eOutDir(path.join(SITE, '.e2e-demo', 'access-manifest.json'))).toBe(path.join(SITE, '.e2e-demo', 'access-manifest.json'))
  })

  it('refuses site/, the roots themselves, the deployed dist and paths outside site/', () => {
    for (const bad of [
      SITE,
      '.',
      path.join(SITE, '.e2e-demo'),
      path.join(SITE, '.access-e2e'),
      path.join(SITE, 'docs', '.vitepress', 'dist'),
      path.join(SITE, '.e2e-demo', '..', 'docs'),
      path.join(SITE, '..'),
      path.join(SITE, '.e2e-demo-other', 'dist'),
    ]) {
      expect(() => assertE2eOutDir(bad), bad).toThrow(/refusing/)
    }
  })

  it('builds the engine demo content (templates/demo-content)', () => {
    expect(E2E_CONTENT_DIR).toBe(path.join(SITE, '..', 'templates', 'demo-content'))
  })

  it('runs on a copy with the e2e site config; the demo keeps its backend-free one (decisions A and B)', () => {
    const copy = path.join(SITE, '.e2e-demo', `unit-copy-${process.pid}`)
    try {
      expect(prepareDemoCopy(copy)).toBe(copy)
      const e2eCfg = fs.readFileSync(path.join(E2E_CONTENT_DIR, 'e2e', 'site.config.ts'), 'utf8')
      expect(fs.readFileSync(path.join(copy, 'site.config.ts'), 'utf8')).toBe(e2eCfg)
      expect(e2eCfg).toMatch(/adapter: 'rest'/)
      expect(fs.existsSync(path.join(copy, 'e2e'))).toBe(false)
      expect(fs.existsSync(path.join(copy, 'groups.ts'))).toBe(true)
      const own = fs.readFileSync(path.join(E2E_CONTENT_DIR, 'site.config.ts'), 'utf8')
      expect(own).toMatch(/progress: \{ adapter: 'local' \}/)
      expect(own).toMatch(/auth: \{ adapter: 'none' \}/)
      expect(own).not.toMatch(/'rest'|'proxy'|'trusted-header'/)
      expect(E2E_CONTENT_COPY).toBe(path.join(SITE, '.e2e-demo', 'content'))
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
    expect(() => prepareDemoCopy(path.join(SITE, '.e2e-demo'))).toThrow(/refusing/)
    expect(() => prepareDemoCopy(E2E_CONTENT_DIR)).toThrow(/refusing/)
  })
})
