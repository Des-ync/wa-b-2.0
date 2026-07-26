# Deployment (Oracle Cloud Free Tier)

One-time server bootstrap on the `app-vm` (Ubuntu 22.04, Ampere A1):

```bash
# Node 18 LTS
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2

# clone + first install
sudo mkdir -p /opt/wa-b-2.0 && sudo chown $USER:$USER /opt/wa-b-2.0
git clone https://github.com/Des-ync/wa-b-2.0.git /opt/wa-b-2.0
cd /opt/wa-b-2.0
npm ci --omit=dev
cp .env.example .env   # then fill in real values, DATABASE_URL pointing at db-vm private IP

npm run migrate
npm run seed              # plans only by default — NEVER pass --demo-data on a real prod DB
npm run issue-key admin "ops"

pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup   # run the printed command to enable boot-time start

# Log rotation for PM2's own captured stdout/stderr (logs/pm2-*.log) — winston's
# own app-level logs already cap themselves at 5MB x 5 files, but PM2's raw
# out_file/error_file do not rotate on their own and will grow unbounded.
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true

# nginx + TLS
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wa-saas
sudo sed -i 's/yourdomain.me/YOUR_REAL_DOMAIN/' /etc/nginx/sites-available/wa-saas
sudo ln -s /etc/nginx/sites-available/wa-saas /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR_REAL_DOMAIN
```

`npm run seed` only upserts the `plans` pricing table by default — that step is
idempotent and safe to re-run anytime (it's also how you publish a pricing
change: edit `PLANS` in `src/models/seed.js`, redeploy, reseed). It will NOT
create the "Demo Vendor GH" sample business/products unless you explicitly
pass `--demo-data` (or set `SEED_DEMO_DATA=true`) — do that only against a
throwaway/dev database, never against `db-vm`'s real production database.

## GitHub Actions secrets

Set these in the repo (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ORACLE_APP_HOST` | Public IP or domain of `app-vm` |
| `ORACLE_APP_USER` | SSH user (e.g. `ubuntu`) |
| `ORACLE_APP_SSH_KEY` | Private key matching a public key in `~/.ssh/authorized_keys` on `app-vm` |

Every push to `main` runs `.github/workflows/deploy.yml`: it first runs the
full `npm test` suite in a clean GitHub-hosted runner (no prod access) and
only proceeds to the deploy job — pull latest, install deps, run migrations,
zero-downtime `pm2 reload` — if every test passes. A commit that fails
`npm test` never reaches `app-vm`.

## Rolling back a bad deploy

There is no automatic rollback. The deploy pipeline always hard-resets
`app-vm`'s checkout to whatever `origin/main` currently points to, so the
fastest safe fix for a bad deploy is usually a forward fix:

```bash
git revert <bad-sha>          # on your machine
git push origin main          # re-triggers the test-gated deploy workflow
```

If you need to manually pin `app-vm` to a specific known-good commit right
now (e.g. CI itself is down, or you need to act faster than a revert PR):

```bash
ssh -i ~/.ssh/oracle_app_vm ubuntu@<app-vm-ip>
cd /opt/wa-b-2.0
git fetch origin
git reset --hard <known-good-sha>
npm ci --omit=dev
npm run migrate            # only if the good SHA's schema differs from current
pm2 reload deploy/ecosystem.config.js --update-env
```

Note `npm run migrate` only ever adds/alters — there's no down-migration, so
rolling back the app code across a migration boundary can leave newer columns
in place that the older code just ignores; that's normally fine, but check
before rolling back across a migration that materially changed a table this
app writes to.

## Restoring from a database backup

`src/jobs/db.backup.js` runs nightly (03:15 Africa/Accra, only if
`DB_BACKUP_ENABLED=true`) and produces a gzipped `pg_dump` SQL file, optionally
uploaded via `DB_BACKUP_UPLOAD_CMD`. To restore one:

```bash
# on db-vm (or wherever you can reach the target Postgres instance)
gunzip -c wa_b_backup_YYYY-MM-DD.sql.gz | psql "$DATABASE_URL"
```

This is a plain SQL-text dump, so it replays as a sequence of statements
against an empty (or matching-schema) database — it does not itself create the
database/role. Run `createdb` first if restoring into a fresh instance. Treat
any restore as destructive to whatever's already in the target database.
**Periodically test this restore procedure against a scratch database** — a
backup that has never been restored from is unverified, not a real backup.

## Database VM (`db-vm`)

```bash
sudo apt-get install -y postgresql
sudo -u postgres createuser --pwprompt wa_saas
sudo -u postgres createdb -O wa_saas whatsapp_saas
# in pg_hba.conf, allow only app-vm's private IP; in postgresql.conf, listen_addresses = '<db-vm private IP>'
sudo systemctl restart postgresql
```

Use the resulting private-IP connection string as `DATABASE_URL` on `app-vm`.
If Postgres on `db-vm` is configured for TLS, also set `DATABASE_SSL=true` in
`app-vm`'s `.env` — the app connects unencrypted by default unless either
`DATABASE_SSL=true` is set or `DATABASE_URL` itself contains `sslmode=require`.

## Uptime monitoring

`GET /health` (checks a real DB round-trip, returns 503 on failure) exists but
nothing in this repo consumes it — PM2 does not health-check over HTTP, and
there is no external monitor wired up. Point a free uptime monitor (e.g.
UptimeRobot, Better Uptime) at `https://skes.tech/health` and alert on
503/timeout so an outage is caught even if `alertOps()`'s WhatsApp ping
(`OPS_ALERT_PHONE`) is unset or the app itself is wedged.
