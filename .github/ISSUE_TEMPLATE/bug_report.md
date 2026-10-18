---
name: Bug 报告
about: 报告一个可复现的缺陷
title: '[Bug] '
labels: ['bug']
assignees: ''
---

<!--
提交前请先搜索现有 issue，避免重复。
⚠️ 请勿粘贴任何密钥、令牌或私钥。
-->

## 缺陷描述

<!-- 一句话说清楚：什么坏了 -->

## 复现步骤

1.
2.
3.

## 期望行为

<!-- 你预期会发生什么 -->

## 实际行为

<!-- 实际发生了什么；有报错请贴完整堆栈 -->

## 环境信息

| 项目 | 值 |
| --- | --- |
| 操作系统 | <!-- 例如 Windows 11 / Ubuntu 22.04 / macOS 14 --> |
| Node.js 版本 | <!-- node --version --> |
| npm 版本 | <!-- npm --version --> |
| Python 版本 | <!-- python --version --> |
| 浏览器（若前端问题） | <!-- 例如 Chrome 120 --> |

## 涉及范围

<!-- 勾选受影响的区域 -->

- [ ] 站点构建（`npm run build`）
- [ ] 开发服务器 / 热重载（`npm run dev`）
- [ ] 图表渲染（mermaid / echarts / wavedrom）
- [ ] 数学公式（KaTeX）
- [ ] 主题与样式
- [ ] 质量闸门脚本（`scripts/`）
- [ ] 文档
- [ ] 其他：

## 质量闸门输出

<!-- 若与闸门相关，请贴出实际输出 -->

```
python scripts/test_angle.py
```

```
python scripts/check_figs2.py
```

```
python scripts/check_body_links.py
```

## 补充信息

<!-- 截图、最小复现仓库、相关链接等 -->
