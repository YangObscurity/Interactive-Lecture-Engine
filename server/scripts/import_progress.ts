import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb } from '../src/db/index.js'
import type { Db, DbClient } from '../src/db/types.js'
import {
  deriveGroupId,
  normalizeLectureId,
  type ProgressRow,
  type ProgressStatus,
} from '../src/repo/progress.js'
import { type DbCliOptions, resolveDatabaseConnection } from './db.js'

export const STATUS_MAP: Record<string, ProgressStatus> = {
  已完成: '已完成',
  completed: '已完成',
  done: '已完成',
  学习中: '学习中',
  in_progress: '学习中',
  reading: '学习中',
  未开始: '未开始',
  not_started: '未开始',
  todo: '未开始',
}

export interface RawGraphNode {
  notionPageId?: string | null
  nodeId?: string | null
  id?: string | null
  title?: string
  category?: string
  groupId?: string | null
  group?: string | null
  lectureId?: string | null
  lecturePath?: string | null
  status?: string | null
  completedDate?: string | null
  completed_at?: string | null
  [key: string]: unknown
}

export interface NormalizedProgressItem {
  lectureId: string
  groupId: string
  status: ProgressStatus
  completedAt: string | null
  notionNodeId: string | null
  notionPageId: string | null
  title?: string
}

export interface ProgressImportOptions extends DbCliOptions {
  filePath?: string
  userId?: string
  apply?: boolean
  includeUnstarted?: boolean
  reconcile?: boolean
  prune?: boolean
  curriculumPath?: string
  databaseUrl?: string
}

export interface ProgressDiff {
  newItems: NormalizedProgressItem[]
  changedItems: Array<{
    item: NormalizedProgressItem
    existing: ProgressRow
    reason: string
  }>
  unchangedItems: NormalizedProgressItem[]
}

export interface ProgressImportResult {
  userId: string
  totalInFile: number
  processedCount: number
  newCount: number
  changedCount: number
  unchangedCount: number
  applied: boolean
  diff: ProgressDiff
  orphans?: string[]
  prunedCount?: number
}

// S2: content mode keeps the graph in content/graph/; site/docs/public holds only the synced copy
const DEFAULT_GRAPH_FILE = [
  resolve(dirname(fileURLToPath(import.meta.url)), '../../content/graph/notion_knowledge_graph.json'),
  resolve(dirname(fileURLToPath(import.meta.url)), '../../site/docs/public/notion_knowledge_graph.json'),
].find((f) => existsSync(f)) ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../site/docs/public/notion_knowledge_graph.json')
// no default owner: pass --user-id (or IMPORT_PROGRESS_USER_ID)
const DEFAULT_USER_ID = process.env.IMPORT_PROGRESS_USER_ID ?? ''

function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) return null
    return d.toISOString()
  } catch {
    return null
  }
}

