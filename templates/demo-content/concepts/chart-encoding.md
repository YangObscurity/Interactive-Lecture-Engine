---
title: "图形编码"
term: "图形编码"
english: "Chart Encoding"
aliases: ["视觉编码"]
field: "可视化"
groups: ["VIS"]
summary: "把数据里的一个变量对应到图上的一种视觉属性，例如位置、长度、颜色或面积。"
status: published
generatedBy: "demo-content"
reviewedAt: "2026-01-01"
outline: deep
related:
  - { slug: tidy-data, rel: prerequisite }
---

# 图形编码

## 定义

图形编码是“数据变量 → 视觉属性”的对应关系。条形图用长度编码数量，折线图用纵向位置编码数值、用横向位置编码时间，分组用颜色编码类别。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/chart-encoding" title="https://example.com/demo/concepts/chart-encoding">示例出处</span>）

## 哪些属性读得准

人眼比较同一基线上的位置和长度最准，比较角度和面积要差一些，比较颜色深浅更差。所以要精确比较的量放在位置或长度上，颜色更适合区分类别或突出重点。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/chart-encoding" title="https://example.com/demo/concepts/chart-encoding">示例出处</span>）

## 例子

六个类别的数量画成饼图，是用角度编码数量；改成排好序的条形图，是用长度编码数量。后者更容易看出相差不多的几个类别谁大谁小。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/chart-encoding" title="https://example.com/demo/concepts/chart-encoding">示例出处</span>）
