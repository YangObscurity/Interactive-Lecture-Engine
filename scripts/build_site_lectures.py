# -*- coding: utf-8 -*-
r"""build_site_lectures.py — 把内容源讲义转成站点讲义（严格按既有契约）。

契约（见 content/README.md）：
  1) docs/<dir>/LNN.md        正文 + frontmatter + 每图一行 <figure> 占位
  2) docs/public/charts/GXX-LNN.json   { "cN": {"type": ..., "code": ...} }

转换规则：
  - 源 md 里的 ```mermaid/echarts/wavedrom 围栏 = 图表位置（这是 build_md.py 的原始约定），
    按出现顺序就地替换成 <figure class="chart" data-lecture data-id data-type></figure>
  - data-id 从 c1 连续编号
  - frontmatter 从源 md 的 `# 第N讲 · XXX` 与 `> 节点 \`xxx\` ｜ ...` 两行提取

用法：
  python build_site_lectures.py --group <GROUP> --src <dir> [--site <docs>] [--apply] [--only L01,L02]
"""
import argparse, io, json, os, pathlib, re, sys, collections

def _ensure_utf8_stdout():
    """幂等地把 stdout 切到 utf-8（与 fix_content.py 同实现）——避免重复包装关掉共享 buffer。"""
    enc = (getattr(sys.stdout, "encoding", "") or "").lower().replace("-", "")
    if enc == "utf8":
        return
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


_ensure_utf8_stdout()

# 路径解析机制：--site 默认值由脚本自身位置动态向上推导仓库根目录：
#   本文件位于 <repo>/scripts/，故 parents[1] == 仓库根，再拼 site/docs。
#   在这里（而非 argparse 点上）推导，是为了让别的脚本 import 本模块时
#   也能拿到同一个「仓库内标准文档目录」，避免各自再写一份推导逻辑。
REPO = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_SITE = REPO / "site" / "docs"

FENCE = re.compile(
    r"^```[ \t]*(mermaid|echarts|wavedrom)[ \t]*\r?\n(.*?)\r?\n```[ \t]*$",
    re.M | re.S,
)
TITLE = re.compile(r"^#\s*第\s*(\d+)\s*讲\s*[·・]\s*(.+?)\s*$", re.M)
NODE = re.compile(r"^>\s*节点\s*`([^`]+)`\s*(.*?)\s*$", re.M)
LEGACY_FIG = re.compile(r"<figure class=\"chart\".*?</figure>", re.S)
FRONT = re.compile(r"\A---\r?\n.*?\r?\n---\r?\n", re.S)
# Notion 导出残留的包裹标签（整行）：不删会被 Vue 当"无效结束标签"直接构建失败
WRAPPER = re.compile(r"^\s*</?(?:content|page|database|properties)\b[^>]*>\s*$", re.I)
# 行内代码片段：其中的 < 不能动
INLINE_CODE = re.compile(r"(`+[^`]*?`+)")


