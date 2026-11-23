/**
 * tests/e2e/demo.ts - what the e2e specs expect of the demo content, read from the demo itself (templates/demo-content,
 * the content `npm run build:e2e` builds) instead of being written into each spec: the groups in the order groups.ts
 * declares them, their categories, the lecture files of every group and the access tiers of access.e2e.json.
 * S6X grew the demo to 9 groups in 3 categories; a later change of the demo only needs the specs that check a
 * particular lecture to follow.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS } from '../../../templates/demo-content/groups'

export const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'templates', 'demo-content')

export interface DemoGroup {
  id: string
  dir: string
  title: string
  category: string
  categoryEn: string
  /** lecture numbers with a file lectures/<dir>/Lnn.md, ascending */
  lectures: number[]
}

function lectureNumbers(dir: string): number[] {
  return fs
    .readdirSync(path.join(DEMO_DIR, 'lectures', dir))
    .map((f) => /^L(\d+)\.md$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
}

export const DEMO_GROUPS: DemoGroup[] = GROUPS.map((g) => ({
  id: g.id,
  dir: g.dir,
  title: g.title,
  category: g.category,
  categoryEn: g.i18n?.en?.category ?? g.category,
  lectures: lectureNumbers(g.dir),
}))

export const DEMO_GROUP_IDS: string[] = DEMO_GROUPS.map((g) => g.id)
export const DEMO_GROUP_DIRS: string[] = DEMO_GROUPS.map((g) => g.dir)
export const DEMO_LECTURE_COUNT: number = DEMO_GROUPS.reduce((n, g) => n + g.lectures.length, 0)
/** the categories in first-appearance order */
export const DEMO_CATEGORIES: string[] = [...new Set(DEMO_GROUPS.map((g) => g.category))]

export function demoGroup(id: string): DemoGroup {
  const g = DEMO_GROUPS.find((x) => x.id === id || x.dir === id)
  if (!g) throw new Error(`demo content has no group ${id}`)
  return g
}

const ACCESS = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'access.e2e.json'), 'utf8')) as { groups?: Record<string, unknown> }
/** the groups access.e2e.json restricts (PLN, DAT) */
export const DEMO_RESTRICTED_IDS: string[] = Object.keys(ACCESS.groups ?? {})
/** the groups the access build ships inline, in groups.ts order */
export const DEMO_INLINE_IDS: string[] = DEMO_GROUP_IDS.filter((id) => !DEMO_RESTRICTED_IDS.includes(id))

/** `mea-l04` style id of lecture `n` of the group in folder `dir` */
export function lectureId(dir: string, n: number): string {
  return `${dir}-l${String(n).padStart(2, '0')}`
}

/** the prerequisite edges written as `requires:` in the frontmatter of the demo lectures, as [prerequisite, lecture] ids */
export const DEMO_REQUIRES: Array<[string, string]> = DEMO_GROUPS.flatMap((g) =>
  g.lectures.flatMap((n) => {
    const src = fs.readFileSync(path.join(DEMO_DIR, 'lectures', g.dir, `L${String(n).padStart(2, '0')}.md`), 'utf8')
    const m = /^requires:\s*\[([^\]]*)\]/m.exec(src)
    const refs = (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    return refs.map((r): [string, string] => {
      const [dir, l] = r.includes('/') ? (r.split('/') as [string, string]) : [g.dir, r]
      return [lectureId(dir, Number(l.replace(/^L/, ''))), lectureId(g.dir, n)]
    })
  }),
)

/** direct prerequisites and direct follow-ups of a lecture (every edge of the curriculum, see DEMO_EDGES) */
export function demoNeighbours(id: string): { pre: string[]; post: string[] } {
  return { pre: DEMO_EDGES.filter(([, b]) => b === id).map(([a]) => a), post: DEMO_EDGES.filter(([a]) => a === id).map(([, b]) => b) }
}

const GRAPH = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'graph', 'graph.json'), 'utf8')) as { nodes: Array<{ id: string; lecture?: string }>; edges: Array<[string, string]> }
const LECTURE_OF_NODE = new Map(GRAPH.nodes.filter((n) => n.lecture).map((n) => [n.id, n.lecture as string]))
const idOfLink = (link: string): string => {
  const [, dir, l] = /^\/([^/]+)\/L(\d+)/.exec(link) ?? []
  return lectureId(dir ?? '?', Number(l))
}

/** every prerequisite edge of the demo curriculum: `requires:` plus graph/graph.json, as [prerequisite, lecture] ids */
export const DEMO_EDGES: Array<[string, string]> = (() => {
  const keys = new Set(DEMO_REQUIRES.map(([a, b]) => `${a}>${b}`))
  const out = [...DEMO_REQUIRES]
  for (const [a, b] of GRAPH.edges) {
    const la = LECTURE_OF_NODE.get(a)
    const lb = LECTURE_OF_NODE.get(b)
    if (!la || !lb) continue
    const e: [string, string] = [idOfLink(la), idOfLink(lb)]
    if (!keys.has(`${e[0]}>${e[1]}`)) {
      keys.add(`${e[0]}>${e[1]}`)
      out.push(e)
    }
  }
  return out
})()

/** the pairs of groups joined by at least one cross-group edge, as `A|B` with the ids sorted (the canvas bundles) */
export const DEMO_CROSS_PAIRS: string[] = [
  ...new Set(
    DEMO_EDGES.map(([a, b]) => [demoGroup(a.split('-')[0] as string).id, demoGroup(b.split('-')[0] as string).id])
      .filter(([x, y]) => x !== y)
      .map((p) => p.sort().join('|')),
  ),
].sort()

const SEED_GRAPH = JSON.parse(fs.readFileSync(path.join(DEMO_DIR, 'graph', 'notion_knowledge_graph.json'), 'utf8')) as Array<{
  lectureId?: string
  status?: string
}>

/** Non-unread lecture statuses seeded by `graph/notion_knowledge_graph.json`. */
export const DEMO_SEED_STATUS: Record<string, 'read' | 'reading'> = Object.fromEntries(
  SEED_GRAPH.flatMap((n): Array<[string, 'read' | 'reading']> => {
    const id = n.lectureId?.toLowerCase()
    if (!id) return []
    if (n.status === '已完成') return [[id, 'read']]
    if (n.status === '学习中') return [[id, 'reading']]
    return []
  }),
)
