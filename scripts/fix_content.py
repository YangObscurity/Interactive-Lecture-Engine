r"""fix_content.py — 修复讲义 md 的两类渲染缺陷（可重复运行，幂等）。

C1 setext 陷阱
  形如：
      段落文字
      ---
  markdown-it 会把上一段吃成 <h2>（setext 下划线），分隔线消失。
  现象：整段正文被误解析为二级标题并产生超长锚点，分隔线失效。
  修法：在分隔线前补一个空行，使其成为真正的 <hr>。
  注意：必须在 frontmatter 之后处理，否则会插进 frontmatter 里把文档弄坏。

C4 行内代码里的伪转义
  code span 是字面量、不处理 markdown 转义，所以 `` `-\>` `` 会**原样显示** `-\>`。
  来源是上游源稿导出时的过度转义。
  修法：只在 **code span 内部** 去掉紧跟标点的反斜杠（按实测出现的字符集）。

用法：python fix_content.py [--group <group>] [--docs <讲义根目录>] [--apply]

  --docs 默认 = <仓库根>/site/docs（由脚本自身位置推导），命令行可覆盖。
"""
import argparse, io, pathlib, re, sys, collections
from urllib.parse import unquote

def _ensure_utf8_stdout():
    """幂等地把 stdout 切到 utf-8 —— 避免「两个脚本都被 import 时重复包装」导致
    前一个 wrapper 被 GC 后关闭共享 buffer（实测报 I/O operation on closed file）。"""
    enc = (getattr(sys.stdout, "encoding", "") or "").lower().replace("-", "")
    if enc == "utf8":
        return
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


_ensure_utf8_stdout()

# 路径解析机制：由脚本自身位置动态向上推导仓库根目录，确保跨环境开箱即跑。
REPO = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_DOCS = REPO / "site" / "docs"
RULE = {"---", "***", "___"}
INLINE_CODE = re.compile(r"(`+[^`]*?`+)")
# 实测出现过的伪转义（保守取集合，不含反斜杠本身，避免破坏 `\\` 这类写法）
UNESC = re.compile(r"\\([<>*^|\[\]#_])")
# 正文行内链接：只有 http(s) 才处理（相对链接如示意图不碰）
LINK = re.compile(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)")
# 参考来源段起始标记：该段允许保留链接，正文不允许
REF_HEAD = "## 参考来源"


# 正文里允许原样保留的 HTML 标签（与 build_site_lectures.py 的 TAG_KEEP 同规则）：
# 这些是**真标签**，转义了页面会显示成字面文本，必须保护。
TAG_KEEP = re.compile(r"</?(?:figure|span|code|div|br|img|a|b|i|em|strong|sub|sup|kbd|details|"
                      r"summary|table|tr|td|th|thead|tbody|p|ul|ol|li|h[1-6]|ClientOnly)\b[^>]*>", re.I)
# 只有「< 后跟 ASCII 字母/下划线」会被 Vue 当标签名（报 Element is missing end tag），才需要转义；
# 「< 后跟数字/空格/中文/<」Vue 本来就接受（<150、<< 24、< 中文>），不动。
ANGLE_BREAK = re.compile(r"(?<!\\)<(?=[A-Za-z_])")


def _math_guard():
    """懒加载 scripts/math_guard.py（数学区间免疫，M3）。"""
    global _MG
    try:
        return _MG
    except NameError:
        pass
    import importlib.util, pathlib as _p
    spec = importlib.util.spec_from_file_location(
        "math_guard", _p.Path(__file__).resolve().parent / "math_guard.py")
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    _MG = mod
    return _MG


