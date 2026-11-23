/**
 * map/atlas/model.ts - the atlas tree and what is open in it (P4a WP-H2; prototype v16 `atlasTree`, `isOpen`, v17 presets).
 *
 * Pure: no Vue, no DOM. The tree is built once from the curriculum data (centre > category > group > phase > lecture)
 * and never changes with progress; statuses, the expansion choice and text widths are inputs of the layout (layout.ts).
 *
 * Ids: group `G05`, phase `G05/s2`, lecture `g05-l19` (the progress store's id), category `cat-<slot>`, centre `root`.
 */
import type { CurriculumData } from '../../../curriculum/data.ts'
import type { AtlasStatus } from '../../slots/registry.ts'

export type { AtlasStatus }
export type AtlasKind = 'root' | 'cat' | 'group' | 'stage' | 'lec'

/** The four expansion choices of the toolbar (prototype `AX.preset`). */
export const ATLAS_PRESETS = ['reading', 'progress', 'all', 'none'] as const
export type AtlasPreset = (typeof ATLAS_PRESETS)[number]
export const DEFAULT_ATLAS_PRESET: AtlasPreset = 'reading'

export function isAtlasPreset(value: unknown): value is AtlasPreset {
  return typeof value === 'string' && (ATLAS_PRESETS as readonly string[]).includes(value)
}

export interface AtlasLec {
  id: string
  n: number
  title: string
  link: string
  groupId: string
  untranslated: boolean
}

export interface AtlasGroupRef {
  id: string
  dir: string
  title: string
  slot: number
  category: string
}

export interface AtlasNode {
  kind: AtlasKind
  id: string
  /** Colour slot 1-8 (`--lec-cat-<slot>`); the centre has 0. */
  slot: number
  /** -1 left of the centre, 1 right; the centre has 0. Every descendant has the side of its category. */
  side: -1 | 0 | 1
  /** 0 centre, 1 category, 2 group, 3 phase, 4 lecture. */
  depth: number
  parent: AtlasNode | null
  kids: AtlasNode[]
  /** Every lecture below this node (a lecture: itself), in reading order. */
  lec: AtlasLec[]
  /** Category name, group title, phase name, lecture title. */
  name: string
  group: AtlasGroupRef | null
  lecture: AtlasLec | null
  /** Index among the phases of its group / among the categories. */
  idx: number
}

export interface AtlasTree {
  root: AtlasNode
  byId: Map<string, AtlasNode>
  lectures: AtlasLec[]
  groups: AtlasNode[]
  /** lecture id -> direct prerequisites / direct follow-ups. */
  pre: Map<string, string[]>
  post: Map<string, string[]>
}

const numericCollator = new Intl.Collator('en', { numeric: true })

function makeNode(kind: AtlasKind, id: string, depth: number, parent: AtlasNode | null, slot: number, name: string): AtlasNode {
  return { kind, id, slot, side: 0, depth, parent, kids: [], lec: [], name, group: null, lecture: null, idx: 0 }
}

/** Categories go left or right (order kept on each side) so that both sides hold about half of the lectures (prototype). */
export function splitSides(sizes: readonly number[]): Array<-1 | 1> {
  const n = sizes.length
  const total = sizes.reduce((a, b) => a + b, 0)
  if (n === 0) return []
  if (n > 16) {
    // too many categories for the exhaustive search (the site has 8 colour slots): fill the left side greedily, largest first
    let left = 0
    const goesLeft = new Set<number>()
    ;[...sizes.keys()].sort((a, b) => (sizes[b] as number) - (sizes[a] as number)).forEach((i) => {
      if (left === 0 || 2 * (left + (sizes[i] as number)) <= total) {
        left += sizes[i] as number
        goesLeft.add(i)
      }
    })
    return sizes.map((_, i) => (goesLeft.has(i) ? -1 : 1))
  }
  let best = 1
  let bd = Infinity
  for (let m = 1; m < 1 << n; m += 2) {
    let sum = 0
    for (let i = 0; i < n; i++) if (m & (1 << i)) sum += sizes[i] as number
    const d = Math.abs(2 * sum - total)
    if (d < bd) {
      bd = d
      best = m
    }
  }
  return sizes.map((_, i) => (best & (1 << i) ? -1 : 1))
}

