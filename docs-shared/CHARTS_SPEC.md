# Sidecar 图表系统设计与契约规范 (Charts Specification)

> **适用范围**：讲义正文内的图表挂载锚点及其配套的 JSON 数据源。  
> **核心哲学**：正文声明式占位，配置独立 Sidecar 存储，运行时异步按需注入。

---

## 1. 架构总览与目录结构

为保持 Markdown 讲义正文的纯粹性，禁止在 Markdown 内部混合数百行复杂的图表渲染代码。所有图表均采用 **Sidecar JSON 模式** 分离维护：

```text
site/docs/
├── demo/
│   └── L01.md                 # 讲义正文：仅包含声明式 <figure class="chart"> 锚点
└── public/charts/
    └── DEMO-L01.json          # Sidecar 配置：按图表 ID 组织完整配置对象
```

---

## 2. 正文 Figure 锚点标准契约

在讲义正文中，挂载图表使用且仅使用 HTML `figure` 占位标签：

```html
<figure class="chart" data-lecture="DEMO-L01" data-id="c1" data-type="echarts"></figure>
```

### 硬性属性说明：
- **`class="chart"`**：挂载组件识别标识；
- **`data-lecture`**：对应的 Sidecar 文件名（不含 `.json` 后缀）。命名规则为 `<课程组前缀>-<讲义文件名>`（全大写）；
- **`data-id`**：图表在对应 JSON 中的唯一键名（如 `c1`, `c2`）；
- **`data-type`**：图表类型，取值必须为 `echarts`、`mermaid` 或 `wavedrom`。

> [!IMPORTANT] 格式守恒要求
> - figure 占位行前后必须各保留一个空行；
> - 绝对禁止丢失任何 figure 锚点，否则会导致前端页面图表直接缺失。

---

## 3. Sidecar JSON 规范与 Schema

每个 JSON 文件必须以图表 ID 为顶级 key。每个 key 下必须包含以下字段：

### 3.1 ECharts 规范 (`data-type="echarts"`)
```json
{
  "c1": {
    "type": "echarts",
    "title": "RC 电路瞬态响应曲线",
    "caption": "图 1.1：时间常数与充放电波形关系图",
    "height": "400px",
    "option": {
      "tooltip": { "trigger": "axis" },
      "xAxis": { "type": "category", "data": ["0", "1τ", "2τ"] },
      "yAxis": { "type": "value" },
      "series": [
        {
          "name": "电容电压",
          "type": "line",
          "data": [0.0, 3.16, 4.32]
        }
      ]
    }
  }
}
```

### 3.2 Mermaid 规范 (`data-type="mermaid"`)
```json
{
  "c1": {
    "type": "mermaid",
    "title": "系统插拔状态迁移拓扑",
    "caption": "图 2.1：从本地开发到生产发布的完整流转",
    "code": "graph LR\n    A[开发态] -->|--mount| B[挂载态]\n    B -->|--clean| C[开源态]"
  }
}
```

### 3.3 WaveDrom 规范 (`data-type="wavedrom"`)
```json
{
  "c1": {
    "type": "wavedrom",
    "title": "SPI 通信时序逻辑",
    "caption": "图 3.1：CPOL=0, CPHA=0 模式下的主从传输波形",
    "signal": [
      { "name": "SCK",  "wave": "p......." },
      { "name": "MOSI", "wave": "x3.4.5.x", "data": ["0x55", "0xAA", "0x00"] },
      { "name": "MISO", "wave": "x.3.4.5x", "data": ["0x01", "0x02", "0x03"] }
    ]
  }
}
```

---

## 4. 1:1 双向守恒契约（严格对账）

图表对账工具（`scripts/mount_content.py --verify`）会对全量页面执行以下硬性核验：
1. **存在性断言**：正文中声明的每个 `data-lecture`，必须在 `public/charts/<data-lecture>.json` 真实存在；
2. **键值匹配**：正文声明的 `data-id` 必须存在于对应 JSON 的一级 key 中；
3. **类型守恒**：正文中的 `data-type` 必须与 JSON 内部配置声明的 `type` 完全一致；
4. **零孤岛原则**：JSON 中声明的所有 key 必须在对应的 Markdown 中被引用。严禁出现未引用的冗余废弃图表。
