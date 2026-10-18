# -*- coding: utf-8 -*-
"""math_guard.py — 内容管线的**数学区间免疫**（第 13 步 · M3，2026-10-07 新增）。

为什么需要：站点启用构建期 KaTeX 之后，散文级安全规则会**反过来改写 LaTeX**：
  · `sanitize_angle()` / `fix_content.escape_lt()` 把散文里 `<`+字母 转成 `&lt;`
    → `\\(a < b\\)` 被改成 `\\(a &lt; b\\)`，公式直接编译失败；
  · `protect_vue()` 在连续 `{{` 之间插零宽空格（U+200B）
    → `\\(\\frac{{a}}{{b}}\\)` 被插进不可见字符，KaTeX 报错；
  · `normalize_md()` 的粗体 flanking 修复会改写 `**`。

做法：把**数学区间**（行内 `\\(…\\)`、行间 `\\[…\\]` 与 `$$…$$`）从散文里切出来，
凡是"改写散文"的规则一律跳过这些片段。

⚠️ 刻意为**不接管**的形态：` ```math ` 围栏（历史 ASCII 公式，走代码块通道，本来就不受影响）
   与裸 `$…$`（本站散文含美元符号，见 MATH_MIGRATION.md）。
"""
import re

MATH_SPAN = re.compile(r"\\\(.*?\\\)|\\\[.*?\\\]|\$\$.*?\$\$", re.S)


def split_math(line: str):
    """把一行切成 [(片段, 是否数学区间), …]。数学区间必须原样保留、不许被改写。"""
    out, pos = [], 0
    for m in MATH_SPAN.finditer(line):
        if m.start() > pos:
            out.append((line[pos:m.start()], False))
        out.append((m.group(0), True))
        pos = m.end()
    if pos < len(line):
        out.append((line[pos:], False))
    return out or [(line, False)]


def has_math(line: str) -> bool:
    return bool(MATH_SPAN.search(line))


def math_with_breaks(line: str):
    """返回 (数学区间列表, 其中内含 `<`+字母 或 `{{` 的片段列表) —— 供闸门告警。"""
    spans = [m.group(0) for m in MATH_SPAN.finditer(line)]
    risky = [s for s in spans
             if re.search(r"(?<!\\)<(?=[A-Za-z_])", s) or "{{" in s or "**" in s]
    return spans, risky
