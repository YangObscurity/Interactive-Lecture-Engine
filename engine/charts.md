# 图表运行时（charts.ts）深度说明

> TL;DR：全站 639 张图（mermaid / echarts / wavedrom 三类）共用同一套骨架与工具条；
> **内联只允许「单击放大」，缩放/拖动只在全屏层解锁**；
> 结构、按钮、交互全部集中在 `charts.ts` 的**单一来源常量**里，讲义 md 只写一行 figure。

## 1. 单一来源常量

```ts
const TAG_LABEL = { mermaid:'流程图 / 关系图', echarts:'数据图表', wavedrom:'时序 / 波形图' }

const TOOLS_BY_TYPE = {
  mermaid:  ['expand','src'],        // 内联只有「全屏放大」与「源码」
  wavedrom: ['expand','src'],
  echarts:  ['expand','src'],
}
const TOOL_DEFS = { expand:['expand','全屏放大查看','&#8599;'], src:['src','查看图表源码','{ }'] }
```

`ensureSkeleton(fig)` 每次都**重建** `figcaption`，所以改常量立刻对 20 讲 63 张图生效。
`body` / `id` 只在缺失时创建（幂等）。

## 2. 骨架与事件绑定

- `id` 运行时生成为 `fig-<data-lecture>-<data-id>`（迁移前 md 里手写；已验证**正文 0 处 `#fig-` 锚点引用**，可安全改为运行时生成）。
- 点击事件用**事件委托绑在 `figure` 上**，`data-tools-bound` 防重复绑定 —— 因为工具条会被 `ensureSkeleton` 重建，绑在按钮上的监听会失效。
- `figStates = WeakMap<HTMLElement, {api, extra}>` 保存每个图的缩放/尺寸/销毁句柄，供工具条与全屏弹层共用。

## 3. 交互语义：内联只准「单击放大」，全屏才解锁缩放/拖动 ★

| 手势 | 内联视图 | 全屏层 |
|---|---|---|
| 滚轮 | **禁用**（不缩放，也不拦页面滚动） | 缩放 |
| 拖动 | **禁用** | 平移（改 `scrollLeft/Top`，光标 `grab`） |
| 单击图表本体 | **进全屏**（内联唯一交互） | **关闭**（全屏唯一退出手势） |
| `＋ / － / ↺` | 无这些按钮 | 顶栏按钮（围绕视口中心缩放 / 回到自适应视图） |
| `Esc` | — | 关闭 |

- 内联 `.chart-body` 光标为 `zoom-in`（提示"点开看大图"）；全屏舞台为 `grab`。
- **echarts 例外**：单击落在「绘图区之外」（图例 / 工具箱 / 坐标轴）时**不进全屏**，
  把这一步交回 echarts —— 保住图例开关、保存图片等原生交互（判据 `chart.containPixel({gridIndex:0}, pt)`）。
- 全屏里「单击关闭」与「拖动平移」用**位移阈值 6px** 区分：拖动过就不算单击，不会误关。
- 历史：内联原先用 `makeZoomable` 绑过 wheel / drag / dblclick（滚轮就把图缩放了、极易误触），已整体移除。

### 3.1 缩放后端（按类型）

| 类型 | 内联 | 全屏 |
|---|---|---|
| mermaid / wavedrom | 无缩放 | `makeSvgSizeZoom`：直接设 SVG 的 `width`/`height`（矢量无损） |
| echarts | 无缩放 | `makeEchartsZoom`：改容器真实尺寸 + `chart.resize()`（canvas 拉伸会糊） |

> 历史上 echarts 内联曾提供 `＋/－`，因容器宽度受版心限制（硬撑会横向溢出、纵向加高并非"放大"）
> 已撤掉；内联的缩放/复位入口现在**全部**收进全屏层。

### 3.2 内联矢量图自适应（`fitInlineSvg`）★

内联已无缩放交互，所以渲染完**一次算好**尺寸，并随容器宽度变化重算：

| 规则 | 说明 |
|---|---|
| **适宽** | `scale = min(1, 容器宽 / 自然宽)` —— **只缩小、绝不放大**（放大既失真，又会让长流程图长度爆炸） |
| **高度** | 按同一比例跟随、**不设上限** —— 原先 `max-height:72vh` 会把长流程图底部整块切掉 |
| **居中** | SVG 设 `display:block; margin:0 auto`（不依赖父级 `text-align`） |
| **何时重算** | 仅当**容器宽度**变化（`ResizeObserver`）—— 否则"设置高度"会反过来触发观察者**自激** |
| **弹层期间** | 跳过（弹层由 `fitToStage` 负责）；`closeModal` 后 `force` 重算一次 |
| **断言** | `site_audit.py` 每图检查：`svg 宽 ≤ 容器宽`、`scrollHeight ≤ clientHeight`（不裁剪）、水平偏移 ≤ 4px |

