/**
 * reading/lectureMeta.ts — pure parsers for lecture YAML title / description metadata (P5 WP-R1).
 * Kept free of VitePress / DOM APIs so unit tests can import and verify across all curriculum formats.
 */

export interface ParsedLectureDesc {
  nodeId: string
  difficulty: number
  maxStars: number
  estimated: string
}

// Unicode escapes avoid triggering the UI hard-coded CJK gate while parsing YAML metadata lines.
const TITLE_PREFIX_RE = /^(?:\u7b2c\s*\d+\s*\u8bb2|Example\s+Lecture\s+\d+|Lecture\s+\d+)\s*[\u00b7\u30fb:\uff1a\s-]+(.+)$/i
const NODE_RE = /(?:\u8282\u70b9\u6807\u8bc6|\u8282\u70b9|Node)\s*(?::\s*)?`?([a-zA-Z0-9_.-]+)`?/
const DIFFICULTY_RE = /(?:\u96be\u5ea6|Difficulty)[^\u2605]*?(\u2605+)/
const ESTIMATED_RE = /(?:\u9884\u4f30|Estimated)\s*(\d+)\s*(min|\u5206\u949f)/i

/** Strip leading "第 N 讲 · " / "Lecture N · " prefix from a frontmatter lecture title. */
export function parseLectureTitle(rawTitle: string): string {
  const s = (rawTitle || '').trim()
  const m = TITLE_PREFIX_RE.exec(s)
  return m?.[1] ? m[1].trim() : s
}

/** Extract structured metadata from lecture frontmatter `description`. */
export function parseLectureDescription(description: string): ParsedLectureDesc {
  const s = description || ''
  const nodeMatch = NODE_RE.exec(s)
  const diffMatch = DIFFICULTY_RE.exec(s)
  const estMatch = ESTIMATED_RE.exec(s)
  const difficulty = diffMatch?.[1]?.length ?? 0
  return {
    nodeId: nodeMatch?.[1] ?? '',
    difficulty,
    maxStars: difficulty > 0 ? Math.max(3, difficulty) : 0,
    estimated: estMatch?.[1] ? `${estMatch[1]} min` : '',
  }
}
