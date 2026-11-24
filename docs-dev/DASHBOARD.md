# Dashboard (DASHBOARD.md)

The Lecture Engine Dashboard (`/dashboard`, `/en/dashboard`) serves as the central administrative, authoring, and personal learning interface (prototype v3.4, spec board §14.2, WP-1..WP-5).

---

## 1. Operating Modes & Architecture

The Dashboard operates under two distinct environments:

1. **Local Author Mode (`vitepress dev`)**:
   - Runs against the local VitePress dev server with full read and write capabilities.
   - All write operations are handled by loopback middleware (`/__lecture/api/*`), protected by origin/host verification and a per-process session token (`x-lecture-dev-token`).
   - Content writes are atomic (`.tmp` write followed by rename).
   - If the site is viewing the engine's built-in demo content (`templates/demo-content`, `demo: true`), write endpoints answer `409 demo_read_only` with advice to run `npm run init`.

2. **Online Production Mode (`dist/` build backed by `lecture-api`)**:
   - Online Dashboard is **not read-only**. Authenticated users interact with `lecture-api` via role-scoped endpoints (`/api/me/*` and `/api/admin/*`).
   - Role-Based Access Control (RBAC) dynamically scopes navigation, read/write permissions, and available features based on the signed-in user's roles (`reader`, `author`, `admin`).
   - Modifiable site settings and content configurations persist to the PostgreSQL/PGlite database (`site_settings`), sync back to `CONTENT_DIR` when available, and trigger non-blocking `rebuild_required` notices when static rebuilding is required.

---

## 2. Navigation Structure & RBAC Matrix

The Dashboard organizes its 13 pages across 5 logical navigation groups:

| Group | Nav Header | Pages | Description |
|---|---|---|---|
| **Personal** | `dsh.nav.gPersonal` | `my-learning`, `account` | Learning KPIs, reading history, export, password, Passkeys, sessions |
| **Overview** | *(Top / None)* | `overview` | System health summary, checklist status, content highlights |
| **Content** | `dsh.nav.gContent` | `checks`, `figures`, `texts`, `companion` | Contract checks, figures catalog, site texts editor, AI tools & prompts |
| **Site** | `dsh.nav.gSite` | `access`, `look` | Access tier manager, appearance tints, skin & theme config |
| **System** | `dsh.nav.gSystem` | `database`, `users`, `runtime`, `backup` | DB engine hot-swap & CRUD, user roles, process logs/health, backups |

### RBAC Permission Matrix

| Role | Visible Navigation Pages | Personal Features (`/api/me/*`) | Content / Site Management | System Admin (`/api/admin/*`) | Readonly Flag |
|---|---|---|---|---|---|
| **`reader`** | `my-learning`, `account` | Read/write personal progress, credentials, passkeys, sessions | ❌ Blocked | ❌ Blocked (0 admin calls) | `data-dashboard-readonly="0"` on personal pages |
| **`author`** | `my-learning`, `account`, `overview`, `checks`, `figures`, `texts`, `companion` | Read/write personal progress and credentials | Read/write checks, texts, companion prompts; read-only overview & figures | ❌ Blocked (`#access`, `#look`, `#database`, `#users`, `#runtime`, `#backup`, `ai-tools`) | `data-dashboard-readonly="0"` on allowed pages |
| **`admin`** | All 13 pages | Full personal access | Full authoring & site config access (tools switches via `/api/admin/ai-tools`) | Full access (DB manager, users, health, backups) | `data-dashboard-readonly="0"` |

- **Security Enforcement**: Unauthorized direct hash changes (e.g. reader entering `#database`, `#users`, `#overview`) are blocked on `hashchange`, redirecting immediately to `my-learning` (or default landing page) while presenting a localized forbidden toast notification (`dsh.nav.forbiddenPage`).
- **Header Lockline**: The read-only banner (`data-dashboard-lockline`) in `DbHead.vue` checks per-page write permissions (`canWritePage`) and is not displayed for authorized online writers/admins.

---

## 3. Authentication & Login Lifecycle (`DashboardLogin.vue`)

When unauthenticated in online mode, the Dashboard renders the integrated `DashboardLogin.vue` component with multiple authentication mechanisms:

1. **Local Password Authentication**:
   - First-time initialization via bootstrap administrator creation (`/api/auth/bootstrap`).
   - Secure login (`/api/auth/login`) supporting a 30-day persistent cookie (`Max-Age=2592000`, `rememberMe = true`) or standard session cookie (`rememberMe = false`).
2. **WebAuthn Passkey Support**:
   - Modern passwordless authentication utilizing browser credentials API and `@simplewebauthn/browser`.
   - Challenge/response handshake through `/api/auth/methods/passkey/login/start` and `/api/auth/methods/passkey/login/finish`.
   - Self-service Passkey registration and revocation in `PageAccount.vue` (`/api/me/credentials`).
