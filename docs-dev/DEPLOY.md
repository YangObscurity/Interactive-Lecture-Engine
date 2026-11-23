# Production Deployment Guide (Self-Hosting)

Guide for setting up and running the lecture site and its backend API (`lecture-api`) on a clean Linux host (Ubuntu 22.04 / 24.04 LTS or Debian 12 recommended).

For gateway routing, nginx location snippets, and Authelia access control rules, refer directly to [`GATEWAY.md`](./GATEWAY.md).

---

## 1. System Requirements & Preparation

- **Operating System**: Linux x86_64 or aarch64 (systemd enabled).
- **RAM**: Minimum 1 GB RAM (lecture-api Node process capped at 384 MB heap, 512 MB cgroup limit).
- **Node.js**: Node.js >= 20.x LTS (tested on Node v20/v22).
- **Dependencies**: `curl`, `git`, `tar`, `nginx`, `openssh-client`.

```bash
# 1. Install Node.js 22 LTS (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs nginx

# 2. Create unprivileged system user for the backend service
sudo useradd -r -s /usr/sbin/nologin -d /opt/lecture-api -m lecture-api

# 3. Create required production directories
sudo mkdir -p /opt/lecture-api/server/data /opt/lecture-api/server/backups /var/backups/lecture-site
sudo chown -R lecture-api:lecture-api /opt/lecture-api
sudo chmod 700 /opt/lecture-api/server/data /opt/lecture-api/server/backups /var/backups/lecture-site
```

---

## 2. Backend Setup (`lecture-api`)

The backend service lives in `server/`. It runs a Hono-based Node.js daemon using an embedded PGlite database (or external PostgreSQL).

```bash
# 1. Place repository code in /opt/lecture-api/server
sudo -u lecture-api git clone <repo-url> /opt/lecture-api/repo
sudo -u lecture-api cp -a /opt/lecture-api/repo/server/. /opt/lecture-api/server/
cd /opt/lecture-api/server

# 2. Install production dependencies and build TypeScript
sudo -u lecture-api npm ci
sudo -u lecture-api npm run build

# 3. Configure environment (.env)
sudo -u lecture-api cp .env.example .env
sudo -u lecture-api chmod 600 .env
```

Edit `/opt/lecture-api/server/.env`:

```env
# Database configuration (PGlite directory)
DATABASE_URL=pglite:./data/pglite-db

# Network binding: loopback only (strictly required for trusted-header)
HOST=127.0.0.1
PORT=8100

# Authentication: trusted-header behind Authelia forward-auth
AUTH_ADAPTER=trusted-header
AUTH_HEADER_PRESET=authelia
AUTH_HEADER_USER=Remote-User
AUTH_HEADER_GROUPS=Remote-Groups
AUTH_ROLE_MAP=admins:admin

# AI Companion settings (Plan B proxy)
AI_PROVIDER=dify
DIFY_API_BASE=https://api.dify.ai/v1
DIFY_API_KEY=app-yourDifyApiKey
# Path to the site-exported prompts/companion.json (or place at /opt/lecture-api/server/prompts/companion.json)
AI_PROMPTS_FILE=prompts/companion.json
AI_RATE_PER_MINUTE=20
AI_MAX_CONCURRENT=2
AI_DAILY_LIMIT=300

# AI Tool Layer & MCP (WP-K2)
# Directory containing built tools/tiers.json, concepts.json, lectures.json (defaults to ../site/docs/.vitepress/dist)
SITE_DIST_DIR=../site/docs/.vitepress/dist
# Optional external MCP & tool enablement config (defaults via content/paths.mts or site/ai-tools.json)
# AI_TOOLS_FILE=ai-tools.json
AI_TOOL_TIMEOUT_MS=8000
AI_TOOL_MAX_RESULT_BYTES=24000
AI_TOOL_MAX_STEPS=5
# Dify MCP server bearer auth + short-lived tier ticket HMAC secret
# AI_MCP_TOKEN=<strong-random-bearer-token>
# AI_MCP_TICKET_SECRET=<strong-random-hmac-secret>
```

### Connecting Dify to `/api/mcp` (6 steps)

After deploying `lecture-api`, configuring `AI_MCP_TOKEN` and `AI_MCP_TICKET_SECRET`, and reloading nginx + Authelia rules (see [`GATEWAY.md`](./GATEWAY.md)):

1. In Dify console, open **Tools › MCP** and click **Add MCP Server** pointing to `https://<site>/api/mcp`.
2. Add the request header `Authorization: Bearer <AI_MCP_TOKEN>` matching `AI_MCP_TOKEN` in `server/.env`.
3. Open your companion application in Dify and attach the five discovered tools (`search_concepts`, `get_concept`, `get_concept_graph`, `search_lectures`, `get_lecture_summary`).
4. In the companion app's **Variables** panel, add an input variable named `tool_ticket` (string). On every `/api/ai/chat` call, `lecture-api` strips any client-supplied value and injects a freshly signed 10-minute ticket carrying the caller's readable tiers.
5. In the companion app's system prompt, instruct the model: whenever it invokes any of the five lecture/concept tools, always pass `ticket={{tool_ticket}}`.
6. Test in the companion UI with a concept/lecture question and confirm `lecture-api` logs one structured `ai_tool_call` JSON line per tool call (and that an anonymous/public user cannot retrieve staff-only content).

Initialize schema migrations:

```bash
sudo -u lecture-api npm run db:migrate
# Check migration status
sudo -u lecture-api npm run db:status
```

(Optional) Import the owner's reading progress from `notion_knowledge_graph.json`. On PGlite the API must be stopped while this runs (one process per data directory):

