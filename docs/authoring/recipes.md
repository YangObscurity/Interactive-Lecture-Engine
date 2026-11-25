# 菜谱

每条菜谱都是「一个命令 + 一个检查」。命令在引擎的 `site/` 目录下运行（另有说明的除外）；内容目录默认是仓库根的 `content/`，设置了 `LECTURE_CONTENT_DIR` 时是那个目录。规则细节见 [讲义契约](./lecture-contract.md)。

## 0. 第一次：建内容目录

```bash
npm run init
```

- 用 `templates/content/` 生成内容目录；目录已存在且不空时拒绝。
- 生成后把站名写进 `site-texts.json` 的 `zh.name` 与 `en.name`（空着构建会失败），然后 `cd <内容目录> && git init`：内容目录是你自己的私有仓库，引擎仓不追踪它。
- 检查：`npm run check:content`（站名为空时 FAIL，其他空字段只是 INFO）。

## 1. 新建课程组

```bash
npm run new:group -- --id G01 --dir g01 --title "数字电路" --tagline "从门电路到状态机" --summary "组合逻辑、时序逻辑与状态机" \
  [--accent "#3B82F6"] [--tags "逻辑,时序"] [--category "硬件"] [--temp] [--title-en "Digital circuits"]
```

- 在 `groups.ts` 末尾追加一组（改完会重新加载一次，确认文件仍能读），并写组页 `lectures/g01/index.md`。
- 带 `--temp`（即 `groups.ts` 中的 `temp: true`）会创建正式**临时组**：排在课程列表末尾、在卡片/导航/组页/Console 显示临时徽章、进度仅存入数据库（`rest`）或浏览器本地（`local`），**不会**触发 Notion 同步（也不会出现 Notion 未绑定报错）。
- `id` 用大写字母和数字（也是图表文件前缀），`dir` 用小写字母、数字、`-`；重复或占用引擎目录会被拒绝。
- 检查：`npm run check:content`（新组没有讲义时给 WARN `group.no_lectures`；若 `groups.ts` 中 `temp` 字段不是布尔值，给 FAIL `group.invalid_temp`）。

## 2. 新建一讲

```bash
npm run new:lecture -- --group G01 --title "门电路与真值表" [--node dc_gates] [--difficulty 2] [--minutes 60] [--n 3] [--title-en "Gates and truth tables"]
```

- 写 `lectures/g01/Lxx.md`：四项 frontmatter、节点信息行、开篇、正文、参考三节骨架；`check.config.json` 要求的标题（例如「下一讲预告」）也一并写上。编号默认接在本组最后一讲之后。
- `--title-en` 同时写英文译本骨架 `lectures/en/g01/Lxx.md`。
- `groups.ts` 不用改：讲数、图数由引擎数文件。
- 加图表：在讲义里放 `<figure class="chart" data-lecture="G01-Lxx" data-id="c1" data-type="mermaid"></figure>`，在 `charts/G01-Lxx.json` 写 `{"c1": {"type": "mermaid", "code": "..."}}`。
- 检查：`npm run check:content`，然后 `npm run dev` 看页面（开发服务器会自动把内容目录的改动同步到站点，不用另开终端）。

## 3. 导入图片包（论文插图）

```bash
# 仓库根目录；需要 poppler（pdftocairo 等）、gs、ImageMagick 7
python3 scripts/figures/import_figure.py --source <论文.pdf> --page 6 --crop 0.08,0.10,0.92,0.52 \
  --group g01 --id rc-step-response --out-rel L03/rc-step-response.svg \
  --caption-zh "RC 电路的阶跃响应" --caption-en "Step response of an RC circuit" \
  --paper "<作者> (<会议或期刊> <年>)" --source-num "Fig. 3" --source-page 6
```

