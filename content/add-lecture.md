# 新增 / 修改一讲（分组件手册）

> TL;DR：**每类改动只碰一个文件。** 先定位你要改的东西属于哪一类，再按对应小节操作，
> 最后跑第 5 节的校验清单。

---

## 0. 先定位：改什么 → 改哪里

| 你要做的事 | 改哪个文件 | 不要碰 |
|---|---|---|
| 新增一整讲 | `docs/<group>/EX-L01.md` + `docs/public/charts/<GROUP>-EX-L01.json` | 主题代码 |
| 改某一讲的**正文文字** | 该讲 `docs/<group>/EX-L01.md` | JSON、主题 |
| 给某一讲**加一张图** | 该讲 md 加一行 figure + 该讲 JSON 加一个 key | 主题 |
| 改某张图的**数据/标题/配色** | 该讲 `docs/public/charts/<GROUP>-EX-L01.json` | md、主题 |
| 某张图**渲染失败/重叠** | 优先看 JSON；通用布局问题在 `charts.ts` | md |
| 改**所有图**的按钮/文案 | `theme/charts.ts` 常量 | md、JSON |
| 改**所有图**的样式 | `theme/custom.css` | md、JSON |
| 改导航/搜索/站点标题 | `theme/../config.mts` | 其它 |

**铁律**：内容改动绝不碰主题，主题改动绝不碰内容。一旦发现自己同时改了两类文件，
说明归类错了，停下重新定位。

---

## 1. 新增一整讲

1. 写 `docs/<group>/EX-L01.md`
   - frontmatter 必须有 `title`（双引号包裹）；`order` 与讲号一致；
     `description` 可包含知识库节点标识符以便回溯。
   - 侧边栏条目**自动生成**（`config.mts` 扫描 `L*.md` 的 `title`），无需改配置。
2. 写 `docs/public/charts/EX-L01.json`
   - key 用 `c1, c2, c3…` 从 1 连续编号。
3. md 里每张图放一行占位：
   ```html
   <figure class="chart" data-lecture="EX-L01" data-id="c1" data-type="mermaid"></figure>
   ```
   `data-lecture` 必须与 JSON 文件名（不含扩展名）保持一致（如 `EX-L01`），`data-type` 必须与 JSON 的 `type` 一致。
4. 构建 + 校验（第 5 节）。
5. 讲次总表**无需手动维护** —— `config.mts` 扫 `docs/<dir>/L*.md` 的 frontmatter title
   ＋ sidecar JSON 自动渲染（讲数/图表数都不手写）。改完只需构建 + 校验（第 5 节）。

> 侧边栏、大纲（`outline: deep`）、上一讲/下一讲链接全部自动，**不改代码**。

---

## 2. 改正文文字

只编辑该讲 md 对应段落。注意：

- 标题用 `##`（进右侧大纲）/ `###`（进子级），层级不要跳。
- 不要在正文里手写 `.chart-body`、`figcaption`、按钮 —— 那些是运行时产物。
- 不要删除 figure 行的 `data-lecture` / `data-id` / `data-type`，删了图就找不到源。

---

## 3. 加一张图

1. **先在 JSON 里加 key**（下一个序号），写好 `type` 与 `code`。
2. **再在 md 对应位置加一行 figure**，`data-id` 与 key 对齐。
3. 顺序无所谓，但**两者必须同时存在**，否则出现 `missing` 或 `unreferenced`。

```json
"c4": { "type": "echarts", "code": "{ ... }" }
```
```html
<figure class="chart" data-lecture="EX-L01" data-id="c4" data-type="echarts"></figure>
```

**图与正文之间留空行**；不要把两行 figure 挤在一起。

---

## 4. 改一张图

- 改数据、标题、图例、配色 → 只改 JSON 的 `code`。
- 不确定某参数会不会引起重叠 → **可以不写 `top`**，`normalizeEchartsLayout` 会自动归一
  （仅在真重叠时下移，不破坏你显式写好的值）。
- 想精确控制 → 显式写 `title.top` / `legend.top` / `grid.top`，归一会尊重你的值。

**不要**为了让图"好看"去改 `charts.ts` —— 那会影响全局所有图表。

---

## 5. 校验清单（双阶段工作流）★

为提升讲义编写与修改效率，全站推行**热重载优先的双阶段验证工作流**（日常高频改动免去耗时全站 build，规避 4173 预览服务 chunk 404 伪故障）：