## 4. 全屏放大弹层（`openChartModal`）

**核心设计：把已渲染的 `.chart-body` 整体搬进弹层，不重渲染；关闭时原样搬回。**

- 好处：mermaid/wavedrom 的 SVG 与 echarts 实例都随节点移动，无需二次初始化；`ResizeObserver` 自动重排。
- **全屏铺满**：`.chart-modal` 是 `position:fixed; inset:0` + 不透明 `--vp-c-bg`，**没有半透明 backdrop、没有圆角面板、没有边距**。
  原因：只在局部弹出会同时暴露原页面的侧栏/大纲，干扰阅读（用户明确反馈的可用性问题）。
- 结构：遮罩 `.chart-modal` → 面板 → 顶栏（左标题 + 右 `＋ － ↺ ✕`）→ 舞台 `.chart-modal__stage`（`display:flex; overflow:auto`）→ 临时 `figure.chart--modal`（`margin:auto` 居中，超出时不像 grid 那样裁掉起始端）。
- 关闭：**单击（主手势）** / `Esc` / `✕`；恢复 body 到原位、清内联尺寸、`resize`、解除 `html.chart-modal-open` 的滚动锁。
- 拖动平移：舞台 `mousedown` 起手，`mousemove` 改 `scrollLeft/Top`，`mouseup` 收手；**位移 > 6px 即标记为拖动**，此时不触发"单击关闭"。
- SPA 换页保护：`initCharts` 开头若发现弹层宿主已脱离文档则先关。

### 4.1 打开即自适应（fitToStage）

打开时按可用区域等比缩放到**整幅完整可见**，而不是默认显示某个局部：

```ts
const s = Math.min((stage.clientWidth - pad) / nat.w, (stage.clientHeight - pad) / nat.h)
api.zoomTo(s)
```

`reset`（↺）的语义也是**回到这个自适应视图**，不是回到 1:1 —— 否则用户按复位会得到一个比打开时更糟的画面。

### 4.2 矢量图必须"改实际尺寸"，不能用 transform ⚠️

这是三个可用性问题的**共同根因**：

| 症状 | 成因 |
|---|---|
| 打开就是放大的某个局部 | 没有 fit 步骤 |
| 放大后底部滚动条"固定死、不动" | `transform: scale()` 只改视觉，**布局尺寸仍是最初尺寸**，舞台的 `scrollWidth` 与看到的画面对不上 |
| 弹层只占局部，损耗可读性 | 半透明 backdrop + 圆角面板 |

因此 mermaid / wavedrom 在弹层里改用 `makeSvgSizeZoom`：**直接设 SVG 的 `width`/`height`**，
布局尺寸与视觉尺寸始终一致，滚动条/居中/自适应全部对得上。
`closeModal` 里必须把 svg 的内联 `width/height/maxWidth` 清空，否则回到内联版式会被撑坏。

echarts 仍走 `makeEchartsZoom`（改容器尺寸 + `chart.resize()`），因为 canvas 拉伸会糊。

### 4.3 围绕视口中心缩放

先记录中心点在内容中的相对位置，`api.zoom()` 后**同步**还原。
⚠️ 必须同步 —— 包进 `rAF` 时连续快速点击的第二次会基于上一次尚未生效的 `scrollWidth` 算比例，
导致放大后偏心（实测 `scrollL` 停在 231 而非理论值 518）。

### 4.4 断言基线（`scripts/modal_fit_audit.py`）

| 断言 | 实测（1440×900 视口） |
|---|---|
| 遮罩铺满视口 | `1416×801` = 视口 ✓ |
| 矢量图打开即整幅可见 | svg `1392×399` ≤ 可用 `1400×740`，**初始无滚动条** ✓ |
| 放大后滚动条与画面一致 | `scrollW 2368 ≥ svgW 2352` ✓ |
| 复位回到自适应 | `1392×399`（非 1:1）✓ |
| echarts 居中精确 | `scrollL 479 / scrollT 252` = 理论值 ✓ |
| 关闭还原 | svg 内联尺寸清空 ✓ |

## 5. `normalizeEchartsLayout` —— 修元素重叠（通用）

