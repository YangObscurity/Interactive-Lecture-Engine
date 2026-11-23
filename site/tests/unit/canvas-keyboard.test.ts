import { describe, expect, it } from 'vitest'
import { canvasNodeCenter, isCanvasArrowKey, pickNextCanvasNode } from '../../docs/.vitepress/theme/map/canvas/keyboard'
import type { CanvasNodeProps } from '../../docs/.vitepress/theme/slots/registry'

function fakeNode(overrides: Partial<CanvasNodeProps> & { id: string }): CanvasNodeProps {
  return {
    number: '01',
    pinNumber: 1,
    label: overrides.id,
    status: 'unread',
    hover: false,
    locked: false,
    active: false,
    match: false,
    x: 0,
    y: 0,
    w: 160,
    h: 32,
    pinX: 0,
    pinY: 0,
    tipX: 0,
    pinSide: 1,
    legLen: 20,
    nameX: 28,
    hitX: 0,
    hitW: 140,
    ...overrides,
  }
}

describe('canvas keyboard navigation', () => {
  it('recognizes only the four arrow keys', () => {
    expect(isCanvasArrowKey('ArrowRight')).toBe(true)
    expect(isCanvasArrowKey('ArrowDown')).toBe(true)
    expect(isCanvasArrowKey('Enter')).toBe(false)
  })

  it('picks the nearest neighbour in each arrow direction', () => {
    const grid = [
      { id: 'n1', x: 100, y: 100 },
      { id: 'n2', x: 300, y: 100 },
      { id: 'n3', x: 100, y: 200 },
      { id: 'n4', x: 300, y: 200 },
    ]
    expect(pickNextCanvasNode(grid, 'n1', 'ArrowRight')).toBe('n2')
    expect(pickNextCanvasNode(grid, 'n1', 'ArrowDown')).toBe('n3')
    expect(pickNextCanvasNode(grid, 'n4', 'ArrowLeft')).toBe('n3')
    expect(pickNextCanvasNode(grid, 'n4', 'ArrowUp')).toBe('n2')
    expect(pickNextCanvasNode(grid, 'n1', 'ArrowLeft')).toBeNull()
    expect(pickNextCanvasNode(grid, 'n1', 'ArrowUp')).toBeNull()
  })

  it('computes node centres differently for reader boxes and datasheet pins', () => {
    const n = fakeNode({ id: 'g01-l01', x: 20, y: 40, w: 160, h: 30, hitX: 10, hitW: 120, pinY: 85 })
    expect(canvasNodeCenter(n, 'reader')).toEqual({ id: 'g01-l01', x: 100, y: 55 })
    expect(canvasNodeCenter(n, 'datasheet')).toEqual({ id: 'g01-l01', x: 70, y: 85 })
  })
})