### 阶段 A：日常编写与即时热重载（推荐常驻 5173）
1. **后台常驻启动 VitePress Dev Server**：
   ```bash
   npx vitepress dev site/docs --port 5173
   ```
   修改 `docs/<group>/Lxx.md` 或 `charts/` JSON 后保存，浏览器毫秒级 HMR 热刷新，无需等待全站重新构建。
2. **结构一致性与源码直读自检（秒级）**：
   ```bash
   # 1) 结构一致性：figure 占位与 JSON key 是否 1:1 对齐
   python scripts/check_figs2.py          # 期望：不一致数 0

   # 2) 尖括号单测与裁判闸门
   python scripts/test_angle.py           # 期望：PASS
   node scripts/fix_angle_brackets.mjs       # 期望：改动 0

   # 3) 源码级排版与 LaTeX 公式审计（直读 site/docs，无需 dist）
   python scripts/format_audit.py --src site/docs
   ```
3. **实机视觉走查（CDP 直连 5173）**：
   ```bash
   node tools/visual/visual_check.mjs --url http://127.0.0.1:5173/<group>/Lxx.html
   ```
   无头 Chrome 直接截取 5173 热重载页面，快速确认图表与排版渲染无瑕疵。

### 阶段 B：提交入库前全量硬门禁（发布终验必须全绿）
在单讲定稿、准备执行 Git Commit 前，执行全站生产构建与全量产物硬指标扫描：
```bash
# 1) 全站 SSR 生产构建
cd site && npm run build

# 2) 全站外链硬扫描（断言构建产物 <a> = 0，.cite > 0）
python scripts/check_body_links.py        # 期望：PASS

# 3) 源码裸 URL 清零
python scripts/audit_bare_urls.py         # 期望：TOTAL 0

# 4) 完整质量闸门联合审计
python scripts/audit_all.py               # 期望：ALL PASS
```

> 这些脚本就在本仓库的 `scripts/` 目录下，克隆仓库即可直接使用。
> 若使用阶段 B 的静态预览（4173），请注意：每次构建后必须重启预览服务，否则会因资源 hash 变动返回陈旧 chunk（详见 `ops/README.md`）。平时推荐阶段 A 常驻 5173 开发服务。

---

## 6. 什么情况才需要动主题

只有当你想改变**所有图的通用行为**时才动 `charts.ts` / `custom.css`：
新增一种按钮、换一种缩放策略、改弹层交互、修一类新出现的重叠。
改完必须跑第 5 节的**全量**回归（不只看改动的那一讲）。

---

## 7. 新增一整组课程（设计准则）★

> **手工只需要改一个文件：`docs/.vitepress/groups.mts`。** 其余全部自动。

### 7.1 步骤

1. **加一条元信息**到 `GROUPS`：`id` / `dir` / `title` / `tagline` / `summary` / `accent` / `tags`
2. **转讲义**（见 7.2）→ 生成 `docs/<dir>/LNN.md` + `docs/public/charts/<ID>-LNN.json`
3. **建组内页** `docs/<dir>/index.md`，内容只有三行：

```markdown
---
title: <课程组> · <讲次标题>
outline: false
---

<GroupIndex />
```

4. 完成。首页卡片、顶栏 nav、侧边栏、组内页讲次表**全部自动生成**。

### 7.2 准则（必须遵守）

| 准则 | 原因 |
|---|---|
| 课程元信息**只**写在 `groups.mts` | 单一数据源；写两处必然不同步 |
| 讲数 / 图表数**绝不手写** | `config.mts` 扫目录与 charts JSON 自动统计 |
| 一组一个目录 `docs/<dir>/`，讲义名必须 `LNN.md` | 侧边栏与讲次表都按此规则扫描 |
| 组内页**只用 `<GroupIndex />`**，不手写讲次表 | 新增一讲不用改表格（旧版手写表格就是坑） |
| 配色写在 `accent`，不硬编码进组件 | 组件遍历 `groups` 自动着色 |
| 每讲 = 一个 md + 一个 charts JSON，图只占一行 | 见第 1–4 节 |

`docs/.vitepress/theme/` 下两个组件是所有组共用的，**加组不需要改它们**：
`HomeBody.vue`（首页门户）、`GroupIndex.vue`（组内页）。

### 7.3 从内容源批量转讲义

工具：`scripts/build_site_lectures.py`

```bash
# 预览
python scripts/build_site_lectures.py --group <GROUP> --src <内容源目录>
# 写盘
python scripts/build_site_lectures.py --group <GROUP> --src <内容源目录> --apply
```

