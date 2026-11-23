/**
 * groups-source.mts - resolves WHICH file defines the course groups (content/groups.ts > content-groups.mts >
 * groups.mts) and loads it. Moved out of config.mts in P2d (WP-I2) with identical behaviour and
 * log lines, because two places need the result: config.mts (nav, sidebar, home data) and the dynamic
 * English group pages (docs/en/[group]/index.paths.mts). Node only; never imported by the client.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GroupI18n, SiteMetaI18n } from './i18n/data.ts'
import { getExampleTextsPath, getSiteTextsPath, loadSiteTexts, toSiteMeta } from './site-texts.mts'
import { resolveContent } from './content/paths.mts'
import { loadTsModule } from './content/ts-loader.mts'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * ──────────────────────────────────────────────────────────────────────────
 * 课程组元信息的优先级解析（多内容源接入策略）
 * ──────────────────────────────────────────────────────────────────────────
 * 设计目标：引擎与业务内容元信息物理彻底解耦，支持内容目录、自定义本地与插拔式挂载三种形态。
 *
 * 候选来源按优先级排序，取第一个存在的来源加载：
 *   0. `content/groups.ts`  —— V2 内容目录（含没有内容目录时回落的示例内容 templates/demo-content）。
 *   1. `content-groups.mts` —— 由 `scripts/mount_content.py` 挂载外部内容源时生成。
 *      显式挂载的内容源优先于本地配置文件。
 *   2. `groups.mts`         —— 原位模式的本地课程组定义（被 .gitignore 排除，不提交至版本库）。
 *   都没有 → 零课程组的空站点（原位模式且没有 groups.mts 时出现），构建日志给出提示。
 *
 * 为什么用「existsSync + 动态 import()」而不是静态 import：
 *   静态 import 的路径在解析期就写死了，文件不存在 → 模块解析失败 → 构建直接挂。
 *   动态 import 的路径是**运行期表达式**，可以先用 existsSync 探测再决定加载谁。
 *
 * 为什么不用「顶层 await + 静态 import」：
 *   `import()` 是动态的，本来就必须 await；而本文件的 await 只在
 *   `resolveGroups()` 这个 async 函数内部，模块顶层并没有 await，
 *   所以不存在「顶层 await 在 esbuild 打包成临时 .mjs 后语义变化」的风险。
 *
 * ⚠️ 为什么**不能**依赖「静态 import 放在 try/catch 里」做回退：
 *   `import ... from` 是静态声明，**必须**出现在模块顶层，放不进 try 块（语法错误）；
 *   而 `import()` 失败（文件缺失时抛 ERR_MODULE_NOT_FOUND）虽然可以 catch，
 *   但路径仍须是运行期表达式才能探测存在性 —— 于是「existsSync 先探、import() 后取」
 *   是最直白也最可读的形态，且失败路径完全不依赖异常。
 */

/**
 * `defineConfig` 支持三种导出形态：对象、同步函数、**async 函数**。
 *
 * 这里必须用 async 函数，因为 `resolveGroups()` 内部要对候选文件做 `await import()`。
 * 已查证 VitePress **1.6.4** 的实际实现（不是猜的）：
 *   · `vitepress/dist/node/chunk-D3CUZ4fa.js` 的 `resolveUserConfig()` 返回
 *       `[await resolveConfigExtends(userConfig), ...]`；
 *   · `resolveConfigExtends(config)` 第一行即
 *       `const resolved = await (typeof config === "function" ? config() : config)`
 *     —— 默认导出只要是**函数**就会被 await 调用，返回 Promise 完全合法。
 *   · Vite 侧同构：`loadConfigFromFile()` 里
 *       `const config = await (typeof userConfig === "function" ? userConfig(configEnv) : userConfig)`
 *   于是 `export default async () => defineConfig({...})` 是受支持的官方形态，
 *   而不是「碰巧能跑」。`defineConfig()` 本身是恒等函数（签名放行对象与函数），
 *   包一层不改变类型，只是把返回类型放宽为 Promise。
 */
export type GroupsModule = {
  GROUPS?: unknown
  GROUP_META?: unknown
  SITE_META?: unknown
}

/** 候选来源：按优先级从高到低排列（顺序即语义，勿随意调换）。 */
export const GROUPS_CANDIDATES = [
  { file: 'content/groups.ts', desc: 'V2 内容目录课程组定义（content/groups.ts）' },
  { file: 'content-groups.mts', desc: '挂载的内容源（scripts/mount_content.py 产生）' },
  { file: 'groups.mts', desc: '本地自定义课程组定义' },
] as const

