# 概念页起草与读者工具调用（CONCEPTS.md）

契约：`site/ai-contracts/concept-draft.json`（v2）。

本页记录本机作者模式下的概念页起草工作流（查全站、防重名、全貌契约、写前检查、补充已有概念）以及线上读者自带密钥（BYOK）时的工具调用闭环与无后端降级。

---

## 1. 概念起草契约（`concept-draft` v2）

- **全貌提示、不固定小标题**：`site/ai-contracts/concept-draft.json`（`version: 2`）把规划 §3.1 的九个方面（一句话定义、直觉与动机、形式化定义与工作机制、关键参数与取值、变体与对比、在讲义中的出现、局限与常见误区、相关概念、每段出处）写入 `instructions.zh` / `instructions.en`，明确说明它们只是“讲全貌通常涵盖什么”的提示；模型自行拟定段落标题（`heading`）与组织顺序，对该概念不适用的方面直接省略，契约与构建检查绝不要求特定标题。
- **每段出处**：优先引用讲义（讲义编号、链接与小节/锚点）；讲义不足时引用外部权威出处（教科书、标准规范、原始论文，写全所有作者、年份、标题、会议/期刊/出版社与具体位置），博客或维基百科不能作为唯一出处。严禁添加任何许可证（licence）或版权字段。无法核实的声明必须置 `verified: false`、填写 `unverifiedReason` 并在 `body` 中包含字面量 `待核实`（发布确认门禁会拒绝含「待核实」的概念页）。
- **结构化互链与 `related`**：正文提及上下文已有概念时链接为 `[文字](concept:slug)`（仅限输入提供的 `slug`）。顶级必填数组 `related: [{ slug, rel }]`（可为空 `[]`，`rel` 取自 `V/concepts/related.ts` 的 6 种关系之一，禁止自反与未知 `slug`）由 `draftPayloadToConceptMarkdown` 写入 frontmatter `related:`。
- **补充模式（`currentConcept`）**：输入包含 `currentConcept`（既有已发布概念页）时，模型返回修订后的完整概念页 JSON，保留原页仍然正确的正文与出处（不丢弃仍在支撑所保留句子的旧出处），将新讲义选文与全站出现位置融入对应段落。

---

## 2. 写前确定性查重与全站上下文（`buildLectureContextForDraft`）

实现位置：`site/docs/.vitepress/concepts/devWorkflow.mts`，经 `dashboardDevPlugin.mts` 暴露于 `/__lecture/api/concepts/context` 与 `/__lecture/api/concepts/draft`。

1. **查重拦截（`create` 模式）**：用零依赖 `normalizeConceptName`（`V/concepts/names.ts`）归一化选中词，与全站根语言（`root`）所有**已发布与草稿**概念的名称及别名（`conceptNamesOf`）比对。命中时**不调用模型**，返回 HTTP `409` `{ ok: false, errorCode: 'DUPLICATE', existing: { slug, term, url, status }, matches }`：
   - 面板 `[data-concept-duplicate]` 提示已有概念并给出**打开已有概念**与**补充已有概念**两个动作；
   - 若多概念同时命中（例如共享同一别名），沿用挂载流的“先选择再继续”列表，选中目标后再打开或补充。
2. **全站出现位置（`occurrences`）**：使用 `rootLocaleLectures`（排除 `en/` 等译稿与被构建过滤的组）和缓存的 `createAnchorParser` + `splitLectureSections`，结合相同归一化规则匹配术语与别名。排序固定为：**当前所在讲义优先**，其余按提及次数降序、讲次号升序；最多 10 节、每节正文 ≤ 1,500 字符，附 `lectureCode`、`lecturePath`、`title`、`heading`、`anchor` 与站内链接 `/<group>/L<n>#<anchor>`。
3. **邻近与已有概念列表**：
   - `neighbours`：扫描选中片段（上下文与所在自然段）以及上述命中章节内出现的既有已发布概念，按位置权重排序，最多 15 条，每条包含 `{ slug, term, aliases, summary, related }`。
   - `existingConcepts`：在原有 `{ slug, term, aliases, field }` 基础上补充 `summary`。
4. **总长度上限 24,000 字符**：构造完成后测量 `JSON.stringify(context).length`；若超出 `24,000` 字符，**先从尾部裁剪 `occurrences`**，仍超出时**再从尾部裁剪 `neighbours`**。

---

## 3. 写前校验闭环（模型路径 1 次重试 + BYOK 路径直拒）

所有写入草稿的路径——服务端/开发端模型调用、`POST /concepts/draft` 提交浏览器 BYOK 生成的 `draftPayload`，以及手动 `markdownOverride` 保存——均先通过 `runDraftGraphChecks`（基于 K1 `graph.ts`）：

- **阻塞错误（拒绝写入草稿）**：
  - `checkDuplicateNames`：跨全部根语言概念（含其他草稿）检查名称与别名重名；
  - `checkConceptPageLinks`：正文 `concept:` 链接不得指向不存在的 `slug` 或权限更严格的层级；
  - `checkRelated`：`related` 不得自指、不得指向未知 `slug` 或权限更严格的层级；
  - 出处完整性：`verified: true` 时段落 `sources` 不得为空；`verified: false` 时须有 `unverifiedReason` 且 `body` 含 `待核实`。
