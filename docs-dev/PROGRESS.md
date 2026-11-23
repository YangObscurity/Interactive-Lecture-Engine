# 学习进度 (progress) 指南

站点的讲次状态（未开始 / 学习中 / 已完成）只有一个真源：`site/docs/.vitepress/theme/progress/` 里的 store。首页、组页、讲义文末打卡卡片、两张脑图都从它读，也只通过它写。后端接口见 `docs/backend-handoff/API_CONTRACT.md`，本文只讲怎么配、它怎么工作、怎么排查。

## 1. 怎么配

`site/lecture.config.ts` 的 `modules.progress`：

```ts
export default defineLectureConfig({
  modules: { progress: { adapter: 'rest', notionSync: true } },
})
```

| 写法 | 效果 |
|---|---|
| 不写 / `adapter: 'local'` | 进度只存浏览器（`localStorage`），不发任何请求。读取仍有图谱种子打底。适合演示站、没有后端的站点 |
| `adapter: 'rest'` | 进度读写同源 `{endpoint}/progress`（默认 `/api/db/progress`）。必须有符合 `API_CONTRACT.md` 的后端（旧后端见 §5 的兼容说明） |
| `endpoint: '/svc/db'` | 改 `rest` 的基础路径，其下是 `/progress`、`/progress/batch` |
| `notionSync: true` | 读者在本页做的修改，经现有 Notion 同步代理（`/api/progress/notion-sync`，失败退到 `/api/notion/sync-status`）回写 Notion。只转发读者自己的修改：加载、另一个标签页的写入、服务端回包都不会触发 |

本站（私有站）用 `rest` + `notionSync`，`auth` 保持默认 `none`（后端提供 `/api/auth/session` 之后再改）。改完重新 `npm run build`；`npm run config:check` 校验选项名与类型。客户端从 `themeConfig.lectureModules` 读到这些设置，接线在 `theme/index.ts`：页面挂载后 `configureProgress` -> 注册调试面板 -> 需要时启动 `notionBridge` -> `progressStore.load()`，整页只做一次，SSR 不碰。

## 2. store 做什么

### 读取规则

`statusOf(id)` = 该讲最新的待发写入 > 服务端记录 > 图谱种子 > 未开始。

- 种子来自构建时的 `docs/public/notion_knowledge_graph.json`，只作用于既没有服务端记录、也没有待发写入的讲次；种子版本变化不会清掉任何东西。
- 完成时间 `completedAtOf(id)` 同样的顺序：待发写入是「已完成」时取写入时间，是其它状态则没有；否则有服务端记录就只看它（它不是「已完成」就没有完成时间，不会落到种子里的旧时间）；都没有才看种子。
- 讲次 id 一律小写，组取组目录的**最后一段**：`examples/g01/L01` 是 `g01-l01`，与 `core/route.ts`、后端契约 §2.1 一致（`progress/types.ts` 的 `groupOfDir`）。组页、讲义页进度卡片、写入时的 `groupId` 都按这条规则，嵌套组的同一讲不会变成两条记录。
- `ready` 之前（SSR 与首次客户端渲染）组件一律按「未开始」渲染，保证水合一致。

### 写入与发件箱

`set` / `setMany` 先乐观更新界面，再把操作放进发件箱（持久化在 `localStorage['tut:v2:progress']`，刷新后还在）。同一讲还没发出的旧操作被新操作替换。

- 一条操作走 `PATCH /progress/:id`，两条以上走 `POST /progress/batch`（每 200 条一批）。`Idempotency-Key`：单条用操作 id，整批用全部操作 id 排序后的哈希，重试时不变。
- 同一时刻只有一个标签页发送（`navigator.locks`）。
- 重试：网络错误、超时、`5xx`、`408`、`429`、重定向（登录过期被网关 302）、「2xx 但不是 JSON」都可重试。间隔 1 s / 5 s / 30 s / 2 min（之后保持 2 min，`429` 用 `Retry-After`）；浏览器 `online`、页面重新可见、下次加载时也会重试。
- 拒绝：其余 `4xx`（例如 `422`）不重试。该操作被丢弃，该讲回到服务端状态，界面弹出「进度未能保存，已恢复为原状态」。
- 成功：用响应里的记录更新缓存，移除已确认的操作，并按响应的 `Date` 头更新本机与服务器的时钟差。

### 加载与裁决

整页一次：读本地状态 -> 取会话 -> 载入种子 -> V1 迁移 -> 读后端 -> 裁决 -> 发送待发队列。裁决（`API_CONTRACT.md` §2.5）：服务端该讲的 `updated_at` 晚于操作时间（加时钟差）就丢弃这条待发操作；服务端没有 `updated_at` 时操作优先。读后端先不带参数 `GET /progress`；旧后端返回 `400 / 404 / 422` 时退回逐组 `?group_id=`。

### 换人

`auth.adapter` 不是 `none` 时，加载先取会话。登录用户的 `id` 与保存的 `owner` 不同，或已登出而 `owner` 非空：清空本地缓存与待发队列（宁可丢一次未发出的操作，也不以别人的身份写入），并在调试面板的 `log` 记一条。会话不可用（404、网络错误、被网关拦截的 401）不改 `owner`。

### V1 迁移

