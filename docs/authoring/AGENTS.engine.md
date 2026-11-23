# AGENTS.md — 给编码智能体的规则

> 本文件在 S5 拆仓后是引擎仓根目录的 `AGENTS.md`。适用于任何编码智能体（Claude Code、Codex、Antigravity 等）。

动手之前先读两份：本文件与 `docs/authoring/`（讲义契约 + 菜谱），以及内容仓里的 `content/AUTHORING.local.md`（用户自己的写作约束，没有就跳过）。两者冲突时以用户的为准，**但下面「安全与隐私」几条不让步**。

## 内容与引擎分开

- 讲义、图表、插图、概念页、图谱、站点文案、提示词只写进内容目录（`content/`，或 `LECTURE_CONTENT_DIR` 指向的目录）。不为了内容去改引擎文件；外观的改动走主题、槽位和 `site.config.ts`。
- `site/docs/<组>/`、`site/docs/public/charts/` 等是 `content:sync` 生成的副本，改了会被拒绝同步。只改内容目录里的源文件。
- 新建一律用脚手架，不手工拼文件：`npm run init`、`npm run new:group`、`npm run new:lecture`（在 `site/` 下运行）。
- 插图由你挂：图放进 `content/figures/<组>/`，在讲义里引用，在 `figures.json` 登记论文、图号、页码、DOI。Dashboard 的图库只用来看。

## 收尾

- 交付前必须跑通 `npm run check:content` 和 `npm run doctor`（在 `site/` 下）；改了引擎代码再加 `npm run check` 与 `npm run build`。有 FAIL 就不算完成。
- 站点文案（`site-texts.json`）只写事实，不写营销腔；写完先给用户过目再提交。

## 安全与隐私（不让步）

- 不把内容复制进引擎目录，不把 `content/` 提交到引擎仓。内容仓是单独的 git 仓库。
- 密钥只放 `.env`（`npm run setup` 生成），不写进任何被跟踪的文件、日志或提交信息。
- 引擎仓提交前跑 `node scripts/privacy/scan.mjs --staged`，有命中先处理。
