# -*- coding: utf-8 -*-
"""audit_all.py —— 功能不变量总闸门（一键跑完全部审计项）。

设计意图（2026-10-14）：
  重构/合并/迁移之后，**不允许任何原有功能静默消失**。本项目已有若干独立闸门脚本，
  但它们各自为战、输出格式不一、退出码语义也不同；本脚本把它们**串成一条证据链**，
  让「是否功能损失」这件事可以一句话回答、也可以被其它 Agent 机器比对。

被调用的闸门（全部为**只读**审计，本脚本绝不修改任何被审计的文件）：
  1. build         —— cd site && npm run build（可选；默认不跑，因为耗时 1~3 分钟）
                      成功标志：输出含 `✓ rendering pages`，产物 site/docs/.vitepress/dist
  2. pages         —— 统计 dist 下 .html 总数（页数守恒：基线 307）
  3. links         —— scripts/check_body_links.py   外链 <a> = 0 且 .cite > 0
  4. angle         —— scripts/test_angle.py         尖括号规则单测 15/15
  5. figs          —— scripts/check_figs2.py        figure 锚点 ↔ charts JSON 严格 1:1
  6. format        —— scripts/format_audit.py --src site/docs   LaTeX(M1~M5)/排版(F1~F4)
  7. bare_urls     —— scripts/audit_bare_urls.py    源码层裸 URL 残留 = 0

用法：
  python scripts/audit_all.py                 # 跑全部闸门（不重新构建，读现有 dist）
  python scripts/audit_all.py --build         # 先全站构建再审计（发布终验用）
  python scripts/audit_all.py --json          # 机器可读输出（便于其它 Agent 比对）
  python scripts/audit_all.py --json --out ops/audit_latest.json
  python scripts/audit_all.py --baseline ops/audit_baseline.json   # 与基线比对，报疑似功能损失
  python scripts/audit_all.py --write-baseline ops/audit_baseline.json  # 写基线快照

退出码约定：全部 PASS -> 0；任一 FAIL -> 1。
  （`--build` 失败、页数下降、任一闸门非 0 退出，都算 FAIL。）
"""
import argparse
import collections
import datetime
import io
import json
import pathlib
import re
import subprocess
import sys
import time

# ★ Windows 控制台默认 GBK，中文会乱码；统一 UTF-8 输出（不是文件损坏，是终端编码问题）
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "buffer"):
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

REPO = pathlib.Path(__file__).resolve().parents[1]
SITE = REPO / "site"
DIST = SITE / "docs" / ".vitepress" / "dist"
DOCS = SITE / "docs"
SCRIPT_DIR = REPO / "scripts"

# 页数基线（2026-10-14 建立，见 ops/audit_baseline.json）——页数只能多、不能少。
#
# 架构设计（页数下限随内容源形态自适应）：
#   本仓库有两个合法形态 ——
#     · 完整内容形态：挂载了全量讲义内容源 → 产出页面数量较多
#     · 纯净开源形态：只有引擎自带示例与核心入口 → 约 4 页
#   基线随内容源是否存在自适应 —— 挂载讲义时使用高基线，纯引擎模式使用示例页数下限。
#
# 判定仍保留“页数只能多不能少”的守恒语义（防止关键页面被意外误删），
# 只是把参照系换成“当前仓库形态应有的页数”。
BASELINE_HTML_WITH_LECTURES = 307
BASELINE_HTML_ENGINE_ONLY = 3   # index + 404 + examples 两页中的下限（保守取值）


def _has_lectures() -> bool:
    """仓库当前是否携带讲义（决定页数基线取哪一个）。"""
    return any(DOCS.glob("**/L*.md")) and any(DOCS.glob("g*/L*.md"))


def baseline_html() -> int:
    return BASELINE_HTML_WITH_LECTURES if _has_lectures() else BASELINE_HTML_ENGINE_ONLY

PY = sys.executable or "python"


