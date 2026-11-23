import { defineConfig, type DefaultTheme, type UserConfig } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'
import { KCONFIG, MATH, IOS, LD } from './grammars.mts'
import { mathPlugin } from './math.mts'
// 讲义导出插件：dev server 下的「按需导出」中间件（长卷 PDF / 全景长图 / A4 PDF）。
// ⚠️ 它只在 **dev** 生效；生产构建时其 apply='serve' 自会跳过，不影响静态产物。
import { lectureExportPlugin } from './plugins/lectureExportPlugin.mjs'
import { apiModePlugin } from './plugins/apiModePlugin.mjs'
import { v2ChromeStrings, v2Head, v2Home, v2Modules, v2IgnoreDeadLinks, v2Lang, v2LectureFallback, v2LocaleConfig, v2LocaleLinks, v2NavLabels, v2LocaleKeys, v2OtherLangs, v2ReadingModeHead, v2HomeMapHead, v2Search, v2SearchPlugin, v2ViteAlias, v2VitePlugins, v2WriteSearchDist, emitCompanionPromptsDist, withCategorySlots } from './config.v2.mts'
import { FALLBACK_SITE_META, resolveGroups } from './groups-source.mts'
import { assertSiteTexts, fillLecturesToken, listEmptyFields, loadSiteTexts, siteTextsProblems } from './site-texts.mts'
import { readTitle } from './i18n/scan.mts'
import { resolveContent } from './content/paths.mts'
import { loadLectureConfig } from './content/config.mts'
// P3b access tiers: which groups are built and who may read them (access/build.mts); applied to the finished config below
import { applyAccess, resolveBuildAccess } from './access/build.mts'
import { ownerOfPath } from './access/tiers.ts'
import { createFiguresMarkdownPlugin } from './figures/markdown.ts'
import { emitFiguresDistArtifacts } from './figures/gallery.ts'
// P4a: the curriculum (groups, prerequisite edges, phases) of every language; written per restricted tier by access/build.mts
import { buildCurriculumFromDisk } from './curriculum/node.mts'
import type { CurriculumBuild } from './curriculum/data.ts'
import { conceptLinkPlugin } from './plugins/conceptLinkPlugin.mts'
import { conceptsVitePlugin, writeConceptDistAssets, writeConceptToolsDist } from './plugins/conceptsPlugin.mts'
import {
  buildBacklinkPayloadsByTier,
  buildGraphFromRecords,
  computeConceptBacklinks,
  filteredOutSlugs,
  loadConceptRecords,
  rootLocaleLectures,
  runConceptChecks,
  scanLectureFiles,
  tierOfPagePath,
} from './concepts/node.mts'
import { conceptPanelsOf, type ConceptGraph } from './concepts/graph.ts'
import { countConceptSources, hasUnverifiedMarkers, parseConceptMarkdown } from './concepts/frontmatter.ts'
import { resolveConceptTier } from './concepts/access.ts'
import { tierBasePath } from './access/tiers.ts'

const contentPaths = resolveContent()
const isProductionBuild = process.argv.some((a) => a === 'build')
const lectureConfig = loadLectureConfig({ paths: contentPaths })
const docsRoot = contentPaths.docsRoot
const chartsRoot = contentPaths.chartsDir

/**
 * 解析结果只做一次模块级解构，后续所有代码的写法与改造前
 * （原本从 './groups.mts' 静态 import）**逐字一致** —— 这样这次改造
 * 对下面 200 行配置逻辑是零侵入的，降低了回归面。
 */
const { GROUPS, SITE_META } = await resolveGroups()

// Site texts: `name` is required in both locales. A production build stops with a message naming field and file;
// `vitepress dev` only warns. Other empty fields are listed once (`doctor` shows the same list).
const siteTexts = loadSiteTexts()
if (process.argv.some((a) => a === 'build')) {
  assertSiteTexts(siteTexts)
} else {
  for (const problem of siteTextsProblems(siteTexts)) console.warn(`[site-texts] ${problem}`)
}
for (const e of listEmptyFields(siteTexts)) {
  if (!e.required) console.warn(`[site-texts] ${e.locale}.${e.field} 未填写（按各字段的留空规则处理）`)
}

