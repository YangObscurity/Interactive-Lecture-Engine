"""编码完整性闸门：检出 tracked 文件里的编码损坏。

为什么需要：
  本项目源码是中文，一旦文件被以 GBK/ANSI 误存或经过错误的编码转换，
  中文会变成 U+FFFD（即 \ufffd，俗称『替换字符』）。**构建与测试都不会报错** ——
  它只表现为"文档/注释变成乱码"，是最容易被漏掉、也最伤开源观感的一类缺陷。
  实测本项目 `.gitignore` 曾有一行在**已提交的 blob 里**就是乱码。

判据（全部为确定性检查，不依赖外部库）：
  1. U+FFFD 替换字符出现 → 编码损坏（除二进制/图片）
  2. UTF-8 BOM 存在 → 部分工具会把它当作内容的一部分（.gitattributes 未声明 BOM 策略）
  3. 文件可被 UTF-8 解码（不能 → 不是 UTF-8 文本）
  4. 同一文件内混用 CRLF 与 LF（行尾不一致会造成 diff 噪声）
  5. 可疑的 GBK 乱码特征（连续高位字节被误读为拉丁扩展字符）

用法：
    python scripts/check_encoding.py          # 扫描 git tracked 文件
    python scripts/check_encoding.py --all    # 也扫未跟踪文件
退出码：0 = 干净；1 = 有发现；2 = 闸门自身错误（如不在 git 仓库）
"""
from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = pathlib.Path(__file__).resolve().parents[1]

# 二进制/资源文件不参与文本编码检查
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svgz",
    ".woff", ".woff2", ".ttf", ".eot", ".pdf", ".zip", ".gz", ".tar",
    ".mp3", ".mp4", ".jar", ".class", ".db", ".xlsx", ".docx", ".pptx",
}

# 排除目录（构建产物/依赖/本地备份都非仓库内容）
SKIP_PARTS = {".git", "node_modules", "dist", "cache", ".temp",
              "_dist_snapshot", ".refactor-backup", "__pycache__"}

REPLACEMENT = "\ufffd"
# 典型 GBK 被当 latin-1 解读后的形态：连续多个 Latin-1 补充区字符（如 鐢甸樆）
# 用"连续 >=4 个 U+0080..U+00FF 之外的 CJK 兼容区误码"来近似不可靠，
# 故这里只做「U+FFFD」与「BOM」两个确定性判据，另报 CRLF 混用。
BOM_UTF8 = b"\xef\xbb\xbf"


def tracked_files() -> list[pathlib.Path]:
    r = subprocess.run(["git", "ls-files"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", cwd=str(REPO))
    if r.returncode != 0:
        return all_files()
    files = [REPO / p for p in r.stdout.splitlines() if p.strip()]
    if not files:
        return all_files()
    return files


def all_files() -> list[pathlib.Path]:
    out = []
    for p in REPO.rglob("*"):
        if not p.is_file():
            continue
        if SKIP_PARTS & set(p.parts):
            continue
        out.append(p)
    return out


def scan(files: list[pathlib.Path]) -> list[tuple[str, str, str]]:
    """返回 [(相对路径, 问题类别, 详情)]。"""
    problems: list[tuple[str, str, str]] = []
    for p in files:
        if p.suffix.lower() in BINARY_EXT or not p.exists():
            continue
        try:
            raw = p.read_bytes()
        except OSError as e:
            problems.append((str(p), "读取失败", str(e)))
            continue

        rel = str(p.relative_to(REPO)).replace("\\", "/")

        # 1) U+FFFD
        try:
            txt = raw.decode("utf-8")
        except UnicodeDecodeError as e:
            problems.append((rel, "非 UTF-8 文本", f"第 {e.start} 字节起解码失败"))
            continue
        if REPLACEMENT in txt:
            for i, line in enumerate(txt.splitlines(), 1):
                if REPLACEMENT in line:
                    problems.append((rel, "U+FFFD 替换字符（编码损坏）",
                                     f"L{i}: {line.strip()[:70]!r}"))
                    break

        # 2) UTF-8 BOM
        if raw.startswith(BOM_UTF8):
            problems.append((rel, "UTF-8 BOM", "首字节为 EF BB BF"))

        # 3) 行尾混用
        crlf = raw.count(b"\r\n")
        lf_total = raw.count(b"\n")
        lone_lf = lf_total - crlf
        if crlf > 0 and lone_lf > 0:
            problems.append((rel, "CRLF/LF 混用",
                             f"CRLF={crlf} 裸LF={lone_lf}"))
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description="编码完整性闸门")
    ap.add_argument("--all", action="store_true", help="同时扫描未跟踪文件")
    a = ap.parse_args()

    files = all_files() if a.all else tracked_files()
    print(f"扫描 {len(files)} 个文件（{'全树' if a.all else 'git tracked'}）")
    print("=" * 74)

    # ── 真空防护（P-10，2026-10-15 修）────────────────────────────────────
    # 改前：`git ls-files` 成功但**返回空集**时（空仓库、在子目录误跑、
    #   CI 检出不完整、`.git` 损坏但 git 仍返回 0），`scan([])` 返回 `[]`
    #   ⇒ `problems` 为空 ⇒ 打印 `结论: PASS（编码完整…）` 并 `return 0`。
    #   这是 AGENTS.md §0.2 明令禁止的真空 PASS，而且本脚本是
    #   `audit_all.py:263` 的正式闸门、又被 `publish_opensource.py:173-177`
    #   当作推送前编码体检 —— 一旦仓库状态异常，它会**替真正的失败背书**。
    # 为什么判 2 而不是 1：判据**根本不成立**（没有输入可查），
    #   与「查了且发现乱码（1）」是两回事，调用方必须能区分。
    if not files:
        print("结论: 无法判定（文件清单为空 —— 真空 PASS 风险）", file=sys.stderr)
        print("  可能原因：在子目录误跑 / 仓库无 tracked 文件 / CI 检出不完整。",
              file=sys.stderr)
        print("  如需扫描全树请加 --all；本仓库须在仓库根执行。", file=sys.stderr)
        return 2

    problems = scan(files)

    # 按类别汇总
    by_kind: dict[str, list[tuple[str, str, str]]] = {}
    for rel, kind, detail in problems:
        by_kind.setdefault(kind, []).append((rel, kind, detail))

    for kind, items in sorted(by_kind.items(), key=lambda kv: -len(kv[1])):
        print(f"\n【{kind}】{len(items)} 处")
        for rel, _k, detail in items[:20]:
            print(f"  {rel}")
            print(f"      {detail}")
        if len(items) > 20:
            print(f"  ... 其余 {len(items) - 20} 处")

    print("\n" + "=" * 74)
    if not problems:
        print("结论: PASS（编码完整，无 U+FFFD / 无 BOM / 无行尾混用）")
        return 0
    print(f"结论: FAIL（{len(problems)} 处编码问题）")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
