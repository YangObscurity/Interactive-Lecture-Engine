# 参与贡献

**语言**：中文（英文读者可以直接用英文提 issue 和 PR）

## 开始之前

- 改动较大时先开 issue 说明想法，免得白做。
- 不要提交任何讲义内容、真实课程材料、个人信息、主机名或密钥。引擎仓库只收引擎代码、模板、示例内容和文档。

## 本地环境

```bash
cd site
npm ci
node ../scripts/privacy/install-hook.mjs   # pre-commit 隐私检查
npm run dev
```

后端改动另需：

```bash
cd server
npm ci
npm test
```

## 提交前

在 `site/` 里：

```bash
npm run check        # 类型检查、lint、主题契约、单元测试、内容检查
npm run build        # 示例站点能构建
npm run test:e2e     # 动了界面或交互时跑
```

在 `server/` 里动了后端就跑 `npm test`。PR 说明里贴实际跑过的命令和结果。

## 约定

- 提交信息用 `feat:`、`fix:`、`docs:`、`refactor:`、`test:`、`chore:` 开头，说清楚改了什么、为什么。
- 界面文字放进 i18n 字典（中英文都要），不要写死在组件里；`npm run lint` 会检查。
- 颜色只用主题契约变量（`--lec-*`），不写颜色值；`npm run check:theme` 会检查。
- 截图基准只用示例内容生成；改动影响截图时用 `npx playwright test --update-snapshots` 更新，并在 PR 里说明。
- 新功能顺手补 `docs-dev/` 里对应的说明。

## 许可

提交的代码按本仓库的 [MIT 许可](./LICENSE) 发布。
