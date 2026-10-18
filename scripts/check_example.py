#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_example.py — 引擎自带示例内容源（site/docs/examples/）的契约闸门。

## 为什么需要它（这是一个真实覆盖缺口，不是锦上添花）

`scripts/check_figs2.py` 只扫描 `site/docs/` 下**一级**、名字以 `g` 开头的目录
（`p.name.startswith("g")`，且**不递归**）。而引擎自带的示例位于
`site/docs/examples/g01/` —— 顶层是 `examples`，不以 `g` 开头，因此
**该闸门对示例完全不可见**。

实测证据（本仓库，2026-10-15）：
    $ python scripts/check_figs2.py
    扫描 279 页 / 1257 个 figure 锚点（12 组）
    不一致数: 0
把示例页从 0 页扩到 3 页，上面的输出**一字不变** —— 说明那 279 页里
没有一页是示例。换言之，示例的图表锚点守恒**从来没有被任何闸门保护过**。

本脚本把示例当成一个合法内容源来校验，复用 `check_figs2.py` **完全相同**的
正则与判据（不另立标准），并额外覆盖内容源契约（`content/CONTENT_SOURCE.md`）
中示例特有的要求。

## 判据

A. 图表锚点守恒（与 check_figs2 同判据）
   - 每个 `<figure class="chart">` 的 data-id 必须在 sidecar JSON 里有对应 key；
   - type 必须与 JSON 里的 type 一致；
   - JSON 里不允许有未被引用的 key。
B. frontmatter 契约：title 双引号包裹 / order / description / outline: deep
C. 结构契约：有 `## 下一讲预告`，且**是最后一个二级标题**
D. 外链契约：无原生 markdown 链接、无裸 URL；外部链接只以 `.cite` 胶囊存在
E. 代码围栏：语言标签非空、不含空格（禁 `plain text`）
F. 内容源三件套齐备：g01/L01.md、g01/index.md、public/charts/EX-L01.json、groups.mts

退出码：0 = 全部通过；非 0 = 有失败（结论反映到退出码）。
用法：python scripts/check_example.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = pathlib.Path(__file__).resolve().parents[1]
EX = REPO / "site" / "docs" / "examples"
MD = EX / "g01" / "L01.md"
INDEX = EX / "g01" / "index.md"
SIDECAR = EX / "public" / "charts" / "EX-L01.json"
# 侧车还必须能在构建后按运行时约定被取到：/charts/<data-lecture>.json
DEPLOYED = REPO / "site" / "docs" / "public" / "charts" / "EX-L01.json"
GROUPS = EX / "groups.mts"

# 与 check_figs2.py 逐字一致的正则：判据同源，不另立标准
FIG = re.compile(r'<figure class="chart"([^>]*)>')

fails: list[str] = []


def chk(name: str, ok: bool, detail: str = "") -> None:
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, ("  — " + detail) if detail else ""))
    if not ok:
        fails.append(name)


