/**
 * S2 content migration (scripts/content/migrate.mts): the plan comes from the path module, and the two
 * conversions turn engine-coupled files into plain content data.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planMigration, toPlainGroups, toPlainSiteConfig } from '../../scripts/content/migrate.mts'

const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function write(root: string, rel: string, body: string): void {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body, 'utf8')
}

describe('content:migrate', () => {
  it('plans every move from the in-place layout to the content layout and leaves engine files in place', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-migrate-'))
    tmp.push(repo)
    write(repo, 'site/docs/.vitepress/groups.mts', "export const GROUPS = [{ id: 'A', dir: 'ga' }, { id: 'B', dir: 'gb/sub' }]\n")
    write(repo, 'site/docs/ga/L01.md', '# a\n')
    write(repo, 'site/docs/gb/sub/L01.md', '# b\n')
    write(repo, 'site/docs/concepts/x.md', '# x\n')
    write(repo, 'site/docs/public/charts/A-L01.json', '{}\n')
    write(repo, 'site/docs/public/lecture_catalog.json', '[]\n')
    write(repo, 'site/docs/public/favicon.svg', '<svg/>\n')
    write(repo, 'site/data/graph.json', '{}\n')
    write(repo, 'site/lecture.config.ts', 'export default {}\n')

    const plan = await planMigration(repo)
    const moves = plan.moves.map((m) => `${m.from} -> ${m.to}`)
    expect(moves).toEqual([
      'site/docs/ga -> content/lectures/ga',
      'site/docs/gb -> content/lectures/gb',
      'site/docs/concepts -> content/concepts',
      'site/docs/public/charts -> content/charts',
      'site/data/graph.json -> content/graph/graph.json',
      'site/docs/public/lecture_catalog.json -> content/public/lecture_catalog.json',
      'site/docs/.vitepress/groups.mts -> content/groups.ts',
      'site/lecture.config.ts -> content/site.config.ts',
    ])
    expect(plan.leftInPlace).toEqual(['site/docs/public/favicon.svg'])
    expect(plan.missing).toContain('site/site-texts.json')
  })

  it('refuses to plan when a content root is already active', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'lec-migrate-'))
    tmp.push(repo)
    write(repo, 'content/groups.ts', 'export const GROUPS = []\n')
    await expect(planMigration(repo)).rejects.toThrow(/already active/)
  })

  it('turns groups.mts into plain data without the engine type import', () => {
    const src = [
      '/** header */',
      "import type { GroupI18n } from './i18n/data.ts'",
      '',
      'export type GroupMeta = {',
      '  id: string',
      '  i18n?: GroupI18n',
      '}',
      '',
      'export const GROUPS: GroupMeta[] = [',
      "  { id: 'G01', dir: 'g01' },",
      ']',
      '',
    ].join('\r\n')
    const out = toPlainGroups(src)
    expect(out).toBe(['/** header */', '', 'export const GROUPS = [', "  { id: 'G01', dir: 'g01' },", ']', ''].join('\r\n'))
  })

  it('turns lecture.config.ts into a plain object', () => {
    const src = [
      '/**',
      " * lecture.config.ts — this site's deployer configuration (non-secret).",
      ' */',
      "import { defineLectureConfig } from './docs/.vitepress/lecture-config.mts'",
      '',
      'export default defineLectureConfig({',
      "  theme: 'datasheet',",
      '})',
      '',
    ].join('\n')
    const out = toPlainSiteConfig(src)
    expect(out).not.toContain('defineLectureConfig')
    expect(out).toContain('export default {\n')
    expect(out.trimEnd().endsWith('}')).toBe(true)
    expect(out).toContain('site.config.ts')
  })
})
