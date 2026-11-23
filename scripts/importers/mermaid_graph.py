#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Mermaid 知识图谱导入器 (Mermaid Knowledge Graph Importer).

将新版 Mermaid 拓扑图 (cs_knowledge_graph_310_final.mmd) 转换为系统引擎使用的
site/data/graph.json，并生成与既有讲义文件、旧版 Notion 知识图谱的深度对账报告。
支持通过 --bindings 传入人工绑定 JSON，具有最高优先级。
"""

import os as _os, sys as _sys
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), ".."))
from content_paths import resolve_content  # noqa: E402
import argparse
import glob
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict


def unescape_markdown(text: str) -> str:
    """还原 Markdown 转义字符。

    将形如 \\_、\\[、\\]、\\#、\\-、\\> 等反斜杠+任意字符还原成该字符本身。
    """
    return re.sub(r'\\(.)', r'\1', text)


def parse_mermaid(content: str):
    """严格解析 Mermaid 知识图谱内容。

    规则：
    1. 全文 Markdown 转义还原。
    2. 忽略 flowchart, %%, classDef, style, 空行。
    3. 支持嵌套 subgraph：最外层 Canvas 容器，内层 cat_NN 分类。
    4. 节点行格式：节点id["显示名"]:::类名
    5. 边行格式：a --> b
    6. 严格语法检查：遇到不认识的行抛出 ValueError 并指示行号。
    7. 边端点检查：端点必须存在于已解析节点中，否则抛出 ValueError。

    Returns:
        categories_dict: {cat_id: {'id': cat_id, 'title': title, 'nodes': [node_id, ...]}}
        nodes: list of node dicts with raw class and line number
        edges: list of (src, dst, line_no)
    """
    lines = content.splitlines()

    subgraph_stack = []  # [(id, title)]
    categories = {}      # cat_id -> {'id': cat_id, 'title': title, 'nodes': []}
    nodes = []           # list of dicts
    edges = []           # list of (src, dst, line_no)
    node_ids = set()

    node_regex = re.compile(r'^([A-Za-z0-9_]+)\["([^"]*)"\]:::([A-Za-z0-9_]+)$')
    edge_regex = re.compile(r'^([A-Za-z0-9_]+)\s*-->\s*([A-Za-z0-9_]+)$')
    subgraph_regex = re.compile(r'^subgraph\s+([A-Za-z0-9_]+)(?:\s*\["([^"]*)"\])?$')

    for idx, raw_line in enumerate(lines):
        line_no = idx + 1
        line = unescape_markdown(raw_line).strip()

        # 忽略空行
        if not line:
            continue

        # 忽略控制行与注释
        if (
            line.startswith("flowchart")
            or line.startswith("%%")
            or line.startswith("classDef")
            or line.startswith("style")
        ):
            continue

        # 子图起始
        m_sub = subgraph_regex.match(line)
        if m_sub:
            sg_id, sg_title = m_sub.group(1), m_sub.group(2) or sg_id
            subgraph_stack.append((sg_id, sg_title))
            if sg_id != "Canvas":
                if sg_id not in categories:
                    categories[sg_id] = {
                        "id": sg_id,
                        "title": sg_title,
                        "nodes": [],
                    }
            continue

        # 子图结束
        if line == "end":
            if not subgraph_stack:
                raise ValueError(f"Unmatched 'end' statement at line {line_no}")
            subgraph_stack.pop()
            continue

        # 节点定义
        m_node = node_regex.match(line)
        if m_node:
            nid, title, cls = m_node.group(1), m_node.group(2), m_node.group(3)
            # 获取最近的分类（非 Canvas）
            curr_cat = next(
                (sg[0] for sg in reversed(subgraph_stack) if sg[0] != "Canvas"),
                None
            )
            node_ids.add(nid)
            node_item = {
                "id": nid,
                "title": title,
                "category": curr_cat,
                "raw_class": cls,
                "line_no": line_no,
            }
            nodes.append(node_item)
            if curr_cat and curr_cat in categories:
                categories[curr_cat]["nodes"].append(nid)
            continue

        # 边定义
        m_edge = edge_regex.match(line)
        if m_edge:
            src, dst = m_edge.group(1), m_edge.group(2)
            edges.append((src, dst, line_no))
            continue

        # 无法识别的行严格报错
        raise ValueError(f"Unrecognized syntax at line {line_no}: {raw_line.strip()}")

    # 检查子图是否全部闭合
    if subgraph_stack:
        unclosed = [sg[0] for sg in subgraph_stack]
        raise ValueError(f"Unclosed subgraphs at EOF: {unclosed}")

    # 边端点存在性校验
    for src, dst, l_no in edges:
        if src not in node_ids:
            raise ValueError(f"Edge source node does not exist: '{src}' at line {l_no}")
        if dst not in node_ids:
            raise ValueError(f"Edge target node does not exist: '{dst}' at line {l_no}")

    return categories, nodes, edges


def scan_lecture_files(docs_dir: str):
    """扫描 docs 目录下的全部讲义文件，提取元数据与映射字典。

    返回:
        title_to_lectures: {clean_title: [lecture_path, ...]}
        all_lecture_files: {lecture_path: {'dir': str, 'stem': str, 'clean_title': str, 'raw_title': str, 'path': str}}
        dir_to_group: {dir_name: group_id}
    """
    groups_file = os.path.join(docs_dir, ".vitepress", "groups.mts")
    if not os.path.exists(groups_file):  # content mode (S2): the group list lives in content/groups.ts
        groups_file = resolve_content().groups
    dir_to_group = {}
    group_dirs = []

    if os.path.exists(groups_file):
        with open(groups_file, "r", encoding="utf-8") as f:
            content = f.read()
        pairs = re.findall(
            r'id:\s*[\x22\x27]([^\x22\x27]+)[\x22\x27]\s*,\s*dir:\s*[\x22\x27]([^\x22\x27]+)[\x22\x27]',
            content
        )
        for gid, d in pairs:
            dir_to_group[d] = gid
            group_dirs.append(d)

    if not group_dirs:
        # 回退：扫描 docs 下所有子目录
        subdirs = [
            d for d in os.listdir(docs_dir)
            if os.path.isdir(os.path.join(docs_dir, d)) and not d.startswith(".")
        ]
        group_dirs = subdirs

    title_to_lectures = defaultdict(list)
    all_lecture_files = {}

    for d in group_dirs:
        dir_path = os.path.join(docs_dir, d)
        if not os.path.exists(dir_path):
            continue
        for p in glob.glob(os.path.join(dir_path, "L*.md")):
            stem = os.path.splitext(os.path.basename(p))[0]
            lec_path = f"/{d}/{stem}"
            with open(p, "r", encoding="utf-8") as f:
                c = f.read()
            m_fm = re.search(r"^---\s*\n(.*?)\n---", c, re.DOTALL)
            raw_title = ""
            clean_title = ""
            node_id = ""
            if m_fm:
                m_title = re.search(
                    r"^title:\s*[\x22\x27]?(.*?)[\x22\x27]?\s*$",
                    m_fm.group(1),
                    re.MULTILINE
                )
                if m_title:
                    raw_title = m_title.group(1).strip()
                    clean_title = re.sub(r"^第\d+讲\s*·\s*", "", raw_title).strip()
                m_nid = re.search(
                    r"节点(?:\s*标识\*\*[:：])?\s*`([^`]+)`",
                    m_fm.group(1),
                )
                if m_nid:
                    node_id = m_nid.group(1).strip()
            if not node_id:
                m_nid_head = re.search(
                    r"节点(?:\s*标识\*\*[:：])?\s*`([^`]+)`",
                    c[:2000],
                )
                if m_nid_head:
                    node_id = m_nid_head.group(1).strip()
            
            title_to_lectures[clean_title].append(lec_path)
            all_lecture_files[lec_path] = {
                "dir": d,
                "stem": stem,
                "clean_title": clean_title,
                "raw_title": raw_title,
                "node_id": node_id,
                "path": p,
            }

    return title_to_lectures, all_lecture_files, dir_to_group


def _lecture_md_exists(docs_dir: str, lec_path: str) -> bool:
    """检查讲义路径 (/group/Lxx) 对应的 .md 物理文件是否在 docs_dir 中存在。"""
    if not docs_dir or not lec_path:
        return False
    md_rel = lec_path.lstrip("/\\") + ".md"
    md_path = os.path.join(docs_dir, *md_rel.replace("\\", "/").split("/"))
    return os.path.exists(md_path)


def resolve_nodes(
    parsed_nodes,
    legacy_data,
    docs_dir: str,
    title_to_lectures: dict,
    manual_bindings: dict = None,
    node_id_to_lectures: dict = None,
):
    """解析节点属性 (kind, status, lecture, binding)。

    类名到状态：
      learned -> read
      inprog -> reading
      unstarted -> unread
      project -> kind: 'project', 状态取旧 JSON，没有则 unread
      其他 -> kind: 'lecture'

    lecture 确定规则：
      1. 人工绑定 (--bindings) 优先级最高，覆盖自动结果。
      2. 旧 JSON 里同 nodeId 的 lecturePath，且对应 .md 真实存在。
      3. 讲义元数据 `节点` 标识精确唯一命中，且对应 .md 真实存在（可自愈旧 JSON 中的 null）。
      4. 旧 JSON 里没有的节点，用标题精确匹配 frontmatter title（去前缀），唯一命中才填。
      5. 都不满足填 None (JSON null)。

    校验铁律：
      - 人工绑定节点 ID 必须在图谱中存在。
      - 人工绑定讲义文件必须在 docs_dir 存在。
      - 同一个讲义不能被绑定到两个及以上节点（无论人工还是自动）。
    """
    CLASS_TO_STATUS = {
        "learned": "read",
        "inprog": "reading",
        "unstarted": "unread",
    }
    LEGACY_STATUS_MAP = {
        "已完成": "read",
        "学习中": "reading",
        "未开始": "unread",
        "read": "read",
        "reading": "reading",
        "unread": "unread",
    }

    manual_bindings = manual_bindings or {}
    node_id_to_lectures = node_id_to_lectures or {}
    node_id_set = {n["id"] for n in parsed_nodes}

    # 校验 1：人工绑定的节点 ID 必须存在于图谱
    for nid, lec in manual_bindings.items():
        if nid not in node_id_set:
            raise ValueError(
                f"Manual binding error: Node ID '{nid}' does not exist in graph."
            )
        # 校验 2：人工绑定的讲义文件必须存在
        rel_path = lec.lstrip("/\\") + ".md"
        md_path = os.path.join(docs_dir, *rel_path.replace("\\", "/").split("/"))
        if not os.path.exists(md_path):
            raise ValueError(
                f"Manual binding error: Lecture file does not exist for node '{nid}': '{lec}' ({md_path})"
            )

    legacy_by_id = {item["nodeId"]: item for item in legacy_data} if legacy_data else {}
    resolved = []
    title_matched_nodes = []
    manual_binding_records = []

    for item in parsed_nodes:
        nid = item["id"]
        title = item["title"]
        cat = item["category"]
        cls = item["raw_class"]

        if cls == "project":
            kind = "project"
            leg = legacy_by_id.get(nid)
            if leg and leg.get("status"):
                status = LEGACY_STATUS_MAP.get(leg["status"], "unread")
            else:
                status = "unread"
        else:
            kind = "lecture"
            status = CLASS_TO_STATUS.get(cls, "unread")

        # 计算原本自动应匹配的讲义路径（用于对账记录覆盖分析）
        auto_lecture = None
        if nid in legacy_by_id:
            lp = legacy_by_id[nid].get("lecturePath")
            if _lecture_md_exists(docs_dir, lp):
                auto_lecture = lp
        if auto_lecture is None and nid in node_id_to_lectures:
            fm_matches = [lp for lp in node_id_to_lectures[nid] if _lecture_md_exists(docs_dir, lp)]
            if len(fm_matches) == 1:
                auto_lecture = fm_matches[0]
        if auto_lecture is None and nid not in legacy_by_id:
            clean_t = title.strip()
            matches = title_to_lectures.get(clean_t, [])
            if len(matches) == 1 and _lecture_md_exists(docs_dir, matches[0]):
                auto_lecture = matches[0]

        # lecture 匹配优先级判定
        lecture = None
        binding_source = None
        matched_by_title = False

        # 优先级 1: 人工绑定
        if nid in manual_bindings:
            lecture = manual_bindings[nid]
            binding_source = "manual"
            manual_binding_records.append({
                "id": nid,
                "title": title,
                "category": cat,
                "lecture": lecture,
                "overrode": auto_lecture,
            })
        # 优先级 2: 旧 JSON 继承
        elif nid in legacy_by_id:
            lp = legacy_by_id[nid].get("lecturePath")
            if _lecture_md_exists(docs_dir, lp):
                lecture = lp
                binding_source = "legacy"
        # 优先级 3: 讲义元数据 `节点` 标识精确唯一命中（含自愈旧 JSON null 映射）
        if lecture is None and nid not in manual_bindings and nid in node_id_to_lectures:
            fm_matches = [lp for lp in node_id_to_lectures[nid] if _lecture_md_exists(docs_dir, lp)]
            if len(fm_matches) == 1:
                lecture = fm_matches[0]
                binding_source = "frontmatter"
        # 优先级 4: 标题唯一命中
        if lecture is None and nid not in manual_bindings and nid not in legacy_by_id:
            clean_t = title.strip()
            matches = title_to_lectures.get(clean_t, [])
            if len(matches) == 1:
                lecture = matches[0]
                binding_source = "title"
                matched_by_title = True
                title_matched_nodes.append({
                    "id": nid,
                    "title": title,
                    "lecture": lecture,
                })

        resolved.append({
            "id": nid,
            "title": title,
            "category": cat,
            "kind": kind,
            "status": status,
            "lecture": lecture,
            "binding": binding_source,
            "_matched_by_title": matched_by_title,
            "_raw_class": cls,
        })

    # 校验 3：重复绑定检测（同一个讲义不能被绑定到两个及以上节点）
    lecture_to_nodes = defaultdict(list)
    for n in resolved:
        if n["lecture"] is not None:
            lecture_to_nodes[n["lecture"]].append(n["id"])

    for lec, nids in sorted(lecture_to_nodes.items()):
        if len(nids) > 1:
            raise ValueError(
                f"Duplicate lecture binding error: Lecture '{lec}' is bound to multiple nodes: {nids}"
            )

    return resolved, title_matched_nodes, manual_binding_records


def build_graph_data(
    in_file_path: str,
    categories_dict: dict,
    resolved_nodes: list,
    edges: list,
):
    """构建 graph.json 数据结构并严格排序。"""
    with open(in_file_path, "rb") as f:
        file_bytes = f.read()
    file_sha256 = hashlib.sha256(file_bytes).hexdigest()

    # 排序 categories
    sorted_categories = []
    for cid in sorted(categories_dict.keys()):
        c_item = categories_dict[cid]
        sorted_categories.append({
            "id": c_item["id"],
            "title": c_item["title"],
            "nodes": sorted(c_item["nodes"]),
        })

    # 排序 nodes（增加 binding 字段）
    clean_nodes = []
    for n in resolved_nodes:
        clean_nodes.append({
            "id": n["id"],
            "title": n["title"],
            "category": n["category"],
            "kind": n["kind"],
            "status": n["status"],
            "lecture": n["lecture"],
            "binding": n["binding"],
        })
    sorted_nodes = sorted(clean_nodes, key=lambda x: x["id"])

    # 排序 edges（列表全部排序，去重保证确定性）
    edge_pairs = set((src, dst) for src, dst, _ in edges)
    sorted_edges = sorted([[src, dst] for src, dst in edge_pairs], key=lambda e: (e[0], e[1]))

    graph_data = {
        "schema": 1,
        "source": {
            "file": os.path.basename(in_file_path),
            "sha256": file_sha256,
            "nodes": len(sorted_nodes),
            "edges": len(sorted_edges),
        },
        "categories": sorted_categories,
        "nodes": sorted_nodes,
        "edges": sorted_edges,
    }
    return graph_data


def detect_graph_structure(nodes: list, edges: list):
    """检查拓扑结构：环、自环、重复边。"""
    node_set = {n["id"] for n in nodes}
    self_loops = []
    duplicate_edges = []
    seen_edges = set()

    adj = defaultdict(list)
    for src, dst, l_no in edges:
        if src == dst:
            self_loops.append((src, l_no))
        pair = (src, dst)
        if pair in seen_edges:
            duplicate_edges.append((src, dst, l_no))
        else:
            seen_edges.add(pair)
            adj[src].append(dst)

    # 检测环路 (DFS)
    visited = {}  # 0: unvisited, 1: visiting, 2: visited
    cycles = []

    def dfs(u, path):
        visited[u] = 1
        path.append(u)
        for v in adj.get(u, []):
            if visited.get(v, 0) == 1:
                idx = path.index(v)
                cycles.append(path[idx:] + [v])
            elif visited.get(v, 0) == 0:
                dfs(v, path)
        path.pop()
        visited[u] = 2

    for n in sorted(node_set):
        if visited.get(n, 0) == 0:
            dfs(n, [])

    return {
        "cycles": cycles,
        "self_loops": self_loops,
        "duplicate_edges": duplicate_edges,
    }


def generate_reconcile_report(
    in_file_path: str,
    graph_data: dict,
    resolved_nodes: list,
    edges: list,
    legacy_data: list,
    all_lecture_files: dict,
    dir_to_group: dict,
    title_matched_nodes: list,
    structure_info: dict,
    manual_binding_records: list = None,
) -> str:
    """生成详尽的对账报告 Markdown 内容。"""
    manual_binding_records = manual_binding_records or []
    categories = graph_data["categories"]
    nodes = graph_data["nodes"]
    file_sha256 = graph_data["source"]["sha256"]
    cat_map = {c["id"]: c["title"] for c in categories}

    # 1. 统计数据
    total_nodes = len(nodes)
    total_edges = len(graph_data["edges"])
    total_categories = len(categories)

    status_counts = Counter(n["status"] for n in nodes)
    binding_counts = Counter(n["binding"] for n in nodes)
    nodes_with_lec = [n for n in nodes if n["lecture"] is not None]
    nodes_without_lec = [n for n in nodes if n["lecture"] is None]

    # 2. 有图谱节点但无讲义文件的节点 (按分类分组)
    no_lec_by_cat = defaultdict(list)
    for n in sorted(nodes_without_lec, key=lambda x: (x["category"] or "", x["id"])):
        no_lec_by_cat[n["category"]].append(n)

    # 3. 有讲义文件但不在新图谱中的讲义
    used_lectures = {n["lecture"] for n in nodes if n["lecture"]}
    unused_lectures = []
    for lp, info in sorted(all_lecture_files.items(), key=lambda x: x[0]):
        if lp not in used_lectures:
            unused_lectures.append(info)

    # 4. 与旧 JSON 差异
    legacy_by_id = {x["nodeId"]: x for x in legacy_data} if legacy_data else {}
    current_by_id = {x["id"]: x for x in nodes}

    added_nodes = []
    for nid in sorted(set(current_by_id.keys()) - set(legacy_by_id.keys())):
        added_nodes.append(current_by_id[nid])

    removed_nodes = []
    for nid in sorted(set(legacy_by_id.keys()) - set(current_by_id.keys())):
        removed_nodes.append(legacy_by_id[nid])

    # 状态变化
    LEGACY_STATUS_MAP = {
        "已完成": "read",
        "学习中": "reading",
        "未开始": "unread",
        "read": "read",
        "reading": "reading",
        "unread": "unread",
    }
    status_changes = []
    for nid in sorted(set(current_by_id.keys()) & set(legacy_by_id.keys())):
        old_raw = legacy_by_id[nid].get("status")
        old_mapped = LEGACY_STATUS_MAP.get(old_raw, old_raw)
        new_status = current_by_id[nid]["status"]
        if old_mapped != new_status:
            status_changes.append({
                "id": nid,
                "title": current_by_id[nid]["title"],
                "old_raw": old_raw,
                "old_mapped": old_mapped,
                "new_status": new_status,
                "lecture": current_by_id[nid]["lecture"],
            })

    # 边差异 (以旧 JSON 的 prerequisites 为标准前置关系)
    legacy_edges = set()
    if legacy_data:
        for item in legacy_data:
            dst = item["nodeId"]
            for src in item.get("prerequisites", []):
                legacy_edges.add((src, dst))

    current_edges_set = set((src, dst) for src, dst in graph_data["edges"])
    added_edges = sorted(current_edges_set - legacy_edges)
    removed_edges = sorted(legacy_edges - current_edges_set)

    # 5. 每个分类在各讲义组的分布
    cat_distribution = []
    for cat in sorted(categories, key=lambda x: x["id"]):
        cid = cat["id"]
        c_nodes = [n for n in nodes if n["category"] == cid]
        grp_counts = defaultdict(int)
        for n in c_nodes:
            lp = n["lecture"]
            if lp:
                d = lp.strip("/").split("/")[0]
                gid = dir_to_group.get(d, d.upper())
                grp_counts[gid] += 1
            else:
                grp_counts["无讲义"] += 1
        dist_str = ", ".join(f"{g}: {cnt}" for g, cnt in sorted(grp_counts.items()))
        cat_distribution.append({
            "id": cid,
            "title": cat["title"],
            "count": len(c_nodes),
            "distribution": dist_str,
        })

    # 构建 Markdown 文本
    lines = [
        "# 知识图谱对账与导入报告 (Knowledge Graph Reconciliation Report)",
        "",
        "> 生成机制：由 `scripts/importers/mermaid_graph.py` 自动化导入生成  ",
        f"> 数据源图谱：`{os.path.basename(in_file_path)}` (SHA256: `{file_sha256}`)  ",
        f"> 关联基准：`site/docs/public/notion_knowledge_graph.json`（旧版 Notion 导出）与 `site/docs/` 实际讲义库",
        "",
        "---",
        "",
        "## 1. 全局总览 (Executive Overview)",
        "",
        "| 指标项 | 统计值 | 说明 |",
        "| :--- | :--- | :--- |",
        f"| **图谱节点总数** | **{total_nodes}** | 新版 Mermaid 拓扑图定义的全部知识节点 |",
        f"| **图谱先修边数** | **{total_edges}** | 严格有向依赖关系（`a --> b`，a 为 b 的先修） |",
        f"| **分类模块数** | **{total_categories}** | `cat_01` ~ `cat_44` 分类容器 |",
        f"| **状态：已完成 (read)** | **{status_counts.get('read', 0)}** | 标识为 `learned` 或旧版已完成 |",
        f"| **状态：学习中 (reading)** | **{status_counts.get('reading', 0)}** | 标识为 `inprog` 或旧版学习中 |",
        f"| **状态：未开始 (unread)** | **{status_counts.get('unread', 0)}** | 标识为 `unstarted` 或旧版未开始 |",
        f"| **已关联讲义节点** | **{len(nodes_with_lec)}** | 成功绑定且磁盘物理讲义文件真实存在 |",
        f"| **未关联讲义节点** | **{len(nodes_without_lec)}** | 属于前瞻图谱设计，当前讲义站尚未编写对应讲义 |",
        f"| └ 人工绑定 (`manual`) | **{binding_counts.get('manual', 0)}** | 由 `--bindings` 显式指定的高优先级绑定 |",
        f"| └ 旧版继承 (`legacy`) | **{binding_counts.get('legacy', 0)}** | 继承旧版 Notion 图谱映射且文件存在的绑定 |",
        f"| └ 元数据标识 (`frontmatter`) | **{binding_counts.get('frontmatter', 0)}** | 通过讲义 `节点` 元数据唯一命中的绑定 |",
        f"| └ 标题匹配 (`title`) | **{binding_counts.get('title', 0)}** | 通过去前缀标题精确唯一命中的绑定 |",
        f"| └ 未绑定 (`null`) | **{binding_counts.get(None, 0)}** | 当前无对应讲义文件的节点 |",
        f"| **讲义库全量文件数** | **{len(all_lecture_files)}** | 涵盖 15 个课程组下的全部 `L*.md` 讲义 |",
        f"| **图谱覆盖讲义数** | **{len(used_lectures)}** | 落在当前新图谱拓扑内的讲义数量 |",
        f"| **未入图谱讲义数** | **{len(unused_lectures)}** | 存在物理讲义但暂未纳入新图谱的讲义数量 |",
        "",
        "---",
        "",
        "## 2. 图谱中存在但缺少讲义文件的节点 (讲义建设落后部分)",
        "",
        f"当前图谱共有 **{len(nodes_without_lec)}** 个节点尚未在 `site/docs/` 讲义库中落地，按分类模块归纳如下：",
        "",
    ]

    for cid, c_nodes in sorted(no_lec_by_cat.items(), key=lambda x: x[0] or ""):
        ctitle = cat_map.get(cid, "未分类")
        lines.append(f"### {cid} · {ctitle} (共 {len(c_nodes)} 个待建讲义)")
        lines.append("")
        lines.append("| 节点 ID | 节点显示名称 | 节点类型 | 状态 | 在旧 JSON 存在 |")
        lines.append("| :--- | :--- | :--- | :--- | :--- |")
        for n in c_nodes:
            in_leg = "是" if n["id"] in legacy_by_id else "否 (纯新增)"
            lines.append(f"| `{n['id']}` | {n['title']} | `{n['kind']}` | `{n['status']}` | {in_leg} |")
        lines.append("")

    lines.extend([
        "---",
        "",
        "## 3. 存在物理讲义但不在新图谱中的讲义文件",
        "",
        f"讲义库共有 **{len(unused_lectures)}** 篇讲义未在新版图谱中引用。多数为：",
        "1. 新图谱重构/重命名了节点 ID（如 `gpio_interrupt_debounce` 重命名为 `gpio_interrupt`，导致旧绑定脱落）；",
        "2. 扩展专题讲义（如 G03 进阶外设与传感器、G04 网络安全扩展、G05 高阶 SQL 优化实战等）；",
        "3. 会议/专项论文编写大章（如 SPI 组中的方法论与证据库）。",
        "",
        "| 讲义路径 | 课程组 | 原讲义完整标题 | 旧图谱对应节点 (若有) |",
        "| :--- | :--- | :--- | :--- |",
    ])

    # 建立旧 JSON 的反查映射: lecturePath -> nodeId
    legacy_by_lp = {}
    if legacy_data:
        for item in legacy_data:
            lp = item.get("lecturePath")
            if lp:
                legacy_by_lp[lp] = item.get("nodeId")

    for info in unused_lectures:
        lp = f"/{info['dir']}/{info['stem']}"
        gid = dir_to_group.get(info['dir'], info['dir'].upper())
        old_nid = legacy_by_lp.get(lp, "-")
        old_nid_str = f"`{old_nid}`" if old_nid != "-" else "-"
        lines.append(f"| `{lp}` | **{gid}** | {info['raw_title']} | {old_nid_str} |")

    lines.extend([
        "",
        "---",
        "",
        "## 4. 与旧版图谱 (notion_knowledge_graph.json) 差异对比",
        "",
        f"### 4.1 新增节点 ({len(added_nodes)} 个)",
        "",
        "新版图谱相比旧版新增的全新知识节点：",
        "",
        "| 节点 ID | 节点名称 | 所属分类 | 节点类型 | 状态 |",
        "| :--- | :--- | :--- | :--- | :--- |",
    ])

    for n in added_nodes:
        ctitle = cat_map.get(n['category'], n['category'])
        lines.append(f"| `{n['id']}` | {n['title']} | {n['category']} ({ctitle}) | `{n['kind']}` | `{n['status']}` |")

    lines.extend([
        "",
        f"### 4.2 移除节点 ({len(removed_nodes)} 个)",
        "",
        "旧版图谱存在但在新版 Mermaid 拓扑图中已被剔除或重构合并的节点：",
        "",
        "| 原节点 ID | 原节点标题 | 原课程组 | 原讲义路径 | 原状态 |",
        "| :--- | :--- | :--- | :--- | :--- |",
    ])

    for n in removed_nodes:
        lp_str = f"`{n.get('lecturePath')}`" if n.get('lecturePath') else "-"
        lines.append(f"| `{n.get('nodeId')}` | {n.get('title')} | {n.get('groupId') or '-'} | {lp_str} | {n.get('status') or '-'} |")

    lines.extend([
        "",
        f"### 4.3 节点状态变更 ({len(status_changes)} 个)",
        "",
        "| 节点 ID | 节点显示名称 | 旧状态 | 新状态 | 关联讲义 |",
        "| :--- | :--- | :--- | :--- | :--- |",
    ])

    for ch in status_changes:
        lec_str = f"`{ch['lecture']}`" if ch['lecture'] else "-"
        lines.append(f"| `{ch['id']}` | {ch['title']} | {ch['old_raw']} (`{ch['old_mapped']}`) | **`{ch['new_status']}`** | {lec_str} |")

    lines.extend([
        "",
        f"### 4.4 依赖边变动 (新增 {len(added_edges)} 条 / 移除 {len(removed_edges)} 条)",
        "",
        "<details>",
        f"<summary><b>展开查看新增依赖边清单 ({len(added_edges)} 条)</b></summary>",
        "",
        "| 序号 | 先修源节点 (Source) | 后续目标节点 (Target) |",
        "| :--- | :--- | :--- |",
    ])
    for idx, (src, dst) in enumerate(added_edges, 1):
        lines.append(f"| {idx} | `{src}` | `{dst}` |")
    lines.extend([
        "",
        "</details>",
        "",
        "<details>",
        f"<summary><b>展开查看移除依赖边清单 ({len(removed_edges)} 条)</b></summary>",
        "",
        "| 序号 | 原先修源节点 (Source) | 原后续目标节点 (Target) |",
        "| :--- | :--- | :--- |",
    ])
    for idx, (src, dst) in enumerate(removed_edges, 1):
        lines.append(f"| {idx} | `{src}` | `{dst}` |")
    lines.extend([
        "",
        "</details>",
        "",
        "---",
        "",
        "## 5. 分类模块与课程组映射分布 (Category vs Group Distribution)",
        "",
        "| 分类 ID | 分类名称 | 节点总数 | 讲义组分布与节点数 |",
        "| :--- | :--- | :--- | :--- |",
    ])

    for cd in cat_distribution:
        lines.append(f"| `{cd['id']}` | {cd['title']} | {cd['count']} | {cd['distribution']} |")

    lines.extend([
        "",
        "---",
        "",
        "## 6. 图拓扑完整性与结构检查 (Graph Integrity Check)",
        "",
        "| 检查项 | 检查标准 | 检查结果 | 详情说明 |",
        "| :--- | :--- | :--- | :--- |",
        f"| **循环依赖 (Cycles)** | 图谱必须为纯有向无环图 (DAG) | **{'通过 (PASS)' if not structure_info['cycles'] else '失败 (FAIL)'}** | 发现 {len(structure_info['cycles'])} 个拓扑环 |",
        f"| **自环依赖 (Self-loops)** | 节点不可指向自身 (`a --> a`) | **{'通过 (PASS)' if not structure_info['self_loops'] else '失败 (FAIL)'}** | 发现 {len(structure_info['self_loops'])} 处自环 |",
        f"| **重复边 (Duplicates)** | 任意两节点间先修边唯一 | **{'通过 (PASS)' if not structure_info['duplicate_edges'] else '失败 (FAIL)'}** | 发现 {len(structure_info['duplicate_edges'])} 处重复边 |",
        "| **悬空边端点 (Endpoints)** | 边的两端必须为有效节点 | **通过 (PASS)** | 解析阶段强制断言校验，0 处悬空端点 |",
        "",
    ])

    if structure_info["cycles"]:
        lines.append("### 环路节点详情：")
        for c in structure_info["cycles"]:
            lines.append(f"- 环路链条：`{' -> '.join(c)}`")
        lines.append("")

    lines.extend([
        "---",
        "",
        "## 7. 标题精确匹配填入讲义的节点 (Title Matching Audit)",
        "",
        "依据导入规则第 2 条：对旧 JSON 中不存在的新增节点，使用标题去除「第N讲 · 」前缀及首尾空白后精确比对讲义库 frontmatter `title`。唯一命中才建立关联，供人工复核：",
        "",
        "| 节点 ID | 节点标题 | 唯一匹配讲义 | 磁盘文件路径 |",
        "| :--- | :--- | :--- | :--- |",
    ])

    if title_matched_nodes:
        for tm in title_matched_nodes:
            md_path = f"site/docs{tm['lecture']}.md"
            lines.append(f"| `{tm['id']}` | {tm['title']} | `{tm['lecture']}` | `{md_path}` |")
    else:
        lines.append("| (无) | - | - | - |")

    lines.extend([
        "",
        "---",
        "",
        "## 8. 人工讲义绑定 (Manual Bindings Audit)",
        "",
        f"本节记录通过 `--bindings` 显式指定的讲义绑定（具有最高优先级），共生效 **{len(manual_binding_records)}** 条规则：",
        "",
    ])

    if manual_binding_records:
        lines.append("| 节点 ID | 节点显示名称 | 所属分类 | 人工绑定讲义路径 | 原自动判定结果 | 覆盖影响说明 |")
        lines.append("| :--- | :--- | :--- | :--- | :--- | :--- |")
        for mb in manual_binding_records:
            cid = mb["category"] or "-"
            cname = cat_map.get(cid, cid)
            overrode_str = f"`{mb['overrode']}`" if mb["overrode"] else "`null` (无讲义)"
            effect = "覆盖旧自动讲义路径" if mb["overrode"] else "补全新增讲义绑定"
            lines.append(f"| `{mb['id']}` | {mb['title']} | `{cid}` ({cname}) | **`{mb['lecture']}`** | {overrode_str} | {effect} |")
        lines.append("")
    else:
        lines.append("> 当前人工绑定清单为空 (`{}`)，全部讲义路径由旧图谱及标题匹配规则自动确定。")
        lines.append("")

    lines.append(f"### 8.2 仍未关联讲义的节点清单 (剩余 {len(nodes_without_lec)} 个节点)")
    lines.append("")
    if nodes_without_lec:
        lines.append("| 节点 ID | 节点显示名称 | 所属分类 | 节点类型 | 状态 |")
        lines.append("| :--- | :--- | :--- | :--- | :--- |")
        for n in sorted(nodes_without_lec, key=lambda x: (x["category"] or "", x["id"])):
            cid = n["category"] or "-"
            cname = cat_map.get(cid, cid)
            lines.append(f"| `{n['id']}` | {n['title']} | `{cid}` ({cname}) | `{n['kind']}` | `{n['status']}` |")
        lines.append("")
    else:
        lines.append("🎉 全部图谱节点均已绑定有效物理讲义文件！")
        lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Mermaid 知识图谱导入器")
    parser.add_argument("--in", dest="in_file", required=True, help="Mermaid 拓扑图文件路径")
    parser.add_argument("--legacy", default=resolve_content().notion_knowledge_graph, help="旧版 Notion 知识图谱 JSON 路径")
    parser.add_argument("--docs", default="site/docs", help="讲义 docs 根目录")
    parser.add_argument("--bindings", default=None, help="人工讲义绑定 JSON 文件路径")
    parser.add_argument("--out", default=resolve_content().graph, help="输出 graph.json 路径")
    parser.add_argument("--report", default="plans/graph_reconcile_report.md", help="输出对账报告 Markdown 路径")

    args = parser.parse_args()

    # 1. 读取 Mermaid 文件
    if not os.path.exists(args.in_file):
        print(f"Error: Input file '{args.in_file}' not found.", file=sys.stderr)
        sys.exit(1)

    with open(args.in_file, "r", encoding="utf-8") as f:
        mermaid_content = f.read()

    # 2. 读取旧版 JSON
    legacy_data = []
    if os.path.exists(args.legacy):
        with open(args.legacy, "r", encoding="utf-8") as f:
            legacy_data = json.load(f)

    # 3. 读取人工绑定 JSON (若提供)
    manual_bindings = {}
    if args.bindings:
        if not os.path.exists(args.bindings):
            print(f"Error: Bindings file '{args.bindings}' not found.", file=sys.stderr)
            sys.exit(1)
        with open(args.bindings, "r", encoding="utf-8") as f:
            bindings_doc = json.load(f)
        manual_bindings = bindings_doc.get("bindings", {})

    # 4. 严格解析 Mermaid
    categories_dict, parsed_nodes, edges = parse_mermaid(mermaid_content)

    # 5. 扫描 docs 目录
    title_to_lectures, all_lecture_files, dir_to_group = scan_lecture_files(args.docs)
    node_id_to_lectures = defaultdict(list)
    for lp, info in all_lecture_files.items():
        if info.get("node_id"):
            node_id_to_lectures[info["node_id"]].append(lp)

    # 6. 解析节点属性与 lecture 绑定（含人工绑定覆盖与严格校验）
    try:
        resolved_nodes, title_matched_nodes, manual_binding_records = resolve_nodes(
            parsed_nodes,
            legacy_data,
            args.docs,
            title_to_lectures,
            manual_bindings=manual_bindings,
            node_id_to_lectures=node_id_to_lectures,
        )
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    # 7. 构建 graph.json 数据
    graph_data = build_graph_data(args.in_file, categories_dict, resolved_nodes, edges)

    # 8. 结构完整性检查
    structure_info = detect_graph_structure(graph_data["nodes"], edges)

    # 9. 写入 graph.json
    out_dir = os.path.dirname(args.out)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    json_str = json.dumps(graph_data, ensure_ascii=False, indent=1) + "\n"
    # newline="\n": always LF, so the bytes are identical on Windows and Linux (git also stores LF, see .gitattributes).
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(json_str)

    print(f"Successfully generated graph JSON: {args.out}")

    # 10. 写入对账报告
    if args.report:
        report_dir = os.path.dirname(args.report)
        if report_dir and not os.path.exists(report_dir):
            os.makedirs(report_dir, exist_ok=True)

        report_md = generate_reconcile_report(
            args.in_file,
            graph_data,
            resolved_nodes,
            edges,
            legacy_data,
            all_lecture_files,
            dir_to_group,
            title_matched_nodes,
            structure_info,
            manual_binding_records=manual_binding_records,
        )
        with open(args.report, "w", encoding="utf-8", newline="\n") as f:
            f.write(report_md)
        print(f"Successfully generated reconciliation report: {args.report}")


if __name__ == "__main__":
    main()
