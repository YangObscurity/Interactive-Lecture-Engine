#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""safe_build.py — 取得构建锁后执行 `npm run build`（**所有构建的唯一入口**）。

## 为什么必须有这个「唯一入口」

`scripts/build_lock.py` 提供了锁，但锁只有被**使用**才有意义。
2026-10-14 实测：在锁已上线之后，仍有三个并行智能体各自**直接**跑 `npm run build`，
绕过了锁，再次把 `site/docs/.vitepress/dist` 打成半成品。

结论：**光有锁不够，必须有唯一入口**。本脚本就是那个入口：
它把「取锁 → 构建 → 校验产物 → 放锁」封成一个原子动作，
调用方只要记住「构建就调 safe_build.py」这一件事即可。

## 它在锁之上还多做三件事（都是踩过的坑）

1. **构建前检测并发构建**：若发现别的 vitepress build 进程正在跑，直接拒绝并列出 PID。
   为什么不全靠文件锁：文件锁只保护「愿意用锁的人」；直接跑 npm 的人锁不住，
   所以这里额外用**进程探测**兜底，把绕过锁的情况也拦住。
2. **构建后校验产物**：断言 dist 里 `.html` 数量达到预期下限、且关键页面存在。
   为什么必要：并发构建最危险的表现不是报错，而是**打印了 `✓ rendering pages...`
   但 dist 是残缺的**（HTML 数量为 0）。只看退出码会把事故当成功。
3. **记录构建事实**：把页数/耗时/产物大小写进 `.refactor-backup/build_history.json`，
   让「什么时候构过、构出多少页」有据可查，便于比对「重构是否掉了页面」。

## 用法

    python scripts/safe_build.py                    # 取锁构建 + 校验
    python scripts/safe_build.py --purpose "终验"    # 带用途说明（便于排查）
    python scripts/safe_build.py --expect-pages 300 # 自定义页数下限断言
    python scripts/safe_build.py --no-verify        # 跳过产物校验（不推荐）
    python scripts/safe_build.py --check-only       # 只看产物现状，不构建
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parent.parent
SITE = REPO / "site"
DIST = SITE / "docs" / ".vitepress" / "dist"
HISTORY = REPO / ".refactor-backup" / "build_history.json"

sys.path.insert(0, str(REPO / "scripts"))
from build_lock import build_lock, BuildLockTimeout  # noqa: E402

# 页数下限：**随仓库形态自适应**，不是固定常数。
#
# 架构规范：
#   本仓库有两个合法形态：
#     · 外部讲义接入形态：挂载了全量讲义内容源时，页面量较多（默认下限 300）
#     · 纯净开源引擎形态：只有引擎自带示例与核心入口（下限约 3~6 页）
#   闸门根据实际内容存在性动态切换阈值，避免纯引擎环境下误报。
#
# 对齐 `audit_all.py` 已有的同款逻辑（BASELINE_HTML_*），保持两个闸门口径一致。
MIN_PAGES_WITH_LECTURES = 300
MIN_PAGES_ENGINE_ONLY = 3   # index + 404 + 示例页的下限（保守取值）


def has_lectures() -> bool:
    """仓库当前是否携带讲义（决定页数下限取哪一个）。

    判据与 `audit_all.py::_has_lectures()` 一致：
    同时存在 `**/L*.md` 与 `g*/L*.md` 才算「带讲义」。
    开源形态下 `g*/` 不存在，只有 `examples/` 里的示例讲次。
    """
    docs = SITE / "docs"
    return any(docs.glob("**/L*.md")) and any(docs.glob("g*/L*.md"))


def default_min_pages() -> int:
    return MIN_PAGES_WITH_LECTURES if has_lectures() else MIN_PAGES_ENGINE_ONLY


def find_concurrent_builds() -> list[tuple[int, str]]:
    """探测是否已有其它 vitepress build 进程在跑。返回 [(pid, cmdline)]。

    刻意**不把锁**作为唯一防线：这个探测能拦住「绕过锁直接跑 npm run build」的情况，
    而那正是实测发生过的绕过方式。
    """
    me = {__import__("os").getpid()}
    found: list[tuple[int, str]] = []

    # ★ 必须只看**本仓库**的构建进程。
    #
    #   原实现只匹配 `*vitepress*` + `*build*`，导致同机其他项目的 VitePress
    #   在构建时也会触发误报阻断。并发风险只存在于同一个 dist 目录，
    #   因此判据必须是「命令行指向本仓库的 site 目录」。
    our_site = str(SITE.resolve()).replace("\\", "/").lower()

    def is_ours(cmdline: str) -> bool:
        c = (cmdline or "").replace("\\", "/").lower()
        # 命令行里出现本仓库的 site 路径，或在**本仓库目录内**以相对路径调用
        return our_site in c or f"{str(REPO.resolve()).replace(chr(92), '/').lower()}/site" in c

    if sys.platform == "win32":
        ps = (
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
            "Where-Object { $_.CommandLine -like '*vitepress*' -and "
            "$_.CommandLine -like '*build*' } | "
            "Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
        )
        try:
            r = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                               capture_output=True, text=True, timeout=45,
                               encoding="utf-8", errors="replace")
            raw = (r.stdout or "").strip()
            if raw:
                data = json.loads(raw)
                if isinstance(data, dict):
                    data = [data]
                for d in data:
                    pid = int(d.get("ProcessId") or 0)
                    cmd = d.get("CommandLine") or ""
                    if pid and pid not in me and is_ours(cmd):
                        found.append((pid, cmd[:110]))
        except Exception:
            pass  # 探测失败不应阻断构建；不假装探测成功
    else:
        try:
            r = subprocess.run(["pgrep", "-af", "vitepress"], capture_output=True,
                               text=True, timeout=15)
            for line in (r.stdout or "").splitlines():
                if "build" in line:
                    pid_s, _, cmd = line.partition(" ")
                    try:
                        pid = int(pid_s)
                    except ValueError:
                        continue
                    if pid not in me and is_ours(cmd):
                        found.append((pid, cmd[:110]))
        except Exception:
            pass
    return found


