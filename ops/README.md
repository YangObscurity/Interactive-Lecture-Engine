# 构建 / 开发热重载 / 预览 / 视觉审计

> TL;DR：推荐日常开发常驻 **VitePress Dev Server（5173 端口）**，依靠 HMR 毫秒级热刷新与源码直读工具链，规避耗时 50s+ 的构建等待；全量发布终验才执行生产构建与全站硬门禁。
> 预览服务（4173）仅用于 SSR 静态产物离线复核，其痛点在于**不感知重建**（会返回旧 HTML 引用已被覆盖的 chunk 导致 JS 404）。

## 0. 开发热重载模式（推荐日常常驻）★

在编写（Agent 1）与增强打磨（Agent 2）阶段，后台常驻启动开发服务器：
```bash
npx vitepress dev site/docs --port 5173
```
- **核心优势**：直接监听 `site/docs/`，Markdown 正文与 sidecar JSON 修改保存即 HMR 实时热重载；
- **极速审计**：支持 `python scripts/format_audit.py --src site/docs` 直读源码；
- **实机走查**：CDP 脚本直连 `http://127.0.0.1:5173/` 端口截取最新渲染，秒级出图，彻底告别 chunk 404 与服务重启。

## 1. 生产构建（发布终验门禁）

```bash
cd site && npm run build        # → docs/.vitepress/dist（约 15~28s）
```

PowerShell 会把 npm/vitepress 写到 **stderr** 的进度信息报成 `NativeCommandError` ——
**只要末尾有 `build complete in Xs` 就是成功的**，不是真错误。

## 2. 静态预览（必须每次构建后重启）

```powershell
# 1) 按端口杀掉旧服务
$pids = (netstat -ano | Select-String ':4173\s+.*LISTENING') |
        ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -Unique
foreach($p in $pids){ Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

# 2) 起新的预览服务
Start-Process -FilePath 'npx' `
  -ArgumentList 'vitepress','preview','docs','--host','127.0.0.1','--port','4173' `
  -WorkingDirectory '<REPO_ROOT>/site' -WindowStyle Hidden
Start-Sleep -Seconds 8
```

**为什么必须重启**：实测故障现象是

```
404 /assets/app.DyH0-HUJ.js
404 /assets/chunks/theme.CA6psqRZ.js
```

旧 HTML 引用了已被新构建覆盖的 hash → `figures=3`（SSR 输出在）但
`__CHARTS_DONE__=undefined`、`lecture-reading-btn` 不存在、`data-chart-status` 全是 `none`。
**看起来像代码 bug，其实是服务陈旧。** 判断方法：对比 HTML 引用的 chunk 与 `dist/assets/` 是否一致。

## 3. 运维与质量审计工具链

脚本目录：[`../scripts/`](../scripts/)（所有脚本均随本仓库开源提交，克隆即可复用）

