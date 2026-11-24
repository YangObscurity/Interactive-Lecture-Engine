# Gateway: nginx, Authelia and lecture-api

How a request reaches the site in production, which nginx location handles which path and why, how the identity headers travel, and how to switch the AI companion to plan B (all `/api/ai/*` traffic goes through lecture-api). Template: [`server/deploy/nginx-locations.conf`](../server/deploy/nginx-locations.conf). Check script: [`scripts/check_header_spoof.mjs`](../scripts/check_header_spoof.mjs).

## 1. Topology

```
browser
  -> nginx (TLS, WAF, limit_req, limit_conn)
       -> Authelia forward auth  (127.0.0.1:9091/api/verify, subrequest per protected location)
       -> lecture-api            (127.0.0.1:8100)  /api/db /api/admin /api/auth/session /api/health /api/ai
       -> legacy Python service  (127.0.0.1:8099)  /api/progress /api/notion /api/tool   (scripts/remote_server.py)
       -> static files           (webroot)         everything else
```

lecture-api listens on loopback only (`HOST=127.0.0.1`, enforced at startup when `AUTH_ADAPTER=trusted-header`). It trusts `Remote-User`, `Remote-Groups`, `Remote-Email`, `Remote-Name`, so **nothing but nginx may reach it**, and nginx must overwrite those four headers on every proxied location.

## 2. Locations and why

