---
title: "整洁数据"
term: "整洁数据"
english: "Tidy Data"
aliases: ["长表"]
field: "数据整理"
groups: ["DAT", "VIS"]
summary: "每一行是一条观测、每一列是一个变量、每个格子只放一个值的表格形状。"
status: published
generatedBy: "demo-content"
reviewedAt: "2026-01-01"
outline: deep
related: []
---

# 整洁数据

## 定义

整洁数据是一种约定的表格形状：每一行是一条观测，每一列是一个变量，每个格子只放一个值。满足这三条的表，筛选、分组、汇总和画图都可以用同一套做法。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/tidy-data" title="https://example.com/demo/concepts/tidy-data">示例出处</span>）

## 宽表与长表

把每个月放成一列的“宽表”适合人眼逐月比较，但“月份”这个变量被藏进了列名里。把它拉成“班级、月份、数量”三列的“长表”，月份重新成为一列，表就整洁了。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/tidy-data" title="https://example.com/demo/concepts/tidy-data">示例出处</span>）

## 例子

一个格子里写着“3 本（含 1 本漫画）”，同时放了数量和类别两个值。拆成“数量”和“其中漫画”两列之后，才能对它求和。（出处：<span class="cite" data-cite="https://example.com/demo/concepts/tidy-data" title="https://example.com/demo/concepts/tidy-data">示例出处</span>）
