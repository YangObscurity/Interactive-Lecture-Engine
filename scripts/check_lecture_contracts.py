# -*- coding: utf-8 -*-
"""check_lecture_contracts.py — 讲义结构契约自检

解决一个真实风险：AGENTS.md 里「L08/L09 豁免 §5.4 下一讲预告」只是**文字规范**，
没有任何脚本知道这件事；未来任何遍历 L*.md 的自动化校验都会把 L08/L09 判为缺项。

用法：
    python scripts/check_lecture_contracts.py                # 全站
    python scripts/check_lecture_contracts.py --group spi    # 单组
    python scripts/check_lecture_contracts.py --md           # 只查源码（不依赖 dist）

退出码：0 = PASS；1 = 有 FAIL
"""
import argparse
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parents[1]
DOCS = REPO / "site" / "docs"

# ── 豁免白名单（唯一真源；与 AGENTS.md §5.5 对应，改这里要同步改规则）──────────
EXEMPT_TEASER = {
    "spi/L08",  # 会议论文编写大章：非教学序列
    "spi/L09",  # 证据库：非教学序列
}
EXEMPT_NEXT_LINK = EXEMPT_TEASER  # 同上，不要求指向"下一讲"

TEASER = "## 下一讲预告"
FM_RE = re.compile(r"\A---\n(.*?)\n---\n", re.S)
FENCE_RE = re.compile(r"^```(.*)$")


def count_pipes(line: str) -> int:
    """只统计**未转义且在行内代码之外**的竖线。

    真实讲义里大量出现 `\\|`（表格转义）与 `|F_k|`（数学绝对值）、
    `\\|w \\odot S\\|_2`（范数），朴素的 line.count("|") 会把它们当列分隔符，
    从而把正确表格误判为"列数不一致"。
    """
    n, in_code, i = 0, False, 0
    while i < len(line):
        ch = line[i]
        if ch == "`":
            in_code = not in_code
        elif ch == "|" and not in_code:
            if not (i > 0 and line[i - 1] == "\\"):
                n += 1
        i += 1
    return n


def check_file(path: Path, group: str, is_last: bool = False):
    key = f"{group}/{path.stem}"
    src = path.read_text(encoding="utf-8", errors="replace")
    fails, warns = [], []

    m = FM_RE.match(src)
    if not m:
        fails.append("缺 frontmatter")
        fm = ""
    else:
        fm = m.group(1)

    tm = re.search(r"^title:\s*(.+)$", fm, re.M)
    if not tm:
        fails.append("frontmatter 缺 title")
    elif not tm.group(1).strip().startswith('"'):
        fails.append("title 未用英文双引号包裹")

    if not re.search(r"^order:\s*\d+\s*$", fm, re.M):
        fails.append("frontmatter 缺 order（须为整数）")

    if TEASER not in src and key not in EXEMPT_TEASER and not is_last:
        fails.append("缺「## 下一讲预告」（且不在豁免白名单，也不是本组最后一讲）")

    if re.search(r"<a\s[^>]*href=\"https?://", src):
        fails.append("正文出现裸 <a href=\"http…\">（应改 .cite 胶囊）")

    if "{{" in src:
        warns.append("含「{{」：确认不是 Vue 插值误触发（代码块内可忽略）")

    # 代码围栏语言标签
    in_fence, no_lang = False, 0
    for line in src.splitlines():
        f = FENCE_RE.match(line.strip())
        if f:
            if not in_fence and not f.group(1).strip():
                no_lang += 1
            in_fence = not in_fence
    if no_lang:
        warns.append(f"{no_lang} 个代码围栏未标语言")

    # 表格列数守恒（按未转义、非行内代码的竖线计数；跳过代码围栏内 ASCII 框图）
    bad_tables = 0
    lines = src.splitlines()
    in_table_fence = False
    i = 0
    while i < len(lines) - 1:
        if FENCE_RE.match(lines[i].strip()):
            in_table_fence = not in_table_fence
            i += 1
            continue
        if in_table_fence:
            i += 1
            continue
        if lines[i].lstrip().startswith("|") and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1] or ""):
            cols = count_pipes(lines[i])
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                if count_pipes(lines[j]) != cols:
                    bad_tables += 1
                j += 1
            i = j
        else:
            i += 1
    if bad_tables:
        fails.append(f"{bad_tables} 行表格列数与表头不一致")

    return key, fails, warns