| Location | Backend | Auth | Notes |
|---|---|---|---|
| `/internal/authelia/authz` | Authelia | internal | forward-auth subrequest, HEAD, sends `X-Original-URL` so Authelia rules see the real path |
| `/api/db/` | 8100 | `auth_request` | progress, sessions, messages, checklists; body 512k |
| `/api/admin/` | 8100 | `auth_request` | admin/author Dashboard APIs; `requireAdminOrAuthor` opens content endpoints to `author`/`admin` and `requireStrictAdmin` restricts system/site routes to `admin`; Authelia rules also protect `/api/admin/` |
| `= /api/auth/session` | 8100 | `auth_request` | session discovery. On a site with public content the Authelia rule is `bypass`, so anonymous visitors get 200 with no identity headers and the app answers the anonymous shape. On a login-only site (production) it stays behind login like every page: nobody reaches the front end without a session |
| `= /api/health` | 8100 | off | public; all identity headers blanked |
| `/api/ai/` | 8100 | `auth_request` | chat (SSE): `proxy_buffering off`, `X-Accel-Buffering: no`, `proxy_read_timeout 330s`, body 64k, `limit_req` zone `lecture_ai` on top of the site zone `docslimit` |
| `= /api/ai/upload` | 8100 | `auth_request` | same, body 20m (the app also caps at `AI_UPLOAD_MAX_BYTES`, default 20 MB) |
| `/api/tools/` | 8100 | `auth_request` | read-only AI tools REST mirror for browser BYOK; identity headers overwritten from Authelia (`$auth_*`), body 64k |
| `= /api/mcp` | 8100 | off | stateless MCP endpoint for Dify (`proxy_buffering off`, `client_max_body_size 256k`, identity headers blanked); `lecture-api` verifies `Authorization: Bearer <AI_MCP_TOKEN>` in constant time and derives tiers from signed `tool_ticket` |
| `/api/progress/`, `/api/notion/` | 8099 | `auth_request` | legacy Notion sync; identity headers overwritten; **admin-only** through the Authelia rules (it writes the owner's Notion) |
| `/api/tool/` | 8099 | off | Dify custom tool endpoint; static token checked in nginx, token kept in an include file outside the repo |
| `~ ^/(?:_access/[^/]+/)?tools/` | - | - | `return 404`: AI tool data (`tools/*.json`, `_access/<tier>/tools/*.json`) is read by lecture-api from disk (`SITE_DIST_DIR`), never by browsers |
| `/` | static | `auth_request` | 401 becomes a 302 to the Authelia portal |

Rule for every location that proxies to 8100 or 8099: all four `Remote-*` headers are set, from `auth_request_set` variables (Authelia's answer) or to `""`. The other gateway presets (`X-Forwarded-User`, `X-authentik-*`, `X-Auth-Request-*`) are blanked too. `server/tests/unit/nginx-template.test.ts` fails when a proxying location misses one of the four, misses `auth_request` (allow-list: `= /api/health`, `/api/tool/`, `= /api/mcp`), or when `/api/ai/` or `/api/mcp` lacks `proxy_buffering off`.

The template has two marked sections: HTTP-LEVEL (`upstream` blocks and `limit_req_zone`, belong in `http { }`) and SERVER-LEVEL (belongs inside the site's `server { }`). `limit_req_zone ... zone=docslimit` and `limit_conn_zone` for `docsconn` already exist on the production site and are not repeated.

## 3. Identity header flow

1. The browser sends a request, possibly with forged `Remote-User` / `Remote-Groups: admins`.
2. nginx calls Authelia (`auth_request`). A logged-in user gets 200 plus `Remote-User/Groups/Email/Name` response headers; an anonymous visitor gets 401 (or 200 without headers on a `bypass` path).
3. `auth_request_set` copies Authelia's headers into variables; `proxy_set_header Remote-User $auth_user;` etc. **replace** whatever the client sent. An empty value removes the header.
4. lecture-api reads the four headers (`AUTH_HEADER_PRESET=authelia`), maps groups to roles with `AUTH_ROLE_MAP` (for example `admins:admin`), and `requireAdmin` guards `/api/admin/*`.

If a location forgets step 3, a logged-in non-admin can send `Remote-Groups: admins` and become admin. That is what `check_header_spoof.mjs` looks for.

## 4. Authelia rules

Generate them from the site's access config; do not hand-write:

```bash
cd site
npm run auth:export authelia -- --domain docs.example.com --admin-groups admins --factor two_factor > /tmp/rules.yml
npm run auth:export -- --format nginx > /tmp/nginx-snippet.conf   # embeds the template sections
```

`--domain` is required (Authelia rejects rules without `domain`). `--factor` sets the level of every non-public rule; the default is `two_factor`, which is what production uses (`one_factor` only if the site really wants password-only logins). Output order:

1. `bypass`: `/api/health`, `/api/tool/`, `/api/mcp` (`^/api/mcp$`), plus `/api/auth/session` when the site has public content.
2. admin only (one subject per line so groups are OR): `/dashboard` (and localized), `/api/admin/`, `/api/progress/`, `/api/notion/`, **followed by a `deny` rule for the same resources**.
3. restricted group tiers (each followed by its own `deny`), restricted authenticated tiers, explicit public groups.
4. `/api/db/`, `/api/ai/`, `/api/tools/`: any logged-in user.
5. catch-all for the site default tier.

Why the `deny` rules: Authelia applies the first rule whose criteria all match, and `subject` is one of the criteria. A user outside the subject does not match the admin rule and falls through to the next one; without the `deny` the catch-all would let every logged-in user into `/api/progress/` (the legacy service has no check of its own). Check a real account with `authelia access-control check-policy --config <file> --url https://<site>/api/progress/health --username <non-admin> --groups <their groups>`: the result must be `deny`.

Merge the `access_control` fragment into the Authelia configuration, then validate before restarting: `authelia validate-config --config <file>` (run it where Authelia is installed; the file has no secrets).

## 5. Plan B switch (main agent, on HK)

Today nginx sends `/api/ai/chat` and `/api/ai/upload` straight to `api.dify.ai` with the Dify key inside nginx, so lecture-api's AI proxy is unused and users are not limited. After the switch `/api/ai/*` goes to lecture-api, which holds the key, limits each user and stores nothing about prompts in logs. Deploy it together with the front-end package that defaults the companion to the `proxy` adapter and shows SSE `error` events (F2).

1. **Back up**: the pglite data directory, `/etc/nginx/sites-available/<site>` (and the Authelia config), the current webroot.
2. **Deploy lecture-api** (`server/`: `npm ci && npm run build`), then set in its `.env`:
   - `AUTH_ADAPTER=trusted-header`, `AUTH_HEADER_PRESET=authelia`, `HOST=127.0.0.1`
   - `AUTH_ROLE_MAP=<admin group>:admin` (for example `admins:admin`)
   - `AI_PROVIDER=dify`, `DIFY_API_KEY=<the key now in nginx>`, `DIFY_API_BASE=https://api.dify.ai/v1`
   - `AI_PROMPTS_FILE` (optional): path to `companion.json` exported with the site build (defaults to `./prompts/companion.json`, then `../site/prompts/companion.json` and `../site/docs/.vitepress/dist/prompts/companion.json`). Under Plan B, `lecture-api` prepends the versioned `[Site Instructions v<n>]` block (and optional quick-action template) to Dify `query` while keeping the 4-key `inputs` whitelist intact (`current_lecture`, `group`, `outline`, `selection`). **Operator note & limits**: keep the Dify console app prompt blank or neutral so it does not conflict with site instructions, and account for prompt + template overhead (~1–6 KB) in Dify's app query limits alongside nginx `client_max_body_size 64k` (`AI_QUERY_MAX_BYTES=8192` only bounds the client's question). **Public by design**: `dist/prompts/companion.json` (written by `buildEnd`, only so a standalone lecture-api can read the same file) holds the system prompt and the quick actions, no secrets; it is served as a static file like any other asset, and the same text is bundled into the site JS for BYOK. `check:access:dist` scans it with every other text file, so a restricted title written into a prompt fails the gate. The reader can send only `query`, `action`, `lang` and the four `inputs`; `action`/`lang` are validated (unknown or disabled action, invalid `lang` -> 400), the selection is capped at 16 KiB, and the access log records `prompt_version`, never the text.
   - optional tuning (defaults: `AI_RATE_PER_MINUTE=20`, `AI_MAX_CONCURRENT=2`, `AI_DAILY_LIMIT=300`, `WRITE_RATE_PER_MINUTE=120`, `AI_UPLOAD_MAX_BYTES=20971520`, `AI_QUERY_MAX_BYTES=8192`, `AI_INPUTS_MAX_BYTES=32768`). The daily cap counts readers only: a session whose groups map to `author` or `admin` in `AUTH_ROLE_MAP` is not counted toward it (the per-minute rate and the concurrency cap still apply).
   - leave `AI_ALLOW_ANONYMOUS` unset.
   Run `npm run db:status`, restart the service (`systemctl restart lecture-api`) and check `curl -s http://127.0.0.1:8100/api/health` (it shows `checks.ai: "ok"` once configured; `aiLastCall` appears after the first real call).
3. **Authelia**: generate the rules (section 4) and merge them into the existing `access_control`: keep the rules for other domains (for example the Authelia portal's own `bypass`) and `default_policy`, and replace only the rules for this site's domain. `authelia validate-config`, then `authelia access-control check-policy` for an admin and a non-admin account on `/api/progress/health` (allow / deny), then restart Authelia. This step makes `/api/progress/` and `/api/notion/` admin-only and keeps `/api/tool/` reachable.
4. **nginx**:
   - `http { }`: add the template's HTTP-LEVEL section (`upstream lecture_api_backend` already exists on the site: keep one copy; add `upstream lecture_legacy_backend` and `limit_req_zone ... zone=lecture_ai`).
   - `server { }`: replace the `/api/ai/chat` and `/api/ai/upload` blocks (the ones with `proxy_pass https://api.dify.ai/...` and the `Authorization: Bearer ...` line) with the template's `/api/ai/` and `= /api/ai/upload`; replace `/api/progress/` and add `/api/notion/` from the template; keep the `/api/tool/` behaviour but move its token into `/etc/nginx/secrets/lecture-tool-token.conf` (shape in the template, `chmod 640`, outside the repo) and `include` it.
   - `nginx -t && systemctl reload nginx`.
5. **Header-spoof check**: `node scripts/check_header_spoof.mjs https://<site>` (anonymous), and again with `--cookie "<session cookie of a non-admin account>"`. Expect no FAIL row. Also check `curl -i https://<site>/api/progress/health` is 401/302 anonymous and 403 for a non-admin.
6. **Smoke**: one chat message and one upload in the browser; `journalctl -u lecture-api | grep ai_call` shows one JSON line per call (hashed user, status, bytes, ms; no prompt text).
7. **Remove the Dify key** from the old nginx blocks (already gone if step 4 replaced them) and consider rotating it, since it lived in nginx config.

**Rollback**: restore the backed-up nginx site file (the Dify-direct `/api/ai/chat` and `/api/ai/upload` blocks) and Authelia config, `nginx -t && systemctl reload nginx`, restart Authelia. lecture-api can keep running; it is not reachable for `/api/ai/*` once nginx points elsewhere. The front end then needs its previous adapter (or the Dify-direct one) because it expects no SSE `error` event from Dify.

## 6. What stays on the legacy service (8099)

`scripts/remote_server.py` keeps: `/api/progress/notion-sync`, `notion-batch-sync`, `notion-pull`, `health` (Notion progress sync for the owner's workspace), `POST /api/notion/sync-status` (no nginx location existed before; the template adds `/api/notion/`), and `/api/tool/*` (lecture retrieval for Dify). It does not read the identity headers and writes the owner's Notion, so access is limited at the gateway: admin-only through the Authelia rules, headers overwritten by nginx, `/api/tool/` guarded by its static token. Note lecture-api also mounts `/api/progress` as an alias of `/api/db/progress`; behind this template `/api/progress/` never reaches it (nginx sends it to 8099).

## 7. Limits at a glance

| Layer | Limit |
|---|---|
| nginx site | `limit_req zone=docslimit burst=40`, `client_max_body_size 1k` default, per-location overrides |
| nginx AI | `limit_req zone=lecture_ai burst=5` (30 r/min per IP), chat body 64k, upload 20m |
| lecture-api AI (per user) | 20/min, 2 concurrent streams, 300/day, 1 concurrent upload, query 8 KB, inputs 32 KB, stream cap 300 s |
| lecture-api writes (per user) | 120/min on `/api/db/*`, `/api/progress/*` |

The per-user counters are in memory (single process, reset on restart). With `AUTH_ADAPTER=none` all visitors share the user `anonymous`: AI routes answer 403 unless `AI_ALLOW_ANONYMOUS=true`, and the write limit is skipped.

## 8. Hybrid Adapter, WebAuthn & Role-Scoped Routes (WP-2 & WP-4)

When deploying with `AUTH_ADAPTER=hybrid`:

### 8.1 Dual-Authentication Flow
1. **Primary Gateway Pass-Through**: `lecture-api` inspects `Remote-User`, `Remote-Groups`, `Remote-Email`, and `Remote-Name` supplied by the reverse proxy (e.g. Authelia, Authentik). If present, the user is authenticated directly (`authSource: 'gateway'`) and roles are mapped via `AUTH_ROLE_MAP`.
2. **Fallback Local Session**: When gateway headers are absent or empty (e.g. direct access or standalone deployment), `lecture-api` falls back to its local cookie session store (`authSource: 'cookie'`), allowing login via local password or WebAuthn Passkey.

### 8.2 Session Lifetimes & Remember Me
- `SESSION_TTL_HOURS`: Governs server session expiration (default: 12 hours).
- **Persistent Cookie vs Session Cookie**:
  - When `rememberMe: true` is passed to `/api/auth/login` or Passkey verification, `lecture-api` issues a persistent cookie with `Max-Age=2592000` (30 days).
  - Otherwise, an ephemeral session cookie is issued without `Max-Age`, clearing when the browser terminates.

### 8.3 WebAuthn Configuration
- `WEBAUTHN_RP_ID`: Relying party domain identifier (e.g. `docs.example.com` or `localhost`).
- `WEBAUTHN_RP_NAME`: Display name of the application (e.g. `Lecture Platform`).
- `WEBAUTHN_ORIGIN`: Exact origin URL expected for WebAuthn ceremony validation (e.g. `https://docs.example.com`).

### 8.4 Role-Scoped Route Separation
- `/api/me/*`: Reader self-service endpoints (reading KPIs, lecture progress export, password changes, WebAuthn Passkey registration/deletion, session listing and revocation). Accessible to any authenticated user (`reader`, `author`, `admin`).
- `/api/admin/*`: Guarded at the router boundary by `requireAdminOrAuthor`. Authoring endpoints (`/overview`, `/checks`, `/figures`, `/texts`, `/companion`) accept `author` or `admin`; system and site-level admin endpoints (`/health`, `/ai-tools`, `/users`, `/access`, `/look`, `/runtime`, `/logs`, `/backups`, `/db`, `/settings`) enforce `requireStrictAdmin` (`admin` role only).
