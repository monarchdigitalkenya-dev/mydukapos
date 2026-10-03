# Owner database (zip 187)

A small shared D1 database, `mydukapos-owner` (binding `OWNER_DB`), used as a **read model / index for the Owner Console only**.
**KV stays the source of truth for everything.** Licence checks, login (online and offline), device pairing, shop sync and shop access never read or import it.

## Why
The Owner Console list lived in ONE KV key (`license-index:v1`, an array of every client summary, rewritten on every change) and the per-person quote/payment
ledger in ONE KV doc (`owner-group-income:v1`). One big array rewritten on every change is a write race and gets heavier with every shop. With the owner database
each change touches one row and the console list is one SQL query.

## What is stored
| table | content |
|---|---|
| `owner_clients` | one row per client summary: `id` (PK), `slug`, `label`, `business_name`, `product`, `type`, `locked`, `trashed_at`, `expires_at`, `created_at`, `updated_at`, `summary_json` (the exact summary object the console list already shows). Indexes on slug, trashed_at, updated_at. |
| `owner_group_income` | one row per person (`person_key`, `data_json`, `updated_at`) — the quote/payment ledger. |
| `owner_meta` | `schema`, and after a rebuild `synced_at`, `kv_rows`, `income_rows`. |

Tables are created if missing at runtime (`ensureOwnerSchema`), and `sql/owner-db/0001_owner.sql` (== `migrations-owner/0001_owner.sql`) is identical (a test checks it).

### No secrets, ever
Only the non-secret summary fields the console list shows are mirrored. **Never mirrored:** password hashes, tokens/sessions, PINs, device-pairing data, the owner account record
(`owner-account:v1`) — **owner accounts stay in KV only**. As a second line of defence any top-level key that looks like a secret (`hash|pin|token|password|secret|salt|otp|proof`) is dropped before a row is written.

## How it works
1. **Write-through (best effort, never throws).** After each KV write that changes a summary (`saveLicense` = lock/unlock/extend/edit/delete/restore/billing/revenue..., `createClient`, `updateIndexBusinessName`, permanent purge) the row is upserted/deleted. Per-person ledger writes in `owner-lock.js` (`recordGroupIncome`, `resetAllIncome`) are mirrored the same way (the single KV doc is still written in full).
   * It runs after the KV write has succeeded, so it can never fail or undo it. A hang is cut off after `OWNER_DB_TIMEOUT_MS` (default 2000).
   * On an error the mirror pauses for 5 minutes in that isolate (`OWNER_DB_PAUSE_MS`) and a small KV flag `owner-db:dirty:v1` is set: D1 may now be behind KV.
   * With no `OWNER_DB` binding (or `OWNER_DB_DISABLED=1`) nothing changes. (While the kill switch is on, writes only set the dirty flag.)
2. **Read-through for the Owner Console list only** (`owner-clients.js` GET). D1 is used only when the mirror is **healthy**: bound, tables answer, `owner_meta.synced_at` set (a rebuild finished and its row count matched the KV index), no dirty flag, not paused, reads not disabled (`OWNER_DB_READS_DISABLED=1`). On ANY other situation, or any D1 error, the existing KV reads run. The response (clients, groupIncome, products, rootDomain) is identical either way — a test compares them. Cost of the check: one small KV get and one 3-row meta query.
   * `q` matches label or slug (case-insensitive substring, exactly like the KV path) using bound `LIKE ... ESCAPE '\'` with `%`, `_` and `\` escaped. A search with non-ASCII letters is left to KV (SQLite folds ASCII case only).
   * Order: live = newest created first, Trash = newest deleted first. Ties inside the same millisecond are ordered by id (KV: index order).
   * Other owner routes that call `listClientSummaries` (owner-health, owner-storage, resetAllIncome, the Trash sweep) still read KV; they are not on the list-screen hot path.
3. **Rebuild / backfill.** `rebuildOwnerDb(env)` copies the whole KV index and ledger into D1 (batches of 50, idempotent, deletes rows KV no longer has, never overwrites a row a live write touched after the rebuild started). Reads stay on KV while it runs and switch to D1 only when the copy has exactly as many rows as the KV index. It clears the dirty flag only if no mirror failure happened meanwhile.
4. **Owner route `/api/owner-db`** (owner session, like the other owner routes):
   * `GET` -> `{ bound, rows, kvRows, drift, driftDetail:{missing,extra,different,income}, incomeRows, kvIncomeKeys, syncedAt, healthy, reading, dirty, pausedUntil }` (reads the KV index once: owner-only, on demand).
   * `POST {"action":"rebuild"}` -> runs the rebuild and returns its result plus the new status.

## Setting it up (needs a Cloudflare login)
1. `node tools\setup-owner-db.mjs` — creates `mydukapos-owner`, adds the `OWNER_DB` binding to `wrangler.toml` and `wildcard-router\wrangler.toml` (backups `*.bak-zip187`, idempotent), creates the tables.
2. `npm run deploy` (and `npm run deploy:router` if you want the binding on the router).
3. Signed in as the owner, open `/api/owner-db` (status), then run the rebuild (`POST /api/owner-db` with `{"action":"rebuild"}`). The tool cannot do this for you because the route needs the owner session.
4. Until the rebuild succeeds the console keeps reading KV. Re-run the rebuild any time `drift` is not 0 (it is safe and repeatable); after a failed mirror write the flag turns reads back to KV until you do.

Kill switches: `OWNER_DB_READS_DISABLED=1` (reads from KV, mirror keeps running), `OWNER_DB_DISABLED=1` (no mirror, no reads). Removing the binding returns to today's behaviour.

## Honest limits
* This does not yet remove the single-blob race: `license-index:v1` is still written on every change, because KV must stay the source of truth (and `evaluateLicense` summaries, `listClientSummaries` and tests depend on it). The gain today is a cheaper, searchable console list and a per-row copy that is race-free for reads; moving the index itself off KV is a later step.
* Detecting a mirror write that was lost without any error (an isolate killed between the KV write and the D1 write) is not possible cheaply; the status route's drift check and a periodic rebuild are the safety net. A scheduled rebuild belongs in the router cron.
* Not verified against a live Cloudflare D1 account: tests run the real SQL on SQLite behind a D1-shaped fake.
