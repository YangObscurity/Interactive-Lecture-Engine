"""notion_props.py: read-only import of the Notion knowledge-graph fields the group page shows.

For every node of the knowledge-graph database it reads ID, 说明, Difficulty, 预估分钟 and 资料链接 and writes
site/data/graph-notion.json as {node id: {desc, diff, min, url}}. Token: NOTION_TOKEN in ~/.secrets/notion.env
(the same file scripts/notion_export_range.py uses); the token is never printed or written anywhere.
Run: python scripts/importers/notion_props.py   (4 requests for ~310 nodes)
"""
import json, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from content_paths import notion_database_id, resolve_content  # noqa: E402  (S2: content/graph/graph-notion.json in content mode)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DB = notion_database_id()  # NOTION_GRAPH_DB or <content>/graph/notion-source.json
PROPS = ["lcyn", "um%5D%5B", "f%7CTr", "RIxR", "sYGr"]  # ID, 说明, Difficulty, 预估分钟, 资料链接
ENV = os.path.join(os.path.expanduser("~"), ".secrets", "notion.env")
TOK = re.search(r"NOTION_TOKEN\s*=\s*(\S+)", open(ENV, "rb").read().decode("utf-8-sig", "replace")).group(1)

def query(cursor):
    body = {"page_size": 100}
    if cursor: body["start_cursor"] = cursor
    url = "https://api.notion.com/v1/databases/%s/query?%s" % (DB, "&".join("filter_properties=" + p for p in PROPS))
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + TOK, "Notion-Version": "2022-06-28", "Content-Type": "application/json"})
    for i in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
        except Exception as e:
            print("retry", i + 1, type(e).__name__); time.sleep(2 + 2 * i)
    raise SystemExit("query failed")

def text(p): return "".join(t.get("plain_text", "") for t in (p or {}).get("rich_text", []))
out, cur, pages = {}, None, 0
while True:
    r = query(cur); pages += 1
    for pg in r.get("results", []):
        pr = pg.get("properties", {})
        nid = text(pr.get("ID")).strip()
        if not nid: continue
        out[nid] = {"desc": text(pr.get("说明")).strip(), "diff": (pr.get("Difficulty") or {}).get("number"),
                    "min": (pr.get("预估分钟") or {}).get("number"), "url": (pr.get("资料链接") or {}).get("url")}
    if not r.get("has_more"): break
    cur = r["next_cursor"]
json.dump(dict(sorted(out.items())), open(resolve_content().graph_notion, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(pages, "requests,", len(out), "nodes,", sum(1 for v in out.values() if v["desc"]), "with 说明,",
      sum(1 for v in out.values() if v["diff"]), "with difficulty,", sum(1 for v in out.values() if v["min"]), "with minutes")