def escape_lt(text: str):
    """把会被 Vue 误读为标签的裸 '<' 转义（C7）。

    起因：协议与规范原文占位符（如 `<network-number>` / `<CRLF>`），markdown-it 当标签透传
    -> Vue 报 "Element is missing end tag"，构建直接失败。

    2026-10-06 修复：原实现 `re.sub(r"(?<!\\\\)<", r"\\\\<", seg)` **无差别转义所有 '<'**，
    把合法标签（<strong> <br/> …）也转义了 -> 页面显示成字面文本。
    现改为：白名单标签（TAG_KEEP）先用占位符保护、原样放回；只转义 ANGLE_BREAK 命中的 '<'。
    保护：figure 占位行与 .cite 标记里的 '<' 不能动。
    """
    out, infence, n = [], False, 0
    for line in text.split("\n"):
        if line.strip().startswith("```"):
            infence = not infence
            out.append(line)
            continue
        if infence or line.lstrip().startswith("<figure") or 'class="cite"' in line:
            out.append(line)
            continue
        parts = INLINE_CODE.split(line)
        for k, seg in enumerate(parts):
            if k % 2:                      # 行内代码：原样
                continue
            # ⚠️ M3（2026-10-07）：数学区间内不转义，否则 `\(a < b\)` 变成 `&lt;` → 编译失败
            mg = _math_guard()
            if mg.has_math(seg):
                keep, rebuilt = mg.split_math(seg), []
                for piece, is_math in keep:
                    if is_math:
                        rebuilt.append(piece)
                        continue
                    orig = piece
                    piece = re.sub(r"\\(" + TAG_KEEP.pattern + r")", r"\1", piece)
                    guard = []
                    seg2 = TAG_KEEP.sub(
                        lambda m: guard.append(m.group(0)) or ("\x03%d\x03" % (len(guard) - 1)), piece)
                    new = ANGLE_BREAK.sub(r"\\<", seg2)
                    for idx, tag in enumerate(guard):
                        new = new.replace("\x03%d\x03" % idx, tag)
                    if new != orig:
                        n += 1
                    rebuilt.append(new)
                parts[k] = "".join(rebuilt)
                continue
            orig = seg
            # 自愈：误转义的白名单标签还原为真标签（历史数据修复）
            seg = re.sub(r"\\(" + TAG_KEEP.pattern + r")", r"\1", seg)
            guard = []
            seg2 = TAG_KEEP.sub(
                lambda m: guard.append(m.group(0)) or ("\x03%d\x03" % (len(guard) - 1)), seg)
            new = ANGLE_BREAK.sub(r"\\<", seg2)
            for idx, tag in enumerate(guard):
                new = new.replace("\x03%d\x03" % idx, tag)
            if new != orig:
                n += 1
            parts[k] = new
        out.append("".join(parts))
    return "\n".join(out), n


def neutralize_links(text: str):
    """把**参考来源段之前**的行内链接换成无高亮的 .cite 标记。

    要求（用户）：正文里不允许出现链接（蓝色带下划线，破坏阅读性）；
    但允许用「无高亮的功能性文字」做跳转 —— 于是输出
        <span class="cite" data-cite="url" title="url">显示文字</span>
    平时与正文同色、无下划线（仅一条极淡点线做可点提示），点击跳到本讲的「参考来源」。
    HTML 属性里的引号会被转义，避免把标签弄坏。
    """
    cut = text.find("\n" + REF_HEAD)
    head, tail = (text[:cut], text[cut:]) if cut >= 0 else (text, "")
    n = 0

    def repl(m):
        nonlocal n
        n += 1
        label = m.group(1)
        url = m.group(2)
        safe = url.replace("&", "&amp;").replace('"', "&quot;")
        return '<span class="cite" data-cite="%s" title="%s">%s</span>' % (safe, safe, label)

    return LINK.sub(repl, head) + tail, n


BARE_URL = re.compile(r"https?://[^\s\u3000，。；、！？（）「」『』【】：]+")
BARE_TRAIL = ".,;:!?)]}"
# ---- 无协议裸域名/URL（C9 扩展，2026-10-06 残留清理）----
# 参考来源段已全站删除（既定设计）：正文一切 URL/裸域名一律转 .cite，
# .cite 点击 window.open 直接打开外链，是正文唯一允许的外链形态。
# TLD 白名单做硬门槛：天然排除 idf.py / database.py / sdkconfig.h / 13.x / i.e
# 等工具名、文件名、版本号、缩写（仅真域名样式命中）。
SCHEMELESS = re.compile(
    r"(?<![\w./@\-:])((?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)"
    r"(:\d+)?(/[^\s\u3000\uff0c\u3002\uff1b\u3001\uff01\uff1f\uff08\uff09\u300c\u300d\u300e\u300f\u3010\u3011\])}]*)?", re.I)