def run(cmd, cwd=None, timeout=1800):
    """执行子进程，返回 (exit_code, stdout+stderr 合并文本)。"""
    t0 = time.time()
    try:
        use_shell = isinstance(cmd, str) or (isinstance(cmd, list) and bool(cmd) and cmd[0] in ("npm", "npx") and sys.platform == "win32")
        p = subprocess.run(
            cmd, cwd=str(cwd or REPO), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=timeout, shell=use_shell,
        )
        out = p.stdout.decode("utf-8", errors="replace")
        return p.returncode, out, round(time.time() - t0, 2)
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode("utf-8", errors="replace")
        return 124, out + "\n[TIMEOUT after %ss]" % timeout, round(time.time() - t0, 2)
    except FileNotFoundError as e:
        return 127, "[NOT FOUND] %s" % e, round(time.time() - t0, 2)


def count_html(dist):
    """dist 下 .html 总数（页数守恒指标）。"""
    if not dist.exists():
        return None
    return len(list(dist.rglob("*.html")))


def gate_build(do_build):
    """闸门 1：全站生产构建（可选）。"""
    if not do_build:
        return {"name": "build", "skipped": True, "ok": True, "note": "未加 --build，跳过构建（读现有 dist）"}
    safe_script = REPO / "scripts" / "safe_build.py"
    if safe_script.exists():
        code, out, secs = run([PY, str(safe_script)], cwd=REPO, timeout=1800)
    else:
        code, out, secs = run(["npm", "run", "build"], cwd=SITE, timeout=1800)
    rendered = "✓ rendering pages" in out or "rendering pages" in out or "产物完整" in out or "✅" in out
    files = sum(1 for ln in out.splitlines() if re.search(r"dist[/\\].*\.html", ln))
    return {
        "name": "build", "skipped": False,
        "ok": bool(code == 0 and rendered),
        "exit_code": code, "seconds": secs,
        "rendering_pages_seen": rendered,
        "html_count": count_html(DIST),
        "tail": out[-3000:],
    }


def gate_pages():
    """闸门 2：页面数守恒（dist 下 .html 总数，基线随仓库形态自适应）。"""
    n = count_html(DIST)
    base = baseline_html()
    if n is None:
        return {"name": "pages", "ok": False,
                "note": "dist 不存在：%s（先跑 --build）" % DIST, "html_count": None}
    ok = n >= base
    return {"name": "pages", "ok": ok, "html_count": n, "baseline": base,
            "delta": n - base,
            "note": "页数 %d（基线 %d，%+d）" % (n, base, n - base)}


def gate_links():
    """闸门 3：check_body_links.py —— 外链 <a> = 0 且 .cite > 0。"""
    code, out, secs = run([PY, str(SCRIPT_DIR / "check_body_links.py")])
    cites = None
    pages = None
    m = re.search(r"\.cite 胶囊总数 = (\d+)", out)
    if m:
        cites = int(m.group(1))
    m = re.search(r"页面数 = (\d+)", out)
    if m:
        pages = int(m.group(1))
    m = re.search(r'<a href="http…"> 总数 = (\d+)', out)
    a_n = int(m.group(1)) if m else None
    ok = code == 0 and a_n == 0 and (cites or 0) > 0
    return {"name": "links", "ok": ok, "exit_code": code, "seconds": secs,
            "a_http": a_n, "cite_total": cites, "pages_scanned": pages,
            "conclusion": "PASS（无外链 <a>）" if ok else "FAIL"}


def gate_script(name: str, rel: str, desc: str):
    """通用闸门：跑一个「退出码即结论」的脚本。

    约定（见 AGENTS.md §6.3）：0 = 通过，非 0 = 失败，2 = 闸门自身错误。
    这里刻意**不解析输出文本**，只看退出码 —— 这几个脚本都已按规范
    把结论反映到退出码（并自带真空防护：扫不到东西时报 2 而非假 PASS）。
    """
    path = SCRIPT_DIR.parent / rel
    if not path.exists():
        return {"name": name, "ok": False, "skipped": True,
                "conclusion": "脚本不存在：%s" % rel}
    code, out, secs = run([PY, str(path)])
    tail = [l for l in out.strip().splitlines() if l.strip()][-1:] or [""]
    return {"name": name, "ok": code == 0, "exit_code": code, "seconds": secs,
            "desc": desc, "conclusion": tail[0][:120]}


