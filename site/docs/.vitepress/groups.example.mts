/**
 * groups.example.mts — 课程组元信息结构示例与默认回退源。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 设计理念与扩展机制
 * ────────────────────────────────────────────────────────────────────────────
 * 本文件提供课程组元信息（GroupMeta）的通用结构与占位示范。
 *
 * `config.mts` 按以下优先级顺序动态解析加载课程组配置：
 *   1. `.vitepress/content-groups.mts`  ← 外部内容源通过 scripts/mount_content.py 挂载生成（推荐）
 *   2. `.vitepress/groups.mts`          ← 本地自定义配置文件（被 .gitignore 忽略，适合单机私有配置）
 *   3. 本文件                            ← 开箱即用兜底配置，保证独立克隆后随时可构建
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 自定义课程配置方式
 * ────────────────────────────────────────────────────────────────────────────
 * 参照本文件导出的 `GROUPS` 结构定义您的课程组，支持以下接入方式：
 *   a. 独立内容源：在 content-sources/<名称>/groups.mts 组织内容，
 *      通过 `python scripts/mount_content.py --mount <名称>` 接入（优先级最高）；
 *   b. 本地独立配置：在 .vitepress/ 目录下新建 `groups.mts`（优先级次之）；
 *   c. 直接修改本文件作为站点根配置。
 *
 * 完整契约见 `content/CONTENT_SOURCE.md` 与 `content-sources/README.md`。
 *
 * ⚠️ 讲数与图表数**不要写在这里** —— 由 config.mts 扫描目录与 charts JSON 自动统计，
 *    避免「手写数字和实际不同步」。
 */

import type { GroupI18n } from './i18n/data.ts'

/** 单个课程组的元信息。字段口径与内容源契约 v1 完全一致。 */
export type GroupMeta = {
  /** 课程组编号（显示在卡片徽章上），如 'G01'；也用于按 `<id>-` 前缀统计图表 sidecar */
  id: string
  /** docs 下的目录名。允许是嵌套路径（如 'examples/g01'），config.mts 直接交给 path.join */
  dir: string
  /** 课程名（不含编号） */
  title: string
  /** 一句话定位 */
  tagline: string
  /** 卡片正文：这组课解决什么问题、覆盖什么 */
  summary: string
  /** 卡片强调色（十六进制） */
  accent: string
  /** 关键词标签 */
  tags: string[]
  /** 临时挂载的课程组：卡片上会有「临时」标记，且永远排在最后（方便日后移除） */
  temp?: boolean
  /** 设为 false 时不进入首页依赖画布（仍保留在速览与组卡片） */
  map?: false
  /**
   * 分类（可选，纯数据）。引擎按分类在 `GROUPS` 里**首次出现的顺序**分配色槽
   * `--lec-cat-1…8`（超过 8 类循环）；没有分类的组共用一个「未分类」色槽。`accent` 仅作覆盖。
   * V1 忽略此字段。
   */
  category?: string
  /**
   * 多语言文案（可选，纯数据）：`title` / `tagline` / `summary` 的其它语言版本。
   * 缺哪种语言或哪个字段，就回落根语言（上面的中文字段）。V1 忽略此字段。
   */
  i18n?: GroupI18n
}

/**
 * 默认课程组：**两个通用的虚构示例**（freely-invented placeholder），
 * 用来演示 `GroupMeta` 的两种典型形态：
 *
 *   · 组 1 —— 普通课程组的完整字段（含 `tags`）；`dir` 指向引擎自带的示例讲义目录
 *     `site/docs/examples/g01/`，所以开源后**点进去是有内容的**（演示讲义 EX-L01）。
 *   · 组 2 —— 演示 `dir` 允许是**嵌套路径**，以及 `temp: true` 的临时组行为
 *     （排最后 + 卡片上加「临时」标记）。它的目录在开源版里并不存在，
 *     引擎对此**天然降级**：`scanLectures()` 扫不到 `L*.md` 就返回空数组，
 *     组内页照常渲染、只是讲次表为空 —— **不会报错，也不会阻断构建**。
 *
 * 换成你自己的课程时，把这里的条目整段替换掉即可。
 */
export const GROUPS: GroupMeta[] = [
  {
    id: 'G01',
    dir: 'examples/g01',
    title: '示例课程',
    tagline: '引擎自带的原创最小示例',
    summary:
      '一个刻意做小的示例课程组：用一件最朴素的工程事，演示本引擎的全部核心特性 —— 三类原生可交互图表（mermaid / echarts / wavedrom）、构建期 LaTeX 公式、.cite 引用胶囊、代码高亮，以及「下一讲预告」收尾契约。示例正文完全原创，供第三方照此结构装入自己的课程。',
    accent: '#3B82F6',
    tags: ['示例内容源', '原创', '引擎特性演示'],
    i18n: {
      en: {
        title: 'Example course',
        tagline: 'A small, original example shipped with the engine',
        summary:
          'A deliberately small example course group. It uses one plain engineering task to show every core feature of the engine: three kinds of native interactive charts (mermaid / echarts / wavedrom), build-time LaTeX formulas, .cite citation capsules, code highlighting, and the closing "next lecture preview" contract. The text is entirely original, so third parties can follow the same structure when loading their own course.',
      },
    },
  },
  {
    id: 'G02',
    dir: 'examples/nested/group-b',
    title: '进阶示例（嵌套目录）',
    tagline: '演示嵌套 dir 与临时挂载标记',
    summary:
      '第二个占位课程组，只为一件事存在：演示 `dir` 可以是嵌套路径（如 `examples/nested/group-b`），以及 `temp: true` 的临时组会被排到最末并标注「临时」。它的讲义目录在本仓库中并不存在，引擎扫不到讲义时组内页照常渲染、仅讲次表为空 —— 用来说明「目录缺失不阻断构建」。请整段替换为你自己的课程组。',
    accent: '#8B5CF6',
    tags: ['占位示例', '嵌套路径', '临时组'],
    temp: true,
    i18n: {
      en: {
        title: 'Advanced example (nested directory)',
        tagline: 'Shows a nested dir and the temporary-mount marker',
        summary:
          'A second placeholder course group that exists for one reason: to show that `dir` may be a nested path (such as `examples/nested/group-b`), and that a group with `temp: true` is sorted last and marked as temporary. Its lecture directory does not exist in this repository; when the engine finds no lectures, the group page still renders with an empty lecture table, which shows that a missing directory does not block the build. Replace this whole entry with your own course group.',
      },
    },
  },
]

/**
 * 兼容别名。
 *
 * 引擎侧的规范名是 `GROUPS`；而内容源契约（content/CONTENT_SOURCE.md §3.1）
 * 与 `site/docs/examples/groups.mts` 用的是 `GROUP_META`。两个名字都导出，
 * 让「本文件 / 本地 groups.mts / 挂载来的 content-groups.mts」三种来源
 * 具有**完全一致的消费口径**，config.mts 的解析逻辑因此不必为来源分支。
 */
export const GROUP_META: GroupMeta[] = GROUPS