/** 引擎兜底文案：一个课程组来源都没有时（原位模式、没有 groups.mts），站点仍要立得起来。 */
export type SiteMeta = { name: string; shortName?: string; text: string; tagline: string; description?: string; i18n?: SiteMetaI18n }

export const FALLBACK_SITE_META: SiteMeta = {
  name: '可交互工程讲义',
  text: '可交互工程讲义库',
  tagline: '引擎已就绪 —— 但没有找到任何课程组定义',
}

/**
 * Site-level texts: the texts file (`site/site-texts.json`, else its template) is the one source and wins.
 * Only when neither exists (an engine folder without the file) the legacy `SITE_META` export of the groups
 * module, else the engine fallback, is used.
 */
function resolveSiteMeta(dir: string, legacy: SiteMeta | undefined): SiteMeta {
  // the engine's own folder follows the active content root; any other folder (tests) uses its own `site/` layout
  const siteDir = path.resolve(dir) === path.resolve(here) ? undefined : path.resolve(dir, '..', '..')
  if (fs.existsSync(getSiteTextsPath(siteDir)) || fs.existsSync(getExampleTextsPath(siteDir))) {
    return toSiteMeta(loadSiteTexts({ siteDir }))
  }
  return legacy ?? FALLBACK_SITE_META
}

export async function resolveGroups(dir: string = here) {
  const useContentPaths = path.resolve(dir) === path.resolve(here)
  const contentPaths = useContentPaths ? resolveContent() : null
  const tried: string[] = []
  for (const cand of GROUPS_CANDIDATES) {
    let abs: string
    if (cand.file === 'content/groups.ts' && contentPaths) {
      if (contentPaths.mode !== 'content') {
        tried.push(`${cand.file}（原位模式跳过）`)
        continue
      }
      abs = contentPaths.groups
    } else {
      abs = path.join(dir, cand.file)
    }
    // 先探测存在性：动态 import 一个不存在的路径会抛 ERR_MODULE_NOT_FOUND，
    // 而「文件不在」在这里是完全正常的状态，不该以异常形式表达。
    if (!fs.existsSync(abs)) {
      tried.push(`${cand.file}（不存在）`)
      continue
    }
    const mod = await loadTsModule<GroupsModule>(abs)
    // 两个导出名都认：`GROUPS` 是引擎规范名，`GROUP_META` 是内容源契约里的名字
    // （content/CONTENT_SOURCE.md §3.1、content-sources/README.md 均写作 GROUP_META）。
    // 同源两个名字都试，第三方照契约写的内容源就不会「挂了却没生效」。
    const groups = (mod.GROUPS ?? mod.GROUP_META) as GroupMetaLike[] | undefined
    if (!Array.isArray(groups)) {
      tried.push(`${cand.file}（存在但未导出 GROUPS / GROUP_META 数组）`)
      continue
    }
    console.log(`[groups] 元信息来源 = ${cand.file} —— ${cand.desc}（${groups.length} 组，${abs}）`)
    return { GROUPS: groups, SITE_META: resolveSiteMeta(dir, mod.SITE_META as SiteMeta | undefined) }
  }
  // 候选全不可用：**不抛错**。抛错会让「引擎独立构建」这一核心目标落空，
  // 而一个零课程组的空站点恰恰是合法的「引擎裸奔」状态（原位模式，即 LECTURE_DEMO=0 且没有 content/）。
  console.warn(
    `[groups] ⚠️ 未找到任何课程组来源，回退为空站点（无课程组）。尝试过：\n  - ${tried.join('\n  - ')}\n` +
      '  原位模式只读 site/docs 里的讲义与 site/docs/.vitepress/groups.mts；要建自己的讲义库请运行 npm run init（创建 content/），' +
      '要看引擎自带的示例内容请去掉 LECTURE_DEMO=0。'
  )
  return { GROUPS: [] as GroupMetaLike[], SITE_META: resolveSiteMeta(dir, undefined) }
}

/**
 * 解析结果里 GROUPS 元素的最小形状。
 *
 * 这里刻意**不做运行期字段校验**：契约的权威定义在 `templates/content/groups.ts`（npm run init 的模板）
 * 与 `content/CONTENT_SOURCE.md`，config.mts 只负责「取到数组」这一件事。
 * 各候选来源（内容目录 / 本地 / 挂载）因此具有完全一致的消费口径。
 */
export type GroupMetaLike = {
  id: string
  dir: string
  title: string
  tagline: string
  summary: string
  accent: string
  tags: string[]
  temp?: boolean
  map?: false
  category?: string
  i18n?: GroupI18n
}

