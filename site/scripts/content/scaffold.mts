/**
 * scripts/content/scaffold.mts — the content scaffolding behind `npm run init`, `npm run new:group` and
 * `npm run new:lecture` (docs/authoring/README.md).
 *
 * Every path comes from `content/paths.mts`; nothing here builds a content path by hand.
 *   initContent   copies `templates/content/` to the init target (LECTURE_CONTENT_DIR or <repo>/content) and creates
 *                 the empty content folders. Refuses when the target exists and is not empty.
 *   newGroup      appends one entry to `groups.ts` (text insertion before the closing bracket of `GROUPS`, then the
 *                 file is loaded again to prove the entry is there) and writes `lectures/<dir>/index.md`.
 *   newLecture    writes `lectures/<dir>/Lxx.md` (and optionally `lectures/en/<dir>/Lxx.md`) in the lecture contract
 *                 (docs/authoring/lecture-contract.md). Lecture and chart counts are derived by the engine, so
 *                 `groups.ts` is not touched.
 * All three refuse symlinks on the way and never overwrite a file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { resolveContent, translationDirOf, type ContentPaths } from '../../docs/.vitepress/content/paths.mts'
import { loadTsModule } from '../../docs/.vitepress/content/ts-loader.mts'
import { ENGINE_COLLISION_NAMES, TRANSLATION_LOCALE_KEYS } from './sync.mts'

export class ScaffoldError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 2) {
    super(message)
    this.name = 'ScaffoldError'
    this.exitCode = exitCode
  }
}

export const GROUP_ID_RE = /^[A-Z][A-Z0-9]{0,11}$/
export const GROUP_DIR_RE = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/
export const NODE_ID_RE = /^[a-zA-Z0-9_.-]+$/
export const HEX_COLOUR_RE = /^#[0-9a-fA-F]{6}$/
const DEFAULT_ACCENT = '#3B82F6'

function assertNotSymlink(abs: string, label: string): void {
  if (fs.existsSync(abs) && fs.lstatSync(abs).isSymbolicLink()) {
    throw new ScaffoldError(`Refusing symlink ${label}: ${abs}`)
  }
}

function writeNewFile(abs: string, text: string): void {
  if (fs.existsSync(abs)) throw new ScaffoldError(`Refusing to overwrite ${abs}`)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text, { encoding: 'utf8', flag: 'wx' })
}

// ── init ────────────────────────────────────────────────────────────────────

export interface InitResult {
  root: string
  files: string[]
  dirs: string[]
}

function copyTemplateTree(srcDir: string, destDir: string, files: string[], rel = ''): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const src = path.join(srcDir, entry.name)
    if (entry.isSymbolicLink() || fs.lstatSync(src).isSymbolicLink()) throw new ScaffoldError(`Refusing symlink in the template: ${src}`)
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      copyTemplateTree(src, dest, files, relPath)
    } else if (entry.isFile()) {
      writeNewFile(dest, fs.readFileSync(src, 'utf8'))
      files.push(relPath)
    }
  }
}

/** Create a content root from `templates/content/` at `paths.initTarget`. */
export function initContent(options: { paths?: ContentPaths } = {}): InitResult {
  const paths = options.paths ?? resolveContent()
  const target = paths.initTarget
  if (!fs.existsSync(paths.templateDir)) throw new ScaffoldError(`The content template is missing: ${paths.templateDir}`)
  assertNotSymlink(target, 'init target')
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new ScaffoldError(`${target} exists and is not a folder`)
    if (fs.readdirSync(target).length > 0) {
      throw new ScaffoldError(
        `${target} already exists and is not empty: init only creates a new content folder. ` +
          'Use `npm run new:group` / `npm run new:lecture` to add to it.',
      )
    }
  }
  fs.mkdirSync(target, { recursive: true })
  const files: string[] = []
  copyTemplateTree(paths.templateDir, target, files)
  // the content folders the template cannot carry (git keeps no empty folders); their paths come from the content layout
  const layout = resolveContent({ repoRoot: paths.repoRoot, env: { LECTURE_CONTENT_DIR: target } })
  const dirs = [layout.lecturesDir, layout.chartsDir, layout.figuresDir, layout.conceptsDir, layout.graphDir.dir]
  for (const d of dirs) fs.mkdirSync(d, { recursive: true })
  return { root: target, files, dirs: dirs.map((d) => path.relative(target, d).replace(/\\/g, '/')) }
}

