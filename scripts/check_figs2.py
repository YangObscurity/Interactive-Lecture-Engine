# -*- coding: utf-8 -*-
"""check_figs2.py —— figure 锚点 ↔ sidecar JSON 契约校验（**全组**，跨平台）。


判据：md 里每个 <figure class="chart"> 的 data-lecture / data-id / data-type
      必须与 site/docs/public/charts/<ID>-Lxx.json 的 key 与 type 严格 1:1 双向对应。
用法：python scripts/check_figs2.py [--docs <dir>]
退出码：0 = 不一致数 0（PASS）。
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
        raise SystemExit("docs 不存在：%s" % docs)
    cj = docs / "public" / "charts"

    bad = 0
    n_pages = 0
    n_figs = 0
    counts = collections.Counter()
    type_by_key = collections.Counter()
    groups = sorted(p for p in docs.iterdir()
                    if p.is_dir() and (p.name.startswith("g") or p.name in ("dt", "lr", "sdm", "spi")) and p.name != "public")

    for gdir in groups:
        gid = gdir.name.upper()
        for p in sorted(gdir.glob("L*.md")):
            n_pages += 1
            src = p.read_text(encoding="utf-8")
            jp = cj / ("%s-%s.json" % (gid, p.stem))
            if not jp.exists():
                if not FIG.search(src):
                    continue
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
        raise SystemExit("扫描集为空（真空 PASS 风险）——请检查 --docs 路径")
    sys.exit(0 if bad == 0 else 1)


if __name__ == "__main__":
    main()