/** P3b: tiers of this build (config block + LECTURE_AUDIENCE / LECTURE_BUILD_GROUPS / LECTURE_ACCESS_JSON); both guards run here. */
const accessPlan = resolveBuildAccess(lectureConfig.access, GROUPS)
const figureGroupDirs = Array.from(new Set([...GROUPS.map((g) => g.dir), 'examples/g01']))
const groupIdByDir = new Map(GROUPS.map((g) => [g.dir, g.id]))
const builtGroupIds = new Set(GROUPS.map((g) => g.id))

function resolveConceptLookupMap() {
  const recs = loadConceptRecords({
    content: contentPaths,
    accessPlan,
    builtGroupIds,
    includeDrafts: !isProductionBuild,
    isDev: !isProductionBuild,
    localeKeys: v2LocaleKeys,
  })
  const bySlug = new Map<string, (typeof recs)[number]>()
  const filteredOut = filteredOutSlugs(recs)
  for (const r of recs) {
    if (r.locale !== 'root' || r.drop) continue
    // Prefer published unless viewing/linking only draft in dev
    const existing = bySlug.get(r.slug)
    if (!existing || (existing.isDraft && !r.isDraft)) {
      bySlug.set(r.slug, r)
    }
  }
  return { recs, bySlug, filteredOut }
}

const buildConceptsSnapshot = resolveConceptLookupMap()
const conceptRewrites: Record<string, string> = {}
if (isProductionBuild) {
  for (const rec of buildConceptsSnapshot.recs) {
    if (rec.isDraft || rec.drop) continue
    if (rec.tier !== accessPlan.inlineTier) {
      const prefix = rec.locale === 'root' ? '' : `${rec.locale}/`
      conceptRewrites[rec.relDocsPath] = `${prefix}${tierBasePath(rec.tier).slice(1)}/concepts/${rec.slug}.md`
    }
  }
}

const initialLecturesScan = scanLectureFiles({
  content: contentPaths,
  groups: GROUPS,
  localeKeys: v2LocaleKeys,
  accessPlan,
})
const inlineBacklinksAtConfig = buildBacklinkPayloadsByTier(
  computeConceptBacklinks(initialLecturesScan),
  accessPlan,
).inlineBySlug

// Concept checks (related, duplicate names, concept links inside concept pages): errors stop a production build and are
// printed by `vitepress dev`. The warning (a concept named in another concept's prose without a link) is listed by
// `npm run check:figures`, not here.
{
  const conceptCheck = runConceptChecks(buildConceptsSnapshot.recs)
  if (conceptCheck.errors.length > 0) {
    const message = `[concepts] ${conceptCheck.errors.length} concept error(s):\n${conceptCheck.errors.map((e) => `  ${e}`).join('\n')}`
    if (isProductionBuild) throw new Error(message)
    console.error(message)
  }
}

// Partial builds (LECTURE_BUILD_GROUPS / --audience): pages cite lectures of groups that were left out (a concept page lists
// the lectures of all its groups); those links are dead only because of the filter, so they are not reported.
// VitePress passes the link only (no source file), so the rule is the link shape: /<removed group dir>/L<n>.
const removedGroupDirs = accessPlan.removedGroupIds.map((id) => id.toLowerCase())
const partialBuildDeadLinkRule: NonNullable<UserConfig['ignoreDeadLinks']> =
  removedGroupDirs.length === 0
    ? v2IgnoreDeadLinks
    : [
        ...v2IgnoreDeadLinks,
        (url: string) => {
          const m = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?([a-z0-9]+)\/L\d+/i.exec(url)
          return Boolean(m && removedGroupDirs.includes((m[1] as string).toLowerCase()))
        },
      ]

