/**
 * theme/search/engine.ts - Split search runtime (title-index first + lazy deflated shards + access isolation).
 *
 * Designed for <100 ms first results from `titles.json` while per-group body shards stream in background
 * with real byte progress. Restricted tiers live exclusively under `/_access/<tier>/search/<locale>/...`
 * and are only requested when `themeConfig.lectureAccess.tiers` is non-empty and the gateway authorizes them.
 */
import { inflateTitleHeadings, stripLectureTitlePrefix, type SearchManifestFile, type ShardMeta, type ShardPayload, type TitleIndexFile, type TitleIndexGroup } from '../../search/format.ts'
import { tierBasePath } from '../../access/tiers.ts'
import { lectureAccessOf, getAccess, invalidateAccess } from '../access/store.ts'
import { parseLecture } from '../core/route.ts'
import type { ProgressStatus } from '../progress/types.ts'
import type { SearchGroupSectionView, SearchHighlightPart, SearchHitView, SearchLoadState } from '../slots/registry.ts'

export interface ClientTitleDoc {
  tierId?: string
  groupId: string
  groupTitle: string
  catSlot: number
  lectureId: string
  lectureNo: number | null
  code: string
  url: string
  fullTitle: string
  displayTitle: string
  searchLower: string
  aliases: string[]
  aliasesLower: string[]
  conceptGroups: string[]
  isConcept: boolean
  headings: Array<{
    anchor: string
    text: string
    path: string[]
    crumb: string
    searchLower: string
  }>
}

export interface ClientBodySection {
  groupId: string
  groupTitle: string
  lectureId: string
  lectureNo: number | null
  code: string
  url: string
  displayTitle: string
  anchor: string
  crumb: string
  text: string
  textLower: string
}

interface ShardQueueItem {
  key: string
  locale: string
  meta: ShardMeta
  url: string
  credentials: RequestCredentials
  cache: RequestCache
}

export interface LocaleIndexState {
  locale: string
  titleLoaded: boolean
  titleLoading: Promise<void> | null
  manifestLoaded: boolean
  manifestLoading: Promise<void> | null
  accessLoading: Promise<void> | null
  accessFetchError: boolean
  tierTitlesLoaded: Set<string>
  tierManifestsLoaded: Set<string>
  failedTierIds: Set<string>
  loadError: boolean
  groups: TitleIndexGroup[]
  groupOrder: Map<string, number>
  docsByUrl: Map<string, ClientTitleDoc>
  titleDocs: ClientTitleDoc[]
  sectionsByShard: Map<string, ClientBodySection[]>
  pendingShards: ShardQueueItem[]
  failedShardsByKey: Map<string, ShardQueueItem>
  loadedShardKeys: Set<string>
  failedShardKeys: Set<string>
  inFlightBytes: Map<string, number>
  finishedBytes: Map<string, number>
  shardBytesByKey: Map<string, number>
  totalShardBytes: number
  shardsPumpPromise: Promise<void> | null
}

const REGEX_ESC_RE = /[.*+?^${}()|[\]\\]/g

/** Extract non-empty unique query terms preserving original casing order and full phrase. */
export function parseQueryTerms(raw: string): string[] {
  const clean = raw.trim()
  if (!clean) return []
  const parts = clean.split(/\s+/).filter(Boolean)
  const unique: string[] = []
  for (const p of parts) {
    if (!unique.some((u) => u.toLowerCase() === p.toLowerCase())) unique.push(p)
  }
  return unique
}

/** Split `text` into highlighted and plain slices without using HTML strings. */
export function splitHighlightParts(text: string, terms: readonly string[]): SearchHighlightPart[] {
  if (!text || terms.length === 0) return text ? [{ text, hit: false }] : []
  const sorted = [...terms].sort((a, b) => b.length - a.length)
  const re = new RegExp(`(${sorted.map((t) => t.replace(REGEX_ESC_RE, '\\$&')).join('|')})`, 'gi')
  const parts: SearchHighlightPart[] = []
  let lastIdx = 0
  for (const match of text.matchAll(re)) {
    const idx = match.index ?? 0
    if (idx > lastIdx) parts.push({ text: text.slice(lastIdx, idx), hit: false })
    if (match[0]) parts.push({ text: match[0], hit: true })
    lastIdx = idx + match[0].length
  }
  if (lastIdx < text.length) parts.push({ text: text.slice(lastIdx), hit: false })
  return parts
}

