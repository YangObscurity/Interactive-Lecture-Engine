# -*- coding: utf-8 -*-
"""audit_bare_urls.py —— 源码层裸 URL 审计（与 fix_content C9 共用同一判定谓词）。

判据（见 content/add-lecture.md §8/§8.1）：讲义正文里不允许出现任何链接；
外部链接唯一合法形态是 `.cite`。扫描跳过围栏代码块、行内 code、已有 `.cite`、<figure> 行。

三类命中：
  md-link      markdown 行内链接 [文字](http…)
  bare-http    带协议裸 URL  https://…
  schemeless   无协议裸域名/URL（is_real_domain() 判为真域名者；教学占位域名与文件名天然排除）

用法：python audit_bare_urls.py [--docs <目录>]
      默认目录 = <仓库根>/site/docs（由脚本自身位置推导）
期望：TOTAL = 0（`example.com` 等教学占位域名不计）

退出码语义（对齐 AGENTS.md §6.3 与 check_deps.py / scan_secrets.py 的既有约定）：
  0 = 通过（扫到了文件，且 TOTAL 残留为 0）
  1 = 失败（真的扫到了残留）
  2 = **闸门自身错误 / 无法判定**（扫描集为空、目录不存在）—— 绝不算通过
"""
import argparse
import pathlib
import re
import sys
import collections

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from fix_content import BARE_URL, SCHEMELESS, is_real_domain   # noqa: E402  (导入时已包好 utf-8 stdout)

# 路径解析机制：由脚本自身位置动态向上推导仓库根目录（REPO / site / docs），
# 支持通过 --docs 显式指定，保证跨平台与 CI 环境一致性。
REPO = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_DOCS = REPO / "site" / "docs"
CITE = re.compile(r'<span class="cite"[^>]*>.*?</span>')
CODE = re.compile(r"`+[^`]*?`+")
MDLINK = re.compile(r"\[[^\]\n]*\]\((https?://[^)\s]+)\)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--docs", default=str(DEFAULT_DOCS))
    a = ap.parse_args()
    root = pathlib.Path(a.docs)

    # ── 真空防护（P-6，2026-10-15 修）────────────────────────────────────────
    # 改前：本函数只有「TOTAL == 0 → PASS」一条判据，而**一个文件都没扫到**也满足它，
    #   于是空目录恒报 `结论: PASS` + `rc=0`。这正是 AGENTS.md §0.2 末段点名禁止的
    #   形态：「工具脚本在扫描集为空时，要么明确报错说明『无法判定』，要么走
    #   『跳过并告警』路径 —— 绝不允许出现『扫了个空集却报 PASS』的真空通过」。
    #   对开源用户尤甚：本仓库不发布讲义，clone 后 site/docs 下没有 L*.md，
    #   本闸门会**恒报 PASS**，使用者会误以为自己的内容合规。
    # 改后：先判定「目录存在」与「扫到了 .md」两件事，任一不成立即 rc=2（无法判定），
    #   与 check_figs2.py 的真空防护、check_deps.py / scan_secrets.py 的
    #   「2 = 无法判定」约定保持一致；调用方据此能区分
    #   「内容真有问题（1）」与「闸门自己跑不起来（2）」。
    if not root.is_dir():
        print("扫描目录不存在：%s" % root, file=sys.stderr)
        print("结论: 无法判定（--docs 指向的目录不存在）", file=sys.stderr)
        return 2

    md_files = sorted(root.rglob("*.md"))
    if not md_files:
        print("扫描集为空：%s 下没有任何 .md 文件" % root, file=sys.stderr)
        print("结论: 无法判定（真空 PASS 风险 —— 未扫到文件不等于内容合规）",
              file=sys.stderr)
        return 2

    hits = collections.defaultdict(list)
    for p in md_files:
        text = p.read_text(encoding="utf-8")
        infence = False
        for i, line in enumerate(text.split("\n"), 1):
            s = line.strip()
            if s.startswith("```") or s.startswith("~~~"):
                infence = not infence
                continue
            if infence or s.startswith("<figure"):
                continue
            seg = CITE.sub(lambda m: " " * len(m.group(0)), line)
            seg = CODE.sub(lambda m: " " * len(m.group(0)), seg)
            for m in MDLINK.finditer(seg):
                hits["md-link"].append((p, i, m.group(0)))
            seg2 = MDLINK.sub(lambda m: " " * len(m.group(0)), seg)
            for m in BARE_URL.finditer(seg2):
                hits["bare-http"].append((p, i, m.group(0)))
            seg3 = BARE_URL.sub(lambda m: " " * len(m.group(0)), seg2)
            for m in SCHEMELESS.finditer(seg3):
                if is_real_domain(m.group(1)):
                    hits["schemeless"].append((p, i, m.group(0)))

    total = sum(len(v) for v in hits.values())
    # 输出扫描规模：让「扫了 0 个文件」这件事在报告里可见，而不是靠读者猜。
    print("扫描 %d 个 .md（%s）" % (len(md_files), root))
    for k in ("md-link", "bare-http", "schemeless"):
        print("-- %-12s %d" % (k, len(hits[k])))
        for p, i, u in hits[k][:40]:
            print("     %s L%d  %s" % (p.relative_to(root).as_posix(), i, u))
    print("\nTOTAL 残留 = %d" % total)
    print("结论: %s" % ("PASS（正文无裸 URL/链接）" if total == 0 else "存在残留"))
    return 0 if total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