| 脚本 | 作用 | 核心断言 / 交付指标 |
|---|---|---|
| `audit_all.py` | 全量质量与规范闸门总控 | 统一调度构建、页面数、链接、尖括号、图表、排版与裸 URL 等 12 道门禁 |
| `audit_bare_urls.py` | 源码层裸 URL 审计 | 检查 md-link、协议裸 URL、无协议域名，断言残留数 = 0 |
| `audit_privacy_leak.py` | 隐私与敏感信息泄漏扫描拦截器 | 深度检测私有绝对路径、生产 IP、API 密钥与私有凭据 |
| `build_lock.py` | SSR 并发构建文件锁 | 申请跨进程互斥文件锁，避免多进程并发破坏 `.vitepress/.temp` 与 `dist` |
| `build_site_lectures.py` | 内容源到站点讲义转换 | 自动提取代码围栏为 `<figure>` 占位并生成 sidecar JSON，规整排版与胶囊链接 |
| `check_body_links.py` | 生产构建产物外链扫描 | 验证静态产物中原生链接标签 `<a>` = 0 且 `.cite` 胶囊数 > 0 |
| `check_deps.py` | 依赖环境与可选工具链检测 | 校验 package.json 依赖完整性与外部运行时环境 |
| `check_encoding.py` | 编码规范与乱码排查 | 验证全站代码与文档 UTF-8 编码完整性，杜绝 BOM 与非法字符 |
| `check_example.py` | 开源演示示例结构与完整性校验 | 验证内置示例课程组配置、讲义文件与图表 JSON 完整对应 |
| `check_figs2.py` | 图表锚点与 JSON 结构一致性 | 验证讲义 `<figure>` 与 sidecar JSON 1:1 双向对应，类型一致且无 orphan |
| `config.py` | 环境变量与公共配置解析加载 | 集中加载管理凭据与环境配置，支持调试打印自动脱敏掩码 |
| `doc_audit.py` | 文档完整性与相对链接静态扫描 | 扫描全站 Markdown 文档断链、坏链与占位符规范 |
| `fix_content.py` | 讲义排版与内容缺陷自愈 | 修复 setext 标题陷阱、尖括号实体化、行内伪转义、外链胶囊化（幂等） |
| `format_audit.py` | 排版规范与 KaTeX 数学公式审计 | 检查超长文本段落、标题层级跳级与 LaTeX 数学公式语法（支持 `--src` 直读） |
| `generate_demo_curriculum.py` | 开源演示课程组自动生成器 | 自动生成演示课程骨架与多种交互图表示例配置 |
| `math_guard.py` | KaTeX 公式与 Vue 编译器隔离防护 | 解析并隔离 LaTeX 数学公式区间，防止 Vue 模板解析冲突 |
| `mount_content.py` | 内容源热插拔挂载与软链接管理 | 支持外部课程目录即插即用挂载与卸载，实现独占呈现与纯净态切换 |
| `safe_build.py` | 并发安全构建执行器 | 包装 npm run build 并结合 build_lock.py 实现全自动互斥构建 |
| `scan_secrets.py` | 敏感凭据正则模式扫描 | 基于规则库深度扫描密钥、私钥与鉴权令牌模式 |
| `test_angle.py` | 尖括号安全规约单测 | 验证 Vue 模板编译器对尖括号的边界安全规约 |
| `test_example_fallback.py` | 示例课程回退与兜底机制单测 | 验证在无私有内容时自动回退并渲染演示课程的功能 |
| `test_mount.py` | 内容源挂载生命周期单测 | 验证挂载、验证、卸载与清理全生命周期的幂等性与安全性 |

> **路径解析约定**：
> 运维与审计脚本默认由**脚本自身位置向上推导仓库根目录**（`pathlib.Path(__file__).resolve().parents[1]`），规范如下：
> - 文档与构建目录（`site/docs`、`site/docs/public/charts`、`site/docs/.vitepress/dist`）默认指向当前仓库内对应标准目录；
> - 临时产物统一写入 `<REPO_ROOT>/.refactor-backup/_temp/`（受 `.gitignore` 保护，不入版本库）；
> - 支持通过各脚本的 `--docs`、`--site`、`--charts`、`--dist` 参数显式覆盖目标路径；
> - 浏览器可执行程序路径支持通过 `CHROME_PATH` 环境变量自适应指定。

### 质量门禁与契约验证

全站质量由自动化门禁体系保障，运行 `python scripts/audit_all.py` 即可完成对构建完整性、页面数、链接合规、尖括号转义、图表 1:1 契约、排版格式与裸 URL 清理的全方位扫描断言。

## 4. 生产环境静态部署与托管

构建成功后，静态文件生成于 `site/docs/.vitepress/dist`，支持部署至各类标准 Web 服务器或静态托管平台（Nginx, GitHub Pages, Vercel, Cloudflare Pages 等）。

| 部署阶段 | 推荐工具 / 操作 | 作用与关键检查 |
|---|---|---|
| 部署前检查 | `python scripts/check_body_links.py` | 产物层链接硬指标：整个 dist 内部 `<a href="http…">` 必须为 **0**，`.cite` > 0 |
| 生产构建 | `python scripts/safe_build.py` | 并发安全串行构建，生成完整 SSR 静态站点产物 |
| 远端发布 | 静态同步 / 原子软链接替换 | 先同步至暂存目录，校验完整性后再原子切换为生产 webroot，保证零停机与高可用 |
| 部署后核验 | HTTP 状态码与静态资源巡检 | 检查首页与核心讲义 HTTP 200、静态 JS/CSS 资源无 404、图表交互与弹层功能正常 |

