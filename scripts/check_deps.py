#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""check_deps.py —— 依赖一致性闸门（开源前依赖健康度硬检查）。

作用
----
扫描站点源码里的所有 import / export ... from / 动态 import()，与
``site/package.json`` 的 dependencies + devDependencies 对账，报告三类问题：

1. **未声明依赖**（源码 import 了，但 package.json 没写）
   —— 这类包当前通常靠"传递依赖"侥幸能解析，一旦上游依赖树变动就会
      在别人机器上直接构建失败。这是发布开源仓库前最危险的一类问题。
2. **僵尸依赖**（package.json 写了，但源码从未 import）
   —— 白白拉大安装体积、扩大攻击面，还会在 ``npm audit`` 里贡献漏洞。
3. **可疑传递依赖**（既未声明、也非直接 import，但由某个已声明包带进来）
   —— 仅作提示：它可能"现在能用"，但契约上不属于本仓库。

设计约束（遵循 AGENTS.md §6.3）
------------------------------
* **路径从 ``__file__`` 推导**，严禁硬编码绝对路径（否则 Linux/CI 直接不可用）。
* **结论必须反映到退出码**：0 = 通过，1 = 发现问题，2 = 无法判定（真空防护）。
* **真空防护**：扫不到任何源码文件、或 package.json 缺失/无依赖时，
  一律以 **非 0** 退出并明确报告"无法判定"，**绝不允许"扫了个空集却报 PASS"**。
* 幂等：只读，不产生任何文件改动。

用法
----
    python scripts/check_deps.py            # 检查
    python scripts/check_deps.py --verbose  # 附带每个包的引用位置

退出码
------
    0  通过（无未声明依赖，且无僵尸依赖；或仅存在被白名单豁免的提示）
    1  发现未声明依赖 或 僵尸依赖
    2  无法判定（真空防护触发 / package.json 缺失）
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

# 强制 UTF-8 输出：Windows 默认 GBK 控制台在打印中文/特殊字符时会抛
# UnicodeEncodeError，把"终端编码问题"误报成"脚本坏了"。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
except (AttributeError, ValueError):  # pragma: no cover - 老 Python / 特殊环境
    pass

# ── 路径推导（严禁硬编码）──────────────────────────────────────────────
REPO = pathlib.Path(__file__).resolve().parents[1]
SITE = REPO / "site"
PKG_JSON = SITE / "package.json"
SRC_ROOT = SITE / "docs" / ".vitepress"

# 扫描时排除的目录名（构建产物 / 依赖 / 缓存，错误 import 不具代表性）
EXCLUDE_DIRS = {"node_modules", "dist", "cache", ".temp", ".git"}

