import type { Role } from '../config/schema.js'

export const ENGINE_TOOL_NAMES = [
  'search_concepts',
  'get_concept',
  'get_concept_graph',
  'search_lectures',
  'get_lecture_summary',
] as const

export type EngineToolName = (typeof ENGINE_TOOL_NAMES)[number]

export type ToolChannel = 'native' | 'mcp' | 'rest' | 'internal'

export type ConceptRelType =
  | 'prerequisite'
  | 'part-of'
  | 'contrast'
  | 'generalizes'
  | 'special-case'
  | 'applied-in'

export interface ConceptRelated {
  slug: string
  rel: ConceptRelType | string
}

export interface ConceptLectureRef {
  route: string
  id: string
  title: string
  count: number
}

export interface ConceptRecord {
  slug: string
  term: string
  english: string
  aliases: string[]
  field: string
  groups: string[]
  summary: string
  url: string
  related: ConceptRelated[]
  links: string[]
  backlinks: string[]
  lectures: ConceptLectureRef[]
  markdown: string
}

export interface ConceptsFile {
  version: number
  tier: string
  generatedAt?: string
  concepts: ConceptRecord[]
}

export interface LectureSection {
  heading: string
  anchor: string
  text: string
}

export interface LectureRecord {
  route: string
  id: string
  group: string
  title: string
  sections: LectureSection[]
}

export interface LecturesFile {
  version: number
  tier: string
  lectures: LectureRecord[]
}

export type TierReadRule = 'public' | 'authenticated' | 'groups'

export interface TierEntry {
  id: string
  read: TierReadRule
  groups: string[]
  path: string
}

export interface TiersFile {
  version: number
  tiers: TierEntry[]
}

export interface CallerIdentity {
  authenticated: boolean
  userId?: string | null
  roles?: readonly Role[]
  groups?: readonly string[]
}

export interface ToolCallContext {
  readableTiers: readonly string[]
  channel: ToolChannel
  userId?: string | null
  userHash?: string | null
  timeoutMs?: number
  maxResultBytes?: number
  /** Optional artificial delay hook (ms) for deterministic timeout testing. */
  testDelayMs?: number
}

export type ConceptMatchKind = 'exact' | 'alias' | 'english' | 'fuzzy'

export interface ConceptSearchHit {
  slug: string
  term: string
  english: string
  aliases: string[]
  summary: string
  url: string
  match: ConceptMatchKind
  score: number
}

export interface ConceptGraphNode {
  slug: string
  term: string
  summary: string
}

export interface ConceptGraphEdge {
  from: string
  to: string
  rel: string
}

export interface ConceptGraphResult {
  nodes: ConceptGraphNode[]
  edges: ConceptGraphEdge[]
  truncated?: boolean
}

export interface LectureSearchHit {
  id: string
  route: string
  title: string
  heading: string
  anchor: string
  snippet: string
  score: number
}

export interface LectureSummaryResult {
  id: string
  route: string
  title: string
  sections: LectureSection[]
  truncated?: boolean
}

export interface EngineToolToggle {
  enabled: boolean
}

export interface McpServerConfig {
  id: string
  name: string
  url: string
  headerEnv: Record<string, string>
  enabled: boolean
  tools: Record<string, { enabled: boolean }>
  timeoutMs?: number
}

export interface AiToolsFileConfig {
  version: 1
  engineTools: Record<string, EngineToolToggle>
  mcpServers: McpServerConfig[]
}

export interface ToolCallLogLine {
  evt: 'ai_tool_call'
  ts: string
  tool: string
  channel: ToolChannel
  ms: number
  ok: boolean
  bytes: number
  uh: string | null
}

export interface Tool7dStats {
  calls: number
  errors: number
  totalMs: number
}

export type ToolStatsByName = Record<string, Tool7dStats>