export function buildAtlasTree(data: CurriculumData): AtlasTree {
  const root = makeNode('root', 'root', 0, null, 0, '')
  const byId = new Map<string, AtlasNode>([['root', root]])
  const lectures: AtlasLec[] = []
  const groups: AtlasNode[] = []
  const cats = new Map<string, AtlasNode>()

  const ordered = data.groups.slice().sort((a, b) => a.catSlot - b.catSlot || numericCollator.compare(a.id, b.id))
  for (const g of ordered) {
    const key = `${g.catSlot}\u0000${g.category}`
    let cat = cats.get(key)
    if (!cat) {
      const taken = [...byId.keys()].filter((k) => k.startsWith(`cat-${g.catSlot}`)).length
      cat = makeNode('cat', taken === 0 ? `cat-${g.catSlot}` : `cat-${g.catSlot}-${taken}`, 1, root, g.catSlot, g.category)
      cat.idx = root.kids.length
      cats.set(key, cat)
      root.kids.push(cat)
      byId.set(cat.id, cat)
    }
    const ref: AtlasGroupRef = { id: g.id, dir: g.dir, title: g.title, slot: g.catSlot, category: g.category }
    const lecs: AtlasLec[] = g.lectures
      .slice()
      .sort((a, b) => a.n - b.n)
      .map((l) => ({ id: l.id, n: l.n, title: l.title, link: l.link, groupId: g.id, untranslated: l.untranslated === true }))
    const gn = makeNode('group', g.id, 2, cat, g.catSlot, g.title)
    gn.group = ref
    gn.lec = lecs
    cat.kids.push(gn)
    cat.lec = cat.lec.concat(lecs)
    root.lec = root.lec.concat(lecs)
    byId.set(gn.id, gn)
    groups.push(gn)
    lectures.push(...lecs)

    const leaves = lecs.map((l) => {
      const leaf = makeNode('lec', l.id, 4, null, g.catSlot, l.title)
      leaf.group = ref
      leaf.lecture = l
      leaf.lec = [l]
      byId.set(leaf.id, leaf)
      return leaf
    })
    if (g.phases.length > 0 && leaves.length > 0) {
      const buckets: AtlasNode[][] = g.phases.map(() => [])
      for (const leaf of leaves) {
        const n = (leaf.lecture as AtlasLec).n
        let k = g.phases.findIndex((p) => n >= p.from && n <= p.to)
        if (k < 0) {
          // a lecture outside every phase joins the last phase that starts before it (or the first one)
          k = 0
          g.phases.forEach((p, i) => {
            if (p.from <= n) k = i
          })
        }
        ;(buckets[k] as AtlasNode[]).push(leaf)
      }
      g.phases.forEach((p, k) => {
        const part = buckets[k] as AtlasNode[]
        if (part.length === 0) return
        const st = makeNode('stage', `${g.id}/s${k}`, 3, gn, g.catSlot, p.name)
        st.group = ref
        st.idx = gn.kids.length
        st.kids = part
        st.lec = part.map((x) => x.lecture as AtlasLec)
        part.forEach((x) => {
          x.parent = st
        })
        gn.kids.push(st)
        byId.set(st.id, st)
      })
    } else {
      leaves.forEach((x) => {
        x.parent = gn
      })
      gn.kids = leaves
    }
  }

  const sides = splitSides(root.kids.map((c) => c.lec.length))
  const setSide = (n: AtlasNode, side: -1 | 1): void => {
    n.side = side
    n.kids.forEach((k) => setSide(k, side))
  }
  root.kids.forEach((c, i) => setSide(c, sides[i] as -1 | 1))

  const pre = new Map<string, string[]>()
  const post = new Map<string, string[]>()
  for (const [from, to] of data.edges) {
    if (!byId.has(from) || !byId.has(to)) continue
    ;(pre.get(to) ?? pre.set(to, []).get(to) ?? []).push(from)
    ;(post.get(from) ?? post.set(from, []).get(from) ?? []).push(to)
  }
  return { root, byId, lectures, groups, pre, post }
}

// ---- counts and expansion ---------------------------------------------------------------------------------------

export interface AtlasCount {
  read: number
  reading: number
}
export type AtlasCounts = ReadonlyMap<string, AtlasCount>

/** Read / reading lectures below every node. */
export function countStatuses(tree: AtlasTree, statuses: ReadonlyMap<string, AtlasStatus>): Map<string, AtlasCount> {
  const out = new Map<string, AtlasCount>()
  for (const [id, node] of tree.byId) {
    if (node.kind === 'lec') continue
    let read = 0
    let reading = 0
    for (const l of node.lec) {
      const s = statuses.get(l.id)
      if (s === 'read') read++
      else if (s === 'reading') reading++
    }
    out.set(id, { read, reading })
  }
  return out
}

export interface AtlasExpansion {
  preset: AtlasPreset
  /** Per-node choices made after the preset (a `+` / `-`, a search jump, a double click); a new preset clears them. */
  open: Readonly<Record<string, boolean>>
}

/** Is `node` drawn open (its children visible)? Centre and categories always are; lectures never. */
export function isNodeOpen(node: AtlasNode, counts: AtlasCounts, exp: AtlasExpansion): boolean {
  if (node.kind === 'root' || node.kind === 'cat') return true
  if (node.kind === 'lec' || node.kids.length === 0) return false
  const own = exp.open[node.id]
  if (own !== undefined) return own
  const c = counts.get(node.id) ?? { read: 0, reading: 0 }
  switch (exp.preset) {
    case 'all':
      return true
    case 'none':
      return false
    case 'progress':
      return c.read + c.reading > 0
    default:
      return node.kind === 'group' ? c.reading > 0 : c.read + c.reading > 0
  }
}

// ---- names ------------------------------------------------------------------------------------------------------

/** Group package name (spec board 13.1 and 12): `SOIC` up to 8 lectures, else `DIP`; pins = the lecture count made even. */
export function packageName(lectures: number): string {
  return `${lectures <= 8 ? 'SOIC' : 'DIP'}-${lectures + (lectures % 2)}`
}

export const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Search: a lecture matches when its title contains the query (lower case) or the query is `g05-l19`. */
export function lectureMatches(lec: AtlasLec, groupLabel: string, query: string): boolean {
  if (!query) return false
  return lec.title.toLowerCase().includes(query) || `${groupLabel}-L${pad2(lec.n)}`.toLowerCase() === query
}
