# Upgrade & Rollback Procedures

Standard operating procedures for upgrading `lecture-api` (backend), schema migrations, VitePress static site, and rollback recovery.

---

## 1. Upgrading Backend Service (`lecture-api`)

Backend updates should follow a zero-downtime or minimal-interruption sequence.

```bash
# 1. Take a snapshot backup before upgrading (MANDATORY). PGlite is single-process: stop the API first
#    (external PostgreSQL: run the pg_dump command the script prints and skip stop/start).
cd /opt/lecture-api/server
sudo systemctl stop lecture-api
sudo -u lecture-api npm run db:backup
sudo systemctl start lecture-api

# 2. Update repository source code
sudo -u lecture-api git fetch origin
sudo -u lecture-api git checkout v2-release-tag # or git pull

# 3. Install production dependencies (if package-lock.json changed)
sudo -u lecture-api npm ci

# 4. Check for pending schema migrations
sudo -u lecture-api npm run db:status

# 5. Preview pending migration SQL in dry-run mode (on PGlite stop the API first)
sudo systemctl stop lecture-api
sudo -u lecture-api npm run db:migrate -- --dry-run

# 6. Apply pending migrations
sudo -u lecture-api npm run db:migrate

# 7. Compile TypeScript build output
sudo -u lecture-api npm run build

# 8. Restart service
sudo systemctl restart lecture-api

# 9. Verify service health
curl -s http://127.0.0.1:8100/api/health | jq .
```

---

## 2. Database Migrations Lifecycle

All database migrations in `server/migrations/` follow strict engineering rules:
- **Forward-Only**: Migrations (`0001_init.sql`, `0002_ai_checklists.sql`) are additive only. No destructive dropping of existing columns or tables in production migrations.
- **Idempotency**: All DDL statements use `IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
- **Locking**: On PostgreSQL, migration runs are protected by an advisory lock. PGlite is single-process, which is why the API must be stopped while `db:migrate` runs.
- **Dry-Run Inspection**: Running `npm run db:migrate -- --dry-run` outputs the exact SQL statements that would be executed without touching the database.

---

## 3. Upgrading Static Frontend (`site/`)

The static frontend is compiled locally on the developer machine or CI runner and deployed using atomic swap scripts:

```bash
# On build machine:
cd site
npm run build

# Deploy to production:
python scripts/deploy_dist.py --local site/docs/.vitepress/dist
```

The script ensures:
1. Backs up existing live webroot to `/var/backups/lecture-site/docs.bak.<ts>` (kept outside webroot with `0700` permissions; retention keeps latest 3).
2. Uploads and extracts files to `.docs_staging`.
3. Verifies file count against local build.
4. Switches the directory into place with two renames. If the switch fails, the previous webroot is restored and the script aborts.

---

## 4. Rollback Procedures

If an upgrade causes regressions or issues:

### 4.1 Frontend Rollback
To roll back the static site to the previous release:
```bash
# Connect to production host
ssh <deploy-user>@<host>

# Locate the most recent backup
LATEST_BAK=$(ls -1td /var/backups/lecture-site/docs.bak.* | head -1)

# Atomically restore
sudo mv /var/www/example.com /var/www/example.com.failed
sudo cp -a "$LATEST_BAK" /var/www/example.com
sudo chown -R www-data:www-data /var/www/example.com
```

### 4.2 Backend Service Rollback
To roll back the backend service to the previous release:
```bash
cd /opt/lecture-api/server

# 1. Stop service
sudo systemctl stop lecture-api

# 2. Revert code to previous commit or release tag
sudo -u lecture-api git checkout <previous-git-tag>
sudo -u lecture-api npm ci
sudo -u lecture-api npm run build

# 3. If database changes must be reverted, restore from pre-upgrade snapshot
LATEST_DUMP=$(ls -1td /opt/lecture-api/server/backups/lecture-api-backup-*.tar.gz | head -1)
sudo -u lecture-api npm run db:restore -- --archive "$LATEST_DUMP" --force

# 4. Restart service and verify health
sudo systemctl start lecture-api
curl -s http://127.0.0.1:8100/api/health | jq .
```

### 4.3 Gateway / Plan B Rollback
If switching `/api/ai/*` to lecture-api (Plan B) needs rollback to legacy direct Dify proxying:
Refer to [`GATEWAY.md`](./GATEWAY.md) §5 (Rollback): restore backed up nginx configuration, reload nginx (`sudo nginx -t && sudo systemctl reload nginx`), and restart Authelia.