3. **Extensible Method Registry**:
   - `fetchAuthMethods()` queries `/api/auth/methods` and displays supported authentication providers dynamically.
4. **Hybrid Gateway Bypass (`AUTH_ADAPTER=hybrid`)**:
   - When deployed behind reverse-proxy authentication (e.g. Authelia, Authentik), gateway headers (`Remote-User`, `Remote-Groups`, `Remote-Email`, `Remote-Name`) authenticate the visitor automatically (`authSource: 'gateway'`).
   - If gateway headers are present, `DashboardPage` lands directly in the authorized interface without prompting for credentials.

---

## 4. Database Engine Manager & Whitelisted CRUD (`PageDatabase.vue`)

Online administrators have complete control over the underlying database architecture via `PageDatabase.vue`:

1. **Engine Selector & Hot-Swap**:
   - Dynamic switching between embedded **PGlite** (`pglite:./data/pglite`) and remote **Neon Postgres** connection strings.
   - Connection validation and latency probe (`POST /api/admin/db/test`).
   - Dry-run migration preview displaying generated SQL DDL statements without executing changes.
   - Confirmed engine switch (`POST /api/admin/db/switch`) with schema migration.
2. **Cross-Engine Data Transfer**:
   - Transfer data between local and remote engines (`POST /api/admin/db/transfer`).
   - Dry-run inspection showing source, target, and transferred record counts across all application tables.
3. **Whitelisted 6-Table Browser & Editor**:
   - Direct record browsing and CRUD editing for application tables:
     - `site_settings`: Global configuration overrides and runtime parameters.
     - `progress`: User lecture reading progress and completion states.
     - `ai_sessions`: AI companion conversations and context bindings.
     - `ai_messages`: AI conversation messages linked to `ai_sessions`.
     - `ai_review_checklists`: Learner review checklist items.
     - `auth_users`: User directory (public columns only, never `password_hash`), roles, and disabled status.

---

## 5. Online Persistence & Non-Blocking Rebuild Notices

When administrators or authors update site settings online (e.g. modifying `PageTexts.vue` via `PUT /api/admin/texts`, `PageAccess.vue` via `PUT /api/admin/access`, or `PageLook.vue` via `PUT /api/admin/look`):

1. **Database & Disk Sync**:
   - Changes are immediately saved to the `site_settings` table (and audited in `site_settings_history`) in the active database.
   - If the server has write access to `CONTENT_DIR`, updates are synchronized to corresponding configuration files (`content/access.json`, `content/site-texts.json`, DTCG `content/theme.json`, `content/prompts/companion.json`, `content/ai-tools.json`).
2. **Non-Blocking Rebuild Notification**:
   - If an applied change alters static build inputs (access tiers, site texts, or default theme/look), the response returns `persistence: { mode: 'db+disk' | 'db', effect: 'rebuild_required', rebuildReason: '...' }`.
   - The Dashboard displays a non-blocking notification badge (`[data-dashboard-rebuild-badge]`) informing administrators that changes are persisted and will reflect in static HTML/bundles after the next `npm run build`.
   - Administrators can dismiss the banner at any time (`[data-dashboard-rebuild-dismiss]`) without obstructing their workflow.

---

## 6. Online Backup & Restore Verification (`PageBackup.vue`)

`PageBackup.vue` provides end-to-end database snapshotting and integrity rehearsal:

1. **Backup Facts & Documentation**:
   - Preserves offline documentation guidelines (`docs-dev/BACKUP.md`, `npm run db:backup` / `npm run db:restore`).
2. **Online Archive Management (Admin Only)**:
   - **Archive Listing**: Automatically queries `/api/admin/backups` on mount, displaying archive directory path (`backupDir`), snapshot table (`filename`, formatted size, 8-character short SHA-256 checksum, creation timestamp via `shortDateTime`), and empty states.
   - **Create Backup**: Button (`data-backup-create`) calls `POST /api/admin/backups`, generates a logical `.json.gz` snapshot along with a `.sha256` checksum file, presents creation details, and refreshes the snapshot list.
   - **Dry-Run Verify**: Button (`:data-backup-dryrun="filename"`) calls `/api/admin/backups/restore` with `dryRun: true`, validating file existence, SHA-256 hash match, gzip decompression, and table record counts without altering data.
   - **2-Step Confirmed Restore**: Button (`:data-backup-restore="filename"`) reveals an inline confirmation dialog (`data-backup-restore-confirm`) before allowing execution of `POST /api/admin/backups/restore` (`:data-backup-confirm-restore="filename"` with `dryRun: false`).
   - **Verification Results**: Panel (`data-backup-result`) displays filename, checksum status, operation mode, table count summary, and honest server verification message.