转换规则：源 md 里的 ` ```mermaid / ```echarts / ```wavedrom ` **围栏 = 图表位置**，按出现顺序就地替换成 `<figure>` 占位，并把代码收进 sidecar JSON（`data-id` 从 `c1` 连续编号）。frontmatter 从 `# 第N讲 · XXX` 与 `> 节点 \`xxx\` ｜ ...` 两行提取。

**转换优势**：支持批量自动化解析源文档与图表配置，实现一键格式标准化转换与图表外置分离。

### 7.4 内容源里的四类边界陷阱 ⚠️

内容源直接转成站点 md 时，需注意排版引擎解析差异。前两类**让构建直接失败**，后两类**静默渲染错误**（构建成功但页面显示不对，更危险）。

| 现象 | 根因 | 处理 |
|---|---|---|
| `Invalid end tag` | 非标准包裹标签未配对 | 整行删除 |
| `Error parsing JavaScript expression` / `Interpolation end sign was not found` | 正文里 `` `{{{{…` `` 被 Vue 当插值；**行内代码没有 `v-pre`** | 连续花括号串**每两个之间插零宽空格**打断 |
| **正文段落变成 `<h2>`、出现超长锚点、分隔线消失** | **setext 陷阱**：`---` 紧跟非空行时，上一段被吃成二级标题 | 在分隔线前**补一个空行**，使其成为真正的 `<hr>` |
| **页面上出现多余反斜杠**，如 `-\>` `\<stdio.h\>` | code span 是字面量、**不处理 markdown 转义**，源稿里的 `\-` 之类会原样显示 | 只在 **code span 内部**去掉紧跟标点的反斜杠 |
| **整段正文并成一坨**（表格/引用也不渲染） | 导出器把块逐行 `join`，**块之间没有空行** → Markdown 把连续段落并成一段 | 导出器 `seg_to_md` **块间补空行**（列表/表格仍同块；段内软换行保留） |
| 构建失败：`Duplicate attribute`（Vue） | **块尾**的字面 `{ ... }` 被 markdown-it **属性语法**当 HTML 属性（如 `{ [ INSERT ] [ , ] }` → `<p [="" INSERT="" …>`） | 导入层把字面花括号转义 `\{` `\}` |
| **页面显示字面 `**`**（粗体没生效） | CommonMark flanking：`**结论。**下一句`（闭合星号后紧接汉字）或 `一个**「引言」**件`（起始星号后紧接标点）**两侧都无法闭合** | 这类 span 改 `<strong>…</strong>`（导入层 `normalize_md`） |
| **表格被当纯文本渲染** | 表头列数 ≠ 分隔行列数（6 列表头配 5 个 `\|---\|`） | 分隔行重写成与表头同列数（导入层 `normalize_md`） |

常见边界防护：
- **包裹标签与花括号**：确保非标准包裹标签彻底剔除，连续花括号插入零宽空格；
- **setext 标题陷阱**：确保分隔线 `---` 前均有空行，防止上一段正文被识别为标题；
- **code span 伪转义**：行内反引号内部避免包含 Markdown 转义反斜杠。

