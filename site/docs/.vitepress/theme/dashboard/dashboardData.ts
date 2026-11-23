/**
 * theme/dashboard/dashboardData.ts — pure helpers that turn the `check:content --json` report into what the Overview and
 * Content-check pages show (to-dos, per-group and per-lecture state). No DOM, no fetches: unit-testable.
 */
import type { MessageKey } from '../../i18n/index.ts'
import type { CheckIssue, CheckReport } from '../api/devDashboard'
import type { DashboardPageId } from './useDashboard'

export interface DashGroup {
  id: string
  dir: string
  title: string
  lectureCount?: number
  chartCount?: number
  lectures?: { n: number; text: string; link: string }[]
  i18n?: { en?: { title?: string } }
}

export type MarkKind = 'ok' | 'half' | 'warn' | 'bad' | 'off'

export interface TodoItem {
  k: MarkKind
  title: string
  detail: string
  file?: string
  go: [DashboardPageId, string?]
}

type T = (key: MessageKey, params?: Record<string, string | number>) => string

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * The reader limits lecture-api enforces (keys, built-in defaults, allowed range): the same table as `LIMIT_KEYS` in
 * plugins/dashboardDevExtras.mts (a unit test keeps them equal). Shown when there are no runtime numbers (online, or the
 * local runtime read failed) so the page says where the values come from and how to change them (S6Y decision: the
 * limits stay read-only; the Dashboard never writes server/.env).
 */
export const READER_LIMIT_DEFAULTS: ReadonlyArray<{ key: string; def: number; min: number; max: number }> = [
  { key: 'AI_DAILY_LIMIT', def: 300, min: 1, max: 100000 },
  { key: 'AI_RATE_PER_MINUTE', def: 20, min: 1, max: 600 },
  { key: 'AI_MAX_CONCURRENT', def: 2, min: 1, max: 20 },
]
/**
 * The Dashboard's one time format: `11-21 15:58` in local time (prototype v3.4; the same in both languages), instead of
 * `toLocaleString()` with the browser's locale (an en-US browser wrote `11/23/2026, 9:24:13 PM` on a Chinese page).
 * Anything that is not a date is returned as it came.
 */
export function shortDateTime(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Is `file` (content-relative) a lecture of the group folder `dir` (not a translation)? */
function inGroup(file: string | undefined, dir: string): boolean {
  if (!file) return false
  const f = file.replace(/\\/g, '/')
  return (f.startsWith(`lectures/${dir}/`) || f.includes(`/docs/${dir}/`) || f.startsWith(`${dir}/`)) && !f.startsWith('lectures/en/')
}

export function groupIssueCounts(report: CheckReport, dir: string): { fail: number; warn: number } {
  let fail = 0
  let warn = 0
  for (const i of report.issues) {
    if (!inGroup(i.file, dir)) continue
    if (i.level === 'fail') fail++
    else if (i.level === 'warn') warn++
  }
  return { fail, warn }
}

export function issuesOfLecture(report: CheckReport, dir: string, n: number): CheckIssue[] {
  const stems = [`L${String(n).padStart(2, '0')}.md`, `L${n}.md`]
  return report.issues.filter((i) => i.level !== 'info' && inGroup(i.file, dir) && stems.some((s) => (i.file ?? '').endsWith(`/${s}`)))
}

/** Failing checks first (one item per file, at most 8), then a single line for the empty site texts. */
export function todoFromChecks(report: CheckReport | null, t: T): TodoItem[] {
  if (!report) return []
  const out: TodoItem[] = []
  const byFile = new Map<string, CheckIssue[]>()
  for (const i of report.issues) {
    if (i.level !== 'fail') continue
    const key = i.file ?? i.code
    byFile.set(key, [...(byFile.get(key) ?? []), i])
  }
  for (const [file, list] of [...byFile].slice(0, 8)) {
    const first = list[0] as CheckIssue
    out.push({
      k: 'bad',
      title: first.message,
      detail: list.length > 1 ? t('dsh.ov.todoMore', { n: list.length - 1 }) : t('dsh.ov.todoBlocks'),
      ...(first.file ? { file: `${file}${first.line ? `:${first.line}` : ''}` } : {}),
      go: ['checks'],
    })
  }
  if (byFile.size > 8) out.push({ k: 'bad', title: t('dsh.ov.todoMoreFiles', { n: byFile.size - 8 }), detail: '', go: ['checks'] })
  // warnings: one line per check code (most frequent first, at most 4), each pointing at the content checks page
  const warnByCode = new Map<string, CheckIssue[]>()
  for (const i of report.issues) {
    if (i.level !== 'warn') continue
    warnByCode.set(i.code, [...(warnByCode.get(i.code) ?? []), i])
  }
  for (const [code, list] of [...warnByCode].sort((a, b) => b[1].length - a[1].length).slice(0, 4)) {
    const first = list[0] as CheckIssue
    out.push({ k: 'warn', title: t('dsh.ov.todoWarn', { n: list.length, code }), detail: t('dsh.ov.todoWarnDetail', { msg: first.message }), go: ['checks'] })
  }
  const emptyTexts = report.issues.filter((i) => i.code === 'texts.empty').length
  if (emptyTexts > 0) out.push({ k: 'off', title: t('dsh.ov.todoTexts', { n: emptyTexts }), detail: t('dsh.ov.todoTextsDetail'), go: ['texts'] })
  return out
}

export interface IssueGroup {
  code: string
  level: CheckIssue['level']
  issues: CheckIssue[]
}

/** Issues grouped by code, fails first, then warnings, then info. */
export function groupIssuesByCode(report: CheckReport): IssueGroup[] {
  const map = new Map<string, IssueGroup>()
  for (const i of report.issues) {
    const g = map.get(i.code) ?? { code: i.code, level: i.level, issues: [] }
    g.issues.push(i)
    map.set(i.code, g)
  }
  const rank = { fail: 0, warn: 1, info: 2 } as const
  return [...map.values()].sort((a, b) => rank[a.level] - rank[b.level] || b.issues.length - a.issues.length || a.code.localeCompare(b.code))
}

/** The text a coding agent gets for one issue ("复制给智能体"). */
export function agentBrief(i: CheckIssue): string {
  const where = i.file ? `${i.file}${i.line ? `:${i.line}` : ''}` : '(site)'
  return [
    `check:content ${i.level.toUpperCase()} [${i.code}] ${where}`,
    i.message,
    'Fix it in the content folder only (never in site/docs/), following docs/authoring/lecture-contract.md, then run npm run check:content.',
  ].join('\n')
}
