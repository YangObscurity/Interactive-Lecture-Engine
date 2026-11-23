"""scripts/content_paths.py — the Python side of site/docs/.vitepress/content/paths.mts (S2).

Same rule as the engine: LECTURE_CONTENT_DIR, else <repo>/content when it holds site.config.ts or groups.ts
(content mode), else the in-place layout. Only the paths the Python tools read or write are listed here.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


@dataclass(frozen=True)
class ContentPaths:
    mode: str  # 'content' | 'in-place'
    root: str
    groups: str
    lectures_dir: str  # sources; the build reads the copies under site/docs
    charts_dir: str
    graph: str
    graph_notion: str
    graph_bindings: str
    notion_knowledge_graph: str
    notion_source: str  # {"database": "<Notion database id>"} for the graph importers


def notion_database_id(paths: 'ContentPaths | None' = None) -> str:
    """NOTION_GRAPH_DB, else the "database" of <content>/graph/notion-source.json. Never hard-coded in the engine."""
    import json
    v = (os.environ.get('NOTION_GRAPH_DB') or '').strip()
    if v:
        return v
    p = (paths or resolve_content()).notion_source
    if os.path.exists(p):
        v = str(json.load(open(p, encoding='utf-8')).get('database') or '').strip()
    if not v:
        raise SystemExit(f'No Notion database id: set NOTION_GRAPH_DB or write {{"database": "<id>"}} to {p}')
    return v


def _is_content_root(d: str) -> bool:
    return any(os.path.exists(os.path.join(d, m)) for m in ('site.config.ts', 'groups.ts'))


def resolve_content(repo_root: str = REPO_ROOT, env: dict | None = None) -> ContentPaths:
    env = os.environ if env is None else env
    raw = (env.get('LECTURE_CONTENT_DIR') or '').strip()
    root = None
    if raw:
        root = raw if os.path.isabs(raw) else os.path.join(repo_root, raw)
    elif os.path.isdir(os.path.join(repo_root, 'content')) and _is_content_root(os.path.join(repo_root, 'content')):
        root = os.path.join(repo_root, 'content')
    if root:
        root = os.path.normpath(root)
        g = os.path.join(root, 'graph')
        return ContentPaths('content', root, os.path.join(root, 'groups.ts'), os.path.join(root, 'lectures'),
                            os.path.join(root, 'charts'), os.path.join(g, 'graph.json'), os.path.join(g, 'graph-notion.json'),
                            os.path.join(g, 'graph-bindings.json'), os.path.join(g, 'notion_knowledge_graph.json'),
                            os.path.join(g, 'notion-source.json'))
    site = os.path.join(repo_root, 'site')
    docs = os.path.join(site, 'docs')
    data = os.path.join(site, 'data')
    return ContentPaths('in-place', repo_root, os.path.join(docs, '.vitepress', 'groups.mts'), docs,
                        os.path.join(docs, 'public', 'charts'), os.path.join(data, 'graph.json'),
                        os.path.join(data, 'graph-notion.json'), os.path.join(data, 'graph-bindings.json'),
                        os.path.join(docs, 'public', 'notion_knowledge_graph.json'),
                        os.path.join(data, 'notion-source.json'))
