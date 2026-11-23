# 写内容：给作者与编码智能体

这里是在讲义引擎上建自己内容的全部规矩。智能体先读引擎根目录的 `AGENTS.md`（现在的草稿：[AGENTS.engine.md](./AGENTS.engine.md)），再读这里，再读内容目录里的 `AUTHORING.local.md`。

| 文档 | 内容 |
|---|---|
| [讲义契约](./lecture-contract.md) | 文件放哪、frontmatter、节点信息行、标题、图表、插图、概念、引用、图谱、中英文、站点文案；每条规则对应 `check:content` 的一个代码 |
| [菜谱](./recipes.md) | 建内容目录、新建课程组、新建一讲、导入图片包、导入图谱、定制站点文案与主题、设置访问档：每条一个命令、一个检查 |

命令一览（在 `site/` 下）：

| 命令 | 做什么 |
|---|---|
| `npm run init` | 用 `templates/content/` 生成内容目录（已存在则拒绝） |
| `npm run new:group` | 在 `groups.ts` 加一组并写组页 |
| `npm run new:lecture` | 写一讲的骨架（可带英文译本） |
| `npm run check:content` | 内容检查；`--json` 输出报告，`--verbose` 列出全部提示 |
| `npm run doctor` | 配置、模块、主题包、站点文案 |
| `npm run dev` | 开发服务器；内容模式下自动把内容目录的改动同步到站点（`LECTURE_CONTENT_WATCH=0` 关掉） |

内容目录的结构见 `templates/content/README.md`。
