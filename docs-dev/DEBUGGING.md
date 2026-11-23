# 前端调试手册（V2）

目标：前端直接调试，不需要为了调试再写后端接口。两部分组成：

1. **dev 服务器 API 模式**（`site/docs/.vitepress/plugins/apiModePlugin.mjs`）：`/api/**` 可以走真实后端、走 fixture，或转发到任意后端；
2. **浏览器调试台** `window.__LECTURE_DEBUG__`（`site/docs/.vitepress/theme/debug/`）：查看各模块状态、切换场景、看请求日志、开关 feature flag、导出 / 导入本地进度。

> 两者都只在 dev 下默认开启。生产站要显式 `?debug=1` 才会出现调试台，API 模式插件在生产构建里根本不存在（`apply: 'serve'`）。

---

## 1. API 模式

| `LECTURE_API_MODE` | 行为 |
|---|---|
| `off`（默认） | 不拦截，行为与 V1 完全一致 |
| `mock` | `/api/**` 由 `site/tests/fixtures/api/` 下的 fixture 应答。状态保存在内存里（PATCH 进度之后再 GET 能读到改动），重启或 `POST /__debug/api/reset` 后复位 |
| `proxy` | `/api/**` 原样转发到 `LECTURE_API_ORIGIN`（必填，缺了直接启动失败）。SSE 不缓冲，请求体和鉴权头都不进日志 |

拼错模式名（比如 `mok`）会直接报错，不会被悄悄当成 `off`。`/api/generate-export` 归导出插件处理，不受本插件影响。

### 启动

PowerShell：

```powershell
cd site
$env:LECTURE_API_MODE='mock'; npm run dev -- --port 5174

# 转发到某个后端（staging 或本地后端）
$env:LECTURE_API_MODE='proxy'; $env:LECTURE_API_ORIGIN='https://staging.example.test'; npm run dev -- --port 5174

# 默认场景（不用每个请求都带）
$env:LECTURE_API_SCENARIO='slow'

# 恢复默认
Remove-Item Env:LECTURE_API_MODE, Env:LECTURE_API_ORIGIN, Env:LECTURE_API_SCENARIO -ErrorAction SilentlyContinue
```

bash：

```bash
cd site
LECTURE_API_MODE=mock npm run dev -- --port 5174
LECTURE_API_MODE=proxy LECTURE_API_ORIGIN=http://127.0.0.1:8787 npm run dev -- --port 5174
```

`LECTURE_API_ORIGIN` 可以带基础路径，例如 `https://host/base` 会把 `/api/db/x` 转发到 `https://host/base/api/db/x`。

终端里每个被拦截的请求打印一行：

```
[api:mock] PATCH /api/db/progress/g01-l03 200 3ms scenario=default
```

### mock 覆盖的接口

| 接口 | 说明 |
|---|---|
| `GET /api/health` | `health.get.json` |
| `GET /api/auth/session` | 按场景返回身份（契约 §1.1）：默认匿名；`user-alice` / `user-bob` 返回两个不同的登录用户；`legacy-backend` 返回 404 |
| `POST /api/ai/chat` | 逐帧推送 `ai/chat.sse`（Dify 事件：ping / agent_thought / agent_message / message / message_end），帧间隔约 60ms；`{{query}}`、`{{conversation_id}}`、`{{message_id}}` 会被替换成实际值 |
| `POST /api/ai/upload` | multipart 只读取不落盘，返回 `ai/upload.post.json`，`id` 由 mock 生成 |
| `POST /api/progress/notion-sync`、`PATCH /api/notion/sync-status` | 校验三态 status，非法值返回 400 |
| `/api/db/sessions[/:id]` | GET（`?lecture_id=`）/ POST / PATCH / DELETE（删会话时级联删消息） |
| `/api/db/messages[/:id]` | GET（`?session_id=`）/ POST / PATCH / DELETE |
| `/api/db/progress` | `GET ?lecture_id=`（单条，不存在返回 404）、`GET ?group_id=`、不带参数的 `GET`（全量）、`PATCH /progress/:id`、`POST /progress/batch`。按 API_CONTRACT 行为：`updated_at` 一律由 mock 的时钟设置（忽略请求体里的值），`completed_at` 在变为已完成时由 mock 填、离开时清空；`PATCH` 必须带合法 `status`；批量最多 200 项且整批原子（任一项非法则整批 400，不写入）；进度数据所有用户共用一份（不按身份隔离） |
| `Idempotency-Key`（进度 `PATCH` 与 `POST /progress/batch`） | 同键同请求在 24 小时内重放：不重复写入，返回第一次的状态码与响应体（带响应头 `idempotency-replayed: true`）；同键不同请求返回 `422 idempotency_key_reused`；只记住 2xx 响应；重置时清空。`legacy-backend` 场景不认这个头 |
| 响应头 `Date` | mock 的每个响应都带，用于前端估算时钟偏差 |
| `/api/db/review-checklists`、`/api/db/checklist` | 两个路径共用同一份数据（DB_ROUTES 里写的是前者，neonRepository 实际调用的是后者） |

