# 讲义契约

`npm run check:content` 按本文逐条检查（规则代码在 `site/scripts/content/contract.mts`）。FAIL 挡交付，WARN 要看一眼，INFO 只是提示。表里的「代码」就是检查输出里方括号中的那一项。

## 1. 文件在哪

| 内容 | 位置 | 说明 |
|---|---|---|
| 课程组 | `content/groups.ts` | `npm run new:group` 追加；讲数、图数由引擎数文件，不写在这里 |
| 组页 | `content/lectures/<组目录>/index.md` | 脚手架生成，正文只有 `<GroupIndex />` |
| 讲义 | `content/lectures/<组目录>/Lxx.md` | 两位数编号：`L01.md`、`L12.md` |
| 英文译本 | `content/lectures/en/<组目录>/Lxx.md` | 与原文同名；不写 `index.md`（英文组页由 `groups.ts` 的 `i18n` 生成） |
| 图表数据 | `content/charts/<组编号>-Lxx.json` | 例：`G01-L03.json` |
| 插图 | `content/figures/<组目录>/` + `figures.json` | 见第 6 节 |
| 概念页 | `content/concepts/<slug>.md`，草稿在 `_drafts/` | 见第 7 节 |
| 图谱 | `content/graph/graph.json`、`graph-bindings.json` | 见第 9 节 |

组目录名不能是引擎占用的 `en`、`public`、`concepts`、`.vitepress`，也不能叫 `index.md`、`dashboard.md`。

## 2. frontmatter（四项必填）

```yaml
---
title: "第3讲 · RC 电路"
order: 3
description: "节点 `ee_rc_basics` ｜ 亚组: G01 ｜ 难度 ★★ ｜ 预估 90min"
outline: deep
---
```

| 规则 | 级别 | 代码 |
|---|---|---|
| 有 frontmatter | FAIL | `lecture.frontmatter_missing` |
| `title` 存在且用英文双引号 | FAIL | `lecture.title_missing` / `lecture.title_unquoted` |
| `order` 是整数且等于文件编号（`L03.md` → 3） | FAIL | `lecture.order_missing` / `lecture.order_mismatch` |
| `description` 存在 | FAIL | `lecture.description_missing` |
| `outline` 存在（一般写 `deep`） | FAIL | `lecture.outline_missing` |
| `description` 里写了节点 id | INFO | `lecture.node_missing` |

可选：`requires: [g01/L02]`（直接前置讲，进依赖图）、`phase: 基础`（阶段名）。

## 3. 节点信息行

`description` 就是节点信息行，正文第一行引用块再写一遍：

```markdown
# 第3讲 · RC 电路

> 节点 `ee_rc_basics` ｜ 亚组: G01 ｜ 难度 ★★ ｜ 预估 90min ｜ 前置: ee_ohms_law ｜ 后续: ee_filters
```

- 节点 id 用字母、数字、`_`、`.`、`-`，与图谱里的节点 id 一致时，这一讲就挂到图谱上。
- 难度用 1–5 个 ★，预估写 `<分钟>min`。站点从这一行读出难度和时长。
- 英文写法：`Node \`id\` ｜ Group: G01 ｜ Difficulty ★★ ｜ Estimated 90min`。

## 4. 标题层级

| 规则 | 级别 | 代码 |
|---|---|---|
| 只有一个 `#`（与 `title` 相同） | WARN | `lecture.h1_multiple` |
| 不跳级（`##` 之后直接 `####`） | WARN | `lecture.heading_skip` |
| `check.config.json` 要求的标题（例：`## 下一讲预告`） | FAIL | `lecture.required_heading` |

正文用 `##` 分节（进右侧大纲），`###` 分小节。必需标题由内容仓的 `content/check.config.json` 决定，引擎本身不要求：

```json
{ "requiredHeadings": [{ "heading": "## 下一讲预告", "exceptLastLecture": true, "exempt": ["g02/L09"] }] }
```

`exceptLastLecture` 默认 true（每组最后一讲不要求），`exempt` 写 `<组目录>/<文件名>`。译本不要求。

## 5. 图表

讲义里放占位，数据放在 `charts/<data-lecture>.json`：

```html
<figure class="chart" data-lecture="G01-L03" data-id="c1" data-type="mermaid"></figure>
```

```json
{ "c1": { "type": "mermaid", "code": "flowchart TB\n  A --> B" } }
```

| 规则 | 级别 | 代码 |
|---|---|---|
| 三个属性都在 | FAIL | `chart.attr_missing` |
| `data-type` 是 `mermaid`、`echarts`、`wavedrom` 之一 | FAIL | `chart.type_unknown` |
| `charts/<data-lecture>.json` 存在且是 JSON 对象 | FAIL | `chart.file_missing` / `chart.json_invalid` |
| JSON 里有 `data-id` 这一项，`type` 与 `data-type` 相同 | FAIL | `chart.id_missing` / `chart.type_mismatch` |
| 同一图不放两次 | FAIL | `chart.duplicate` |
| `data-lecture` 是本讲的 `<组编号>-Lxx` | WARN | `chart.prefix` |
| 每个图表文件至少被一讲用到 | WARN | `chart.orphan` |

