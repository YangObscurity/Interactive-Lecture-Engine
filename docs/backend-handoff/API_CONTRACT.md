# 后端接口契约 v1（进度、身份、健康检查）

> 状态：v1，2026-11-18 随 V2 P3 起草。前端实现在 `site/docs/.vitepress/theme/{api,progress,auth}/`，本地 mock 在 `site/docs/.vitepress/plugins/apiModePlugin.mjs`。
> 范围：V2 前端在 P3 用到的接口。伴读（`/api/ai/*`）、会话与消息（`/api/db/sessions|messages`）、复习清单留给 P6；管理接口 `/api/admin/*` 留给 P6.5。
> 本文是**规范**：前端只依赖这里写的行为；第 5 节列出现有后端与本文的差距。

## 0. 通用约定

- 全部接口同源，挂在 `/api/` 下；请求与响应都是 `application/json; charset=utf-8`。
- 时间一律 ISO 8601 UTC，带毫秒：`2026-11-18T08:30:00.000Z`。
- **每个响应都带 `Date` 头**（HTTP 标准头）。前端用它估算客户端与服务端的时钟偏差（第 2.5 节）。
- 错误响应体：`{ "error": "<机器可读代码>", "message": "<可选，给人看>" }`。不得在错误体里回显请求体、令牌或请求头。
- **重试语义**：前端对网络错误、超时、`5xx`、`408`、`429` 按 1 s → 5 s → 30 s → 2 min 退避重试（`429` 时优先用 `Retry-After`）；其余 `4xx` 视为业务拒绝，不重试，并回滚本地乐观更新。所以**所有写接口都必须幂等**（第 2.3 节）。
- 读接口加 `Cache-Control: no-store`。

## 1. 身份

### 1.1 `GET /api/auth/session`

返回当前请求者是谁。公开路由，不要求登录；网关未给出身份时返回匿名。

```json
{
  "authenticated": true,
  "user": { "id": "alice", "name": "Alice", "email": "alice@example.com" },
  "roles": ["reader", "admin"],
  "groups": ["admins", "students-2026"],
  "logoutUrl": "https://auth.example.com/logout"
}
```

匿名：

```json
{ "authenticated": false, "user": null, "roles": ["reader"], "groups": [], "logoutUrl": null }
```

| 字段 | 规则 |
|---|---|
| `user.id` | 网关给出的稳定用户名，**作为所有按用户存储的数据的 `user_id`**。`name`、`email` 可为 `null` |
| `roles` | `reader` / `author` / `admin` 的子集，至少含 `reader`。由后端配置把网关用户组映射成角色，例如 Authelia 组 `admins` → `admin` |
| `groups` | 网关给出的用户组原样返回（去空白、去重、保持顺序）。前端用它判断能读哪些课程组（访问模型，修订案 01 §4.8） |
| `logoutUrl` | 网关的登出地址；没有就是 `null` |

- 只接受 `GET`；带 `Cache-Control: no-store`。
- 站点配置 `modules.auth.adapter = 'none'` 时前端**不会**请求这个接口。
- **网关不要拦这个接口**（不要求登录）。前端只把响应体里的 `authenticated: false` 当作「已登出」，并因此清空本机缓存的进度与待发写入；`401` 或重定向一律当作「身份暂时不可用」，不动本机数据。整站在网关之后的部署（本站）里，登录过期时这个接口会被网关重定向，前端按后一种处理。
- 前端所有请求都**不跟随重定向**（`fetch` 的 `redirect: 'manual'`）。写进度时遇到重定向（典型是登录过期被网关送去登录页），写入留在待发队列，重新登录后补发。

### 1.2 `trusted-header` 适配器（后端实现）

后端从认证网关注入的请求头读身份。头名可配置，默认值按网关：

| 网关 | 用户 | 用户组 | 邮箱 | 显示名 |
|---|---|---|---|---|
| Authelia（本站） | `Remote-User` | `Remote-Groups` | `Remote-Email` | `Remote-Name` |
| Authentik | `X-authentik-username` | `X-authentik-groups` | `X-authentik-email` | `X-authentik-name` |
| oauth2-proxy | `X-Forwarded-User` | `X-Forwarded-Groups` | `X-Forwarded-Email` | `X-Forwarded-Preferred-Username` |

- 用户组头按逗号分隔（Authentik 用 `|`，可配置分隔符）。
- **安全前提，两条都必须满足**：
  1. 后端只监听 `127.0.0.1`，外部无法绕过 nginx 直连；
  2. nginx 在**所有**转发到后端的 `location` 里用 `auth_request_set` 取网关的结果，再用 `proxy_set_header` 写入身份头。这样客户端自带的同名头会被覆盖；对不经过 `auth_request` 的公开路由，把身份头显式设为空串：

