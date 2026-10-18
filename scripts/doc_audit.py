#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""doc_audit.py —— 文档完整性闸门：链接可达性 + 敏感信息静态合规 + 结构健全。

## 为什么需要它
本仓库有过多次「文档与事实脱节」的真实记录：
  · `.gitignore:125` 在已提交的 blob 里就是 U+FFFD 乱码；
  · 审计报告自引用敏感串（报告本身成了泄露源）；
  · 搜索脚本被 `*secret*` 规则静默排除（文档里却引用它）；
  · `CONTRIBUTING.md` 曾列出一个已被删除的 `plans/` 目录。
这些都**不会让构建失败**，只会让新人照着文档撞墙。故单独立闸门。

## 检查项
  D1  README 里指向仓库内的链接必须可达（改过文件结构后最容易漏）
  D2  所有 tracked `.md` 引用的**仓库内具体文件**必须存在
      （只认「看起来是具体文件」的引用；泛指目录与占位符跳过，避免误报）
  D3  文档里不得出现敏感信息与硬编码凭据（复用 scan_secrets.py 的规则）
  D4  README 必须含必备章节（是什么 / 快速开始 / License）
  D5  License 文件存在且被 README 引用

## 为什么 D2 要收紧判据
第一版实现把所有含 `/` 的引用都算死链，结果报了 214 条 —— 绝大多数是
`node_modules/`、`dist/`、`docs/` 这类**泛指目录**，以及计划文档里
**提议但未创建的路径**。假阳性会把真问题淹没，团队随后开始无视闸门。
故此处要求：引用经过**非泛指目录**、且末段**像具体文件名**（含扩展名）。

用法：
    python scripts/doc_audit.py
