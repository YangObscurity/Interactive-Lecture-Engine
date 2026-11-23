import type { CanvasNodeProps } from '../../slots/registry.ts'
import type { CanvasSkinId } from './model.ts'

export type CanvasArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

export interface CanvasNodePos {
  id: string
  x: number
  y: number
}

export function isCanvasArrowKey(key: string): key is CanvasArrowKey {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
}

/** Spatial centre of a canvas lecture node for keyboard arrow navigation. */
export function canvasNodeCenter(node: CanvasNodeProps, skin: CanvasSkinId): CanvasNodePos {
  if (skin === 'datasheet') {
    return { id: node.id, x: node.hitX + node.hitW / 2, y: node.pinY }
  }
  return { id: node.id, x: node.x + node.w / 2, y: node.y + node.h / 2 }
}

/** Pick the nearest node in the requested arrow direction, preferring a 60-degree cone before general half-plane fallback. */
export function pickNextCanvasNode(
  nodes: readonly CanvasNodePos[],
  currentId: string,
  key: CanvasArrowKey,
): string | null {
  const cur = nodes.find((n) => n.id === currentId)
  if (!cur) return nodes[0]?.id ?? null
  const ux = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
  const uy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0

  let bestConeId: string | null = null
  let bestConeScore = Infinity
  let bestHalfId: string | null = null
  let bestHalfScore = Infinity

  for (const n of nodes) {
    if (n.id === currentId) continue
    const dx = n.x - cur.x
    const dy = n.y - cur.y
    const primary = dx * ux + dy * uy
    if (primary <= 1) continue
    const perp = Math.abs(ux === 0 ? dx : dy)
    const score = primary + perp * 2.5 + Math.hypot(dx, dy) * 0.01
    if (primary >= perp * 0.5 && score < bestConeScore) {
      bestConeScore = score
      bestConeId = n.id
    }
    if (score < bestHalfScore) {
      bestHalfScore = score
      bestHalfId = n.id
    }
  }
  return bestConeId ?? bestHalfId
}
