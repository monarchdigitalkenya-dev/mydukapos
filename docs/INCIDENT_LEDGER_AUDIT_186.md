# Incident zip 186: D1 `mydukapos-ledger` full (10 GB) because of `ledger_audit`

Server side, tools and cleanup order. (The client retry fix, the CRM removal 0008 and the single-site packaging are described by their own notes.)

## 1. What happened (root causes, verified in the code)

| # | Cause | Where |
|---|---|---|
| RC1 | A pending stock movement carries a counter the client increments on every push (`m.tries`, `stampLocalContext` in `src/shared/functions.js`). `recordPush` stored the whole record as `data`, so every resend had different `data`. | `functions/api/_ledger.js` `rec()` (data = `canon(record)` incl. `tries`) |
| RC1b | The upsert only skips a write when `excluded.data = ledger_records.data`; with `tries` inside, every resend passed `excluded.data <> ledger_records.data`, did an UPDATE, and fired the audit trigger. | old `UPSERT_RECORD` (`_ledger.js` ~108-112) |
| RC1c | The trigger wrote one audit row (full snapshot, about 460 bytes) for every UPDATE, with no "did anything really change" test. | `migrations/0001_ledger.sql` ~374 and `functions/api/_ledger-schema.js` ~354 (`audit_ledger_records_upd`) |
| RC2 | No backoff and no cap on the client (about 84 rows/s across devices). | client (other agent) |
| RC3 | No size guard, no retention, no alert. | new: `/api/ledger-health`, router watchdog, prune tools |
| RC4 (unverified without logs) | Why the till never accepted a reply. Every ledger failure is answered 503 `busy` and the till retries every 2 s (`pos-sync.js` `busyResponse` / `Retry-After: 2`); a later step failing after the ledger succeeded has the same effect. The server can no longer turn that into audit growth. | `pos-sync.js` |
| RC5 | Stock exactness: the stock ledger applies a movement once per movement **id** (`newLedgerMoves` + `mergeRecordsById`: a stored movement is immutable; a resend is ignored). The D1 mirror is keyed by (client_id, kind, rec_id). A resend never changed a shop's stock; only the audit table exploded. Verified by test (stock changes once over 50 resends). | `_merge.js` 372, 954-975 |

Stock for a shop (e.g. `kw8mqf3dkt` / barcode `8991389410365`) lives in the shop record (KV / its own database), not in D1: see `tools/stock-reconcile.sql` and `GET /api/stock-integrity`.

## 2. What the server does now

* **Idempotent writes** (`_ledger.js`): retry/telemetry fields (`tries`, `_tries`, `retries`, `retryCount`, `_retryCount`, `lastTryAt`, top level only) are removed before a record is stored or fingerprinted, and the upsert compares against the stored data minus the same fields (so rows stored before the fix are not "changed" by a resend either). A resend that differs only in those fields is a pure no-op: no UPDATE, no audit row.
* **Quiet audit triggers** (migration `0007`, same list is applied by the runtime bootstrap): an audit row is written only when version, status, amount or the data (minus the counters) really changed, and only if `ledger_meta audit_disabled` is not `1`. No unique index on `ledger_audit`.
* **Small audit rows**: snapshot is the full record unless its JSON is longer than 2000 characters (`stock_move`) or 16000 (every money kind); then a valid-JSON stub `{"truncated":1,"len":..,"kind","status","amount","version"}` is stored. (Brief suggested 4000 for all; money kinds were kept larger so ordinary sales never lose their history copy. The full current record is always in `ledger_records.data`.)
* **Delete guard** `no_delete_ledger_audit`: still aborts with `financial records are never deleted`, except while `ledger_meta audit_prune_open = '1'` AND the row is older than 10 minutes. `no_update_ledger_audit` (append-only) is unchanged. All other delete guards are unchanged.
* **Per-record rate guard**: more than `AUDIT_REC_RATE_PER_MIN` (default 20, `0` = off) really changing writes of one (shop, kind, id) per minute in one isolate: that record is left out of the write; if the whole push is only such records the answer is `429 {ok:false, code:'record_rate', retryAfter}` + `Retry-After`; otherwise `200` with `rateLimited:[...]`. No-op resends are never counted. In-isolate memory only (no KV / D1 write per request), so the limit is per isolate.
* **Permanent errors**: an item with an unusable id (object / longer than 200 chars) or a record over 512 KB is left out and listed in `rejected`; a push with nothing else valid answers `422 {ok:false, permanent:true, code:'bad_record', rejected}` so the client can stop retrying.
* **Storage full**: D1 `SQLITE 7500 / Exceeded maximum DB size` is never retried (`_retry.js` `isStorageFull`) and is answered `507 {ok:false, code:'storage_full', retryAfter:300}` + `Retry-After: 300` by `pos-sync.js` and `cross-branch-sale.js`. Webhook payments/gateway events keep parking in the KV outbox; the outbox replay stops at the first "full" error.
* **Reply additions** (only added; the existing fields are unchanged): `duplicate:true` (every record of the push was already stored), `rateLimited`, `rejected`.
* **Kill switch** (audit rows off, sales/records still saved). Audit rows are written by triggers, so the switch is a row in `ledger_meta`:
  * Owner (signed in): `POST /api/ledger-health` body `{"audit":"off"}` / `{"audit":"on"}`.
  * SQL: `npx wrangler d1 execute mydukapos-ledger --remote --command "INSERT INTO ledger_meta (k, v) VALUES ('audit_disabled', '1') ON CONFLICT (k) DO UPDATE SET v = '1'"` (use `'0'` to turn it back on).
  * No deploy needed: env var `AUDIT_WRITES_DISABLED=1` (Pages > Settings > Variables, applies to new requests) or KV key `audit:disabled` = `1` is mirrored into the row by the server on the next push. The mirror only turns the switch ON; turning it OFF is always explicit (endpoint or SQL), so an audit trail never resumes or flaps silently. `GET /api/ledger-health` and the watchdog warn while it is off.
