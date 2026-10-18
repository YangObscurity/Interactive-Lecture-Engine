# 讲义内容契约

> TL;DR：一讲 = 一个 md + 一个 sidecar JSON，两个文件互不越界。
md 只负责"讲什么"，JSON 只负责"图表怎么画"，主题只负责"怎么渲染"。

## 1. 内容与站点流转架构

```
内容源（Markdown 文本 + 图表定义）
   │
   ├─ 标准源目录：<content-source>/docs/<group>/
   │  ├─ EX-L01.md               # 讲义正文（包含文字与 <figure> 占位符）
   │  └─ index.md                # 课程组引导页
   │
   └─ 图表源目录：<content-source>/public/charts/
      └─ EX-L01.json             # 独立 Sidecar 图表定义（Mermaid/WaveDrom/ECharts）
   │
   ▼ 通过构建/挂载管道接入站点
site/docs/<group>/EX-L01.md + site/docs/public/charts/EX-L01.json
   │
   ├──────────────── 链路 A：Web 交互式站点 ─────────────┐
   │  • VitePress SSR 静态构建或开发态 HMR                │
   │  • 浏览器端按需异步加载图表引擎并完成动态渲染        │
   │  • charts.ts 统一负责图表骨架填充、源码折叠与工具栏   │
   │                                                      │
   └──────────────── 链路 B：离线静态交付物（可选） ─────┘
      • 无头浏览器（Headless Chrome / Puppeteer）自动化渲染
      • 导出高质量独立 SVG 图表与离线 HTML/PDF 讲义
```

**两条链路共用同一份内容源，但图表消费方式不同**：站点是运行时动态交互渲染，交付物支持离线预渲染。
修改图表源时，两端均可自动消费对应更新。

## 2. md 契约（`site/docs/<group>/EX-L01.md`）

### frontmatter

```yaml
---
title: "第1讲 · 硬件接口原理图设计示范"   # 必填：侧边栏条目由它生成
order: 1
description: "节点 `demo_uart_hardware_design` ｜ 亚组: DEMO ｜ 难度 ★★★ ｜ 预估 60min ｜ 前置: demo_circuit_basics ｜ 后续: demo_esd_protection"
outline: deep
---
```

- `title` **必须用双引号包裹**：YAML 里含中文冒号会被解析成映射导致构建失败。
- `description` 可包含知识库节点标识符或元数据，用于溯源追踪。

### 图表占位（每张图只占一行）

```html
<figure class="chart" data-lecture="EX-L01" data-id="c1" data-type="echarts"></figure>
```

| 属性 | 作用 | 谁消费 |
|---|---|---|
| `data-lecture` | 定位 `/charts/EX-L01.json` | `charts.ts → loadCharts` |
| `data-id` | 定位 JSON 内的 key（`c1`,`c2`,…） | `charts.ts` |
| `data-type` | 让 CSS 在渲染前就按类型给容器定高 | `custom.css` |

**body / 标签 / 工具条 / `id` / 源码折叠全部由 `charts.ts` 运行时生成** —— 讲义里无需手写。
`id` 会生成为 `fig-<data-lecture>-<data-id>`。

### 图表与正文的排版

figure 前后**各留一个空行**（标准 markdown 块级分隔）。
连续空行会被压回单个。

### 引用与链接（2026-10-06 定稿）★

**「## 参考来源」段已于 2026-10-05 全站删除 —— 这是既定设计，不是缺失，不要再补回。**

完整规则见 `content/add-lecture.md` §8：

- 正文里**不允许出现任何链接**；外部链接的**唯一合法形态**是 `.cite` 胶囊：

  ```html
  <span class="cite" data-cite="https://…" title="https://…">短名</span>
  ```

  平时是浅色小胶囊、悬停显示 URL、**点击 `window.open` 直接在新标签打开该外链**（`theme/cites.ts`）。