SCHEME_TLDS = {
    "com", "org", "net", "edu", "gov", "io", "ai", "dev", "sh", "cn", "co",
    "uk", "de", "jp", "hk", "us", "xyz", "info", "me", "tv", "cc", "ru",
    "fr", "au", "ca", "kr", "nl", "eu", "cloud", "tech", "online", "site",
}
# 脚本/源码文件名后缀：`install.sh` `build.c` `foo.py` 是文件名不是域名（.sh 与圣赫勒拿 TLD 同名，必须靠后缀表拦截）
FILE_EXT = {"sh", "py", "c", "h", "cpp", "cc", "rs", "go", "js", "ts", "mjs", "java",
            "rb", "pl", "ps1", "bat", "cmd", "exe", "o", "a", "so", "dll", "elf",
            "txt", "csv", "json", "yml", "yaml", "toml", "ini", "cfg", "conf",
            "lock", "log", "mk", "cmake", "ld", "s", "ino", "bin", "map"}
# RFC 2606/6761 教学占位域名：协议示例里的正文内容（证书 CN、MX 记录例），不是引用来源，豁免
CONTENT_HOSTS = {"example.com", "www.example.com", "example.org", "example.net"}
CONTENT_DOMAIN_SUFFIX = ("example.com", "example.org", "example.net")   # 含子域 *.example.com
CITE_HTML = re.compile(r'<span class="cite"[^>]*>.*?</span>')
PAREN2 = re.compile(r"([（(])([^（）()]*)([）)])")
MARKER2 = re.compile(r"^(出处|来源|參考|参考|資料來源|source|Source)\s*[：:]")
POINTER2 = re.compile(
    r"^(一?手?来源|出处|參考|参考|資料來源|source|官方\s*(URL|文档|网站|站点)?|"
    r"文档|仓库|地址|口径|URL|url|网址|链接|见|详见)\s*[：:]?$")
GENERIC_SEG = {"index", "latest", "documents", "en", "zh-cn", "stable", "main", "master"}


def _slug_of(url: str, host: str) -> str:
    """URL 末段去扩展名；太泛（index/latest/documents）或太长 -> 用主机名。"""
    host = re.sub(r"^www\.", "", host)
    u = url.split("#")[0].split("?")[0].rstrip("/")
    last = unquote(u.rsplit("/", 1)[-1])
    last = re.sub(r"\.(html?|pdf|php|aspx?|txt|md|json|xml)$", "", last, flags=re.I)
    if not last or last.lower() in GENERIC_SEG or "." in last or len(last) > 26:
        return host
    return last


def _make_cite(url: str, label: str) -> str:
    safe = url.replace("&", "&amp;").replace('"', "&quot;")
    return '<span class="cite" data-cite="%s" title="%s">%s</span>' % (safe, safe, label)


def _clean_inner(s: str) -> str:
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = re.sub(r"([，、；,;])\s*\1", r"\1", s)
    s = re.sub(r"：\s*[，、]", "：", s)
    s = s.replace("；；", "；").replace("，，", "，").replace("、、", "、")
    s = re.sub(r"[ \t\u00a0\u3000]+([，、；。！？)）])", r"\1", s)
    s = re.sub(r"[，、；,;]\s*$", "", s)
    s = re.sub(r"[。.]\s*$", "", s)
    return s.strip()


def is_real_domain(host: str) -> bool:
    """无协议命中的 host 是否为「真域名」（供 grab2 与审计脚本共用同一判据）。"""
    host = host.lower()
    tld = host.rsplit(".", 1)[-1]
    if tld not in SCHEME_TLDS:
        return False                       # 工具名/文件名/版本号/缩写
    if tld in FILE_EXT and host.count(".") == 1 and host.split(".")[0] != "www":
        return False                       # `install.sh` 这类单段+源码后缀 = 文件名
    if host in CONTENT_HOSTS or host.endswith(tuple("." + d for d in CONTENT_DOMAIN_SUFFIX)):
        return False                       # RFC 教学占位域名（含 *.example.com 子域）
    return True


