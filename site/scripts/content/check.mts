/**
 * scripts/content/check.mts — `npm run check:content`: the content gate an author or agent runs before handing over
 * (docs/authoring/README.md; rules in docs/authoring/lecture-contract.md).
 *
 * Checks, all on the active content root from `content/paths.mts`:
 *   groups       groups.ts: duplicate id / dir (fail); a group without lectures, a lecture folder no group names (warn)
 *   lectures     the lecture contract (contract.mts): frontmatter, node line, headings, tables, chart placeholders
 *                against charts/<data-lecture>.json, internal links, required headings of check.config.json
 *   translations lectures/en/<dir>/Lxx.md: an original exists, title, same chart placeholders
 *   charts       chart files no lecture uses (warn)
 *   concepts     concept page rules (ported from check_lecture_contracts.py) + the engine's concept checks, and every
 *                `concept:` link in the lectures against the published concepts and the access tiers
 *   figures      the figure registry check (figures.json, files, checksums, citations) — same as check:figures
 *   graph        graph.json / graph-bindings.json point at lectures that exist
 *   site texts   `name` empty (either language) fails like the build; other empty fields are listed as info
 * Exit codes: 0 pass (warnings and info allowed), 1 at least one fail, 2 the check itself broke.
 * `--json` prints the report as JSON (the Dashboard reads the same shape); `--verbose` lists every info line.
 * `--only <category>[,<category>]` (or `--only=...`) reports one kind of issue: the categories are the first part of the
 * issue codes (CHECK_CATEGORIES: group, lecture, link, chart, translation, concept, figure, graph, texts). The cheap file
 * checks always run (charts nobody places need every lecture); the engine checks of other categories are skipped.
 * An unknown category is a usage error (exit 2). The Dashboard's "rerun this check" uses it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'
import { resolveContent, translationDirOf, type ContentPaths } from '../../docs/.vitepress/content/paths.mts'
import {
  checkConceptSource,
  checkGraph,
  checkLectureSource,
  compareTranslationCharts,
  type ContentIssue,
  type IssueLevel,
} from './contract.mts'
import { readCheckConfig } from './scaffold.mts'
import { TRANSLATION_LOCALE_KEYS } from './sync.mts'

const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false })

export interface ContentCheckReport {
  mode: ContentPaths['mode']
  root: string
  counts: { groups: number; lectures: number; translations: number; charts: number; concepts: number; figures: number }
  totals: Record<IssueLevel, number>
  issues: ContentIssue[]
  ok: boolean
  /** The categories this run reported (`--only`), or null for a full run. */
  only: CheckCategory[] | null
}

/** Issue categories = the first part of an issue code (`chart.file_missing` → `chart`). */
export const CHECK_CATEGORIES = ['group', 'lecture', 'link', 'chart', 'translation', 'concept', 'figure', 'graph', 'texts'] as const
export type CheckCategory = (typeof CHECK_CATEGORIES)[number]

export function categoryOf(code: string): string {
  return code.split('.')[0] ?? code
}

export function isCheckCategory(value: unknown): value is CheckCategory {
  return typeof value === 'string' && (CHECK_CATEGORIES as readonly string[]).includes(value)
}

/** `lecture,chart` → ['lecture', 'chart'] (deduplicated, in CHECK_CATEGORIES order); throws on an empty or unknown name. */
export function parseOnly(value: string | readonly string[]): CheckCategory[] {
  const names = (typeof value === 'string' ? [value] : [...value]).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)
  if (names.length === 0) throw new Error(`--only needs a category: ${CHECK_CATEGORIES.join(', ')}`)
  for (const n of names) if (!isCheckCategory(n)) throw new Error(`unknown check category "${n}" (use one of: ${CHECK_CATEGORIES.join(', ')})`)
  return CHECK_CATEGORIES.filter((c) => names.includes(c))
}

/** The `--only` value of an argv (`--only x`, `--only=x`), or null when it is absent. */
export function onlyFromArgv(argv: readonly string[]): CheckCategory[] | null {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--only') values.push(argv[i + 1] ?? '')
    else if (a.startsWith('--only=')) values.push(a.slice('--only='.length))
  }
  return values.length ? parseOnly(values) : null
}

interface GroupLike {
  id: string
  dir: string
}

function rel(paths: ContentPaths, abs: string): string {
  return path.relative(paths.root, abs).replace(/\\/g, '/')
}

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return 'invalid'
  }
}

