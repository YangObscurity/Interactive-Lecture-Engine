# 内容源（Content Sources）

本目录是**引擎与讲义的分界线**。

- **引擎**（`site/`）可以开源：主题、图表运行时、数学渲染、AI 伴读、知识地图、构建管线。
- **讲义**（本目录下的各内容源）是你的私人资产，**不进开源仓库**。

`content-sources/*/` 已被 `.gitignore` 排除，只有本文件会被提交。

完整契约见 [`../content/CONTENT_SOURCE.md`](../content/CONTENT_SOURCE.md)。

---

## 目录约定

```
content-sources/<你的课程名>/
├─ groups.mts                      # 课程组元信息（必需）
├─ docs/
│  ├─ <group>/L01.md                   # 讲义正文，文件名必须匹配 ^L\d+\.md$
│  ├─ <group>/index.md                 # 课程组落地页（可选）
│  └─ public/charts/<GROUP>-L01.json   # 图表 sidecar
└─ docs/public/
   ├─ lecture_catalog.json         # 讲次目录（可选）
   └─ notion_knowledge_graph.json  # 知识图谱（可选）
```

## `groups.mts` 模板

复制下面内容改字段即可。字段含义与引擎的 `GroupMeta` 完全一致：

```ts
export type GroupMeta = {
  id: string        // 课程组编号，如 'CS01'
  dir: string       // docs 下的目录名，如 'cs01'
  title: string     // 课程名（不含编号）
  tagline: string   // 一句话定位
  summary: string   // 卡片正文
  accent: string    // 强调色，如 '#3B82F6'
  tags: string[]    // 关键词
  temp?: boolean    // 临时挂载的组（排最后并加「临时」标记）
}

export const SITE_META = {
  name: '我的课程讲义',
  text: '可交互工程讲义库',
  tagline: '一句话副标题',
}

export const SITE_FEATURES = [
  { title: '特性名', details: '特性说明' },
]

export const GROUPS: GroupMeta[] = [
  {
    id: 'CS01',
    dir: 'cs01',
    title: '我的第一门课',
    tagline: '一句话定位',
    summary: '这组课解决什么问题、覆盖什么。',
    accent: '#3B82F6',
    tags: ['标签一', '标签二'],
  },
]
```

> **讲数与图表数不需要手写** —— 引擎会自动扫描 `docs/` 与 `public/charts/` 统计，
> 避免「手写数字和实际不同步」。

## 讲义 `frontmatter`

```yaml
---
title: "第1讲 · 课程名称"
order: 1
description: "一句话描述 ｜ 难度 ★★ ｜ 预估 90min"
outline: deep
---
```

- `title` **必须用英文双引号包裹**（规避中文冒号导致 YAML 解析失败）。

## 图表挂载

正文里放**空占位符**，内容由 sidecar JSON 在运行时注入：

```html
<figure class="chart" data-lecture="EX-L01" data-id="c1" data-type="echarts"></figure>
```

同时 `docs/public/charts/EX-L01.json`：

```json
{
  "c1": { "type": "echarts", "code": "{ \"xAxis\": {}, \"yAxis\": {}, \"series\": [] }" }
}
```

**契约铁律**：正文的 `data-id` 与 JSON 的 key 必须**严格 1:1**（不能多也不能少）。
校验：

```bash
python scripts/check_figs2.py     # 期望：不一致数 = 0
```

支持的 `data-type`：`mermaid` / `echarts` / `wavedrom`。

---

## 挂载与卸载

```bash
python scripts/mount_content.py --list                    # 看有哪些内容源
python scripts/mount_content.py --mount my-course         # 预演（默认 dry-run）
python scripts/mount_content.py --mount my-course --apply # 真正挂载
cd site && npm run build

python scripts/mount_content.py --unmount --apply         # 卸载，恢复纯引擎状态
python scripts/mount_content.py --verify                  # 校验图表契约
```

## 从既有站点抽取内容源

若你已有一份讲义散落在 `site/docs/`，可反向导出：

```bash
python scripts/mount_content.py --export content-sources/my-course   # 预演
python scripts/mount_content.py --export content-sources/my-course --apply
```

导出**只搬运内容**（讲义、图表、数据 JSON），**不会**碰引擎侧受保护路径
（`.vitepress/`、`examples/`、`index.md`、站点图标）。
