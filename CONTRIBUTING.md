# 贡献指南（Contributing Guide）

> **语言 / Language**: 中文 ｜ [English](./CONTRIBUTING.en.md)

感谢你有兴趣为本项目做贡献！本文档说明**如何搭建环境、如何验证改动、以及提交规范**。

> 本仓库开源的是技术讲义渲染引擎核心与通用工具链（VitePress 核心配置、图表仿真管线、自动化审计与质量闸门），并附带了一套涵盖 6 大体系的基础演示课程包供开发调试与走查。

---

## 一、这个项目是什么

一个**面向中文技术讲义的可交互 VitePress 站点引擎**：

| 目录 | 作用 |
| --- | --- |
| `site/` | 站点引擎本体：VitePress 配置、主题、图表渲染、KaTeX 数学渲染 |
| `site/docs/.vitepress/` | 站点配置（`config.mts`）、课程组定义、图表组件、样式 |
| `scripts/` | 内容转换、质量闸门与审计工具链（Python + Node） |
| `engine/` | 引擎设计文档 |
| `content/` | 内容规范与写作契约 |
| `ops/` | 运维与部署文档、质量审计报告 |

**核心设计**：每讲 = 一个 Markdown 文件 + 一个图表 sidecar JSON，互不越界；
工具条、样式、导航的改动只落在一处，全站同步。

---

## 二、环境准备

| 依赖 | 版本要求 | 说明 |
| --- | --- | --- |
| Node.js | **≥ 20** | 站点构建与前端工具链 |
| npm | 随 Node 附带 | 依赖安装 |
| Python | **≥ 3.10** | 质量闸门脚本（仓库开发机实测于 3.14） |

Python 侧脚本**只依赖标准库**，无需 `pip install`。

```bash
git clone <仓库地址>
cd <仓库目录>
```

---

## 三、安装与构建

所有前端命令都在 `site/` 目录下执行：

```bash
cd site
npm ci          # 严格按 package-lock.json 安装，保证可复现
npm run build   # 生产构建，产物在 site/docs/.vitepress/dist/
```

本地开发预览（带热更新，改 Markdown 即时刷新）：

```bash
cd site
npm run dev     # VitePress 开发服务器，默认 http://localhost:5173
```

> **提示**：开发阶段优先用 `npm run dev` 做秒级热重载验证；
> 只有准备提交前才需要跑一次完整的 `npm run build` 做生产硬门禁。

---

## 四、提交前的质量闸门（必读）

本仓库有一套**自建质量闸门**，全部在**仓库根目录**执行。
提交 PR 前请确保它们通过。

### 4.1 尖括号规则单测（任何仓库状态都必须通过）

```bash
python scripts/test_angle.py
```

覆盖 Vue 模板编译器对裸 `<` 的处理规则（散文转义、行内 code 去占位符尖括号、
代码围栏免转义、白名单 HTML 标签保护）。
**期望输出**：`15/15 通过`，退出码 0。

这是**纯函数单测，不读取任何讲义内容**，因此在空的引擎仓库里也一定会运行。

### 4.2 figure 锚点 ↔ 图表 JSON 契约校验

```bash
python scripts/check_figs2.py
```

校验每讲的 `<figure class="chart">` 锚点的
`data-lecture` / `data-id` / `data-type` 与 `site/docs/public/charts/<ID>-Lxx.json`
是否严格 **1:1 双向对应**。
**期望输出**：`不一致数: 0`，退出码 0。

> ⚠️ **该脚本在扫不到任何讲义时会主动报错退出（退出码 1）**，
> 因为它内置了"真空 PASS 风险"防护——扫描集为空时无法证明任何事。
> 在**不含讲义**的引擎仓库中，请**跳过**这条闸门（CI 已自动跳过）。

### 4.3 正文外链硬判据

```bash
python scripts/check_body_links.py
```

扫描构建产物中所有 `L*.html`，断言**不允许出现任何 `<a href="http…">`**——
项目中所有外部链接的唯一合法形态是 `.cite` 胶囊
（`<span class="cite" data-cite="…">`），它渲染为 `<span>` 而非 `<a>`。
**期望输出**：`结论: PASS`。

> ⚠️ 该脚本需要**先完成 `npm run build`**（它读 `dist/`）。
> 该脚本的退出码已正确反映结论（2026-10-15 修），并内建真空自检。
> （结论未反映到 exit code，属已知缺陷）。因此 CI 中额外断言了
> 输出里必须出现 `结论: PASS`，而不能只看退出码。
> 在**不含讲义**的引擎仓库中，请**跳过**这条闸门（CI 已自动跳过）。

### 4.4 一条龙验证（有讲义时）