def neutralize_bare_urls(text: str):
    """正文里的**裸 URL** -> 无高亮的 .cite（C9）。

    背景：VitePress 的 markdown-it 开了 linkify，正文裸 URL 会被**自动变成真链接**，
    而且会把紧跟的中文标点一起吞进 href（实测 `...build-system.html%EF%BC%89`）。

    规则（只作用于「## 参考来源」之前）：
      · 括注以「出处/来源：」开头且去掉 URL 后仍有说明文字 -> 删掉 URL 与分隔符
        （说明文字已点明是哪份文档；参考来源段已全站删除，不再依赖该段判定）
      · 其余位置的裸 URL -> <span class="cite" data-cite=URL title=URL>短名</span>
        （平时无高亮，悬停显示 URL，点击 window.open 直接打开外链——参考来源段已删）
    已有的 .cite 与行内 code 不动；幂等，可反复运行。
    """
    cut = text.find("\n" + REF_HEAD)
    head, tail = (text[:cut], text[cut:]) if cut >= 0 else (text, "")
    n = 0
    lines = head.split("\n")
    infence = False

    for line_i, line in enumerate(lines):
        if line.strip().startswith("```"):          # 围栏代码块整体跳过
            infence = not infence
            continue
        if infence or line.lstrip().startswith("<figure") \
                or ("http" not in line and "." not in line):
            continue
        codes = []

        def keep_code(m):
            codes.append(m.group(0))
            return "\x02%d\x02" % (len(codes) - 1)

        seg = re.sub(r"(`+[^`]*?`+)", keep_code, line)
        saved = []

        def protect(m):
            saved.append(m.group(0))
            return "\x01%d\x01" % (len(saved) - 1)

        seg = CITE_HTML.sub(protect, seg)
        store = {}

        def grab(m):
            url = m.group(0).rstrip(BARE_TRAIL)
            host = unquote(url.split("//")[-1].split("/")[0])
            label = _slug_of(url, host)
            inref = (url in tail or url.rstrip("/") in tail
                     or (len(label) >= 4 and label.lower() in tail.lower()))
            key = "\x00%d\x00" % len(store)
            store[key] = (url, label, inref)
            return key + m.group(0)[len(url):]

        seg = BARE_URL.sub(grab, seg)

        def grab2(m):
            """无协议裸域名/URL -> .cite（data-cite 补 https:// 前缀）。"""
            raw = m.group(0)
            host = m.group(1)
            if not is_real_domain(host):
                return raw                      # 非真域名/教学占位域名：原样保留
            core = raw.rstrip(BARE_TRAIL)
            url = "https://" + core
            label = _slug_of(url, host)
            key = "\x00%d\x00" % len(store)
            store[key] = (url, label, False)
            return key + raw[len(core):]

        seg = SCHEMELESS.sub(grab2, seg)

        def paren(m):
            op, inner, cl = m.groups()
            marks = [k for k in store if k in inner]
            if not marks:
                return m.group(0)
            had_marker = bool(MARKER2.match(inner.strip()))   # 括注本身是否带「出处/来源：」
            rest = inner
            for k in marks:
                rest = rest.replace(k, "")
            rest = _clean_inner(MARKER2.sub("", rest.strip()))
            inref = all(store[k][2] for k in marks)
            out = inner
            if rest and not POINTER2.match(rest) and (inref or had_marker):
                # 括注自带的说明文字已经点明是哪份文档 -> URL 与分隔符一起删
                for k in marks:
                    out = re.sub(r"[ \t]*[，、,;]?[ \t]*" + re.escape(k), "", out)
                return op + _clean_inner(out) + cl
            for k in marks:
                u, lb, _ = store[k]
                out = out.replace(k, _make_cite(u, lb))
            return op + _clean_inner(out) + cl

        seg = PAREN2.sub(paren, seg)
        for k in [k for k in store if k in seg]:
            u, lb, _ = store[k]
            seg = seg.replace(k, _make_cite(u, lb))
        seg = re.sub(r"[ \t\u00a0\u3000]+([，、；。！？)）])", r"\1", seg)
        for j, c in enumerate(saved):
            seg = seg.replace("\x01%d\x01" % j, c)
        for j, c in enumerate(codes):
            seg = seg.replace("\x02%d\x02" % j, c)
        if seg != line:
            n += 1
            lines[line_i] = seg
    body = "\n".join(lines)
    # 括号里只剩一个 cite -> 去掉多余的括号（胶囊直接跟在文字后面即可）
    body, k = re.subn(r"[（(]\s*(%s)\s*[）)]" % CITE_HTML.pattern, r"\1", body)
    n += k
    return body + tail, n


