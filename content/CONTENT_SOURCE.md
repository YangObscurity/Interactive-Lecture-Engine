# 内容源分离契约（Content Source Separation）

> **语言 / Language**: 中文 ｜ [English](./CONTENT_SOURCE.en.md)

> **一句话**：引擎与讲义彻底解耦 —— 仓库只带**引擎 + 一个最小示例内容源**，
> 你自己的讲义作为**独立内容源**在本地挂载，永不上传。

---

## 1. 为什么要这么设计

开源前的核心矛盾：

| 需求 | 冲突 |
|---|---|
| 引擎要能开源、能被第三方复现构建 | 引擎与业务讲义**硬耦合**在同一个 `site/docs/` 树下 |
| 讲义必须留在本地 | `groups.mts` 硬编码了 13 个课程组；`config.mts` 直接扫描 `docs/<dir>` |
| 私人数据（Notion 进度、节点 ID、考试解析）不能外泄 | `public/*.json` 是私人数据的**直接产物**，且被前端 fetch 消费 |

解决办法不是「删掉讲义」——那会把引擎一起删掉。而是引入**内容源（content source）**这一层间接：

```
引擎（开源）                内容源（私人 / 第三方）
site/                       content-sources/<name>/
  docs/.vitepress/            groups.mts         ← 课程组元信息
    config.mts  ──读取──▶     docs/gxx/Lxx.md    ← 讲义正文
    theme/                    docs/public/charts/<ID>-<Lxx>.json  ← 图表 sidecar
                              public/*.json      ← 目录 / 图谱数据
```

引擎在**构建时**把指定内容源挂载（symlink 或拷贝）到 `site/docs/` 的对应位置，
构建产物因此完全一致；而**内容源目录本身**通过 `.gitignore` 排除在开源仓库之外。

---

## 2. 目录布局

```
<repo root>/
├─ site/                          # 引擎（开源）
│  └─ docs/
│     ├─ .vitepress/              # 主题 / 配置 / 构建脚本
│     ├─ index.md                 # 首页（引擎自带）
│     └─ examples/                # 引擎自带的**最小示例内容源**（开源）
│        ├─ g01/L01.md            # 1～2 讲示例，演示全部特性
│        └─ public/charts/EX-L01.json
├─ content-sources/               # 内容源根（**开源仓库中为空**）
│  ├─ README.md                   # 契约说明（开源）
│  └─ <your-course>/              # 私人内容源（.gitignore 排除）
│     ├─ groups.mts
│     ├─ docs/
│     └─ public/
└─ .gitignore                     # 排除 content-sources/*/ 但放行 README.md
```

---

## 3. 内容源契约（v1）

一个合法内容源必须提供：

### 3.1 `groups.mts`

导出课程组元信息，元素结构与引擎的 `GroupMeta` 完全一致
（`id` / `dir` / `title` / `tagline` / `summary` / `accent` / `tags` / `temp?`）。

导出名 **`GROUPS` 与 `GROUP_META` 两者都认**（实现为 `mod.GROUPS ?? mod.GROUP_META`），
因此无论照本契约写 `GROUP_META`、还是照引擎惯例写 `GROUPS`，都能生效。
另可选导出 `SITE_META`（站点名 / 副标题）与 `SITE_FEATURES`（首页能力卡文案）。

**引擎的真实解析优先级与示例隔离契约**（与 `site/docs/.vitepress/config.mts` 逐字对应，2026-10-17 工程定稿）：

| 优先级 | 文件 / 来源 | 说明与行为 |
|---|---|---|
| 1 | `site/docs/.vitepress/content-groups.mts` | `scripts/mount_content.py` 挂载内容源时引入的副本（自动禁用 examples） |
| 2 | `site/docs/.vitepress/groups.mts` | 本地个人课程组定义（维护者/用户自定义课程走这条，自动禁用 examples） |
| 2.5 | 自动推导未配置课程目录 | `docs/` 下扫描到的非系统保留业务讲义目录（自动生成组元信息，自动禁用 examples） |
| 3 | `site/docs/.vitepress/groups.example.mts` | 仅当上述个人讲义**完全不存在**时加载（纯引擎/全新克隆开箱展示） |

