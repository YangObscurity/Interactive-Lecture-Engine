/**
 * README style lock & sync gate unit tests (scripts/check_readme_sync.mjs).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createJiti } from 'jiti'

interface ReadmeSyncModule {
  REPO_ROOT: string
  analyzeChangedFiles: (files: string[], skipTagPresent?: boolean) => { errors: string[]; advisories: string[] }
  checkReadmes: (repoRoot?: string) => { ok: boolean; errors: string[] }
  extractEnvVarsFromExample: (text: string) => string[]
  extractTableVarsFromServerReadme: (text: string) => string[] | null
}

const syncModule = (await createJiti(import.meta.url).import(
  '../../../scripts/check_readme_sync.mjs',
)) as ReadmeSyncModule

const tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-sync-'))
  tmpDirs.push(dir)

  fs.mkdirSync(path.join(dir, 'docs', 'brand'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true })
  for (const f of ['banner-light.svg', 'banner-dark.svg', 'hero.png', 'hero-dark.png']) {
    fs.writeFileSync(path.join(dir, 'docs', 'brand', f), '<svg/>')
  }

  const zh = [
    '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/banner-dark.svg"><img src="docs/brand/banner-light.svg"></picture>',
    '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/hero-dark.png"><img src="docs/brand/hero.png"></picture>',
    '![License: MIT](https://img.shields.io/badge/license-MIT-2155c4?style=flat-square)',
    '<a href="./README.en.md">English</a>',
    '<a href="#功能">功能</a>',
    '## 功能',
    ...Array.from({ length: 6 }, (_, i) => `<details><summary>Item ${i}</summary></details>`),
  ].join('\n\n')

  const en = [
    '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/banner-dark.svg"><img src="docs/brand/banner-light.svg"></picture>',
    '<picture><source media="(prefers-color-scheme: dark)" srcset="docs/brand/hero-dark.png"><img src="docs/brand/hero.png"></picture>',
    '![License: MIT](https://img.shields.io/badge/license-MIT-2155c4?style=flat-square)',
    '<a href="./README.md">中文</a>',
    '<a href="#features">Features</a>',
    '## Features',
    ...Array.from({ length: 6 }, (_, i) => `<details><summary>Item ${i}</summary></details>`),
  ].join('\n\n')

  const srv = [
    '# server',
    ...Array.from({ length: 7 }, (_, i) => `## ${i + 1}. Sec`),
    '## 8. 完整配置项参考表',
    '| 变量 | 说明 |',
    '|---|---|',
    '| `HOST` | bind host |',
    '## 9. Tests',
    '## 10. FAQ',
    '## AI tools',
  ].join('\n\n')

  fs.writeFileSync(path.join(dir, 'README.md'), zh)
  fs.writeFileSync(path.join(dir, 'README.en.md'), en)
  fs.writeFileSync(path.join(dir, 'server', 'README.md'), srv)
  fs.writeFileSync(path.join(dir, 'server', '.env.example'), 'HOST=127.0.0.1\n')
  return dir
}

describe('readme sync & style lock', () => {
  it('passes on the real repository READMEs and server/.env.example', () => {
    const res = syncModule.checkReadmes(syncModule.REPO_ROOT)
    expect(res.errors).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('detects missing env vars in server/README.md §8', () => {
    const dir = makeFixtureRepo()
    fs.writeFileSync(path.join(dir, 'server', '.env.example'), 'HOST=127.0.0.1\nPORT=8100\n')
    const res = syncModule.checkReadmes(dir)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('PORT'))).toBe(true)
  })

  it('rejects hype slogans and broken local links', () => {
    const dir = makeFixtureRepo()
    const zh = fs.readFileSync(path.join(dir, 'README.md'), 'utf8')
    fs.writeFileSync(path.join(dir, 'README.md'), `${zh}\n\n[broken](docs-dev/NONEXISTENT.md)\n\n这是一款革命性的工具。\n`)
    const res = syncModule.checkReadmes(dir)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.includes('NONEXISTENT.md'))).toBe(true)
    expect(res.errors.some((e) => e.includes('革命性'))).toBe(true)
  })

  it('requires bilingual README pairing unless skipped, and warns on surface code changes', () => {
    const oneLang = syncModule.analyzeChangedFiles(['README.md'])
    expect(oneLang.errors.length).toBe(1)

    const skipped = syncModule.analyzeChangedFiles(['README.md'], true)
    expect(skipped.errors).toEqual([])

    const surfaceRouteOnly = syncModule.analyzeChangedFiles(['server/src/routes/admin/db.ts'])
    expect(surfaceRouteOnly.errors).toEqual([])
    expect(surfaceRouteOnly.advisories.length).toBe(1)

    const surfaceDashboardOnly = syncModule.analyzeChangedFiles([
      'site/docs/.vitepress/theme/dashboard/DashboardPage.vue',
    ])
    expect(surfaceDashboardOnly.errors).toEqual([])
    expect(surfaceDashboardOnly.advisories.length).toBe(1)
  })
})
