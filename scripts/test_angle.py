# -*- coding: utf-8 -*-
"""test_angle.py — 尖括号规则单测（不碰任何站点文件）。

覆盖两处实现：
  1) 导入层  build_site_lectures.sanitize_angle   （散文 -> &lt;，行内 code 去占位符）
  2) 站点侧  fix_content.escape_lt                （白名单标签保护 + 自愈 + 只转义 ANGLE_BREAK）

判据来自 @vue/compiler-dom 实测（见 build_site_lectures.py 注释块 / add-lecture §8.2）。
用法：python scripts/test_angle.py   # 期望全 PASS
"""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("bsl", HERE / "build_site_lectures.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

sys.path.insert(0, str(HERE))
import fix_content as fc   # noqa: E402  （导入时已把 stdout 包装为 utf-8）

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

CASES = [
    ("散文：`<` 后跟字母 -> 转实体（显示仍是 '<'）",
     "命令提示符 <name> 之后继续", "命令提示符 &lt;name> 之后继续"),
    ("散文：`<` 后跟数字/空格/`<` -> 不动（Vue 本来就接受）",
     "误差 < 150 ms 且 << 24", "误差 < 150 ms 且 << 24"),
    ("行内 code：ASCII 占位符去尖括号",
     "用 `show cdp entry <name>` 查询", "用 `show cdp entry name` 查询"),
    ("行内 code：中文占位符去尖括号",
     "命令 `ip route 0.0.0.0 0.0.0.0 <下一跳>` 即可", "命令 `ip route 0.0.0.0 0.0.0.0 下一跳` 即可"),
    ("行内 code：无尖括号不动",
     "运行 `idf.py build` 即可", "运行 `idf.py build` 即可"),
    ("围栏代码块内一律不动（自动 v-pre，raw '<' 安全）",
     "```\n<name>\n```\n正文 <tag>", "```\n<name>\n```\n正文 &lt;tag>"),
    ("合法 HTML 标签保留（figure / span.cite）",
     '见 <span class="cite">x</span> 与 <figure class="chart"></figure>',
     '见 <span class="cite">x</span> 与 <figure class="chart"></figure>'),
]

# ---- fix_content.escape_lt：白名单标签保护 + 自愈（2026-10-06 回归防线）----
CASES_FC = [
    ("C7：白名单标签原样保留（<strong> 不能被转义）",
     "<strong>粗体</strong>正文", "<strong>粗体</strong>正文"),
    ("C7：自闭合标签保留（<br/>）",
     "第一行<br/>第二行", "第一行<br/>第二行"),
    ("C7：自愈——误转义的 <strong> 还原为真标签",
     "\\<strong>粗体\\</strong>正文", "<strong>粗体</strong>正文"),
    ("C7：自愈——误转义的 <br/> 还原",
     "换行\\<br/>继续", "换行<br/>继续"),
    ("C7：非白名单占位符转义（Vue 会当标签）",
     "原型 <network-number> 处", "原型 \\<network-number> 处"),
    ("C7：`<` 后跟空格/数字不动",
     "误差 < 150 ms", "误差 < 150 ms"),
    ("C7：行内 code 内不动",
     "参数 `<name>` 说明", "参数 `<name>` 说明"),
    ("C7：.cite 行不动（保护 URL 属性）",
     '见 <span class="cite" data-cite="https://a.io">a</span>',
     '见 <span class="cite" data-cite="https://a.io">a</span>'),
]

ok = 0
total = 0
for label, cases, fn in (("sanitize_angle", CASES, lambda s: m.sanitize_angle(s)),
                         ("escape_lt", CASES_FC, lambda s: fc.escape_lt(s)[0])):
    print("== %s ==" % label)
    for name, src, want in cases:
        total += 1
        got = fn(src)
        flag = "PASS" if got == want else "FAIL"
        ok += flag == "PASS"
        print("%s  %s" % (flag, name))
        if flag == "FAIL":
            print("     源: %r" % src)
            print("     期望: %r" % want)
            print("     实际: %r" % got)
print("\n%d/%d 通过" % (ok, total))
sys.exit(0 if ok == total else 1)