```bash
cd site && npm ci && npm run build && cd ..
python scripts/test_angle.py
python scripts/check_figs2.py
python scripts/check_body_links.py
```

---

## 五、代码风格

### 5.1 通用

- **注释与文档一律使用中文**（本项目是中文项目）。
- 缩进与行尾由 [`.editorconfig`](.editorconfig) 与 [`.gitattributes`](.gitattributes) 统一：
  **UTF-8 编码、LF 行尾、文件末尾保留一个空行**。
  仓库内部一律以 LF 归档，跨平台协作不会产生行尾 diff 噪声。
  请勿提交整文件的行尾重排改动。
- 提交前去掉行尾空白（Markdown 中用于硬换行的**两个及以上**尾随空格除外）。

### 5.2 TypeScript / 前端

- 遵循 **strict 风格**：不用隐式 `any`；能标注类型就标注。
- 站点配置与主题代码位于 `site/docs/.vitepress/`。
- 修改图表或主题前，请先读 `engine/` 下对应的设计文档，理解既有契约再动手。

### 5.3 Python（`scripts/`）

- 遵循 **PEP 8**：4 空格缩进。
- 脚本必须做到**跨平台**：路径一律从脚本自身位置推导，**严禁硬编码绝对路径**
  （`pathlib.Path(__file__).resolve().parents[1]` 是既有惯例）。
- 脚本应支持 `--help`，并给出明确的退出码：**0 = 通过，非 0 = 失败**。
- 打印结论时，请把结论**同时反映到退出码**（这是 CI 可判定的前提）。

### 5.4 Markdown（讲义内容，若你贡献内容源）

- **外链唯一合法形态是 `.cite` 胶囊**，禁止原生 Markdown 链接与裸 URL。
- 散文中 `<` 紧跟 ASCII 字母/下划线需转义为 `&lt;`；紧跟数字/空格/中文则保持原样。
- 行内代码中的占位符尖括号（如 `` `<name>` ``）需去掉尖括号。
- **公式一律用 LaTeX**（`\( … \)` 行内，`$$ … $$` 行间），不要用 ASCII 摆版。
- 代码围栏需带规范语言标签（`bash` / `shellsession` / `kconfig` / `asm` / `ini` / `text` 等），
  不要写带空格的 `plain text`。
- 分隔线 `---` 前必须保留一个空行（否则会被解析成 Setext 标题）。
- 详见 [`content/`](content/) 目录下的内容规范文档。

---

## 六、提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，**描述用中文**：

```
<类型>(<范围>): <简短描述>
```

| 类型 | 用途 |
| --- | --- |
| `feat` | 新增功能 |
| `fix` | 修复缺陷 |
| `docs` | 仅文档变更 |
| `refactor` | 重构（不改变外部行为） |
| `chore` | 构建、依赖、配置等杂项 |
| `test` | 测试相关 |
| `style` | 格式调整（不影响逻辑） |

示例：

```
feat(charts): 支持 wavedrom 时序图全屏缩放
fix(theme): 修复 mermaid 标签被正文行高顶高导致文字不居中
docs(content): 补充 LaTeX 分式尺寸的降级判据
```

**提交粒度**：一次提交只做一件事。**严禁**把"规则/配置变更"与"内容变更"混在同一个提交里。

---

## 七、Pull Request 流程

1. 从 `main` 切出特性分支：`git checkout -b feat/your-feature`
2. 完成改动，跑通第四节的相关闸门。
3. 提交并推送，然后开 PR（PR 模板会自动加载，请逐项填写）。
4. 在 PR 描述中说明：**改了什么、为什么、如何验证**。
5. 若改动涉及图表契约或内容规范，请在 PR 里附上闸门的**实际输出**。

维护者会尽快 review。请保持耐心与友善——见
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

## 八、提交前自检清单

- [ ] `cd site && npm ci && npm run build` 成功
- [ ] `python scripts/test_angle.py` → `15/15 通过`
- [ ] （若有讲义）`python scripts/check_figs2.py` → `不一致数: 0`
- [ ] （若有讲义）`python scripts/check_body_links.py` → `结论: PASS`
- [ ] 未提交 `node_modules/`、`dist/`、缓存等构建产物
- [ ] 未提交任何密钥、令牌、私钥（见 `.gitignore`）
- [ ] 提交信息符合第六节规范

---

## 九、报告问题

- **缺陷**：请用 [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.md)。
- **功能建议**：请用 [功能请求模板](.github/ISSUE_TEMPLATE/feature_request.md)。

提交 issue 前请先搜索是否已有同类问题。**请勿在 issue 中粘贴任何密钥或令牌。**
