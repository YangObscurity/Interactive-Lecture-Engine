import { tool, type ToolSet } from 'ai'
import type { z } from 'zod'
import type { AppConfig } from '../config/schema.js'
import { hashUserId } from '../routes/ai/runtime.js'
import { ToolDataStore, resolveReadableTiers } from './loader.js'
import { TOOL_DESCRIPTIONS, TOOL_INPUT_SCHEMAS, type ToolInputMap } from './schemas.js'
import { normalizeSearchText, rankConcepts, rankLectures } from './search.js'
import {
  ENGINE_TOOL_NAMES,
  type CallerIdentity,
  type ConceptGraphEdge,
  type ConceptGraphNode,
  type ConceptGraphResult,
  type ConceptRecord,
  type EngineToolName,
  type LectureRecord,
  type LectureSection,
  type LectureSummaryResult,
  type ToolCallContext,
  type ToolCallLogLine,
  type ToolChannel,
  type ToolStatsByName,
} from './types.js'

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`)
    this.name = 'ToolTimeoutError'
  }
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function truncateUtf8String(text: string, maxBytes: number, suffix = '\n...[truncated]'): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  const suffixBytes = Buffer.byteLength(suffix, 'utf8')
  const target = Math.max(0, maxBytes - suffixBytes)
  if (target === 0) return suffix.slice(0, maxBytes)
  let slice = buf.subarray(0, target).toString('utf8')
  // Trim replacement character at split multi-byte UTF-8 boundary
  while (slice.endsWith('\uFFFD')) {
    slice = slice.slice(0, -1)
  }
  return `${slice}${suffix}`
}

function capResultBytes(toolName: EngineToolName, value: unknown, maxBytes: number): unknown {
  if (utf8Bytes(value) <= maxBytes) return value

  if (Array.isArray(value)) {
    const copy = [...value]
    while (copy.length > 0 && utf8Bytes(copy) > maxBytes) {
      copy.pop()
    }
    return copy
  }

  if (toolName === 'get_concept' && typeof value === 'object' && value !== null && 'markdown' in value) {
    const rec = { ...(value as ConceptRecord) }
    const suffix = '\n...[truncated]'
    let low = 0
    let high = rec.markdown.length
    let best = { ...rec, markdown: '' }
    while (low <= high) {
      const mid = (low + high) >> 1
      const candidate = {
        ...rec,
        markdown: mid === rec.markdown.length ? rec.markdown : `${rec.markdown.slice(0, mid)}${suffix}`,
      }
      if (utf8Bytes(candidate) <= maxBytes) {
        best = candidate
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    return best
  }

  if (toolName === 'get_lecture_summary' && typeof value === 'object' && value !== null && 'sections' in value) {
    const summary = value as LectureSummaryResult
    const sections: LectureSection[] = summary.sections.map((s) => ({ ...s }))
    const copy: LectureSummaryResult = { ...summary, sections, truncated: true }
    while (copy.sections.length > 1 && utf8Bytes(copy) > maxBytes) {
      copy.sections.pop()
    }
    if (copy.sections.length === 1 && utf8Bytes(copy) > maxBytes) {
      const only = copy.sections[0]!
      const overhead = utf8Bytes({ ...copy, sections: [{ ...only, text: '' }] })
      const budget = Math.max(32, maxBytes - overhead)
      only.text = truncateUtf8String(only.text, budget)
    }
    while (copy.sections.length > 0 && utf8Bytes(copy) > maxBytes) {
      copy.sections.pop()
    }
    return copy
  }

  if (toolName === 'get_concept_graph' && typeof value === 'object' && value !== null && 'nodes' in value) {
    const graph = value as ConceptGraphResult
    const copy: ConceptGraphResult = {
      nodes: [...graph.nodes],
      edges: [...graph.edges],
      truncated: true,
    }
    while (copy.edges.length > 0 && utf8Bytes(copy) > maxBytes) {
      copy.edges.pop()
    }
    while (copy.nodes.length > 1 && utf8Bytes(copy) > maxBytes) {
      copy.nodes.pop()
    }
    return copy
  }

  return value
}

interface DayBucket {
  dayStartMs: number
  counts: Map<string, { calls: number; errors: number; totalMs: number }>
}

export class RollingToolStats {
  private readonly buckets = new Map<string, DayBucket>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  private utcDayKey(tsMs: number): { key: string; dayStartMs: number } {
    const d = new Date(tsMs)
    const key = d.toISOString().slice(0, 10)
    const dayStartMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    return { key, dayStartMs }
  }

  private prune(currentMs: number): void {
    const cutoff = currentMs - SEVEN_DAYS_MS
    for (const [key, bucket] of this.buckets) {
      if (bucket.dayStartMs < cutoff) {
        this.buckets.delete(key)
      }
    }
  }

  record(toolName: string, ok: boolean, ms: number): void {
    const tsMs = this.now()
    this.prune(tsMs)
    const { key, dayStartMs } = this.utcDayKey(tsMs)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { dayStartMs, counts: new Map() }
      this.buckets.set(key, bucket)
    }
    const cur = bucket.counts.get(toolName) ?? { calls: 0, errors: 0, totalMs: 0 }
    cur.calls += 1
    if (!ok) cur.errors += 1
    cur.totalMs += Math.max(0, Math.round(ms))
    bucket.counts.set(toolName, cur)
  }

  snapshot(): ToolStatsByName {
    this.prune(this.now())
    const out: ToolStatsByName = {}
    for (const bucket of this.buckets.values()) {
      for (const [name, entry] of bucket.counts) {
        const agg = out[name] ?? { calls: 0, errors: 0, totalMs: 0 }
        agg.calls += entry.calls
        agg.errors += entry.errors
        agg.totalMs += entry.totalMs
        out[name] = agg
      }
    }
    return out
  }
}

function parseEngineToolInput<K extends EngineToolName>(name: K, rawArgs: unknown): ToolInputMap[K] {
  switch (name) {
    case 'search_concepts':
      return TOOL_INPUT_SCHEMAS.search_concepts.parse(rawArgs) as ToolInputMap[K]
    case 'get_concept':
      return TOOL_INPUT_SCHEMAS.get_concept.parse(rawArgs) as ToolInputMap[K]
    case 'get_concept_graph':
      return TOOL_INPUT_SCHEMAS.get_concept_graph.parse(rawArgs) as ToolInputMap[K]
    case 'search_lectures':
      return TOOL_INPUT_SCHEMAS.search_lectures.parse(rawArgs) as ToolInputMap[K]
    case 'get_lecture_summary':
      return TOOL_INPUT_SCHEMAS.get_lecture_summary.parse(rawArgs) as ToolInputMap[K]
  }
}

function normalizeRouteKey(routeOrId: string): string {
  return routeOrId.trim().replace(/\.html$/i, '').replace(/\/+$/, '').toLowerCase()
}

export interface ToolEngineOptions {
  now?: () => number
  logger?: (line: ToolCallLogLine) => void
  serverRoot?: string
  cwd?: string
}

export class ToolEngine {
  readonly store: ToolDataStore
  readonly stats: RollingToolStats
  private readonly config: Pick<AppConfig, 'siteDistDir' | 'aiToolTimeoutMs' | 'aiToolMaxResultBytes'>
  private readonly now: () => number
  private readonly logger: (line: ToolCallLogLine) => void

  constructor(
    config: Pick<AppConfig, 'siteDistDir' | 'aiToolTimeoutMs' | 'aiToolMaxResultBytes'>,
    options: ToolEngineOptions = {},
  ) {
    this.config = config
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? ((line) => console.info(JSON.stringify(line)))
    this.store = new ToolDataStore(config.siteDistDir, {
      serverRoot: options.serverRoot,
      cwd: options.cwd,
    })
    this.stats = new RollingToolStats(this.now)
  }

  resolveTiersForCaller(identity: CallerIdentity | null | undefined): string[] {
    const tiers = this.store.loadTiers()
    return resolveReadableTiers(identity, tiers)
  }

  logToolCall(entry: {
    tool: string
    channel: ToolChannel
    ms: number
    ok: boolean
    bytes: number
    userId?: string | null
    userHash?: string | null
  }): void {
    const uh =
      entry.userHash !== undefined
        ? entry.userHash
        : entry.userId
          ? hashUserId(entry.userId)
          : null
    const roundedMs = Math.max(0, Math.round(entry.ms))
    this.stats.record(entry.tool, entry.ok, roundedMs)
    this.logger({
      evt: 'ai_tool_call',
      ts: new Date(this.now()).toISOString(),
      tool: entry.tool,
      channel: entry.channel,
      ms: roundedMs,
      ok: entry.ok,
      bytes: entry.bytes,
      uh,
    })
  }

  async execute<K extends EngineToolName>(
    name: K,
    rawArgs: unknown,
    ctx: ToolCallContext,
  ): Promise<unknown> {
    const started = this.now()
    const timeoutMs = ctx.timeoutMs ?? this.config.aiToolTimeoutMs
    const maxBytes = ctx.maxResultBytes ?? this.config.aiToolMaxResultBytes

    let parsedArgs: ToolInputMap[K]
    try {
      parsedArgs = parseEngineToolInput(name, rawArgs)
    } catch (err) {
      const elapsed = this.now() - started
      this.logToolCall({
        tool: name,
        channel: ctx.channel,
        ms: elapsed,
        ok: false,
        bytes: 0,
        userId: ctx.userId,
        userHash: ctx.userHash,
      })
      throw err
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const work = async (): Promise<unknown> => {
      if (ctx.testDelayMs && ctx.testDelayMs > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, ctx.testDelayMs))
      }
      return this.runBuiltIn(name, parsedArgs, ctx.readableTiers)
    }

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new ToolTimeoutError(name, timeoutMs))
      }, timeoutMs)
    })

    try {
      const rawResult = await Promise.race([work(), timeoutPromise])
      const capped = capResultBytes(name, rawResult, maxBytes)
      const bytes = utf8Bytes(capped)
      this.logToolCall({
        tool: name,
        channel: ctx.channel,
        ms: this.now() - started,
        ok: true,
        bytes,
        userId: ctx.userId,
        userHash: ctx.userHash,
      })
      return capped
    } catch (err) {
      this.logToolCall({
        tool: name,
        channel: ctx.channel,
        ms: this.now() - started,
        ok: false,
        bytes: 0,
        userId: ctx.userId,
        userHash: ctx.userHash,
      })
      throw err
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private runBuiltIn<K extends EngineToolName>(
    name: K,
    args: ToolInputMap[K],
    readableTiers: readonly string[],
  ): unknown {
    const { concepts, lectures } = this.store.loadVisibleData(readableTiers)

    switch (name) {
      case 'search_concepts': {
        const a = args as ToolInputMap['search_concepts']
        return rankConcepts(concepts.values(), a.query, a.limit ?? 8)
      }
      case 'get_concept': {
        const a = args as ToolInputMap['get_concept']
        return this.getConcept(a.slug, concepts, lectures)
      }
      case 'get_concept_graph': {
        const a = args as ToolInputMap['get_concept_graph']
        return this.getConceptGraph(a.slug, a.depth ?? 1, concepts)
      }
      case 'search_lectures': {
        const a = args as ToolInputMap['search_lectures']
        return rankLectures(lectures.values(), a.query, a.group, a.limit ?? 8)
      }
      case 'get_lecture_summary': {
        const a = args as ToolInputMap['get_lecture_summary']
        return this.getLectureSummary(a.lecture, a.heading, lectures)
      }
    }
  }

  private getConcept(
    slug: string,
    concepts: Map<string, ConceptRecord>,
    lectures: Map<string, LectureRecord>,
  ): ConceptRecord | { error: 'not_found'; slug: string } {
    const c = concepts.get(slug.trim())
    if (!c) {
      return { error: 'not_found', slug }
    }

    const visibleLectureRoutes = new Set<string>()
    const visibleLectureIds = new Set<string>()
    for (const lec of lectures.values()) {
      visibleLectureRoutes.add(normalizeRouteKey(lec.route))
      visibleLectureIds.add(lec.id.trim().toLowerCase())
    }

    return {
      ...c,
      related: c.related.filter((r) => concepts.has(r.slug)),
      links: c.links.filter((s) => concepts.has(s)),
      backlinks: c.backlinks.filter((s) => concepts.has(s)),
      lectures: c.lectures.filter(
        (l) =>
          visibleLectureRoutes.has(normalizeRouteKey(l.route)) ||
          visibleLectureIds.has(l.id.trim().toLowerCase()),
      ),
    }
  }

  private getConceptGraph(
    rootSlug: string,
    depthInput: number,
    concepts: Map<string, ConceptRecord>,
  ): ConceptGraphResult {
    const startSlug = rootSlug.trim()
    const root = concepts.get(startSlug)
    if (!root) {
      return { nodes: [], edges: [] }
    }

    const depth = Math.min(2, Math.max(1, depthInput))
    const visited = new Set<string>([startSlug])
    const queue: Array<{ slug: string; dist: number }> = [{ slug: startSlug, dist: 0 }]

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.dist >= depth) continue
      const curConcept = concepts.get(current.slug)
      if (!curConcept) continue

      const neighbors = new Set<string>()
      for (const rel of curConcept.related) {
        if (concepts.has(rel.slug)) neighbors.add(rel.slug)
      }
      for (const linkSlug of curConcept.links) {
        if (concepts.has(linkSlug)) neighbors.add(linkSlug)
      }
      for (const backSlug of curConcept.backlinks) {
        if (concepts.has(backSlug)) neighbors.add(backSlug)
      }
      // Also inspect visible incoming edges from other readable concepts
      for (const other of concepts.values()) {
        if (
          other.related.some((r) => r.slug === curConcept.slug) ||
          other.links.includes(curConcept.slug)
        ) {
          neighbors.add(other.slug)
        }
      }

      for (const nextSlug of neighbors) {
        if (!visited.has(nextSlug)) {
          visited.add(nextSlug)
          queue.push({ slug: nextSlug, dist: current.dist + 1 })
        }
      }
    }

    const nodes: ConceptGraphNode[] = [...visited]
      .sort()
      .map((slug) => {
        const c = concepts.get(slug)!
        return { slug: c.slug, term: c.term, summary: c.summary }
      })

    const edgeSet = new Set<string>()
    const edges: ConceptGraphEdge[] = []
    const pushEdge = (from: string, to: string, rel: string) => {
      if (!visited.has(from) || !visited.has(to)) return
      const key = `${from}\0${to}\0${rel}`
      if (edgeSet.has(key)) return
      edgeSet.add(key)
      edges.push({ from, to, rel })
    }

    for (const slug of visited) {
      const c = concepts.get(slug)!
      for (const r of c.related) {
        pushEdge(c.slug, r.slug, r.rel)
      }
      for (const target of c.links) {
        pushEdge(c.slug, target, 'link')
      }
    }

    edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.rel.localeCompare(b.rel))
    return { nodes, edges }
  }

  private getLectureSummary(
    lectureQuery: string,
    heading: string | undefined,
    lectures: Map<string, LectureRecord>,
  ): LectureSummaryResult | { error: 'not_found'; lecture: string } {
    const qNorm = normalizeRouteKey(lectureQuery)
    let matched: LectureRecord | undefined

    for (const lec of lectures.values()) {
      if (lec.id.trim().toLowerCase() === qNorm || normalizeRouteKey(lec.route) === qNorm) {
        matched = lec
        break
      }
    }

    if (!matched) {
      return { error: 'not_found', lecture: lectureQuery }
    }

    let sections = matched.sections
    if (heading && heading.trim() !== '') {
      const hNorm = normalizeSearchText(heading)
      const hAnchor = heading.trim().replace(/^#/, '').toLowerCase()
      const exact = sections.filter(
        (s) => normalizeSearchText(s.heading) === hNorm || s.anchor.trim().replace(/^#/, '').toLowerCase() === hAnchor,
      )
      if (exact.length > 0) {
        sections = exact
      } else {
        sections = sections.filter((s) => normalizeSearchText(s.heading).includes(hNorm))
      }
    }

    return {
      id: matched.id,
      route: matched.route,
      title: matched.title,
      sections,
    }
  }

  toAiSdkTools(
    ctx: ToolCallContext,
    enabledMap?: Readonly<Record<string, { enabled: boolean }>>,
  ): ToolSet {
    const tools: ToolSet = {}
    for (const name of ENGINE_TOOL_NAMES) {
      if (enabledMap && enabledMap[name]?.enabled === false) {
        continue
      }
      const schema = TOOL_INPUT_SCHEMAS[name] as unknown as z.ZodType<Record<string, unknown>>
      tools[name] = tool({
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: schema,
        execute: async (input) => this.execute(name, input, ctx),
      })
    }
    return tools
  }
}