> **配置管理与凭据保护**：
> 部署相关连接参数（如目标主机、端口、认证用户名、远端 webroot 等）一律通过环境变量或仓库根目录 `.env` 注入（详见 `.env.example`），仓库与文档内严禁硬编码任何真实服务器 IP、域名或认证密钥。

### 为什么推荐"暂存 + 原子替换"

直接向线上运行中的 webroot 目录逐文件上传会导致上传过程中站点处于不完整状态（静态资源 hash 错配或丢失）。推荐先将构建产物完整传输至临时目录（如 `.staging`），校验文件数量与哈希无误后，再通过原子重命名（`mv`）或软链接切换完成上线，将停机与故障窗口降至最低。

### 部署后核心校验点

- 讲义页面中 `figure.chart` 锚点数量与页面预期图表数一致；
- 静态构建产物中 `assets/app.*.js` 磁盘文件名与 HTML 引用一致；
- CSS 与 JS 弹层交互样式完整加载；
- 生产 Web 服务器配置与健康检查通过。

## 5. sync.py 的三个坑（2026-10-05 实证）

### 5.1 构建失败必须中止，否则会部署旧/残缺 dist

`sync.py --all` 里构建曾用 `check=False` → **构建报错也照样 commit + push + deploy** ✗
实测后果：构建中途失败留下**残缺 dist（481 文件，正常 622）**，被原样推上线，站点一度是坏的。

**规则**：构建步必须 `check=True`（失败即 `SystemExit`，绝不继续推送/部署）。

### 5.2 构建前必须先关掉预览服务

预览服务（`vitepress preview`）正读着 `dist` 时构建会**随机失败**，报：

```
TypeError: Cannot read properties of undefined (reading 'imports')
    at resolvePageImports (.../vitepress/dist/node/chunk-*.js)
```

同一份代码、同一个命令，关掉预览后立刻就能 `build complete`。
`sync.py` 已加 `free_preview_port()`：构建前按端口杀掉预览进程，避免文件占用。
（Windows 上 `npm` 是 `npm.cmd`，必须用**字符串**走 shell 调用，列表调用会 `WinError 2`。）

### 5.3 其他 Windows 细节

- `shutil.rmtree` 常因只读属性/句柄占用报 `WinError 5` → 已封装 `rmtree_force()`（清只读后重试）
- `sync.py --push` 支持环境变量 `GITHUB_TOKEN`（一次性 header，不写 `.git/config`）；
  没设就走已配置的凭据助手

### 5.4 盘符大小写会让构建**必然**失败（2026-10-05 定位）

`resolvePageImports` 里有一处**大小写敏感**的字符串比较：

```js
const srcPath = normalizePath(fs.realpathSync(path.resolve(config.srcDir, page)))
const pageChunk = result.output.find(c => c.facadeModuleId === srcPath)
```

把**小写盘符** `g:\...` 当 cwd 交给 node 时，`path.resolve` 得 `g:/...`，
而产物 chunk 的 `facadeModuleId` 是 `G:/...` → 找不到 → `pageChunk.imports` 抛

```
TypeError: Cannot read properties of undefined (reading 'imports')
    at resolvePageImports (.../vitepress/dist/node/chunk-*.js)
```

**第一个被渲染的页面必挂**（字母序最前，本机实测命中的是某组第一讲），所以现象与 §5.2
"预览服务占用 dist" 长得**一模一样**，极易误判成随机故障 —— 但它是**必然复现**的。

**判定方法**：给 `resolvePageImports` 临时插一行日志（`if (!pageChunk) console.error(page, srcPath)`），
看 `page` 与 `srcPath` 的盘符是 `g:` 还是 `G:`。

**修法**：凡是把 cwd 交给 node 的地方都用 `os.path.realpath()` 规范化盘符
（`sync.py` 的 `SITE_SRC`/`REPO` 已加）。**不要**只在 PowerShell 里 `cd G:\...` 就以为没事 ——
脚本里的硬编码小写路径同样会踩。

