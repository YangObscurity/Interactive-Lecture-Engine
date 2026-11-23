# 内容仓

这是讲义站的内容仓：讲义、图表、插图、概念页、图谱、站点文案和伴读提示词都在这里，引擎仓里没有它们。
它是一个独立的 git 仓库（私有仓或本地仓都可以），引擎仓的 `.gitignore` 忽略它。

| 路径 | 内容 |
|---|---|
| `site.config.ts` | 站点配置：主题、模块、访问档、语言（不放密钥） |
| `site-texts.json` | 站点文案：站名、短名、顶栏文字、标语、首页描述（中英文）；站名必填 |
| `groups.ts` | 课程组定义 |
| `lectures/<组目录>/Lxx.md` | 讲义；`lectures/<组目录>/index.md` 是组页 |
| `lectures/en/<组目录>/Lxx.md` | 英文译本（可选） |
| `charts/<组编号>-Lxx.json` | 讲义里图表占位的数据 |
| `figures/<组目录>/` + `figures.json` | 插图与登记 |
| `concepts/` | 概念页（`_drafts/` 是草稿） |
| `graph/` | 图谱：`graph.json`、`graph-bindings.json` 等 |
| `prompts/companion.json` | 伴读提示词与快捷动作 |
| `check.config.json` | `npm run check:content` 的附加规则（可选） |
| `AUTHORING.local.md` | 你自己的写作约束 |
| `.env` | 密钥（不提交） |

命令都在引擎的 `site/` 目录里跑：`npm run new:group`、`npm run new:lecture`、`npm run check:content`、`npm run doctor`。
详细做法见引擎的 `docs/authoring/`。