- 原始素材包放在仓库之外（例如 `~/Assets/figure-packs/`），内容目录只放挑好的图。脚本输出 SVG 或 2 倍 WebP，写进 `figures/<组目录>/`，并在 `figures.json` 登记尺寸、校验值和出处（论文、图号、页码；有 DOI 就加）。
- 在讲义里挂：`<LectureFigure id="rc-step-response" />`；正文引用 `[](fig:rc-step-response)`。
- 挂图是智能体的事，Dashboard 的图库只看图、查来源和用在哪一讲。参数全表见 `docs-dev/FIGURES.md`。
- 检查：`npm run check:content`（登记、文件、校验值、引用、访问档；登记了没引用给 WARN）。

## 4. 从 Notion（或任何 Mermaid 拓扑图）导入图谱

```bash
# 仓库根目录。先同步一次，导入器读 site/docs 里的讲义副本来对账
(cd site && npm run content:sync)
python scripts/importers/mermaid_graph.py --in <内容目录>/graph/<拓扑图>.mmd \
  --bindings <内容目录>/graph/graph-bindings.json --docs site/docs --report <内容目录>/graph/import-report.md
```

- 输入是 Mermaid `flowchart`：节点 `id["标题"]`、边 `a --> b`（前置 → 后续）、`classDef` 表示状态。Notion 用户可以用 `scripts/importers/notion_graph_export.py` 先导出成 `.mmd`（需要 `NOTION_TOKEN`，放在用户目录的 secrets 文件里，不进仓库）。
- 输出写到内容目录的 `graph/graph.json`（路径取自 `paths.mts`）。节点按讲义 `description` 里的节点 id 绑定到讲；绑不上的，在 `graph-bindings.json` 里手写 `"<节点 id>": "/<组目录>/Lxx"`。
- 检查：`npm run check:content`（绑定指向不存在的讲是 FAIL；节点指向不存在的讲是 WARN）。

## 5. 定制站点文案与主题

站点文案：编辑 `<内容目录>/site-texts.json`，或在 `npm run dev` 的 Dashboard「站点文案」页改。

- 只写事实（课程是什么、有几组），不写营销腔；改完先给用户过目。
- 留空规则：站名必填；短名空用站名；顶栏文字、标语空则不显示；首页描述空用标语。首页描述可写 `{lectures}`。

主题：编辑 `<内容目录>/site.config.ts`。

```ts
export default {
  theme: 'datasheet',            // 默认主题：datasheet 或 reader
  themes: ['reader'],            // 读者可切换的其他主题
  themeOverrides: { datasheet: { modes: { light: { accent: '#0F5B3E' } } } },   // 只改颜色，不写代码
}
```

- 自己的主题包放 `<内容目录>/theme/<id>/`（`theme.json` + `theme.css`，可选组件），在 `themePacks` 里登记，路径相对 `site/`（默认布局下写 `'../content/theme/<id>'`）。带组件的包是代码，会在每个读者的浏览器里运行。槽位与字段见 `docs-dev/SLOTS.md`。
- 检查：`npm run doctor`（配置、主题包、模块与站点文案），再 `npm run check:content`。

## 6. 设置访问档

编辑 `<内容目录>/site.config.ts` 的 `access`：

```ts
access: {
  default: 'public',                       // 首页与没列出的组：public 或 authenticated
  enforcement: 'gateway',                  // 有认证网关时写 gateway；没有写 none
  groups: { G05: { read: 'authenticated' }, LR: { read: ['staff'] } },   // 组 id -> 谁能读；数组是网关用户组名
}
```

- 受限组的内容只进 `/_access/<档>/` 与组目录，网关按构建产出的清单放行。有受限组（或 `default: 'authenticated'`）而 `enforcement` 不是 `gateway` 时构建会拒绝；只想发布公开组用 `npm run build -- --audience public`。
- 也可以在 Dashboard「课程组与讲义」页改档，改前会显示影响。
- 检查：`npm run doctor`，然后 `npm run build && npm run check:access:dist`（产物里受限内容没有漏进公开部分）。细节见 `docs-dev/ACCESS.md`。

## 收尾清单

```bash
npm run check:content && npm run doctor     # 内容与配置
npm run build                               # 改了引擎或想看产物时
```

有 FAIL 就不算完成。只改内容目录；引擎目录里的 `site/docs/<组>/` 等是副本，改了会被下一次同步拒绝。
