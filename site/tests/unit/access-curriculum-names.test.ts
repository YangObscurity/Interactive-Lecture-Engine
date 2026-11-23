/**
 * The leak check must also look for the curriculum's prefix-less lecture titles (audit P4a): the sidebar names it
 * already had are "第N讲 · X", the curriculum carries only "X".
 */
import { describe, expect, it } from 'vitest'
import { curriculumNamesByTier, descNeedle } from '../../docs/.vitepress/access/build.mts'
import type { CurriculumBuild, CurriculumData, CurriculumGroup } from '../../docs/.vitepress/curriculum/data'
import { resolveAccess } from '../../docs/.vitepress/access/tiers'

function group(id: string, title: string, lectures: string[]): CurriculumGroup {
  return {
    id,
    dir: id.toLowerCase(),
    title,
    category: '',
    catSlot: 1,
    lectures: lectures.map((t, i) => ({ id: `${id.toLowerCase()}-l${String(i + 1).padStart(2, '0')}`, n: i + 1, title: t, link: `/${id.toLowerCase()}/L${String(i + 1).padStart(2, '0')}` })),
    phases: [],
  }
}

function data(locale: string, groups: CurriculumGroup[]): CurriculumData {
  return { version: 1, locale, groups, edges: [], stats: { groups: groups.length, lectures: 0, edges: 0 } }
}

describe('curriculumNamesByTier', () => {
  const plan = resolveAccess({
    access: { default: 'public', enforcement: 'gateway', groups: { G09: { read: 'authenticated' }, G12: { read: ['staff'] } } },
    groupIds: ['G06', 'G09', 'G12'],
  })
  const build: CurriculumBuild = {
    byLocale: {
      root: data('root', [
        group('G06', 'Python 进阶', ['装饰器与闭包', '共享讲名']),
        group('G09', 'AWS 云平台', ['VPC 与私有子网设计', '共享讲名', 'IAM']),
        group('G12', 'Java 工程', ['多线程 IoT 网关']),
      ]),
      en: data('en', [group('G09', 'AWS cloud', ['VPC and private subnets'])]),
    },
    dropped: [],
    warnings: [],
    edgeSources: { graph: 0, requires: 0, both: 0, union: 0 },
  }

  it('collects each restricted tier\'s group and prefix-less lecture titles in every language', () => {
    const r = curriculumNamesByTier(build, plan)
    expect(r.authenticated?.names).toEqual(['AWS cloud', 'AWS 云平台', 'VPC and private subnets', 'VPC 与私有子网设计'].sort())
    const staff = Object.keys(r).find((k) => k.startsWith('grp-')) as string
    expect(r[staff]?.names).toEqual(['Java 工程', '多线程 IoT 网关'].sort())
  })

  it('a title shared with the inline tier, or shorter than 4 characters, is only ambiguous', () => {
    const r = curriculumNamesByTier(build, plan)
    expect(r.authenticated?.ambiguous.sort()).toEqual(['IAM', '共享讲名'].sort())
    expect(r.authenticated?.names).not.toContain('共享讲名')
  })

  it('the 说明 of a restricted lecture (first 12 characters) is searched for, unless the inline tier has the same start', () => {
    const withDesc = (g: CurriculumGroup, descs: string[]): CurriculumGroup => ({ ...g, lectures: g.lectures.map((l, i) => (descs[i] ? { ...l, desc: descs[i] } : l)) })
    const b: CurriculumBuild = {
      ...build,
      byLocale: {
        root: data('root', [
          withDesc(group('G06', 'Python 进阶', ['装饰器与闭包']), ['内联组的说明开头一样的文字，其余不同']),
          withDesc(group('G09', 'AWS 云平台', ['VPC 与私有子网设计', '共享讲名', 'IAM']), ['私有子网与路由表的设计要点，含 NAT 网关与端点', '', '内联组的说明开头一样的文字，其余完全不同']),
          group('G12', 'Java 工程', ['多线程 IoT 网关']),
        ]),
      },
    }
    const r = curriculumNamesByTier(b, plan)
    expect(r.authenticated?.names).toContain('私有子网与路由表的设计要')
    expect(r.authenticated?.ambiguous).toContain('内联组的说明开头一样的文')
    expect(r.authenticated?.names).not.toContain('内联组的说明开头一样的文')
    expect(descNeedle({ desc: '  一二三四五六七八九十十一十二十三  ' })).toBe('一二三四五六七八九十十一')
    expect(descNeedle({})).toBe('')
  })

  it('the inline tier gets no entry', () => {
    expect(Object.keys(curriculumNamesByTier(build, plan)).sort()).toEqual(Object.keys(curriculumNamesByTier(build, plan)).filter((k) => k !== plan.inlineTier).sort())
    expect(curriculumNamesByTier(build, plan)[plan.inlineTier]).toBeUndefined()
  })
})
