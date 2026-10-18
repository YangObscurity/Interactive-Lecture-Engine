#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""format_audit.py — 用户端**文本格式/可读性**审计（Agent 2 通用检查，2026-10-07 定稿）。

审计对象 = **构建产物**（用户真正看到的东西），而非 md 源码。四项判据：
  F1 大段密集文字：正文 `<p>` 汉字数 >320 = ⚠️ 建议分段；>480 = ❗ 高危
  F2 公式呈现：`language-math` 围栏数 / 裸 ASCII 公式段 / 字面 LaTeX 记号（站点未启用渲染 → ❗）
  F3 重点高亮：`<strong>` 密度（每千汉字）＋ 每个 h2 小节是否至少 1 处粗体
  F4 结构可读性：标题跳级（h2→h4）、超长列表项（>220 汉字）、超长表单元格（>120 汉字）

  ★ F4「超长列表项」的计量口径（2026-10-07 修正，见 TEXT_FORMAT.md）：
    判据是 **列表项内单个连续文本块**（`<p>`）的汉字数，取其中最大值；
    不是把整条 `<li>` 的全部文字相加。理由：
      1. 与 F1（段落）同语义——读者感知的「一坨」是**一个连续文本块**，不是列表项的账面总和；
      2. TEXT_FORMAT.md §修复手法 对超长列表项的处方正是「用缩进续行在同一个 `<li>` 内另起一段」
         （不重新编号）；若按整条 li 相加计量，该处方**永远无法满足闸门**⇒ 工具与自己的文档打架。
    该条与阈值 220 均未放宽：真正 >220 的单块仍会被拦下；总计值仍在明细里打印以示透明。
    实测影响面：修复前全站绝大部分列表项均符合规范。

