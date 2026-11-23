/**
 * progress/seed.data.mts — VitePress data loader (build time): seed records from the Notion knowledge-graph
 * export `docs/public/notion_knowledge_graph.json` (missing or unreadable file -> empty seed).
 *
 * P3b: only nodes of the inline access tier go into the seed (nodes of restricted groups arrive with their tier's
 * graph.json, client side); with no restricted tier every node is kept, as before.
 *
 * Do NOT import this from code that runs on every page: VitePress inlines the data into the importing chunk.
 * progressStore.ts loads it with a dynamic `import()` on the client, so it becomes its own chunk, fetched only
 * after the page is up.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSeed, EMPTY_SEED } from './seed.ts'
import type { SeedData } from './seed.ts'
import { loadLectureConfig } from '../../content/config.mts'
import { resolveContent, watchExistingFrom } from '../../content/paths.mts'
import { resolveAccessWithoutGroups } from '../../access/build.mts'
import { lookupTier } from '../../access/tiers.ts'
import { groupIdOfGraphNode } from '../../access/siteData.ts'
import type { GraphNodeLike } from '../../access/siteData.ts'

declare const data: SeedData
export { data }

const here = path.dirname(fileURLToPath(import.meta.url))
const contentPaths = resolveContent()

/** Nodes that belong in the seed of this build: no group, or a group whose tier is the inline tier. */
function inlineNodes(nodes: unknown[]): unknown[] {
  const lectureConfig = loadLectureConfig({ paths: contentPaths })
  const plan = resolveAccessWithoutGroups(lectureConfig.access)
  if (plan.tiers.length === 0 && plan.removedGroupIds.length === 0 && plan.buildGroups === null) return nodes
  return nodes.filter((n) => {
    const gid = typeof n === 'object' && n !== null ? groupIdOfGraphNode(n as GraphNodeLike) : null
    return gid === null || lookupTier(plan, gid) === plan.inlineTier
  })
}

export default {
  watch: watchExistingFrom(here, [contentPaths.graphDir.notionKnowledgeGraph], contentPaths.mode),
  load(files: string[]): SeedData {
    const file = files[0]
    if (!file) return EMPTY_SEED
    try {
      const nodes: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      return buildSeed(Array.isArray(nodes) ? inlineNodes(nodes) : nodes)
    } catch {
      return EMPTY_SEED
    }
  },
}
