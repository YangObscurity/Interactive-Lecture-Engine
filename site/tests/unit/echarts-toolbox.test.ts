/**
 * ECharts tool icons vs the engine's enlarge icon (charts/renderers/echarts.ts): a centred title or top legend the engine
 * placed is kept clear of the tool row at the top right; titles and legends the author placed are left alone.
 */
import { describe, expect, it } from 'vitest'
import { normalizeEchartsLayout, type ToolRow } from '../../docs/.vitepress/theme/charts/renderers/echarts'

// the row on a 316 px phone chart: 25 px from the right edge, 3 icons (13 px, gap 8, padding 5) = 65 x 23
const ROW: ToolRow = { right: 25, top: 0, width: 65, height: 23 }
type T = { left?: unknown; top?: unknown; right?: unknown }
const title = (opt: Record<string, unknown>): T => opt.title as T

describe('normalizeEchartsLayout: tool row', () => {
  it('leaves a short centred title where it is', () => {
    const opt: Record<string, unknown> = { title: { text: 'Short' }, xAxis: {}, yAxis: {} }
    normalizeEchartsLayout(opt, 316, 320, ROW)
    expect(title(opt).left).toBe('center')
    expect(title(opt).top).toBe(4)
  })

  it('moves a centred title that would run into the row to the left', () => {
    const opt: Record<string, unknown> = { title: { text: '两组数据，平均值相同' }, xAxis: {}, yAxis: {} }
    normalizeEchartsLayout(opt, 316, 320, ROW)
    expect(title(opt).left).toBe(8)
    expect(title(opt).top).toBe(4)
  })

  it('moves a title too wide to sit beside the row below it', () => {
    const opt: Record<string, unknown> = { title: { text: '一个很长很长的标题放不进工具图标左边' }, xAxis: {}, yAxis: {} }
    normalizeEchartsLayout(opt, 316, 320, ROW)
    expect(title(opt).left).toBe('center')
    expect(title(opt).top).toBe(ROW.top + ROW.height + 2)
  })

  it('keeps a title the author placed', () => {
    const opt: Record<string, unknown> = { title: { text: '两组数据，平均值相同', left: 'center', top: 4 }, xAxis: {}, yAxis: {} }
    const right: Record<string, unknown> = { title: { text: '两组数据，平均值相同', right: 0 }, xAxis: {}, yAxis: {} }
    normalizeEchartsLayout(opt, 316, 320, ROW)
    normalizeEchartsLayout(right, 316, 320, ROW)
    // `left: 'center'` written by the author looks the same as the engine's default: it is avoided too
    expect(title(opt).left).toBe(8)
    expect(title(right).left).toBeUndefined()
    expect(title(right).right).toBe(0)
  })

  it('without a tool row nothing moves (the viewer, a hidden toolbox)', () => {
    const opt: Record<string, unknown> = { title: { text: '两组数据，平均值相同' }, xAxis: {}, yAxis: {} }
    normalizeEchartsLayout(opt, 316, 320)
    expect(title(opt).left).toBe('center')
  })

  it('keeps a wide top legend without a title clear of the row', () => {
    const opt: Record<string, unknown> = { legend: { data: ['第一组读数', '第二组读数', '第三组读数'] }, xAxis: {}, yAxis: {} }
    normalizeEchartsLayout(opt, 316, 320, ROW)
    const l = opt.legend as T
    expect(l.left === 8 || toNum(l.top) >= ROW.top + ROW.height).toBe(true)
  })
})

function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number.NaN
}
