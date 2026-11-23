/**
 * docs/en/[group]/index.paths.mts — generated English group pages.
 * Regression (P2d audit): the skip check once looked in docs/en/[group]/<dir>/ instead of docs/en/<dir>/,
 * so a real translated group page would have collided with the generated one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { groupPageParams } from '../../docs/en/[group]/index.paths.mts'

const groups = [
  { id: 'G01', dir: 'g01', title: '基础电学', tagline: '中文副标题', i18n: { en: { title: 'Basic electronics', tagline: 'English tagline' } } },
  { id: 'EX', dir: 'courses/g01', title: '示例', tagline: '示例副标题' },
]

let tmp: string | undefined
afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

describe('groupPageParams', () => {
  it('generates one page per group, nested dirs included, with localized title and fallback', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-en-'))
    const out = groupPageParams(groups, tmp, 'en')
    expect(out.map((p) => p.params.group)).toEqual(['g01', 'courses/g01'])
    expect(out[0]!.params).toMatchObject({ title: 'G01 · Basic electronics', description: 'English tagline' })
    expect(out[1]!.params).toMatchObject({ title: 'EX · 示例', description: '示例副标题' })
  })

  it('skips a group that has a real <lang dir>/<dir>/index.md', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2d-en-'))
    fs.mkdirSync(path.join(tmp, 'courses', 'g01'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'courses', 'g01', 'index.md'), '# real page\n')
    expect(groupPageParams(groups, tmp, 'en').map((p) => p.params.group)).toEqual(['g01'])
  })
})