**根因**：ECharts 里 `title` 与 `legend` 的默认位置都是 `top:0, left:center`。
只要源码 JSON 没显式写 `top`，两者就画在同一坐标上。

**实测规模**：22 张 echarts 中 **10 张**命中该冲突（L01#c3、L04#c2/c3、L05#c1、L06#c1、
L07#c1、L08#c3、L09#c2、L10#c2、L12#c3）—— 不是单张图的问题。

**四步归一（只下移、不上移，不破坏手工布局）**：
1. 标题：`top` 缺省补 4、`left` 缺省补 center，并按宽度估算占几行 → 得 `titleBottom`（含 `subtext`）。
2. 图例：未写 `top` 就放到 `titleBottom`；写了但小于 `titleBottom` 则下移 → 得 `legendBottom = top + 30`（单行 + 窄屏折两行余量）。
3. 绘图区：`grid.top` 若为空或小于 `legendBottom + 12`，抬到该值。
4. x 轴名称：默认 `nameLocation:'end'` 画在轴线末端，`grid.right` 不够会被容器裁掉（原截图右缘只剩"上拉阻"）→ 按 `字数 × fontSize + 24` 补足右边距。

**几何约束**：`titleBottom ≤ legendTop ≤ legendBottom ≤ gridTop`。

**已验证**：对全部 22 张 echarts 做离线几何断言，**修复后 0 张失败**；
手工调过 `top` 的（L13#c2、L15#c4、L17#c1、L20#c1）位置被正确保留或仅在真重叠时下移。
脚本：`_temp/layout_audit.py`（用法见 `ops/README.md`）。

## 6. 图表状态机

`data-chart-status`：`loading` → `ok` | `missing`（md 的 `data-id` 不在 JSON）| `error`（渲染抛异常）| `unknown-type`。
加载占位 `.chart-pending` 便于区分"fetch 卡住"与"渲染卡住"。

**全量回归基线（2026-10-04）**：20 讲逐讲打开，**63/63 `ok`**、工具条 63/63 与类型匹配、
`__CHARTS_DONE__=true`、沉浸按钮存在、仅剩既有的 `favicon.ico` 404。

## 7. 相关踩坑

- `renderEcharts` 原先传给工具条的 api 只有 `{reset}`，`zoom-in/out` 无处理器 → **死按钮**，现已按类型裁撤。
- 弹层里 `figure.chart--modal[data-type] .chart-body` 与内联规则**优先级相同**，靠书写顺序在后胜出；用 `!important` 会连内联缩放一起压掉。
- echarts 的 `toolbox` 默认 `right:10, top:6`（右上），标题居中且不超宽时不会冲突，故未额外处理。

---

## 8. ⚠️ 正文行高绝不能波及图表（2026-10-07 实测事故）

**现象**：把正文行高统一到 2.35（`--lec-prose-line-height`）后，mermaid 流程图**节点文字失去垂直居中、
溢出节点框**（用户报「mermaid 字体没有居中，偏移了」）。

**根因**：mermaid v11 的标签结构是

```
<foreignObject> → <div> → <span class="nodeLabel"> → <p>（每一行文字一个 <p>）
```

而该规则 `figure.chart…` 之外的 `.vp-doc p { line-height: … }` **正好命中这个 `<p>`**：
实测其 `line-height` 由 mermaid 预期的 **24px** 被顶到 **37.6px** → 标签块高度超出节点框、
文字整体下坠并溢出。

**修法**：图表内部一律用自己的行高，与正文行高**解耦**：

```css
:root { --lec-chart-line-height: 1.5; }          /* = 改动前的 24px@16px */
figure.chart .chart-body,
figure.chart .chart-body * { line-height: var(--lec-chart-line-height); }
```

**回归闸门**（已加入工具链）：

```bash
# 若你自备了「图表文字居中」检查脚本（本仓库不含该脚本，
# 它属维护者的私有工具链），可在构建后自行运行。
# 本仓库内的等价保障：AGENTS.md §2.4 的「图表豁免」契约 +
# scripts/audit_visual.py 的居中偏差断言。
```

判据：① 每个 `g.node` 的「标签块中心 vs 节点形状中心」偏差 ≤ 1px（垂直）/ ≤ 2px（水平）；
② 标签 `<p>` 的 line-height **不得**等于正文行高（相等即豁免失效）；③ 每个 figure 都渲染出内容。
**防假通过**：测量数为 0 时直接判 FAIL（曾因选择器写成 `closest('g')` 而静默报 0 测量）。

实测（修复后）：多个讲次的全部节点偏差 0.00px，全部 PASS。
