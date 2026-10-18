/**
 * groups.mts — 引擎内置示例内容源的课程组定义。
 *
 * 为示例内容源（site/docs/examples/）提供合法的 GroupMeta 元信息，保证独立构建与测试能力。
 * 挂载外部业务内容源时，该定义将由挂载内容源中的 groups.mts 优先覆盖。
 */
export type GroupMeta = {
  /** 课程组编号（显示在卡片徽章上） */
  id: string
  /** docs 下的目录名 */
  dir: string
  /** 课程名（不含编号） */
  title: string
  /** 一句话定位 */
  tagline: string
  /** 卡片正文：这组课解决什么问题、覆盖什么 */
  summary: string
  /** 卡片强调色 */
  accent: string
  /** 关键词标签 */
  tags: string[]
  /** 临时挂载的课程组（卡片上会有「临时」标记） */
  temp?: boolean
}

/**
 * 示例内容源只含一个课程组。
 *
 * 字段口径与引擎一致（权威定义见 `site/docs/.vitepress/groups.example.mts`），
 * 三处需要说明：
 *   · `id: 'G01'` —— 与引擎自带的 `groups.example.mts` **保持一致**，
 *     这样「挂载本示例」与「走引擎兜底」两条路径的徽章编号、侧边栏标题完全相同。
 *   · `dir: 'examples/g01'` —— 引擎把 `dir` 直接交给 `path.join` 扫描讲义
 *     （`docs/<dir>/L*.md`），因此 `dir` 允许是**嵌套路径**；同时它也是
 *     左侧边栏 / 顶栏的链接前缀（`/examples/g01/`），所以该目录下需要有 `index.md`。
 *   · 图表 sidecar 命名为 `EX-L01.json`（对应正文 `data-lecture="EX-L01"`），
 *     因此本组 `id` 与 sidecar 前缀不同名 —— 图表由正文锚点 1:1 决定，
 *     不依赖 `id` 前缀（`<id>-` 前缀只用于首页卡片的图表计数）。
 */
export const GROUP_META: GroupMeta[] = [
  {
    id: 'G01',
    dir: 'examples/g01',
    title: '示例课程',
    tagline: '引擎自带的原创最小示例',
    summary:
      '一个刻意做小的示例课程组：用「LED 与限流电阻」这件最朴素的工程事，演示本引擎的全部核心特性 —— 三类原生可交互图表（mermaid / echarts / wavedrom）、构建期 LaTeX 公式、.cite 引用胶囊、代码高亮与「下一讲预告」收尾契约。示例正文完全原创，供第三方照此结构装入自己的课程。',
    accent: '#3B82F6',
    tags: ['示例内容源', '原创', '引擎特性演示'],
  },
]

/** 兼容别名：部分工具按 `GROUPS` 取名读取。 */
export const GROUPS: GroupMeta[] = GROUP_META
