# -*- coding: utf-8 -*-
"""check_figs2.py —— figure 锚点 ↔ sidecar JSON 契约校验（**全组**，跨平台）。

2026-10-08 修（系主任 CP-A1-008）：
  · ROOT 路径由脚本自身位置动态向上推导仓库根目录
    —— 在 Linux/沙箱里扫描集为空，**属「真空 PASS」**（子 Agent 已实测报告）。
    此处刻意**不复现该路径原值**：它暴露本机目录结构，正是本次要清除的对象。
  · 现改为**从脚本位置推导仓库根**，并**遍历所有 `site/docs/g*` 组目录**（不再只扫 g01）。

判据：md 里每个 <figure class="chart"> 的 data-lecture / data-id / data-type
      必须与 site/docs/public/charts/<ID>-Lxx.json 的 key 与 type 严格 1:1 双向对应。
用法：python scripts/check_figs2.py [--docs <dir>]

退出码（P-9，2026-10-15 修；对齐 AGENTS.md §6.3）：
  0 = 不一致数 0（PASS）
  1 = 不一致数 > 0（真·契约破坏）
  2 = **闸门自身错误 / 无法判定**（docs 不存在、扫描集为空）

⚠️ 为什么必须把 1 和 2 分开（改前这里是个真缺陷）：
  改前 `:37` 与 `:134` 写的是 `raise SystemExit("...")` —— 传的是**字符串**，
  Python 语义下退出码**恒为 1**。于是调用方（`audit_all.py` 的 `gate_script`、CI）
  **无法区分**「讲义里的 figure 契约真坏了（1）」与「闸门自己跑不起来（2）」，
  两者同码的后果是：真正的契约破坏会淹没在「环境没准备好」里，
  而环境问题又会被当成内容问题去回滚。本仓库其它闸门
  （`check_deps.py:31-35`、`scan_secrets.py`）早已是「2 = 无法判定」，
  本文件是未对齐的最后一个。
"""
import argparse
import collections
import io
import json
import pathlib
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

REPO = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_DOCS = REPO / "site" / "docs"

