# Owner Console: Storage -> Databases & cleanup (zip 194)

Owner only. Open the Owner Console -> **Storage** tab; the **Databases & cleanup** card is at the top (the older per-shop size table is below it, unchanged).

## What it is (and what it is not)
* `GET/POST /api/owner-databases` (functions/api/owner-databases.js, helper `_storage-report.js`) - same owner session check as every owner endpoint. No shop or staff page contains it (tested).
* `/api/owner-storage` is the OLDER endpoint (per-shop KV size, compress, archive, move to own database). It is untouched; this feature is about the databases themselves.

## What it shows
One card per store. Everything comes from the endpoint; what cannot be measured says **not measurable** and why.

| Store | Size | Rows | Limit / % |
|---|---|---|---|
| Sales ledger D1 (`LEDGER_DB`) | measured (D1 `size_after`, else `PRAGMA page_count*page_size`) | per table (`COUNT(*)`) | yes |
| Audit D1 (`LEDGER_AUDIT_DB`) | measured | per table; `ledger_audit` is an id-range UPPER BOUND (never COUNT(*) - zip 186) | yes |
| Owner D1 (`OWNER_DB`) | measured | per table | yes |
| KV (`mydukapos_kv`) | **not measurable** (Cloudflare gives a Worker no size) | key counts per group (first 5,000 keys per group = "at least"); shop-record bytes only from keys that carry a size | no |
| Per-shop databases (`SHOP_STORE`) | sum of the first 30 shop databases that answer (`stats`) | records per shop (top 10 listed) | no |
| R2 buckets (`AUDIT_ARCHIVE`, `DB_BACKUPS`, `MEDIA`) | sum of the first 5,000 objects ("at least" beyond) | object count | no |

Per-table bytes are shown only if D1 exposes `dbstat`; otherwise the column shows a dash and a note says why. A store that is not bound shows "not bound on this project".

## Settings (Save settings)
* **Size limit (GB)** - per D1 database. Default 10 (paid plan). Free plan: 0.5 GB per database, 5 GB per account. It only drives the bar and the warning at 80%; Cloudflare enforces the real cap.
* **Kept for (days)**: Audit log (default 90, min 7), Till push log `ledger_batches` (365, min 90), Daily shop backup copies in KV (30, min 14). "Temporary data" (reset links, pairing codes, M-Pesa pending, print queue) is listed but not editable: those KV entries carry their own expiry, so there is nothing to prune.
* Automatic cleanup (daily) and automatic backup (Sundays) switches.
* Stored in `ledger_meta` key `storage_settings` of the main ledger D1 (the one place the Pages project AND the router cron both reach), mirrored in KV `owner-storage:storage_settings`; the newer copy wins.

## Run cleanup now
Only these, nothing else: (1) audit rows older than the retention - the existing `auditMaintenance` (archive to R2 with head-size verification, then delete exactly that id range; without the bucket the existing plain trim); (2) `ledger_batches` rows older than the retention - archived to R2 (`db-archive/ledger_batches/...`, verified) then exactly those rows deleted; **without the archive bucket this is skipped**; (3) KV shop backup copies older than the retention (never the `last-date` marker, never `pos-data:state:*`). Sales, payments, bills, inventory, customers and stock movements are never named in a DELETE (tested with seeded rows). Any R2 failure or size mismatch deletes nothing and the real error is shown. The result (archived / removed per category) is stored and shown as "Last cleanup ... (manual|automatic)".

The manual run bypasses the monthly gate of the audit archive; the automatic one keeps it (so a shorter retention takes effect at the next month's run unless you press Run cleanup now).

## Backups
"Back up now" copies the **ledger** and **owner** databases (every table except `ledger_audit`, which has its own monthly archive) to R2 as gzip NDJSON under `db-backups/<UTC run id>/<db>.ndjson.gz`, verified by head size, last 8 runs kept. A database larger than `BACKUP_MAX_ROWS` (default 50,000 rows) is **skipped with the reason** and the run shows PARTIAL: use `npm run db:backup` or D1 Time Travel for it. The Sunday cron does the same. Needs an R2 binding `DB_BACKUPS` (or `AUDIT_ARCHIVE`); without one the button is disabled and says so. This is a NEW mechanism: before this there was only the per-shop daily KV snapshot (`_backups.js`, shown as a KV group) and the manual `tools/backup-all.cmd`.

## Cron
`wildcard-router/worker.js` -> `ledgerSizeWatchdog` (every firing): the audit retention now uses your saved days (no saved setting = the old 90-day default), then `scheduledStorageJobs`: cleanup at most once per ~20 h (marker = last state timestamp, claimed first), backup on Sundays UTC at most once a week. Non-fatal. The router only reaches what is bound on it (`LEDGER_DB`, `LEDGER_AUDIT_DB`, R2); KV prune and the owner DB backup need those bindings there too.

## Bindings (examples are commented in wrangler.toml / wildcard-router/wrangler.toml - nothing was activated)
`npx wrangler r2 bucket create mydukapos-db-backups`, then un-comment `DB_BACKUPS` and, on the Pages project, `AUDIT_ARCHIVE` so "Run cleanup now" archives instead of removing. Until the Pages project has `AUDIT_ARCHIVE`, a manual cleanup removes old audit rows WITHOUT an archive (the console warns before it runs).

## Honest limits
Nothing here was run against real Cloudflare (tests use node:sqlite D1 and R2/KV fakes). Unverified on the real platform: `size_after` on `SELECT 1`, `dbstat` availability, R2 `list` paging, Durable Object `stats` timing for many shops, request time of a large COUNT(*) or backup.