> 💡 **动态隔离机制 (Dynamic Example Fallback & Exclusive Isolation)**：
> 当优先级 1、2 或 2.5 命中时，引擎自动判定为「个人讲义独占态」，**绝对不加载 examples 示例**，并通过 VitePress `srcExclude: ['examples/**']` 在编译期彻底剔除示例 Markdown，保证本地搜索、侧边栏、导航与脑图 100% 独占呈现用户个人课程体系。

> ⚠️ 为什么「挂载副本」优先级最高：挂载是**显式动作**，
> 显式挂载的内容源理应压过本地残留文件，否则「挂了却没生效」极难排查。
>
> ⚠️ 本契约**不使用**环境变量 `CONTENT_SOURCE`（历史文档曾如此描述，与实现不符，已于
> 2026-10-15 更正）。挂载一律经 `scripts/mount_content.py` 显式执行。

### 3.2 `docs/` 与 `public/`

- `docs/<dir>/L<n>.md`：讲义正文。文件名必须匹配 `^L\d+\.md$`（引擎据此排序与编号）。
  - frontmatter 至少含 `title`（**英文双引号包裹**）与 `order`。
  - `index.md` 为课程组落地页（可选）。
- `public/charts/<ID>-<Lxx>.json`：图表 sidecar。key 必须与正文
  `<figure class="chart" data-lecture data-id data-type>` 的 `data-id` **严格 1:1**。
- `public/lecture_catalog.json`、`public/notion_knowledge_graph.json`：可选。
  缺少时相关前端视图（全局课程地图 / 知识脉络脑图）自动降级为占位，**不报错、不阻断构建**。

### 3.3 图表锚点守恒（**不可违反**）

正文里的每一次 `<figure class="chart" ...></figure>` 都必须在 sidecar JSON 里有对应 key，
反之亦然。校验命令：

```bash
python scripts/check_figs2.py     # 期望：不一致数 = 0
```

---

## 4. 私人数据边界（开源版必须为空）

以下内容**绝不进入开源仓库**，已由 `.gitignore` 强制排除：

| 路径 | 内容 | 为何私人 |
|---|---|---|
| `content-sources/*/`（除 `README.md`） | 你的讲义正文、图表、课程组定义 | 版权 / 已出版同源 |
| `workspaces/` | 讲义增强 / 编写 / 教学法工作区与记忆 | 私人工作流与项目记忆 |
| `site/docs/<mounted-group>/` | 挂载后的讲义工作副本 | 属于外部接入内容 |
| `site/docs/public/*.json`（真实数据） | 学习进度、Notion 节点 ID、考试解析 | 私人学习数据 |
| `.env` | Notion token、服务器凭据 | 凭据 |

> 开源版保留**结构**、剔除**内容**：`content-sources/README.md` 与
> `site/docs/examples/` 说明契约并演示用法，第三方可据此装入自己的课程。

---

## 5. 第三方接入步骤（开源用户）

```bash
# 1. 克隆并安装
git clone <this-repo> my-course && cd my-course/site && npm ci

# 2. 建立自己的内容源
mkdir -p ../content-sources/my-course/docs/g01 ../content-sources/my-course/public/charts

# 3. 编写 groups.mts（照抄 content-sources/README.md 的模板）

# 4. 挂载并构建
cd .. && python scripts/mount_content.py --source content-sources/my-course
cd site && npm run build
```

---

## 6. 内容源与纯净引擎解耦机制

本引擎已确立物理级的内容源与引擎解耦架构：

- **开箱即用态**：克隆本开源仓库后，引擎自带 `site/docs/examples/` 作为结构样板与功能演示，直接运行即可体验全套图表与交互能力；
- **用户内容挂载**：使用 `scripts/mount_content.py --mount <source-name> --apply` 挂载外部独立内容源，引擎会自动屏蔽示例课程，100% 独占呈现用户自己的课程体系；
- **卸载与还原**：运行 `python scripts/mount_content.py --unmount --apply`，即可一键卸载自定义内容源，恢复纯净开源骨架。
