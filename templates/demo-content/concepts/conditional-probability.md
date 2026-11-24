---
title: "条件概率"
term: "条件概率"
english: "Conditional Probability"
aliases: ["条件机率"]
field: "概率"
groups: ["PRB"]
summary: "已知事件 B 发生时事件 A 发生的概率，记作 P(A | B)，等于 P(A 且 B) 除以 P(B)。"
status: published
generatedBy: "demo-content"
reviewedAt: "2026-11-23"
outline: deep
related: []
---

# 条件概率

## 定义

条件概率 \(P(A \mid B)\) 是在已知 \(B\) 发生的前提下 \(A\) 发生的概率。只要 \(P(B) > 0\)，就有 \(P(A \mid B) = P(A \cap B)/P(B)\)：只在 \(B\) 成立的那部分结果里重新计算 \(A\) 所占的比例。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/conditional-probability" title="https://example.com/demo/concepts/conditional-probability">示例出处</span>）

## 例子

两颗骰子之和至少为 10 的结果有 6 个，其中第一颗为 6 的有 3 个，所以 \(P(\text{第一颗为 } 6 \mid \text{和} \ge 10) = 1/2\)，比不知道条件时的 \(1/6\) 大。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/conditional-probability" title="https://example.com/demo/concepts/conditional-probability">示例出处</span>）

## 注意

\(P(A \mid B)\) 与 \(P(B \mid A)\) 一般不相等。检测、筛查类问题里把两者混淆，是最常见的错误；把概率换成个数列成表格最稳妥。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/conditional-probability" title="https://example.com/demo/concepts/conditional-probability">示例出处</span>）