/** Slice a clean ~130-character snippet centered near the best hit match. */
export function buildSnippet(text: string, terms: readonly string[], maxLen = 136): string {
  if (!text) return ''
  const lower = text.toLowerCase()
  const fullPhrase = terms.join(' ').toLowerCase()
  let bestAt = fullPhrase ? lower.indexOf(fullPhrase) : -1
  if (bestAt < 0) {
    for (const t of terms) {
      const idx = lower.indexOf(t.toLowerCase())
      if (idx >= 0 && (bestAt < 0 || idx < bestAt)) bestAt = idx
    }
  }
  if (bestAt < 0 || text.length <= maxLen) {
    return text.length > maxLen ? `${text.slice(0, maxLen).trimEnd()}…` : text
  }
  const start = Math.max(0, bestAt - 36)
  const end = Math.min(text.length, start + maxLen)
  const slice = text.slice(start, end).trim()
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`
}

async function decompressDeflateRaw(buf: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is not supported in this runtime')
  }
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  const stream = new Blob([ab]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return await new Response(stream).text()
}

export async function fetchCompressedShard(
  url: string,
  credentials: RequestCredentials,
  fetchFn: typeof fetch,
  onProgress: (bytesReceived: number) => void,
  cache: RequestCache = 'default',
): Promise<ShardPayload | null> {
  const res = await fetchFn(url, {
    credentials,
    redirect: 'manual',
    cache,
  })
  if (res.status !== 200) return null

  let rawBytes: Uint8Array
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        received += value.byteLength
        onProgress(received)
      }
    }
    rawBytes = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      rawBytes.set(chunk, offset)
      offset += chunk.byteLength
    }
  } else {
    const ab = await res.arrayBuffer()
    rawBytes = new Uint8Array(ab)
    onProgress(rawBytes.byteLength)
  }

  // Gracefully accept plain JSON if a test route fulfilled uncompressed JSON directly
  if (rawBytes[0] === 0x7b /* '{' */) {
    const txt = new TextDecoder().decode(rawBytes)
    return JSON.parse(txt) as ShardPayload
  }

  const text = await decompressDeflateRaw(rawBytes)
  return JSON.parse(text) as ShardPayload
}

export type SearchLabelValue = string | (() => string)

function resolveDynamicLabel(val?: SearchLabelValue): string {
  return typeof val === 'function' ? val() : (val ?? '')
}

export interface SearchEngineOptions {
  base: string
  localeKeys: readonly string[]
  siteData: () => unknown
  statusOf: (lectureId: string) => ProgressStatus
  labels: {
    lectureNo: (n: number) => string
    groupCount: (n: number) => string
    groupSite: string
    groupConcepts?: string
    conceptBadge?: string
    loadingBar: (loadedMb: string, totalMb: string) => string
    loadingIdle: (loadedMb: string, totalMb: string) => string
    loadingTitles?: SearchLabelValue
    loadError?: SearchLabelValue
    statusLabel: (status: ProgressStatus) => string
  }
  fetchFn?: typeof fetch
  onStateChange?: () => void
}

interface CandidateMatch {
  score: number
  id: string
  href: string
  groupId: string
  groupTitle: string
  catSlot: number
  lectureNo: number | null
  code: string
  displayTitle: string
  crumb: string
  snippetSource: string
}

export class LectureSearchEngine {
  private readonly states = new Map<string, LocaleIndexState>()
  private readonly opts: SearchEngineOptions
  private readonly fetchImpl: typeof fetch

  constructor(opts: SearchEngineOptions) {
    this.opts = opts
    this.fetchImpl = opts.fetchFn ?? fetch.bind(globalThis)
  }

  private getOrCreateState(locale: string): LocaleIndexState {
    let st = this.states.get(locale)
    if (!st) {
      st = {
        locale,
        titleLoaded: false,
        titleLoading: null,
        manifestLoaded: false,
        manifestLoading: null,
        accessLoading: null,
        accessFetchError: false,
        tierTitlesLoaded: new Set(),
        tierManifestsLoaded: new Set(),
        failedTierIds: new Set(),
        loadError: false,
        groups: [],
        groupOrder: new Map(),
        docsByUrl: new Map(),
        titleDocs: [],
        sectionsByShard: new Map(),
        pendingShards: [],
        failedShardsByKey: new Map(),
        loadedShardKeys: new Set(),
        failedShardKeys: new Set(),
        inFlightBytes: new Map(),
        finishedBytes: new Map(),
        shardBytesByKey: new Map(),
        totalShardBytes: 0,
        shardsPumpPromise: null,
      }
      this.states.set(locale, st)
    }
    return st
  }

  private mergeTitleIndex(st: LocaleIndexState, payload: TitleIndexFile, base: string, tierId = 'public'): void {
    const localGroups = payload.groups
    for (const g of localGroups) {
      if (!st.groupOrder.has(g.id)) {
        st.groupOrder.set(g.id, st.groups.length)
        st.groups.push(g)
      }
    }

    for (const row of payload.pages) {
      const [groupIdx, lectureNo, code, url, fullTitle, compactHeadings, rawAliases, rawConceptGroups] = row
      const grp = localGroups[groupIdx] ?? { id: 'SITE', dir: '', title: 'Site', catSlot: 1 }
      if (st.docsByUrl.has(url)) continue

      const parsed = parseLecture(url, base, this.opts.localeKeys)
      const lectureId = parsed ? parsed.lectureId : ''
      const isConcept = grp.id === 'CONCEPTS' || code === 'CONCEPT'
      const displayTitle = isConcept ? fullTitle.trim() : stripLectureTitlePrefix(fullTitle)
      const aliases = Array.isArray(rawAliases) ? rawAliases.filter((a): a is string => typeof a === 'string' && a.trim().length > 0) : []
      const aliasesLower = aliases.map((a) => a.toLowerCase())
      const conceptGroups = Array.isArray(rawConceptGroups) ? rawConceptGroups.filter((g): g is string => typeof g === 'string') : []
      const inflated = inflateTitleHeadings(compactHeadings)
      const headings = inflated.map((h) => {
        const crumb = [...h.path, h.text].join(' › ')
        return {
          anchor: h.slug,
          text: h.text,
          path: h.path,
          crumb,
          searchLower: `${h.text} ${h.path.join(' ')}`.toLowerCase(),
        }
      })

      const doc: ClientTitleDoc = {
        tierId,
        groupId: grp.id,
        groupTitle: this.resolveGroupTitle(grp),
        catSlot: grp.catSlot,
        lectureId,
        lectureNo,
        code,
        url,
        fullTitle,
        displayTitle,
        searchLower: `${code} ${grp.id} ${grp.title} ${fullTitle}`.toLowerCase(),
        aliases,
        aliasesLower,
        conceptGroups,
        isConcept,
        headings,
      }
      st.docsByUrl.set(url, doc)
      st.titleDocs.push(doc)
    }
  }

  private resolveGroupTitle(grp: TitleIndexGroup): string {
    if (grp.id === 'CONCEPTS') return this.opts.labels.groupConcepts ?? grp.title
    if (grp.id === 'SITE') return this.opts.labels.groupSite
    return grp.title
  }

  private enqueueShards(
    st: LocaleIndexState,
    bucketKey: string,
    manifest: SearchManifestFile,
    urlPrefix: string,
    credentials: RequestCredentials,
    cache: RequestCache,
  ): void {
    for (const shard of manifest.shards) {
      const key = `${bucketKey}:${shard.shardId}`
      if (st.loadedShardKeys.has(key) || st.failedShardKeys.has(key)) continue
      if (st.pendingShards.some((p) => p.key === key)) continue
      st.pendingShards.push({
        key,
        locale: st.locale,
        meta: shard,
        url: `${urlPrefix}/${shard.url}`.replace(/\/{2,}/g, '/'),
        credentials,
        cache,
      })
      st.shardBytesByKey.set(key, shard.bytes)
      st.totalShardBytes += shard.bytes
    }
  }

  private evictTierData(st: LocaleIndexState, tierId: string): void {
    st.failedTierIds.delete(tierId)
    st.tierTitlesLoaded.delete(tierId)
    st.tierManifestsLoaded.delete(tierId)
    st.titleDocs = st.titleDocs.filter((doc) => {
      if (doc.tierId === tierId) {
        st.docsByUrl.delete(doc.url)
        return false
      }
      return true
    })
    const prefix = `tier:${tierId}:`
    st.pendingShards = st.pendingShards.filter((item) => !item.key.startsWith(prefix))
    for (const [key, bytes] of st.shardBytesByKey) {
      if (!key.startsWith(prefix)) continue
      st.totalShardBytes = Math.max(0, st.totalShardBytes - bytes)
      st.shardBytesByKey.delete(key)
      st.sectionsByShard.delete(key)
      st.loadedShardKeys.delete(key)
      st.failedShardKeys.delete(key)
      st.failedShardsByKey.delete(key)
      st.inFlightBytes.delete(key)
      st.finishedBytes.delete(key)
    }
  }

  private requeueFailedShards(st: LocaleIndexState): void {
    if (st.failedShardsByKey.size === 0) return
    for (const [key, item] of st.failedShardsByKey) {
      st.failedShardKeys.delete(key)
      if (!st.loadedShardKeys.has(key) && !st.pendingShards.some((p) => p.key === key)) {
        st.pendingShards.push(item)
      }
    }
    st.failedShardsByKey.clear()
  }

  private prioritizeShards(st: LocaleIndexState, preferGroupId: string | null): void {
    if (!preferGroupId) return
    st.pendingShards.sort((a, b) => {
      const aMatch = a.meta.groupId === preferGroupId ? 0 : 1
      const bMatch = b.meta.groupId === preferGroupId ? 0 : 1
      return aMatch - bMatch
    })
  }

  private async loadAccessTiers(st: LocaleIndexState, basePrefix: string, forceRetry = false): Promise<void> {
    const accessCfg = lectureAccessOf(this.opts.siteData())
    if (!accessCfg || accessCfg.tiers.length === 0) return

    if (st.accessLoading) {
      await st.accessLoading
      return
    }

    st.accessLoading = (async () => {
      try {
        let access: Awaited<ReturnType<typeof getAccess>>
        try {
          access = await getAccess()
          if (forceRetry && (st.accessFetchError || st.failedTierIds.size > 0 || (access.failedTiers?.length ?? 0) > 0)) {
            invalidateAccess()
            access = await getAccess()
          }
          st.accessFetchError = (access.failedTiers?.length ?? 0) > 0
        } catch {
          st.accessFetchError = true
          return
        }

        const tiers = access?.tiers ?? []
        const readableIds = new Set(tiers.map((t) => t.id))
        const knownTiers = new Set([...st.tierTitlesLoaded, ...st.tierManifestsLoaded, ...st.failedTierIds])
        for (const oldId of knownTiers) {
          if (!readableIds.has(oldId)) this.evictTierData(st, oldId)
        }

        await Promise.all(
          tiers.map(async (tier) => {
            const needTitle = !st.tierTitlesLoaded.has(tier.id)
            const needManifest = !st.tierManifestsLoaded.has(tier.id)
            if (!needTitle && !needManifest) {
              st.failedTierIds.delete(tier.id)
              return
            }

            const tierBase = `${basePrefix}${tierBasePath(tier.id)}/search/${st.locale}`
            let tierFailed = false
            const [tManSettled, tTitleSettled] = await Promise.all([
              needManifest
                ? this.fetchImpl(`${tierBase}/manifest.json`, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' }).then(
                    (res): { res?: Response; err?: unknown } => ({ res }),
                    (err): { res?: Response; err?: unknown } => ({ err }),
                  )
                : Promise.resolve(null),
              needTitle
                ? this.fetchImpl(`${tierBase}/titles.json`, { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' }).then(
                    (res): { res?: Response; err?: unknown } => ({ res }),
                    (err): { res?: Response; err?: unknown } => ({ err }),
                  )
                : Promise.resolve(null),
            ])

            if (needTitle) {
              try {
                if (!tTitleSettled || !tTitleSettled.res || tTitleSettled.res.status !== 200) {
                  tierFailed = true
                } else {
                  const tTitleData = (await tTitleSettled.res.json()) as TitleIndexFile
                  this.mergeTitleIndex(st, tTitleData, this.opts.base, tier.id)
                  st.tierTitlesLoaded.add(tier.id)
                }
              } catch {
                tierFailed = true
              }
            }

            // Never mark manifest/shards loaded while this tier's titles failed, or pumpShards skips all sections without docs.
            if (needManifest) {
              if (!st.tierTitlesLoaded.has(tier.id)) {
                tierFailed = true
              } else {
                try {
                  if (!tManSettled || !tManSettled.res || tManSettled.res.status !== 200) {
                    tierFailed = true
                  } else {
                    const tMan = (await tManSettled.res.json()) as SearchManifestFile
                    this.enqueueShards(st, `tier:${tier.id}`, tMan, tierBase, 'same-origin', 'no-store')
                    st.tierManifestsLoaded.add(tier.id)
                  }
                } catch {
                  tierFailed = true
                }
              }
            }

            if (tierFailed) st.failedTierIds.add(tier.id)
            else st.failedTierIds.delete(tier.id)
          }),
        )
      } finally {
        st.accessLoading = null
        this.opts.onStateChange?.()
      }
    })()
    this.opts.onStateChange?.()
    await st.accessLoading
  }

  private async fetchAndEnqueueManifest(
    st: LocaleIndexState,
    publicBase: string,
    prefetched?: Promise<{ res?: Response; err?: unknown }>,
  ): Promise<void> {
    if (st.manifestLoaded) return
    if (!st.manifestLoading) {
      st.manifestLoading = (async () => {
        try {
          let manifestRes: Response
          if (prefetched) {
            const settled = await prefetched
            if (!settled.res) throw (settled.err ?? new Error('Search manifest fetch failed'))
            manifestRes = settled.res
          } else {
            manifestRes = await this.fetchImpl(`${publicBase}/manifest.json`, { credentials: 'same-origin', redirect: 'manual' })
          }
          if (manifestRes.status !== 200) {
            throw new Error(`Search manifest returned status ${manifestRes.status}`)
          }
          const manifest = (await manifestRes.json()) as SearchManifestFile
          this.enqueueShards(st, 'public', manifest, publicBase, 'same-origin', 'default')
          st.manifestLoaded = true
          st.loadError = false
        } catch {
          st.manifestLoaded = false
          st.loadError = true
        } finally {
          st.manifestLoading = null
          this.opts.onStateChange?.()
        }
      })()
      this.opts.onStateChange?.()
    }
    await st.manifestLoading
  }

  async ensureLoaded(locale: string, preferGroupId: string | null, opts?: { forceRetry?: boolean }): Promise<void> {
    const st = this.getOrCreateState(locale)
    const basePrefix = this.opts.base.replace(/\/$/, '')
    const publicBase = `${basePrefix}/search/${locale}`
    const forceRetry = Boolean(opts?.forceRetry)

    if (forceRetry && st.loadError) {
      st.loadError = false
    }

    if (!st.titleLoading && !st.titleLoaded && !st.loadError) {
      st.titleLoading = (async () => {
        try {
          // Send same-origin cookies so gateway/forward-auth deployments (e.g. Authelia) authorize search JSON & shards,
          // and prevent cross-origin login redirects from turning into unhandled CORS/CSP errors via `redirect: 'manual'`.
          // Attach settlement handler on manifest fetch immediately so a titles failure never leaks an unhandled rejection.
          const manifestSettled = this.fetchImpl(`${publicBase}/manifest.json`, { credentials: 'same-origin', redirect: 'manual' }).then(
            (res): { res?: Response; err?: unknown } => ({ res }),
            (err): { res?: Response; err?: unknown } => ({ err }),
          )
          const titleRes = await this.fetchImpl(`${publicBase}/titles.json`, { credentials: 'same-origin', redirect: 'manual' })
          if (titleRes.status !== 200) {
            void manifestSettled
            throw new Error(`Search title index returned status ${titleRes.status}`)
          }
          const titleData = (await titleRes.json()) as TitleIndexFile
          this.mergeTitleIndex(st, titleData, this.opts.base)
          st.titleLoaded = true
          st.loadError = false
          this.opts.onStateChange?.()

          // Isolate manifest + access-tier loading so a manifest error never blocks already-loaded title search.
          await Promise.all([
            this.fetchAndEnqueueManifest(st, publicBase, manifestSettled),
            this.loadAccessTiers(st, basePrefix, forceRetry),
          ])
        } finally {
          st.titleLoading = null
        }
      })()
      this.opts.onStateChange?.()
    }

    if (st.titleLoading) {
      const pendingTitles = st.titleLoading
      try {
        await pendingTitles
      } catch (err) {
        st.titleLoaded = false
        st.loadError = true
        this.opts.onStateChange?.()
        throw err
      }
    } else if (st.titleLoaded) {
      const retryTasks: Array<Promise<void>> = []
      if (forceRetry && !st.manifestLoaded) {
        retryTasks.push(this.fetchAndEnqueueManifest(st, publicBase))
      } else if (st.manifestLoading) {
        retryTasks.push(st.manifestLoading)
      }
      if (forceRetry && (st.failedTierIds.size > 0 || st.accessFetchError)) {
        retryTasks.push(this.loadAccessTiers(st, basePrefix, true))
      } else if (st.accessLoading) {
        retryTasks.push(st.accessLoading)
      }
      if (retryTasks.length > 0) {
        await Promise.all(retryTasks)
      } else if (!st.manifestLoaded && !st.manifestLoading && st.failedTierIds.size === 0 && !st.accessFetchError) {
        return
      }
    } else {
      return
    }

    if (forceRetry) {
      this.requeueFailedShards(st)
    }
    this.prioritizeShards(st, preferGroupId)
    void this.pumpShards(st, preferGroupId)
  }

  private pumpShards(st: LocaleIndexState, preferGroupId: string | null): Promise<void> {
    if (st.shardsPumpPromise) {
      this.prioritizeShards(st, preferGroupId)
      return st.shardsPumpPromise
    }

    st.shardsPumpPromise = (async () => {
      const CONCURRENCY = 3
      const nextItem = (): ShardQueueItem | undefined => st.pendingShards.shift()

      const worker = async (): Promise<void> => {
        for (;;) {
          const item = nextItem()
          if (!item) return
          st.inFlightBytes.set(item.key, 0)
          this.opts.onStateChange?.()
          try {
            const payload = await fetchCompressedShard(
              item.url,
              item.credentials,
              this.fetchImpl,
              (bytes) => {
                st.inFlightBytes.set(item.key, Math.min(bytes, item.meta.bytes))
                this.opts.onStateChange?.()
              },
              item.cache,
            )
            st.inFlightBytes.delete(item.key)
            if (payload) {
              const parsedSections: ClientBodySection[] = []
              for (const [pIdx, anchor, pathSegs, text] of payload.sections) {
                const url = payload.pages[pIdx]
                if (!url) continue
                const doc = st.docsByUrl.get(url)
                if (!doc) continue
                parsedSections.push({
                  groupId: doc.groupId,
                  groupTitle: doc.groupTitle,
                  lectureId: doc.lectureId,
                  lectureNo: doc.lectureNo,
                  code: doc.code,
                  url,
                  displayTitle: doc.displayTitle,
                  anchor,
                  crumb: pathSegs.join(' › '),
                  text,
                  textLower: text.toLowerCase(),
                })
              }
              st.sectionsByShard.set(item.key, parsedSections)
              st.loadedShardKeys.add(item.key)
              st.failedShardKeys.delete(item.key)
              st.failedShardsByKey.delete(item.key)
              st.finishedBytes.set(item.key, item.meta.bytes)
            } else {
              st.failedShardKeys.add(item.key)
              st.failedShardsByKey.set(item.key, item)
            }
          } catch {
            st.inFlightBytes.delete(item.key)
            st.failedShardKeys.add(item.key)
            st.failedShardsByKey.set(item.key, item)
          }
          this.opts.onStateChange?.()
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
      st.shardsPumpPromise = null
      this.opts.onStateChange?.()
    })()

    return st.shardsPumpPromise
  }

  prioritizeGroup(locale: string, groupId: string | null): void {
    const st = this.states.get(locale)
    if (st) this.prioritizeShards(st, groupId)
  }

  getLoadState(locale: string, hasQuery: boolean): SearchLoadState {
    const st = this.states.get(locale)
    if (!st) {
      return { loading: false, loadedBytes: 0, totalBytes: 0, percent: 0, label: '', phase: 'idle' }
    }
    if (!st.titleLoaded) {
      if (st.loadError) {
        return {
          loading: false,
          loadedBytes: 0,
          totalBytes: 0,
          percent: 0,
          label: resolveDynamicLabel(this.opts.labels.loadError),
          phase: 'error',
          error: true,
        }
      }
      if (st.titleLoading) {
        return {
          loading: true,
          loadedBytes: 0,
          totalBytes: 0,
          percent: 0,
          label: resolveDynamicLabel(this.opts.labels.loadingTitles),
          phase: 'loading-titles',
        }
      }
      return { loading: false, loadedBytes: 0, totalBytes: 0, percent: 0, label: '', phase: 'idle' }
    }
    if (!st.manifestLoaded) {
      if (st.manifestLoading) {
        return {
          loading: true,
          loadedBytes: 0,
          totalBytes: 0,
          percent: 0,
          label: resolveDynamicLabel(this.opts.labels.loadingTitles),
          phase: 'loading-shards',
        }
      }
      if (st.loadError) {
        return {
          loading: false,
          loadedBytes: 0,
          totalBytes: 0,
          percent: 0,
          label: resolveDynamicLabel(this.opts.labels.loadError),
          phase: 'partial-error',
          error: true,
        }
      }
    }
    const pending = st.pendingShards.length + st.inFlightBytes.size > 0
    const failedTierCount = st.failedTierIds.size + (st.accessFetchError ? 1 : 0)
    let loaded = 0
    for (const v of st.finishedBytes.values()) loaded += v
    for (const v of st.inFlightBytes.values()) loaded += v
    const capped = Math.min(loaded, st.totalShardBytes)
    if ((!pending && !st.accessLoading && !st.manifestLoading) || (st.totalShardBytes === 0 && !st.accessLoading && !st.manifestLoading)) {
      if (st.failedShardKeys.size > 0 || failedTierCount > 0) {
        return {
          loading: false,
          loadedBytes: capped,
          totalBytes: st.totalShardBytes,
          percent: st.totalShardBytes > 0 ? Math.min(99, Math.round((capped / st.totalShardBytes) * 100)) : 0,
          label: resolveDynamicLabel(this.opts.labels.loadError),
          phase: 'partial-error',
          error: true,
          failedShards: st.failedShardKeys.size + failedTierCount,
        }
      }
      return {
        loading: false,
        loadedBytes: st.totalShardBytes,
        totalBytes: st.totalShardBytes,
        percent: 100,
        label: '',
        phase: 'ready',
      }
    }
    const percent = Math.min(99, Math.max(0, Math.round((capped / st.totalShardBytes) * 100)))
    const toMb = (b: number) => (b / (1024 * 1024)).toFixed(1)
    const label = hasQuery
      ? this.opts.labels.loadingBar(toMb(capped), toMb(st.totalShardBytes))
      : this.opts.labels.loadingIdle(toMb(capped), toMb(st.totalShardBytes))
    return {
      loading: true,
      loadedBytes: capped,
      totalBytes: st.totalShardBytes,
      percent,
      label,
      phase: 'loading-shards',
    }
  }

  query(
    locale: string,
    rawQuery: string,
    scope: 'all' | 'group',
    currentGroupId: string | null,
  ): { groups: SearchGroupSectionView[]; totalHits: number; elapsedMs: number } {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const terms = parseQueryTerms(rawQuery)
    const st = this.states.get(locale)
    if (terms.length === 0 || !st || !st.titleLoaded) {
      return { groups: [], totalHits: 0, elapsedMs: 0 }
    }

    const termsLower = terms.map((t) => t.toLowerCase())
    const phraseLower = rawQuery.trim().toLowerCase()
    const activeGroupFilter = scope === 'group' && currentGroupId ? currentGroupId : null
    const matchesById = new Map<string, CandidateMatch>()

    const matchesScope = (doc: ClientTitleDoc | undefined, groupId: string): boolean => {
      if (!activeGroupFilter) return true
      if (groupId === activeGroupFilter) return true
      if (doc?.isConcept && doc.conceptGroups.includes(activeGroupFilter)) return true
      return false
    }

    const upsertMatch = (cand: CandidateMatch, singlePerPage = false): void => {
      const key = singlePerPage ? (cand.href.split('#', 1)[0] ?? cand.href) : cand.id
      const normalized = singlePerPage ? { ...cand, id: key } : cand
      const prev = matchesById.get(key)
      if (!prev || normalized.score > prev.score) matchesById.set(key, normalized)
    }

    // Phase 1: Instant matches over title index, aliases field, & heading hierarchy
    for (const doc of st.titleDocs) {
      if (!matchesScope(doc, doc.groupId)) continue

      const titleMatchAll = termsLower.every((t) => doc.searchLower.includes(t))
      if (titleMatchAll) {
        let score = 40
        if (doc.code.toLowerCase() === phraseLower) score += 80
        else if (doc.displayTitle.toLowerCase().includes(phraseLower)) score += 45
        else if (doc.fullTitle.toLowerCase().includes(phraseLower)) score += 35
        upsertMatch(
          {
            score,
            id: doc.url,
            href: doc.url,
            groupId: doc.groupId,
            groupTitle: doc.groupTitle,
            catSlot: doc.catSlot,
            lectureNo: doc.lectureNo,
            code: doc.code,
            displayTitle: doc.displayTitle,
            crumb: doc.aliases.slice(0, 2).join(' · '),
            snippetSource: '',
          },
          doc.isConcept,
        )
      }

      if (doc.aliasesLower.length > 0) {
        for (let i = 0; i < doc.aliasesLower.length; i++) {
          const aliasLower = doc.aliasesLower[i]!
          const aliasHay = `${doc.searchLower} ${aliasLower}`
          if (!termsLower.every((t) => aliasHay.includes(t))) continue
          if (!termsLower.some((t) => aliasLower.includes(t))) continue
          let score = 38
          if (aliasLower === phraseLower) score += 60
          else if (aliasLower.includes(phraseLower)) score += 35
          const aliasOrig = doc.aliases[i] ?? ''
          upsertMatch(
            {
              score,
              id: doc.url,
              href: doc.url,
              groupId: doc.groupId,
              groupTitle: doc.groupTitle,
              catSlot: doc.catSlot,
              lectureNo: doc.lectureNo,
              code: doc.code,
              displayTitle: doc.displayTitle,
              crumb: aliasOrig,
              snippetSource: aliasOrig,
            },
            doc.isConcept,
          )
        }
      }

      for (const h of doc.headings) {
        const headingHay = `${doc.searchLower} ${h.searchLower}`
        const matchesAll = termsLower.every((t) => headingHay.includes(t))
        if (!matchesAll) continue
        const directInHeading = termsLower.every((t) => h.searchLower.includes(t))
        if (!directInHeading) continue

        let score = 28
        if (h.text.toLowerCase().includes(phraseLower)) score += 32
        const href = h.anchor ? `${doc.url}#${h.anchor}` : doc.url
        upsertMatch(
          {
            score,
            id: href,
            href,
            groupId: doc.groupId,
            groupTitle: doc.groupTitle,
            catSlot: doc.catSlot,
            lectureNo: doc.lectureNo,
            code: doc.code,
            displayTitle: doc.displayTitle,
            crumb: h.crumb,
            snippetSource: '',
          },
          doc.isConcept,
        )
      }
    }

    // Phase 2: Body sections from all currently-loaded shards
    for (const sections of st.sectionsByShard.values()) {
      for (const sec of sections) {
        const titleDoc = st.docsByUrl.get(sec.url)
        if (!matchesScope(titleDoc, sec.groupId)) continue

        const combinedLower = `${sec.textLower} ${sec.crumb.toLowerCase()} ${sec.displayTitle.toLowerCase()} ${titleDoc?.fullTitle.toLowerCase() ?? ''} ${sec.groupId.toLowerCase()} ${sec.groupTitle.toLowerCase()} ${sec.code.toLowerCase()}`
        let ok = true
        let inBodyCount = 0
        for (const t of termsLower) {
          if (sec.textLower.includes(t)) {
            inBodyCount++
          } else if (!combinedLower.includes(t)) {
            ok = false
            break
          }
        }
        if (!ok || inBodyCount === 0) continue

        let score = 12 + inBodyCount * 5
        if (sec.textLower.includes(phraseLower)) score += 18
        if (sec.crumb.toLowerCase().includes(phraseLower)) score += 12
        const isConcept = titleDoc?.isConcept ?? (sec.groupId === 'CONCEPTS' || sec.code === 'CONCEPT')
        const href = isConcept ? sec.url : sec.anchor ? `${sec.url}#${sec.anchor}` : sec.url
        // If we already matched the same heading in Phase 1, enrich it with body snippet & boosted score!
        const existingHeading = matchesById.get(isConcept ? sec.url : href)
        upsertMatch(
          {
            score: existingHeading ? Math.max(score, existingHeading.score + 8) : score,
            id: href,
            href,
            groupId: sec.groupId,
            groupTitle: sec.groupTitle,
            catSlot: titleDoc?.catSlot ?? 1,
            lectureNo: sec.lectureNo,
            code: sec.code,
            displayTitle: sec.displayTitle,
            crumb: sec.crumb || existingHeading?.crumb || '',
            snippetSource: sec.text,
          },
          isConcept,
        )
      }
    }

    // Group & cap hits per lecture/total so common terms remain responsive
    const sorted = [...matchesById.values()].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ga = st.groupOrder.get(a.groupId) ?? 999
      const gb = st.groupOrder.get(b.groupId) ?? 999
      if (ga !== gb) return ga - gb
      return (a.lectureNo ?? 999) - (b.lectureNo ?? 999)
    })

    const perLectureCount = new Map<string, number>()
    const kept: CandidateMatch[] = []
    for (const item of sorted) {
      const basePage = item.href.split('#', 1)[0] ?? item.href
      const cnt = perLectureCount.get(basePage) ?? 0
      if (cnt >= 3) continue
      perLectureCount.set(basePage, cnt + 1)
      kept.push(item)
      if (kept.length >= 60) break
    }
    // the count next to the timing is what the panel lists (after the 3-per-lecture cap and the 60 limit), so it matches the
    // rows the reader sees (spec board 04.2 "右侧显示结果数与用时"; S6Y audit-spec #17: "6 条" over 5 rows)
    const totalHits = kept.length

    const grouped = new Map<string, { groupTitle: string; order: number; items: SearchHitView[] }>()
    for (const c of kept) {
      let bucket = grouped.get(c.groupId)
      if (!bucket) {
        bucket = {
          groupTitle: c.groupTitle,
          order: st.groupOrder.get(c.groupId) ?? 999,
          items: [],
        }
        grouped.set(c.groupId, bucket)
      }
      const doc = st.docsByUrl.get(c.href.split('#', 1)[0] ?? c.href)
      const status = doc?.lectureId ? this.opts.statusOf(doc.lectureId) : 'not_started'
      const noLabel = doc?.isConcept
        ? (this.opts.labels.conceptBadge ?? doc.groupTitle)
        : c.lectureNo !== null
          ? this.opts.labels.lectureNo(c.lectureNo)
          : c.code || c.groupId
      const snippetRaw = c.snippetSource ? buildSnippet(c.snippetSource, terms) : ''

      const highlightTerms = terms.length > 1 ? [rawQuery.trim(), ...terms] : terms
      bucket.items.push({
        id: c.id,
        href: c.href,
        groupId: c.groupId,
        code: doc?.isConcept ? noLabel : c.code,
        noLabel,
        titleParts: splitHighlightParts(c.displayTitle, highlightTerms),
        crumbParts: splitHighlightParts(c.crumb, highlightTerms),
        snippetParts: splitHighlightParts(snippetRaw, highlightTerms),
        status,
        statusLabel: this.opts.labels.statusLabel(status),
      })
    }

    const groups: SearchGroupSectionView[] = [...grouped.entries()]
      .sort((a, b) => a[1].order - b[1].order)
      .map(([groupId, info]) => ({
        groupId,
        groupTitle: info.groupTitle,
        countLabel: this.opts.labels.groupCount(info.items.length),
        items: info.items,
      }))

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now()
    return {
      groups,
      totalHits,
      elapsedMs: Math.max(0, Math.round(t1 - t0)),
    }
  }
}
