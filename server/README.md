# lecture-api 服务说明与部署指南

`lecture-api` 是本课程网站的独立后端 HTTP 服务（基于 Node.js 20+ 与 TypeScript，采用 Hono 框架构建），负责管理学生的学习进度、用户会话身份以及服务健康状态。

---

## 目录
1. [服务定位与特性](#1-服务定位与特性)
2. [数据库选择与连接串配置（Neon）](#2-数据库选择与连接串配置neon)
3. [快速开始与环境配置向导](#3-快速开始与环境配置向导)
4. [数据库初始化与迁移管理](#4-数据库初始化与迁移管理)
5. [编译与启动运行](#5-编译与启动运行)
6. [前置认证与反向代理安全前置条件](#6-前置认证与反向代理安全前置条件)
7. [历史数据平移工具（db:reassign）](#7-历史数据平移工具dbreassign)
8. [完整配置项参考表](#8-完整配置项参考表)
9. [自动化测试与质量校验](#9-自动化测试与质量校验)
10. [常见问题排查](#10-常见问题排查)

---

## 1. 服务定位与特性

- **学习进度 API** (`/api/db/progress*` 与别名 `/api/progress*`)：支持单讲进度查询与更新、全量进度拉取、多讲原子批量提交（最多 200 项）、24 小时幂等性重放去重以及基于服务端时钟的跨设备冲突裁决。
- **AI 伴读问答与会话 API** (`/api/db/sessions`, `/api/db/messages`)：支持多端对话会话与消息持久化、按讲次（`lecture_id`）与分组（`group_id`）归档、新建消息自动更新会话更新时间（`updated_at`）、单会话级联清理以及多用户严格数据隔离。
- **考点复习清单 API** (`/api/db/review-checklists` 与别名 `/api/db/checklist`)：支持单项与批量（1–200 项原子提交）考点生成、按优先级与创建时间排序、标记完成状态与删除。
- **AI 伴读流式代理 API** (`/api/ai/chat`, `/api/ai/upload`)：
  - `/api/ai/chat`：流式 SSE 反向代理。抹除客户端传入的 Authorization 请求头，强制覆写 `user` 字段为经过认证的用户 ID；`inputs`/`files`/`conversation_id` 按白名单与归属校验；原生支持 Dify SSE 流直通以及 OpenAI SSE 流转换（映射为 `agent_message` 与 `message_end` 事件）；客户端断开时主动取消上游请求；流开始前的上游失败统一返回 `502`，流开始后的失败写一个 `event: error` 帧（见契约 §5.2）。
  - `/api/ai/upload`：课件与图片（PDF、Office、PNG/JPEG/GIF/WEBP、纯文本）按内容签名校验后转发至 Dify。受 `AI_UPLOAD_MAX_BYTES`（默认 20 MB）限制；**请求体在内存中整包缓冲**（`formData()`），不是流式转发，因为要先读文件头做魔数校验；缓冲的风险由 20 MB 上限与每用户 1 个并发上传限制。
  - **每用户限流**（进程内存，重启清零）：AI 每分钟、每日、并发流；写请求每分钟。`AUTH_ADAPTER=none` 时 AI 路由默认关闭（`AI_ALLOW_ANONYMOUS=true` 才开放）。每次 AI 调用一行结构化访问日志（哈希用户 ID，不含提示词与密钥）。
- **身份认证与账户自助 API** (`/api/auth/*`, `/api/me/*`)：支持 `none`、`trusted-header`、`local`（邮箱密码与原生 WebAuthn Passkey，HttpOnly Cookie 会话）与 `hybrid`（网关头优先、本地会话回落）四种适配器。公开只读 `/api/auth/session` 返回当前身份摘要；`/api/auth/status`、`/api/auth/methods`、`/api/auth/bootstrap`、`/api/auth/login`、`/api/auth/logout` 与 `/api/auth/methods/passkey/login/*` 负责认证生命周期；`/api/me/*` 提供个人学习概览、JSON 导出、改密、Passkey 凭据与多端会话管理。
- **管理端与后台运维 API** (`/api/admin/*`)：按角色分层开放。`author` 与 `admin` 可访问内容概览、契约检查、图包清单、站点文案与 AI 伴读提示词（`/api/admin/overview`, `/checks`, `/figures`, `/texts`, `/companion`）；`admin` 独占系统健康检查、AI 工具开关与外部 MCP 发现、用户角色与状态管理、访问档与外观设置、运行状态与内存日志、备份快照创建与只读校验（`npm run db:backup` / `npm run db:restore`），以及在线数据库引擎探测、迁移、热切换、跨库迁移与 6 张白名单表 CRUD（`/api/admin/health`, `/ai-tools`, `/users`, `/access`, `/look`, `/runtime`, `/logs`, `/backups`, `/db`）。修改构建输入类设置后会写入 `site_settings`（挂载可写 `CONTENT_DIR` 时同步写盘），并返回非阻塞的 `rebuild_required` 提示。
- **健康检查 API** (`/api/health`)：实时探测底层 PostgreSQL 连通性、迁移状态以及可选的 Notion 同步与 AI 代理服务状态（数据库响应超 1.5 秒自动标记为 `degraded`）。
- **零额外依赖的本地开发**：除了生产级 PostgreSQL，内置支持 `@electric-sql/pglite` 内存数据库与嵌入式目录存储，开箱即用，无需安装本地 Docker 或外部数据库。

---

## 2. 数据库选择与连接串配置（Neon）

本服务推荐使用 **Neon Serverless PostgreSQL** 作为托管数据库，同时也完全兼容任何标准 PostgreSQL（14+）自建实例或云数据库。

### 2.1 为什么推荐 Neon？
- **免费额度充沛**：Neon 免费层提供 1 GB 存储空间与每月 100 算力小时（CU-hours），支持 5 分钟空闲自动休眠。
- **业务契合度高**：单用户全站学习进度约 400 行，容量需求极小；冷启动唤醒延迟仅数百毫秒，前端内置了待发重试队列，对用户无感知。
- **物理就近原则**：建议在 Neon 控制台创建项目时，区域选择 **AWS `ap-southeast-1`（新加坡）** 或距离您的生产服务器（如香港 HK）最近的可用区。

### 2.2 两个连接串的职责与差异
在 `.env` 中，本服务支持配置两个数据库连接串：

| 配置项 | 连接类型 | 典型主机名与端口 | 主要用途 |
|---|---|---|---|
| `DATABASE_URL` | 池化连接 (Pooled) | `ep-xxx-pooler.region.aws.neon.tech:5432` (或 6543) | **运行时业务查询**：走 PgBouncer 事务池模式，应对高频短连接与突发并发，防止连接数被打满。 |
| `DATABASE_URL_DIRECT` | 直连 (Direct, Session) | `ep-xxx.region.aws.neon.tech:5432` (无 `-pooler`) | **数据库建表与迁移**：直连计算节点，支持执行 Postgres 会话级建议锁。未设置时自动回落到 `DATABASE_URL`。 |

### 2.3 为什么执行迁移必须使用直连连接串（DATABASE_URL_DIRECT）？
1. **建议锁机制**：本服务的迁移执行器在执行 SQL 变更前后，会调用 `SELECT pg_advisory_lock(74208100)` 与 `SELECT pg_advisory_unlock(74208100)` 获取全局互斥建议锁，防止多实例并发启动或并发部署时发生建表竞争与账本混乱。
2. **连接池失效风险**：Neon 的池化连接（PgBouncer 事务池）在每个事务结束后会立即收回并重新分配底层物理连接。由于 PostgreSQL 建议锁是**会话级（Session-level）**绑定的，事务池可能导致加锁在一个底层连接上，而解锁命令或后续 DDL 跑在另一个底层连接上，导致建议锁失效或连接死锁。
3. **官方建议**：Neon 官方文档明确指出：所有运行 DDL、数据库迁移或使用建议锁的工具均应使用 Direct（非池化）连接。

---

## 3. 快速开始与环境配置向导

### 3.1 依赖安装
```bash
cd server
npm ci
```

### 3.2 交互式配置向导（npm run setup）
运行内置向导，根据提示逐步完成配置：
```bash
npm run setup
```
向导流程特性：
1. **密码掩码**：数据库连接串等敏感字段输入时自动无回显。
2. **连接探活**：当场执行 `SELECT version()` 校验数据库连通性，终端仅显示数据库类型与内核版本，绝不泄露凭据与主机名。
3. **初始化确认**：列出待执行的迁移文件并询问：`现在初始化数据库表吗？[y/N]`。
4. **自动迁移设定**：询问服务启动时是否允许自动执行迁移（`DB_AUTO_MIGRATE`）。
5. **安全写回与备份**：写入 `server/.env`；若已存在 `.env`，自动创建 `.env.bak-<时间戳>` 备份，并保留原有换行格式（LF/CRLF）、注释与包含 ` #` 的值。

### 3.3 非交互式命令行模式（CI/CD 与脚本专用）
```bash
# 接受默认/环境变量，并立即初始化数据库表
npm run setup -- --yes --init-db

# 接受默认/环境变量，跳过数据库表初始化
npm run setup -- --yes --no-init-db
```
*(注意：npm 命令参数前需加 `--` 分隔符)*

---

## 4. 数据库初始化与迁移管理

迁移文件位于 `server/migrations/`，所有迁移均为**向前兼容（Forward-only）**，严禁使用 `DROP` 语句。

- **查看当前迁移状态**：
  ```bash
  npm run db:status
  ```
- **执行待应用的迁移**：
  ```bash
  npm run db:migrate
  ```
- **迁移预演（Dry-run，仅打印待执行 SQL，不修改数据库）**：
  ```bash
  npm run db:migrate -- --dry-run
  ```

### 启动期自动迁移策略（DB_AUTO_MIGRATE）
- 当 `DB_AUTO_MIGRATE=false`（推荐生产默认值）：服务启动前若发现存在未应用的迁移，将**拒绝启动**并打印提示：
  ```text
  Found N pending migration(s). Refusing to start without migrations applied.
  Please run: npm run db:migrate
  ```
- 当 `DB_AUTO_MIGRATE=true`：服务启动时会自动依次应用所有待执行迁移，随后正常开启监听。

---

## 5. 编译与启动运行

### 5.1 本地开发模式
```bash
npm run dev
```
基于 `tsx watch` 运行，代码变更时自动热重载。

### 5.2 生产编译与运行
```bash
# 1. 静态编译 TypeScript 到 dist/
npm run build

# 2. 生产环境启动
npm start
```

### 5.3 无数据库环境快速体验（使用内置 PGlite）
无需配置任何外部数据库，直接使用内存或本地目录：
```bash
# 内存模式（服务停止后数据清空）
DATABASE_URL=pglite:memory DB_AUTO_MIGRATE=true npm run dev

# 本地目录持久化模式
DATABASE_URL=pglite:./data/pglite-db DB_AUTO_MIGRATE=true npm run dev
```

---

## 6. 前置认证与反向代理安全前置条件

本服务支持 `none`（匿名）、`local`（内置密码 / WebAuthn Passkey 会话 Cookie，无需前置登录网关）、`trusted-header`（仅从网关请求头读取身份）与 `hybrid`（网关请求头优先，缺失时回落本地 Cookie 会话）四种认证模式。当配置 `AUTH_ADAPTER=trusted-header` 或在 `hybrid` 模式下前置部署认证网关时，后端信任传入请求中的网关 HTTP Header（如 `Remote-User`、`Remote-Groups`），必须严格遵循以下**三大安全红线**：

1. **服务强制绑定回环地址**：
   - 生产环境中服务必须只监听 `127.0.0.1`（默认）或 `::1`，严禁将端口直接暴露给公网。
   - **安全护栏**：若 `AUTH_ADAPTER=trusted-header` 且 `HOST` 配置为非回环地址（如 `0.0.0.0`），服务启动时将强制报错退出。只有在确信上游经过合规反向代理且显式配置 `ALLOW_NON_LOOPBACK=true` 时才允许启动。
2. **反向代理覆盖身份头（防伪造核心）**：
   - Nginx 在所有转发到后端的 `location` 中，必须通过 `auth_request_set` 读取认证网关（如 Authelia / Authentik）验证后的真实身份，再用 `proxy_set_header` 写入后端。客户端直接携带的同名请求头会被强制冲刷覆盖。
3. **公开与透传接口清空身份头**：
   - 对于不走认证网关的公开接口（如 `/api/health`），或 `hybrid` 模式下直接透传给内置账号登录使用的接口，Nginx 必须显式将所有身份头设置为空串（如 `proxy_set_header Remote-User "";`），阻断非法身份注入。

参考部署模板位于 `server/deploy/nginx-locations.conf`（覆盖 `/api/db`、`/api/admin`、`/api/auth/session`、`/api/health`、`/api/ai`、`/api/tools`、`/api/mcp`、`/api/progress`、`/api/notion`、`/api/tool`，由 `tests/unit/nginx-template.test.ts` 约束）与 `server/deploy/lecture-api.service`。使用 `local` / `hybrid` 在线登录时，请同步转发 `/api/auth/` 与 `/api/me/` 并按网关策略覆盖或清空身份请求头。完整拓扑、方案 B 切换步骤与回滚见 `docs-dev/GATEWAY.md`；上线后用 `node scripts/check_header_spoof.mjs <站点URL>` 验证身份头无法伪造。

---

## 7. 历史数据平移工具（db:reassign）

### 7.1 使用场景
若站点初期以 `AUTH_ADAPTER=none`（匿名模式）上线，所有学生的学习进度、AI 伴读会话与复习清单均保存在 `user_id = 'anonymous'` 名下。当后续开启认证网关（`trusted-header`）后，站长登录会产生真实用户 ID（如 `admin`），导致初始进度为空。
此时可使用 `db:reassign` 工具将 `anonymous` 的全部数据平移至真实账户名下。支持平移的表包括：
1. `progress`（学习进度表）
2. `ai_sessions`（AI 会话表）
3. `ai_messages`（AI 对话消息表，通过外键自动随会话关联平移）
4. `ai_review_checklists`（复习考点清单表）

### 7.2 命令用法
```bash
npm run db:reassign -- --from <源用户ID> --to <目标用户ID> [--yes]
```

- **第一步：无修改预演（预览待平移项与重叠项）**：
  ```bash
  npm run db:reassign -- --from anonymous --to admin
  ```
  终端将输出预览信息（各表源行数、目标已有行数、同键重叠行数），未加 `--yes` 时拒绝修改数据库。
- **第二步：确认执行单事务平移**：
  ```bash
  npm run db:reassign -- --from anonymous --to admin --yes
  ```

### 7.3 冲突解决规则
若目标用户已存在同讲（`lecture_id`）进度或同 ID 会话/清单：
- **最新修改时间胜出（newer updated_at wins）**：若源记录的 `updated_at` 晚于目标记录，则以源记录覆盖；否则保留目标记录的原有数据。
- 平移操作在单数据库事务中原子执行，满足外键约束依赖（先平移会话后平移消息），成功后源记录将被自动清理。

---

## 8. 完整配置项参考表

配置由 `server/src/config/schema.ts` 集中定义。可通过 `npm run config:check` 验证模板与定义的一致性。

| 环境变量名 | 类型 | 默认值 | 必填 | 敏感 | 说明 |
|---|---|---|---|---|---|
| `DATABASE_URL` | string | - | 是 | 是 | 运行时数据库连接串（支持 postgres://, postgresql://, pglite:memory, pglite:<目录>） |
| `DATABASE_URL_DIRECT` | string | - | 否 | 是 | 迁移直连连接串（Neon 建议填非池化直连地址，未设时回落到 DATABASE_URL） |
| `HOST` | host | `127.0.0.1` | 否 | 否 | HTTP 监听地址（trusted-header 模式下须为回环地址） |
| `PORT` | int | `8100` | 否 | 否 | HTTP 监听端口（1–65535） |
| `AUTH_ADAPTER` | enum | `none` | 否 | 否 | 认证适配器（`none`, `trusted-header`, `local`, `hybrid`） |
| `AUTH_HEADER_PRESET`| enum | `authelia` | 否 | 否 | 网关头预设（`authelia`, `authentik`, `oauth2-proxy`, `custom`） |
| `AUTH_HEADER_USER` | string | 依预设 | 否 | 否 | 用户 ID 请求头名（custom 预设下必填） |
| `AUTH_HEADER_GROUPS`| string | 依预设 | 否 | 否 | 用户组请求头名 |
| `AUTH_HEADER_EMAIL` | string | 依预设 | 否 | 否 | 用户邮箱请求头名 |
| `AUTH_HEADER_NAME` | string | 依预设 | 否 | 否 | 用户显示名请求头名 |
| `AUTH_GROUP_SEPARATOR`| string| 依预设 | 否 | 否 | 用户组分隔符（Authelia 默认为 `,`，Authentik 默认为 `\|`） |
| `AUTH_ROLE_MAP` | string | `""` | 否 | 否 | 用户组到角色的映射规则（如 `admins:admin,staff:author`，`reader` 始终保留） |
| `LOGOUT_URL` | url | - | 否 | 否 | 认证网关登出跳转 URL |
| `AUTH_COOKIE_NAME` | string | `lec_session` | 否 | 否 | 身份凭证 Cookie 名称 |
| `AUTH_COOKIE_SECURE` | enum | `auto` | 否 | 否 | Cookie `Secure` 属性策略（`auto`, `true`, `false`） |
| `SESSION_TTL_HOURS` | int | `12` | 否 | 否 | 普通会话有效期（小时，1–8760） |
| `REMEMBER_ME_DAYS` | int | `30` | 否 | 否 | 持久会话（记住我）有效期（天，1–365） |
| `AUTH_METHODS_ENABLED` | string | `password,passkey,gateway` | 否 | 否 | 启用的认证方法列表（逗号分隔） |
| `AUTH_BOOTSTRAP_TOKEN` | string | - | 否 | 是 | 首次初始化管理员所需的一次性令牌（留空时不要求） |
| `WEBAUTHN_RP_ID` | string | `""` | 否 | 否 | WebAuthn Relying Party 域名（留空时从请求 Host 推断） |
| `WEBAUTHN_RP_NAME` | string | `Interactive Lecture Engine` | 否 | 否 | WebAuthn Relying Party 显示名称 |
| `WEBAUTHN_ORIGIN` | string | `""` | 否 | 否 | WebAuthn 期望 Origin（多个可用逗号分隔，留空时从请求推断） |
| `DB_AUTO_MIGRATE` | boolean| `false` | 否 | 否 | 启动时是否自动执行待应用的迁移 |
| `NOTION_HEALTH_URL` | url | - | 否 | 否 | Notion 伴随服务健康探测地址（如 `http://127.0.0.1:8099/health`） |
| `ALLOW_NON_LOOPBACK`| boolean| `false` | 否 | 否 | 是否允许在 trusted-header 模式下绑定非回环地址 |
| `LOG_LEVEL` | enum | `info` | 否 | 否 | 日志级别（`debug`, `info`, `warn`, `error`） |
| `AI_PROVIDER` | enum | `off` | 否 | 否 | AI 伴读服务提供商（`off`, `dify`, `openai`） |
| `DIFY_API_BASE` | url | `https://api.dify.ai/v1` | 否 | 否 | Dify API 基础 URL |
| `DIFY_API_KEY` | string | - | 是(dify) | 是 | Dify API 鉴权密钥（Bearer 格式） |
| `OPENAI_API_BASE` | url | `https://api.openai.com/v1` | 否 | 否 | OpenAI API 基础 URL |
| `OPENAI_API_KEY` | string | - | 是(openai) | 是 | OpenAI API 鉴权密钥 |
| `OPENAI_MODEL` | string | `gpt-4o-mini` | 否 | 否 | OpenAI 模型名称 |
| `AI_UPSTREAM_TIMEOUT_MS`| int | `60000` | 否 | 否 | AI 上游请求超时时间毫秒数（1000–300000） |
| `AI_UPLOAD_MAX_BYTES` | int | `20971520` | 否 | 否 | AI 上传文件大小限制字节数（1024–104857600，默认 20 MB） |
| `AI_ALLOW_ANONYMOUS` | boolean | `false` | 否 | 否 | `AUTH_ADAPTER=none` 时是否仍开放 `/api/ai/*` |
| `AI_RATE_PER_MINUTE` | int | `20` | 否 | 否 | 每用户每分钟 AI 请求数 |
| `AI_MAX_CONCURRENT` | int | `2` | 否 | 否 | 每用户并发 chat 流上限 |
| `AI_DAILY_LIMIT` | int | `300` | 否 | 否 | 每个读者每 UTC 日 AI 请求数；作者与管理员不计（每分钟速率照常） |
| `AI_QUERY_MAX_BYTES` | int | `8192` | 否 | 否 | `query` 最大字节数（超限 413） |
| `AI_INPUTS_MAX_BYTES` | int | `32768` | 否 | 否 | `inputs` 合计最大字节数（超限 413） |
| `AI_STREAM_MAX_MS` | int | `300000` | 否 | 否 | 单次流总时长上限 |
| `AI_ACCESS_LOG` | boolean | `true` | 否 | 否 | AI 调用结构化访问日志 |
| `AI_PROMPTS_FILE` | string | - | 否 | 否 | 伴读系统提示词与快捷动作 JSON 路径 |
| `SITE_DIST_DIR` | string | - | 否 | 否 | 站点构建产物目录（读取 `tools/tiers.json`、各档 `concepts.json` / `lectures.json`） |
| `AI_TOOLS_FILE` | string | - | 否 | 否 | 工具与外部 MCP 配置 `ai-tools.json` 路径（未设时优先走站点 `content/paths.mts`） |
| `AI_TOOL_TIMEOUT_MS` | int | `8000` | 否 | 否 | 单次工具调用超时毫秒数（100–120000） |
| `AI_TOOL_MAX_RESULT_BYTES` | int | `24000` | 否 | 否 | 单次工具返回结果 UTF-8 字节上限（256–1048576） |
| `AI_TOOL_MAX_STEPS` | int | `5` | 否 | 否 | `AI_PROVIDER=openai` 原生通道单轮最大工具步数（1–20） |
| `AI_MCP_TOKEN` | string | - | 否 | 是 | `/api/mcp` 无状态 MCP 端点 Bearer 鉴权令牌（留空则端点禁用） |
| `AI_MCP_TICKET_SECRET` | string | - | 否 | 是 | Dify `tool_ticket` 10 分钟访问档票据 HMAC-SHA256 签名密钥 |
| `WRITE_RATE_PER_MINUTE` | int | `120` | 否 | 否 | 每用户每分钟写请求数 |

---

## AI tools

`lecture-api` 内置 5 个只读工具（`search_concepts`、`get_concept`、`get_concept_graph`、`search_lectures`、`get_lecture_summary`），统一从 `SITE_DIST_DIR`（默认 `../site/docs/.vitepress/dist`）按文件 `mtime` 热加载构建产物 `tools/tiers.json` 及各访问档下的 `concepts.json` / `lectures.json`，并通过三条通道对外提供服务：

1. **原生对话通道（`AI_PROVIDER=openai`）**：基于 AI SDK v7 `streamText` + `@ai-sdk/openai` 运行多步工具循环，直接按读者会话（`roles` / `groups`）解析可读档位，并通过 `@ai-sdk/mcp` 加载 `ai-tools.json` 中已启用的外部 MCP 工具；流式输出保持 `agent_message` / `message_end` 兼容，并额外发射不含参数与结果正文的 `{ event: 'tool_call', name, state, ok, ms }` 进度帧。
2. **Dify MCP 通道（`/api/mcp`）**：基于 `@modelcontextprotocol/server` + `@modelcontextprotocol/hono` 提供无状态端点（兼容 2025-11-25 `initialize` 握手与 2026-07-28 客户端）。使用常量时间比较校验 `Authorization: Bearer <AI_MCP_TOKEN>`（未配置时返回 `503 mcp_not_configured`）。每次 Dify 对话请求自动剥离客户端伪造的 `inputs.tool_ticket`，并签发 10 分钟有效期 HMAC 票据（`{ tiers, uh, exp }`）；票据缺失、过期或签名无效时一律降级为 `public` 档；全站需登录的站点没有 `public` 档，此时工具什么也读不到。工具数据文件（`tools/*.json`、`_access/<tier>/tools/*.json`）只由 lecture-api 从磁盘读取，nginx 模板对浏览器返回 404。
3. **浏览器自带密钥只读镜像（`POST /api/tools/:name`）**：走网关可信身份头与会话鉴权、按会话解析档位并按用户限流；未知工具返回 `404`，Zod 参数校验失败返回不含堆栈的 `400` 摘要。

- **配置文件（`ai-tools.json`）**：单仓下优先通过 `site/docs/.vitepress/content/paths.mts` 解析路径，也可由 `AI_TOOLS_FILE` 显式指定；参考模板见 [`site/ai-tools.example.json`](../site/ai-tools.example.json)。外部 MCP 服务器与每个工具均默认关闭，认证请求头的值通过 `headerEnv` 指向环境变量名，绝不将密钥写入配置或 `GET /api/admin/ai-tools` 状态返回（只暴露主机名、连接状态、已发现工具与进程内存中的 7 日计数）。
- **安全与审计约束**：工具结果按档严格隔离（跨档的 `links`、`backlinks`、`related`、`lectures` 均会被过滤）；每次调用记录一行 `ai_tool_call` 结构化日志（工具名、通道、耗时、成败、字节数、用户哈希），不记录查询参数与返回内容。

---

## 9. 自动化测试与质量校验

黑盒测试员或开发者可在代码修改后运行完整的测试验证套件：

```bash
# 运行全部单元测试与集成测试
npm test

# 运行代码覆盖率报告（要求 server/src/ 行覆盖率 >= 85%）
npm run test:coverage

# 运行黑盒契约测试（独立运行，不依赖前端 site/ 源码，自动拉起测试服务）
npm run test:contract

# 对外部正在运行的服务运行黑盒契约测试（支持端口与主机自定义）
CONTRACT_BASE_URL=http://127.0.0.1:8100 npm run test:contract

# 静态类型检查与代码规范检查
npm run typecheck
npm run lint

# 校验 .env.example 是否与 schema.ts 同步
npm run config:check
```

### 契约测试独立性与环境说明
1. **完全解耦前端**：契约测试已将测试契约与断言工具内聚于 `server/tests/contract/`，即使完全剥离 `site/` 目录，也可独立运行并通过全部测试。
2. **支持运行期端口与主机覆盖**：通过 `PORT=8200 HOST=127.0.0.1 node dist/index.js` 可灵活指定监听地址与端口。
3. **PGlite 建议锁提示说明**：在 PGlite 数据库引擎下运行时，控制台将输出：
   ```text
   Skipping pg_advisory_lock on PGlite (single-process WASM engine serialized via local mutex).
   ```
   这是正常预期表现，因为 PGlite 为单进程内存/本地嵌入式引擎，所有并发事务已通过内部内存互斥锁严格串行化，安全跳过 Postgres 全局建议锁命令。

---

## 10. 常见问题排查

1. **服务启动报错：`Pending migrations exist... Please run: npm run db:migrate`**
   - 原因：数据库中有未应用的迁移，且未开启自动迁移。
   - 解决：执行 `npm run db:migrate`，或者在 `.env` 中设置 `DB_AUTO_MIGRATE=true`。
2. **服务启动报错：`AUTH_ADAPTER=trusted-header 模式下禁止绑定非回环地址`**
   - 原因：配置了 `AUTH_ADAPTER=trusted-header`，但 `HOST` 填写了公网 IP 或 `0.0.0.0`。
   - 解决：将 `HOST` 改为 `127.0.0.1`。如确在隔离容器中由网关反向代理，可设置 `ALLOW_NON_LOOPBACK=true`。
3. **数据库迁移执行卡住或报错建议锁失败**
   - 原因：`DATABASE_URL_DIRECT` 未配置且 `DATABASE_URL` 走的是 PgBouncer 事务池。
   - 解决：在 Neon 控制台获取未带 `-pooler` 的直接连接串，配置到 `DATABASE_URL_DIRECT`。
4. **服务启动报错：配置校验失败 `DIFY_API_KEY: 当 AI_PROVIDER=dify 时必须提供 DIFY_API_KEY`**
   - 原因：设置了 `AI_PROVIDER=dify` 但未提供密钥。
   - 解决：在 `.env` 中设置有效的 `DIFY_API_KEY`，或者将 `AI_PROVIDER` 设为 `off`。
5. **课件文件上传失败返回 413 `payload_too_large`**
   - 原因：上传的文件大小超出了 `AI_UPLOAD_MAX_BYTES`（默认 20 MB）上限。
   - 解决：在 `.env` 中增大 `AI_UPLOAD_MAX_BYTES` 设置（最大可设为 104857600 即 100 MB）。
