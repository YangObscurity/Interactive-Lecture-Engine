import { describe, expect, it } from 'vitest'
import { parseLectureDescription, parseLectureTitle } from '../../docs/.vitepress/theme/reading/lectureMeta'
import { chartSourceOf } from '../../docs/.vitepress/theme/charts/sidecar'

describe('reading/lectureMeta', () => {
  it('strips zh and en lecture prefixes while preserving plain titles', () => {
    expect(parseLectureTitle('第19讲 · 多表连接查询与子查询')).toBe('多表连接查询与子查询')
    expect(parseLectureTitle('第01讲 · HearthNet：边缘智能')).toBe('HearthNet：边缘智能')
    expect(parseLectureTitle("Example Lecture 1 · Understanding Ohm's Law")).toBe("Understanding Ohm's Law")
    expect(parseLectureTitle('Lecture 19 · Joins and Subqueries')).toBe('Joins and Subqueries')
    expect(parseLectureTitle('无前缀标题')).toBe('无前缀标题')
  })

  it('extracts nodeId, difficulty stars and estimated minutes across formats', () => {
    expect(
      parseLectureDescription('节点 `db_joins` ｜ 亚组: G05 ｜ 难度 ★★ ｜ 预估 30min ｜ 前置: a ｜ 后续: b'),
    ).toEqual({ nodeId: 'db_joins', difficulty: 2, maxStars: 3, estimated: '30 min' })

    expect(
      parseLectureDescription('Node `example_led` | Subgroup: EX | Difficulty ★ | Estimated 45 min'),
    ).toEqual({ nodeId: 'example_led', difficulty: 1, maxStars: 3, estimated: '45 min' })

    expect(parseLectureDescription('SAPI架构定位、感测与策略解耦')).toEqual({
      nodeId: '',
      difficulty: 0,
      maxStars: 0,
      estimated: '',
    })
  })
})

describe('charts/sidecar chartSourceOf', () => {
  it('supports string code as well as inline options/option objects', () => {
    expect(chartSourceOf({ type: 'echarts', code: '{"a":1}' })).toBe('{"a":1}')
    expect(JSON.parse(chartSourceOf({ type: 'echarts', options: { series: [{ type: 'pie' }] } }))).toEqual({
      series: [{ type: 'pie' }],
    })
    expect(JSON.parse(chartSourceOf({ type: 'echarts', option: { title: { text: 'ok' } } }))).toEqual({
      title: { text: 'ok' },
    })
  })
})
