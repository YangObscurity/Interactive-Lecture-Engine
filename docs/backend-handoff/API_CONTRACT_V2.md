# V2 后端接口契约 v2（Backend M4：AI 伴读、考点清单、大模型代理与管理总览）

本文件在 [`API_CONTRACT.md`](./API_CONTRACT.md)（v1：健康检查、身份会话、学习进度 `/api/db/progress*`）的基础上，定义 **Backend M4 (`backend-v2`)** 新增或扩展的全部 HTTP 接口与数据库迁移契约。v1 已约定的全部端点、错误码与测试不得破坏。

---

## 0. 通用规则（继承并补充 v1 §0）

1. **基础响应头**：每个 HTTP 响应（含 4xx/5xx 错误及流式响应首包）必须带有效 `Date`；所有只读 `GET`/`HEAD` 带 `Cache-Control: no-store`；SSE 流带 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`。
2. **认证与权限分层**：
   - 公开：`GET /api/health`、`GET /api/auth/session`（405 on other methods）；
   - 用户态（`requireUser`，`effectiveUserId == null` 返回 `401 {"error":"unauthenticated"}`）：`/api/progress/*`、`/api/db/*`、`/api/notion/*`、`/api/ai/*`；
   - 管理员态（`requireAdmin`，未登录 `401 {"error":"unauthenticated"}`，已登录但 `session.roles` 不含 `'admin'` 返回 `403 {"error":"forbidden"}`）：`/api/admin/*`。
   - `AUTH_ADAPTER=none` 下没有"无头"状态：每个请求都是已认证身份 `anonymous`（`session.authenticated=false`，角色只有 `reader`）。因此用户态路由对它放行，`/api/admin/*` 回 `403`（不是 `401`）；`/api/ai/*` 在 `AI_PROVIDER` 不是 `off` 时回 `403 {"error":"forbidden","message":"ai_requires_authentication"}`，除非显式设置 `AI_ALLOW_ANONYMOUS=true`（所有访客共用一个身份，无法按人限流）。
6. **限流（每有效用户 ID，进程内存，单进程；重启清零，多进程需改共享存储）**：
   - `/api/ai/chat`、`/api/ai/upload`：令牌桶 `AI_RATE_PER_MINUTE`（默认 20/分钟，突发等于该值）、每 UTC 日 `AI_DAILY_LIMIT`（默认 300）；`/api/ai/chat` 同时打开的流不超过 `AI_MAX_CONCURRENT`（默认 2），上传每用户同时只允许 1 个；
   - 写请求（`/api/db/*`、`/api/progress/*` 的 POST/PATCH/PUT/DELETE）：`WRITE_RATE_PER_MINUTE`（默认 120/分钟）；`AUTH_ADAPTER=none` 下所有人共用 `anonymous`，此项不生效；
   - 超限一律 `429`，带 `Retry-After`（秒）与 `{"error":"rate_limited","limit":"rate|daily|concurrency|upload_concurrency|write_rate","retry_after":N}`。
7. **列表分页**：`GET /api/db/sessions`、`/api/db/messages`、`/api/db/review-checklists` 接受 `?limit=`（1..1000，默认 200）与 `?offset=`（>= 0，默认 0），排序不变；非法值回 `400 {"error":"invalid_request"}`。`/api/db/progress` 不分页（行数以讲次数为上限）。
3. **请求体体积上限**：
   - 全站 JSON / API 路由继续限制 **256 KB**（`262144` 字节），超限返回 `413 {"error":"payload_too_large"}` 并附 `Connection: close`；
   - 例外：`POST /api/ai/upload`（`multipart/form-data` 课件上传）使用配置项 `AI_UPLOAD_MAX_BYTES`（默认 `20971520` = 20 MB），超限同样返回 `413 {"error":"payload_too_large"}` 并附 `Connection: close`。
4. **`lecture_id` 与 `group_id` 规则**：
   - `/api/db/progress*` 保持 v1 严格正则 `/^[a-z0-9][a-z0-9_-]*-l\d{2,}$/` 不变；
   - `/api/db/sessions` 与 `/api/db/review-checklists` 接受上述讲次正则 **或** 字面值 `'global'`（全站首页 / 非讲义页 AI 伴读上下文），统一按 `trim().toLowerCase()` 归一化；缺失 `group_id` 时，`'global'` 推导为 `'global'`，`<group>-lxx` 推导为 `<group>`；格式不合法返回 `400 {"error":"invalid_lecture_id"}`。
5. **多租户隔离与保密**：
   - 所有 `/api/db/sessions`、`/api/db/messages`、`/api/db/review-checklists` 行均按 `effectiveUserId` 隔离；A 用户永不可读、改、删 B 用户的记录（访问 B 拥有的 ID 返回 `404 {"error":"not_found"}`）；
   - 错误响应、`/api/health`、`/api/admin/health`、`setup`、日志严禁回显请求体敏感字段、数据库连接串、主机名或 AI API Key。

---

## 1. 数据库迁移：`0002_ai_checklists.sql`（Forward-only）

同时兼容 PostgreSQL 14+（Neon）与 PGlite（`0.5.x`），严禁 `DROP` 语句：

1. **`ai_sessions`**：
   - `user_id text NOT NULL`
   - `id text NOT NULL`
   - `lecture_id text NOT NULL`
   - `group_id text NOT NULL`
   - `title text NOT NULL DEFAULT '新会话'`
   - `is_archived boolean NOT NULL DEFAULT false`
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - `PRIMARY KEY (user_id, id)`
   - 索引：`idx_ai_sessions_user_lecture_updated ON ai_sessions (user_id, lecture_id, updated_at DESC)`
2. **`ai_messages`**：
   - `user_id text NOT NULL`
   - `id text NOT NULL`
   - `session_id text NOT NULL`
   - `role text NOT NULL CHECK (role IN ('user', 'assistant', 'system'))`
   - `content text NOT NULL`
   - `selected_context text NULL`
   - `model text NOT NULL DEFAULT ''`
   - `prompt_tokens integer NOT NULL DEFAULT 0`
   - `completion_tokens integer NOT NULL DEFAULT 0`
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `PRIMARY KEY (user_id, id)`
   - 外键：`FOREIGN KEY (user_id, session_id) REFERENCES ai_sessions (user_id, id) ON DELETE CASCADE`
   - 索引：`idx_ai_messages_user_session_created ON ai_messages (user_id, session_id, created_at ASC)`
3. **`ai_review_checklists`**：
   - `user_id text NOT NULL`
   - `id text NOT NULL`
   - `lecture_id text NOT NULL`
   - `group_id text NOT NULL`
   - `topic_title text NOT NULL`
   - `section_anchor text NULL`
   - `is_completed boolean NOT NULL DEFAULT false`
   - `pptx_source text NULL`
   - `priority integer NOT NULL DEFAULT 1`
   - `created_at timestamptz NOT NULL DEFAULT now()`
   - `updated_at timestamptz NOT NULL DEFAULT now()`
   - `PRIMARY KEY (user_id, id)`
   - 索引：`idx_ai_checklists_user_lecture ON ai_review_checklists (user_id, lecture_id, priority DESC, created_at ASC)`

所有返回给客户端的行对象**均不返回** `user_id`；时间戳一律以 ISO-8601 UTC 字符串序列化。

---

## 2. 会话历史接口：`/api/db/sessions`

| 方法与路径 | 查询/请求体 | 成功响应 | 说明 |
|---|---|---|---|
| `GET /api/db/sessions` | 可选 `?lecture_id=`、`?group_id=`、`?archived=true\|false` | `200` `AiSession[]` | 按 `updated_at DESC, created_at DESC, id ASC` 排序；`lecture_id` 非法回 `400 invalid_lecture_id`；`Cache-Control: no-store` |
| `GET /api/db/sessions/:id` | - | `200` `AiSession` 或 `404 {"error":"not_found"}` | 仅返回当前用户所属会话 |
| `POST /api/db/sessions` | `{ id?, lecture_id, group_id?, title?, is_archived? }` | `201` `AiSession` | `id` 缺省由服务端 `randomUUID()` 生成；按 `(user_id, id)` 幂等 upsert；时间戳用服务端时钟 |
| `PATCH /api/db/sessions/:id` | `{ title?, is_archived? }` | `200` `AiSession` 或 `404` | 服务端更新 `updated_at = now()`（忽略客户端时间） |
| `DELETE /api/db/sessions/:id` | - | `204` 空体 | 级联删除所属 `ai_messages`；对不存在 ID 返回 `204`（幂等删除） |
| `DELETE /api/db/sessions?lecture_id=` | 必填 `lecture_id` | `204` 空体 | 删除当前用户该讲全部会话并级联删消息；缺 `lecture_id` 回 `400 {"error":"invalid_request"}` |

---

## 3. 消息明细接口：`/api/db/messages`

| 方法与路径 | 查询/请求体 | 成功响应 | 说明 |
|---|---|---|---|
| `GET /api/db/messages` | 可选 `?session_id=` | `200` `AiMessage[]` | 按 `created_at ASC, id ASC` 排序；不存在或已删的 `session_id` 返回 `200 []` |
| `POST /api/db/messages` | `{ id?, session_id, role, content, selected_context?, model?, prompt_tokens?, completion_tokens? }` | `201` `AiMessage` | 校验 `session_id` 属于当前用户（否则 `404 {"error":"not_found"}`）、`role` 为 `user\|assistant\|system`（否则 `400 invalid_request`）、token 字段为非负整数；同事务内递增刷新 `ai_sessions.updated_at = now()` |
| `PATCH /api/db/messages/:id` | `{ content?, completion_tokens?, prompt_tokens?, model?, selected_context? }` | `200` `AiMessage` 或 `404` | 校验字段类型后局部更新 |
| `DELETE /api/db/messages/:id` | - | `204` 空体 | 仅删当前用户消息 |
| `DELETE /api/db/messages?session_id=` | 必填 `session_id` | `204` 空体 | 清空当前用户该会话下全部消息；缺 `session_id` 回 `400 {"error":"invalid_request"}` |

---

## 4. 考点复习清单接口：`/api/db/review-checklists`（兼别名 `/api/db/checklist`）

| 方法与路径 | 查询/请求体 | 成功响应 | 说明 |
|---|---|---|---|
| `GET /api/db/review-checklists` | 可选 `?lecture_id=`、`?group_id=` | `200` `AiReviewChecklist[]` | 按 `priority DESC, created_at ASC, id ASC` 排序 |
| `POST /api/db/review-checklists` | `{ items: CreateChecklistItem[] }`（1–200 项）或单对象 | `201` `AiReviewChecklist[]` | 单事务原子校验并 upsert；超 200 项回 `400 {"error":"too_many_items"}`，空数组回 `400 {"error":"invalid_request"}`，任一项 `lecture_id` 非法或缺 `topic_title` 整批回滚 `400`；始终返回数组与前端及 mock 对齐 |
| `PATCH /api/db/review-checklists/:id` | `{ is_completed?, topic_title?, section_anchor?, priority?, pptx_source? }` | `200` `AiReviewChecklist` 或 `404` | 服务端更新 `updated_at = now()` |
| `DELETE /api/db/review-checklists/:id` | - | `204` 空体 | 仅删当前用户清单项 |

---

## 5. AI 伴读代理与配置：`/api/ai/chat`、`/api/ai/upload`

### 5.1 新增环境变量（均纳入 `server/src/config/schema.ts` 与 `.env.example`）

| 变量名 | 类型 / 允许值 | 默认值 | `secret` | 说明 |
|---|---|---|---|---|
| `AI_PROVIDER` | enum `off \| dify \| openai` | `off` | 否 | `off` 时维持 v1 行为：`checks.ai="off"`，`/api/ai/*` 返回 `503 {"error":"ai_not_configured"}` |
| `DIFY_API_BASE` | http/https URL | `https://api.dify.ai/v1` | 否 | Dify 服务根路径 |
| `DIFY_API_KEY` | string | `unset` | **是** | `AI_PROVIDER=dify` 时必填 |
| `OPENAI_API_BASE` | http/https URL | `https://api.openai.com/v1` | 否 | OpenAI 兼容服务 `/v1` 根路径 |
| `OPENAI_API_KEY` | string | `unset` | **是** | `AI_PROVIDER=openai` 时必填 |
| `OPENAI_MODEL` | string | `gpt-4o-mini` | 否 | OpenAI 模型 ID |
| `AI_UPSTREAM_TIMEOUT_MS` | int `1000..300000` | `60000` | 否 | 上游连接 + 首字节超时毫秒（首字节到达即清除，之后只受 `AI_STREAM_MAX_MS` 约束） |
| `AI_UPLOAD_MAX_BYTES` | int `1024..104857600` | `20971520` | 否 | `/api/ai/upload` 允许最大字节（默认 20 MB） |
| `AI_ALLOW_ANONYMOUS` | boolean | `false` | 否 | `AUTH_ADAPTER=none` 时是否仍开放 `/api/ai/*` |
| `AI_RATE_PER_MINUTE` | int `1..600` | `20` | 否 | 每用户每分钟 AI 请求数（令牌桶） |
| `AI_MAX_CONCURRENT` | int `1..20` | `2` | 否 | 每用户同时进行的 chat 流上限 |
| `AI_DAILY_LIMIT` | int `1..100000` | `300` | 否 | 每用户每 UTC 日 AI 请求数 |
| `AI_QUERY_MAX_BYTES` | int `256..65536` | `8192` | 否 | `query` 最大 UTF-8 字节数，超限 `413` |
| `AI_INPUTS_MAX_BYTES` | int `1024..131072` | `32768` | 否 | `inputs` 各值合计最大字节数，超限 `413` |
| `AI_STREAM_MAX_MS` | int `10000..1800000` | `300000` | 否 | 单次流的总时长上限 |
| `AI_ACCESS_LOG` | boolean | `true` | 否 | 每次 AI 调用一行结构化访问日志 |
| `AI_PROMPTS_FILE` | path | `unset` | 否 | 站点导出的 `companion.json` 路径；留空按 `./prompts/companion.json` → `../site/prompts/companion.json` → 站点构建产物顺序解析 |
| `WRITE_RATE_PER_MINUTE` | int `1..6000` | `120` | 否 | 每用户每分钟写请求数（`ops` 组） |

### 5.2 接口行为

1. **`POST /api/ai/chat`**：
   - `AI_PROVIDER=off` → `503 {"error":"ai_not_configured"}`。
   - **提示词与指令装配（WP-F7，方案 B 服务端权威）**：服务端加载与前端同源的 `companion.json`（含 `version`、`system.{zh,en}`、`actions[]`）。客户端不再、也不能下发自定义 `system` 提示词或指令模板（任意未列在白名单的指令字段一律丢弃）。
   - 请求 JSON 校验（白名单，其余字段忽略）：
     - `action` 可选，命中 `companion.json` 中已定义动作 `id`（未知动作回 `400 {"error":"invalid_request","message":"unknown_action"}`）；`enabled: false` 的动作同样视为未知动作；当该动作 `needsSelection` 为 `true` 且 `inputs.selection` 为空或仅为占位词（`无` / `None`）时回 `400 {"error":"invalid_request","message":"selection_required"}`；`inputs.selection` 超过 16384 字节回 `413 {"error":"payload_too_large","message":"selection_too_long"}`（总 `inputs` 仍受 `AI_INPUTS_MAX_BYTES` 限制）；
     - `lang` 可选（`zh` | `en`，默认 `zh`；其他取值或非字符串回 `400 {"error":"invalid_request","message":"invalid_lang"}`），决定服务端使用对应语言版本的系统提示词与动作模板；
     - `query`：未传 `action` 时必填非空字符串，传 `action` 时可为空串（作追加补充提问），UTF-8 不超过 `AI_QUERY_MAX_BYTES`（超限 `413 {"error":"payload_too_large","message":"query_too_long"}`）；
     - `inputs` 可选，只保留 `current_lecture`、`group`、`outline`、`selection` 四个键，值必须是字符串（否则 `400`，`message` 为 `inputs_<key>_must_be_string`），合计不超过 `AI_INPUTS_MAX_BYTES`（超限 `413`，`message: inputs_too_long`），其他键丢弃；
     - `files` 可选，最多 5 项，每项只能是 `{ "type", "transfer_method": "local_file", "upload_file_id" }`，`upload_file_id` 必须是本服务早先返回给**同一用户**的上传 ID（否则 `400`，`message: unknown_file` / `files_invalid`）；不接受 `remote_url`；
     - `conversation_id` 可选，只有本服务在该用户的流里见过（Dify 帧里的 `conversation_id`，或 OpenAI 路径自己生成的）才会转发，否则开启新会话，新 ID 随流返回，客户端应采用。该跟踪在进程内存里，重启后丢失（等同于开启新会话）；
     - `response_mode` 忽略（恒为 streaming）。
     服务端**强制用 `effectiveUserId` 覆盖 `user` 字段**（不信任客户端提交的 `user`），也不转发客户端 `Authorization` 到上游。
   - **Dify 模式**：请求 `${DIFY_API_BASE}/chat-messages`（`response_mode: "streaming"`），携带 `Authorization: Bearer ${DIFY_API_KEY}`，保留 4 键 `inputs` 白名单，并将 `[Site Instructions v<version>]` 与（若传 `action`）展开后的动作模板前置拼入上游 `query`（再接 `[User Request]`）；透传标准 SSE 流（`agent_thought` / `agent_message` / `message` / `message_end` / `error`），并在客户端断连时通过 `AbortController` 立即取消上游请求。限制：Dify 控制台中的系统提示词应保持留空或中性以免冲突，且前置指令会占用 Dify 侧 `query` 长度配额。
   - **OpenAI 模式**：请求 `${OPENAI_API_BASE}/chat/completions`（`stream: true`），按与浏览器 BYOK 完全一致的装配顺序拼装 `messages`（`system` = 站点系统提示词 + 4 项上下文块；`user` = 展开后的 `action` 模板与可选补充问题），将 OpenAI `choices[0].delta.content` 转换为前端 `useDifyChat` 消费的 `data: {"event":"agent_message","answer":...}\n\n` 与终帧 `data: {"event":"message_end","metadata":{"usage":{...}}}\n\n`。
   - **流开始之前**（上游连接失败、非 2xx、首字节超时 `AI_UPSTREAM_TIMEOUT_MS`）：返回 `502 {"error":"ai_upstream_error"}`（绝不泄露 Key 或上游内部地址）。服务端先读到第一个上游数据块才向客户端发 `200`，所以这些失败仍是普通 HTTP 错误。
   - **流开始之后**（上游中途断开、读出错、总时长超过 `AI_STREAM_MAX_MS`）：写**恰好一个** `error` 事件帧再关闭流，Dify 透传与 OpenAI 转换两条路径相同；客户端自己断开则不写：

     ```
     event: error
     data: {"event":"error","code":"upstream_error","message":"The AI service stopped unexpectedly."}

     ```

     `code` 取值：`upstream_error`（上游断开或出错）、`stream_timeout`（总时长到限）、`upstream_timeout`（保留）。`message` 是固定的通用英文句子，不含上游细节。若上一个已转发的字节不在帧边界上，错误帧前补一个空行，避免半帧吞掉它。前端把它当作终止事件处理（F2 消费，`sseParser` 已把 `event: error` 视为错误）。Dify 自己发的 `event: error` 帧原样透传。
2. **`POST /api/ai/upload`**：
   - `multipart/form-data`，字段 `file`；校验扩展名与内容签名（魔数）一致（不一致 `400 {"error":"invalid_file_type"}`，`message: file_content_mismatch`）及非空（空文件 `400 {"error":"invalid_request"}`）。允许的类型：`.pdf`（`%PDF`）、`.png`、`.jpg/.jpeg`、`.gif`、`.webp`（RIFF…WEBP）、`.pptx/.docx/.xlsx`（zip `PK`）、`.ppt/.doc/.xls`（OLE `D0 CF 11 E0`）、`.txt/.md/.markdown`（合法 UTF-8 且无 NUL，检查前 8 KB）。每用户同时只能有 1 个上传（第二个 `429`，`limit: upload_concurrency`）。请求体在内存中整包缓冲（上限 `AI_UPLOAD_MAX_BYTES`），不是流式转发，因为要先看文件头；`AI_PROVIDER=off` 回 `503 {"error":"ai_not_configured"}`；`AI_PROVIDER=openai` 回 `501 {"error":"upload_unsupported_for_provider"}`。
   - `AI_PROVIDER=dify`：重打包 `FormData` 写入 `file` 与 `user = effectiveUserId` 转发 `${DIFY_API_BASE}/files/upload`，返回 `{ id, name, size, extension, mime_type, created_at }`，并记下该 `id` 属于当前用户（供 chat 的 `files` 校验）。

---

## 6. 管理员总览与深度诊断：`/api/admin/*`

全部挂在 `requireAdmin` 之后（匿名/非 `none` 无头 → `401`；无 `'admin'` 角色 → `403`；均带 `Cache-Control: no-store`）：

1. **`GET /api/admin/overview`**：
   - 从数据库实时聚合只读统计（禁止返回任何聊天原文、邮箱或凭证）：
     ```json
     {
       "generatedAt": "ISO-8601 UTC",
       "totals": {
         "users": 12,
         "progressRows": 420,
         "completedLectures": 180,
         "sessions": 35,
         "messages": 210,
         "checklistItems": 48,
         "completedChecklistItems": 19
       },
       "byStatus": { "未开始": 140, "学习中": 100, "已完成": 180 },
       "byGroup": [
         { "group_id": "g01", "total_rows": 60, "completed": 30, "in_progress": 10, "not_started": 20 }
       ],
       "recentActivity": {
         "progressUpdatedLast24h": 14,
         "sessionsCreatedLast24h": 3,
         "messagesCreatedLast24h": 18
       }
     }
     ```
2. **`GET /api/admin/health`**：
   - 返回详细运行时体检（严禁含主机名、端口、连接串、密钥）：
     ```json
     {
       "ok": true,
       "service": "lecture-api",
       "version": "2026.11.18",
       "time": "ISO-8601 UTC",
       "uptimeSeconds": 123,
       "checks": {
         "db": { "status": "ok", "latencyMs": 1.2, "migrations": { "appliedCount": 2, "pendingCount": 0, "latestApplied": "0002_ai_checklists" } },
         "ai": { "provider": "off", "configured": false, "status": "off", "lastCall": null },
         "notion": { "configured": false, "status": "off" }
       },
       "runtime": {
         "nodeVersion": "v22.x",
         "authAdapter": "trusted-header",
         "headerPreset": "authelia",
         "dbKind": "postgres"
       }
     }
     ```

---

### 6.1 公开 `GET /api/health`（D-12）

- 数据库与 Notion 探测结果缓存约 10 秒（并发请求共用一次探测），端点不会被用来放大对数据库或 `NOTION_HEALTH_URL` 的探测。
- `checks.ai`：`off` = 未配置；否则 `ok`，若**最近一次真实代理调用**失败则 `degraded`。不会为健康检查去探测上游。至少发生过一次调用后，响应多一个顶层字段 `aiLastCall: { ok, at, status? }`（`at` 为 ISO-8601 UTC）。`/api/admin/health` 的 `checks.ai` 同样有 `status`（`off|ok|degraded`）与 `lastCall`（未发生调用时为 `null`）。
- `GET /api/health` 与 admin health 的 `version` 来自 `server/package.json`（唯一来源）。

### 6.2 AI 访问日志

`AI_ACCESS_LOG=true`（默认）时，每次 `/api/ai/*` 调用写一行 JSON 到 stdout：`{"evt":"ai_call","ts","user","route","provider","status","outcome","prompt_version","bytes_in","bytes_out","ms","limit"}`。`user` 是用户 ID 的 SHA-256 前 16 位十六进制；`prompt_version` 为本次调用加载的 `companion.json` 版本号（非 chat 路由或未加载时为 `null`）；`limit` 是命中的限制（`rate|daily|concurrency|upload_concurrency`）或 `null`；`outcome` 如 `ok`、`rejected`、`upstream_timeout`、`stream_timeout`、`upstream_error`、`client_abort`。**从不记录提示词、回答、文件名、密钥。** 流式调用在流结束时写日志。

### 6.3 消息写入（D-13）

`POST /api/db/messages` 同一 `id`、相同 `session_id`/`role`/`content` 重放是幂等的：返回已存的那一行，状态 `200`（首次为 `201`）；同一 `id` 但内容不同回 `409 {"error":"id_conflict"}`。`prompt_tokens`/`completion_tokens` 上限 2147483647（超出 `400`）。数据库故障回 `500 {"error":"internal_error"}`，不再伪装成 `400`。

## 7. `db:reassign` 与独立契约测试补充

- `npm run db:reassign -- --from <old> --to <new> --yes` 须在**同一事务**内一并平移 `ai_sessions`、`ai_messages`、`ai_review_checklists`（先建/并目标会话避免外键冲突，再搬消息与清单，同 `id` 冲突按最新 `updated_at` 胜出或保留目标），预览模式（无 `--yes`）一并报告这些表的待迁移数量且不写库。
- `server/tests/contract/` 须实现**自包含**契约校验（不强依赖 `../site/docs/.vitepress/site.config.mts` 在独立后端部署下存在），使 `cd server && npm run test:contract` 在独立部署包中亦可直接通过（修复 黑盒测试发现的 `DEF-01`）。

## 8. 变更记录

- 2026-11-21 WP-F7：站点托管提示词与快捷动作真源（`AI_PROMPTS_FILE` / `companion.json`）、`/api/ai/chat` 支持 `action` 与 `lang` 装配、Dify `query` 前置指令块与 OpenAI/BYOK 等价消息装配、访问日志新增 `prompt_version`。
- 2026-11-21 WP-B1：每用户限流与并发上限、AI 输入白名单与长度上限、`none` 模式默认关闭 AI、SSE `error` 事件、上传魔数校验与 20 MB 上限、健康检查缓存与 AI 状态、消息写入幂等、列表分页。
- 2026-11-19 v2 起草（Backend M4 / P6 / P6.5 对接契约，继承并兼容 `API_CONTRACT.md` v1）。