let conceptGraphAtConfig: ConceptGraph | null = null
function conceptGraphFor(slug: string, isDraft: boolean): ConceptGraph {
  if (isProductionBuild) {
    conceptGraphAtConfig ??= buildGraphFromRecords(
      buildConceptsSnapshot.recs,
      rootLocaleLectures(initialLecturesScan, v2LocaleKeys, accessPlan),
    )
    return conceptGraphAtConfig
  }
  const live = resolveConceptLookupMap()
  const lectures = rootLocaleLectures(
    scanLectureFiles({ content: contentPaths, groups: GROUPS, localeKeys: v2LocaleKeys, accessPlan }),
    v2LocaleKeys,
    accessPlan,
  )
  const draft = isDraft ? live.recs.find((r) => r.slug === slug && r.isDraft && r.locale === 'root') : undefined
  const published = live.recs.some((r) => r.slug === slug && !r.isDraft && r.locale === 'root')
  return buildGraphFromRecords(live.recs, lectures, draft && !published ? [draft] : [])
}

/** 扫描某组目录 → 按讲号**数值**排序（两位数排序对 L100 之类会错，这里统一按数值） */
function scanLectures(dir: string) {
  const d = path.join(docsRoot, dir)
  if (!fs.existsSync(d)) return [] as { n: number; text: string; link: string }[]
  return fs
    .readdirSync(d)
    .filter((f) => /^L\d+\.md$/.test(f))
    .map((f) => {
      const n = Number(f.slice(1, -3))
      const title = readTitle(fs.readFileSync(path.join(d, f), 'utf-8'))
      return { n, text: title || v2LectureFallback(v2Lang, n), link: `/${dir}/${f.slice(0, -3)}` }
    })
    .sort((a, b) => a.n - b.n)
}

/**
 * ──────────────────────────────────────────────────────────────────────────
 * 图表统计的口径（2026-10-15 修「首页显示 0 张可交互图表」）
 * ──────────────────────────────────────────────────────────────────────────
 * 统计视图的**唯一职责**是回答「这个组的讲义页面上实际渲染出多少张图」。
 * 因此判据必须与**运行时**（theme/charts.ts 的 loadCharts）保持同源，
 * 而不是自己发明一套命名约定。
 *
 * 运行时的事实（见 theme/charts.ts:79、site.config.mts 的 DATA_FILES.chartsDir）：
 *
 *     fetch(`${DATA_FILES.chartsDir}/${lecture}.json`)   // = /charts/<data-lecture>.json
 *
 * 即：**sidecar 的文件名就是 `data-lecture` 的值**，与「组 id」没有任何必然关系。
 * `data-lecture` 是 figure 锚点上的真实字段，而 sidecar ↔ figure 的 1:1 对应
 * 是 AGENTS.md §4.1 的硬契约（由 scripts/check_figs2.py 把关）。
 *
 * 于是本函数的口径改为：
 *
 *     读 `docs/<dir>/L*.md` → 抽出正文里出现的 `data-lecture` 值 → 找 `<该值>.json`
 *
 * 为什么不能继续用「按组 id 前缀」：
 *   组 id 是**展示用编号**（首页徽章、导航、侧边栏标题都取它），
 *   而 sidecar 前缀由 `data-lecture` 决定。两者在开源版示例里**unavoidably 不同**：
 *   遵循数据与正文 1:1 双向契约，图表统计改由「正文实际引用的 data-lecture」
 *   反查对应的 sidecar JSON 文件，杜绝组 id 与图表文件名前缀脱节导致的漏统或误统。
 *
 * 为什么按「正文实际出现的 data-lecture」而不是「遍历 chartsRoot 认前缀」：
 *   后者需要猜测前缀（组 id？dir 名？），且在两组共享前缀时会重复计数。
 *   前者直接来自正文，天然 1:1，且**只统计真正被页面引用的图**——
 *   若某组有孤儿 sidecar（无对应 figure），它不会被计入本组统计，
 *   这正是统计视图该有的语义。
 */

/** 某组的图表统计结果（按类型分布） */
type ChartStats = { total: number; mermaid: number; echarts: number; wavedrom: number }

/** 从一个 md 正文里抽出所有 `data-lecture="..."` 的值（去重） */
function readLectureIds(src: string): Set<string> {
  const out = new Set<string>()
  // 只认 figure 锚点上的 data-lecture（与 check_figs2.py 的判据一致），
  // 不扫描散文里偶然出现的同名字符串。
  const re = /<figure\b[^>]*\bdata-lecture="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) out.add(m[1])
  return out
}