```bash
sudo systemctl stop lecture-api
# Preview (dry-run is the default; prints new / changed / unchanged counts and a diff)
sudo -u lecture-api npm run db:import-progress -- --user-id <your-user-id>
# Write; a second --apply changes nothing
sudo -u lecture-api npm run db:import-progress -- --user-id <your-user-id> --apply
# List progress rows whose lecture is not in the current curriculum; delete them only with --prune
sudo -u lecture-api npm run db:import-progress -- --user-id <your-user-id> --reconcile
sudo -u lecture-api npm run db:import-progress -- --user-id <your-user-id> --reconcile --prune
sudo systemctl start lecture-api
```

Options: `--file <json>` (default `site/docs/public/notion_knowledge_graph.json`), `--curriculum <file>` (JSON graph or one lecture id per line; default: the graph file, `site/data/graph.json` and the `l<NN>.md` pages under `site/docs`), `--include-unstarted`. Status mapping: `已完成` / `completed` / `done` become `已完成`; `学习中` / `in_progress` / `reading` become `学习中`; `未开始` / `not_started` / `todo` become `未开始` and are skipped unless `--include-unstarted` is given. Unknown statuses are skipped and counted as invalid. Without `--include-unstarted` the import never lowers an existing row to `未开始`.

---

## 3. Systemd Units Installation

Install the API service unit and the daily backup timer:

```bash
# Copy unit files from repository deploy folder
sudo cp /opt/lecture-api/server/deploy/lecture-api.service /etc/systemd/system/
sudo cp /opt/lecture-api/server/deploy/lecture-api-backup.service /etc/systemd/system/
sudo cp /opt/lecture-api/server/deploy/lecture-api-backup.timer /etc/systemd/system/

# Reload systemd daemon
sudo systemctl daemon-reload

# Enable and start services
sudo systemctl enable --now lecture-api.service
sudo systemctl enable --now lecture-api-backup.timer
```

Verify service status:

```bash
sudo systemctl status lecture-api.service
sudo systemctl status lecture-api-backup.timer
```

The service runs under strict sandbox isolation (`ProtectSystem=strict`, `ProtectHome=true`, `MemoryMax=512M`, `TasksMax=64`) with write permission explicitly allowed for `/opt/lecture-api/server/data` only; the backup unit additionally writes `/opt/lecture-api/server/backups`. Both directories must exist before the units start (step 1 creates them).

The backup unit stops `lecture-api` while it dumps (PGlite is single-process) and starts it again afterwards, through root-run `ExecStartPre=+` and `ExecStopPost=+`; see [`BACKUP.md`](./BACKUP.md).

---

## 4. Gateway & Reverse Proxy (nginx + Authelia)

Do not expose `lecture-api` directly to the public internet. It must be proxied through nginx behind Authelia forward-auth.

- Full nginx configuration, location blocks, identity header overwriting, and Authelia export commands are documented in [`GATEWAY.md`](./GATEWAY.md).
- To generate Authelia rules and nginx snippets from current site config:
  ```bash
  cd site
  npm run auth:export authelia -- --domain docs.example.com --admin-groups admins > /tmp/authelia-rules.yml
  npm run auth:export -- --format nginx > /tmp/nginx-locations.conf
  ```
- Test nginx configuration and reload:
  ```bash
  sudo nginx -t && sudo systemctl reload nginx
  ```

---

## 5. Deploying the Static Site

The VitePress frontend (`site/`) is built on the deployment machine (or CI runner) and uploaded using the atomic deployment scripts.

```bash
# 1. On build machine: build static production assets (also writes dist/prompts/companion.json)
cd site
npm run build

# Copy the built prompts file to lecture-api if running standalone outside the monorepo
sudo -u lecture-api mkdir -p /opt/lecture-api/server/prompts
sudo -u lecture-api cp site/docs/.vitepress/dist/prompts/companion.json /opt/lecture-api/server/prompts/companion.json

# 2. Deploy to production webroot via SSH
# Using paramiko-based deployment script (strict host key verification):
python scripts/deploy_dist.py --local site/docs/.vitepress/dist

# Or using OpenSSH CLI script (no paramiko required):
python scripts/deploy_dist_cli.py --local site/docs/.vitepress/dist --key ~/.ssh/id_ed25519
```

Deployment guarantees:
- **Atomic switch**: The existing live directory is renamed aside and the staged directory is renamed into place (two renames, sub-second gap); if the second rename fails the previous site is restored and the script aborts with an error.
- **Host keys**: connections use `RejectPolicy` (or `StrictHostKeyChecking=yes` for the CLI script). Add the host once with `ssh-keyscan -p <port> <host> >> ~/.ssh/known_hosts` and check the fingerprint against your provider's console first.
- **Backups**: Previous deployments are backed up to `/var/backups/lecture-site/docs.bak.<timestamp>` with `0700` permissions (outside the nginx web root; nginx cannot serve them). Latest 3 versions are retained.

---

## 6. Verification and Health Checks

After deployment, perform health checks:

1. **Local API Health Check**:
   ```bash
   curl -s http://127.0.0.1:8100/api/health | jq .
   ```
   Expect `"ok": true` and `"checks": {"db": "ok", ...}` (`ai` and `notion` may read `off`).

2. **Public Gateway Check**:
   ```bash
   curl -i https://docs.example.com/api/health
   ```
   Expect `200 OK` without requiring login.

3. **Header Spoofing Regression**:
   Verify that forged identity headers sent by external clients are overwritten by nginx:
   ```bash
   node scripts/check_header_spoof.mjs https://docs.example.com
   ```
   Expect zero `FAIL` rows.

4. **Backup Timer Check**:
   ```bash
   systemctl list-timers lecture-api-backup.timer
   ```
   Verify the next trigger is scheduled.
