# Backup & Disaster Recovery Guide

Operating instructions for automated snapshots, retention policies, restore drills, and data privacy for `lecture-api`.

---

## 1. Automated Backup Schedule & Mechanism

Production backups of the PGlite database are automated via a systemd timer and service pair:
- **Timer**: `lecture-api-backup.timer`
- **Schedule**: Daily at `03:30:00` local time, with `RandomizedDelaySec=15m` (to prevent I/O load spikes) and `Persistent=true` (catches up missed runs after maintenance).
- **Service**: `lecture-api-backup.service` (the dump runs as unprivileged user `lecture-api` under the systemd sandbox).
- **Script**: `npm run db:backup` (`server/scripts/backup.ts`); the unit runs `node --import tsx scripts/backup.ts` because `scripts/` is not compiled into `dist/`.
- **Downtime**: PGlite is single-process, so the unit stops `lecture-api` before the dump and starts it again afterwards (root-run `ExecStartPre=+` / `ExecStopPost=+`, also on failure). Expect a few seconds of API downtime around 03:30. Run `npm run db:backup` by hand only with the service stopped.

### How Backups Work
1. **PGlite Dump**: Opens the (idle) PGlite data directory and calls `PGlite.dumpDataDir('gzip')`, producing a `.tar.gz` archive of the whole data directory. The file is written under a `.part` name and renamed when complete.
2. **Checksum**: Computes SHA256 of the archive and saves a companion `.sha256` verification file.
3. **Naming**: Files are named `lecture-api-backup-YYYYMMDD-HHMMSS.tar.gz`.
4. **Location and retention**: Archives go to `BACKUP_DIR` (default `server/backups`, or `--dir`). Keeps the latest 14 snapshots (`BACKUP_RETENTION=14` by default, or `--retention N`; an integer >= 1). Older archives and their `.sha256` files are automatically pruned.
5. **PostgreSQL URLs**: When `DATABASE_URL` is a remote PostgreSQL connection (e.g. Neon or self-hosted Postgres), `npm run db:backup` outputs the corresponding `pg_dump` command rather than a local file dump.

---

## 2. What Is and Is Not in a Backup

| Data Asset | In Database Backup? | Where Stored / Backup Method |
|---|---|---|
| User reading progress (`progress` table) | **YES** | Embedded in PGlite snapshot |
| Request idempotency keys (`idempotency_keys`) | **YES** | Embedded in PGlite snapshot |
| AI Chat Sessions (`ai_sessions`) | **YES** | Embedded in PGlite snapshot |
| AI Chat Messages (`ai_messages`) | **YES** | Embedded in PGlite snapshot |
| AI Review Checklists (`ai_review_checklists`) | **YES** | Embedded in PGlite snapshot |
| Database migration ledger (`schema_migrations`) | **YES** | Embedded in PGlite snapshot |
| Frontend static site (`dist/`) | **NO** | Backed up by `deploy_dist.py` to `/var/backups/lecture-site/docs.bak.<ts>` (0700) |
| Environment configuration (`server/.env`) | **NO** | Kept outside VCS; must be secured separately |
| Nginx & Authelia server configs | **NO** | Backed up separately in `/etc/nginx/` and Authelia directory |

---

## 3. Restore Drill (Step-by-Step Runbook)

Execute this disaster recovery drill to restore the database from a backup archive.

### 3.1 Pre-Restore Verification
Inspect available backups and verify archive integrity:
```bash
cd /opt/lecture-api/server

# List available backup snapshots
ls -lh backups/lecture-api-backup-*.tar.gz

# Pick the desired archive (e.g. latest)
ARCHIVE="backups/$(ls -1t backups/lecture-api-backup-*.tar.gz | head -1 | xargs basename)"

# Verify checksum matches
sha256sum -c "${ARCHIVE}.sha256"
```

### 3.2 Offline Drill in Sandbox (Safe Testing)
Before touching the live database, you can test restoring the snapshot into an isolated temporary directory:
```bash
# Test restore into /tmp/test-restore without touching production data
npm run db:restore -- --archive "$ARCHIVE" --target-dir /tmp/test-restore --force

# Inspect restored database
ls -la /tmp/test-restore
rm -rf /tmp/test-restore
```

### 3.3 Production Restore Procedure
To restore the live database:

```bash
# 1. Stop the backend service (PGlite allows one process per data directory)
sudo systemctl stop lecture-api

# 2. Run restore script
# NOTE: If target data directory is non-empty, the restore tool REFUSES to overwrite
# without --force. With --force, it preserves the existing directory as <dataDir>.bak.<ts>
cd /opt/lecture-api/server
sudo -u lecture-api npm run db:restore -- --archive "$ARCHIVE" --force
# The snapshot is first loaded into <dataDir>.restoring; the live directory is only moved aside
# once that succeeded, so a corrupt archive leaves the current database untouched.

# 3. Start service
sudo systemctl start lecture-api

# 4. Verify health
sudo systemctl status lecture-api
curl -s http://127.0.0.1:8100/api/health | jq .   # expect "ok": true and checks.db "ok"
```

After a successful drill delete the `<dataDir>.bak.<ts>` directory once you no longer need it.

---

## 4. Privacy & AI Data Lifecycle

### What the server stores
- **Sessions** (`ai_sessions`): session id, title, lecture id, group id, archive flag, timestamps, owner user id.
- **Messages** (`ai_messages`): the prompt and the answer text, the selected page text sent as context (`selected_context`), model name, token counts, timestamp. These rows are the full conversation in clear text, in the database and therefore in every backup.
- **Checklists** (`ai_review_checklists`): review items and completion flags.
- The browser keeps its own local copy of recent sessions in `localStorage`.

### What it does not store
- Logs: with `AI_ACCESS_LOG=true` the server writes one line per `/api/ai/*` call with a hashed user id, route, byte count, status, latency and rate-limit hits. It never logs prompts, answers or keys.
- Prompts and answers pass through the configured AI provider (Dify or another upstream, see `AI_PROVIDER`). That provider's own retention rules apply and are outside this server.

### How a user deletes AI history
1. **In the reader**: the history drawer deletes one session or all sessions of a lecture; this removes the local copy and calls `DELETE /api/db/sessions/:id`, which also deletes the session's messages (`ON DELETE CASCADE`).
2. **By API**: `DELETE /api/db/sessions/:id` (one session) or `DELETE /api/db/messages?session_id=<id>` (messages only), with the user's own identity headers.
3. **By an administrator**: `npm run db:reassign -- --from <userA> --to <userB> --yes` moves progress to `<userB>` and deletes the sessions, messages and checklists of `<userA>`.
4. **Backups**: deleted rows stay in older archives until retention prunes them (14 archives by default). Delete an archive together with its `.sha256` file to remove them earlier.
