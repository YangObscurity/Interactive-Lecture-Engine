#!/usr/bin/env node
/**
 * scripts/check_search_dist.mjs - Verifies search index structure and size budgets on dist/.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDistSearchBudgets } from '../docs/.vitepress/search/budget.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SITE_DIR = path.resolve(__dirname, '..')
const distArg = process.argv.indexOf('--dist')
const distDir = path.resolve(
  distArg > -1 && process.argv[distArg + 1]
    ? process.argv[distArg + 1]
    : path.join(SITE_DIR, 'docs', '.vitepress', 'dist'),
)

const report = checkDistSearchBudgets(distDir)
for (const [loc, summary] of Object.entries(report.locales)) {
  console.log(
    `[search-dist] ${loc}: titles=${(summary.titleBytes / 1024).toFixed(1)} KB, shards=${summary.shardCount} (${(summary.shardBytes / 1024 / 1024).toFixed(2)} MB compressed / ${(summary.rawShardBytes / 1024 / 1024).toFixed(2)} MB raw)`,
  )
}
if (!report.ok) {
  for (const f of report.failures) console.error(`[search-dist] FAIL ${f}`)
  process.exit(1)
}
console.log('[search-dist] PASS')
