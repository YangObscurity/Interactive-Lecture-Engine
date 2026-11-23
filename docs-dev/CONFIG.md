# 讲义引擎配置指南 (CONFIG.md)

本指南说明 Tutorial V2 讲义引擎与运维工具链的统一配置规范、取值优先级与日常工具使用。

---

## 1. 配置分类与存放位置

引擎配置严格划分为**前端构建配置**与**环境运维凭据**两类，两者完全解耦：

| 配置种类 | 涵盖范围 | 存放位置 | 是否打包进产物 |
|---|---|---|---|
| **站点模块 (site)** | `progress` (学习进度)<br>`companion` (AI伴读)<br>`graph` (先修图)<br>`contentSync` (内容同步)<br>`auth` (身份认证) | 内容目录的 `site.config.ts` 中的 `modules` 块（没有内容目录时用引擎默认 `site/lecture.config.ts`；路径由 `site/docs/.vitepress/content/paths.mts` 决定） | 是（前端编译期类型检查与默认值合并） |
| **环境变量 (env)** | 部署主机、SSH 端口、远端微服务地址、测试端点、镜像目录等 | 真实环境变量 或 仓库根 `.env` | 否（仅服务端 / 本地脚本读取） |
| **秘密项 (secret)** | Notion 集成令牌、数据库 ID、页面 ID、SSH 私钥 PEM 内容等 | 真实环境变量 或 仓库根 `.env` | 否（绝不回显、绝不记录日志、绝不提交） |

站点模块除了「选哪个适配器」，还可以带选项（同一张 `modules` 块里，键名即 `schema.ts` 里的 `<模块>.<选项>`）：

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `progress.endpoint` | 路径 | `/api/db` | `rest` 适配器的基础路径（同源，其下是 `/progress`、`/progress/batch`） |
| `progress.notionSync` | 布尔 | `false` | 进度写入后经现有 Notion 同步代理回写 Notion |
| `auth.sessionEndpoint` | 路径 | `/api/auth/session` | 身份接口（`auth.adapter = 'none'` 时前端不请求） |

示例：`modules: { progress: { adapter: 'rest', notionSync: true } }`。写错键名或类型时构建失败，报错里会列出可选项。客户端通过 `themeConfig.lectureModules`（已填好默认值）读取这些设置。

进度 store 的行为（读取规则、发件箱与重试、写入被拒、换人、V1 迁移）与排查方法见 [PROGRESS.md](./PROGRESS.md)。

> **铁律**：真实的服务器 IP、生产域名、SSH 私钥、Notion 令牌与页面 ID 属于私有凭据，**严禁写进任何受 Git 跟踪的文件**。
> `.env` 已在根 `.gitignore` 中排除，只保留 `.env.example` 占位模板。

---

## 2. 统一真源与派生链条

配置表的唯一真源是 `site/config/schema.ts`，其余配置载体全部自动派生：

```
site/config/schema.ts (单一真源)
  ├─ site/config/schema.json      (由 npm run config:gen 生成，供 scripts/config.py 消费)
  ├─ .env.example                 (由 npm run config:gen 生成，分模块注释模板)
  ├─ npm run setup                (交互式向导，按模块配置并校验)
  ├─ npm run doctor               (状态体检与探针连通性测试)
  ├─ scripts/config.py            (Python 统一读取层，读 schema.json)
  └─ scripts/deploy_config.py     (部署脚本兼容层，向后兼容)
```

---

## 3. 取值优先级 (Precedence)

所有读取层（Node.js 与 Python）严格遵循同一四级优先级顺序：

```
1. 真实进程环境变量（非空）
       ↓ (未设置或为空)
2. 仓库根目录 .env 文件
       ↓ (未设置或为空)
3. 旧版部署配置文件 (DEPLOY_ENV_FILE 指定路径，或 scripts/deploy.local.env)
       ↓ (未设置或为空)
4. schema 代码默认值
```

### 别名解析规则
对于带有旧名称别名（alias）的配置项（如 `DEPLOY_SSH_KEY` 与旧名 `DEPLOY_KEY`、`DEPLOY_SITE_DOMAIN` 与旧名 `DEPLOY_DOMAIN`）：
- 在**每一优先级层级内部**，优先匹配标准键名，若未设置再尝试匹配别名；
- 只有当前层级标准键与别名均未提供时，才回退至下一层级；
- 环境变量注入的旧别名优先于 `.env` 中的标准名。

---

## 4. 工具命令