FIG = re.compile(r'<figure class="chart"([^>]*)>')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", default=str(DEFAULT_DOCS))
    a = ap.parse_args()
    docs = pathlib.Path(a.docs)
    if not docs.exists():
        # rc=2：判据不成立（路径给错了），**不是**契约破坏。
        print("docs 不存在：%s" % docs, file=sys.stderr)
        print("  请用 --docs 指定含 g*/ 课程组的讲义根目录"
              "（默认 <仓库根>/site/docs）。", file=sys.stderr)
        raise SystemExit(2)
    cj = docs / "public" / "charts"

    bad = 0
    n_pages = 0
    n_figs = 0
    counts = collections.Counter()
    type_by_key = collections.Counter()
    # 扫描所有课程组目录。
    #
    # 2026-10-15 修：原先只认 `startswith("g")` 的一级目录，导致引擎自带的
    # 示例课程组 `examples/`（开源版唯一的可构建内容）**完全不被扫描** ——
    # 它的 `不一致数: 0` 是"没扫到"造成的**真空 PASS**，而不是"示例合规"。
    # 这与本文件 2026-10-08 修的同类缺陷（硬编码路径 → 扫描集为空 → 假 PASS）
    # 是同一个病根，所以在「收录哪些目录」上也必须显式覆盖示例。
    #
    # 收录规则（保持进取但明确）：
    #   · `g<数字>` —— 常规课程组（g01 / g02 …）
    #   · `dt`      —— 历史特殊组名
    #   · `examples`—— 引擎自带示例内容源（开源版的默认内容）
    # 其余目录（public / .vitepress / 任意新名）一概不扫，避免把非课程目录当组。
    def _is_group_dir(p: pathlib.Path) -> bool:
        if not p.is_dir():
            return False
        n = p.name
        return n == "examples" or n == "dt" or bool(re.fullmatch(r"g\d+", n))

    groups = sorted(p for p in docs.iterdir() if _is_group_dir(p))

    for gdir in groups:
        # 组内讲次文件用 **递归** glob：示例内容源是 `examples/g01/L01.md` 这种两级结构，
        # 非递归的 `glob("L*.md")` 会一个都匹配不到（静默漏扫 = 又一处真空 PASS）。
        for p in sorted(gdir.rglob("L*.md")):
            n_pages += 1
            src = p.read_text(encoding="utf-8")
            # 组 ID 的判据：**以正文里的 `data-lecture` 前缀为准**，而不是目录名。
            # 原因：示例内容是 `examples/g01/EX-L01.md` 结构与 `EX-` 前缀不一致，
            # 而 sidecar 文件名由 data-lecture 前缀决定（契约见 content/CONTENT_SOURCE.md）。
            # 目录名只用于回退（无 figure 的纯文字页）。
            m0 = FIG.search(src)
            gid = gdir.name.upper()
            if m0:
                lec_m = re.search(r'data-lecture="([^"]+)"', m0.group(1))
                if lec_m and "-" in lec_m.group(1):
                    gid = lec_m.group(1).split("-")[0].upper()
            jp = cj / ("%s-%s.json" % (gid, p.stem))
            if not jp.exists():
                alt_jp = docs / "examples" / "public" / "charts" / ("%s-%s.json" % (gid, p.stem))
                if not alt_jp.exists():
                    alt_jp = docs / "examples" / "public" / "charts" / ("EX-%s.json" % p.stem)
                if alt_jp.exists():
                    jp = alt_jp

            # ⚠️ 纯文字页（无任何 figure 锚点）**允许没有 sidecar**。
            # 本仓库真实存在这样的课程组：`dt` 组 13 讲全部无图、
            # 无 sidecar —— 这是既定设计（见 groups.mts 里该组的说明），不是缺陷。
            # 只有「正文有 figure 却没有 sidecar」才是真契约破坏。
            # 2026-10-15：把扫描范围扩展到 examples/ 后，dt 也被纳入扫描，
            # 于是暴露出原先未做此区分、导致 13 个假 MISSING 的问题。
            if not jp.exists():
                if FIG.search(src) is not None:
                    print("  MISSING JSON: %s" % jp.name)
                    bad += 1
                continue
            try:
                data = json.loads(jp.read_text(encoding="utf-8"))
            except Exception as e:  # noqa: BLE001
                print("  BAD JSON: %s（%s）" % (jp.name, e))
                bad += 1
                continue
            used = set()
            for m in FIG.finditer(src):
                attrs = m.group(1)
                n_figs += 1
                cid = re.search(r'data-id="([^"]+)"', attrs)
                typ = re.search(r'data-type="([^"]+)"', attrs)
                lec = re.search(r'data-lecture="([^"]+)"', attrs)
                if not (cid and lec):
                    print("  %s: figure 锚点缺 data-id/data-lecture" % p.name)
                    bad += 1
                    continue
                cid, lec = cid.group(1), lec.group(1)
                used.add(cid)
                counts[typ.group(1) if typ else "?"] += 1
                if cid not in data:
                    print("  %s: figure %s NOT in json" % (p.name, cid))
                    bad += 1
                elif typ and typ.group(1) != data[cid].get("type"):
                    print("  %s: %s type md=%s json=%s" % (p.name, cid, typ.group(1), data[cid].get("type")))
                    bad += 1
                if lec != "%s-%s" % (gid, p.stem):
                    print("  %s: data-lecture=%s mismatch（应为 %s-%s）" % (p.name, lec, gid, p.stem))
                    bad += 1
            for k in data:
                if k not in used:
                    print("  %s: json key %s UNREFERENCED" % (p.name, k))
                    bad += 1
                type_by_key[data[k].get("type")] += 1

    print("\nmd 中图表类型分布: %s" % dict(counts))
    print("json 中图表类型分布: %s" % dict(type_by_key))
    print("扫描 %d 页 / %d 个 figure 锚点（%d 组）" % (n_pages, n_figs, len(groups)))
    print("不一致数: %d" % bad)
    if n_pages == 0:
        # rc=2：真空防护。**扫描集为空 ≠ 契约成立**，绝不能与「不一致数 0」同码，
        # 否则「没扫到」会被下游当成「PASS」（AGENTS.md §0.2 禁止的真空 PASS）。
        print("扫描集为空（真空 PASS 风险）——请检查 --docs 路径", file=sys.stderr)
        raise SystemExit(2)
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