四个细节坑：
- **只转义 `<`，不要动 `>`**（行首 `>` 是引用语法；且 `>` 不构成标签）。
- 零宽空格不能写成 `str.replace('{{', ...)`：`` {{{{ `` 会被拆成 `{{` + `{{`，**边界又拼出新的 `{{`**；
  必须用正则 `\{\{+` 对整段连续花括号逐个插入。HTML 实体（`&#123;`）在 code span 内不解析，也不能用。
- **setext 修复必须在 frontmatter 之后做** —— 否则会往 frontmatter 里插空行，直接把文档弄坏。
- **改完 md 必须确认构建真的重新编译了**：VitePress 会复用 markdown 转换缓存，
  实测同一条 md 改完后立刻构建仍产出旧 HTML（构建耗时 25s vs 36s 是明显信号）。
  校验要直接 grep `dist/<组>/<讲>.html`，不要只看构建成功。

工具：
- `scripts/build_site_lectures.py` —— 转换时应用上述四类修复（`clean_lines` + `normalize_body`）
- `scripts/fix_content.py` —— 对**已有**站点 md 做 C1/C4 修复（幂等，可反复跑）
- `scripts/content_audit.py` —— 审计（C1~C7 七类检查，只分析代码块外的正文，避免大量误报）

---

## 8. 正文里不允许出现链接（改用 `.cite`）★

**规则**：讲义正文里**不得出现任何链接**（蓝色 + 下划线会打断阅读节奏）。
外部链接的**唯一合法形态**是 `.cite` 胶囊；该胶囊点击 **`window.open` 直接在新标签打开该外链**
（2026-10-05 改：原先跳本讲「参考来源」段，该段已**全站删除**，改为直接打开，少一次跳转）。
**没有例外**——参考来源段已不存在，正文任何位置都不允许 `<a href="http…">`。

**替代方案**：正文里的行内链接与裸 URL 在转换时被改写成**无高亮的功能性文字**：

```html
<span class="cite" data-cite="https://…" title="https://…">build-system</span>
```

- 平时是**浅色小胶囊**（chip）：一眼能认出"这里是个可点的引用组件"，但不上链接蓝、不抢阅读视线
  （`custom.css` 的 `.cite`；2026-10-05 改——原先只有一条 1px 极淡点线，白底上几乎看不见）
- 悬停才变品牌色并显示 URL（`title`）
- **点击 `window.open(data-cite)` 新标签打开外链**（`theme/cites.ts`）

视觉审计结论（2026-10-05 实测截图）：与正文完全融为一体，**不突兀**，不抢阅读注意力。

实现：`scripts/fix_content.py` 的 `neutralize_links()`（修已有 md）
＋ `scripts/build_site_lectures.py` 同规则（转换时直接生成）。幂等。

### 8.1 裸 URL 同样禁止（含**无协议域名**）★

**不只是 `[文字](URL)`**：正文里的**裸 URL**（带协议 `https://…` 或无协议 `docs.espressif.com/…`）
一律禁止。实测链接的 URL 会把紧跟的中文标点一起吞进 href（`href="…build-system.html%EF%BC%89%E3%80%82"`）。

`fix_content.py` 的 `neutralize_bare_urls()`（C9）负责清理，**两条规则**：

| 情形 | 处理 |
|---|---|
| 括注以「出处/来源：」开头，且去掉 URL 后仍有说明文字 | **删掉 URL 与它的分隔符**（说明文字已点明是哪份文档） |
| 其余位置的裸 URL | 换成 `<span class="cite" data-cite=URL title=URL>短名</span>` |

**无协议域名的判定**（`is_real_domain()`，与审计脚本共用同一谓词）：
- TLD 必须在白名单（`SCHEME_TLDS`）内
- 单段 + 源码后缀（`install.sh`、`build.c`）＝ 文件名，**不转**
- `example.com/.org/.net` 及其子域（RFC 2606/6761 教学占位域名，如证书 CN、MX 示例）＝ **正文内容，豁免**

短名取 URL 末段去扩展名；末段是 `index/latest/documents` 等通用词或长度 > 26 时回落成主机名。
无协议命中的 `data-cite` 自动补 `https://` 前缀（否则 `window.open` 打不开）。

判据（**硬指标**）：构建产物里 `L*.html` 的 `<a href="http…">` 必须为 **0** ——

```powershell
# 期望：a href=http 总数 = 0；自检须报 页面数>0 且 .cite 胶囊数>0（防假阴性）
python scripts/check_body_links.py
```

**三个实现坑**（都踩过）：① 不能按行内 code 切段处理 —— 跨 code 的「（…）」会被切开、
匹配不上、漏清理，要把行内 code 换成**占位符**；② **围栏代码块要整体跳过**（代码里
`.url = "http://<LAN_TARGET>/ingest"` 不是链接）；③ 标点前的空格在 Notion 源稿里
可能是 **NBSP/全角空格**，字符类要写成 `[ \t\u00a0\u3000]`。

清理规模：2026-10-05 **24 文件 / 126 处**（仅带协议）；2026-10-06 **27 文件 / 79 处**
（补漏无协议域名，含 `freertos.org`×21、`docs.python.org`×4 等；遗留 `example.com` 教学占位 4 处按设计保留）。

### 8.2 尖括号（`<`）规则 —— **永久落在导入层**★

**规则不写在站点文件上，而是写进导入器**：`scripts/build_site_lectures.py` 的
`clean_lines → normalize_body → **sanitize_angle** → FENCE`。以后从 Notion 导任何新组，
尖括号自动规整，**不需要再人工修**。

站点侧同规则由 `scripts/fix_content.py` 的 `escape_lt()`（C7）执行（对已有 md 幂等）。

判据全部来自 `@vue/compiler-dom` 实测（不是猜的）：

| 位置 | 处理 |
|---|---|
| 散文 `<` 后跟 ASCII 字母/下划线 | → `&lt;`（导入层）/ `\<`（C7）—— Vue 实测 `<name>` `<NAME>` `<stdio.h>` `<x y>` `<idf-py>` 全报 *Element is missing end tag*；两者在散文里浏览器仍显示 `<` |
| 散文 `<` 后跟数字/空格/`<`/中文 | **不动** —— Vue 本来就接受（`<150` `< 150` `<< 24` `<中文>`） |
| 行内 code 里的占位符 `<name>` / `<下一跳>` | → `name` / `下一跳`（去尖括号）—— 行内 code 内 raw `<` **没有稳妥转义方案**，只能不让它出现 |
| 围栏代码块 | **一律不动** —— VitePress 自动给围栏加 `v-pre`，raw `<` 安全 |
| 合法 HTML 标签（`<figure>` `<span class="cite">` `<strong>` `<br/>` 等白名单 `TAG_KEEP`） | **一律不动** —— 保护 |

**⚠️ 2026-10-06 修复的一处回归**：`fix_content.escape_lt()` 旧实现是
`re.sub(r"(?<!\\)<", r"\\<", seg)` —— **无差别转义所有 `<`**，把白名单标签也转了，
页面显示成字面文本（实测 **9 处 `<strong>` + 8 处 `<br/>`**）。
现改为：先自愈（把误转义的 `\<白名单标签>` 还原）、再 `TAG_KEEP` 占位保护、
最后只转义 `ANGLE_BREAK`（`<` 后跟 ASCII 字母/下划线）命中的那些。
回归防线：`content_audit.py` 的 **C7**（期望 0）。

**四条已被实测证伪的"转义方案"（不要再试）**：

| 方案 | 结果 |
|---|---|
| 行内 code 里写 `&lt;` | markdown-it 把 `&` 再转义 → 页面显示成字面量 `&lt;` ✗ |
| 行内 code 里写 `\<` | code span 内不处理转义 → 显示 `\<` ✗ |
| 行内 code 外裹 `<span v-pre>` | markdown-it 先处理 code span，raw `<` 照样进 Vue 模板 → 仍炸 ✗ |
| 用全角 `＜` | 读者复制命令会拿到全角字符 ✗ |

**两道保险**（每次改完必跑）：

```bash
python scripts/test_angle.py            # 单测，期望 7/7 PASS
node  scripts/fix_angle_brackets.mjs    # 裁判闸门（VitePress 自己的渲染器当裁判）
```

`fix_angle_brackets.mjs` 的做法值得记住：用 **VitePress 自己导出的 `createMarkdownRenderer`**
解析同一文件（`lecture-site` 里**没有独立 markdown-it**，它被内联进 dist 了），
把自写的 code span 扫描与裁判的 `code_inline` **逐项比对**，
**不一致的文件拒绝写盘**（宁可不动，也不猜）。裁判加载不到则直接 `exit 2` —— 绝不静默降级。

---

## 9. 临时课程组（例如：某个单独挂载的课程组）

临时挂一份外来讲义时：

1. `groups.mts` 加一条并带 **`temp: true`** → 首页卡片多一个虚线「临时」药丸标记，便于日后辨认/移除
2. 使用通用转换脚本或编写轻量解析器生成讲义，复用转换器的同一套内容规则与保护
3. 建 `docs/<dir>/index.md`（三行 + `<GroupIndex />`）
4. 移除时：删 `groups.mts` 那条 + `docs/<dir>/` 整个目录即可，**不影响其它组**

无图表的组不写 `charts JSON`，首页卡片会自动只显示「N 讲」而不显示「0 图」。

### 9.1 素材 vs 讲义（一个真实教训）★

一份外部资料往往同时包含**讲义**和**原始素材**两类文件，**只把讲义上线**。

以某个课程组为例，源目录（例如 `提取\<课程名>_讲义解析\`）里：

| 文件 | 性质 | 是否上线 |
|---|---|---|
| `00_全量讲义解析_中文.md` | **讲义**（考试导向的整理稿） | ✅ 按章拆成多讲 |
| `Week 0…12 *.md` | 原始素材（PPT 逐页英文提取） | ❌ 不上线 |
| `90_图片页OCR补充.md` | 原始素材（OCR 补充） | ❌ 不上线 |
| `00_原始提取索引.md`、附录 D 文件清单 | 索引 | ❌ 不上线 |

**按章拆分**：讲义里的 `## 第 N 章 …` 就是天然的分讲边界，导入器直接按 `##` 切分 ——
最终 = 导览（考试情报 + 章节总览）+ 各章正文 + 附录速查
（原先误把 Week 原始稿也挂成了讲次，已纠正）。

导入器每次运行会**先清掉 `docs/<dir>/L*.md`** 再重建，避免旧的素材副本残留成"讲次"。
源素材文件本身**不动**（仍留在 `提取\` 目录供溯源）。

## 10. 代码围栏的语言标签要写对（否则一片灰）★

**规则**：围栏标签必须是 Shiki 认得的语言名；**`text` / `plain` / `txt` 是特殊语言，
设计上就不高亮**，页面上是没有颜色的灰块。

内容源常常偷懒把非 C 的块一律标成 `plain text`（注意是「plain」+「text」两个词），
转换后需要跑一次重标注：

```bash
python scripts/retag_fences.py            # 预览
python scripts/retag_fences.py --apply    # 写盘（幂等）
```

判定规则见 `engine/README.md` §1c。常用对应：

| 内容 | 标签 |
|---|---|
| 终端会话（`$ 命令` + 输出） | `shellsession` |
| 单独一条命令 | `shellsession`（或 `bash`） |
| Kconfig 片段 | `kconfig`（本项目自定义语法） |
| 汇编（`.section`/`.globl`） | `asm` |
| `key = value` 配置 | `ini` |
| ASCII 工程公式（**历史遗留**） | `math`（本项目自定义语法，不再新增） |
| 真·纯文本 / 引文 / 目录树 | `text` |

> ★ **公式必须用 LaTeX（2026-10-07 定稿）**：行内 `\( … \)`、行间 `$$ … $$`／`\[ … \]`（**禁用裸 `$…$`**）；
> 量关系用 `\dfrac`（满尺寸上下分式）、系数用 `\frac`、**单位与指数保留斜杠**；
> 读者可点击公式复制 LaTeX 源码（`data-tex`）。完整约定见根 `AGENTS.md` §4.9 与
> 迁移时建议自行维护一份「逐讲迁移台账」，记录哪些公式已转 LaTeX。

> 不需要在 `config.mts` 里登记这些语言 —— VitePress 会按需动态加载 Shiki 内置的
> 316 种语言；只有 `kconfig` / `math` 这类 Shiki **没有**的才需要自定义语法
> （见 `docs/.vitepress/grammars.mts`）。

---

## 11. 从上游内容源批量导入新课程组 ★

本引擎设计支持从任意上游知识库与 Markdown 源批量导入新课程组：

```
上游内容源 ──导出/整理──► 源内容目录 ──转换──► 站点 docs/<group>/LNN.md + charts/<GROUP>-LNN.json
                         （含图表定义）            （导入层自动规整尖括号/链接/setext…）
```

### 11.1 标准批量导入工作流

```bash
# 1) 批量转换指定课程组内容（--apply 写入磁盘）
python scripts/build_site_lectures.py --group <GROUP> --src <源目录> --apply

# 2) 运行完整质量与结构审计
python scripts/check_figs2.py             # 验证 figure 锚点与 sidecar JSON 1:1 对齐
python scripts/test_angle.py              # 验证尖括号 Vue 编译器安全
python scripts/audit_bare_urls.py         # 验证正文裸 URL 清零

# 3) 执行安全生产构建与产物校验
python scripts/safe_build.py
python scripts/check_body_links.py        # 验证静态产物外部链接合规
```

### 11.2 导入边界排查与加固

| 潜在问题 | 表现与加固方案 |
|---|---|
| 编码格式与 BOM 冲突 | 保证所有 Markdown 与 JSON 文件均使用标准 UTF-8 无 BOM 编码，避免跨平台解析异常 |
| 跨平台行尾与管道输出 | 统一标准换行符（LF），子进程与文件读写均显式指定 `encoding="utf-8"` |
| 图表类型判定完备性 | 确保支持 `mermaid`、`wavedrom`（含 `reg` / `signal` / `assign`）以及 `echarts` 的全量识别 |

### 11.3 为什么"导入层即终态"

尖括号转义、链接胶囊化、setext 标题陷阱防范、行内代码伪转义清理**均在转换流水线中一次性自动规整**，保证新课程组接入后即处于结构纯净状态；后续的校验步骤仅作为质量把关闸门，实现新课程组接入的零人工修补与高效流转。