// ── groups.ts ───────────────────────────────────────────────────────────────

export interface GroupLike {
  id: string
  dir: string
  title?: string
  [key: string]: unknown
}

function requireContentMode(paths: ContentPaths): void {
  if (paths.mode !== 'content') {
    throw new ScaffoldError('No content folder is active (in-place mode). Run `npm run init` first, or set LECTURE_CONTENT_DIR.')
  }
}

export async function loadContentGroups(paths: ContentPaths): Promise<GroupLike[]> {
  if (!fs.existsSync(paths.groups)) return []
  assertNotSymlink(paths.groups, 'groups.ts')
  const mod = await loadTsModule<{ GROUPS?: unknown; GROUP_META?: unknown }>(paths.groups)
  const list = mod.GROUPS ?? mod.GROUP_META
  if (!Array.isArray(list)) throw new ScaffoldError(`${paths.groups} does not export a GROUPS array`)
  return list.filter((g): g is GroupLike => !!g && typeof g === 'object' && typeof (g as GroupLike).id === 'string')
}

/** Single-quoted TS string literal. */
export function tsString(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}'`
}

/**
 * Index of the `]` closing the `GROUPS` (or `GROUP_META`) array literal, skipping strings, template literals and
 * comments. Throws when the file has no such array.
 */
export function findGroupsArrayEnd(source: string): { open: number; close: number } {
  const m = /export\s+const\s+(?:GROUPS|GROUP_META)\b[^=]*=\s*\[/.exec(source)
  if (!m) throw new ScaffoldError('groups.ts has no `export const GROUPS = [` array literal to append to')
  const open = m.index + m[0].length - 1
  let depth = 0
  let i = open
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) break
      i = end + 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i++
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (ch === '[' || ch === '{' || ch === '(') depth++
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth--
      if (depth === 0) {
        if (ch !== ']') break
        return { open, close: i }
      }
    }
    i++
  }
  throw new ScaffoldError('groups.ts: could not find the end of the GROUPS array')
}

export interface NewGroupInput {
  id: string
  dir: string
  title: string
  tagline?: string
  summary?: string
  accent?: string
  tags?: string[]
  category?: string
  temp?: boolean
  titleEn?: string
  taglineEn?: string
  summaryEn?: string
  categoryEn?: string
}

export function renderGroupEntry(g: NewGroupInput): string {
  const lines = [
    '  {',
    `    id: ${tsString(g.id)},`,
    `    dir: ${tsString(g.dir)},`,
    `    title: ${tsString(g.title)},`,
    `    tagline: ${tsString(g.tagline ?? '')},`,
    `    summary: ${tsString(g.summary ?? '')},`,
    `    accent: ${tsString(g.accent ?? DEFAULT_ACCENT)},`,
    `    tags: [${(g.tags ?? []).map(tsString).join(', ')}],`,
  ]
  if (g.category) lines.push(`    category: ${tsString(g.category)},`)
  if (g.temp) lines.push('    temp: true,')
  const en: string[] = []
  if (g.titleEn) en.push(`title: ${tsString(g.titleEn)}`)
  if (g.taglineEn) en.push(`tagline: ${tsString(g.taglineEn)}`)
  if (g.summaryEn) en.push(`summary: ${tsString(g.summaryEn)}`)
  if (g.categoryEn) en.push(`category: ${tsString(g.categoryEn)}`)
  if (en.length > 0) lines.push(`    i18n: { en: { ${en.join(', ')} } },`)
  lines.push('  },')
  return lines.join('\n')
}