```nginx
location /api/ {
    auth_request /internal/authelia/authz;
    auth_request_set $user   $upstream_http_remote_user;
    auth_request_set $groups $upstream_http_remote_groups;
    auth_request_set $email  $upstream_http_remote_email;
    auth_request_set $name   $upstream_http_remote_name;
    proxy_set_header Remote-User   $user;
    proxy_set_header Remote-Groups $groups;
    proxy_set_header Remote-Email  $email;
    proxy_set_header Remote-Name   $name;
    proxy_pass http://127.0.0.1:<port>;
}
```

- 请求里没有身份头（或为空）= 匿名。
- **不再信任客户端自报的用户 id**。现在伴读请求体里的 `user`（浏览器本地生成，键 `dify_chat_user_id`）在 P6 改为由后端用 `user.id` 填写。

### 1.3 路由分级

| 档 | 路由 | 未登录时 |
|---|---|---|
| 公开 | `GET /api/health`、`GET /api/auth/session` | 正常响应 |
| 用户 | `/api/db/*`、`/api/progress/*`、`/api/notion/*`、`/api/ai/*` | `401 {"error":"unauthenticated"}` |
| 管理 | `/api/admin/*`（P6.5） | 未登录 `401`，登录但不是 `admin` 返回 `403` |

- 站点没有认证模块（`auth.adapter = 'none'`）时，部署者要么不部署后端（进度用 `local`），要么自行保证整站在网关之后；此时所有请求视为同一个匿名用户 `user_id = "anonymous"`。

## 2. 学习进度

### 2.1 记录格式（线上传输）

```json
{
  "lecture_id": "g05-l19",
  "group_id": "g05",
  "status": "学习中",
  "completed_at": null,
  "updated_at": "2026-11-18T08:30:00.000Z",
  "notion_node_id": null,
  "notion_page_id": null
}
```

| 字段 | 规则 |
|---|---|
| `lecture_id` | 小写，`<组目录最后一段>-l<两位以上讲号>`，如 `g05-l19`、`lr-l03`、`g01-l100`。与前端 `core/route.ts` 的 `lectureId` 转小写一致。后端收到大写要先转小写 |
| `group_id` | 小写，组目录最后一段 |
| `status` | `未开始` / `学习中` / `已完成` 三者之一，其余值返回 `400 {"error":"invalid_status"}`。v1 保持中文值，与现有数据库约束和 Notion 状态一致 |
| `completed_at` | 变为 `已完成` 时若为空则由服务端填当前时间；离开 `已完成` 时清空（与 V1 的 Notion 同步语义一致） |
| `updated_at` | **服务端时钟**，每次写入由服务端设置。请求体里的 `updated_at` 只作参考，不参与先后判断 |
| `notion_*` | 可选的 Notion 溯源 id，可为 `null` |

所有进度数据**按 `user.id` 隔离**：同一 `lecture_id` 不同用户各有一条。

### 2.2 `GET /api/db/progress`

- 不带参数：返回当前用户的**全部**记录（数组，顺序不限）。前端每次整页加载调用一次。
- 可选过滤：`?group_id=g05`、`?lecture_id=g05-l19`（后者返回单条对象，找不到 `404`）。
- 前端兼容：不带参数的请求若返回 `400`、`404` 或 `422`，前端退回按组逐个请求 `?group_id=`，并在调试面板标记「后端不支持全量读取」。

### 2.3 `PATCH /api/db/progress/{lecture_id}`

写一条（不存在就创建）。

- 请求头 `Idempotency-Key: <UUID>`：同一用户、同一个键在 24 小时内重复到达时，**不重复执行**，直接返回第一次的响应（状态码与响应体都相同）。同一个键配不同的请求体返回 `422 {"error":"idempotency_key_reused"}`。
- 请求体：

```json
{ "status": "已完成", "group_id": "g05", "updated_at": "2026-11-18T08:30:00.000Z", "notion_node_id": null, "notion_page_id": null }
```

  `status` 必填；其余可选，缺省保留原值。`completed_at` 由服务端按 2.1 的规则处理，请求体里的值忽略。
- 响应 `200`：写入后的完整记录（含服务端 `updated_at`）。

### 2.4 `POST /api/db/progress/batch`

批量写入，用于组页「批量标记」。

