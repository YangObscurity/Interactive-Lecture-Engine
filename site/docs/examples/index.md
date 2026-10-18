---
title: "开源示例讲义套件 · 开箱即用示范"
order: 0
description: "可交互工程讲义渲染引擎官方示例目录与全功能特性展示"
outline: deep
---

# 开源示例讲义套件 · 开箱即用示范

> 本目录为**解耦渲染引擎自带的通用开箱即用示例套件**。无需装载任何私有讲义，直接运行即可完整演示全部交互图表、LaTeX 公式构建期渲染、出版级 A4 多页导出、全景长图切片与折叠自测题组件。

---

## 示例讲义目录与快捷入口

你可以通过以下卡片入口直达各个示范章节与功能验证页：

<div class="portal-card-grid">
  <a href="./g01/" class="portal-card">
    <div class="portal-card-header">
      <span class="portal-card-icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
        </svg>
      </span>
      <span class="portal-card-title">示例课程组 · 章节导览与能力矩阵</span>
      <span class="portal-card-badge">基准示例</span>
    </div>
    <div class="portal-card-desc">
      演示内容源物理分离契约、双向图表锚点校验与全量前端渲染能力。
    </div>
    <div class="portal-card-footer">
      <span>查看导览大纲 →</span>
    </div>
  </a>

  <a href="./g01/L01" class="portal-card">
    <div class="portal-card-header">
      <span class="portal-card-icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
      </span>
      <span class="portal-card-title">第 1 讲 · 用 LED 与限流电阻理解欧姆定律</span>
      <span class="portal-card-badge">综合实战</span>
    </div>
    <div class="portal-card-desc">
      涵盖标准三类交互图表（Mermaid 关系流图、ECharts 伏安特性曲线、WaveDrom 硬件数字时序）、构建期 KaTeX 渲染（行内与行间公式）、矢量波形对比卡片与虚拟示波器视窗。
    </div>
    <div class="portal-card-footer">
      <span>进入本讲阅读 →</span>
    </div>
  </a>

  <a href="./feature-check/L02" class="portal-card">
    <div class="portal-card-header">
      <span class="portal-card-icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 2v7.31L4.1 20.08A2 2 0 0 0 5.8 23h12.4a2 2 0 0 0 1.7-2.92L14 9.31V2"/>
          <line x1="8.5" y1="2" x2="15.5" y2="2"/>
          <line x1="6.8" y1="16" x2="17.2" y2="16"/>
        </svg>
      </span>
      <span class="portal-card-title">渲染引擎全功能特性自检与边界压力测试</span>
      <span class="portal-card-badge">质量闸门</span>
    </div>
    <div class="portal-card-desc">
      针对深浅色模式自愈、极值视口尺寸、多阶段折叠自测题（<code>::: details</code>）以及跨页截断防护进行深度测试。
    </div>
    <div class="portal-card-footer">
      <span>进入特性自检 →</span>
    </div>
  </a>
</div>

---

## 引擎核心技术特性一览

| 核心特性 | 技术方案 | 优势与效果 |
| :--- | :--- | :--- |
| **原生可交互图表** | ECharts / Mermaid / WaveDrom | 默认内联优雅展示，单击即刻进入全景自适应全屏层；支持深色模式重绘自愈与 `containLabel` 自动防贴边 |
| **构建期 KaTeX 渲染** | `math.mts` + KaTeX SSR | 服务端渲染 MathML + HTML，首屏零闪烁、零抖动；公式节点原生支持点击复制 LaTeX 源码 |
| **双模式出版级导出** | `LectureExportButton.vue` | 提供 **出版级 A4 多页 PDF**（严格断言元素防截断）与 **卷轴式单页长卷**，彻底消除末尾空白与截断现象 |
| **全景高清长图** | 离线 Canvas 自适应切片 | 带毛玻璃 HUD 进度环遮罩，沙箱隔离不破坏可见页面，突破浏览器 16384px 硬件纹理截断限制 |
| **内容与引擎物理解耦** | `groups.mts` 动态候选回退链 | 业务讲义与通用引擎完全分离，支持通过插拔脚本一键挂载与安全脱敏清零 |

---

## 如何接入您自己的讲义

若需要将您自己的课程内容接入本引擎，只需遵循标准的目录组织结构：
1. 在 `site/docs/` 下创建您的课程子目录（如 `my-course/`）；
2. 撰写符合 Markdown 规范的正文 `L01.md`，并在文末保持独立的 `## 下一讲预告`；
3. 将配套图表 JSON 放入 `site/docs/public/charts/`；
4. 运行 `npm run dev` 即可享受毫秒级热重载（HMR）编写体验。