键名从 `c1` 起连续编号。占位与正文之间留空行。

## 6. 插图（论文图、示意图）

挂图由智能体完成，Dashboard 不挑图。

1. 图放进 `content/figures/<组目录>/`（矢量用 `.svg`，位图用 2 倍 `.webp`）。
2. 在 `content/figures/<组目录>/figures.json` 登记：`id`、`file`、`kind`（`figure` 或 `table`）、`width`、`height`、`caption`（`zh`、`en`）、`source`（`paper`、`number`、`page`，有就写 `doi` 或 `url`）、`sha256`（前 12 位）。引擎不登记许可或版权。
3. 讲义里挂图：`<LectureFigure id="rc-step-response" />`，可加 `size="medium|full"`、`float="right|left|none"`；多图 `<LectureFigure :ids="['a', 'b']" />`。
4. 正文引用：`[](fig:rc-step-response)`、`[](tab:parts-list)`，或 `[自定义文字](fig:id)`。编号按出现顺序自动给。

`check:content` 核对 `figures.json` 的格式、文件是否存在、校验值、每处引用能否找到、引用有没有越过访问档；登记了却没人引用的图给 WARN（代码 `figure.error` / `figure.warning`）。导入脚本与参数见 `docs-dev/FIGURES.md`。

## 7. 概念链接与概念页

- 讲义里写 `[时间常数](concept:time-constant)`。slug 必须是已发布的概念页，且读者能读这一讲就能读那个概念（FAIL，`concept.link`）。
- 概念页 frontmatter 必填 `title`、`term`、`english`、`field`、`groups`、`summary`、`status`（`concept.field_missing`）。
- 每个正文小节写出处：`（出处：<书名> §x.y）` 或 `.cite` 胶囊（`concept.source_missing`）。
- 已发布的页面不能再有「待核实」（`concept.unverified`）；草稿可以有（WARN）。
- 不用 ` ```math ` 围栏、旧语法 `[[concept:...]]`、正文里的 `[文字](http…)` 外链；`**` 要成对。
- 引擎的概念检查（`related` 关系、重名、概念页之间的链接）也一起跑（`concept.check`）。

## 8. 引用、链接与其他正文规则

| 规则 | 级别 | 代码 |
|---|---|---|
| 外部来源用 `.cite` 胶囊，不写裸 `<a href="http…">` | FAIL | `lecture.bare_link` |
| 站内讲义链接指向存在的讲（`./L02`、`../g02/L03.md`、`/g02/L03#节`、`./index.md`） | FAIL | `link.broken` |
| 表格每行的列数与表头相同（`\|` 与行内代码里的 `\|` 不算） | FAIL | `lecture.table_columns` |
| 代码围栏标语言 | WARN | `lecture.fence_language` |
| 代码外不出现 `{{`（Vue 会当插值） | WARN | `lecture.vue_interpolation` |

`.cite` 胶囊：

```html
<span class="cite" data-cite="https://openstax.org/books/university-physics-volume-2" title="OpenStax University Physics Vol.2 §15.2">OpenStax Vol.2 §15.2</span>
```

数字、公式、引语都要能对回出处：书名与节号、论文与图号、标准与条款。公式用 `\( \)` 与 `$$ $$`。

## 9. 图谱

- `graph/graph.json`：`nodes[]`（`id`、`title`、`category`、`lecture`）与 `edges[]`。节点的 `lecture` 指向不存在的讲给 WARN（`graph.lecture_missing`）。
- `graph/graph-bindings.json`：`{ "schema": 1, "bindings": { "<节点 id>": "/<组目录>/Lxx" } }`，人工绑定，优先级最高。指向不存在的讲是 FAIL（`graph.binding_lecture_missing`），节点 id 不在图里是 WARN。

## 10. 中英文

- 根语言默认是中文（`site.config.ts` 的 `i18n.root`）。译本放 `lectures/en/<组目录>/Lxx.md`，与原文同名，`title` 必填。
- 图表占位与原文保持一致，译本不另配图表文件（不一致给 WARN，`translation.charts_differ`）；没有原文的译本是 FAIL（`translation.no_original`）。
- 组与站点的英文文案写在 `groups.ts` 的 `i18n.en` 和 `site-texts.json` 的 `en` 块。

## 11. 站点文案

`content/site-texts.json` 的中英文 `name`（站名）必填，空着时 `check:content` 与生产构建都失败（`texts.required`）。其余字段可以留空，按规则处理：短名用站名，顶栏文字与标语不显示，首页描述用标语（INFO，`texts.empty`）。首页描述可写 `{lectures}` 表示讲数。