首次加载做一次（`migratedV1`）。读取 V1 的 `tut_neon_progress_all_map` 与全部 `tut_neon_progress_<id>`，取并集（键转小写，同一讲取 `updated_at` 较新者）；与种子相同的忽略，不同的进入发件箱（操作时间取 V1 记录的 `updated_at`），随后由裁决决定去留。**V1 的键只读不删**：同域名上的 V1 站点继续可用，回退也不丢数据。

## 3. 排查

调试控制台：dev 默认开启；生产用 `?debug=1` 或 `localStorage['lecture:debug'] = '1'`。

```js
const d = window.__LECTURE_DEBUG__
d.panel('progress')        // ready / backend / owner / seedVersion / counts / outbox / skewMs / unfilteredGet / syncState / log
d.run('progress', 'flush') // 立刻重发（忽略退避时间）
d.run('progress', 'reload')// 重新走一遍加载
d.run('progress', 'reset') // 清空 tut:v2:progress（owner、服务端缓存、发件箱、迁移标记）
d.api.log                  // 最近的 /api/** 请求
```

- `counts.outbox` > 0 且 `syncState` 是 `offline` / `retrying`：后端不可达或在报错，看 `outbox[].attempts`、`nextAt` 与 `d.api.log`。
- `unfilteredGet === false`：后端不支持不带参数的 `GET /progress`，在逐组读取。
- `log` 里有 `reader changed` / `signed out`：发生了换人清空；有 `dropped pending write`：服务端记录更新，丢弃了这条待发写入。
- 状态值损坏时原值另存在 `tut:v2:progress:corrupt`，可取出排查。

本地 mock（`LECTURE_API_MODE=mock`，见 `docs-dev/DEBUGGING.md`）里的相关场景：

| 场景 | 用途 |
|---|---|
| `offline` / `error` / `slow` | 离线、`500`、慢响应：看发件箱与重试 |
| `reject-writes` | 写入一律 `422`：验证回滚与提示 |
| `legacy-backend` | 不带参数的 `GET` 返回 `400`、会话 `404`、不认 `Idempotency-Key`：验证逐组读取 |
| `user-alice` / `user-bob` | 先以 alice 加载并改几讲，再切到 bob 刷新：`owner` 变化并清空本地缓存 |

切场景：`d.api.scenario('reject-writes')`。端到端用例见 `site/tests/e2e/progress.spec.ts`（测试内有状态 mock，不触达真实后端）。

## 4. 代码在哪

| 路径 | 内容 |
|---|---|
| `theme/progress/progressStore.ts` | store 与站点单例、`configureProgress`、调试面板 |
| `theme/progress/useProgress.ts` | 组件用的组合函数：`ready`、`statusOf`、`completedAtOf`、`countCompleted`、`set`、`setMany`、`syncState`、`pending`、`onRejected` |
| `theme/progress/notionBridge.ts` | `notionSync` 为真时订阅 store，调用 `theme/components/ai/notionSync.ts` |
| `theme/progress/v1Migration.ts` / `seed.data.mts` | V1 迁移、构建时种子 |
| `theme/api/progress.ts` / `http.ts` / `contract.ts` | `local` 与 `rest` 适配器、HTTP 层、线上类型 |
| `theme/auth/session.ts` | 会话客户端 |

线上中文状态值（`未开始 / 学习中 / 已完成`）是协议常量 `PROGRESS_WIRE_STATUS`（`site.config.mts`），只在适配器、V1 迁移、Notion 同步这三处边界出现；站内其余代码用 `not_started | in_progress | completed`，需要旧值时用 `toLegacyStatus`。除 `theme/progress/` 与 `theme/api/` 外，没有代码读写 `tut_neon_progress_*` 键或调用进度接口（`neonRepository.ts` 里只剩会话、消息、清单）。

## 5. 已知限制

- **后端还没补齐时**：本站的后端是契约之前的旧实现，不带参数的 `GET` 可能返回 `400`，前端会退回逐组读取（每组一次请求）；不认 `Idempotency-Key` 时，重试的重复写入由「同一状态写两次结果相同」兜底。
- **进度按人隔离依赖后端**：后端上线 `/api/auth/session` 与按身份隔离前，进度表全站共用，多人登录会互相覆盖；上线后把 `auth` 改为 `trusted-header`。
- **多人共用一个浏览器**：换人时清空本地缓存与待发队列，未发出的操作会丢。
- **V1 迁移与图谱漂移**：V1 每次加载都把当时 `notion_knowledge_graph.json` 的状态写进本地，迁移时分不出「图谱写的」和「读者改的」。若图谱在读者最后一次打开 V1 之后又更新过，旧图谱状态会被当成读者改动排队；后端已有更新记录时由裁决丢弃，没有时会写回旧值。上线前若更新图谱，先让 V1 读一次新图谱，或在迁移前比对 `tut_graph_ver`。
- **脑图**：`GlobalCurriculumMap`、`GroupKnowledgeMap` 只是换了进度来源，整体重做在 P4。
- **Notion 节点 id**：讲义文末卡片不再把 frontmatter 里的节点 id 传给 Notion 同步，Notion 的 id 只取服务端记录与种子（二者都来自图谱，覆盖全部已建档的讲次）。
- **审计未覆盖**：`rest` 适配器对真实后端的行为（`Date` 头、`Retry-After`、幂等重放）只在 mock 与单元测试里验证过。