种子数据：`db/sessions.get.json`、`db/messages.get.json`、`db/progress.get.json`、`db/review-checklists.get.json`。`db/progress.patch.json` 是请求体样例。

### 场景

场景名的取值优先级：`?__scenario=` 查询参数 > 请求头 `x-lecture-scenario` > cookie `lecture-scenario` > 环境变量 `LECTURE_API_SCENARIO` > `default`。

| 场景 | 效果 | 模式 |
|---|---|---|
| `default` | 正常应答 | mock / proxy |
| `slow` | 每个请求先延迟 2s | mock / proxy |
| `offline` | 全部返回 503（请求不会转发出去） | mock / proxy |
| `error` | 全部返回 500 | mock / proxy |
| `sse-error` | 对话先输出半段回答，再发 `event: error`，不发 message_end | mock |
| `empty` | db 列表返回 `[]`，单条查询返回 404 | mock |
| `notion-fallback` | 主同步端点返回 404，用来验证 PATCH 降级 | mock |
| `legacy-backend` | 模拟契约之前的后端：不带参数的 `GET /api/db/progress` 返回 400（前端退回逐组读取）、`GET /api/auth/session` 返回 404、不认 `Idempotency-Key` | mock |
| `reject-writes` | 进度写入（`PATCH /progress/:id`、`POST /progress/batch`）一律返回 422（验证回滚与「写入被拒」提示） | mock |
| `user-alice` | `GET /api/auth/session` 返回登录用户 alice（角色 reader、admin；组 admins、students-2026） | mock |
| `user-bob` | `GET /api/auth/session` 返回登录用户 bob（角色 reader；组 students-2026）。先用 `user-alice` 加载再切到 `user-bob` 重新加载，可验证进度 store 的 `owner` 切换会清空本地缓存与待发队列 | mock |

### 调试端点（dev 服务器）

- `GET /__debug/api/state`：当前模式、origin、mock 内存状态（进度 / 会话 / 消息 / 清单 / Notion 同步记录 / 上传记录）
- `POST /__debug/api/reset`：mock 状态恢复到 fixture
- `GET /__debug/api/scenarios`：列出所有场景

---

## 2. 浏览器调试台 `__LECTURE_DEBUG__`

### 开启条件

- `npm run dev`（`import.meta.env.DEV`）下自动开启；
- 任何环境（包括线上）在 URL 后加 `?debug=1` 开启，并记到 `localStorage['lecture:debug']='1'`，之后的访问继续保持开启；
- `?debug=0` 清除记录，并在这一次加载中关闭（dev 下也一样）。

调试台打开后才会包装 `window.fetch`；关闭状态下不改任何全局对象。

### API

```js
const d = __LECTURE_DEBUG__

d.help()                         // 打印面板 / 动作表和全部方法
d.state()                        // 所有面板快照 { [id]: describe() }
d.panels()                       // ['debug', 'progress', ...]
d.panel('progress')              // 单个面板
d.run('progress', 'flush')       // 调用面板动作
d.enabledBy                      // 'dev' | 'query' | 'localStorage'

// feature flag（localStorage 'lecture:flags'）
d.flags.list()                   // [{ name, enabled, source: 'override'|'env'|'default' }]
d.flags.set('aiScope', true)     // 本地覆盖
d.flags.set('aiScope', null)     // 去掉覆盖，回落到 env 或默认值
d.flags.get('aiUpload')
d.flags.reset()

// 请求日志与场景
d.api.log                        // 最近 200 次同源 /api/** 请求：{ at, method, url, status, ms, scenario, error? }
console.table(d.api.log)
d.api.clear()
d.api.scenario('offline')        // 之后所有 /api 请求都带 x-lecture-scenario，同时写 cookie（XHR 上传也能带上）
d.api.scenario()                 // 读取当前场景
d.api.scenario(null)             // 回到 default
await d.api.serverState()        // = GET /__debug/api/state
await d.api.serverReset()        // = POST /__debug/api/reset

// 本地存储快照（只涉及讲义相关键：lecture- / lecture: / tut_neon_ / tut: / dify_chat_user_id / tutorial_ai_）
d.storage.keys()
d.storage.dump('tut_neon_')      // JSON 自动解析后输出
copy(JSON.stringify(d.storage.export()))     // DevTools 的 copy() 把快照放进剪贴板
d.storage.import(snapshotJson)               // 合并导入
d.storage.import(snapshotJson, { replace: true })  // 先清掉现有讲义键，再导入
```

导入时会跳过非讲义前缀的键，所以快照里即使混入其他键也不会被写进去。请求日志里只有方法、路径、状态码和耗时，不记录请求体和请求头。

### 常见调试流程