- 请求头 `Idempotency-Key`：整批一个键，语义同 2.3。
- 请求体：`{ "items": [ { "lecture_id": "g05-l01", "status": "已完成", "group_id": "g05" }, … ] }`，每项字段同 2.3，最多 200 项。
- **整批原子**：任一项非法则整批 `400`，不写入任何一项。
- 响应 `200`：与 `items` 同序的完整记录数组。

### 2.5 先后裁决（前端行为，后端知悉）

- 前端先乐观更新，写操作进本地「待发队列」，同一讲后来的操作覆盖还没发出的旧操作。
- 每次响应用 `Date` 头估算偏差 `skew = 服务端时间 − 客户端收到响应的时间`。
- 整页加载拉全量后，对有待发操作的讲：若服务端记录的 `updated_at` 晚于「操作发生时间 + skew」，说明别的设备后来改过，以服务端为准并丢弃该操作；否则保留操作并继续发送。
- 服务端没有可信的 `updated_at`（第 5 节差距未补前）时：操作在被确认前一律以本地为准，确认后以服务端为准。

## 3. `GET /api/health`

公开、只读、不访问外部服务以外的东西，用于部署自测与 Dashboard。

```json
{ "ok": true, "service": "lecture-api", "version": "2026.11.18", "checks": { "db": "ok", "ai": "ok", "notion": "ok" }, "time": "2026-11-18T08:30:00.000Z" }
```

- `checks` 的值为 `ok` / `degraded` / `down` / `off`（模块未启用）。任何一项 `down` 时 `ok` 为 `false`，HTTP 状态仍为 `200`。
- 不返回版本以外的任何配置、主机名、连接串或密钥。

## 4. Notion 进度同步（沿用现状）

- `POST /api/progress/notion-sync`；返回 `404` 时前端降级为 `PATCH /api/notion/sync-status`。Notion 令牌只在服务端。
- 前端仅在站点配置 `modules.progress.notionSync = true` 时调用（本站开启）。
- 建议（非 v1 必需）：后端在 2.3 / 2.4 写入成功后自行同步 Notion，届时把 `notionSync` 关掉，前端少一次请求，也不会出现「进度写入成功、Notion 同步失败」的分叉。

## 5. 现有后端与本契约的差距

截至 2026-11-18，前端按 V1 行为推断（`site/tests/fixtures/api/` 是按前端行为编写的合成数据，**不是**真实录制）：

| # | 差距 | 影响 | 前端兼容方式 |
|---|---|---|---|
| 1 | 进度不按用户隔离（请求里没有任何身份） | 多人登录时共用一份进度 | 无；需后端用 `user.id` 隔离 |
| 2 | 没有 `GET /api/auth/session` | 前端不知道当前用户与用户组 | 返回 `404` 时按「身份未知」处理：不按用户分隔本地缓存，访问分档只显示默认档 |
| 3 | 不带过滤的 `GET /progress` 未确认可用 | 首页要按组请求 15 次 | 2.2 的退回逻辑 |
| 4 | 不支持 `Idempotency-Key` | 重试可能重复写入（对 upsert 无害，对将来的计数类接口有害） | 无；前端总是发送该头 |
| 5 | `updated_at` 是否由服务端设置未确认（V1 前端在请求体里自带） | 跨设备先后裁决不可靠 | 2.5 末条 |
| 6 | 没有 `GET /api/health` 或格式不同 | 部署自测无从判断 | Dashboard 显示「未知」 |
| 7 | ~~仓库缺 `schema/neon_schema.sql`~~ 由 `server/migrations/` 取代 | — | — |

**更正**：上表按「后端存在但不合契约」写成，实际 `/api/db/*` 后端此前并未实现。第 1–6 条差距全部由 `server/`（lecture-api）补齐。

后端补齐后：从真实服务端各录一份响应替换 `site/tests/fixtures/api/` 下对应文件，并在本节把该行标为已完成。

**数据迁移**：服务端从来没有进度数据，按用户隔离时**没有旧行要迁**。站长的进度在浏览器的 V1 本地数据和 Notion 图谱里：前端加载时先应用身份、再导入 V1 本地数据（`progressStore.ts` `doLoad`），所以首次登录后这些进度会作为写入发到后端，不会看到空进度。只有一种情况要人工迁移：后端先以 `auth: none` 运行过一段（数据都记在 `anonymous` 名下），之后才开登录。这时用 `npm run db:reassign -- --from anonymous --to <站长用户名> --yes`。所以上线时后端和前端的 `auth: trusted-header` 要在同一次发布里打开。

## 6. 变更记录

- 2026-11-18 v1 起草（V2 P3）。
- 2026-11-18 更正第 5 节：`/api/db/*` 后端从未实现，没有旧进度行要迁；实现位置定为仓库根 `server/`。
