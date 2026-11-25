import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config/load.js'
import { resolveContentDir } from '../../src/services/contentSync.js'

describe('resolveContentDir (contentSync isolation)', () => {
  const savedContentDir = process.env.CONTENT_DIR
  const savedLectureContentDir = process.env.LECTURE_CONTENT_DIR
  const tempDirs: string[] = []

  function makeTempDir(prefix = 'content-sync-test-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    if (savedContentDir !== undefined) process.env.CONTENT_DIR = savedContentDir
    else delete process.env.CONTENT_DIR

    if (savedLectureContentDir !== undefined) process.env.LECTURE_CONTENT_DIR = savedLectureContentDir
    else delete process.env.LECTURE_CONTENT_DIR

    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('disables disk sync when CONTENT_DIR is explicitly empty or whitespace even if fallbacks exist', () => {
    const root = makeTempDir()
    const contentDir = join(root, 'content')
    const distDir = join(root, 'dist')
    const altDir = makeTempDir('lecture-alt-')
    mkdirSync(contentDir, { recursive: true })
    mkdirSync(distDir, { recursive: true })

    const config = loadConfig({ DATABASE_URL: 'pglite:memory', AUTH_ADAPTER: 'none', SITE_DIST_DIR: distDir })
    process.env.LECTURE_CONTENT_DIR = altDir
    process.env.CONTENT_DIR = ''
    expect(resolveContentDir(config)).toBeNull()

    process.env.CONTENT_DIR = '   '
    expect(resolveContentDir(config)).toBeNull()
  })

  it('returns null without falling back when CONTENT_DIR points to a non-existent path', () => {
    const root = makeTempDir()
    const contentDir = join(root, 'content')
    const distDir = join(root, 'dist')
    mkdirSync(contentDir, { recursive: true })
    mkdirSync(distDir, { recursive: true })

    const config = loadConfig({ DATABASE_URL: 'pglite:memory', AUTH_ADAPTER: 'none', SITE_DIST_DIR: distDir })
    delete process.env.LECTURE_CONTENT_DIR
    process.env.CONTENT_DIR = join(root, 'missing-content')
    expect(resolveContentDir(config)).toBeNull()
  })

  it('treats empty LECTURE_CONTENT_DIR as unset and falls back to siteDistDir/../content', () => {
    const root = makeTempDir()
    const contentDir = join(root, 'content')
    const distDir = join(root, 'dist')
    mkdirSync(contentDir, { recursive: true })
    mkdirSync(distDir, { recursive: true })

    const config = loadConfig({ DATABASE_URL: 'pglite:memory', AUTH_ADAPTER: 'none', SITE_DIST_DIR: distDir })
    delete process.env.CONTENT_DIR
    process.env.LECTURE_CONTENT_DIR = ''
    expect(resolveContentDir(config)).toBe(contentDir)

    process.env.LECTURE_CONTENT_DIR = '  '
    expect(resolveContentDir(config)).toBe(contentDir)
  })

  it('uses trimmed existing LECTURE_CONTENT_DIR and returns null when non-existent', () => {
    const root = makeTempDir()
    const customDir = makeTempDir('lecture-custom-')
    const distDir = join(root, 'dist')
    mkdirSync(join(root, 'content'), { recursive: true })
    mkdirSync(distDir, { recursive: true })

    const config = loadConfig({ DATABASE_URL: 'pglite:memory', AUTH_ADAPTER: 'none', SITE_DIST_DIR: distDir })
    delete process.env.CONTENT_DIR

    process.env.LECTURE_CONTENT_DIR = ` ${customDir} `
    expect(resolveContentDir(config)).toBe(customDir)

    process.env.LECTURE_CONTENT_DIR = join(root, 'missing-lecture-dir')
    expect(resolveContentDir(config)).toBeNull()
  })
})
