# README 风格锁定与同步规范 (README Sync & Style Lock)

本规范同时服务于维护者、CodeRabbit、PR-Agent 与 GitHub Actions（`.github/workflows/readme-sync.yml` + `scripts/check_readme_sync.mjs`），用于在不增加大模型成本、也不改坏原文档版式的前提下，保证根 README 与后端说明随代码事实同步。

---

## 1. 维护范围与对齐关系

| 文档 | 权威事实源 | 强制同步关系 |
|---|---|---|
| `README.md` | `site/`、`server/`、`docs-dev/`、`scripts/`、仓库根目录布局 | 必须与 `README.en.md` 保持节数、结构块与事实完全对齐 |
| `README.en.md` | 与 `README.md` 相同 | 与 `README.md` 必须成对更新（除非 PR 明确标记 `[skip-readme-sync]`） |
| `server/README.md` | `server/.env.example`、`server/src/config/schema.ts`、`server/src/app.ts`、`server/src/routes/**` | 第 8 节配置表必须覆盖 `server/.env.example` 的全部激活变量 |

---

## 2. 风格锁定条款（不可破坏）

### 2.1 语言与语气（"只写事实，不写口号"）

- 只陈述**已实现的功能、真实命令、实测边界与已知限制**；不写宣传口号、绝对化形容词或空泛修饰。
- 禁用营销腔与常见 AI 套话（由 `scripts/check_readme_sync.mjs` 硬拦截）：
  - 中文禁用词示例：`革命性`、`颠覆性`、`赋能`、`无缝衔接`、`丝滑体验`、`企业级`、`全方位`、`一站式解决`、`强力驱动`、`超强性能`、`震撼发布`
  - 英文禁用词示例：`revolutionary`、`game-changing`、`seamlessly`、`unlock the power`、`cutting-edge`、`enterprise-grade`、`supercharge`、`empower`、`best-in-class`、`next-generation`
- `README.en.md` 延续既有简洁偏英式技术用语（如 `summarise`、`colours`、`built in`）。
- 章节标题与正文不使用装饰性 Emoji（统一通过项目自带 `docs/brand/icons/*.svg` 的 `<picture>` 标签适配明暗主题）。

### 2.2 版式与视觉组件锁定

修改 `README.md` 与 `README.en.md` 时，必须保留以下原文档骨架（禁止擅自改成纯文本列表或第三方排版模板）：

1. 居中头部 `<div align="center">`：`docs/brand/banner-{light,dark}.svg`、`<h3>` + `<p>` 一句话定位、6 枚 `#2155c4` flat-square 徽章、中/英切换行、页内锚点导航行。
2. Hero 图与说明：`docs/brand/hero.png` / `hero-dark.png` 与 `<sub>` 注释。
3. V2 提示块：`> [!IMPORTANT]`（以及快速开始中的 `> [!TIP]`、已知限制中的 `> [!NOTE]`）。
4. 亮点与工作方式：`docs/brand/highlights-{zh,en}-{light,dark}.svg`、`docs/brand/architecture-{zh,en}-{light,dark}.svg`。
5. 截图主表与 `<details>` 更多截图折叠区（引用 `docs/screenshots/*.png`，不得手工编造或指向不存在的文件；截图刷新须走 `cd site && npm run screenshots:readme`）。
6. 快速开始 3 步标题图标（`step-1..3-{light,dark}.svg`）。
7. 功能区 5 个 `<details>` 折叠块（分别配 `lecture`、`map`、`theme`、`access`、`ai`、`layers` 图标）及可选后端 HTML 表格（`server`、`database`、`gateway` 图标）。
8. 文档 3 列表格（`pen`、`puzzle`、`rocket` 图标）、仓库目录、开发与测试命令、隐私检查、已知限制、`参与 / Contributing` 及底部 MIT 声明。

---

## 3. 自动化门禁与触发规则

### 3.1 确定性脚本与 GitHub Actions（零 API 成本）

`node scripts/check_readme_sync.mjs` 在每次 Push（`main` / `feat/**`）与 Pull Request 运行，校验：

1. **版式与视觉元素完整**：品牌图、`#2155c4` 徽章、双语切换、`##` 章节数、`<details>` 折叠块数量在 `README.md` 与 `README.en.md` 之间一致。
2. **锚点与相对路径有效**：所有页内 `#anchor` 能匹配真实标题；所有本地链接与图片路径（`src`、`href`、Markdown 链接）真实存在于仓库。
3. **风格禁词扫描**：拦截上文列出的营销/AI 夸饰词与标题 Emoji。
4. **环境变量 100% 对齐**：`server/.env.example` 中每个环境变量均必须在 `server/README.md` 第 8 节配置表中存在且无冗余过时变量。
5. **PR 变更联动检测**（`--base` / `--head`）：
   - **硬阻断**：修改了 `README.md` 但未同步 `README.en.md`（或反之），且提交/PR 标题未携带 `[skip-readme-sync]`。
   - **提醒（Step Summary Notice）**：改动了 `server/src/app.ts`、`server/src/routes/**`、`site/docs/.vitepress/theme/components/dashboard/**`、`site/package.json` 或 `docs-dev/` 且未修改 README 时，提示维护者确认是否需要补充面向用户的说明（纯粹内部 bugfix 可直接忽略或加 `[skip-readme-sync]`）。

### 3.2 CodeRabbit 与 PR-Agent 协作职责

- **CodeRabbit（`.coderabbit.yaml`）**：已将该文件纳入 `knowledge_base.code_guidelines.filePatterns`，并在 `path_instructions` 中为 `README*.md`、`server/README.md` 和 `docs-dev/README_SYNC.md` 注入审查规则。
- **PR-Agent（`.github/workflows/pr-agent.yml`）**：在既有 ClinePass 免费/低耗审查流程中通过 `PR_REVIEWER__EXTRA_INSTRUCTIONS` 复核 README 同步与语气风格；`PR_CODE_SUGGESTIONS__COMMITTABLE_CODE_SUGGESTIONS` 保持 `false`，不自动改写仓库。

---

## 4. 维护者日常操作速查

```bash
# 本地校验 README 风格、双语对齐、链接与环境变量表
node scripts/check_readme_sync.mjs

# 校验 server/.env.example 与 schema.ts 一致
cd server && npm run config:check

# 如同时改了截图触发区域，按需用示例内容重拍（Linux CI 基线下核验）
cd site && npm run screenshots:readme
```
