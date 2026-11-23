# e2e demo content

The engine's own demo content in the content-mode layout (`npm run init`). The Playwright suites build and run on it
(`npm run build:e2e`, `LECTURE_CONTENT_DIR`), so they never depend on a site's own lectures. All text and figures are
original and generic; links go to example.com.

- 4 groups in 2 categories: MEA (6 lectures), LOG (3, translated into English), PLN (3), DAT (2)
- prerequisites (`requires:` and graph/graph.json): MEA L01-L04 chain with a branch L03 -> L05, cross-group edges
- progress seed (graph/notion_knowledge_graph.json): MEA-L01, MEA-L02, LOG-L01 completed, MEA-L03 in progress
- charts (echarts, mermaid, wavedrom), one SVG figure pack (figures/mea), three concepts
- access.e2e.json: the tiers the access project builds with (PLN authenticated, DAT user group staff)

It is also the engine's fallback content: with no `LECTURE_CONTENT_DIR` and no content root in `<repo>/content`, the
site (`npm run dev`, `npm run build`) shows this demo, so a fresh clone, a hosted demo and the tests show the same site.
`npm run init` still creates `<repo>/content`, which then takes over. `LECTURE_DEMO=0` turns the fallback off
(in-place mode, lectures under site/docs).

Check it with `LECTURE_CONTENT_DIR=templates/demo-content npm run check:content`.
