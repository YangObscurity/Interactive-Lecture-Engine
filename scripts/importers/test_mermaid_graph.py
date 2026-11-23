#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Unit tests for Mermaid Knowledge Graph Importer (scripts/importers/mermaid_graph.py)."""

import json
import os
import sys
import tempfile
import unittest

# Ensure repo root is on sys.path
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from scripts.importers.mermaid_graph import (
    unescape_markdown,
    parse_mermaid,
    scan_lecture_files,
    resolve_nodes,
    build_graph_data,
    detect_graph_structure,
)


class TestMermaidGraphImporter(unittest.TestCase):
    """Test suite covering unescaping, nested subgraphs, status/kind mappings,
    validation errors with line numbers, manual bindings, and output determinism.
    """

    def test_unescape_markdown(self):
        """测试 Markdown 转义字符还原 (\\_ -> _, \\[ -> [, \\- -> -, \\> -> > 等)。"""
        raw = r"subgraph cat\_01 \[\"C 语言核心\"\]"
        expected = 'subgraph cat_01 ["C 语言核心"]'
        self.assertEqual(unescape_markdown(raw), expected)

        edge_raw = r"antenna\_rf\_keepout \--\> cellular\_module\_powerkey\_reset"
        edge_expected = "antenna_rf_keepout --> cellular_module_powerkey_reset"
        self.assertEqual(unescape_markdown(edge_raw), edge_expected)

        node_raw = r"c\_overview\[\"C 语言定位与编译认知\"\]:::learned"
        node_expected = 'c_overview["C 语言定位与编译认知"]:::learned'
        self.assertEqual(unescape_markdown(node_raw), node_expected)

    def test_nested_subgraph(self):
        """测试嵌套 subgraph 解析：Canvas 容器忽略，cat_NN 记录分类，end 正确闭合栈。"""
        mmd_content = """flowchart TD
    %%{init: {'theme': 'base'}}%%
    subgraph Canvas ["画布全量"]
        subgraph cat_01 ["分类一"]
            node_a["节点 A"]:::learned
            node_b["节点 B"]:::unstarted
        end
        subgraph cat_02 ["分类二"]
            node_c["节点 C"]:::inprog
        end
    end
"""
        categories, nodes, edges = parse_mermaid(mmd_content)

        # Canvas 不应作为分类记录在 categories 中
        self.assertNotIn("Canvas", categories)
        self.assertIn("cat_01", categories)
        self.assertIn("cat_02", categories)

        self.assertEqual(categories["cat_01"]["title"], "分类一")
        self.assertEqual(categories["cat_01"]["nodes"], ["node_a", "node_b"])
        self.assertEqual(categories["cat_02"]["title"], "分类二")
        self.assertEqual(categories["cat_02"]["nodes"], ["node_c"])

        # 检查节点所属分类
        node_dict = {n["id"]: n for n in nodes}
        self.assertEqual(node_dict["node_a"]["category"], "cat_01")
        self.assertEqual(node_dict["node_b"]["category"], "cat_01")
        self.assertEqual(node_dict["node_c"]["category"], "cat_02")

    def test_class_to_status(self):
        """测试类名到状态映射：learned -> read, inprog -> reading, unstarted -> unread。"""
        mmd_content = """flowchart TD
    subgraph cat_test ["测试分类"]
        n_learned["学完节点"]:::learned
        n_inprog["进行中节点"]:::inprog
        n_unstarted["未开始节点"]:::unstarted
    end
"""
        categories, nodes, edges = parse_mermaid(mmd_content)
        resolved, _, _ = resolve_nodes(nodes, legacy_data=[], docs_dir="", title_to_lectures={})

        res_dict = {n["id"]: n for n in resolved}
        self.assertEqual(res_dict["n_learned"]["status"], "read")
        self.assertEqual(res_dict["n_learned"]["kind"], "lecture")

        self.assertEqual(res_dict["n_inprog"]["status"], "reading")
        self.assertEqual(res_dict["n_inprog"]["kind"], "lecture")

        self.assertEqual(res_dict["n_unstarted"]["status"], "unread")
        self.assertEqual(res_dict["n_unstarted"]["kind"], "lecture")

    def test_project_node(self):
        """测试 project 节点：kind 为 project，状态取旧 JSON（未开始->unread, 已完成->read），无旧数据则为 unread。"""
        mmd_content = """flowchart TD
    subgraph cat_proj ["项目实战"]
        proj_old_done["已有已完成项目"]:::project
        proj_old_doing["已有进行中项目"]:::project
        proj_old_unstarted["已有未开始项目"]:::project
        proj_new["新项目"]:::project
    end
"""
        categories, nodes, edges = parse_mermaid(mmd_content)

        legacy_data = [
            {"nodeId": "proj_old_done", "status": "已完成", "lecturePath": None},
            {"nodeId": "proj_old_doing", "status": "学习中", "lecturePath": None},
            {"nodeId": "proj_old_unstarted", "status": "未开始", "lecturePath": None},
        ]

        resolved, _, _ = resolve_nodes(nodes, legacy_data=legacy_data, docs_dir="", title_to_lectures={})
        res_dict = {n["id"]: n for n in resolved}

        # 存在于旧 JSON 且为已完成 -> read
        self.assertEqual(res_dict["proj_old_done"]["kind"], "project")
        self.assertEqual(res_dict["proj_old_done"]["status"], "read")

        # 存在于旧 JSON 且为学习中 -> reading
        self.assertEqual(res_dict["proj_old_doing"]["kind"], "project")
        self.assertEqual(res_dict["proj_old_doing"]["status"], "reading")

        # 存在于旧 JSON 且为未开始 -> unread
        self.assertEqual(res_dict["proj_old_unstarted"]["kind"], "project")
        self.assertEqual(res_dict["proj_old_unstarted"]["status"], "unread")

        # 不在旧 JSON 中 -> fallback unread
        self.assertEqual(res_dict["proj_new"]["kind"], "project")
        self.assertEqual(res_dict["proj_new"]["status"], "unread")

    def test_missing_edge_endpoint_raises(self):
        """测试边端点不存在时严格报错并指示行号与缺失节点 ID。"""
        mmd_content = """flowchart TD
    subgraph cat_01 ["分类"]
        node_a["节点 A"]:::learned
    end
    node_a --> ghost_node
"""
        with self.assertRaises(ValueError) as ctx:
            parse_mermaid(mmd_content)
        self.assertIn("ghost_node", str(ctx.exception))
        self.assertIn("line 5", str(ctx.exception))

    def test_unrecognized_line_raises_with_lineno(self):
        """测试未知语法行严格报错并附带准确行号。"""
        mmd_content = """flowchart TD
    subgraph cat_01 ["分类"]
        node_a["节点 A"]:::learned
        INVALID_SYNTAX_LINE_HERE
    end
"""
        with self.assertRaises(ValueError) as ctx:
            parse_mermaid(mmd_content)
        self.assertIn("line 4", str(ctx.exception))
        self.assertIn("INVALID_SYNTAX_LINE_HERE", str(ctx.exception))

    def test_output_determinism_and_sorting(self):
        """测试输出排序确定性：无论输入顺序如何，输出列表全部严格排序，两次运行产物逐字节相同。"""
        # 构造乱序的 Mermaid 文本
        mmd_unordered = """flowchart TD
    subgraph cat_02 ["分类乙"]
        node_z["节点 Z"]:::unstarted
        node_m["节点 M"]:::learned
    end
    subgraph cat_01 ["分类甲"]
        node_b["节点 B"]:::learned
        node_a["节点 A"]:::inprog
    end
    node_z --> node_a
    node_b --> node_m
    node_a --> node_b
"""
        # 使用临时文件测试 build_graph_data
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".mmd") as tmp:
            tmp.write(mmd_unordered)
            tmp_path = tmp.name

        try:
            cats, nodes, edges = parse_mermaid(mmd_unordered)
            resolved, _, _ = resolve_nodes(nodes, legacy_data=[], docs_dir="", title_to_lectures={})

            data1 = build_graph_data(tmp_path, cats, resolved, edges)
            data2 = build_graph_data(tmp_path, cats, resolved, edges)

            # 序列化为带缩进 JSON 字符串
            json1 = json.dumps(data1, ensure_ascii=False, indent=1) + "\n"
            json2 = json.dumps(data2, ensure_ascii=False, indent=1) + "\n"

            # 逐字节完全相同
            self.assertEqual(json1, json2)

            # 验证 categories 列表已按 id 升序排序
            cat_ids = [c["id"] for c in data1["categories"]]
            self.assertEqual(cat_ids, ["cat_01", "cat_02"])

            # 验证 category 内部 nodes 已字母排序
            self.assertEqual(data1["categories"][0]["nodes"], ["node_a", "node_b"])
            self.assertEqual(data1["categories"][1]["nodes"], ["node_m", "node_z"])

            # 验证 nodes 列表已按 id 升序排序
            node_ids = [n["id"] for n in data1["nodes"]]
            self.assertEqual(node_ids, ["node_a", "node_b", "node_m", "node_z"])

            # 验证 edges 列表已排序
            expected_edges = [
                ["node_a", "node_b"],
                ["node_b", "node_m"],
                ["node_z", "node_a"],
            ]
            self.assertEqual(data1["edges"], expected_edges)
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)

    def test_lecture_matching_rules(self):
        """测试 lecture 绑定规则：旧 JSON 优先且需文件真实存在；新节点按标题精确匹配。"""
        with tempfile.TemporaryDirectory() as tmp_docs:
            # 创建模拟讲义文件
            g01_dir = os.path.join(tmp_docs, "g01")
            os.makedirs(g01_dir, exist_ok=True)
            l01_path = os.path.join(g01_dir, "L01.md")
            with open(l01_path, "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第1讲 · 电阻直觉模型"\n---\n正文...')

            g02_dir = os.path.join(tmp_docs, "g02")
            os.makedirs(g02_dir, exist_ok=True)
            l02_path = os.path.join(g02_dir, "L01.md")
            with open(l02_path, "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第1讲 · C语言编译认知"\n---\n正文...')

            mmd = """flowchart TD
    subgraph cat_01 ["测试"]
        n_legacy_exists["旧节点文件在"]:::learned
        n_legacy_missing["旧节点文件丢失"]:::learned
        n_new_matched["C语言编译认知"]:::learned
        n_new_unmatched["无对应文件的新节点"]:::unstarted
    end
"""
            cats, nodes, edges = parse_mermaid(mmd)

            legacy = [
                {"nodeId": "n_legacy_exists", "status": "已完成", "lecturePath": "/g01/L01"},
                {"nodeId": "n_legacy_missing", "status": "已完成", "lecturePath": "/g99/L99"},
            ]

            title_to_lectures = {
                "C语言编译认知": ["/g02/L01"],
                "电阻直觉模型": ["/g01/L01"],
            }

            resolved, title_matched, _ = resolve_nodes(
                nodes,
                legacy_data=legacy,
                docs_dir=tmp_docs,
                title_to_lectures=title_to_lectures,
            )
            res_dict = {n["id"]: n for n in resolved}

            # 1. 旧 JSON 命中且文件存在
            self.assertEqual(res_dict["n_legacy_exists"]["lecture"], "/g01/L01")
            self.assertEqual(res_dict["n_legacy_exists"]["binding"], "legacy")

            # 2. 旧 JSON 虽有 lecturePath 但物理文件不存在 -> null
            self.assertIsNone(res_dict["n_legacy_missing"]["lecture"])
            self.assertIsNone(res_dict["n_legacy_missing"]["binding"])

            # 3. 旧 JSON 中没有，但标题唯一命中 -> 填入 /g02/L01
            self.assertEqual(res_dict["n_new_matched"]["lecture"], "/g02/L01")
            self.assertEqual(res_dict["n_new_matched"]["binding"], "title")
            self.assertEqual(len(title_matched), 1)
            self.assertEqual(title_matched[0]["id"], "n_new_matched")

            # 4. 新节点且标题无匹配 -> null
            self.assertIsNone(res_dict["n_new_unmatched"]["lecture"])
            self.assertIsNone(res_dict["n_new_unmatched"]["binding"])

    def test_manual_binding_overrides_automatic(self):
        """测试人工绑定覆盖自动结果：人工绑定优先级最高，覆盖旧 JSON 与标题匹配。"""
        with tempfile.TemporaryDirectory() as tmp_docs:
            g01_dir = os.path.join(tmp_docs, "g01")
            os.makedirs(g01_dir, exist_ok=True)
            for l_name in ["L01.md", "L02.md", "L03.md"]:
                with open(os.path.join(g01_dir, l_name), "w", encoding="utf-8") as f:
                    f.write(f'---\ntitle: "第1讲 · 测试{l_name}"\n---\n')

            mmd = """flowchart TD
    subgraph cat_01 ["测试"]
        node_override_legacy["覆盖旧版节点"]:::learned
        node_override_title["覆盖标题匹配"]:::learned
        node_bind_null["从空补全节点"]:::unstarted
    end
"""
            cats, nodes, edges = parse_mermaid(mmd)

            legacy = [
                {"nodeId": "node_override_legacy", "status": "已完成", "lecturePath": "/g01/L01"}
            ]
            title_to_lectures = {
                "覆盖标题匹配": ["/g01/L01"]
            }

            # 人工绑定将它们分别指向不同的讲义
            manual = {
                "node_override_legacy": "/g01/L02",
                "node_override_title": "/g01/L03",
                "node_bind_null": "/g01/L01",
            }

            resolved, _, manual_records = resolve_nodes(
                nodes,
                legacy_data=legacy,
                docs_dir=tmp_docs,
                title_to_lectures=title_to_lectures,
                manual_bindings=manual,
            )
            res_dict = {n["id"]: n for n in resolved}

            # 验证全部被人工绑定覆盖且 binding 标记为 manual
            self.assertEqual(res_dict["node_override_legacy"]["lecture"], "/g01/L02")
            self.assertEqual(res_dict["node_override_legacy"]["binding"], "manual")

            self.assertEqual(res_dict["node_override_title"]["lecture"], "/g01/L03")
            self.assertEqual(res_dict["node_override_title"]["binding"], "manual")

            self.assertEqual(res_dict["node_bind_null"]["lecture"], "/g01/L01")
            self.assertEqual(res_dict["node_bind_null"]["binding"], "manual")

            # 验证对账记录中保留了原先覆盖的目标
            rec_map = {r["id"]: r for r in manual_records}
            self.assertEqual(rec_map["node_override_legacy"]["overrode"], "/g01/L01")
            self.assertEqual(rec_map["node_override_title"]["overrode"], "/g01/L01")
            self.assertIsNone(rec_map["node_bind_null"]["overrode"])

    def test_manual_binding_nonexistent_node_raises(self):
        """测试人工绑定中包含不存在的节点 ID 时严格报错。"""
        mmd = """flowchart TD
    subgraph cat_01 ["测试"]
        node_real["真实节点"]:::learned
    end
"""
        cats, nodes, edges = parse_mermaid(mmd)
        manual = {"nonexistent_ghost_node": "/g01/L01"}

        with self.assertRaises(ValueError) as ctx:
            resolve_nodes(nodes, legacy_data=[], docs_dir="", title_to_lectures={}, manual_bindings=manual)
        self.assertIn("nonexistent_ghost_node", str(ctx.exception))
        self.assertIn("does not exist in graph", str(ctx.exception))

    def test_manual_binding_missing_file_raises(self):
        """测试人工绑定指定的讲义物理文件不存在时严格报错。"""
        with tempfile.TemporaryDirectory() as tmp_docs:
            mmd = """flowchart TD
    subgraph cat_01 ["测试"]
        node_real["真实节点"]:::learned
    end
"""
            cats, nodes, edges = parse_mermaid(mmd)
            manual = {"node_real": "/g99/L99"}  # 物理文件不存在

            with self.assertRaises(ValueError) as ctx:
                resolve_nodes(nodes, legacy_data=[], docs_dir=tmp_docs, title_to_lectures={}, manual_bindings=manual)
            self.assertIn("/g99/L99", str(ctx.exception))
            self.assertIn("does not exist", str(ctx.exception))

    def test_duplicate_lecture_binding_raises(self):
        """测试重复绑定检测：同一个讲义被绑定到两个及以上节点时（无论人工还是自动）严格报错。"""
        with tempfile.TemporaryDirectory() as tmp_docs:
            g01_dir = os.path.join(tmp_docs, "g01")
            os.makedirs(g01_dir, exist_ok=True)
            with open(os.path.join(g01_dir, "L01.md"), "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第1讲 · 共享讲义"\n---\n')

            mmd = """flowchart TD
    subgraph cat_01 ["测试"]
        node_a["节点甲"]:::learned
        node_b["节点乙"]:::learned
    end
"""
            cats, nodes, edges = parse_mermaid(mmd)

            # 场景 1: 人工绑定将两个节点绑定到同一个讲义
            manual = {
                "node_a": "/g01/L01",
                "node_b": "/g01/L01",
            }
            with self.assertRaises(ValueError) as ctx:
                resolve_nodes(nodes, legacy_data=[], docs_dir=tmp_docs, title_to_lectures={}, manual_bindings=manual)
            self.assertIn("Duplicate lecture binding", str(ctx.exception))
            self.assertIn("/g01/L01", str(ctx.exception))
            self.assertIn("node_a", str(ctx.exception))
            self.assertIn("node_b", str(ctx.exception))

            # 场景 2: 节点甲自动继承 /g01/L01，人工绑定把节点乙也绑到 /g01/L01
            legacy = [{"nodeId": "node_a", "status": "已完成", "lecturePath": "/g01/L01"}]
            manual_conflict = {"node_b": "/g01/L01"}
            with self.assertRaises(ValueError) as ctx2:
                resolve_nodes(nodes, legacy_data=legacy, docs_dir=tmp_docs, title_to_lectures={}, manual_bindings=manual_conflict)
            self.assertIn("Duplicate lecture binding", str(ctx2.exception))
            self.assertIn("/g01/L01", str(ctx2.exception))

    def test_no_bindings_arg_unchanged(self):
        """测试不传参数时输出不变：不传 manual_bindings 与传入空 bindings 结果逐字节相同，且讲义自动分配保持一致。"""
        with tempfile.TemporaryDirectory() as tmp_docs:
            g01_dir = os.path.join(tmp_docs, "g01")
            os.makedirs(g01_dir, exist_ok=True)
            with open(os.path.join(g01_dir, "L01.md"), "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第1讲 · 讲义一"\n---\n')

            mmd = """flowchart TD
    subgraph cat_01 ["测试"]
        node_a["节点甲"]:::learned
        node_b["节点乙"]:::unstarted
    end
"""
            cats, nodes, edges = parse_mermaid(mmd)
            legacy = [{"nodeId": "node_a", "status": "已完成", "lecturePath": "/g01/L01"}]

            res_none, _, rec_none = resolve_nodes(
                nodes, legacy_data=legacy, docs_dir=tmp_docs, title_to_lectures={}, manual_bindings=None
            )
            res_empty, _, rec_empty = resolve_nodes(
                nodes, legacy_data=legacy, docs_dir=tmp_docs, title_to_lectures={}, manual_bindings={}
            )

            # 数据结构完全一致
            self.assertEqual(res_none, res_empty)
            self.assertEqual(rec_none, [])
            self.assertEqual(rec_empty, [])

            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".mmd") as tmp:
                tmp.write(mmd)
                tmp_path = tmp.name

            try:
                g_none = build_graph_data(tmp_path, cats, res_none, edges)
                g_empty = build_graph_data(tmp_path, cats, res_empty, edges)

                json_none = json.dumps(g_none, ensure_ascii=False, indent=1) + "\n"
                json_empty = json.dumps(g_empty, ensure_ascii=False, indent=1) + "\n"

                # 逐字节完全一致
                self.assertEqual(json_none, json_empty)

                # 节点正确标记 binding 来源
                node_map = {n["id"]: n for n in g_none["nodes"]}
                self.assertEqual(node_map["node_a"]["binding"], "legacy")
                self.assertIsNone(node_map["node_b"]["binding"])
            finally:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)


class TestCliOutputBytes(unittest.TestCase):
    def test_cli_writes_lf_only(self):
        """CLI output must be LF-only on every platform; on Windows text-mode writes would otherwise turn each newline into CRLF."""
        import subprocess

        repo = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        with tempfile.TemporaryDirectory() as tmp:
            docs = os.path.join(tmp, "docs")
            os.makedirs(os.path.join(docs, ".vitepress"))
            os.makedirs(os.path.join(docs, "g01"))
            with open(os.path.join(docs, ".vitepress", "groups.mts"), "w", encoding="utf-8") as f:
                f.write("export const GROUPS = [\n  { id: 'G01', dir: 'g01', title: 'T' },\n]\n")
            with open(os.path.join(docs, "g01", "L01.md"), "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第1讲 · 节点甲"\n---\n')
            mmd = os.path.join(tmp, "g.mmd")
            with open(mmd, "w", encoding="utf-8") as f:
                f.write('flowchart TD\n    subgraph cat_01 ["测试"]\n        node_a["节点甲"]:::learned\n        node_b["节点乙"]:::unstarted\n    end\n    node_a --> node_b\n')
            legacy = os.path.join(tmp, "legacy.json")
            with open(legacy, "w", encoding="utf-8") as f:
                json.dump([], f)
            out, report = os.path.join(tmp, "graph.json"), os.path.join(tmp, "report.md")
            proc = subprocess.run(
                [sys.executable, os.path.join(repo, "scripts", "importers", "mermaid_graph.py"),
                 "--in", mmd, "--legacy", legacy, "--docs", docs, "--out", out, "--report", report],
                cwd=repo, capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            for path in (out, report):
                with open(path, "rb") as f:
                    data = f.read()
                self.assertNotIn(b"\r", data, f"{os.path.basename(path)} contains CR bytes")


class TestFrontmatterNodeIdBinding(unittest.TestCase):
    def test_frontmatter_node_id_binds_and_heals_legacy_null(self):
        """讲义元数据中的 `节点 `node_id`` 能唯一绑定并自愈旧 JSON 的 lecturePath: null。"""
        with tempfile.TemporaryDirectory() as tmp_docs:
            g03_dir = os.path.join(tmp_docs, "g03")
            g12_dir = os.path.join(tmp_docs, "g12")
            os.makedirs(g03_dir, exist_ok=True)
            os.makedirs(g12_dir, exist_ok=True)
            with open(os.path.join(g03_dir, "L54.md"), "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第54讲 · 外设扩展版"\ndescription: "节点 `mcu_adc_pwm_timer` ｜ 亚组: G03"\n---\n')
            with open(os.path.join(g12_dir, "L01.md"), "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第1讲 · 项目标题与图谱不同"\n---\n\n> **节点标识**: `project_blink_button`\n')
            with open(os.path.join(g12_dir, "L02.md"), "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第2讲 · 另一讲"\ndescription: "节点 `override_target`"\n---\n')
            with open(os.path.join(g12_dir, "L03.md"), "w", encoding="utf-8") as f:
                f.write('---\ntitle: "第3讲 · 手动覆盖目标"\n---\n')

            mmd = """flowchart TD
    subgraph cat_08 ["外设"]
        mcu_adc_pwm_timer["短名称：ADC/PWM"]:::unstarted
        override_target["手动覆盖测试"]:::unstarted
    end
    subgraph cat_44 ["项目"]
        project_blink_button["LED 按钮状态机项目"]:::project
    end
"""
            _, parsed_nodes, _ = parse_mermaid(mmd)
            title_to_lectures, all_lecture_files, _ = scan_lecture_files(tmp_docs)
            node_id_to_lectures = {}
            for lp, info in all_lecture_files.items():
                if info.get("node_id"):
                    node_id_to_lectures.setdefault(info["node_id"], []).append(lp)

            legacy = [
                {"nodeId": "project_blink_button", "status": "未开始", "lecturePath": None},
            ]
            manual = {"override_target": "/g12/L03"}
            resolved, _, manual_records = resolve_nodes(
                parsed_nodes,
                legacy_data=legacy,
                docs_dir=tmp_docs,
                title_to_lectures=title_to_lectures,
                manual_bindings=manual,
                node_id_to_lectures=node_id_to_lectures,
            )
            res = {n["id"]: n for n in resolved}
            self.assertEqual(res["mcu_adc_pwm_timer"]["lecture"], "/g03/L54")
            self.assertEqual(res["mcu_adc_pwm_timer"]["binding"], "frontmatter")
            self.assertEqual(res["project_blink_button"]["lecture"], "/g12/L01")
            self.assertEqual(res["project_blink_button"]["binding"], "frontmatter")
            self.assertEqual(res["override_target"]["lecture"], "/g12/L03")
            self.assertEqual(res["override_target"]["binding"], "manual")
            self.assertEqual(manual_records[0]["overrode"], "/g12/L02")


if __name__ == "__main__":
    unittest.main()
