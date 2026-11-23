/**
 * group/types.ts - shapes shared by the components of the group page (P4a WP-H3).
 */
import type { GroupI18n } from '../../i18n/data.ts'
import type { LecStatus } from './model'

/** One lecture of the page's group, as the two maps and the panel draw it. */
export interface GroupLecture {
  /** `g05-l19`. */
  id: string
  n: number
  /** Title without the "第N讲 · " prefix, in the page's language (the root-language title when the lecture is not translated). */
  title: string
  /** Page to open, base and locale prefix included except for `withBase`. */
  href: string
  /** The page and title are the root-language ones although the reader is on another language's page. */
  untranslated: boolean
  /** Notion category title ('' when the lecture has none). */
  category: string
  status: LecStatus
  ready: boolean
  /** Accessible name of the link (group, number, title, status, "ready"), already in the reader's language. */
  label: string
}

export interface LaneView {
  index: number
  /** Lane title (the Notion category, or the "all" / "unlinked" fallback). */
  name: string
  /** The title is a Notion title (Chinese) and not a UI string of the page's language. */
  notion: boolean
  lectures: GroupLecture[]
}

/** The group as `themeConfig.groups` (or a restricted group's `frontmatter.groupMeta`) carries it. */
export interface PageGroup {
  id: string
  dir: string
  title: string
  tagline: string
  summary: string
  accent?: string
  tags: string[]
  lectures: Array<{ n: number; text: string; link: string }>
  lectureCount: number
  chartCount: number
  category?: string
  catSlot?: number
  i18n?: GroupI18n
}