* **Health / watchdog**: `GET /api/ledger-health` (owner session) returns `auditRows` (an upper bound from MIN/MAX id, never COUNT(*)), `ratePerMin`, `rowsLastHourEstimate`, `topRecords` / `topTenants` over the newest 5000 ids, `sizeBytes` / `pctOfCap` (from D1's `meta.size_after`), the flags, the last watchdog alert. The router Worker's cron (daily health firing plus a 6-hourly firing, `wildcard-router/wrangler.toml`) writes the same reading to `ledger_meta size_alert` (and KV `ledger:size-alert` if bound): warning at 60%, critical at 80% of 10 GB, or runaway growth (3000 rows/min), audit off, prune flag left open, migration 0007 missing. It is inert without a `LEDGER_DB` binding (the production router toml now binds the same database; staging does not).

## 3. Owner run order (Windows cmd, no PowerShell)

> Never run a Time Travel restore or the prune without reading the warning it prints. Nothing below touches client browsers or their local queues.

Order: **backup, free space, 0006, 0007, 0008 (CRM drop, from the other agent), deploy router, deploy Pages.**

```cmd
cd C:\dev\mydukapos

REM 1. BACKUP everything except ledger_audit data (about a minute per table; failures are logged and the loop continues)
tools\backup-all.cmd
type backup\backup-log.txt | findstr /i "FAILED"

REM 2. (recommended) archive the audit rows that the prune will delete, as gzip NDJSON (read-only; same --chunk as the prune)
node tools\archive-audit.mjs --chunk 100000

REM 3. EVIDENCE, read-only
npx wrangler d1 execute mydukapos-ledger --remote --file=sql\incident\01_capture_triggers_and_schema.sql --json > backup\incident_01_capture.json
npx wrangler d1 execute mydukapos-ledger --remote --file=sql\incident\02_sample_junk_A2.sql --json > backup\incident_02_sample.json
node tools\prune-audit.mjs --measure --sample-every 10

REM 4. FREE SPACE: look, then delete (asks you to type YES; resumable with --from-id N; Ctrl+C is safe)
node tools\prune-audit.mjs --dry-run
node tools\prune-audit.mjs --run --global-dups
```

* Before 0007 the script takes the **EMERGENCY path**: it saves the exact guard trigger SQL to `backup\ledger_audit_delete_guard.sql`, drops `no_delete_ledger_audit`, prunes, and re-creates it in a `finally` (also on Ctrl+C or an error) and verifies it. If the re-create fails it prints the exact `wrangler d1 execute ... --file=backup\ledger_audit_delete_guard.sql` command: run it at once.
* **If it stops with `SQLITE 7500`** (`DROP TRIGGER` / the flag need a free page): nothing was changed. Only a Time Travel restore frees space. It DISCARDS every write after the bookmark; tills that still hold unsynced sales will re-send them, and the server is idempotent now. Show Monarch what will be lost first:
  ```cmd
  npx wrangler d1 time-travel info mydukapos-ledger
  npx wrangler d1 time-travel restore mydukapos-ledger --bookmark=<bookmark from before the explosion>
  ```
  (The brief's bookmark, taken 00:09 EAT on 2026-10-03, already contains the full table: prefer one from about 2026-10-02 12:00 UTC. Time Travel prints the bookmark of the state it replaced, which undoes the restore.)
* D1 bills deleted rows as rows written (21.8M deletes plus index updates): check the plan quota before a full run, or use `--max-chunks` and `--sleep-ms` to pace it.

```cmd
REM 5. HEADROOM CHECK
npx wrangler d1 execute mydukapos-ledger --remote --command "SELECT MIN(id), MAX(id) FROM ledger_audit"

REM 6. MIGRATIONS (0006 M-Pesa claims, 0007 quiet audit triggers; 0008 drops the CRM tables: only after the backup in step 1 succeeded for them)
npx wrangler d1 migrations apply mydukapos-ledger --remote

REM 7. DEPLOY: router first (watchdog + cron + D1 binding), then Pages (idempotent server BEFORE the tills flush their backlog)
npm install
npm run deploy:router
npm run deploy
```

After 0007 any later prune takes the **SAFE path** (it only sets and clears `ledger_meta audit_prune_open`, and never rows younger than 10 minutes). To check the guard by hand: `DELETE FROM ledger_audit WHERE id = 1` must answer `financial records are never deleted`.

### Verification after deploy (acceptance tests 3, 6, 7)

```cmd
npx wrangler d1 execute mydukapos-ledger --remote --file=tools\stock-reconcile.sql --json > backup\stock-reconcile.json
```

Open `https://<your-domain>/api/ledger-health` signed in as owner: `ratePerMin` should be a few rows per sale, `level` `ok`. Tests: `tests/zip186-audit-idempotency.test.mjs` (50 resends = 1 audit row, stock once, guard, flag, kill switch, rate guard, 507, 0007 on top of 0001) and `tests/zip186-prune-audit.test.mjs` (prune flow on a real SQLite, both paths, abort/Ctrl+C restore, SQL files).

## 4. Migration 0006 and 0007

* `0006_mpesa_claims.sql` stays as is (additive, `CREATE TABLE IF NOT EXISTS`).
* `0007_audit_idempotency.sql` is generated from `LEDGER_SCHEMA_0007` (`npm run gen:migration`; a test fails if they differ). It drops and re-creates the two audit triggers and the audit delete guard, changes no data, adds no index, and records schema version 3 so the runtime bootstrap does not repeat it. `0001` is never edited (it still creates the old triggers on a brand-new database; `0007` replaces them). A database still on schema 2 is upgraded by the bootstrap on the first push.

## 5. Not verifiable without the live database

* The exact current trigger SQL (section 4A of the brief), whether other ledger tables carry the same guard, and how much headroom a `DROP TRIGGER` needs.
* The real distribution of the 21.8M rows (what share are exact duplicates); `--measure` answers it.
* How long a 100,000-id chunk delete takes on D1 (the script halves the chunk on a timeout, down to 1000).
* `wrangler d1 execute --json` output shape and the `--yes` flag on wrangler 4.147 (the parser tolerates banner lines; `meta.changes` is used for counts).
* Whether `meta.size_after` is returned for every query (the health reading omits `pctOfCap` if not).

## 6. Remaining risks

* The rate guard and the "seen" cache are per Worker isolate: a storm spread over many isolates is bounded per isolate, not globally. The idempotency itself is global (it is in SQL).
* Rows already in `ledger_audit` are only removed by the prune; the first resend of an old stuck record after the fix is not audited again (compared minus the counters).
* While `audit_disabled=1` no history rows are written for any shop; the health endpoint and the watchdog flag it.
* A truncated audit snapshot (stub) loses the history copy of an oversized record version; the current record in `ledger_records` is complete.