def count_pages() -> int:
    if not DIST.is_dir():
        return 0
    return sum(1 for _ in DIST.rglob("*.html"))


def verify_dist(min_pages: int) -> tuple[bool, list[str]]:
    """校验产物完整性。返回 (是否通过, 问题清单)。"""
    problems: list[str] = []
    n = count_pages()
    if not DIST.is_dir():
        problems.append(f"dist 目录不存在：{DIST}")
        return False, problems
    if n < min_pages:
        problems.append(
            f"HTML 页数 {n} < 下限 {min_pages} —— 疑似构建残缺（并发构建的典型症状）"
        )
    # 关键产物存在性
    for rel in ("index.html",):
        if not (DIST / rel).exists():
            problems.append(f"缺少关键产物：dist/{rel}")
    if not (DIST / "assets").is_dir():
        problems.append("缺少 dist/assets/ —— 资源未产出")
    # 讲义与示例目录：有内容源或示例时应存在
    content_dirs = [d for d in DIST.iterdir() if d.is_dir() and d.name not in ("assets", ".vitepress")] if DIST.is_dir() else []
    if not content_dirs:
        problems.append("dist 下未发现任何讲义或示例目录 —— 内容整体缺失")
    return (not problems), problems


def record(pages: int, seconds: float, ok: bool, purpose: str) -> None:
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    hist: list = []
    if HISTORY.exists():
        try:
            hist = json.loads(HISTORY.read_text(encoding="utf-8"))
            if not isinstance(hist, list):
                hist = []
        except (OSError, json.JSONDecodeError):
            hist = []
    size_mb = 0.0
    if DIST.is_dir():
        size_mb = sum(f.stat().st_size for f in DIST.rglob("*") if f.is_file()) / 1024 / 1024
    hist.append({
        "at": datetime.now().isoformat(timespec="seconds"),
        "pages": pages,
        "seconds": round(seconds, 1),
        "dist_mb": round(size_mb, 1),
        "ok": ok,
        "purpose": purpose,
    })
    HISTORY.write_text(json.dumps(hist[-50:], ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description="唯一的构建入口：取锁 + 构建 + 产物校验")
    ap.add_argument("--purpose", default="safe_build", help="用途说明")
    ap.add_argument("--expect-pages", type=int, default=None,
                    help="HTML 页数下限断言。不传时**按仓库形态自适应**："
                         "带讲义 %d 页，纯引擎形态 %d 页"
                         % (MIN_PAGES_WITH_LECTURES, MIN_PAGES_ENGINE_ONLY))
    ap.add_argument("--no-verify", action="store_true", help="跳过产物校验")
    ap.add_argument("--check-only", action="store_true", help="只检查产物现状，不构建")
    ap.add_argument("--timeout", type=float, default=1800.0, help="等锁超时秒数")
    a = ap.parse_args()

    # 页数下限：未显式指定时按仓库形态自适应（见文件头 MIN_PAGES_* 的说明）
    if a.expect_pages is None:
        a.expect_pages = default_min_pages()
        shape = "含讲义" if has_lectures() else "纯引擎（仅自带示例）"
        print(f"[safe_build] 仓库形态：{shape} → 页数下限 {a.expect_pages}")

    if a.check_only:
        ok, problems = verify_dist(a.expect_pages)
        print(f"dist 页数 = {count_pages()}")
        if ok:
            print("✅ 产物完整")
            return 0
        print("❌ 产物有问题：")
        for p in problems:
            print(f"   - {p}")
        return 1

    # 1) 并发构建兜底探测（拦「绕过锁」的人）
    busy = find_concurrent_builds()
    if busy:
        print("❌ 检测到已有构建进程在运行，拒绝并发构建（会把 dist 打成半成品）：")
        for pid, cmd in busy:
            print(f"   PID {pid}: {cmd}")
        print("\n   处理：等它跑完，或先结束这些进程；"
              "或改用本脚本串行构建。")
        return 3

    t0 = time.time()
    try:
        with build_lock(a.purpose, a.timeout):
            # 2) 取到锁后再探测一次：锁只能挡住「用锁的人」，
            #    这里再确认没有绕过锁的构建在跑，然后才动 dist。
            busy = find_concurrent_builds()
            if busy:
                print("⚠️ 持锁期间发现其它构建进程，为安全起见中止：")
                for pid, cmd in busy:
                    print(f"   PID {pid}: {cmd}")
                return 3

            print("[safe_build] 执行 npm run build ...")
            r = subprocess.run("npm run build", shell=True, cwd=str(SITE))
            if r.returncode != 0:
                print(f"[safe_build] ❌ 构建失败（exit {r.returncode}）")
                record(count_pages(), time.time() - t0, False, a.purpose)
                return r.returncode
    except BuildLockTimeout as e:
        print(f"❌ {e}")
        return 4

    elapsed = time.time() - t0
    pages = count_pages()
    print(f"[safe_build] 构建完成：{pages} 页，耗时 {elapsed:.1f}s")

    if a.no_verify:
        record(pages, elapsed, True, a.purpose)
        return 0

    ok, problems = verify_dist(a.expect_pages)
    record(pages, elapsed, ok, a.purpose)
    if not ok:
        print("❌ 产物校验未通过：")
        for p in problems:
            print(f"   - {p}")
        return 1
    print("✅ 产物校验通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