/** 累加一个 sidecar JSON 的类型分布到统计结果上 */
function countChartTypes(fullPath: string, out: ChartStats) {
  try {
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as Record<
      string,
      { type?: string }
    >
    for (const k of Object.keys(data)) {
      out.total++
      const t = data[k]?.type
      if (t === 'mermaid' || t === 'echarts' || t === 'wavedrom') out[t]++
    }
  } catch {
    /* 单个 JSON 异常不阻断构建（与改造前一致） */
  }
}

/**
 * 统计某组图表数量与类型分布。
 *
 * 参数是**组目录**（`dir`，如 `examples/g01`）而非组 id —— 因为判据来自
 * 该目录下讲义正文里的 `data-lecture`，不再依赖组 id 的命名约定。
 * 读 sidecar JSON 而非手写数字，避免「写死的数字与实际不同步」。
 */
function scanCharts(dir: string) {
  const out: ChartStats = { total: 0, mermaid: 0, echarts: 0, wavedrom: 0 }
  const d = path.join(docsRoot, dir)
  if (!fs.existsSync(d)) return out // 目录不存在（引擎裸奔形态）→ 0，不报错

  const exampleChartsRoot = contentPaths.exampleChartsDir

  for (const f of fs.readdirSync(d)) {
    if (!/^L\d+\.md$/.test(f)) continue
    let src: string
    try {
      src = fs.readFileSync(path.join(d, f), 'utf-8')
    } catch {
      continue
    }
    for (const lecture of readLectureIds(src)) {
      const sidecar = `${lecture}.json`
      const p1 = path.join(chartsRoot, sidecar)
      const p2 = path.join(exampleChartsRoot, sidecar)
      if (fs.existsSync(p1)) {
        countChartTypes(p1, out)
      } else if (fs.existsSync(p2)) {
        countChartTypes(p2, out)
      }
    }
  }
  return out
}

/** 首页 / 组内页 / 侧边栏共用的课程组数据（唯一来源是解析出的课程组定义 + 目录扫描） */
// colour slots are assigned over ALL groups first, so a group keeps its colour when others are left out of the build
const groups = withCategorySlots(GROUPS).filter((g) => accessPlan.keptGroupIds.includes(g.id)).map((g) => {
  const lectures = scanLectures(g.dir)
  // 传 `dir` 而非 `id`：统计判据已改为「组目录下讲义正文里的 data-lecture」，
  // 与组 id 的命名约定解耦（理由见 scanCharts 上方注释）。
  const chartTypes = scanCharts(g.dir)
  return { ...g, lectures, lectureCount: lectures.length, chartCount: chartTypes.total, chartTypes }
}).sort((a, b) => Number(!!a.temp) - Number(!!b.temp)) // 临时挂载的课程组**永远排最后**（sort 稳定，组内保持声明顺序）

const totals = groups.reduce(
  (a, g) => ({ lectures: a.lectures + g.lectureCount, charts: a.charts + g.chartCount }),
  { lectures: 0, charts: 0 }
)

const navLabels = v2NavLabels(v2Lang)

/** Built on first use (the build end and the dev server's /_access/ routes), not at config load. */
let curriculumBuild: CurriculumBuild | undefined
const curriculum = (): CurriculumBuild =>
  (curriculumBuild ??= buildCurriculumFromDisk({
    docsRoot,
    graphFile: contentPaths.graphDir.graph,
    notionFile: contentPaths.graphDir.graphNotion,
    allGroups: GROUPS,
    keptGroupIds: accessPlan.keptGroupIds,
    rootLang: v2Lang,
    otherLangs: v2OtherLangs,
  }))

const localeConfigBlock = v2LocaleConfig({
  groups,
  totals,
  siteMeta: SITE_META,
  includeRootPath: (rootPath) => {
    const owner = ownerOfPath(rootPath, GROUPS, [])
    return owner === null || accessPlan.keptGroupIds.includes(owner.groupId)
  },
})