function lectureFilesOf(dir: string): { stem: string; n: number; abs: string }[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((f) => /^L(\d+)\.md$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ stem: `L${m[1] as string}`, n: Number(m[1]), abs: path.join(dir, m[0]) }))
    .sort((a, b) => a.n - b.n)
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  // engine modules log their sources (`[groups] ...`); keep stdout clean for --json
  const con = globalThis.console
  const { log, info, warn } = con
  con.log = () => {}
  con.info = () => {}
  con.warn = () => {}
  try {
    return await fn()
  } finally {
    con.log = log
    con.info = info
    con.warn = warn
  }
}

export async function runContentCheck(options: { paths?: ContentPaths; only?: readonly CheckCategory[] | null } = {}): Promise<ContentCheckReport> {
  const paths = options.paths ?? resolveContent()
  const only = options.only && options.only.length ? CHECK_CATEGORIES.filter((c) => options.only?.includes(c)) : null
  const want = (c: CheckCategory) => !only || only.includes(c)
  const issues: ContentIssue[] = []
  const push = (...items: ContentIssue[]) => {
    issues.push(...items)
  }

  const { resolveGroups } = await jiti.import<typeof import('../../docs/.vitepress/groups-source.mts')>('../../docs/.vitepress/groups-source.mts')
  const { GROUPS } = await quietly(() => resolveGroups())
  const groups = (GROUPS as GroupLike[]).filter((g) => g && typeof g.id === 'string' && typeof g.dir === 'string')
  const groupDirs = new Set(groups.map((g) => g.dir))

  // groups
  const ids = new Map<string, number>()
  const dirs = new Map<string, number>()
  for (const g of groups) {
    ids.set(g.id.toUpperCase(), (ids.get(g.id.toUpperCase()) ?? 0) + 1)
    dirs.set(g.dir, (dirs.get(g.dir) ?? 0) + 1)
  }
  const groupsFile = rel(paths, paths.groups)
  for (const [id, n] of ids) if (n > 1) push({ level: 'fail', code: 'group.duplicate_id', file: groupsFile, message: `group id ${id} is used ${n} times` })
  for (const [d, n] of dirs) if (n > 1) push({ level: 'fail', code: 'group.duplicate_dir', file: groupsFile, message: `group dir ${d} is used ${n} times` })

  const lectureExists = (dir: string, stem: string) => fs.existsSync(path.join(paths.lecturesDir, ...dir.split('/'), `${stem}.md`))
  const chartCache = new Map<string, Record<string, { type?: unknown }> | null | 'invalid'>()
  const usedCharts = new Set<string>()
  const readChart = (lectureId: string) => {
    usedCharts.add(lectureId)
    if (!chartCache.has(lectureId)) {
      const own = path.join(paths.chartsDir, `${lectureId}.json`)
      const example = path.join(paths.exampleChartsDir, `${lectureId}.json`)
      const raw = readJson(fs.existsSync(own) ? own : example)
      chartCache.set(lectureId, raw === null || raw === 'invalid' ? raw : typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, { type?: unknown }>) : 'invalid')
    }
    return chartCache.get(lectureId) ?? null
  }
  const checkConfig = readCheckConfig(paths)

  // lectures
  let lectureCount = 0
  for (const g of groups) {
    const dir = path.join(paths.lecturesDir, ...g.dir.split('/'))
    const files = lectureFilesOf(dir)
    if (files.length === 0) {
      push({ level: 'warn', code: 'group.no_lectures', file: groupsFile, message: `group ${g.id} has no lectures yet (${rel(paths, dir)}/Lxx.md)` })
      continue
    }
    const last = files[files.length - 1]?.n
    for (const f of files) {
      lectureCount++
      push(
        ...checkLectureSource(fs.readFileSync(f.abs, 'utf8'), {
          file: rel(paths, f.abs),
          key: `${g.dir}/${f.stem}`,
          groupId: g.id,
          groupDir: g.dir,
          n: f.n,
          isLast: f.n === last,
          requiredHeadings: checkConfig.requiredHeadings,
          readChart,
          lectureExists,
          groupDirs,
        }),
      )
    }
  }
  if (paths.mode === 'content' && fs.existsSync(paths.lecturesDir)) {
    for (const entry of fs.readdirSync(paths.lecturesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || TRANSLATION_LOCALE_KEYS.has(entry.name)) continue
      const named = [...groupDirs].some((d) => d === entry.name || d.startsWith(`${entry.name}/`))
      if (!named) push({ level: 'warn', code: 'group.unlisted_dir', file: `${rel(paths, paths.lecturesDir)}/${entry.name}`, message: `lectures/${entry.name}/ is not the dir of any group in groups.ts: it is copied but not listed` })
    }
  }

  // translations
  let translationCount = 0
  for (const key of TRANSLATION_LOCALE_KEYS) {
    for (const g of groups) {
      const dir = translationDirOf(paths, key, g.dir)
      for (const f of lectureFilesOf(dir)) {
        translationCount++
        const file = rel(paths, f.abs)
        const original = path.join(paths.lecturesDir, ...g.dir.split('/'), `${f.stem}.md`)
        const src = fs.readFileSync(f.abs, 'utf8')
        if (!fs.existsSync(original)) {
          push({ level: 'fail', code: 'translation.no_original', file, message: `no original ${rel(paths, original)} for this translation` })
          continue
        }
        push(
          ...checkLectureSource(src, {
            file,
            key: `${key}/${g.dir}/${f.stem}`,
            groupId: g.id,
            groupDir: g.dir,
            n: f.n,
            isLast: false,
            readChart,
            lectureExists,
            groupDirs,
            translation: true,
          }),
        )
        push(...compareTranslationCharts(fs.readFileSync(original, 'utf8'), src, file))
      }
    }
  }

  // charts nobody places
  let chartFiles = 0
  if (fs.existsSync(paths.chartsDir)) {
    for (const f of fs.readdirSync(paths.chartsDir)) {
      if (!f.endsWith('.json')) continue
      chartFiles++
      const id = f.slice(0, -5)
      if (!usedCharts.has(id)) push({ level: 'warn', code: 'chart.orphan', file: `${rel(paths, paths.chartsDir)}/${f}`, message: `no lecture places a chart from ${f}` })
    }
  }

  // concept pages: file rules
  let conceptCount = 0
  if (want('concept') && fs.existsSync(paths.conceptsDir)) {
    const scan = (dir: string, isDraft: boolean) => {
      if (!fs.existsSync(dir)) return
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue
        const abs = path.join(dir, f)
        if (!fs.statSync(abs).isFile()) continue
        if (!isDraft) conceptCount++
        push(...checkConceptSource(fs.readFileSync(abs, 'utf8'), { file: rel(paths, abs), isDraft }))
      }
    }
    scan(paths.conceptsDir, false)
    scan(path.join(paths.conceptsDir, '_drafts'), true)
  }

  // engine checks: figures, concepts, concept links in lectures (jiti: the script starts with a hashbang)
  const figureMod = want('figure') || want('concept') ? await jiti.import<typeof import('../figures/check_figures.mjs')>('../figures/check_figures.mjs') : null
  let figureCount = 0
  if (figureMod && want('figure')) {
    const figures = await quietly(() => figureMod.runFiguresCheck())
    figureCount = (figures.gallery as unknown[]).length
    for (const e of figures.errors as string[]) push({ level: 'fail', code: 'figure.error', message: e })
    for (const w of figures.warnings as string[]) push({ level: 'warn', code: 'figure.warning', message: w })
  }
  if (figureMod && want('concept')) {
    const concepts = await quietly(() => figureMod.runConceptsCheck())
    for (const e of concepts.errors as string[]) push({ level: 'fail', code: 'concept.check', message: e })
    for (const w of concepts.warnings as string[]) push({ level: 'warn', code: 'concept.check_warning', message: w })
    for (const e of await quietly(() => lectureConceptLinkErrors(paths, groups))) push({ level: 'fail', code: 'concept.link', message: e })
  }

  // graph
  const lectureLinkExists = (link: string) => {
    const m = /^\/?(.+)\/(L\d+)(?:\.md|\.html)?$/.exec(link.split('#')[0] ?? '')
    return !!m && lectureExists(m[1] as string, m[2] as string)
  }
  if (want('graph')) {
    push(
      ...checkGraph({
        graph: readJson(paths.graphDir.graph),
        bindings: readJson(paths.graphDir.graphBindings),
        graphFile: rel(paths, paths.graphDir.graph),
        bindingsFile: rel(paths, paths.graphDir.graphBindings),
        lectureLinkExists,
      }),
    )
  }

  // site texts
  if (want('texts')) {
    const textsMod = await jiti.import<typeof import('../../docs/.vitepress/site-texts.mts')>('../../docs/.vitepress/site-texts.mts')
    const textsFile = rel(paths, fs.existsSync(paths.siteTexts) ? paths.siteTexts : paths.siteTextsExample)
    try {
      const texts = textsMod.loadSiteTexts()
      for (const issue of textsMod.validateSiteTexts(texts).issues) {
        push({ level: 'fail', code: `texts.${issue.code}`, file: textsFile, message: textsMod.formatIssue(issue) })
      }
      for (const e of textsMod.listEmptyFields(texts)) {
        if (!e.required) push({ level: 'info', code: 'texts.empty', file: textsFile, message: `${e.locale}.${e.field} is empty (its empty-value rule applies)` })
      }
    } catch (err) {
      push({ level: 'fail', code: 'texts.unreadable', file: textsFile, message: err instanceof Error ? err.message : String(err) })
    }
  }

  const reported = only ? issues.filter((i) => (only as readonly string[]).includes(categoryOf(i.code))) : issues
  const totals: Record<IssueLevel, number> = { fail: 0, warn: 0, info: 0 }
  for (const i of reported) totals[i.level]++
  return {
    mode: paths.mode,
    root: paths.root,
    counts: {
      groups: groups.length,
      lectures: lectureCount,
      translations: translationCount,
      charts: chartFiles,
      concepts: conceptCount,
      figures: figureCount,
    },
    totals,
    issues: reported,
    ok: totals.fail === 0,
    only,
  }
}

