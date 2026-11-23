/**
 * Translation scan (i18n/scan.mts) and group-source resolution (groups-source.mts), P2d WP-I2.
 * Both run on throw-away folders under the OS temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTitle, scanLocale, scanTranslations } from '../../docs/.vitepress/i18n/scan.mts'
import { FALLBACK_SITE_META, GROUPS_CANDIDATES, resolveGroups } from '../../docs/.vitepress/groups-source.mts'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-wp-i2-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function put(rel: string, text: string): void {
  const abs = path.join(dir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, 'utf-8')
}

describe('scan translations', () => {
  it('readTitle strips quotes like the sidebar code in config.mts', () => {
    expect(readTitle('---\ntitle: "A: B"\n---\n')).toBe('A: B')
    expect(readTitle('---\ntitle: Plain\n---\n')).toBe('Plain')
    expect(readTitle('---\ntitle: "Say \\"hi\\""\n---\n')).toBe('Say "hi"')
    expect(readTitle('# no frontmatter')).toBeNull()
  })

  it('maps ROOT paths to the translated page, nested directories included', () => {
    put('en/g01/L03.md', '---\ntitle: "Kconfig and menuconfig"\n---\n# x\n')
    put('en/g01/L10.md', '---\ntitle: Ten\n---\n')
    put('en/courses/g01/L01.md', '---\ntitle: "Ohm"\n---\n')
    put('en/g01/L04.md', '# no frontmatter title\n')
    put('en/g01/index.md', '---\ntitle: Group\n---\n')
    put('en/g01/notes.md', 'x')
    put('en/[group]/index.md', 'x')
    put('en/.hidden/L09.md', 'x')
    put('g01/L03.md', '---\ntitle: root\n---\n') // root-language files are not in any locale folder
    expect(scanLocale(dir, 'en')).toEqual({
      '/courses/g01/L01': { link: '/en/courses/g01/L01', title: 'Ohm' },
      '/g01/L03': { link: '/en/g01/L03', title: 'Kconfig and menuconfig' },
      '/g01/L04': { link: '/en/g01/L04', title: '' },
      '/g01/L10': { link: '/en/g01/L10', title: 'Ten' },
    })
  })

  it('a missing locale folder means no translations; scanTranslations covers every key', () => {
    put('en/g01/L01.md', '---\ntitle: One\n---\n')
    expect(scanLocale(dir, 'zh')).toEqual({})
    const all = scanTranslations(dir, ['en', 'zh'])
    expect(Object.keys(all)).toEqual(['en', 'zh'])
    expect(all.zh).toEqual({})
    expect(Object.keys(all.en ?? {})).toEqual(['/g01/L01'])
  })
})

describe('resolveGroups(dir)', () => {
  const GROUP = (dirName: string) => `export const GROUPS = [{ id: 'X', dir: '${dirName}', title: 't', tagline: 'g', summary: 's', accent: '#000', tags: [] }]\n`
  let log: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    log.mockRestore()
    warn.mockRestore()
  })

  it('candidate order is the documented priority', () => {
    expect(GROUPS_CANDIDATES.map((c) => c.file)).toEqual([
      'content/groups.ts',
      'content-groups.mts',
      'groups.mts',
    ])
  })

  it('takes the first existing source and logs it', async () => {
    put('groups.mts', GROUP('local'))
    const r = await resolveGroups(dir)
    expect(r.GROUPS.map((g) => g.dir)).toEqual(['local'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[groups] 元信息来源 = groups.mts'))
    put('content-groups.mts', GROUP('mounted') + "export const SITE_META = { name: 'N', text: 'T', tagline: 'G' }\n")
    const r2 = await resolveGroups(dir)
    expect(r2.GROUPS.map((g) => g.dir)).toEqual(['mounted'])
    expect(r2.SITE_META.name).toBe('N')
    put('content/groups.ts', GROUP('v2-content'))
    const r3 = await resolveGroups(dir)
    expect(r3.GROUPS.map((g) => g.dir)).toEqual(['v2-content'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[groups] 元信息来源 = content/groups.ts'))
  })

  it('accepts GROUP_META as the export name and skips a file without a groups array', async () => {
    put('content-groups.mts', 'export const NOPE = 1\n')
    put('groups.mts', GROUP('local').replace('GROUPS', 'GROUP_META'))
    const r = await resolveGroups(dir)
    expect(r.GROUPS.map((g) => g.dir)).toEqual(['local'])
  })

  it('falls back to an empty site with a warning when nothing exists', async () => {
    const r = await resolveGroups(dir)
    expect(r.GROUPS).toEqual([])
    expect(r.SITE_META).toEqual(FALLBACK_SITE_META)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('未找到任何课程组来源'))
    // in-place mode with no groups: the warning says how to get content (npm run init, or the demo fallback)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/npm run init[\s\S]*LECTURE_DEMO=0/))
  })
})
