# Dashboard (DASHBOARD.md)

The Lecture Engine Dashboard (`/dashboard`, `/en/dashboard`) serves as the central administrative and authoring interface (prototype v3.4, spec board §14.2).

## 1. Operating Modes

The Dashboard operates under two distinct modes:

1. **Local Author Mode (`vitepress dev`)**:
   - Runs against the dev server with full read and write capabilities.
   - All write operations are served by loopback-only middleware (`/__lecture/api/*`), protected by origin/host verification and a per-process session token (`x-lecture-dev-token`).
   - Content writes are atomic (`.tmp` write followed by rename).
   - If the site is viewing the engine's built-in demo content (`templates/demo-content`, `demo: true`), write endpoints answer `409 demo_read_only` with advice to run `npm run init`.

2. **Online Production Mode (`dist/` build)**:
   - Read-only interface for authenticated admins (checked via `/api/auth/session` roles).
   - Fetches data from `/api/admin/overview` and `/api/admin/health`.
   - Modifiable controls and savebars are replaced by read-only badges or unavailable explanations (`DbUnavailable`).

## 2. Access Page & `content/access.json`

The Access page (`/dashboard#access`, `PageAccess.vue`) displays and edits course group access tiers and gateway rules.

### 2.1 Configuration & Precedence

Access tiers follow a three-tier precedence model:
1. `LECTURE_ACCESS_JSON`: environment variable override (highest priority).
2. `content/access.json` (`site/access.json` in-place): file-based configuration taking precedence over TypeScript configuration files. Loaded with BOM/comment stripping and validation via `validateAccessConfig`.
3. `lecture.config.ts` / `site.config.ts`: fallback code configuration.

### 2.2 Interactive Features (Local Author Mode)

In local author mode (`writable && !demo`):
- **Tier Picker**:
  Select between four tiers for any course group:
  - `public`: Accessible to all visitors without signing in.
  - `login` (`authenticated`): Accessible to signed-in users.
  - `groups`: Accessible to specified gateway user groups (e.g. `staff`, `students`). When selected, an inline editor allows customizing the group list.
  - `admin`: Restricted to administrators and authors (`read: ['admin']`).
- **Bulk Action Bar (`.db-bulk`)**:
  - Row checkboxes on each group table row.
  - Header tri-state select-all checkbox (unselected / partial indeterminate / all selected).
  - Bulk action bar appears when groups are selected: displays selection count, "Clear selection", target tier picker, and "Set N groups" button to update drafts.
- **Impact Preview Panel**:
  - Live summary: indicates how many groups and lectures are affected by pending draft changes, noting that unpermitted readers will see the access gate screen.
  - Per-group breakdown showing source and target tiers.
- **Diff & Rule Previews**:
  - Line-by-line JSON diff preview comparing current saved configuration against the draft.
  - Gateway rule preview: displays Authelia `access_control.yml` configuration generated via `npm run auth:export`. When draft changes alter rules, a rule diff block highlights before/after modifications.
- **Savebar**:
  - "Discard": reverts all draft changes to saved baseline.
  - "Preview diff": toggles JSON diff preview.
  - "Apply access tiers": issues `POST /__lecture/api/access` to write `content/access.json`, updates saved baseline, and announces success via toast notification without full page reload.

### 2.3 Read-Only States

- **Online Mode**: Displays `dsh.ac.roBanner` informing that tiers cannot be edited on the public server.
- **Demo Mode**: Displays `dsh.ac.demoBanner` explaining that demo content is read only and `npm run init` should be used to establish a content repository.