export default async () =>
  applyAccess(defineConfig({
    lang: v2Lang,
    title: SITE_META.name || FALLBACK_SITE_META.name,
    description: fillLecturesToken(SITE_META.description || SITE_META.tagline, totals.lectures),
    cleanUrls: true,
    lastUpdated: true,
    ignoreDeadLinks: partialBuildDeadLinkRule,
    // P2d: locales (nav / sidebar / chrome per language), srcExclude for disabled languages, SITE_URL: sitemap + hreflang
    ...localeConfigBlock,
    ...(Object.keys(conceptRewrites).length > 0 ? { rewrites: conceptRewrites } : {}),
    transformPageData: async (pageData, ctx) => {
      if (localeConfigBlock.transformPageData) {
        await localeConfigBlock.transformPageData(pageData, ctx)
      }
      const rawRel = String(pageData.filePath ?? pageData.relativePath ?? '').replace(/\\/g, '/')
      const conceptMatch = /^(?:([a-z]{2}(?:-[a-z]{2})?)\/)?concepts\/(?:(_drafts)\/)?([^/]+)\.md$/i.exec(rawRel)
      if (!conceptMatch) return
      const isDraft = Boolean(conceptMatch[2])
      const slug = conceptMatch[3] as string
      const fm = (pageData.frontmatter ??= {}) as Record<string, unknown>
      fm.layout = fm.layout ?? 'doc'
      fm.sidebar = false
      fm.prev = false
      fm.next = false
      fm.aside = fm.aside ?? true
      fm.conceptSlug = slug
      fm.conceptIsDraft = isDraft

      const absPath = path.join(docsRoot, rawRel)
      const fallbackPath = isDraft ? path.join(contentPaths.conceptsDir, '_drafts', `${slug}.md`) : path.join(contentPaths.conceptsDir, `${slug}.md`)
      const sourcePath = fs.existsSync(absPath) ? absPath : fs.existsSync(fallbackPath) ? fallbackPath : null
      if (sourcePath) {
        const rawMd = fs.readFileSync(sourcePath, 'utf8')
        const parsed = parseConceptMarkdown(rawMd, slug)
        const tierRes = resolveConceptTier(parsed.meta.groups, accessPlan, builtGroupIds)
        if (tierRes.tier !== accessPlan.inlineTier && !isDraft) {
          fm.accessTier = tierRes.tier
        }
        fm.conceptPanels = conceptPanelsOf(conceptGraphFor(slug, isDraft), slug, tierRes.tier)
        fm.conceptMeta = {
          slug,
          term: parsed.meta.term,
          english: parsed.meta.english,
          aliases: parsed.meta.aliases,
          field: parsed.meta.field,
          groups: parsed.meta.groups,
          summary: parsed.meta.summary,
          status: isDraft ? 'draft' : parsed.meta.status,
          generatedBy: parsed.meta.generatedBy,
          reviewedAt: parsed.meta.reviewedAt,
          selectionSource: parsed.meta.selectionSource,
          sourcesCount: countConceptSources(parsed.body),
          hasUnverified: hasUnverifiedMarkers(rawMd).hasUnverified,
        }
      }

      if (!isProductionBuild) {
        const liveLectures = scanLectureFiles({
          content: contentPaths,
          groups: GROUPS,
          localeKeys: v2LocaleKeys,
          accessPlan,
        })
        const allBl = computeConceptBacklinks(liveLectures).get(slug) ?? []
        fm.conceptBacklinks = allBl.map((b) => ({
          lecturePath: b.lecturePath,
          code: b.code,
          title: b.title,
          count: b.count,
        }))
      } else {
        fm.conceptBacklinks = inlineBacklinksAtConfig.get(slug) ?? []
      }
    },
    head: [
      // 站点图标（菱形标记）：SVG 为主，PNG/ICO 兜底；
      // 显式声明后浏览器不再盲请求 /favicon.ico（那正是之前 404 的来源）
      ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      ['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icon-192.png' }],
      ['link', { rel: 'alternate icon', sizes: '16x16 32x32 48x48 64x64', href: '/favicon.ico' }],
      ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
      ['link', { rel: 'mask-icon', href: '/favicon.svg', color: '#3D1755' }],
      ['meta', { name: 'theme-color', content: '#3D1755' }],
      ['meta', { name: 'robots', content: 'noindex, nofollow, noarchive, nosnippet, noimageindex' }],
      ['meta', { name: 'referrer', content: 'no-referrer' }],
      // 沉浸阅读首帧（脚本由 config.v2.mts 按语言前缀生成；键名与首页规则同 theme/reading/readingMode.ts、core/route.ts）
      v2ReadingModeHead(),
      v2HomeMapHead(),
      ...v2Head,
    ],
    /**
     * 语法高亮：VitePress 用 Shiki，**内置 316 种语言且按需动态加载**
     * （loadLanguage -> loadLanguageSync），所以除下面两个之外的标签**无需在这里登记**。
     * 这里只补 Shiki 没有的 kconfig / math 两个自定义语法。
     */
    markdown: {
      languages: [KCONFIG, MATH, IOS, LD],
      languageAlias: {
        'mermaid:chart': 'mermaid',
      },
      /** 第 13 步：构建期 KaTeX。只认 \(…\) / \[…\] / $$…$$，**不接管裸 $…$ 与 ```math 围栏** */
      config: (md) => {
        md.use(mathPlugin)
        md.use(v2LocaleLinks)
        md.use(
          createFiguresMarkdownPlugin({
            paths: contentPaths,
            groupDirs: figureGroupDirs,
            groupIdByDir,
            localeKeys: v2LocaleKeys,
            accessPlan,
            isBuild: isProductionBuild,
          }),
        )
        md.use(conceptLinkPlugin, {
          isBuild: isProductionBuild,
          accessPlan,
          resolveConcept: (slug) => {
            const snap = isProductionBuild ? buildConceptsSnapshot : resolveConceptLookupMap()
            const rec = snap.bySlug.get(slug)
            if (!rec && snap.filteredOut.has(slug)) return { slug, tier: accessPlan.inlineTier, isDraft: false, filteredOut: true }
            if (!rec) return null
            return { slug: rec.slug, tier: rec.tier, isDraft: rec.isDraft }
          },
          tierOfPage: (relPath) => tierOfPagePath(relPath, GROUPS, v2LocaleKeys, accessPlan),
        })
        md.core.ruler.after('block', 'lec-meta-quote', (state) => {
          const tokens = state.tokens
          for (let i = 0; i < tokens.length && i <= 12; i++) {
            const open = tokens[i]
            if (!open || open.type !== 'blockquote_open') continue
            let depth = 0
            let text = ''
            for (let j = i; j < tokens.length; j++) {
              const tok = tokens[j]!
              if (tok.type === 'blockquote_open') depth++
              else if (tok.type === 'blockquote_close') {
                depth--
                if (depth === 0) break
              } else if (tok.type === 'inline') {
                text += tok.content || ''
              }
            }
            const trimmed = text.trim()
            if (/^(?:\*\*)?(?:节点标识|节点|Node)(?=\s|:|\*|$)/.test(trimmed)) {
              open.attrJoin('class', 'lec-meta-quote')
            }
          }
        })
      },
    },
    themeConfig: {
      ...v2ChromeStrings(v2Lang),
      search: v2Search(),
      /**
       * 顶栏导航：课程组多起来之后平铺会挤成一行，改成**下拉栏**。
       * 临时挂载的组在文字后加「（临时）」标记，且（见上面的 sort）永远排最后。
       */
      nav: [
        { text: navLabels.home, link: '/' },
        {
          text: navLabels.groups,
          component: 'NavCourseMenuHost',
          items: groups.map((g) => ({
            text: `${g.id} · ${g.title}${g.temp ? navLabels.temp : ''}`,
            link: `/${g.dir}/`,
          })),
        } as DefaultTheme.NavItemWithChildren & { component: string },
      ],
      sidebar: Object.fromEntries(
        groups.map((g) => [
          `/${g.dir}/`,
          [
            {
              text: `${g.id} · ${g.title}`,
              collapsed: false,
              items: g.lectures.map((l) => ({ text: l.text, link: l.link })),
            },
          ],
        ])
      ),
      siteTitle: SITE_META.shortName
        ? `<span class="site-title-full">${SITE_META.name}</span><span class="site-title-short">${SITE_META.shortName}</span>`
        : SITE_META.name,
      // 供 HomeBody.vue / GroupIndex.vue 读取（客户端可从 useData().theme 拿到）
      groups,
      totals,
      siteMeta: SITE_META,
      // P3: resolved site-module choices and options (client reads progress / auth settings from here)
      lectureModules: v2Modules,
      // P4a: home page settings (default expansion of the overview map)
      lectureHome: v2Home,
      socialLinks: [],
    },
    vite: {
      resolve: { alias: v2ViteAlias },
      optimizeDeps: {
        // Pre-bundle dynamically imported browser dependencies up front so Vite dev never triggers
        // mid-interaction dependency re-optimization reloads on /lr/L01, search, charts, or author draft generation.
        include: [
          'ajv',
          'dompurify',
          'echarts/charts',
          'echarts/components',
          'echarts/core',
          'echarts/renderers',
          'html-to-image',
          'katex',
          'marked',
          'mermaid',
          'minisearch',
          'photoswipe',
          'shiki',
          'wavedrom',
          'wavedrom/skins/dark.js',
        ],
      },
      build: {
        chunkSizeWarningLimit: 2500,
        rollupOptions: {
          onwarn(warning, warn) {
            // 过滤第三方库 wavedrom 中使用 eval 的无害代码提示
            if (warning.code === 'EVAL' && warning.id && warning.id.includes('wavedrom')) {
              return
            }
            warn(warning)
          },
        },
      },
      // 讲义导出插件（按需导出中间件）。
      // 之前漏了这一步，导致「点导出按钮 → 即时生成」这条路 404，
      // 只剩预生成产物可用 —— 现补上，与新组件形成闭环。
      // apiModePlugin 必须在前：LECTURE_API_MODE=mock|proxy 时接管 /api/**（仅 dev，默认 off）
      plugins: [
        apiModePlugin(),
        lectureExportPlugin(),
        conceptsVitePlugin({ docsRoot, allGroups: GROUPS, localeKeys: v2LocaleKeys, accessPlan }),
        v2SearchPlugin({ docsRoot, allGroups: GROUPS, conceptsDir: contentPaths.conceptsDir, accessPlan }),
        ...v2VitePlugins,
      ],
      server: {
        watch: {
          ignored: ['**/.git/**', '**/.content-mount.json', '**/*.tmp/**', '**/*.tmpdir/**'],
        },
      },
    },
    // empty description in both texts fields: VitePress would write an empty tag (or its own "A VitePress site"); write none
    transformHtml: (code) => code.replace(/<meta name="description" content="(?:A VitePress site)?">\s*/, ''),
    async buildEnd(siteConfig) {
      v2WriteSearchDist(siteConfig.outDir, {
        docsRoot,
        allGroups: GROUPS,
        conceptsDir: contentPaths.conceptsDir,
        accessPlan,
        base: siteConfig.site.base,
        cleanUrls: siteConfig.cleanUrls ?? true,
      })
      writeConceptDistAssets(
        siteConfig.outDir,
        { docsRoot, allGroups: GROUPS, localeKeys: v2LocaleKeys, accessPlan },
        contentPaths,
      )
      const toolSizes = await writeConceptToolsDist(
        siteConfig.outDir,
        { docsRoot, allGroups: GROUPS, localeKeys: v2LocaleKeys, accessPlan },
        contentPaths,
      )
      console.log(
        `[concepts] tool data: ${[...toolSizes].map(([f, n]) => `${f} ${(n / 1024).toFixed(1)} KiB`).join(', ')}`,
      )
      emitCompanionPromptsDist(siteConfig.outDir)
      emitFiguresDistArtifacts(siteConfig.outDir, {
        paths: contentPaths,
        groups: GROUPS,
        localeKeys: v2LocaleKeys,
        accessPlan,
      })
    },
  }), {
    plan: accessPlan,
    allGroups: GROUPS,
    groups,
    localeKeys: v2LocaleKeys,
    docsRoot,
    chartsDir: contentPaths.chartsDir,
    figuresDir: contentPaths.figuresDir,
    notionKnowledgeGraphFile: contentPaths.graphDir.notionKnowledgeGraph,
    publicDir: contentPaths.publicDir,
    curriculum,
  })