所有工具均位于 `site/` 目录下运行（依赖 Node.js 内置能力，零第三方依赖）：

### 4.1 生成与校验 schema
```bash
# 生成 schema.json 与 .env.example
npm run config:gen

# 校验当前磁盘文件是否与 schema.ts 一致（CI 闸门）
npm run config:check
```

### 4.2 交互式配置向导 (setup)
在交互式终端 (TTY) 下运行：
```bash
npm run setup
```
- 按数字选择要启用的运维模块（如 `1,2` 或 `all`）；
- 逐项输入配置值，回车保留当前值，输入 `-` 清空；
- 输入秘密项时不回显明文；
- 输入完成后自动将修改写入根目录 `.env`（POSIX 系统自动设为 `0600` 权限），并输出体检报告。

### 4.3 配置体检 (doctor)
全面检查所有在用模块的状态、类型合法性与必填项完整度：
```bash
# 控制台直观排查（秘密项仅显示「已设置 (长度 N)」）
npm run doctor

# 附带轻量网络可达性探针 (5s 超时只读探测：Notion API、SSH 端口、HTTPS 等)
npm run doctor -- --probe

# 机器可读 JSON 输出（供自动化脚本调用）
npm run doctor -- --json
```

---

## 5. 旧名称兼容表 (Legacy Aliases)

| 当前标准键名 | 兼容旧名称 | 所属模块 | 说明 |
|---|---|---|---|
| `DEPLOY_SSH_KEY` | `DEPLOY_KEY` | `deploy` | SSH 私钥路径，默认 `~/.ssh/id_ed25519` |
| `DEPLOY_SITE_DOMAIN` | `DEPLOY_DOMAIN` | `deploy` | 生产站点域名（不含协议与斜杠） |

如在环境或配置文件中使用了旧名称，`npm run doctor` 会输出温馨警告并建议迁移至标准名称。

---

## 6. 访问分档 `access` 块

`lecture.config.ts` 的 `access` 块（谁能读哪个课程组、是否有认证网关）不是环境变量，也不属于任何站点模块，
声明在 `site/config/schema.ts` 的 `SITE_BLOCKS`（同样写入 `schema.json`）。配置、档的计算、构建开关、产物布局、
网关清单与检查脚本见 [ACCESS.md](./ACCESS.md)。

---

## 7. 定制讲义后的收尾 / After customising the lectures

课程组、讲义定制完成后，必须执行（完整做法见 `docs/authoring/`）：

1. 运行 `npm run check:content` 与 `npm run doctor`（在 `site/` 下），处理它们列出的 FAIL、站点文案错误与未填写项（每个语言、每个字段各一条）。
2. 填写内容目录 `site-texts.json`（内容模式为 `content/site-texts.json`，原位模式为 `site/site-texts.json`）里的空字段（`zh`、`en` 各一份：`name`、`shortName`、`navText`、`tagline`、`description`），用朴素、基于事实的措辞，内容取自实际讲义（讲什么、共多少讲）。不写口号，不用营销形容词、排比句和 emoji。`description` 里可以写 `{lectures}`，构建时替换为讲数；其它 `{x}` 一律不允许。
3. 留空规则（一行）：`name` 必填（缺了 `doctor` 与 `check:content` 报错、生产构建失败）；`shortName` 空则用 `name`；`navText`、`tagline` 空则首页不显示；`description` 空则用 `tagline`，都空则不写 meta 描述。英文字段留空不会回落到中文。
4. 写入前把拟定的文案给用户确认，或请用户在本机 Dashboard「站点文案」页（`npm run dev` 后打开 `/dashboard`）填写；输入框里灰色的是示例提示，不是值。

文案文件的路径只在 `site/docs/.vitepress/content/paths.mts` 一处定义（`site-texts.mts` 从那里取）。

## 8. 内容目录与开发服务器

- 内容根：环境变量 `LECTURE_CONTENT_DIR` > 仓库根 `content/`（有 `site.config.ts` 或 `groups.ts` 才算）> 原位模式。`npm run init` 用 `templates/content/` 生成内容目录。
- `npm run dev` 在内容模式下自动起单向监视（`content:watch`），内容目录的改动随时同步到 `site/docs/`，不用另开终端。`LECTURE_CONTENT_WATCH=0` 关掉；仍可单独跑 `npm run content:watch`。
- `check:content` 的附加规则（例如每讲必须有的标题）写在内容目录的 `check.config.json`，规则见 `docs/authoring/lecture-contract.md`。