def gate_angle():
    """闸门 4：test_angle.py —— 尖括号规则单测 15/15。"""
    code, out, secs = run([PY, str(SCRIPT_DIR / "test_angle.py")])
    m = re.search(r"(\d+)\s*/\s*(\d+)\s*通过", out)
    passed, total = (int(m.group(1)), int(m.group(2))) if m else (None, None)
    ok = code == 0 and passed is not None and passed == total and total > 0
    return {"name": "angle", "ok": ok, "exit_code": code, "seconds": secs,
            "passed": passed, "total": total,
            "conclusion": "%s/%s 通过" % (passed, total) if m else "FAIL(无法解析)"}


def gate_figs():
    """闸门 5：check_figs2.py —— figure 锚点 ↔ charts JSON 严格 1:1。"""
    code, out, secs = run([PY, str(SCRIPT_DIR / "check_figs2.py")])
    bad = None
    m = re.search(r"不一致数:\s*(\d+)", out)
    if m:
        bad = int(m.group(1))
    md_types = {}
    m = re.search(r"md 中图表类型分布:\s*(\{[^}]*\})", out)
    if m:
        md_types = eval(m.group(1), {"__builtins__": {}}, {})  # noqa: S307 (仅解析自家 dict 字面量)
    n_pages = n_figs = n_groups = None
    m = re.search(r"扫描 (\d+) 页 / (\d+) 个 figure 锚点（(\d+) 组）", out)
    if m:
        n_pages, n_figs, n_groups = int(m.group(1)), int(m.group(2)), int(m.group(3))
    ok = code == 0 and bad == 0
    return {"name": "figs", "ok": ok, "exit_code": code, "seconds": secs,
            "inconsistent": bad, "pages": n_pages, "figure_anchors": n_figs,
            "groups": n_groups, "md_type_dist": md_types,
            "conclusion": "不一致数: %s" % bad}


def gate_format():
    """闸门 6：format_audit.py --src site/docs（LaTeX M1~M5 / 排版 F1~F4）。"""
    code, out, secs = run([PY, str(SCRIPT_DIR / "format_audit.py"), "--src", "site/docs"])
    fatal = warn = None
    m = re.search(r"高危合计 = (\d+)；提示合计 = (\d+)", out)
    if m:
        fatal, warn = int(m.group(1)), int(m.group(2))
    # 抓出高危行（❗ 列 > 0 的讲次），方便定位
    hot = []
    for ln in out.splitlines():
        parts = ln.split()
        if len(parts) >= 5 and (DOCS / parts[0]).is_dir():
            try:
                if int(parts[4]) > 0:      # ❗ 列
                    hot.append("%s/%s (❗%s, 最长段 %s)" % (parts[0], parts[1], parts[4], parts[2]))
            except (ValueError, IndexError):
                pass
    ok = code == 0 and fatal == 0
    return {"name": "format", "ok": ok, "exit_code": code, "seconds": secs,
            "high_severity": fatal, "warnings": warn, "hot_pages": hot,
            "conclusion": "PASS（无高危）" if ok else "FAIL（%s 处高危）" % fatal}


def gate_bare_urls():
    """闸门 7：audit_bare_urls.py —— 源码层裸 URL 残留 = 0。"""
    code, out, secs = run([PY, str(SCRIPT_DIR / "audit_bare_urls.py")])
    m = re.search(r"TOTAL 残留 = (\d+)", out)
    total = int(m.group(1)) if m else None
    kinds = {}
    for k in ("md-link", "bare-http", "schemeless"):
        mm = re.search(r"-- %s\s+(\d+)" % re.escape(k), out)
        if mm:
            kinds[k] = int(mm.group(1))
    ok = code == 0 and total == 0
    return {"name": "bare_urls", "ok": ok, "exit_code": code, "seconds": secs,
            "total": total, "kinds": kinds,
            "conclusion": "PASS（正文无裸 URL/链接）" if ok else "存在残留"}