def _math_guard():
    """懒加载 scripts/math_guard.py（数学区间免疫，见该文件头）。"""
    global _MG
    try:
        return _MG
    except NameError:
        pass
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location(
        "math_guard", pathlib.Path(__file__).resolve().parent / "math_guard.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    _MG = mod
    return _MG


def protect_vue(line: str) -> str:
    """让正文里的裸 '<' 与 '{{' 不再被 Vue 模板编译器误认。

    起因（实测两例）：
      1) Notion 残留的 `</content>` 未配对 -> "Invalid end tag"
      2) C / ESP-IDF 讲义里 `` `{{{{…` `` 这类行内代码 -> "Error parsing JavaScript
         expression"，因为 VitePress 的行内代码没有 v-pre，Vue 会把 {{ }} 当插值。

    处理：
      - '{{' / '}}' 中间插入零宽空格（U+200B）打断插值。用零宽空格而不是 HTML 实体，
        是因为行内代码（code span）不会解析实体，实体在那里会原样显示出来。
      - 代码外的 '<' 用 markdown 原生反斜杠转义；'>' 不构成标签且行首 '>' 是引用语法，不碰。
      - 块尾字面 `{...}` 转义，避免被 markdown-it 当属性语法。

    ⚠️ M3（2026-10-07）：**以上四条规则全部跳过数学区间**（行内 `\\(…\\)`、行间 `\\[…\\]`／`$$…$$`）。
    否则 KaTeX 会收到被转义的 `&lt;`／被插入 U+200B 的花括号 → 公式直接编译失败。
    """
    if line.lstrip().startswith('<figure class="chart"'):
        return line
    _mg = _math_guard()

    def _braces(s: str) -> str:
        # 连续花括号串：每两个之间都插零宽空格
        # （不能用 str.replace('{{',...) —— 形如 {{{{ 会被拆成 {{ + {{，边界又拼出新的 {{）
        s = re.sub(r"\{\{+", lambda m: "\u200b".join(m.group(0)), s)
        return re.sub(r"\}\}+", lambda m: "\u200b".join(m.group(0)), s)

    line = "".join(seg if is_math else _braces(seg)
                   for seg, is_math in _mg.split_math(line))

    out = []
    for i, seg in enumerate(INLINE_CODE.split(line)):
        # 奇数下标是反引号包裹的片段，原样保留
        if i % 2:
            out.append(seg)
            continue
        buf = []
        for piece, is_math in _mg.split_math(seg):
            if is_math:                  # 数学区间：原样，什么都不做
                buf.append(piece)
                continue
            piece = piece.replace("<", "\\<")
            # 字面花括号转义：避免 markdown-it 属性语法将块尾的 {...}
            # 误解析为 HTML 属性（当遇到复杂 HTML 属性如 `{ [ INSERT ] [ , ] ... }`
            # 会被解析成重复属性名，导致 Vue 报 Duplicate attribute 编译错误）。
            piece = re.sub(r"(?<!\\)\{", r"\\{", piece)
            piece = re.sub(r"(?<!\\)\}", r"\\}", piece)
            buf.append(piece)
        out.append("".join(buf))
    return "".join(out)


def clean_lines(text: str) -> str:
    """逐行处理：删包裹标签 + 代码块外转义 '<'（缩进代码块也一并跳过）。"""
    out, infence = [], False
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith("```"):
            infence = not infence
            out.append(line)
            continue
        if infence or s.startswith("    "):
            out.append(line)
            continue
        if WRAPPER.match(line):
            continue
        out.append(protect_vue(line))
    return "\n".join(out)


UNESC = re.compile(r"\\([<>*^|\[\]#_])")
# 与 scripts/fix_content.py 保持同规则（那边负责修复已有 md，这边负责转换时直接生成）
LINK = re.compile(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)")
REF_HEAD = "## 参考来源"


def neutralize_links(text: str):
    """正文（参考来源段之前）的行内链接 -> 无高亮 .cite 标记。

    正文不允许出现链接（蓝色+下划线破坏阅读性）；改用与正文同色、无下划线的
    <span class="cite">，点击跳到本讲「参考来源」段。属性里的引号做转义。
    """
    cut = text.find("\n" + REF_HEAD)
    head, tail = (text[:cut], text[cut:]) if cut >= 0 else (text, "")
    n = 0

    def repl(m):
        nonlocal n
        n += 1
        label, url = m.group(1), m.group(2)
        safe = url.replace("&", "&amp;").replace('"', "&quot;")
        return '<span class="cite" data-cite="%s" title="%s">%s</span>' % (safe, safe, label)

    return LINK.sub(repl, head) + tail, n


# ==================== 尖括号永久规整（Vue 语义，2026-10-05 用 Vue 编译器实测） ====================
# 判据（不是猜的，来自 @vue/compiler-dom 实测）：
#   `<` 后跟 ASCII 字母/下划线 -> Vue 当标签名，报 "Element is missing end tag"
#       （`<name>` `<NAME>` `<stdio.h>` `<x y>` `<idf-py>` 全炸）
#   `<` 后跟数字/空格/中文/`<` -> 安全（`<150` `< 中文>` `<< 24`）
#   散文里写成 `&lt;`       -> Vue 安全，浏览器仍显示 `<`（正确显示）
#   行内 code 里留 raw `<`  -> **唯一稳定做法是不让它出现**：占位符去尖括号 `<name>` -> `name`
#                              （实测：`&lt;` 会被 markdown-it 二次转义显示成字面量；`\<` 在 code span 内无效；
#                                `<span v-pre>` 包裹也无效；全角 `＜` 会破坏复制）
#   围栏代码块              -> **不动**（VitePress 自动加 v-pre，raw `<` 安全）
TAG_KEEP = re.compile(r"</?(?:figure|span|code|div|br|img|a|b|i|em|strong|sub|sup|kbd|details|"
                      r"summary|table|tr|td|th|thead|tbody|p|ul|ol|li|h[1-6]|ClientOnly)\b[^>]*>", re.I)
ANGLE_BREAK = re.compile(r"(?<!\\)<(?=[A-Za-z_])")
PLACEHOLDER = re.compile(r"<([A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\-.·\u4e00-\u9fff]*)>")


def code_parts(line: str):
    """把一行拆成 [('text'|'code', 内容, 反引号长度)]，等长反引号串配对（CommonMark 单行语义）。"""
    res, buf, i, n = [], [], 0, len(line)
    while i < n:
        if line[i] != "`":
            buf.append(line[i])
            i += 1
            continue
        j = i
        while j < n and line[j] == "`":
            j += 1
        run = j - i
        k, hit = j, -1
        while k < n:
            if line[k] != "`":
                k += 1
                continue
            m = k
            while m < n and line[m] == "`":
                m += 1
            if m - k == run:
                hit = k
                break
            k = m
        if hit < 0:                      # 没有等长闭合 -> 当作普通文本
            buf.append(line[i:j])
            i = j
            continue
        if buf:
            res.append(("text", "".join(buf), 0))
            buf = []
        res.append(("code", line[j:hit], run))
        i = hit + run
    if buf:
        res.append(("text", "".join(buf), 0))
    return res


def sanitize_angle(text: str) -> str:
    """导入时一次性规整尖括号 —— 让「以后每次从 Notion 导新组」不再需要任何人工修补。"""
    out, fenced = [], False
    for ln in text.split("\n"):
        s = ln.strip()
        if s.startswith("```") or s.startswith("~~~"):
            fenced = not fenced
            out.append(ln)
            continue
        if fenced or s.startswith("<figure") or 'class="cite"' in ln:
            out.append(ln)
            continue
        buf = []
        for kind, seg, run in code_parts(ln):
            if kind == "code":
                inner = PLACEHOLDER.sub(r"\1", seg)          # 行内 code：占位符去尖括号
                buf.append("`" * run + inner + "`" * run)
            else:
                # ⚠️ M3（2026-10-07）：**数学区间内不转义** —— `\(a < b\)` 若被改成 `&lt;`
                # 会让 KaTeX 编译失败（见 scripts/math_guard.py）。
                _out = []
                for _seg, _is_math in _math_guard().split_math(seg):
                    if _is_math:
                        _out.append(_seg)
                        continue
                    guard = []
                    _seg = TAG_KEEP.sub(lambda m: guard.append(m.group(0)) or ("\x02%d\x02" % (len(guard) - 1)), _seg)
                    _seg = ANGLE_BREAK.sub("&lt;", _seg)      # 散文：转实体（显示仍是 '<'）
                    for idx, tag in enumerate(guard):
                        _seg = _seg.replace("\x02%d\x02" % idx, tag)
                    _out.append(_seg)
                buf.append("".join(_out))
        out.append("".join(buf))
    return "\n".join(out)


def normalize_body(text: str) -> str:
    """修两类继承自内容源的渲染缺陷（与 scripts/fix_content.py 同规则）。

    C1 setext 陷阱：'---' 紧跟非空行 -> 上一段被误解析成 <h2> 标题且分隔线消失
       （避免段落末尾长文本被识别为标题并产生超长锚点）
    C4 code span 伪转义：code span 是字面量不处理转义，`` `-\\>` `` 会原样显示 `-\\>`
    必须在围栏还在的时候跑（要跟踪 ``` 区域）。
    """
    out, infence, n1, n4 = [], False, 0, 0
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            infence = not infence
            out.append(line)
            continue
        if not infence:
            if line.strip() in ("---", "***", "___") and out and out[-1].strip() != "":
                out.append("")
                n1 += 1
            parts = INLINE_CODE.split(line)
            for k in range(1, len(parts), 2):
                new = UNESC.sub(r"\1", parts[k])
                if new != parts[k]:
                    n4 += 1
                    parts[k] = new
            line = "".join(parts)
        out.append(line)
    return "\n".join(out)


def normalize_md(body: str) -> str:
    """修两类「按 CommonMark 规则渲染不出来」的缺陷（导新组时自动生效）：

    ① `**粗体**` 无法闭合：中文写作常写 `**结论。**下一句`（闭合星号后紧接汉字）
       或 `一个**「引言」**件`（起始星号后紧接标点）——两侧都不满足 flanking 规则，
       页面会**显示字面 `**`**。修法：这类 span 改用 <strong>。
    ② 表头列数 ≠ 分隔行列数（如 6 列表头配 5 个 |---|）→ markdown-it 判定不是表格，
       整表当纯文本渲染。修法：把分隔行重写成与表头同列数。
    """
    lines = body.split("\n")
    fence = re.compile(r"^(\s*)(`{3,}|~{3,})(.*)$")
    fenced, fr = [], None
    for ln in lines:                                   # 围栏掩码（闭合围栏不能带 info string）
        m = fence.match(ln)
        if fr is None:
            if m:
                fr = (m.group(2)[0], len(m.group(2))); fenced.append(True)
            else:
                fenced.append(False)
        else:
            fenced.append(True)
            if m and m.group(2)[0] == fr[0] and len(m.group(2)) >= fr[1] and not m.group(3).strip():
                fr = None
    out, skip = [], set()
    for i, ln in enumerate(lines):
        if i in skip or fenced[i]:
            out.append(ln); continue
        # ② 表格分隔行
        if i + 1 < len(lines) and ln.strip().startswith("|") and \
                re.match(r"^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$", lines[i + 1]):
            h = len(ln.strip().strip("|").split("|"))
            d = len(lines[i + 1].strip().strip("|").split("|"))
            if h != d:
                out.append(ln); out.append("|" + "---|" * h); skip.add(i + 1)
                continue
        # ① 粗体 flanking
        if "**" in ln and not ln.lstrip().startswith("<figure"):
            code = [(m.start(), m.end()) for m in INLINE_CODE.finditer(ln)]
            pos = [m.start() for m in re.finditer(r"\*\*", ln)
                   if not any(a <= m.start() < b for a, b in code)]
            if len(pos) >= 2 and len(pos) % 2 == 0:
                for k in range(len(pos) - 2, -1, -2):
                    a, b = pos[k], pos[k + 1]
                    core = ln[a + 2:b]
                    if not core or "*" in core:
                        continue
                    ob, oa = ln[a - 1:a], ln[a + 2:a + 3]
                    cb, ca = ln[b - 1:b], ln[b + 2:b + 3]

                    def punct(c):
                        return c != "" and (not c.isalnum()) and (not c.isspace()) and c != "_"
                    ok_o = (oa != "" and not oa.isspace()) and \
                        (not punct(oa) or ob == "" or ob.isspace() or punct(ob))
                    ok_c = (cb != "" and not cb.isspace()) and \
                        (not punct(cb) or ca == "" or ca.isspace() or punct(ca))
                    if not (ok_o and ok_c):
                        ln = ln[:a] + "<strong>" + core + "</strong>" + ln[b + 2:]
        out.append(ln)
    return "\n".join(out)


def yaml_quote(s: str) -> str:
    """安全包进双引号（含中文冒号 / 反引号 / 引号都不怕）。"""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def convert(src_path: str, group: str, lecture: str, site: str, apply: bool,
            meta_dir: str = ""):
    raw = open(src_path, encoding="utf-8").read()
    raw = FRONT.sub("", raw)                    # 去掉源里可能已有的 frontmatter
    body = LEGACY_FIG.sub("", raw)              # 去掉可能残留的旧 figure
    body = re.sub(r"\n{3,}", "\n\n", body).strip("\n") + "\n"
    body = clean_lines(body)                    # 删 Notion 包裹标签 + 转义裸 '<'
    body = normalize_body(body)                 # 修 setext 陷阱 + code span 伪转义
    body = sanitize_angle(body)                 # 尖括号永久规整（Vue 语义；导新组自动生效）
    body, _nlink = neutralize_links(body)       # 正文链接 -> 无高亮 .cite 标记

    m = TITLE.search(body)
    if not m:
        return None, "no title line"
    order, name = int(m.group(1)), m.group(2)
    node = NODE.search(body)
    desc = ""
    if node:
        rest = node.group(2).strip()
        desc = "节点 `" + node.group(1) + "`" + ((" " + rest) if rest else "")

    charts = collections.OrderedDict()

    def repl(mm):
        cid = "c%d" % (len(charts) + 1)
        charts[cid] = {"type": mm.group(1), "code": mm.group(2)}
        return ('<figure class="chart" data-lecture="%s-%s" data-id="%s" data-type="%s">'
                "</figure>" % (group, lecture, cid, mm.group(1)))

    body = FENCE.sub(repl, body)
    body = normalize_md(body)                   # 粗体 flanking + 表格分隔行（导新组自动生效）
    body = re.sub(r"\n{3,}", "\n\n", body)

    ref = reference_section(meta_dir, group, lecture)
    if ref:
        body = body.rstrip("\n") + "\n" + ref

    fm = ["---",
          "title: " + yaml_quote("第%d讲 · %s" % (order, name)),
          "order: %d" % order]
    if desc:
        fm.append("description: " + yaml_quote(desc))
    fm += ["outline: deep", "---", ""]
    out_md = "\n".join(fm) + body

    gdir = os.path.join(site, group.lower())
    cdir = os.path.join(site, "public", "charts")
    md_path = os.path.join(gdir, "%s.md" % lecture)
    js_path = os.path.join(cdir, "%s-%s.json" % (group, lecture))

    if apply:
        os.makedirs(gdir, exist_ok=True)
        os.makedirs(cdir, exist_ok=True)
        with open(md_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(out_md)
        with open(js_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(charts, f, ensure_ascii=False, indent=1)

    return {"order": order, "name": name,
            "figs": len(charts),
            "types": collections.Counter(c["type"] for c in charts.values())}, None


def reference_section(meta_dir: str, group: str, lecture: str) -> str:
    """从元数据文件 <meta_dir>/<GROUP-LNN>.meta.json 的 sources 读取参考来源段落。

    当上游元数据中存在 sources 列表时提取参考条目，无条目时返回空。
    格式保持 Markdown 列表规范：`- [标题](url)`。
    """
    if not meta_dir:
        return ""
    p = os.path.join(meta_dir, "%s-%s.meta.json" % (group, lecture))
    if not os.path.exists(p):
        return ""
    try:
        data = json.load(open(p, encoding="utf-8"))
    except Exception:
        return ""
    srcs = [s for s in (data.get("sources") or []) if s and (s.get("url") or s.get("title"))]
    if not srcs:
        return ""
    out = ["", "## 参考来源", ""]
    for s in srcs:
        t = (s.get("title") or "").strip()
        u = (s.get("url") or "").strip()
        # ⚠️ 标题里可能有 <network-number> 这类尖括号占位符（RFC 原文引用），
        # 而参考来源是在 clean_lines 之后追加的 —— 不转义会被 Vue 当成标签、构建直接失败。
        if t:
            t = protect_vue(t)
        out.append("- [%s](%s)" % (t or u, u) if u else "- %s" % t)
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", required=True)
    ap.add_argument("--src", required=True, help="含 GXX-LNN.md 的目录")
    ap.add_argument("--meta-dir", default="", help="含 GXX-LNN.meta.json 的目录（有则补「参考来源」）")
    ap.add_argument("--site", default=str(DEFAULT_SITE),
                    help="站点 docs 目录（默认：<仓库根>/site/docs）")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only", default="", help="逗号分隔的讲号，如 L01,L02")
    a = ap.parse_args()

    only = {s.strip().upper() for s in a.only.split(",") if s.strip()}
    files = sorted(f for f in os.listdir(a.src)
                   if re.match(r"^%s-L\d+\.md$" % a.group, f))
    if only:
        files = [f for f in files if f[:-3].upper() in only]

    tot_fig = 0
    tot_type = collections.Counter()
    problems = []
    print("%-10s %-6s %-34s %s" % ("lecture", "figs", "title", "types"))
    for f in files:
        lec = f[:-3].split("-")[1]
        res, err = convert(os.path.join(a.src, f), a.group, lec, a.site, a.apply,
                           a.meta_dir)
        if err:
            problems.append("%s: %s" % (f, err))
            print("%-10s SKIP   %s" % (lec, err))
            continue
        tot_fig += res["figs"]
        tot_type.update(res["types"])
        print("%-10s %-6d %-34s %s" % (lec, res["figs"], res["name"],
                                       dict(res["types"])))
    print("\n合计: %d 讲, %d 张图, 类型 %s" % (len(files), tot_fig, dict(tot_type)))
    print("模式: %s" % ("已写入" if a.apply else "预览（加 --apply 才写盘）"))
    if problems:
        print("问题:")
        for p in problems:
            print("  - " + p)


if __name__ == "__main__":
    main()