/** `source` with `entry` appended as the last element of the GROUPS array. */
export function appendGroupEntry(source: string, entry: string): string {
  const { open, close } = findGroupsArrayEnd(source)
  const inner = source.slice(open + 1, close)
  const trimmed = inner.replace(/\s+$/, '')
  const needsComma = trimmed.trim() !== '' && !trimmed.endsWith(',') && !trimmed.endsWith('[')
  const head = source.slice(0, open + 1) + trimmed + (needsComma ? ',' : '')
  return `${head}\n${entry}\n${source.slice(close)}`
}

export function validateGroupInput(g: NewGroupInput, existing: readonly GroupLike[]): string[] {
  const problems: string[] = []
  if (!GROUP_ID_RE.test(g.id)) problems.push(`id "${g.id}": use 1-12 upper-case letters or digits starting with a letter (e.g. G01)`)
  if (!GROUP_DIR_RE.test(g.dir)) problems.push(`dir "${g.dir}": use lower-case letters, digits and dashes, "/" for a nested folder`)
  const top = g.dir.split('/')[0] ?? ''
  if (ENGINE_COLLISION_NAMES.has(top) || TRANSLATION_LOCALE_KEYS.has(top)) problems.push(`dir "${g.dir}": "${top}" is an engine folder`)
  if (!g.title || g.title.trim() === '') problems.push('title is required')
  if (g.accent && !HEX_COLOUR_RE.test(g.accent)) problems.push(`accent "${g.accent}": use #RRGGBB`)
  if (existing.some((x) => x.id.toUpperCase() === g.id.toUpperCase())) problems.push(`id "${g.id}" is already used in groups.ts`)
  if (existing.some((x) => typeof x.dir === 'string' && x.dir === g.dir)) problems.push(`dir "${g.dir}" is already used in groups.ts`)
  return problems
}

export function renderGroupIndex(g: NewGroupInput): string {
  const title = `${g.id} · ${g.title}`
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `description: ${JSON.stringify(g.tagline ?? '')}`,
    'outline: false',
    'sidebar: false',
    'aside: false',
    '---',
    '',
    '<GroupIndex />',
    '',
  ].join('\n')
}

export interface NewGroupResult {
  group: NewGroupInput
  files: string[]
}

export async function newGroup(input: NewGroupInput, options: { paths?: ContentPaths } = {}): Promise<NewGroupResult> {
  const paths = options.paths ?? resolveContent()
  requireContentMode(paths)
  if (!fs.existsSync(paths.groups)) throw new ScaffoldError(`${paths.groups} does not exist (run \`npm run init\`)`)
  const existing = await loadContentGroups(paths)
  const problems = validateGroupInput(input, existing)
  if (problems.length > 0) throw new ScaffoldError(`Cannot add the group:\n  - ${problems.join('\n  - ')}`)

  const groupDir = path.join(paths.lecturesDir, ...input.dir.split('/'))
  const indexFile = path.join(groupDir, 'index.md')
  if (fs.existsSync(indexFile)) throw new ScaffoldError(`Refusing to overwrite ${indexFile}`)

  const before = fs.readFileSync(paths.groups, 'utf8')
  const after = appendGroupEntry(before, renderGroupEntry(input))
  fs.writeFileSync(paths.groups, after, 'utf8')
  const reloaded = await loadContentGroups(paths).catch((err: unknown) => {
    fs.writeFileSync(paths.groups, before, 'utf8')
    throw new ScaffoldError(`groups.ts no longer loads after the edit (restored): ${err instanceof Error ? err.message : String(err)}`)
  })
  if (!reloaded.some((g) => g.id === input.id && g.dir === input.dir)) {
    fs.writeFileSync(paths.groups, before, 'utf8')
    throw new ScaffoldError('groups.ts did not contain the new group after the edit (restored)')
  }
  writeNewFile(indexFile, renderGroupIndex(input))
  return {
    group: input,
    files: [paths.groups, indexFile].map((f) => path.relative(paths.root, f).replace(/\\/g, '/')),
  }
}

// ── lectures ────────────────────────────────────────────────────────────────

export type RootLanguage = 'zh-CN' | 'en'