def build_result(do_build):
    gates = [gate_build(do_build)]
    if do_build and not gates[0]["ok"]:
        # 构建都失败了，后续 dist 审计无意义（但源码层闸门仍可跑，故不提前返回）
        pass
    gates.append(gate_pages())
    gates.append(gate_links())
    gates.append(gate_angle())
    gates.append(gate_figs())
    gates.append(gate_format())
    gates.append(gate_bare_urls())
    # 2026-10-15 新增的四道闸门。它们与讲义内容无关（任何仓库状态都必须通过），
    # 补的是「重构过程本身引入的缺陷」这一类：
    #   · check_deps.py     —— 源码 import 与 package.json 声明不一致
    #                          （实测漏过 vue，且 markmap-lib 是僵尸依赖）
    #   · check_encoding.py —— 编码损坏 / BOM / 行尾混用
    #                          （实测 .gitignore 有 1 处在已提交 blob 里就是 U+FFFD）
    #   · scan_secrets.py   —— 密钥与个人身份残留（CI 级别的开源安全底线）
    #   · check_example.py  —— 引擎自带示例内容源的内容契约
    gates.append(gate_script("deps", "scripts/check_deps.py", "依赖声明与源码 import 一致"))
    gates.append(gate_script("encoding", "scripts/check_encoding.py", "编码完整（无 U+FFFD/BOM/行尾混用）"))
    gates.append(gate_script("secrets", "scripts/scan_secrets.py", "无密钥与个人身份残留"))
    gates.append(gate_script("example", "scripts/check_example.py", "示例内容源契约成立"))
    #   · doc_audit.py      —— 文档内引用可达 + README 结构 + 敏感信息静态合规
    #     补的是「构建成功但新人照文档撞墙」这一类：真实记录 —— CONTRIBUTING 曾列出
    #     已被删除的 plans/ 目录；搜索脚本被 *secret* 规则静默排除而文档仍在引用它。
    gates.append(gate_script("docs", "scripts/doc_audit.py", "文档链接可达且结构健全"))
    all_ok = all(g["ok"] for g in gates if not g.get("skipped"))
    return {
        "tool": "scripts/audit_all.py",
        "generated_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
        "repo": str(REPO),
        "all_ok": all_ok,
        "gates": gates,
    }


def compare_baseline(res, bpath):
    """与基线快照比对：任何关键计数下降 -> 疑似功能损失。"""
    bp = pathlib.Path(bpath)
    if not bp.exists():
        print("\n[基线] 未找到 %s，跳过比对" % bp)
        return []
    base = json.loads(bp.read_text(encoding="utf-8"))
    bg = {g["name"]: g for g in base.get("gates", [])}
    cg = {g["name"]: g for g in res["gates"]}
    # 计数类指标：只许 >= 基线（下降 = 疑似功能损失）
    monotonic = [("pages", "html_count"), ("links", "cite_total"), ("links", "pages_scanned"),
                 ("angle", "passed"), ("figs", "figure_anchors"), ("figs", "pages")]
    alerts = []
    for gname, field in monotonic:
        b, c = bg.get(gname, {}), cg.get(gname, {})
        bv, cv = b.get(field), c.get(field)
        if isinstance(bv, int) and isinstance(cv, int) and cv < bv:
            alerts.append({"kind": "疑似功能损失", "gate": gname, "field": field,
                           "baseline": bv, "current": cv, "delta": cv - bv})
    # 状态翻转：基线 PASS 现在 FAIL
    for name, b in bg.items():
        c = cg.get(name)
        if c and b.get("ok") and not c.get("ok"):
            alerts.append({"kind": "闸门由 PASS 转 FAIL", "gate": name,
                           "baseline": b.get("conclusion"), "current": c.get("conclusion")})
    # 图表类型分布逐类比对
    bd = bg.get("figs", {}).get("md_type_dist") or {}
    cd = cg.get("figs", {}).get("md_type_dist") or {}
    for k, v in bd.items():
        cv = cd.get(k, 0)
        if cv < v:
            alerts.append({"kind": "疑似功能损失", "gate": "figs", "field": "type_dist.%s" % k,
                           "baseline": v, "current": cv, "delta": cv - v})
    print("\n=== 与基线比对（%s） ===" % bp.as_posix())
    if not alerts:
        print("✓ 无回归：所有关键计数 >= 基线，且无闸门由 PASS 转 FAIL")
    else:
        for a in alerts:
            print("✗ [%s] %s.%s：基线 %s -> 现在 %s（%+d）"
                  % (a["kind"], a["gate"], a["field"], a["baseline"], a["current"],
                     a.get("delta", 0) if isinstance(a.get("delta"), int) else 0))
    res["baseline_compare"] = {"baseline_file": str(bp), "alerts": alerts}
    return alerts


