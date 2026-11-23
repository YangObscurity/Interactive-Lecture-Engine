# -*- coding: utf-8 -*-
"""check_body_links.py —— 正文链接硬判据（构建产物 dist 审计）。

设计（2026-10-06 更新，见 docs-dev/legacy-content/add-lecture.md §8）：
  · 参考来源段已**全站删除**（既定设计），不再有「正文 vs 参考来源」的分界；
  · 正文一切外部链接的唯一合法形态是 `.cite` 胶囊（<span class="cite" data-cite=URL>），
    点击 window.open 直接打开外链 —— 它渲染成 <span>，**不是 <a>**；
  · 因此判据 = **整个 dist 的 L*.html 里 `<a href="http...">` 必须为 0**
    （markdown 行内链接/裸 URL 若漏清，会被 markdown-it 渲染成真 <a>；.cite 不受影响）。

仪器自检（防"0 是假阴性"）：必须扫到页面；且 `.cite` 胶囊总数必须 > 0。
用法：python check_body_links.py [--dist <目录>]
"""
import argparse
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

REPO = pathlib.Path(__file__).resolve().parents[1]
DIST = REPO / "site" / "docs" / ".vitepress" / "dist"
A_HTTP = re.compile(r'<a\s[^>]*href="https?://[^"]*"[^>]*>')
CITE = re.compile(r'class="cite"')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", default=str(DIST))
    a = ap.parse_args()
    dist = pathlib.Path(a.dist)
    if not dist.exists():
        raise SystemExit("dist 不存在：%s（先跑 sync.py --build）" % dist)

    total = 0
    cites = 0
    per_file = {}
    n_pages = 0
    for p in sorted(dist.rglob("L*.html")):
        html = p.read_text(encoding="utf-8", errors="replace")
        n_pages += 1
        cites += len(CITE.findall(html))
        hits = A_HTTP.findall(html)
        if hits:
            per_file[p.relative_to(dist).as_posix()] = hits
            total += len(hits)

    print("扫描 %d 个 L*.html" % n_pages)
    print("页面里的 <a href=\"http…\"> 总数 = %d，涉及 %d 个页面" % (total, len(per_file)))
    for f, hits in list(per_file.items())[:12]:
        print("  %-18s %d" % (f, len(hits)))
        for h in hits[:3]:
            print("      " + h[:150])

    # 仪器自检：必须扫到页面、且必须扫到 .cite（否则 0 是假阴性）
    print("  [自检] 页面数 = %d，.cite 胶囊总数 = %d" % (n_pages, cites))
    ok = True
    if n_pages == 0:
        print("  [自检] X 未扫到任何 L*.html —— 判据失效"); ok = False
    if cites == 0:
        print("  [自检] X 未扫到任何 .cite —— 判据失效"); ok = False
    print("\n结论: %s" % ("PASS（无外链 <a>）" if (total == 0 and ok) else "FAIL"))


if __name__ == "__main__":
    main()

