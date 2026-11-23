import { z } from 'zod'
import type { EngineToolName } from './types.js'

export const searchConceptsInputSchema = z.object({
  query: z.string().trim().min(1, 'query 不能为空').describe('检索关键词（中文概念名、英文名或别名）'),
  limit: z.number().int().min(1).max(50).optional().describe('返回条数上限（默认 8，最大 50）'),
})

export const getConceptInputSchema = z.object({
  slug: z.string().trim().min(1, 'slug 不能为空').describe('概念唯一 slug 标识符'),
})

export const getConceptGraphInputSchema = z.object({
  slug: z.string().trim().min(1, 'slug 不能为空').describe('起点概念 slug'),
  depth: z.number().int().min(1).max(2).optional().describe('展开深度（1 或 2，默认 1）'),
})

export const searchLecturesInputSchema = z.object({
  query: z.string().trim().min(1, 'query 不能为空').describe('讲义检索关键词'),
  group: z.string().trim().min(1).optional().describe('可选课程分组过滤（如 G01、G03）'),
  limit: z.number().int().min(1).max(50).optional().describe('返回条数上限（默认 8，最大 50）'),
})

export const getLectureSummaryInputSchema = z.object({
  lecture: z.string().trim().min(1, 'lecture 不能为空').describe('讲义 id（如 G01-L01）或站内路由（如 /g01/L01）'),
  heading: z.string().trim().min(1).optional().describe('可选小节标题或锚点，若提供则仅返回该小节'),
})

export const TOOL_INPUT_SCHEMAS = {
  search_concepts: searchConceptsInputSchema,
  get_concept: getConceptInputSchema,
  get_concept_graph: getConceptGraphInputSchema,
  search_lectures: searchLecturesInputSchema,
  get_lecture_summary: getLectureSummaryInputSchema,
} as const

export type ToolInputMap = {
  search_concepts: z.infer<typeof searchConceptsInputSchema>
  get_concept: z.infer<typeof getConceptInputSchema>
  get_concept_graph: z.infer<typeof getConceptGraphInputSchema>
  search_lectures: z.infer<typeof searchLecturesInputSchema>
  get_lecture_summary: z.infer<typeof getLectureSummaryInputSchema>
}

export const TOOL_DESCRIPTIONS: Record<EngineToolName, string> = {
  search_concepts:
    'Search published concepts by Chinese name, alias, English name, or fuzzy match within readable tiers.',
  get_concept:
    'Fetch full details of a concept by slug, including markdown, relations, links, backlinks, and lectures.',
  get_concept_graph:
    'Explore neighboring concepts and relation edges around a concept slug (depth 1 or 2).',
  search_lectures:
    'Search readable lecture sections by query string and optional group code, returning ranked snippets.',
  get_lecture_summary:
    'Fetch lecture sections (or a specific section by heading) for a lecture id or route.',
}

export const MCP_TOOL_INPUT_SCHEMAS = {
  search_concepts: searchConceptsInputSchema.extend({
    ticket: z.string().describe('Signed short-lived tier access ticket from Dify tool_ticket'),
  }),
  get_concept: getConceptInputSchema.extend({
    ticket: z.string().describe('Signed short-lived tier access ticket from Dify tool_ticket'),
  }),
  get_concept_graph: getConceptGraphInputSchema.extend({
    ticket: z.string().describe('Signed short-lived tier access ticket from Dify tool_ticket'),
  }),
  search_lectures: searchLecturesInputSchema.extend({
    ticket: z.string().describe('Signed short-lived tier access ticket from Dify tool_ticket'),
  }),
  get_lecture_summary: getLectureSummaryInputSchema.extend({
    ticket: z.string().describe('Signed short-lived tier access ticket from Dify tool_ticket'),
  }),
} as const

export interface ZodIssueSummary {
  path: string
  message: string
}

export function summarizeZodIssues(err: z.ZodError): ZodIssueSummary[] {
  return err.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)',
    message: issue.message,
  }))
}