> 判据速记：**同一份代码、同一命令，报错页面总是字母序第一个 → 先怀疑盘符大小写，而不是文件占用。**

## 6. 站点图标（已修）


原先每个页面都会盲请求 `/favicon.ico` → **404**（控制台一条红字）。
原因：`config.mts` 的 `head` 里**没有声明任何 icon**，浏览器便去默认路径找。

修法（两份都做，缺一不可）：

1. 图标文件放进 `docs/public/`（构建时原样复制到站点根）：

| 文件 | 尺寸/类型 | 用途 |
|---|---|---|
| `favicon.svg` | 300×300 矢量 | **主图标**，现代浏览器优先 |
| `favicon.ico` | 16/32/48/64 多尺寸 | 传统兜底（也是裸请求 `/favicon.ico` 的答案） |
| `icon-192.png` | 192×192 | PWA/安卓 |
| `apple-touch-icon.png` | 180×180 | iOS 添加到主屏 |

2. `config.mts` 的 `head` 里**显式声明**（声明后浏览器不再盲请求）：

```ts
['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/icon-192.png' }],
['link', { rel: 'alternate icon', sizes: '16x16 32x32 48x48 64x64', href: '/favicon.ico' }],
['link', { rel: 'apple-touch-icon', sizes: '180x180', href: '/apple-touch-icon.png' }],
```

**验收**：4 个路径均 HTTP 200，且 CDP 抓网络 **4xx 请求 = 0**（脚本 `_temp/favicon_check.py` 思路）。

> 图标来源：品牌 logo 包里的 `vector/default.svg`（**纯菱形标记**，不含品牌文字）。
> 从 `default.png` 裁 `favicon.ico`/PNG 时注意：**不能按固定比例取左半**，
> 那样会把右边的品牌文字一起圈进来 —— 要**按列扫描找第一个连续墨迹簇**才是标记本身。

---

## 7. ⚠️ 事故与加固：`sync.py --sync/--build` 的「自我复制」自毁（2026-10-07）

**现象**：在沙箱（Linux）里把「工作副本」指向仓库自身的 `site/` 后执行 `sync.py --deploy`，
`mirror()` 对每个条目先 `rmtree_force(dst)` 再 `copytree(src, dst)`；当 `src == dst` 时，
**源已被删掉**，于是 386 个文件（整个 `site/docs/`）瞬间消失（`copytree` 随后抛 FileNotFoundError）。

**为什么没造成损失**：所有内容当时都已 commit + push（`git checkout -- site/docs` 秒级恢复）。
**教训**：① 破坏性脚本必须**先判同路径**再动手；② 「每推进一步就 commit」是真正的安全网；
③ 沙箱里不要跑为 Windows 本地布局设计的镜像步骤。

**加固（已入库）**：
1. `mirror()` 开头 `_same(SITE_SRC, MIRROR)` → **硬拒**（`SystemExit`，不做任何写操作）；
   逐条目也再判一次同路径再 `skip`。
2. `main()` 增加 **SELF_MIRROR 沙箱模式**：工作副本 == 镜像时跳过镜像/差异步骤并打印 `ℹ️` 提示，
   不再输出「两边一致」这种无信息量的结论。
3. 源目录不存在时**报错退出（exit 2）**——此前 `realpath('c:\…')` 在 Linux 上会解析成
   不存在的相对路径，导致 `--check` **假报「两边一致」**（比报错更危险）。
4. `sync.py --push` 改为推**当前分支**（`--branch` 可覆盖），**绝不隐式推 `main`**。
5. 部署流水线支持 `DEPLOY_HOST/PORT/USER/WEBROOT/LOCAL_DIST/SSH_KEY/SSH_KEY_PEM` 覆盖，
   参数解析优雅回退；缺私钥时给出**可执行**的指引而不是程序堆栈崩溃。
6. 无凭据环境下 `sync.py --deploy` **自动降级为 dry-run 自检**（打包 + 报告 + 私钥检查），不再假装成功。
