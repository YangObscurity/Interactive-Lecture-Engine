---
title: "缺失值"
term: "缺失值"
english: "Missing Value"
aliases: ["空值"]
field: "数据整理"
groups: ["DAT", "VIS"]
summary: "表格中本该有值、却没有记录下来的格子；它不等于零，也不等于“无”。"
status: published
generatedBy: "demo-content"
reviewedAt: "2026-01-01"
outline: deep
related:
  - { slug: tidy-data, rel: prerequisite }
---

# 缺失值

## 定义

缺失值是一条记录里某个变量本该有一个值，却没有被记录下来。它和“数值为 0”不同：0 是一次真实的测量结果，缺失表示“我们不知道”。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/missing-value" title="https://example.com/demo/concepts/missing-value">示例出处</span>）

## 为什么要区分

把缺失当成 0 去求平均，算出的平均数会被拉低；直接删掉含缺失的整行，又可能让样本偏向“记录完整的那一类人”。所以清洗时先问一句：这一格为什么是空的？（出处：<span class="cite" data-cite="https://example.com/demo/concepts/missing-value" title="https://example.com/demo/concepts/missing-value">示例出处</span>）

## 例子

一张体温记录表里，周三的读数是空的，因为那天体温计没电了。这是缺失值，应标记为“缺失”并在说明里写明原因，而不是填 0 °C。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/missing-value" title="https://example.com/demo/concepts/missing-value">示例出处</span>）