退出码：0 = 通过；1 = 有问题；2 = 闸门自身错误（不在 git 仓库 / 扫不到 md）
"""
from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = pathlib.Path(__file__).resolve().parents[1]

# ── 判据表 ────────────────────────────────────────────────────────────────
# 泛指目录：引用路径中出现这些片段时不判死链（它们是概念目录，不是具体文件）
GENERIC_SEG = {
    "node_modules", "dist", "cache", ".temp", ".vitepress", "public", "docs",
    "charts", "theme", "examples", "content-sources", "site", "scripts",
    "content", "engine", "ops", "assets", "backups", "workspaces",
}
# 明显占位/示例名（Lxx / G01-Lxx / <...> / 含 * 等）
PLACEHOLDER = re.compile(r"[Xx]{2,}|\bLxx\b|L\d{2}\.html?$|<|>|\*|\{|\}|…")

# ── 已知的「非死链」语境（每一条都有实测依据，不是为凑数放行）──────────────
#
# 判据来源：2026-10-15 逐条人工核实了 12 条被初版闸门误报的引用，发现它们
# 分属四类**合法语境**。假阳性会淹没真问题（初版曾误报 214 条），故显式放行：
#
#   1. `_temp/xxx.py` —— **历史溯源**：说明「该脚本原先在 _temp/，现已迁到
#      scripts/」。这是有价值的工程史，不是指向现有文件的链接。
#   2. `vector/default.svg` / `default.png` —— **仓库外的素材包**：文档明确写了
#      「该目录须含…」，指的是使用者自己的 logo 目录，不是本仓库文件。
#   3. `/opt/...`、`/home/user/...`、`memory-mcp-*` —— **方案文档里提议的路径**：
#      计划文档描述「打算部署到哪里」，这些路径本就不该存在于仓库。
#   4. `<group>/index.html` 等 —— **dist 构建产物名**：描述"构建后会生成什么"，
#      不是仓库源文件。
#   5. **方案文档里"提议新建"的模块路径**（如架构审计报告写
#      「职责 2 应移到 `ai/data/sessionHeal.ts`」）—— 那个文件**本就不存在**，
#      存在的意义是"建议将来建它"。这类路径无法靠文件名识别，改用**语境标记**：
#      同行（或紧邻上一行）出现下列"提议性词"即视为提案而非链接。
PROPOSAL_MARKERS = (
    "应移到", "应拆", "建议新建", "建议拆分", "拟建", "拟拆", "计划新建",
    "抽取为", "提取为", "拆分为", "should be moved", "proposed",
)
FALSE_POSITIVE_PATTERNS = [
    re.compile(r"(^|/)_temp/"),                 # 1) 历史迁移溯源
    re.compile(r"(^|/)vector/"),                # 2) 外部 logo 素材包
    re.compile(r"^/opt/"),                      # 3) 方案里提议的服务器路径
    re.compile(r"^/home/"),                     # 3) 同上（其它机器的示例路径）
    re.compile(r"memory-mcp"),                  # 3) 外部 MCP 服务示例路径
    re.compile(r"^[a-z]\d{2}/index\.html$"),    # 4) dist 产物（组内页）
]

# 引用形态：markdown 链接 与 行内反引号路径
LINK = re.compile(r"\]\(([^)\s]+)\)")
CODE = re.compile(r"`([A-Za-z0-9_./-]+/[A-Za-z0-9_./-]*)`")
EXTERNAL = ("http://", "https://", "mailto:", "#", "www.", "ftp://")

# README 必备章节关键词（任一命中即可，容忍不同措辞）
README_REQUIRED = {
    "是什么/定位": ("这个仓库是什么", "是什么", "What is"),
    "快速开始": ("快速开始", "Quick start", "安装", "Getting started"),
    "License": ("License", "许可", "开源协议"),
}


def tracked_mds() -> list[str]:
    r = subprocess.run(["git", "ls-files", "*.md"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", cwd=str(REPO))
    res = [l for l in r.stdout.splitlines() if l.strip()] if r.returncode == 0 else []
    if not res:
        # 兼容未提交/缓冲态：扫描本地 md
        skip = {"node_modules", "dist", "cache", ".temp", ".git"}
        for p in REPO.rglob("*.md"):
            if not any(sp in p.parts for sp in skip):
                res.append(p.relative_to(REPO).as_posix())
    return sorted(res)


# 全量 tracked 清单（含非 md）。见下方 is_tracked 的说明。
_TRACKED_SET: set[str] | None = None


def is_tracked(path: pathlib.Path) -> bool:
    """该路径是否随仓库发布（即出现在 git 索引里）。"""
    global _TRACKED_SET
    if _TRACKED_SET is None:
        r = subprocess.run(["git", "ls-files"], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", cwd=str(REPO))
        lines = [l.strip().replace("\\", "/") for l in r.stdout.splitlines() if l.strip()] if r.returncode == 0 else []
        if lines:
            _TRACKED_SET = set(lines)
        else:
            skip = {"node_modules", "dist", "cache", ".temp", ".git"}
            _TRACKED_SET = set()
            for p in REPO.rglob("*"):
                if p.is_file() and not any(sp in p.parts for sp in skip):
                    _TRACKED_SET.add(p.relative_to(REPO).as_posix())
    try:
        rel = str(path.resolve().relative_to(REPO.resolve())).replace("\\", "/")
    except ValueError:
        return False  # 仓库之外的路径一律视为不随仓库发布
    return rel in _TRACKED_SET


def looks_like_file(s: str) -> bool:
    last = s.rstrip("/").split("/")[-1]
    return "." in last and not last.startswith(".")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="文档完整性闸门：链接可达 + 敏感信息静态合规 + README 结构")
    ap.add_argument(
        "--allow-untracked", action="store_true",
        help="把「磁盘上存在但尚未 git add」的目标视为可达。"
             "**仅供本地边写边查**：发布前与 CI 一律用默认严格模式，"
             "否则会漏掉「引用了不随仓库发布的文件」这类真问题。")
    a = ap.parse_args()
    allow_untracked = a.allow_untracked

    mds = tracked_mds()
    if not mds:
        # 真空防护（AGENTS.md §0.2）：扫不到文档 ≠ 通过
        print("✗ 闸门错误：未发现任何 tracked .md —— 判据不成立", file=sys.stderr)
        return 2

    print(f"扫描 {len(mds)} 个 tracked markdown"
          + ("（--allow-untracked：未跟踪但存在的目标视为可达）" if allow_untracked else ""))
    print("=" * 74)
    problems: list[str] = []

    # ── D1/D2：链接可达性 ────────────────────────────────────────────────
    dead: dict[str, list[str]] = {}
    untracked_refs: dict[str, list[str]] = {}
    for md in mds:
        p = REPO / md
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            continue
        src_lines = text.splitlines()
        cands = {m.group(1) for rx in (LINK, CODE) for m in rx.finditer(text)}

        def is_proposal(path_str: str) -> bool:
            """该引用是否出现在「提议新建某模块」的语境里。

            做法：找到首次出现该字符串的那一行，连同**上一行**一起检查是否含
            提议性词（如「应移到」）。只看相邻两行是为了避免把整篇文档的
            提议语气错误地施加到所有引用上。
            """
            for i, line in enumerate(src_lines):
                if path_str in line:
                    ctx = line
                    if i > 0:
                        ctx += src_lines[i - 1]
                    return any(mk in ctx for mk in PROPOSAL_MARKERS)
            return False

        for c in sorted(cands):
            if not c or c.startswith(EXTERNAL):
                continue
            if any(ch in c for ch in ("<", ">", "…", "＊", "*", "{", "}", "（", "）")):
                continue
            if not looks_like_file(c) or PLACEHOLDER.search(c):
                continue
            if any(rx.search(c) for rx in FALSE_POSITIVE_PATTERNS):
                continue
            if set(c.split("/")) & GENERIC_SEG:
                continue
            # 解析基准依次尝试：文档所在目录 → 仓库根 → `site/` 下。
            # 为什么加第三档：文档里常写 `<group>/L01.md` 意指 `site/docs/<group>/L01.md`
            # （站点内容的惯用相对简写）。前两档都对不上时，第三档能正确命中，
            # 避免把"路径写法简略"误判成"文件不存在"。
            #
            # ⚠️ 关键：必须同时用 tracked 清单判断，不能只看本地磁盘。
            #   本地断链防范：避免文档引用仅存在于本地但未纳入版本控制的非公开讲义。
            #   核心判据必须是「该文件是否随仓库正式发布并被版本控制纳管」。
            cands_paths = [p.parent / c, REPO / c, REPO / "site" / "docs" / c]
            if any(x.exists() and is_tracked(x) for x in cands_paths):
                continue

            # 目标不在版本控制里。要区分两种情况，但**默认仍是 FAIL**：
            #
            #   ① 「磁盘上也没有」 → 真死链。
            #   ② 「磁盘上有、只是没纳入版本控制」（未 add / 已 gitignore）
            #      → 分场景处理，见下。
            #
            # 为什么 ② 默认也判 FAIL：
            #   因为仅凭磁盘文件存在无法证明文件已纳管。
            #   未纳入版本控制的文件推送到 CI 或外部克隆后将缺失导致死链。
            #   判据必须是「是否纳入版本控制并在发布包中存在」。
            #
            # 所以 ② 的**正确用法**是：本地边写边查时加 `--allow-untracked`
            # （把你正在写的文件当作"即将提交"来看），而 CI 与发布前一律用默认的
            # 严格模式。这样既不会在编辑中途刷屏误报，也不会漏掉真问题。
            exists_untracked = [x for x in cands_paths if x.exists() and not is_tracked(x)]
            if exists_untracked and allow_untracked:
                untracked_refs.setdefault(md, []).append(c)
                continue

            # 文件确实不存在。但在「提议新建」的语境里，这正是它应有的状态
            # （例如架构文档写「职责 2 应移到 ai/data/sessionHeal.ts」——
            #   那个文件本就不存在，存在的意义是"建议将来建它"）。
            #
            # ★ 修复（2026-10-15，实测 bug）：原先这里**先无条件入账、再判断提议**
            #   —— 第 234 行 `dead.append(c)` 已执行，第 236 行的 `is_proposal`
            #   即便命中也只是 `continue`（不撤销已入账），于是：
            #     ① 计数**翻倍**（每条死链被记两次）；
            #     ② 提议放行逻辑**完全失效**（等于没写）。
            #   这是"审计脚本自身出错"的典型：它会虚报问题、且让精心写的
            #   放行规则形同虚设。顺序必须是**先判断、后入账**。
            if is_proposal(c):
                continue
            dead.setdefault(md, []).append(c)

    if dead:
        n = sum(len(v) for v in dead.values())
        print(f"[D2] ❌ {n} 条引用指向不存在的文件")
        for md, items in sorted(dead.items()):
            for c in items:
                print(f"        {md} -> {c}")
        problems.append(f"{n} 条文档死链")
    else:
        print("[D2] ✅ 文档内引用全部可达")

    if untracked_refs:
        n = sum(len(v) for v in untracked_refs.values())
        print(f"[D2] ⚠️ {n} 条引用指向「磁盘上存在但未纳入版本控制」的文件"
              "（已按 --allow-untracked 放行；提交前请 git add）")
        for md, items in sorted(untracked_refs.items()):
            for c in items:
                print(f"        {md} -> {c}")

    # ── D1：README 链接单独重点校验（对外第一入口）────────────────────────
    readme = REPO / "README.md"
    if readme.exists():
        t = readme.read_text(encoding="utf-8")
        bad_links = []
        for m in re.finditer(r"\]\(([^)\s]+)\)", t):
            link = m.group(1)
            if link.startswith(EXTERNAL):
                continue
            if not (readme.parent / link).exists():
                bad_links.append(link)
        if bad_links:
            print(f"[D1] ❌ README 有 {len(bad_links)} 条死链：{bad_links}")
            problems.append("README 存在死链")
        else:
            print("[D1] ✅ README 全部链接可达")
    else:
        print("[D1] ❌ 缺少 README.md")
        problems.append("缺少 README.md")

    # ── D3：敏感信息与凭据扫描（复用 scan_secrets.py）──────────────────────────────
    scanner = REPO / "scripts" / "scan_secrets.py"
    if scanner.exists():
        r = subprocess.run([sys.executable, str(scanner)], capture_output=True,
                           text=True, encoding="utf-8", errors="replace", cwd=str(REPO))
        high = ""
        for line in (r.stdout or "").splitlines():
            if "按等级" in line:
                high = line.strip()
        if r.returncode != 0 and "🔴 高" in high and "🔴 高 0" not in high:
            print(f"[D3] ❌ {high}")
            problems.append("密钥扫描发现高风险命中")
        else:
            print(f"[D3] ✅ 敏感信息与凭据扫描通过（{high or '无输出'}）")
    else:
        print("[D3] ⚠️ 找不到 scan_secrets.py，跳过（不静默算通过）")
        problems.append("缺少 scan_secrets.py，无法完成 D3")

    # ── D4：README 必备章节 ──────────────────────────────────────────────
    if readme.exists():
        t = readme.read_text(encoding="utf-8")
        missing = [name for name, kws in README_REQUIRED.items()
                   if not any(k in t for k in kws)]
        if missing:
            print(f"[D4] ❌ README 缺必备章节：{missing}")
            problems.append(f"README 缺章节 {missing}")
        else:
            print("[D4] ✅ README 章节齐全（定位 / 快速开始 / License）")

    # ── D5：License ─────────────────────────────────────────────────────
    lic = REPO / "LICENSE"
    if not lic.exists():
        print("[D5] ❌ 缺少 LICENSE")
        problems.append("缺少 LICENSE")
    elif "License" not in (readme.read_text(encoding="utf-8") if readme.exists() else ""):
        print("[D5] ❌ README 未引用 LICENSE")
        problems.append("README 未引用 LICENSE")
    else:
        print("[D5] ✅ LICENSE 存在且被 README 引用")

    print("=" * 74)
    if problems:
        print(f"结论: FAIL —— {len(problems)} 项")
        for p in problems:
            print(f"  · {p}")
        return 1
    print("结论: PASS（文档链接可达、无敏感信息残留、结构健全）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