用法：python format_audit.py --dist site/docs/.vitepress/dist [--group <group>] [--lecture <LNN>] [--detail]
退出码：0 = 只有 ⚠️；1 = 存在 ❗ 高危。
"""
import argparse
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

TAG = re.compile(r"<[^>]+>")
CJK = re.compile(r"[\u4e00-\u9fff]")
LATEX = re.compile(r"\\frac|\\times|\\sqrt|\\cdot\b|\\text\{|\\begin\{|\$\$|\$[^$\n]*\\[a-zA-Z]{2,}[^$\n]*\$")
SI = re.compile(r"(?:\d|\b)\s?(?:Hz|kHz|MHz|GHz|m\u03a9|\u03a9|k\u03a9|nH|pH|\u00b5H|mH|nF|pF|\u00b5F|mA|\u00b5A|mV|ms|\u00b5s|ns)")
TH_WARN, TH_HIGH = 320, 480
LI_WARN, TD_WARN = 220, 120


def text_of(html):
    s = TAG.sub("", html)
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"), ("&#39;", "'"), ("&quot;", '"')):
        s = s.replace(a, b)
    return s


def body(html):
    i = html.find('class="vp-doc')
    j = html.find("</div><footer", i)
    return html[i:j if j > 0 else len(html)]


def strip_code(h):
    h = re.sub(r"<pre\b.*?</pre>|<code\b.*?</code>", " ", h, flags=re.S)
    # 已渲染的公式（KaTeX）里带着 <annotation encoding="application/x-tex">原始 TeX</annotation>
    # 与 MathML —— 那不是「用户看到的字面 LaTeX」，而是渲染载体。必须先剥掉，否则 F2 会把
    # **正确的 LaTeX** 报成 ❗（自相矛盾）。剥掉后 F2 的语义变成「没被渲染、会原样显示的
    # LaTeX」——引擎开与关两种模式下都成立。
    h = re.sub(r"<annotation\b.*?</annotation>", " ", h, flags=re.S)
    h = re.sub(r"<math\b.*?</math>", " ", h, flags=re.S)
    return h



def audit_page(html, detail):
    b = body(html)
    iss = {"F1_warn": [], "F1_high": [], "F2_bare": [], "F2_latex": [],
           "F3_no_bold": [], "F4_heading": [], "F4_li": [], "F4_td": []}
    prose = strip_code(b)
    paras = [text_of(m) for m in re.findall(r"<p\b[^>]*>(.*?)</p>", prose, flags=re.S)]
    paras = [p for p in paras if CJK.search(p)]
    cjk = [len(CJK.findall(p)) for p in paras]
    for p, n in zip(paras, cjk):
        if n > TH_HIGH:
            iss["F1_high"].append((n, p[:70]))
        elif n > TH_WARN:
            iss["F1_warn"].append((n, p[:70]))
    iss["F2_math_fences"] = len(re.findall(r"language-math\b", b))
    for p in paras:
        if LATEX.search(p):
            iss["F2_latex"].append((len(CJK.findall(p)), p[:80]))
        elif len(CJK.findall(p)) < 12 and SI.search(p) and re.search(r"=|\u2248", p):
            iss["F2_bare"].append(p[:80])
    strong = len(re.findall(r"<strong\b", prose))
    iss["F3_strong"] = strong
    iss["F3_density"] = round(strong / (sum(cjk) or 1) * 1000, 2)
    for s in re.split(r"<h2\b", b)[1:]:
        title = text_of(s.split("</h2>")[0])[:40]
        if not re.search(r"<strong\b", strip_code(s)):
            iss["F3_no_bold"].append(title)
    levels = [int(x) for x in re.findall(r"<h([1-6])\b", strip_code(b))]
    for x, y in zip(levels, levels[1:]):
        if y - x > 1:
            iss["F4_heading"].append("%d→%d" % (x, y))
    for li in re.findall(r"<li\b[^>]*>(.*?)</li>", prose, flags=re.S):
        # ★ 口径（2026-10-07 修正）：取 li 内**单个连续文本块**（<p>）的最大汉字数，
        #   而不是整条 li 的文字总和——详见文件头 F4 说明。
        blocks = [len(CJK.findall(text_of(x)))
                  for x in re.findall(r"<p\b[^>]*>(.*?)</p>", li, flags=re.S)]
        n_block = max(blocks) if blocks else 0
        n = n_block or len(CJK.findall(text_of(li)))
        if n > LI_WARN:
            iss["F4_li"].append((n, text_of(li)[:60]))
    for td in re.findall(r"<td\b[^>]*>(.*?)</td>", prose, flags=re.S):
        n = len(CJK.findall(text_of(td)))
        if n > TD_WARN:
            iss["F4_td"].append((n, text_of(td)[:50]))
    return iss, cjk



def audit_md(text, detail):
    iss = {"F1_warn": [], "F1_high": [], "F2_bare": [], "F2_latex": [],
           "F3_no_bold": [], "F4_heading": [], "F4_li": [], "F4_td": []}
    text = text.replace("\r\n", "\n")
    if text.startswith("---"):
        parts = text.split("---", 2)
        text = parts[2] if len(parts) >= 3 else text

    iss["F2_math_fences"] = len(re.findall(r"```math\b", text))

    prose = re.sub(r"```.*?```", " ", text, flags=re.S)

    # ★ 盲区修复：标题行 / 分隔线（---、***）与紧随正文之间无空行时，
    #   \n\n 分块会把正文吞进「块首行可跳过」的块里整段漏检——HTML 渲染中它们是独立的 <p>
    #   （dist 模式能看见）。避免因缺少空行导致正文长段落被源码模式漏判。
    #   处置：把纯标题行 / 纯分隔线行之后各补一个空行，使其后正文独立成块再参与判定；
    #   markdown 语义不变（标题与 HR 本就结束于行尾，HTML 产物一致）。
    prose = re.sub(r"(?m)^(#{1,6}\s[^\n]*)$", r"\1\n", prose)
    prose = re.sub(r"(?m)^(-{3,}|\*{3,})[ \t]*$", r"\1\n", prose)

    blocks = [b.strip() for b in prose.split("\n\n") if b.strip()]
    paras = []
    for b in blocks:
        first_line = b.splitlines()[0].strip()
        if first_line.startswith(("#", "<figure", "```", "---", "***", ">")):
            continue
        if first_line.startswith("|") and "|" in first_line[1:]:
            continue
        if first_line.startswith(("- ", "* ", "+ ")) or re.match(r"^\d+\.\s", first_line):
            continue
        p_clean = re.sub(r"`.*?`", " ", b)
        p_clean = re.sub(r"\\\([^\n]*?\\\)|\\\[.*?\\\]|\$\$.*?\$\$", " ", p_clean, flags=re.S)
        p_clean = TAG.sub("", p_clean)
        p_clean = re.sub(r"\*\*([^*]+)\*\*", r"\1", p_clean)
        paras.append(p_clean)

    cjk = [len(CJK.findall(p)) for p in paras if CJK.search(p)]
    paras = [p for p in paras if CJK.search(p)]
    for p, n in zip(paras, cjk):
        if n > TH_HIGH:
            iss["F1_high"].append((n, p[:70].replace("\n", " ")))
        elif n > TH_WARN:
            iss["F1_warn"].append((n, p[:70].replace("\n", " ")))

    for p in paras:
        if LATEX.search(p):
            iss["F2_latex"].append((len(CJK.findall(p)), p[:80].replace("\n", " ")))
        elif len(CJK.findall(p)) < 12 and SI.search(p) and re.search(r"=|\u2248", p):
            iss["F2_bare"].append(p[:80].replace("\n", " "))

    strong = len(re.findall(r"\*\*([^*]+)\*\*|<strong\b", prose))
    iss["F3_strong"] = strong
    iss["F3_density"] = round(strong / (sum(cjk) or 1) * 1000, 2)

    for s in re.split(r"\n##\s+", "\n" + prose)[1:]:
        title = s.splitlines()[0].strip()[:40]
        rest = "\n".join(s.splitlines()[1:])
        if not re.search(r"\*\*([^*]+)\*\*|<strong\b", rest):
            iss["F3_no_bold"].append(title)

    levels = [len(m.group(1)) for m in re.finditer(r"^(#{1,6})\s", prose, flags=re.M)]
    for x, y in zip(levels, levels[1:]):
        if y - x > 1:
            iss["F4_heading"].append("%d→%d" % (x, y))

    for m in re.finditer(r"^[ \t]*(?:[-*+]|\d+\.)\s+(.+)$", prose, flags=re.M):
        li_text = TAG.sub("", m.group(1))
        n = len(CJK.findall(li_text))
        if n > LI_WARN:
            iss["F4_li"].append((n, li_text[:60]))

    for line in prose.splitlines():
        line = line.strip()
        if line.startswith("|") and line.endswith("|"):
            cells = [c.strip() for c in line[1:-1].split("|")]
            for c in cells:
                if re.match(r"^:?-+:?$", c):
                    continue
                c_text = TAG.sub("", c)
                n = len(CJK.findall(c_text))
                if n > TD_WARN:
                    iss["F4_td"].append((n, c_text[:50]))

    return iss, cjk



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", default="site/docs/.vitepress/dist")
    ap.add_argument("--src", default="site/docs", help="源 Markdown 目录，当 md 比 dist 新时自动优先审计源码")
    ap.add_argument("--dist-only", action="store_true", help="强制只读 dist 静态构建产物")
    ap.add_argument("--src-only", action="store_true", help="强制只读源 Markdown（CP-299）：否则 md 比 dist 旧时会自动改读 dist HTML，而 dist 把散文+紧邻列表拆成独立 p/li，全站 md 口径会被稀释")
    ap.add_argument("--group", default=None)
    ap.add_argument("--lecture", default=None)
    ap.add_argument("--detail", action="store_true")
    a = ap.parse_args()
    dist = pathlib.Path(a.dist)
    src = pathlib.Path(a.src)

    if a.group:
        groups = [a.group]
    elif dist.exists():
        groups = sorted(d.name for d in dist.iterdir() if d.is_dir() and (d / "L01.html").exists())
    elif src.exists():
        groups = sorted(d.name for d in src.iterdir() if d.is_dir() and (d / "L01.md").exists())
    else:
        groups = []

    rows, fatal = [], 0
    for g in groups:
        if a.lecture:
            stems = [a.lecture]
        elif dist.exists() and (dist / g).exists():
            stems = [f.stem for f in sorted((dist / g).glob("L*.html"))]
        elif src.exists() and (src / g).exists():
            stems = [f.stem for f in sorted((src / g).glob("L*.md"))]
        else:
            stems = []

        for stem in stems:
            dist_file = dist / g / f"{stem}.html"
            md_file = src / g / f"{stem}.md"

            use_md = False
            if a.src_only and md_file.exists():
                use_md = True
            elif not a.dist_only and md_file.exists():
                if not dist_file.exists():
                    use_md = True
                elif md_file.stat().st_mtime > dist_file.stat().st_mtime:
                    use_md = True

            if use_md:
                iss, cjk = audit_md(md_file.read_text(encoding="utf-8", errors="replace"), a.detail)
            elif dist_file.exists():
                iss, cjk = audit_page(dist_file.read_text(encoding="utf-8", errors="replace"), a.detail)
            else:
                continue
            rows.append((g, stem, iss, cjk))
    print("=== 文本格式审计（段落 >%d ⚠️ / >%d ❗；列表项 >%d；表单元格 >%d）==="
          % (TH_WARN, TH_HIGH, LI_WARN, TD_WARN))
    print("%-5s %-5s %7s %4s %4s %6s %7s %6s %5s %5s %4s" %
          ("组", "讲", "最长段", "⚠️", "❗", "粗体", "密度/千", "无粗体", "裸公式", "LaTeX", "跳级"))
    for g, stem, iss, cjk in rows:
        mx = max(cjk) if cjk else 0
        print("%-5s %-5s %7d %4d %4d %6d %7.2f %6d %5d %5d %4d" %
              (g, stem, mx, len(iss["F1_warn"]), len(iss["F1_high"]), iss["F3_strong"],
               iss["F3_density"], len(iss["F3_no_bold"]), len(iss["F2_bare"]),
               len(iss["F2_latex"]), len(iss["F4_heading"])))
        fatal += len(iss["F1_high"]) + len(iss["F2_latex"])
        if a.detail:
            for n, p in iss["F1_high"]:
                print("     ! %4d 汉字 %s/%s：%s…" % (n, g, stem, p))
            for n, p in iss["F1_warn"]:
                print("     ~ %4d 汉字 %s/%s：%s…" % (n, g, stem, p))
            for t in iss["F3_no_bold"]:
                print("     ~ %s/%s h2 无粗体：%s" % (g, stem, t))
            for p in iss["F2_bare"][:3]:
                print("     ~ %s/%s 裸公式段：%s…" % (g, stem, p))
            for n, p in iss["F2_latex"][:3]:
                print("     ! %s/%s LaTeX 记号（未启用渲染）：%s…" % (g, stem, p))
            for x in iss["F4_heading"]:
                print("     ~ %s/%s 标题跳级 %s" % (g, stem, x))
            for n, p in iss["F4_li"][:3]:
                print("     ~ %s/%s 超长列表项 %d：%s…" % (g, stem, n, p))
            for n, p in iss["F4_td"][:3]:
                print("     ~ %s/%s 超长表单元格 %d：%s…" % (g, stem, n, p))
    warn = sum(len(i["F1_warn"]) + len(i["F3_no_bold"]) + len(i["F2_bare"]) +
               len(i["F4_heading"]) + len(i["F4_li"]) + len(i["F4_td"])
               for _, _, i, _ in rows)
    print("\n高危合计 = %d；提示合计 = %d" % (fatal, warn))
    print("结论: %s" % ("PASS（无高危）" if fatal == 0 else "FAIL（%d 处高危）" % fatal))
    return 0 if fatal == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