- **禁止形态**：markdown 行内链接 `[文字](URL)`、带协议裸 URL（`https://…`）、
  无协议裸域名与完整路径（`docs.espressif.com/…`、`freertos.org`）。
  例外：`example.com/.org/.net` 及其子域是 RFC 2606 教学占位域名（证书 CN、MX 示例），
  属正文内容，豁免。
- 清理与审计三件套（都幂等）：
  `scripts/fix_content.py`（C9 清理，`--only-url` 只跑 URL）→
  `scripts/audit_bare_urls.py`（源码层，期望 TOTAL 0）→
  `scripts/check_body_links.py`（产物层，`<a href="http…">` 必须 0 且 `.cite`>0 自检）。
- 正文引用一律走 `.cite` 胶囊标签，不使用文末参考来源列表。

### mermaid 语法红线（实测踩过）⚠️

内容源里的 mermaid 代码可能有语法错误 —— **一处错误会让那张图整块显示为红色错误框**，
而构建**不会报错**（只有运行时才炸），所以必须靠审计发现。

| 现象 | 根因 | 修法 |
|---|---|---|
| `Lexical error on line N. Unrecognized text.` | **点线标签里含 `.`**（如 `-. 发往 10.0.1.20 的帧 .->`）—— lexer 把标签里**第一个点**当成 `-. 文字 .->` 的结束符 | 标签加**成对引号**：`-. "发往 10.0.1.20 的帧" .->` |
| `Parse error on line N`（stateDiagram） | **状态名含连字符**（`SYN-SENT`、`FIN-WAIT-1`）—— 状态 id 不接受 `-` | 用别名：`state "SYN-SENT" as SYN_SENT`，转移里改用 `SYN_SENT` |

注意：**`-.->`（无标签的点线箭头）是合法的**，不要误改（第一版修复脚本就误伤了 34 处）。

工具：`scripts/fix_mermaid.py`（幂等，`--apply` 写盘）—— 上面两类一起修。

## 3. sidecar JSON 契约（`site/docs/public/charts/EX-L01.json`）

```json
{
  "c1": { "type": "mermaid",   "code": "flowchart LR\n ..." },
  "c2": { "type": "wavedrom",  "code": "{ \"reg\": [...] }" },
  "c3": { "type": "echarts",   "code": "{ \"title\": {...}, \"series\": [...] }" }
}
```

- key 必须与 md 里 `data-id` **一一对应**（多了会 unreferenced，少了会 `missing`）。
- `type` 必须与 md 的 `data-type` 一致（不一致时以 JSON 为准并覆盖）。
- `code` 是**字符串化的源码**，不是嵌套对象 —— 站点靠它填充 `<details>` 源码折叠。
- echarts 的 `title` / `legend` **可以不写 `top`**，`normalizeEchartsLayout` 会归一；
  但要精确控制版面时仍建议显式写。

## 4. 规模由引擎实时统计，不写进文档

**本仓库不含讲义**，所以这里**刻意不给任何具体数字** —— 那既是使用者的私人数据，
也一定会与真实状态漂移。引擎侧的处理方式是：

| 项 | 由谁决定 |
|---|---|
| 课程组数量 | `groups.mts` 的声明（或 `groups.example.mts` 兜底） |
| 讲次数 | 扫描 `<组目录>/L*.md` 实时统计 |
| 图表数 | 扫描 `docs/public/charts/<ID>-L*.json` 并按 `type` 分类统计 |
| sidecar 命名 | 每讲 1 个 `<ID>-LNN.json`，与正文 `data-lecture` 严格 1:1 |
| 页数与体积 | 由内容规模决定；**构建成功但页数少是合法状态**（见 AGENTS.md §0.1） |

> **单一真源原则**：讲数与图表数**不手写在任何文档或组件里** —— 首页统计条、
> 组内页元信息均由
> `config.mts` 扫描实时计算。临时组（`temp: true`）在首页卡片与顶栏下拉里**永远排最后**。