def strip_code_and_math(text: str) -> str:
    """Remove fenced code blocks, inline code spans, and TeX math before prose checks."""
    out_lines = []
    in_fence = False
    for line in text.splitlines():
        if FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if not in_fence:
            out_lines.append(line)
    cleaned = "\n".join(out_lines)
    cleaned = re.sub(r"`[^`\n]+`", " ", cleaned)
    cleaned = re.sub(r"\$\$[\s\S]*?\$\$", " ", cleaned)
    cleaned = re.sub(r"\\\[[\s\S]*?\\\]", " ", cleaned)
    cleaned = re.sub(r"\\\(.*?\\\)", " ", cleaned)
    return cleaned


def check_concept_file(path: Path, is_draft: bool = False):
    key = f"concepts/{'_drafts/' if is_draft else ''}{path.stem}"
    src = path.read_text(encoding="utf-8", errors="replace")
    fails, warns = [], []

    m = FM_RE.match(src.replace("\r\n", "\n"))
    if not m:
        fails.append("概念页缺 frontmatter")
        fm = ""
        body = src
    else:
        fm = m.group(1)
        body = src[m.end():]

    for req_field in ("title", "term", "english", "field", "groups", "summary", "status"):
        if not re.search(rf"^{req_field}\s*:", fm, re.M):
            fails.append(f"概念页 frontmatter 缺 {req_field}")

    if re.search(r"<a\s[^>]*href=\"https?://", src):
        fails.append("正文出现裸 <a href=\"http…\">（应改 .cite 胶囊）")
    if re.search(r"\[[^\]]+\]\(https?://[^)]+\)", body):
        fails.append("正文出现 Markdown 外链 [文](http…)（应改 .cite 胶囊）")
    if "[[concept:" in src:
        fails.append("仍含旧语法 [[concept:...]]（应迁移为 [文](concept:slug)）")

    # 数学定界符检查（禁用 ```math 围栏与裸 $...$）
    in_fence = False
    has_math_fence = False
    for line in body.splitlines():
        stripped = line.strip()
        f = FENCE_RE.match(stripped)
        if f:
            if not in_fence and f.group(1).strip().lower() == "math":
                has_math_fence = True
            in_fence = not in_fence
    if has_math_fence:
        fails.append("概念页仍含 ```math 围栏（须改 LaTeX）")

    # 粗体成对闭合检查（在去除代码与公式后逐行统计未转义 **）
    prose = strip_code_and_math(body)
    unbalanced_bold = 0
    for line in prose.splitlines():
        stars = re.findall(r"(?<!\\)\*\*", line)
        if len(stars) % 2 != 0:
            unbalanced_bold += 1
    if unbalanced_bold:
        fails.append(f"{unbalanced_bold} 行粗体 ** 未成对闭合")

    # 段落出处与待核实检查
    has_unverified = "待核实" in src
    if has_unverified:
        if is_draft:
            warns.append("草稿含「待核实」标记（确认发布前须核实清除）")
        else:
            fails.append("已发布概念页仍含未解决的「待核实」标记")

    # 按段落检查：每个包含正文内容的 ##/散文节必须带出处或（仅草稿允许）待核实标记
    sections = re.split(r"(?m)^##\s+", body)
    # skip leading H1 block alone if no prose under H1; check every substantive prose section
    missing_source_sections = 0
    for idx, sec in enumerate(sections):
        sec_clean = strip_code_and_math(sec).strip()
        if not sec_clean:
            continue
        lines = [ln.strip() for ln in sec_clean.splitlines() if ln.strip()]
        if idx == 0:
            # lead block: drop "# term" line
            lines = [ln for ln in lines if not ln.startswith("# ")]
        else:
            # ## section: drop heading title line
            lines = lines[1:]
        # ignore metadata/source/unverified lines when deciding if prose exists
        prose_lines = [
            ln for ln in lines
            if not ln.startswith(">")
            and not ln.startswith("（出处")
            and not ln.startswith("(出处")
            and not ln.startswith("（来源")
            and not ln.startswith("(来源")
            and not ln.startswith("|")
        ]
        if not prose_lines:
            continue
        has_cite = ('class="cite"' in sec) or ("class='cite'" in sec) or bool(
            re.search(r"[（(](?:出处|来源)\s*[：:]", sec)
        )
        sec_unverified = "待核实" in sec
        if not has_cite and not (is_draft and sec_unverified):
            missing_source_sections += 1
    if missing_source_sections:
        fails.append(f"{missing_source_sections} 个正文节缺少段落来源标注（出处/.cite）")

    # 表格列数守恒
    bad_tables = 0
    t_lines = body.splitlines()
    in_table_fence = False
    i = 0
    while i < len(t_lines) - 1:
        if FENCE_RE.match(t_lines[i].strip()):
            in_table_fence = not in_table_fence
            i += 1
            continue
        if in_table_fence:
            i += 1
            continue
        if t_lines[i].lstrip().startswith("|") and re.match(r"^\s*\|[\s:|-]+\|\s*$", t_lines[i + 1] or ""):
            cols = count_pipes(t_lines[i])
            j = i + 2
            while j < len(t_lines) and t_lines[j].lstrip().startswith("|"):
                if count_pipes(t_lines[j]) != cols:
                    bad_tables += 1
                j += 1
            i = j
        else:
            i += 1
    if bad_tables:
        fails.append(f"{bad_tables} 行表格列数与表头不一致")

    return key, fails, warns


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default=None)
    ap.add_argument("--md", action="store_true", help="保留参数：本脚本始终查源码")
    ap.add_argument("--concepts", action="store_true", help="检查独立概念页与概念草稿")
    a = ap.parse_args()

    groups = [a.group] if a.group else [p.name for p in sorted(DOCS.iterdir()) if p.is_dir() and p.name != "concepts"]
    total = fails_n = warns_n = 0
    for g in groups:
        d = DOCS / g
        if not d.is_dir():
            continue
        files = sorted(d.glob("L*.md"))
        if not files:
            continue
        last_stem = max(files, key=lambda p: int(p.stem[1:])).stem if files else None
        print(f"\n== {g} ({len(files)} 页，最后一讲 {last_stem}) ==")
        for f in files:
            key, fails, warns = check_file(f, g, is_last=(f.stem == last_stem))
            total += 1
            warns_n += len(warns)
            if fails:
                fails_n += 1
                print(f"  FAIL {key}")
                for x in fails:
                    print(f"       - {x}")
            elif warns:
                print(f"  WARN {key}: {'；'.join(warns)}")

    concepts_dir = DOCS / "concepts"
    if (a.concepts or not a.group) and concepts_dir.is_dir():
        pub_files = sorted(f for f in concepts_dir.glob("*.md") if f.is_file())
        draft_dir = concepts_dir / "_drafts"
        draft_files = sorted(f for f in draft_dir.glob("*.md") if f.is_file()) if draft_dir.is_dir() else []
        if pub_files or draft_files:
            print(f"\n== concepts ({len(pub_files)} 已发布，{len(draft_files)} 草稿) ==")
        for f in pub_files:
            key, fails, warns = check_concept_file(f, is_draft=False)
            total += 1
            warns_n += len(warns)
            if fails:
                fails_n += 1
                print(f"  FAIL {key}")
                for x in fails:
                    print(f"       - {x}")
            elif warns:
                print(f"  WARN {key}: {'；'.join(warns)}")
        for f in draft_files:
            key, fails, warns = check_concept_file(f, is_draft=True)
            total += 1
            warns_n += len(warns)
            if fails:
                fails_n += 1
                print(f"  FAIL {key}")
                for x in fails:
                    print(f"       - {x}")
            elif warns:
                print(f"  WARN {key}: {'；'.join(warns)}")

    print(f"\nSUMMARY: {total} 页，FAIL {fails_n}，WARN {warns_n}")
    print("豁免白名单（缺「下一讲预告」不判错）：", ", ".join(sorted(EXEMPT_TEASER)))
    return 1 if fails_n else 0


if __name__ == "__main__":
    sys.exit(main())