export interface NewLectureInput {
  /** Group id (case-insensitive) or dir. */
  group: string
  title: string
  /** Lecture number; default: one past the highest existing `Lxx.md` of the group. */
  n?: number
  node?: string
  difficulty?: number
  minutes?: number
  /** Also write the English translation skeleton with this title. */
  titleEn?: string
}

export function lectureStem(n: number): string {
  return `L${String(n).padStart(2, '0')}`
}

export function existingLectureNumbers(dir: string): number[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .map((f) => /^L(\d+)\.md$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
}

interface LectureLabels {
  title: (n: number, t: string) => string
  node: string
  group: string
  difficulty: string
  estimated: string
  opening: string
  openingHint: string
  section: string
  sectionHint: string
  references: string
  referencesHint: string
}

const LABELS: Record<RootLanguage, LectureLabels> = {
  'zh-CN': {
    title: (n, t) => `第${n}讲 · ${t}`,
    node: '节点',
    group: '亚组',
    difficulty: '难度',
    estimated: '预估',
    opening: '开篇',
    openingHint: '一段话：这一讲回答什么问题，读完能做什么。',
    section: '第一节',
    sectionHint: '正文。图表与插图的写法见引擎 docs/authoring/lecture-contract.md（图表占位 + charts/ 数据；插图登记在 figures/）。',
    references: '参考',
    referencesHint: '每条出处写清书名与节号、论文与图号或标准与条款。',
  },
  en: {
    title: (n, t) => `Lecture ${n} · ${t}`,
    node: 'Node',
    group: 'Group',
    difficulty: 'Difficulty',
    estimated: 'Estimated',
    opening: 'Opening',
    openingHint: 'One paragraph: the question this lecture answers and what the reader can do afterwards.',
    section: 'First section',
    sectionHint: 'Body text. Charts and figures: see docs/authoring/lecture-contract.md of the engine (a chart placeholder plus data in charts/; figures registered in figures/).',
    references: 'References',
    referencesHint: 'Name every source: book and section, paper and figure, or standard and clause.',
  },
}

export function renderInfoLine(lang: RootLanguage, groupId: string, input: Pick<NewLectureInput, 'node' | 'difficulty' | 'minutes'>): string {
  const L = LABELS[lang]
  const parts: string[] = []
  if (input.node) parts.push(`${L.node} \`${input.node}\``)
  parts.push(`${L.group}: ${groupId}`)
  parts.push(`${L.difficulty} ${'★'.repeat(Math.min(5, Math.max(1, input.difficulty ?? 2)))}`)
  parts.push(`${L.estimated} ${Math.max(5, input.minutes ?? 60)}min`)
  return parts.join(' ｜ ')
}

export interface RenderLectureOptions {
  lang: RootLanguage
  groupId: string
  n: number
  title: string
  node?: string
  difficulty?: number
  minutes?: number
  /** Headings the site's check.config.json requires (for example a closing "next lecture" section). */
  requiredHeadings?: readonly string[]
}

export function renderLecture(o: RenderLectureOptions): string {
  const L = LABELS[o.lang]
  const fullTitle = L.title(o.n, o.title)
  const info = renderInfoLine(o.lang, o.groupId, o)
  const lines = [
    '---',
    `title: ${JSON.stringify(fullTitle)}`,
    `order: ${o.n}`,
    `description: ${JSON.stringify(info)}`,
    'outline: deep',
    '---',
    '',
    `# ${fullTitle}`,
    '',
    `> ${info}`,
    '',
    `## ${L.opening}`,
    '',
    `<!-- ${L.openingHint} -->`,
    '',
    `## ${L.section}`,
    '',
    `<!-- ${L.sectionHint} -->`,
    '',
    `## ${L.references}`,
    '',
    `<!-- ${L.referencesHint} -->`,
    '',
  ]
  for (const h of o.requiredHeadings ?? []) {
    lines.push(h, '', '<!-- -->', '')
  }
  return lines.join('\n')
}

export interface CheckConfig {
  requiredHeadings: { heading: string; exceptLastLecture?: boolean; exempt?: string[] }[]
}

export function readCheckConfig(paths: ContentPaths): CheckConfig {
  if (!fs.existsSync(paths.checkConfig)) return { requiredHeadings: [] }
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(paths.checkConfig, 'utf8'))
  } catch (err) {
    throw new ScaffoldError(`${paths.checkConfig} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const list = (raw as { requiredHeadings?: unknown })?.requiredHeadings
  if (list !== undefined && !Array.isArray(list)) throw new ScaffoldError(`${paths.checkConfig}: requiredHeadings must be an array`)
  const out: CheckConfig = { requiredHeadings: [] }
  for (const item of (list ?? []) as unknown[]) {
    const h = item as { heading?: unknown; exceptLastLecture?: unknown; exempt?: unknown }
    if (typeof h?.heading !== 'string' || !/^#{2,6} \S/.test(h.heading)) {
      throw new ScaffoldError(`${paths.checkConfig}: every requiredHeadings item needs "heading" like "## Next lecture"`)
    }
    out.requiredHeadings.push({
      heading: h.heading,
      exceptLastLecture: h.exceptLastLecture !== false,
      exempt: Array.isArray(h.exempt) ? h.exempt.filter((x): x is string => typeof x === 'string') : [],
    })
  }
  return out
}

export async function readRootLanguage(paths: ContentPaths): Promise<RootLanguage> {
  if (!fs.existsSync(paths.siteConfig)) return 'zh-CN'
  const mod = await loadTsModule<{ default?: { i18n?: { root?: unknown } } }>(paths.siteConfig)
  return mod.default?.i18n?.root === 'en' ? 'en' : 'zh-CN'
}

export interface NewLectureResult {
  group: GroupLike
  n: number
  files: string[]
}

export async function newLecture(input: NewLectureInput, options: { paths?: ContentPaths } = {}): Promise<NewLectureResult> {
  const paths = options.paths ?? resolveContent()
  requireContentMode(paths)
  const groups = await loadContentGroups(paths)
  const key = input.group.trim()
  const group = groups.find((g) => g.id.toUpperCase() === key.toUpperCase() || g.dir === key)
  if (!group) {
    throw new ScaffoldError(`No group "${input.group}" in groups.ts (known: ${groups.map((g) => g.id).join(', ') || 'none'}). Add it with \`npm run new:group\`.`)
  }
  if (!input.title || input.title.trim() === '') throw new ScaffoldError('title is required')
  if (input.node !== undefined && !NODE_ID_RE.test(input.node)) throw new ScaffoldError(`node "${input.node}": use letters, digits, "_", "." or "-"`)
  const dirParts = group.dir.split('/')
  const lectureDir = path.join(paths.lecturesDir, ...dirParts)
  assertNotSymlink(lectureDir, 'group folder')
  const taken = existingLectureNumbers(lectureDir)
  const n = input.n ?? (taken.length > 0 ? (taken[taken.length - 1] as number) + 1 : 1)
  if (!Number.isInteger(n) || n < 0 || n > 999) throw new ScaffoldError(`lecture number ${String(n)}: use an integer 0-999`)
  if (taken.includes(n)) throw new ScaffoldError(`${group.dir}/${lectureStem(n)}.md already exists`)

  const lang = await readRootLanguage(paths)
  const required = readCheckConfig(paths).requiredHeadings.map((h) => h.heading)
  const files: string[] = []
  const file = path.join(lectureDir, `${lectureStem(n)}.md`)
  writeNewFile(
    file,
    renderLecture({ lang, groupId: group.id, n, title: input.title.trim(), node: input.node, difficulty: input.difficulty, minutes: input.minutes, requiredHeadings: required }),
  )
  files.push(file)
  if (input.titleEn) {
    const enFile = path.join(translationDirOf(paths, 'en', group.dir), `${lectureStem(n)}.md`)
    writeNewFile(
      enFile,
      renderLecture({ lang: 'en', groupId: group.id, n, title: input.titleEn.trim(), node: input.node, difficulty: input.difficulty, minutes: input.minutes }),
    )
    files.push(enFile)
  }
  return { group, n, files: files.map((f) => path.relative(paths.root, f).replace(/\\/g, '/')) }
}
