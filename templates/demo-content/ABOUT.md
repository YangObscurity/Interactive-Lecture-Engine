# e2e demo content

The engine's own demo content in the content-mode layout (`npm run init`). The Playwright suites build and run on it
(`npm run build:e2e`, `LECTURE_CONTENT_DIR`), so they never depend on a site's own lectures. All text and figures are
original and generic; links go to example.com.

- 9 groups, 46 lectures in 3 categories:
  - Foundations: MEA (6 lectures), LOG (5, translated into English), PRB (6), GEO (5)
  - Applications: PLN (5), DAT (5), VIS (5)
  - Methods: EXP (5), WRT (4)
- prerequisites (`requires:` and graph/graph.json, 46 nodes and 62 edges): chains inside every group plus cross-group
  edges (for example MEA -> PRB -> EXP, DAT -> VIS -> WRT); WRT L01 has no prerequisites
- progress seed (graph/notion_knowledge_graph.json): MEA-L01, MEA-L02, LOG-L01, PRB-L01, VIS-L01 completed,
  MEA-L03 and GEO-L01 in progress
- charts (echarts, mermaid, wavedrom), SVG figure packs, concept pages
- access.e2e.json: the tiers the access project builds with (PLN authenticated, DAT user group staff); the other
  groups are public

It is also the engine's fallback content: with no `LECTURE_CONTENT_DIR` and no content root in `<repo>/content`, the
site (`npm run dev`, `npm run build`) shows this demo, so a fresh clone, a hosted demo and the tests show the same site.
`npm run init` still creates `<repo>/content`, which then takes over. `LECTURE_DEMO=0` turns the fallback off
(in-place mode, lectures under site/docs).

Check it with `LECTURE_CONTENT_DIR=templates/demo-content npm run check:content`.
