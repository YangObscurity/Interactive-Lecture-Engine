/**
 * progress/notionBridge.ts — when `modules.progress.notionSync` is on, forward the reader's own changes to the
 * existing Notion sync proxy (theme/components/ai/notionSync.ts: queue, throttle, retry, whitelisted payload).
 *
 * Only changes the reader made on this page (`origin: 'user'`) are forwarded: a load, another tab's write or a
 * server reply never produces a Notion call. Chinese status values are produced here, at the protocol boundary.
 *
 * Nothing starts at import time. WP-P2 calls `startNotionBridge()` once on the client when
 * `progressRuntime().notionSync` is true.
 */
import { batchSyncStatusToNotion, syncStatusToNotion } from '../components/ai/notionSync'
import { currentSession } from '../auth/session'
import { progressStore } from './progressStore'
import type { ProgressStore } from './progressStore'
import { toLegacyStatus } from './types'
import type { LegacyProgressStatus } from './types'

export function isNotionSyncAdmin(): boolean {
  const s = currentSession()
  return s.status === 'authenticated' && s.roles.includes('admin')
}

export interface NotionItem {
  lectureId: string
  status: LegacyProgressStatus
  notionNodeId?: string
  notionPageId?: string
}

export interface NotionBridgeOptions {
  store?: ProgressStore
  /** One change: `syncStatusToNotion(lectureId, status, nodeId?, pageId?)`. */
  sync?: (lectureId: string, status: LegacyProgressStatus, notionNodeId?: string, notionPageId?: string) => void
  /** Several changes at once: `batchSyncStatusToNotion(items)`. */
  batch?: (items: NotionItem[]) => void
  /** Gate for admin-only runtime sync; tests injecting mock sync/batch default to allowed unless overridden. */
  canSync?: () => boolean
}

/** Subscribe the bridge. Returns the function that stops it. */
export function startNotionBridge(options: NotionBridgeOptions = {}): () => void {
  const store = options.store ?? progressStore
  const sync = options.sync ?? syncStatusToNotion
  const batch = options.batch ?? batchSyncStatusToNotion
  const canSync = options.canSync ?? (options.sync || options.batch ? () => true : isNotionSyncAdmin)
  return store.subscribe((event) => {
    if (event.kind !== 'change' || event.origin !== 'user') return
    if (!canSync()) return
    try {
      const items: NotionItem[] = event.ids.map((id) => {
        const meta = store.metaOf(id)
        return {
          lectureId: id,
          status: toLegacyStatus(store.statusOf(id)),
          ...(meta.notionNodeId ? { notionNodeId: meta.notionNodeId } : {}),
          ...(meta.notionPageId ? { notionPageId: meta.notionPageId } : {}),
        }
      })
      const [first] = items
      if (first === undefined) return
      if (items.length === 1) sync(first.lectureId, first.status, first.notionNodeId, first.notionPageId)
      else batch(items)
    } catch {
      // Notion is best effort; a failure here must never disturb the reader's progress
    }
  })
}