async function lectureConceptLinkErrors(paths: ContentPaths, groups: GroupLike[]): Promise<string[]> {
  const { loadConceptRecords, scanLectureFiles, validateAllLectureConceptLinks } = await jiti.import<
    typeof import('../../docs/.vitepress/concepts/node.mts')
  >('../../docs/.vitepress/concepts/node.mts')
  const { resolveBuildAccess } = await jiti.import<typeof import('../../docs/.vitepress/access/build.mts')>('../../docs/.vitepress/access/build.mts')
  const { loadLectureConfig } = await jiti.import<typeof import('../../docs/.vitepress/content/config.mts')>('../../docs/.vitepress/content/config.mts')
  const config = loadLectureConfig({ paths })
  const accessPlan = resolveBuildAccess(config.access, groups as never)
  const records = loadConceptRecords({
    content: paths,
    accessPlan,
    builtGroupIds: new Set(groups.map((g) => g.id)),
    includeDrafts: false,
    isDev: false,
    localeKeys: [],
  })
  const lectures = scanLectureFiles({ content: paths, groups, accessPlan })
  return validateAllLectureConceptLinks({ lectures, records }).errors
}

export function formatReport(report: ContentCheckReport, options: { verbose?: boolean } = {}): string {
  const out: string[] = [`[check:content] ${report.root} (${report.mode} mode${report.only ? `, only ${report.only.join(', ')}` : ''})`]
  const order: IssueLevel[] = ['fail', 'warn']
  for (const level of order) {
    for (const i of report.issues.filter((x) => x.level === level)) {
      out.push(`${level.toUpperCase()} ${i.file ? `${i.file}${i.line ? `:${i.line}` : ''} ` : ''}[${i.code}] ${i.message}`)
    }
  }
  const infos = report.issues.filter((x) => x.level === 'info')
  if (options.verbose) {
    for (const i of infos) out.push(`INFO ${i.file ? `${i.file} ` : ''}[${i.code}] ${i.message}`)
  } else if (infos.length > 0) {
    const byCode = new Map<string, number>()
    for (const i of infos) byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1)
    out.push(`INFO ${[...byCode].map(([c, n]) => `${c} x${n}`).join(', ')} (--verbose lists them)`)
  }
  const c = report.counts
  out.push(
    `[check:content] ${c.groups} groups, ${c.lectures} lectures, ${c.translations} translations, ${c.charts} chart files, ${c.concepts} concepts, ${c.figures} figures — ` +
      `FAIL ${report.totals.fail}, WARN ${report.totals.warn}, INFO ${report.totals.info}`,
  )
  out.push(report.ok ? '[check:content] PASS' : '[check:content] FAIL: fix the lines above (content only lives in the content folder)')
  return out.join('\n')
}

async function main(): Promise<void> {
  let only: CheckCategory[] | null
  try {
    only = onlyFromArgv(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`[check:content] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(2)
  }
  const report = await runContentCheck({ only })
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else process.stdout.write(`${formatReport(report, { verbose: process.argv.includes('--verbose') })}\n`)
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`[check:content] BROKEN: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
    process.exit(2)
  })
}
