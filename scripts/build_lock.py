#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_lock.py — 构建互斥闸门：**同一时刻只允许一个 vitepress build 写 dist**。

## 为什么需要它（真实事故，非假设）

本项目支持多智能体并行重构。2026-10-14 实测发生了一次事故：
三个子智能体**各自**在同一个 `site/` 下跑 `npm run build`，VitePress 不会拒绝并发——

- 三个进程同时往 `site/docs/.vitepress/dist` 写；
- VitePress 构建**开头就会清空 dist**，于是 A 清空、B 正在写、C 再清空；
- 中间态表现为 `dist/` 里只剩 `assets/` 与 `charts/`、**`.html` 数量 = 0**；
- 此时任何静态服务器都返回 404，无头浏览器 `document.title = "Error response"`。

**危险之处不是构建失败，而是它「看起来像成功了」**：并发构建最终往往都能打印
`✓ rendering pages...`，但在构建窗口内去读 dist 的**任何审计都会读到半成品**，
于是「视觉审计」拿到 `.cite = 0` 或页面 404，得出一个**完全虚假的结论**——
要么假 PASS（漏掉真实回归），要么假 FAIL（浪费大量时间追一个不存在的 bug）。

结论：**并发读 dist 是安全的，并发写 dist 必须串行化。** 本模块提供该串行化。

## 机制

用一把**跨进程文件锁**（Windows 用 `msvcrt.locking`，POSIX 用 `fcntl.flock`），
零第三方依赖。锁文件在 `.refactor-backup/.build.lock`（该目录已被 .gitignore 忽略）。

- `acquire()`：拿不到锁就**阻塞等待**（默认最长 30 分钟），拿到为止。
  为什么阻塞而不是立即失败：重构场景下等待几分钟远好过让调用方重试逻辑出错。
- 超时后抛 `BuildLockTimeout`，并**提示当前持锁者是谁**（写入锁文件的 PID/时间/用途），
  避免「锁住了但不知道谁锁的」这种最让人恼火的情况。
- 支持 `with build_lock("视觉审计基线"):` 上下文管理器，异常路径也必定释放。

## 用法

命令行（给 CI / shell 用）：

    python scripts/build_lock.py --run "npm run build" --purpose "Lead 终验"
    python scripts/build_lock.py --status

Python（给脚本用）：

    from build_lock import build_lock
    with build_lock("视觉审计基线"):
        subprocess.run(["npm", "run", "build"], cwd="site", check=True)

## 约定（写进协作规范的铁律）

> **任何会写 `site/docs/.vitepress/dist` 的操作，必须先取得本锁。**
> 只读 dist 的审计（统计 .cite 数、截图）建议**先确认没有 build 在跑**
> （`python scripts/build_lock.py --status`），否则审计结论不可信。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = Path(__file__).resolve().parent.parent
LOCK_DIR = REPO / ".refactor-backup"
LOCK_FILE = LOCK_DIR / ".build.lock"
# ★ 持锁者信息单独放一个文件，**不能**写进被锁的那个文件。
#   原因（Windows 实测踩坑）：`msvcrt.locking` 锁住的是文件的**字节区间**，
#   被锁区间在持锁期间对该文件其它句柄的 read **会直接抛 PermissionError**，
#   而不是读到旧内容。若把 owner 信息写进 LOCK_FILE，则 `--status` 在读它时
#   必然失败 → 永远显示「无法读取持锁者信息」，排查能力归零。
#   拆成两个文件后：锁文件只承担互斥，信息文件只承担可读的诊断信息。
OWNER_FILE = LOCK_DIR / ".build.lock.owner"

DEFAULT_TIMEOUT = 1800.0          # 30 分钟：单次全站构建约 20-60s，留足排队余量
POLL_INTERVAL = 0.5


class BuildLockTimeout(RuntimeError):
    """等待构建锁超时。"""


def _lock_fd(fd: int) -> None:
    """对已打开的 fd 加**排他**锁。跨平台分支，零第三方依赖。"""
    if os.name == "nt":
        import msvcrt

        # msvcrt.locking 锁的是文件的一段区域；从当前位置锁 1 字节即可。
        # LK_NBLCK = 非阻塞；拿不到会抛 OSError。故外层用轮询实现「限时阻塞」。
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock_fd(fd: int) -> None:
    if os.name == "nt":
        import msvcrt

        try:
            # 必须先 seek 回 0：锁是针对「文件区域」的，位置错了会解锁不存在的区域。
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        import fcntl

        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass


def _write_owner_info(fd: int, purpose: str) -> None:
    """把持锁者信息写进**独立的** OWNER_FILE（见上方注释：不能写进被锁的文件）。

    原子写：先写临时文件再 os.replace，避免 --status 读到写了一半的 JSON。
    """
    info = {
        "pid": os.getpid(),
        "purpose": purpose,
        "since": datetime.now().isoformat(timespec="seconds"),
        "cwd": os.getcwd(),
    }
    try:
        tmp = OWNER_FILE.with_suffix(".owner.tmp")
        tmp.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(str(tmp), str(OWNER_FILE))
    except OSError:
        pass


def read_owner_info() -> dict | None:
    """读取当前锁文件里的持锁者信息（不判断锁是否真的还持有）。"""
    try:
        raw = OWNER_FILE.read_text(encoding="utf-8", errors="replace").strip()
        if not raw:
            return None
        return json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return None


def _alive(pid: int) -> bool:
    """判断 PID 是否仍存活 —— 用于识别「锁已释放但信息残留」的陈旧记录。"""
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            r = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True, text=True, timeout=10,
            )
            return str(pid) in (r.stdout or "")
        os.kill(pid, 0)
        return True
    except Exception:
        return False


@contextmanager
def build_lock(purpose: str = "build", timeout: float = DEFAULT_TIMEOUT):
    """取得构建锁的上下文管理器。退出（含异常）必定释放。"""
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(LOCK_FILE), os.O_RDWR | os.O_CREAT, 0o644)
    acquired = False
    deadline = time.time() + timeout
    try:
        while True:
            try:
                _lock_fd(fd)
                acquired = True
                break
            except OSError:
                if time.time() >= deadline:
                    owner = read_owner_info()
                    who = (
                        f"PID {owner.get('pid')} 用途「{owner.get('purpose')}」"
                        f" 自 {owner.get('since')}"
                        if owner else "（无法读取持锁者信息）"
                    )
                    raise BuildLockTimeout(
                        f"等待构建锁超时（{timeout:.0f}s）。当前持锁者：{who}\n"
                        f"  排查：python scripts/build_lock.py --status\n"
                        f"  若持锁进程已死，锁会自动释放，可直接重试。"
                    )
                time.sleep(POLL_INTERVAL)

        _write_owner_info(fd, purpose)
        print(f"[build_lock] 已取得构建锁（PID {os.getpid()}，用途：{purpose}）")
        yield

    finally:
        if acquired:
            _unlock_fd(fd)
            # 清掉诊断信息：留着一个已退出的 PID 会让 --status 误报「有构建在跑」。
            # 但**只在确实是本进程持锁时**清（acquired=True），避免误删别人的记录。
            try:
                OWNER_FILE.unlink()
            except OSError:
                pass
            print(f"[build_lock] 已释放构建锁（PID {os.getpid()}）")
        os.close(fd)


def cmd_status() -> int:
    owner = read_owner_info()
    if not owner:
        print("构建锁：空闲（无记录）")
        return 0

    pid = int(owner.get("pid") or 0)
    alive = _alive(pid)
    print("构建锁状态：")
    print(f"  持锁 PID   : {pid}  ({'存活' if alive else '已退出 → 锁已自动释放'})")
    print(f"  用途       : {owner.get('purpose')}")
    print(f"  取得时间   : {owner.get('since')}")
    print(f"  工作目录   : {owner.get('cwd')}")
    if not alive:
        print("\n  → 无活动构建。可以安全地重建 dist，或对 dist 做只读审计。")
    else:
        print("\n  ⚠️ 有构建在进行。此刻读 dist 会读到半成品，审计结论不可信。")
    return 0


def cmd_run(command: str, purpose: str, timeout: float) -> int:
    """在锁内执行 shell 命令（CI / 纯 shell 调用场景）。"""
    cwd = REPO / "site" if (REPO / "site").is_dir() else REPO
    with build_lock(purpose, timeout):
        print(f"[build_lock] 执行：{command}  (cwd={cwd})")
        r = subprocess.run(command, shell=True, cwd=str(cwd))
        return r.returncode


def main() -> int:
    ap = argparse.ArgumentParser(description="构建互斥闸门（同一时刻只允许一个 build 写 dist）")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--status", action="store_true", help="查看当前是否有构建持锁")
    g.add_argument("--run", metavar="CMD", help="在锁内执行命令，如 --run \"npm run build\"")
    ap.add_argument("--purpose", default="build", help="用途说明（写进锁文件，便于排查）")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT, help="等锁超时秒数")
    a = ap.parse_args()

    if a.status:
        return cmd_status()
    return cmd_run(a.run, a.purpose, a.timeout)


if __name__ == "__main__":
    raise SystemExit(main())