SOURCE_EXTS = {".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".vue"}

# ── 白名单：已知且**有理由**的例外 ─────────────────────────────────────
# 说明：这些包出现在源码 import 中但不应（或暂不）计入"未声明依赖"。
# 白名单必须写明理由，且尽量收窄；不允许为了"让它变绿"而随意添加。
ALLOW_UNRESOLVED = {
    # Node 内置模块：由运行时提供，绝非 npm 依赖。
    # （已在 pkg_of() 中归一为 node: 前缀，此处保留以防遗漏。）
}

# 允许"声明了但未直接 import"的包：它们由**用户在运行时**通过
# markdown / 配置文件间接使用，静态 import 扫描天然看不到。
ALLOW_UNUSED = {
    # mermaid / echarts / wavedrom 是动态 import 的，已被扫到，无需豁免。
    # markmap-lib 不在其列 —— 它是真僵尸（见审计报告）。
}

# ── import 语法正则 ───────────────────────────────────────────────────
# 覆盖：import x from 'm' / import {a} from 'm' / import 'm'
#       export {a} from 'm' / export * from 'm'
STATIC_IMPORT = re.compile(
    r"""(?:^|[\s;}])(?:import|export)\s+(?:[^'"();]*?\s+from\s+)?['"]([^'"]+)['"]""",
    re.MULTILINE,
)
# 覆盖：await import('m') / import('m')
DYNAMIC_IMPORT = re.compile(r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")


def pkg_of(spec: str) -> str | None:
    """把 import 说明符归一为顶层包名。

    返回 None 表示"不是 npm 包"（相对路径 / 绝对路径）。
    ``@scope/name/sub`` -> ``@scope/name``
    ``name/sub/path``   -> ``name``
    ``node:fs``         -> ``node:fs``（内置模块，调用方负责跳过）
    """
    if not spec:
        return None
    if spec.startswith(".") or spec.startswith("/"):
        return None
    if spec.startswith("node:"):
        return spec
    parts = spec.split("/")
    if spec.startswith("@"):
        return "/".join(parts[:2]) if len(parts) >= 2 else spec
    return parts[0]


def is_builtin(pkg: str) -> bool:
    """判断是否 Node 内置模块（node: 前缀，或裸内置名如 fs/path/url）。"""
    if pkg.startswith("node:"):
        return True
    return pkg in {
        "fs", "path", "url", "os", "util", "events", "stream", "crypto",
        "http", "https", "zlib", "child_process", "assert", "buffer",
        "process", "vm", "worker_threads", "readline", "querystring",
    }


def collect_sources() -> list[pathlib.Path]:
    """收集所有待扫描的源码文件（排除 node_modules / dist / cache）。"""
    if not SRC_ROOT.is_dir():
        return []
    out: list[pathlib.Path] = []
    for p in SRC_ROOT.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in SOURCE_EXTS:
            continue
        rel_parts = p.relative_to(SRC_ROOT).parts[:-1]
        if any(part in EXCLUDE_DIRS for part in rel_parts):
            continue
        out.append(p)
    return sorted(out)


def scan_imports(files: list[pathlib.Path]):
    """返回 (静态引用表, 动态引用表)；表结构 {包名: {相对路径, ...}}。"""
    static: dict[str, set[str]] = {}
    dynamic: dict[str, set[str]] = {}
    for f in files:
        text = f.read_text(encoding="utf-8", errors="replace")
        rel = f.relative_to(REPO).as_posix()
        for m in STATIC_IMPORT.finditer(text):
            pkg = pkg_of(m.group(1))
            if pkg and not is_builtin(pkg):
                static.setdefault(pkg, set()).add(rel)
        for m in DYNAMIC_IMPORT.finditer(text):
            pkg = pkg_of(m.group(1))
            if pkg and not is_builtin(pkg):
                dynamic.setdefault(pkg, set()).add(rel)
    return static, dynamic


def load_manifest():
    """读取 package.json；失败返回 None。"""
    if not PKG_JSON.is_file():
        return None
    try:
        return json.loads(PKG_JSON.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser(
        description="依赖一致性闸门：源码 import vs site/package.json"
    )
    ap.add_argument("--verbose", "-v", action="store_true",
                    help="打印每个包的引用位置")
    args = ap.parse_args()

    print("=" * 68)
    print(" 依赖一致性闸门 check_deps.py")
    print("=" * 68)
    print("仓库根目录 : %s" % REPO)
    print("清单文件   : %s" % PKG_JSON.relative_to(REPO).as_posix())

    # ── 前置校验：清单必须存在且可用（否则"无法判定"而非 PASS）──────────
    manifest = load_manifest()
    if manifest is None:
        print()
        print("[无法判定] 读不到或无法解析 %s" % PKG_JSON)
        print("           → 真空防护：不以 0 退出（绝不允许空集报 PASS）。")
        return 2

    declared = set(manifest.get("dependencies") or {})
    declared |= set(manifest.get("devDependencies") or {})
    # ★ 选装依赖（optionalDependencies）也算「已声明」（2026-10-16 修）。
    #
    # 为什么必须认它：本仓库有**功能可选、但体积巨大**的依赖 ——
    # 典型是 `puppeteer`（导出套件用它做无头截图/打印，装它会拉 ~300MB Chromium）。
    # 把它写进 dependencies 会强加给每一个只想看站点的人；
    # 写进 optionalDependencies 才是准确表达「可选」。
    # 若闸门不认这一类，维护者就只剩两个坏选择：要么强加重依赖，
    # 要么为了「让闸门变绿」而干脆不声明 —— 后者更糟（源码 import 了却不声明）。
    # 认它，是为了让「诚实地声明为可选」成为可行选项。
    declared |= set(manifest.get("optionalDependencies") or {})
    optional = set(manifest.get("optionalDependencies") or {})
    if not declared:
        print()
        print("[无法判定] package.json 里 dependencies / devDependencies / "
              "optionalDependencies 均为空")
        print("           → 真空防护：不以 0 退出（绝不允许空集报 PASS）。")
        return 2

    # ── 收集源码 ──────────────────────────────────────────────────────
    files = collect_sources()
    print("源码根目录 : %s" % SRC_ROOT.relative_to(REPO).as_posix())
    print("扫描文件数 : %d（%s）" % (len(files), " ".join(sorted(SOURCE_EXTS))))
    if not files:
        print()
        print("[无法判定] 未扫描到任何源码文件 —— 扫描集为空")
        print("           → 真空防护：不以 0 退出（绝不允许空集报 PASS）。")
        return 2

    static, dynamic = scan_imports(files)
    used = set(static) | set(dynamic)

    # ── 对账 ──────────────────────────────────────────────────────────
    undeclared = sorted(used - declared - set(ALLOW_UNRESOLVED))
    unused = sorted(declared - used - set(ALLOW_UNUSED))

    print()
    print("已声明包数 : %d（其中选装 %d）" % (len(declared), len(optional)))
    print("源码引用包 : %d" % len(used))
    if optional:
        # 选装依赖单独列出：它们「不装也能跑，装了才有某项功能」。
        # 值得让维护者一眼看到有哪些可选能力，而不是埋在 dependencies 里。
        print("选装依赖   : %s" % "、".join(sorted(optional)))
    print()

    # 1) 未声明依赖
    print("-" * 68)
    print("[1] 未声明依赖（源码 import 了，package.json 没写）")
    print("-" * 68)
    if undeclared:
        for pkg in undeclared:
            where = sorted(static.get(pkg, set()) | dynamic.get(pkg, set()))
            kind = []
            if pkg in static:
                kind.append("静态×%d" % len(static[pkg]))
            if pkg in dynamic:
                kind.append("动态×%d" % len(dynamic[pkg]))
            print("  [X] %-28s %s" % (pkg, " + ".join(kind)))
            if args.verbose:
                for w in where:
                    print("        ← %s" % w)
        print()
        print("  ⇒ 危险：这些包当前多半靠**传递依赖**侥幸可解析，")
        print("    上游依赖树一变就会在别人机器上直接构建失败。")
    else:
        print("  [OK] 无未声明依赖。")

    # 2) 僵尸依赖
    #
    # ⚠️ 选装依赖（optionalDependencies）**不参与**僵尸判定（2026-10-16 修）。
    #    「僵尸」的语义是「声明了却从没用过，白拉体积」；
    #    而选装依赖的本意就是「**可能**用、不装也能跑」——
    #    它在源码里往往还是**运行期拼接**的模块名（为了不被静态分析强绑），
    #    静态扫描必然看不到。把它判僵尸会逼维护者删掉声明，
    #    结果就是「源码 import 了却不声明」——比僵尸更糟。
    print()
    print("-" * 68)
    print("[2] 僵尸依赖（package.json 写了，源码从未 import）")
    print("-" * 68)
    zombie = [p for p in unused if p not in optional]
    skipped_optional = [p for p in unused if p in optional]
    if zombie:
        for pkg in zombie:
            print("  [!] %-28s 声明为 %s" % (
                pkg,
                (manifest.get("dependencies") or {}).get(pkg)
                or (manifest.get("devDependencies") or {}).get(pkg),
            ))
        print()
        print("  ⇒ 提示：白拉安装体积、扩大攻击面，且常连带 `npm audit` 漏洞。")
        print("    删除前请人工确认它不被 markdown/配置**运行时**间接使用。")
    else:
        print("  [OK] 无僵尸依赖。")
    if skipped_optional:
        print()
        print("  （选装依赖不参与僵尸判定，故以下不计：%s）"
              % "、".join(sorted(skipped_optional)))

    # 3) 传递依赖提示（既未声明也非直接 import，但装得到）
    print()
    print("-" * 68)
    print("[3] 可疑传递依赖提示")
    print("-" * 68)
    lock = SITE / "package-lock.json"
    if lock.is_file():
        try:
            lk = json.loads(lock.read_text(encoding="utf-8"))
            pkgs = lk.get("packages") or {}
            hoisted = {
                n[len("node_modules/"):]: e.get("version")
                for n, e in pkgs.items()
                if n.startswith("node_modules/")
                and "/" not in n[len("node_modules/"):].rstrip("/")
            }
            # 只提示"被源码用到但未声明"的（已在 [1] 报过），此处补充版本，
            # 便于判断是哪个上游把它带进来的。
            if undeclared:
                for pkg in undeclared:
                    if pkg in hoisted:
                        print("  [?] %-28s 由 node_modules 实际提供 v%s（传递依赖）"
                              % (pkg, hoisted[pkg]))
            else:
                print("  [OK] 无需要提示的传递依赖。")
        except (json.JSONDecodeError, OSError):
            print("  [?] package-lock.json 无法解析，跳过传递依赖分析。")
    else:
        print("  [?] 无 package-lock.json，跳过传递依赖分析。")

    # ── 结论 + 退出码（必须一致）──────────────────────────────────────
    # 判据用 `zombie`（已排除选装依赖），与 [2] 的输出口径保持一致 ——
    # 否则会出现「报告说无僵尸、退出码却说有僵尸」的自相矛盾。
    ok = not undeclared and not zombie
    print()
    print("=" * 68)
    if ok:
        print(" 结论: PASS —— 依赖声明与源码 import 完全一致")
        if skipped_optional:
            print("       （选装依赖另计，不参与对账：%s）"
                  % "、".join(sorted(skipped_optional)))
        print("=" * 68)
        return 0
    print(" 结论: FAIL —— 未声明 %d 个 / 僵尸 %d 个"
          % (len(undeclared), len(zombie)))
    print("=" * 68)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