def main() -> int:
    for p in (MD, INDEX, SIDECAR, GROUPS):
        chk("文件存在：%s" % p.relative_to(REPO), p.exists())
    if fails:
        print("\n%d 项失败（缺文件，后续判据无法进行）" % len(fails))
        return 1

    text = MD.read_text(encoding="utf-8")
    data = json.loads(SIDECAR.read_text(encoding="utf-8"))

    # ---- A. 图表锚点守恒 ----
    used: set[str] = set()
    n_fig = 0
    for m in FIG.finditer(text):
        attrs = m.group(1)
        n_fig += 1
        cid = re.search(r'data-id="([^"]+)"', attrs)
        typ = re.search(r'data-type="([^"]+)"', attrs)
        lec = re.search(r'data-lecture="([^"]+)"', attrs)
        if not (cid and typ and lec):
            chk("figure #%d 含 data-id/data-type/data-lecture" % n_fig, False)
            continue
        cid_s, typ_s, lec_s = cid.group(1), typ.group(1), lec.group(1)
        used.add(cid_s)
        chk("figure %s 在 sidecar 中有对应 key" % cid_s, cid_s in data)
        if cid_s in data:
            chk("figure %s 的 type 与 sidecar 一致" % cid_s,
                typ_s == data[cid_s].get("type"),
                "md=%s json=%s" % (typ_s, data[cid_s].get("type")))
        chk("figure %s 的 data-lecture 与 sidecar 文件名相符" % cid_s,
            lec_s == "EX-L01", "实际 %s" % lec_s)

    chk("示例至少含 3 个 figure 锚点", n_fig >= 3, "实际 %d" % n_fig)
    for k in data:
        chk("sidecar key %s 被正文引用" % k, k in used)
    chk("sidecar 每个值形如 {type, code}", all(
        set(v.keys()) == {"type", "code"} and isinstance(v.get("code"), str)
        for v in data.values()))
    types = {v.get("type") for v in data.values()}
    for t in ("mermaid", "echarts", "wavedrom"):
        chk("示例演示了 %s 类型" % t, t in types)

    # 每张 echarts / wavedrom 的内层 code 必须是合法 JSON（运行时 JSON.parse 它）
    for k, v in data.items():
        if v.get("type") in ("echarts", "wavedrom"):
            try:
                json.loads(v["code"])
                ok = True
            except Exception as e:  # noqa: BLE001
                ok = False
                chk("sidecar %s 的内层 code 是合法 JSON" % k, False, str(e)[:80])
                continue
            chk("sidecar %s 的内层 code 是合法 JSON" % k, ok)

    # ---- B. frontmatter ----
    fm_m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    chk("frontmatter 存在且闭合", bool(fm_m))
    fm = fm_m.group(1) if fm_m else ""
    chk("title 用英文双引号包裹", bool(re.search(r'^title:\s*"[^"]+"', fm, re.M)))
    chk("含 order", bool(re.search(r"^order:\s*\d+", fm, re.M)))
    chk("含 description", bool(re.search(r"^description:\s*\S", fm, re.M)))
    chk("含 outline: deep", bool(re.search(r"^outline:\s*deep\s*$", fm, re.M)))

    # ---- C. 结构：下一讲预告必须是最后一个二级标题 ----
    h2 = re.findall(r"^##\s+(.+)$", text, re.M)
    chk("正文含二级标题", len(h2) > 0)
    chk("最后一个二级标题是「下一讲预告」",
        bool(h2) and h2[-1].strip() == "下一讲预告",
        "实际末尾 = %s" % (h2[-1] if h2 else "（无）"))
    chk("无已废除的「## 参考来源」段", not any("参考来源" in h for h in h2))

    # ---- D. 外链契约 ----
    cites = re.findall(r'<span class="cite" data-cite="([^"]+)" title="([^"]+)">', text)
    chk("至少 1 个 .cite 胶囊", len(cites) >= 1, "实际 %d" % len(cites))
    chk(".cite 的 data-cite 与 title 一致", all(a == b for a, b in cites))
    chk("无原生 markdown 外链", not re.search(r"(?<!!)\[[^\]]+\]\((?!\./|#)[^)]+\)", text))
    stripped = re.sub(r'<span class="cite"[^>]*>.*?</span>', "", text, flags=re.S)
    chk("无裸 URL", not re.search(r"(?<![\"\w/])https?://", stripped))

    # ---- E. 代码围栏语言标签 ----
    fences = re.findall(r"^```([^\n]*)$", text, re.M)
    opens = [f for i, f in enumerate(fences) if i % 2 == 0]
    chk("至少 1 个代码围栏", len(opens) >= 1, "围栏 = %s" % opens)
    chk("围栏语言标签非空且不含空格（禁 plain text）",
        all(f.strip() and " " not in f.strip() for f in opens))

    # ---- F. 部署可达性：运行时按 /charts/<data-lecture>.json 取侧车 ----
    chk("侧车已置于 site/docs/public/charts/（构建后 dist 才能按 /charts/ 取到）",
        DEPLOYED.exists())
    if DEPLOYED.exists():
        chk("public 与 examples 两份侧车内容一致",
            DEPLOYED.read_bytes() == SIDECAR.read_bytes())

    print("\n%d 项失败" % len(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