export function parseGraphNodes(fileContent: string): RawGraphNode[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fileContent)
  } catch (err) {
    throw new Error(`Failed to parse JSON file: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (Array.isArray(parsed)) {
    return parsed as RawGraphNode[]
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>
    if (Array.isArray(record.nodes)) {
      return record.nodes as RawGraphNode[]
    }
    if (Array.isArray(record.lectures)) {
      return record.lectures as RawGraphNode[]
    }
  }
  throw new Error('Expected JSON array or an object with "nodes" or "lectures" array')
}

export function resolveCurriculumIds(curriculumPath?: string): Set<string> {
  const ids = new Set<string>()

  if (curriculumPath) {
    const fullPath = resolve(curriculumPath)
    if (!existsSync(fullPath)) {
      throw new Error(`Curriculum file not found: ${fullPath}`)
    }
    const content = readFileSync(fullPath, 'utf8')
    try {
      const nodes = parseGraphNodes(content)
      for (const n of nodes) {
        const rawId = n.lectureId || n.id
        if (rawId) {
          try {
            ids.add(normalizeLectureId(rawId))
          } catch {
            // ignore malformed IDs
          }
        }
      }
      return ids
    } catch {
      // If plain text line by line
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim().toLowerCase()
        if (trimmed && !trimmed.startsWith('#')) {
          try {
            ids.add(normalizeLectureId(trimmed))
          } catch {
            ids.add(trimmed)
          }
        }
      }
      return ids
    }
  }

  // Default discovery
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const defaultGraph = resolve(repoRoot, 'site/docs/public/notion_knowledge_graph.json')
  if (existsSync(defaultGraph)) {
    try {
      const nodes = parseGraphNodes(readFileSync(defaultGraph, 'utf8'))
      for (const n of nodes) {
        if (n.lectureId) {
          try {
            ids.add(normalizeLectureId(n.lectureId))
          } catch {
            // ignore malformed ID
          }
        }
      }
    } catch {
      // ignore graph read error
    }
  }

  // S2: in content mode the graph sources live in content/graph/ (site/data/ is gone)
  const contentGraph = resolve(repoRoot, 'content/graph/graph.json')
  const siteDataGraph = existsSync(contentGraph) ? contentGraph : resolve(repoRoot, 'site/data/graph.json')
  if (existsSync(siteDataGraph)) {
    try {
      const g = JSON.parse(readFileSync(siteDataGraph, 'utf8')) as { nodes?: Array<{ id?: string }> }
      if (Array.isArray(g.nodes)) {
        for (const n of g.nodes) {
          if (n.id) {
            try {
              ids.add(normalizeLectureId(n.id))
            } catch {
              // ignore malformed ID
            }
          }
        }
      }
    } catch {
      // ignore graph read error
    }
  }

  // Scan site/docs for markdown lectures
  const docsDir = resolve(repoRoot, 'site/docs')
  if (existsSync(docsDir)) {
    try {
      const groups = readdirSync(docsDir, { withFileTypes: true })
      for (const g of groups) {
        if (g.isDirectory()) {
          const groupDir = resolve(docsDir, g.name)
          const files = readdirSync(groupDir)
          for (const f of files) {
            if (/^l\d{2,}\.md$/i.test(f)) {
              const lecBase = f.slice(0, -3).toLowerCase()
              ids.add(`${g.name.toLowerCase()}-${lecBase}`)
            }
          }
        }
      }
    } catch {
      // ignore docs scan error
    }
  }

  return ids
}

export async function runProgressImport(
  options: ProgressImportOptions = {},
): Promise<ProgressImportResult> {
  const log = options.log ?? ((msg: string) => console.log(msg))
  const _error = options.error ?? ((msg: string) => console.error(msg))

  const filePath = resolve(options.filePath ?? DEFAULT_GRAPH_FILE)
  const userId = (options.userId ?? DEFAULT_USER_ID).trim()
  if (!userId) {
    throw new Error('No user id: pass --user-id <id> (the Remote-User of the reader whose progress is imported)')
  }
  const apply = Boolean(options.apply)
  const includeUnstarted = Boolean(options.includeUnstarted)
  const reconcile = Boolean(options.reconcile)
  const prune = Boolean(options.prune)

  if (!existsSync(filePath)) {
    throw new Error(`Graph JSON file not found: ${filePath}`)
  }

  let dbUrl = options.databaseUrl
  if (!dbUrl) {
    const resolved = resolveDatabaseConnection(options)
    dbUrl = resolved.dbUrl
  }

  const rawJson = readFileSync(filePath, 'utf8')
  const nodes = parseGraphNodes(rawJson)

  log(`[import_progress] Source file: ${filePath} (${nodes.length} total node(s))`)
  log(`[import_progress] Target user: "${userId}"`)
  log(`[import_progress] Mode: ${apply ? 'APPLY (writing to database)' : 'DRY-RUN (read-only preview)'}`)

  const db: Db = createDb(dbUrl)
  try {
    // 1. Fetch current progress records for this user
    const existingRes = await db.query<ProgressRow>(
      `SELECT lecture_id, group_id, status, completed_at, updated_at, notion_node_id, notion_page_id
       FROM progress
       WHERE user_id = $1
       ORDER BY lecture_id ASC`,
      [userId],
    )
    const existingMap = new Map<string, ProgressRow>()
    for (const row of existingRes.rows) {
      existingMap.set(row.lecture_id.toLowerCase(), row)
    }

    // 2. Normalize and filter candidate items from graph export
    const candidates: NormalizedProgressItem[] = []
    let skippedUnstarted = 0
    let skippedInvalid = 0

    for (const node of nodes) {
      let rawLectureId = node.lectureId || node.id
      if (!rawLectureId && node.lecturePath) {
        // e.g. /g06/L03 -> g06-l03
        const parts = node.lecturePath.split('/').filter(Boolean)
        if (parts.length >= 2) {
          rawLectureId = `${parts[0]}-${parts[1]}`
        }
      }
      if (!rawLectureId) {
        skippedInvalid++
        continue
      }

      let lectureId: string
      try {
        lectureId = normalizeLectureId(rawLectureId)
      } catch {
        skippedInvalid++
        continue
      }

      const rawStatus = (node.status || '').trim()
      const mappedStatus = STATUS_MAP[rawStatus]
      if (!mappedStatus) {
        skippedInvalid++
        continue
      }

      if (mappedStatus === '未开始' && !includeUnstarted) {
        skippedUnstarted++
        continue
      }

      const groupId = (node.groupId || node.group || deriveGroupId(lectureId)).toLowerCase()
      const completedAt = toIsoDate(node.completedDate || node.completed_at)

      candidates.push({
        lectureId,
        groupId,
        status: mappedStatus,
        completedAt,
        notionNodeId: node.nodeId ?? null,
        notionPageId: node.notionPageId ?? null,
        title: node.title,
      })
    }

    log(
      `[import_progress] Candidates: ${candidates.length} (skipped: ${skippedUnstarted} unstarted, ${skippedInvalid} invalid/unmapped)`,
    )

    // 3. Compare candidates with existing database records
    const newItems: NormalizedProgressItem[] = []
    const changedItems: Array<{
      item: NormalizedProgressItem
      existing: ProgressRow
      reason: string
    }> = []
    const unchangedItems: NormalizedProgressItem[] = []

    for (const item of candidates) {
      const existing = existingMap.get(item.lectureId)
      if (!existing) {
        newItems.push(item)
      } else {
        const reasons: string[] = []
        if (existing.status !== item.status) {
          reasons.push(`status: "${existing.status}" -> "${item.status}"`)
        }
        if (existing.group_id.toLowerCase() !== item.groupId) {
          reasons.push(`group: "${existing.group_id}" -> "${item.groupId}"`)
        }
        if (item.notionNodeId && existing.notion_node_id !== item.notionNodeId) {
          reasons.push(`notion_node_id: "${existing.notion_node_id}" -> "${item.notionNodeId}"`)
        }
        if (item.notionPageId && existing.notion_page_id !== item.notionPageId) {
          reasons.push(`notion_page_id: "${existing.notion_page_id}" -> "${item.notionPageId}"`)
        }

        if (reasons.length > 0) {
          changedItems.push({
            item,
            existing,
            reason: reasons.join(', '),
          })
        } else {
          unchangedItems.push(item)
        }
      }
    }

    log('--- DIFF SUMMARY ---')
    log(`  [NEW]       : ${newItems.length}`)
    log(`  [CHANGED]   : ${changedItems.length}`)
    log(`  [UNCHANGED] : ${unchangedItems.length}`)

    if (newItems.length > 0) {
      log('\n[+] New items to insert:')
      for (const item of newItems) {
        log(`    + ${item.lectureId} [${item.status}] (group: ${item.groupId}) ${item.title ?? ''}`)
      }
    }

    if (changedItems.length > 0) {
      log('\n[~] Changed items to update:')
      for (const ch of changedItems) {
        log(`    ~ ${ch.item.lectureId}: ${ch.reason}`)
      }
    }

    // 4. If --apply, write the changes to the database
    if (apply && (newItems.length > 0 || changedItems.length > 0)) {
      log('\n[apply] Writing records to database...')
      const itemsToWrite = [...newItems, ...changedItems.map((c) => c.item)]
      const nowIso = new Date().toISOString()

      await db.tx(async (client: DbClient) => {
        for (const it of itemsToWrite) {
          const compDate = it.completedAt ?? (it.status === '已完成' ? nowIso : null)
          await client.query(
            `INSERT INTO progress (
               user_id,
               lecture_id,
               group_id,
               status,
               completed_at,
               updated_at,
               notion_node_id,
               notion_page_id
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (user_id, lecture_id) DO UPDATE SET
               group_id = EXCLUDED.group_id,
               status = EXCLUDED.status,
               completed_at = COALESCE(EXCLUDED.completed_at, progress.completed_at),
               updated_at = EXCLUDED.updated_at,
               notion_node_id = COALESCE(EXCLUDED.notion_node_id, progress.notion_node_id),
               notion_page_id = COALESCE(EXCLUDED.notion_page_id, progress.notion_page_id)`,
            [
              userId,
              it.lectureId,
              it.groupId,
              it.status,
              compDate,
              nowIso,
              it.notionNodeId,
              it.notionPageId,
            ],
          )
        }
      })
      log(`[apply] Successfully upserted ${itemsToWrite.length} record(s).`)
    } else if (!apply) {
      log('\n[dry-run] Dry-run complete. No changes were written to database. Run with --apply to commit.')
    } else {
      log('\n[apply] Database is already identical to export. Zero rows changed (idempotent no-op).')
    }

    // 5. Reconcile orphans (if requested)
    let orphanIds: string[] | undefined
    let prunedCount = 0

    if (reconcile) {
      log('\n--- CURRICULUM RECONCILIATION ---')
      const curriculum = resolveCurriculumIds(options.curriculumPath)
      log(`[reconcile] Known curriculum lectures count: ${curriculum.size}`)

      // Refresh existing progress rows
      const currentRowsRes = await db.query<ProgressRow>(
        'SELECT lecture_id, group_id, status FROM progress WHERE user_id = $1 ORDER BY lecture_id ASC',
        [userId],
      )
      orphanIds = currentRowsRes.rows
        .map((r) => r.lecture_id.toLowerCase())
        .filter((id) => !curriculum.has(id))

      if (orphanIds.length === 0) {
        log('[reconcile] No orphan progress rows found. All rows belong to current curriculum.')
      } else {
        log(`[reconcile] Found ${orphanIds.length} orphan progress row(s) not in current curriculum:`)
        for (const oid of orphanIds) {
          const row = currentRowsRes.rows.find((r) => r.lecture_id.toLowerCase() === oid)
          log(`    ! [orphan] ${oid} (status: ${row?.status}, group: ${row?.group_id})`)
        }

        if (prune) {
          log(`[prune] Deleting ${orphanIds.length} orphan row(s) for user "${userId}"...`)
          await db.tx(async (client: DbClient) => {
            for (const oid of orphanIds!) {
              await client.query('DELETE FROM progress WHERE user_id = $1 AND lecture_id = $2', [
                userId,
                oid,
              ])
            }
          })
          prunedCount = orphanIds.length
          log(`[prune] Pruned ${prunedCount} orphan row(s).`)
        } else {
          log('[reconcile] Dry-run: orphans were NOT deleted. Re-run with --prune to delete them.')
        }
      }
    }

    return {
      userId,
      totalInFile: nodes.length,
      processedCount: candidates.length,
      newCount: newItems.length,
      changedCount: changedItems.length,
      unchangedCount: unchangedItems.length,
      applied: apply,
      diff: {
        newItems,
        changedItems,
        unchangedItems,
      },
      orphans: orphanIds,
      prunedCount,
    }
  } finally {
    await db.close()
  }
}

export async function runProgressImportCli(
  args: string[] = process.argv.slice(2),
  options: DbCliOptions = {},
): Promise<number> {
  const log = options.log ?? ((msg: string) => console.log(msg))
  const error = options.error ?? ((msg: string) => console.error(msg))

  let filePath: string | undefined
  let userId: string | undefined
  let apply = false
  let includeUnstarted = false
  let reconcile = false
  let prune = false
  let curriculumPath: string | undefined
  let databaseUrl: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--file') {
      const next = args[++i]
      if (!next) {
        error('Missing value for --file')
        return 1
      }
      filePath = next
    } else if (arg.startsWith('--file=')) {
      filePath = arg.slice('--file='.length)
    } else if (arg === '--user-id' || arg === '--user') {
      const next = args[++i]
      if (!next) {
        error(`Missing value for ${arg}`)
        return 1
      }
      userId = next
    } else if (arg.startsWith('--user-id=')) {
      userId = arg.slice('--user-id='.length)
    } else if (arg === '--apply') {
      apply = true
    } else if (arg === '--include-unstarted' || arg === '--all') {
      includeUnstarted = true
    } else if (arg === '--reconcile') {
      reconcile = true
    } else if (arg === '--prune') {
      prune = true
    } else if (arg === '--curriculum') {
      const next = args[++i]
      if (!next) {
        error('Missing value for --curriculum')
        return 1
      }
      curriculumPath = next
    } else if (arg.startsWith('--curriculum=')) {
      curriculumPath = arg.slice('--curriculum='.length)
    } else if (arg === '--database-url') {
      const next = args[++i]
      if (!next) {
        error('Missing value for --database-url')
        return 1
      }
      databaseUrl = next
    } else if (arg.startsWith('--database-url=')) {
      databaseUrl = arg.slice('--database-url='.length)
    } else if (arg === '--help' || arg === '-h') {
      log('Usage: import_progress.ts [--file <path>] [--user-id <id>] [--apply] [--include-unstarted] [--reconcile] [--prune] [--curriculum <path>]')
      return 0
    } else {
      error(`Unknown option: ${arg}`)
      return 1
    }
  }

  if (prune && !reconcile) {
    error('--prune only works together with --reconcile')
    return 1
  }

  try {
    await runProgressImport({
      ...options,
      filePath,
      userId,
      apply,
      includeUnstarted,
      reconcile,
      prune,
      curriculumPath,
      databaseUrl,
      log,
      error,
    })
    return 0
  } catch (err) {
    error(`[import error] ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  const code = await runProgressImportCli()
  if (code !== 0) {
    process.exit(code)
  }
}