1. 复现"后端挂了"：`d.api.scenario('offline')`，刷新页面，看 UI 的离线提示，再用 `console.table(d.api.log)` 看请求；
2. 复现"流式回答中途出错"：用 mock 模式启动，执行 `d.api.scenario('sse-error')`，然后在伴读侧栏提问；
3. 复现"换人登录"：`d.api.scenario('user-alice')` 刷新页面并改几讲进度，再 `d.api.scenario('user-bob')` 刷新，`d.panel('progress')` 里 `owner` 变为 bob、`log` 里有一条清空记录；
4. 复现"后端拒绝写入"：`d.api.scenario('reject-writes')` 后切换一讲状态，应当回滚并收到 `rejected` 事件；
5. 复现"旧后端"：`d.api.scenario('legacy-backend')` 刷新，`d.panel('progress').unfilteredGet` 为 `false`（退回逐组读取）；
6. 复现某个用户的进度：让对方在线上打开 `?debug=1`，执行 `copy(JSON.stringify(__LECTURE_DEBUG__.storage.export()))` 把快照发过来，本地执行 `d.storage.import(json, { replace: true })` 后刷新。

---

## 3. Feature flag（应用代码）

```ts
import { isEnabled, onFlagsChange } from '../debug/flags'

if (isEnabled('aiScope')) { /* 显示范围胶囊 */ }
const off = onFlagsChange(() => rerender())   // 同标签页的自定义事件 + 跨标签页的 storage 事件
```

取值优先级：本地覆盖（调试台写入）> 构建期 `VITE_FLAG_<NAME>` > 默认 `false`。
`aiScope` 对应的环境变量可以写 `VITE_FLAG_AI_SCOPE=1`，也可以写 `VITE_FLAG_AISCOPE=1`；值为 `1/true/on/yes` 时开启，`0/false/off/no` 时关闭。

```powershell
$env:VITE_FLAG_AI_SCOPE='1'; npm run dev -- --port 5174
```

---

## 4. V2 模块如何注册面板

```ts
// theme/progress/progressStore.ts（示例）
import { registerDebugPanel } from '../debug/registry'

const unregister = registerDebugPanel('progress', {
  describe: () => ({
    outbox: store.outbox.length,
    lastSyncAt: store.lastSyncAt,
    server: store.serverSnapshot(),
  }),
  actions: {
    flush: () => store.flushOutbox(),
    set: (id: unknown, status: unknown) =>
      typeof id === 'string' && typeof status === 'string' ? store.set(id, status) : 'usage: set(id, status)',
  },
})
// 模块销毁时（HMR / dispose）调用 unregister()
```

要求：

- `describe()` 只返回能 JSON 序列化的快照，不要放 DOM 节点，也不要放令牌；即使它抛错也只会显示成 `{ __error }`；
- 动作参数类型是 `unknown`，在动作内部自行校验；
- 注册调用本身对 SSR 安全，可以写在模块顶层；调试台没有开启时，注册只是往 Map 里加一条，不产生其他影响。

调试台安装入口：`theme/index.ts` 的 `setup()` 在 `onMounted` 里调用一次 `exposeDebug()`，随后 `lifecycle.enter(route.path)`。

### 已注册的面板

#### lifecycle 面板

`d.panel('lifecycle')`：当前路径 `path`、代号 `generation`（每次 enter +1）、本次访问已挂载的 feature `mounted`、待执行的 disposer 数 `pendingDisposers`、已安装的 app feature `appFeatures`、各 feature 的 `timings`（`mounted / failed / skipped / stale` + 耗时 ms）。动作：`d.run('lifecycle', 'reenter')` 重新进入当前页。

#### reading-progress 面板

`d.panel('reading-progress')`：`activeBindings`（当前活跃的监听组数，正常恒为 0 或 1，大于 1 说明有泄漏）、`lastVisit`（`restored` 恢复到的像素、`settledBy` 是 `charts-settled` 还是 `timeout`）、`entries`（存储条目数）。动作：`d.run('reading-progress', 'clear', '/g05/L19')`，不传路径则清空全部。

#### charts 面板

`d.panel('charts')`：图表运行时的代号 `generation`、当前页 `path`、`running`、上次收敛 `lastSettle`、`chartsDone`（`window.__CHARTS_DONE__`）、`live`（跨页仍存活、尚未 dispose 的句柄数，按类型；`echarts` 即 ECharts 实例数，连续换页后不应增长）、当前页 registry 计数 `page`、`figures`（各 figure 的状态）、`sidecarCache`、`modalOpen`。动作：`rerenderAll`（重渲当前页）、`disposeAll`（释放当前页全部实例）。收敛时派发 `lecture:charts-settled`（`detail.path` 为规范化路径），阅读进度据此做最后一次位置恢复。

---

## 5. 测试

```bash
cd site
npx vitest run tests/unit/api-mode-plugin.test.ts tests/unit/debug-registry.test.ts
```

注意：Node ≥ 25 自带一个实验性的全局 `localStorage`。没有传 `--localstorage-file` 时它的值是 `undefined`，而且会覆盖 happy-dom 提供的 Storage。`debug-registry.test.ts` 里已经装了内存版 Storage 来绕过这个问题，其他 happy-dom 测试如果用到 localStorage 也要这样处理，或者统一放进 vitest 的 setup 文件。
