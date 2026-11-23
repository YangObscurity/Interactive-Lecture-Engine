"""notion_graph_export.py: read-only export of the Notion knowledge-graph database to the Mermaid topology that
scripts/importers/mermaid_graph.py parses (content-sources/graph/cs_knowledge_graph.mmd).

Notion is the source of truth, so graph.json is reproducible: notion_graph_export.py -> mermaid_graph.py.
- Nodes: one per page with a non-empty `ID`. Class from Status (已完成 learned / 学习中 inprog / 未开始 unstarted);
  every node of the category "项目实战" is class `project`.
- Categories: cat_01 .. cat_NN follow content-sources/graph/category-order.json (Category names; Notion's select options
  carry no usable order). Used categories missing from that file are appended in schema order and reported.
- Labels: content-sources/graph/title-labels.json (id -> short label) first; the Notion `Name` only for ids missing from it
  (those ids are listed in the report, so a new node without a short label is visible).
- Edges: union of the `前置` relation and the `前置IDs` text field, deduplicated. Edges present in only one source,
  relations to pages without an `ID`, and unknown ids are reported (Notion is never modified).
Token: NOTION_TOKEN in ~/.secrets/notion.env (same as notion_props.py); never printed or written.
Run: python scripts/importers/notion_graph_export.py [--out content-sources/graph/cs_knowledge_graph.mmd]
"""
import argparse, json, os, re, sys, time, urllib.request
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from content_paths import notion_database_id  # noqa: E402
DB = notion_database_id()  # NOTION_GRAPH_DB or <content>/graph/notion-source.json
ENV = os.path.join(os.path.expanduser("~"), ".secrets", "notion.env")
PROJECT_CATEGORY = "项目实战"
STATUS_CLASS = {"已完成": "learned", "学习中": "inprog", "未开始": "unstarted"}


def _token():
    return re.search(r"NOTION_TOKEN\s*=\s*(\S+)", open(ENV, "rb").read().decode("utf-8-sig", "replace")).group(1)


def _call(tok, url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET",
                                 headers={"Authorization": "Bearer " + tok, "Notion-Version": "2022-06-28", "Content-Type": "application/json"})
    for i in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:
            print("retry", i + 1, type(e).__name__); time.sleep(2 + 2 * i)
    raise SystemExit("request failed")


def fetch():
    tok = _token()
    schema = _call(tok, "https://api.notion.com/v1/databases/" + DB)
    cats = [o["name"] for o in schema["properties"]["Category"]["select"]["options"]]
    pages, cur = [], None
    while True:
        body = {"page_size": 100}
        if cur: body["start_cursor"] = cur
        r = _call(tok, "https://api.notion.com/v1/databases/%s/query" % DB, body)
        pages += r["results"]
        if not r.get("has_more"): break
        cur = r["next_cursor"]
    return cats, pages


def text(p): return "".join(t.get("plain_text", "") for t in (p or {}).get("rich_text", []))


def build(cats, pages, labels, order=()):
    """Pure function: (category option names, Notion pages, labels, category order) -> (mmd text, report lines)."""
    rep = []
    pid, nodes = {}, {}
    for pg in pages:
        pr = pg["properties"]
        nid = text(pr.get("ID")).strip()
        if not nid:
            rep.append("skip page without ID: " + "".join(t.get("plain_text", "") for t in pr["Name"]["title"]))
            continue
        if nid in nodes: raise SystemExit("duplicate node ID: " + nid)
        pid[pg["id"]] = nid
        name = "".join(t.get("plain_text", "") for t in pr["Name"]["title"]).strip()
        nodes[nid] = {"name": name, "cat": (pr["Category"]["select"] or {}).get("name"), "status": (pr["Status"]["select"] or {}).get("name")}
    missing_label = sorted(n for n in nodes if n not in labels)
    if missing_label: rep.append("no short label (fell back to Notion Name): " + ", ".join(missing_label))
    unused = sorted(set(labels) - set(nodes))
    if unused: rep.append("labels for ids not in Notion: " + ", ".join(unused))
    rel, txt = set(), set()
    for pg in pages:
        pr = pg["properties"]; nid = pid.get(pg["id"])
        if not nid: continue
        if (pr.get("前置") or {}).get("has_more"): rep.append("relation truncated (has_more): " + nid)
        for r in pr["前置"]["relation"]:
            if r["id"] in pid: rel.add((pid[r["id"]], nid))
            else: rep.append("relation to page without ID skipped: %s <- %s" % (nid, r["id"]))
        for s in re.split(r"[,，;；\s]+", text(pr.get("前置IDs"))):
            if s:
                if s in nodes: txt.add((s, nid))
                else: rep.append("前置IDs entry is not a node ID, skipped: %s <- %s" % (nid, s))
    for e in sorted(rel - txt): rep.append("edge only in 前置 relation (missing in 前置IDs): %s --> %s" % e)
    for e in sorted(txt - rel): rep.append("edge only in 前置IDs text (missing in 前置 relation): %s --> %s" % e)
    edges = sorted((rel | txt) - {(a, a) for a, _ in rel | txt})
    bad = [n["cat"] for n in nodes.values() if n["cat"] not in cats]
    if bad: raise SystemExit("node with unknown/empty Category: %s" % bad[:3])
    def title(nid):
        t = labels.get(nid) or nodes[nid]["name"]
        return t.replace('"', "'").replace("\\", "/")
    used = {v["cat"] for v in nodes.values()}
    extra = [c for c in cats if c in used and c not in order]
    if extra: rep.append("categories not in category-order.json (appended): " + ", ".join(extra))
    cats = [c for c in order if c in used] + extra
    out = ["flowchart TD", 'subgraph Canvas["Canvas"]']
    for i, c in enumerate(cats, 1):
        out.append('subgraph cat_%02d["%s"]' % (i, c.replace('"', "'")))
        for nid in sorted(n for n, v in nodes.items() if v["cat"] == c):
            v = nodes[nid]
            cls = "project" if c == PROJECT_CATEGORY else STATUS_CLASS.get(v["status"], "unstarted")
            out.append('%s["%s"]:::%s' % (nid, title(nid), cls))
        out.append("end")
    out.append("end")
    out += ["%s --> %s" % e for e in edges]
    return "\n".join(out) + "\n", rep, len(nodes), len(edges)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "content-sources", "graph", "cs_knowledge_graph.mmd"))
    ap.add_argument("--category-order", default=os.path.join(ROOT, "content-sources", "graph", "category-order.json"))
    ap.add_argument("--labels", default=os.path.join(ROOT, "content-sources", "graph", "title-labels.json"))
    a = ap.parse_args()
    labels = json.load(open(a.labels, encoding="utf-8")) if os.path.exists(a.labels) else {}
    order = json.load(open(a.category_order, encoding="utf-8")) if os.path.exists(a.category_order) else []
    cats, pages = fetch()
    mmd, rep, n, e = build(cats, pages, labels, order)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8", newline="\n") as f: f.write(mmd)
    print("%d nodes, %d edges -> %s" % (n, e, a.out))
    for l in rep: print("REPORT:", l)


if __name__ == "__main__":
    main()