- **非阻塞警告（写入草稿并在面板展示）**：
  - `checkUnlinkedMentions`：检测到正文提及另一已发布概念但未加链接，返回 `warnings` 数组，在侧边栏草稿卡片上展示提醒，不阻塞写入或发布。
- **失败行为**：
  - 模型路径把 `runDraftGraphChecks` 挂入 `runAiContract` 的 `validateData` 钩子；若失败则附带错误清单**自动重试 1 次**，第二次仍失败则返回 `格式不符，未写入` 与错误列表，磁盘不留文件。
  - `draftPayload`（BYOK）与 `markdownOverride` 路径直接返回 HTTP `422` 与错误列表，不写入文件。

---

## 4. 「补充已有概念」工作流（`mode: 'supplement'`）

- **触发入口**：正文划词匹配到已发布概念时的浮动工具栏按钮 `[data-ai-toolbar-concept="supplement"]`，或新建查重命中的 **补充已有概念** 按钮。
- **修订与预览**：以目标 `slug` 的已发布页面作为 `currentConcept`（与 §2 的 `occurrences`/`neighbours` 一并传入 `concept-draft` v2），生成草稿文件存于 `concepts/_drafts/<slug>.md`。
- **差异对比与确认写入**：
  - `listAllConceptsDev` 为存在已发布原页的草稿标注 `isRevision: true`（同时为原页标注 `hasDraftRevision: true`），Dashboard「概念草稿与已发布概念」列表将其显示为「修订待确认」状态与专属菱形标记。
  - `previewConfirmConcept` 生成已发布原页与修订草稿之间的统一 diff（`conceptPatch`），连同可选讲义挂链 diff（`lecturePatch`）与 `previewToken`（同时摘要原已发布字节、待写发布字节与讲义挂链后字节）一并返回；`executeConfirmConcept` 核验 `expectedPreviewToken` 一致且无「待核实」阻塞后，覆盖写入 `concepts/<slug>.md`（保留 `status: published` 与原 `/concepts/<slug>` 路由，更新 `reviewedAt` 为当天日期），随后删除 `_drafts/<slug>.md` 与侧车文件。

---

## 5. 读者自带密钥（BYOK）工具调用闭环

### 5.1 服务端工具清单（`server/src/routes/tools.ts`）

- 新增 `GET /api/tools`（复用 `requireUser` 会话校验、按用户限流的 `rt.toolsLimiter`，以及 `server/deploy/nginx-locations.conf` 的 `location = /api/tools` 精确反代规则）。
- 读取 `rt.mcpManager.loadConfig()`，仅返回当前启用的内置工具列表：
  ```json
  {
    "maxSteps": 5,
    "tools": [
      { "name": "search_concepts", "description": "...", "parameters": { ...JSON Schema... } }
    ]
  }
  ```
  其中 `parameters` 由 Zod 4 的 `z.toJSONSchema(TOOL_INPUT_SCHEMAS[name])` 直接生成。

### 5.2 浏览器端循环与降级（`byokClient.ts`、`sseParser.ts`、`useDifyChat.ts`）

1. **工具发现与无后端降级**：BYOK 发送消息前请求同源 `GET /api/tools`（仅携带同源会话 Cookie，绝不向任何 `/api/*` 发送读者密钥）。若站点未部署 `lecture-api`（`404`、非 2xx、网络错误）或返回空工具列表，请求直接按既有逻辑发送，不附带 OpenAI `tools` 字段。
2. **多轮函数调用（最多 `maxSteps` 次模型调用）**：
   - 存在可用工具时，向读者选择的 OpenAI 兼容接口附带 `tools: [{ type: 'function', function: { name, description, parameters } }]`。
   - `sseParser.ts` 解析 `delta.tool_calls` 分片与 `finish_reason`，`createOpenAiToolCallAccumulator` 按 `index` 拼合流式工具名与参数 JSON。
   - 若模型返回 `tool_calls` 且当前步数小于 `maxSteps`：浏览器逐个同源调用 `POST /api/tools/<name>`（非 2xx 或执行报错转成 `{"error":"<code>"}`），追加一条 `assistant(tool_calls)` 消息与各条 `tool(tool_call_id, content)` 消息后发起下一次模型请求；达到 `maxSteps` 次模型调用上限时停止继续发请求并干净结束流。
3. **共用进度展示（双皮肤）**：`ChatContainer.vue` 在 `.assistant-content-wrapper` 内统一渲染 `msg.toolCalls` 胶囊条（`.ai-tool-calls` / `.ai-tool-pill` / `.ai-tool-mark`），遵循 the spec board 的 `--lec-*` 契约变量与双皮肤样式（`reader` 圆角胶囊、`datasheet` 等宽方角标签），同时服务**本机/托管原生通道的 `event: tool_call`** 与 **BYOK 浏览器工具循环**；仅显示工具名与运行/完成/受限状态，绝不展示工具参数或返回值。
