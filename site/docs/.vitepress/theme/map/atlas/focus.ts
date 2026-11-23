/**
 * map/atlas/focus.ts - hover highlight, search hits and jumps of the atlas (P4a WP-H2; prototype `atlasFocus`, `upPath`,
 * `downAll`, `visRep`, `atlasSearch`, `atlasJump`). Pure.
 *
 * Hovering a lecture lights its branch up to the centre and the branches of its direct prerequisites and follow-ups; one
 * that sits in a collapsed branch is shown on the row that holds it (`visRep`). Hovering anything else lights its branch
 * and everything open below it.
 */
import type { AtlasLayout, LaidNode } from './layout.ts'
import { lectureMatches } from './model.ts'
import type { AtlasNode, AtlasTree } from './model.ts'

export interface AtlasFocus {
  /** The hovered node. */
  hover: string
  /** Nodes on a lit branch (and the ids of their links, a link is named by its child). */
  on: ReadonlySet<string>
  links: ReadonlySet<string>
  /** Rows that hold a direct prerequisite / follow-up of the hovered lecture. */
  pre: ReadonlySet<string>
  post: ReadonlySet<string>
}

/** The row that shows `node` now: itself, or the highest collapsed ancestor that hides it. */
export function visibleRep(node: AtlasNode, layout: AtlasLayout): AtlasNode {
  let r = node
  for (let p = node.parent; p && p.kind !== 'root'; p = p.parent) {
    if (!(layout.all.get(p.id) as LaidNode).open) r = p
  }
  return r
}

export function computeFocus(tree: AtlasTree, layout: AtlasLayout, hoverId: string): AtlasFocus | null {
  const start = tree.byId.get(hoverId)
  const startL = layout.all.get(hoverId)
  if (!start || !startL || !startL.vis) return null
  const on = new Set<string>()
  const links = new Set<string>()
  const pre = new Set<string>()
  const post = new Set<string>()
  const up = (x: AtlasNode): void => {
    for (let p: AtlasNode | null = x; p && p.kind !== 'root'; p = p.parent) {
      on.add(p.id)
      links.add(p.id)
    }
  }
  const down = (x: AtlasNode): void => {
    for (const k of x.kids) {
      if (!(layout.all.get(k.id) as LaidNode).vis) continue
      on.add(k.id)
      links.add(k.id)
      down(k)
    }
  }
  up(start)
  if (start.kind !== 'lec') {
    down(start)
  } else {
    for (const id of tree.pre.get(start.id) ?? []) {
      const o = tree.byId.get(id)
      if (!o) continue
      const rep = visibleRep(o, layout)
      up(rep)
      pre.add(rep.id)
    }
    for (const id of tree.post.get(start.id) ?? []) {
      const o = tree.byId.get(id)
      if (!o) continue
      const rep = visibleRep(o, layout)
      up(rep)
      post.add(rep.id)
    }
  }
  return { hover: hoverId, on, links, pre, post }
}

export type NodeHighlight = '' | 'on' | 'hover' | 'pre' | 'post'

/** What one node shows under a focus (the hovered node wins over `pre` / `post`, which win over `on`). */
export function highlightOf(focus: AtlasFocus | null, id: string): NodeHighlight {
  if (!focus) return ''
  if (focus.hover === id) return 'hover'
  if (focus.pre.has(id)) return 'pre'
  if (focus.post.has(id)) return 'post'
  return focus.on.has(id) ? 'on' : ''
}

// ---- search -----------------------------------------------------------------------------------------------------

/** Lecture ids that match the query, in reading order. */
export function searchHits(tree: AtlasTree, query: string): string[] {
  if (!query) return []
  const out: string[] = []
  for (const l of tree.lectures) if (lectureMatches(l, l.groupId, query)) out.push(l.id)
  return out
}

/** Rows that light up for the hits: the lecture itself or the collapsed row that holds it. */
export function matchRows(tree: AtlasTree, layout: AtlasLayout, hits: readonly string[]): Set<string> {
  const rows = new Set<string>()
  for (const id of hits) {
    const n = tree.byId.get(id)
    if (n) rows.add(visibleRep(n, layout).id)
  }
  return rows
}

/** Branches that have to be open for `node` to show: every ancestor between it and its category. */
export function ancestorsToOpen(node: AtlasNode): string[] {
  const ids: string[] = []
  for (let p = node.parent; p && p.kind !== 'cat' && p.kind !== 'root'; p = p.parent) ids.push(p.id)
  return ids
}