def fix_text(text: str, only_url: bool = False):
    """only_url=True 时只跑 C9（裸 URL），跳过 C1/C4/C7(escape_lt)。

    用途（2026-10-06）：escape_lt 会把**合法 HTML 标签**（`<strong>` 等）转义成 `\\<strong>`，
    页面上会显示成字面标签文本 —— 属既有缺陷，需单独评估，不能混在 URL 清理里一起写盘。
    """
    lines = text.split("\n")

    # 定位 frontmatter 结束位置
    start = 0
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                start = i + 1
                break

    out = []
    n1 = n4 = 0
    infence = False
    for i, ln in enumerate(lines):
        if i >= start and not only_url:
            if ln.strip().startswith("```"):
                infence = not infence
            elif not infence:
                # ---- C1：分隔线紧跟非空行 -> 前面补空行 ----
                if ln.strip() in RULE and out and out[-1].strip() != "":
                    out.append("")
                    n1 += 1
                # ---- C4：code span 内的伪转义 ----
                parts = INLINE_CODE.split(ln)
                for k in range(1, len(parts), 2):
                    new = UNESC.sub(r"\1", parts[k])
                    if new != parts[k]:
                        n4 += 1
                        parts[k] = new
                ln = "".join(parts)
        out.append(ln)

    body, n7 = neutralize_links("\n".join(out))
    body, n9 = neutralize_bare_urls(body)
    if only_url:
        return body, 0, 0, n7, 0, n9
    body, n8 = escape_lt(body)
    return body, n1, n4, n7, n8, n9


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--group", default="")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only-url", action="store_true",
                    help="只跑 C9（裸 URL 清理），跳过 C1/C4/escape_lt")
    # 支持通过命令行参数指定目标处理目录。
    #   默认值 = 由脚本位置推导的仓库内 site/docs，命令行仍可指向别处
    #   （例如把本工具用于另一份工作副本）。
    ap.add_argument("--docs", default=str(DEFAULT_DOCS),
                    help="讲义 md 根目录（默认：<仓库根>/site/docs）")
    a = ap.parse_args()

    if a.group:
        groups = [a.group]
    else:
        groups = [p.name for p in sorted(docs_root.iterdir()) if p.is_dir() and not p.name.startswith(".")]
    tot1 = tot4 = tot7 = tot8 = tot9 = files = 0
    for g in groups:
        d = docs_root / g
        if not d.exists():
            continue
        for f in sorted(d.glob("L*.md")):
            src = f.read_text(encoding="utf-8")
            new, n1, n4, n7, n8, n9 = fix_text(src, only_url=a.only_url)
            if n1 or n4 or n7 or n8 or n9:
                files += 1
                tot1 += n1
                tot4 += n4
                tot7 += n7
                tot8 += n8
                tot9 += n9
                print("  %-16s C1×%d  C4×%d  链接×%d  裸<×%d  裸URL×%d"
                      % (g + "/" + f.name, n1, n4, n7, n8, n9))
                if a.apply and new != src:
                    f.write_text(new, encoding="utf-8", newline="\n")

    print("\n合计: C1 %d 处, C4 %d 处, 正文链接 %d 处, 裸 '<' %d 处, 裸 URL %d 处, 涉及 %d 个文件"
          % (tot1, tot4, tot7, tot8, tot9, files))
    print("模式: %s" % ("已写入" if a.apply else "预览（加 --apply 才写盘）"))


if __name__ == "__main__":
    main()
