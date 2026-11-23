# Group page (GROUP.md)

The page follows the group-page design prototype (v3); the map it embeds is described in `docs-dev/MAP.md`.
Code: `site/docs/.vitepress/theme/group/` (entry `theme/GroupIndex.vue`).

## 1. Parts

| File | Role |
|---|---|
| `GroupIndex.vue` | finds the group of the route (`themeConfig.groups`, or a restricted group's `frontmatter.groupMeta`), renders `GroupPage` |
| `group/GroupPage.vue` | state and rules: tracked / previewed lecture, batch, completion pulse, hash arrival, `STORAGE_KEYS.groupDesc` |
| `group/GroupTitleBlock.vue` | spec board 06 title block, spec rows 先修自 / 后续, 可开始 n 讲, continue / start buttons |
| `slots GroupMap` | group map (slot, see `SLOTS.md` section 11) |
| `group/LaneMap.vue` | Notion lanes of chips (links), lines for the tracked lecture (measured from the DOM) |
| `group/RelationPanel.vue` | preview / tracking panel: Notion fields, 说明, actions, relations |
| `group/model.ts` | pure: curriculum index, readiness, chains, roles, lanes, group links, edge paths, `#track-<id>` |
| `group/group.css` | shared layout (reader look); datasheet differences are in `themes/datasheet/theme.css` |

## 2. Data

`CurriculumLecture` (WP-H1 data) carries, when the lecture has a node in the graph file (`<content>/graph/graph.json`, in-place `site/data/graph.json`): `node`, `category` (Notion category title), and from
`graph-notion.json` next to it `desc`, `diff`, `min`, `url` (made by `scripts/importers/notion_props.py`, never run by the build). A missing file or node means the fields
are absent. The fields are the Chinese originals in every locale bucket, so English pages mark them `lang="zh-CN"`. They live inside the groups, so a restricted group's
fields are only in its tier file `/_access/<tier>/curriculum.<locale>.json`; the leak check (`curriculumNamesByTier`) searches the first 12 characters of every
restricted 说明 in the other tiers' output.

## 3. Behaviour

- Status: unread until the progress store is ready (equal to SSR). Ready (可开始) = unread, group has relation data, every prerequisite read, across groups too.
- Single click opens after the double-click window (`useClickRule`); double click or Space tracks; Esc or a click on the blank map leaves tracking or batch mode.
  The maps carry `vp-raw` because VitePress would otherwise navigate on the first click.
- Tracking marks direct relations (`data-role` `pre` / `post`), indirect ones (`pre2` / `post2`, same group only) and draws a line per direct relation.
- Panel item "追踪": same group = lock; other group = `<dir>/#track-<lecture id>`, locked on arrival (the chips have the ids `track-<id>`).
- Marking read / unread (panel, batch) goes through the store; lectures that just became ready pulse (`prefers-reduced-motion`: a static outline) and are named
  in the polite live region `[data-gp-live]`.
- 说明 open / closed: reader preference `lecture:group-desc` (`1` open, default; `0` closed); P6 adds the settings entry.

## 4. Themes

Same DOM, same layout. Reader: `group.css`. Datasheet: `theme.css` (ruled spec table, square chips, heavy rules), the DIP `GroupMap`, and `layout.edges: "orthogonal"`.

## 5. Tests

`tests/unit/group-model.test.ts`, `tests/unit/curriculum-data.test.ts` (Notion fields), `tests/unit/access-curriculum-names.test.ts` (说明 in the leak check),
`tests/e2e/group-page.spec.ts` (prototype checks, two skins, two baselines), `tests/e2e/access.spec.ts` (说明 only in its tier file).