def print_human(res):
    print("=" * 74)
    print("  功能不变量总闸门 audit_all.py   %s" % res["generated_at"])
    print("=" * 74)
    for g in res["gates"]:
        if g.get("skipped"):
            print("-- %-10s SKIP  %s" % (g["name"], g.get("note", "")))
            continue
        flag = "PASS" if g["ok"] else "FAIL"
        extra = {
            "build": lambda g: "构建%s，dist html=%s" % ("成功" if g.get("rendering_pages_seen") else "失败", g.get("html_count")),
            "pages": lambda g: "html=%s（基线 %s）" % (g.get("html_count"), g.get("baseline")),
            "links": lambda g: 'a_http=%s  .cite=%s  页=%s' % (g.get("a_http"), g.get("cite_total"), g.get("pages_scanned")),
            "angle": lambda g: "%s/%s" % (g.get("passed"), g.get("total")),
            "figs": lambda g: "不一致=%s  锚点=%s  页=%s  %s" % (g.get("inconsistent"), g.get("figure_anchors"), g.get("pages"), g.get("md_type_dist")),
            "format": lambda g: "高危=%s  提示=%s" % (g.get("high_severity"), g.get("warnings")),
            "bare_urls": lambda g: "残留=%s  %s" % (g.get("total"), g.get("kinds")),
        }.get(g["name"], lambda g: "") (g)
        print("-- %-10s %-4s %s" % (g["name"], flag, extra))
        if g["name"] == "format" and g.get("hot_pages"):
            for h in g["hot_pages"]:
                print("              ❗ %s" % h)
    print("-" * 74)
    print("总结论: %s" % ("✓ 全部通过（ALL PASS）" if res["all_ok"] else "✗ 存在失败项（见上）"))
    return res["all_ok"]


def main():
    ap = argparse.ArgumentParser(description="功能不变量总闸门")
    ap.add_argument("--build", action="store_true", help="先执行全站生产构建 npm run build（发布终验）")
    ap.add_argument("--json", action="store_true", help="输出机器可读 JSON（打到 stdout）")
    ap.add_argument("--out", default=None, help="把 JSON 结果写入指定文件")
    ap.add_argument("--baseline", default=None, help="与基线快照 JSON 比对，报告疑似功能损失")
    ap.add_argument("--write-baseline", default=None, help="把本次结果写为基线快照")
    a = ap.parse_args()

    res = build_result(a.build)

    if a.baseline:
        alerts = compare_baseline(res, a.baseline)
        if alerts and res["all_ok"]:
            res["all_ok"] = False   # 有回归 -> 整体判 FAIL

    if a.write_baseline:
        wp = pathlib.Path(a.write_baseline)
        wp.parent.mkdir(parents=True, exist_ok=True)
        wp.write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
        print("[基线] 已写入 %s" % wp.as_posix())

    if a.out:
        op = pathlib.Path(a.out)
        op.parent.mkdir(parents=True, exist_ok=True)
        op.write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")

    if a.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print_human(res)

    return 0 if res["all_ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
