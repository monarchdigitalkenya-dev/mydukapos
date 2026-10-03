# Efficiency and reliability report, zip 159

Scope: the server side and delivery of MyDukaPOS on Cloudflare (Pages Functions, KV, D1, Durable Objects, R2, the Cache API).
All numbers below are OPERATION COUNTS produced by `node tools/measure-hot-paths.mjs` (the real functions running against counting wrappers
around the test fakes). They are not milliseconds. What one KV read or one D1 round trip costs on real Cloudflare (a few ms from the edge
cache, tens of ms to a D1 primary in another region) can only be measured on Cloudflare, so any time saving below is an estimate and is labelled so.
`node tools/measure-hot-paths.mjs --legacy` switches the new memory off and reproduces the "before" column.

## 1. Findings

| Hot path | Before | After | Basis |
|---|---|---|---|
| Sync poll, nothing changed (every ~7 s per device) | 3 KV reads + 1 DO call | 0 KV reads + 1 DO call (warm Worker); 3 KV reads on a cold instance | measured (ops) |
| Sync push, 1 sale | 4 KV reads, 1 D1 round trip / 5 statements, 1 DO call | 0 KV reads, same D1 and DO | measured (ops) |
| Push with 40 open tabs + 100 bills, nothing changed | 3 D1 round trips / 180 statements | 0 / 0 | measured (ops) |
| Same, one tab changed | 3 / 180 | 1 / 2 | measured (ops) |
| Licence check (`/api/license-status`, every 30 s per device) | 2 KV reads | 0 (warm) | measured (ops) |
| Product photo GET | 2 KV reads + full R2 body buffered in the Worker | 0 KV reads, R2 body streamed, ETag and 304 revalidation, edge-cache hit skips R2 | measured (ops) for KV; the rest is by construction, tested |
| CRM request as staff (list leads) | 6 D1 round trips | 4 | measured (ops) |
| CRM request as staff, session check alone | 3 D1 round trips | 1 | measured (ops) |
| D1 failure on a push | first blip = 503 "busy" to the till | one transient error retried (3 tries, backoff with full jitter); permanent errors are not retried | tested |
| Daily health cron | every shop in ONE request | slices of 12, self-chained, one email at the end | tested; the saving is estimated (one long request becomes several short ones) |
| `/api` answers with no Cache-Control | undefined (a proxy could keep live data) | `no-store` unless the endpoint set its own | tested |
| Static files | every request (apps, icons, sw.js) started the Function | app folders, icons, sw.js and the manifest skip it | estimate: with a root `_middleware.js`, Pages generates a `/*` route, so static requests were counted as Function invocations. This is Cloudflare's documented behaviour, not measured here. |
| KV-mode WebSocket broadcast | whole record to every device on every save | whole record up to 256 KiB, a bare poke above it | tested |
| D1 indexes (CRM) | the staff-scorecard meetings count scanned the whole table; the ad re-link UPDATEs on leads and sales could not use the campaign composite index | 6 new indexes; those statements now use one | EXPLAIN QUERY PLAN, tested (the audit tool also lists scans that are inherent and left alone, for example whole-table reports) |

### The chaos-test failure (seed 2026, "stale-read KV simulation: sales sometimes missing from server"): ROOT CAUSE AND FIX

Root cause. A shop that is stored as one KV record is updated by read, merge, write. KV has no compare-and-set, and a read can return a copy up
to about a minute old. The old code tried to detect a competing write (a "stamp" re-read before the write and a "verify" read after it), but both
checks read KV, so a stale answer fooled them too. Two devices merged from the same old copy, and the later write silently erased the other's
sales, while both devices had been told OK. I reproduced it at server level with 4 concurrent pushes and 35% stale reads: about 11% of
acknowledged sales were missing from the record, and 0% with no staleness.

Fix (server side, `functions/api/pos-sync.js`, `functions/api/_state-store.js`, new `_write-fence.js`, `_efficiency-schema.js`). A D1 "write
fence": a table `shop_write_fence(client_id, seq, kv_ver, at)`. D1 is strongly consistent, so it is the sequencer KV lacks.

1. A writer reads the fence row, then waits until the KV copy it reads has a version at least `kv_ver` (bounded, default 4 s, otherwise 503 "busy", which the till already handles by keeping the sale and retrying).
2. It merges.
3. It claims the next slot with one conditional upsert (`... WHERE seq = <what I read> RETURNING seq`). Exactly one concurrent writer wins; the others re-read and merge again on top of the winner's write.
4. It writes KV with an explicit version (`ver = max(seen, kv_ver) + 1`), and skips the old, unreliable stamp and verify reads.

Safety valves: no D1 or a failing fence query falls back to the old behaviour (the ledger, written first, still holds every sale); a claim
whose writer crashed before its KV write is ignored after 120 s; if KV refuses the claimed write, the slot is handed back. Environment
switches: `WRITE_FENCE=0`, `FENCE_WAIT_MS`, `FENCE_ORPHAN_MS`. The same fence covers `kvMergeUpdate` (cross-branch sales).

Evidence. `tests/zip159-efficiency.test.mjs`: 12 seeds of 4-way concurrent pushes over stale KV lose 0 sales with the fence, and the same script with
`WRITE_FENCE=0` loses sales (proving the race is real and the fence is what closes it). `tests/multi-device-chaos.test.mjs` passes 4/4 including seed 2026.

Honest limits. (a) Permanent shops already run in the per-shop Durable Object, which is serial and never had this race; the fence protects the
single-record (demo, trial, not yet moved) shops and any shop while it is in KV mode. (b) The chaos test's stale-read seeds now run with a D1
attached (`makeServer({ d1: true })` in `tests/e2e-harness.mjs`, used by `tests/multi-device-chaos.test.mjs` for the two stale seeds), because
every real shop has D1 and the fence lives there. Without D1 the old, weaker checks still apply, and the race can still occur; that is
labelled in the test. (c) A non-fenced writer (owner restore, some owner tools that call `writeState`) stamps a version that can be lower than the
fence expects only if its own read was stale; the next fenced push then waits up to 4 s, answers 503 busy, and recovers by itself within 120 s at
worst. This is rare and self-healing, and I did not add a fence to those tools.

## 2. What changed

Speed (fewer round trips):
- `_license.js`: 10 s isolate cache of licence and slug records (parsed per use, never caches "not found", stale-if-error up to 10 minutes, invalidated on every write in this instance). `LICENSE_CACHE_MS=0` disables. Other instances see a change within 10 s (a licence lock is a rare, deliberate action).
- `_state-store.js`: 10 s cache of the shop mode, only for "do". "kv" and "migrating" are never cached, because a shop can move at any time. The migrate, unmigrate and failure paths drop the entry, and unmigrate waits for other instances' entries to expire before exporting. `SHOP_MODE_CACHE_MS=0` disables; `MIGRATE_SETTLE_MS` shortens the wait (tests).
- `_ledger.js`: a 5 minute per-record fingerprint memory (only marked after the batch commits), so a push that repeats records D1 already holds sends nothing; the KV outbox is read at most once per 20 s while known empty; each D1 batch is retried on transient errors. `LEDGER_SEEN_MS=0` and `LEDGER_OUTBOX_CHECK_MS=0` disable.
- `_crm/auth.js`: session user, roles and overrides in one `db.batch`.
- `media.js` / `_media.js`: ETag, `If-None-Match` answered by R2 itself (`onlyIf`) with 304, R2 body streamed with `Content-Length`, Cache API for PUBLIC product photos only (never the private `r` and `ref` kinds), purged on delete. `MEDIA_EDGE_CACHE=0` disables.
- `pos-sync.js`: KV-mode broadcast capped at 256 KiB (`BROADCAST_MAX_BYTES`), a bare poke above it.
- `owner-health.js`: the daily cron is sliced (`HEALTH_CRON_SLICE`, default 12) and chains itself; a small fleet behaves exactly as before.
- Delivery: `_routes.json` (static app folders, icons, sw.js and the manifest skip the Function; `/`, `/api/*`, internal paths and root files still reach it, so the internal-path 404 guard is intact), `_headers` (icons cached 1 day + stale-while-revalidate, service workers no-cache), `/api` default `no-store` plus `Server-Timing`.

Reliability: `_retry.js` (backoff with full jitter, transient errors only), the write fence above, KV reads wrapped in retry, stale-if-error licence reads.

Database: `CRM_SCHEMA_VERSION` 3 to 4 with `ix_crm_meetings_user`, `ix_crm_leads_ad`, `ix_crm_sales_ad`, `ix_crm_spend_date`, `ix_crm_spend_ad`, `ix_crm_attr_ad`. New `migrations/0003_efficiency.sql` (the fence table). `migrations/0002_crm.sql` regenerated. All idempotent; `tools/gen-migration.mjs` generates all three and a test fails if a file differs.

Tools: `tools/measure-hot-paths.mjs`, `tools/audit-d1-queries.mjs` (EXPLAIN QUERY PLAN over every SQL literal in `functions/`), `tests/ops-count.mjs`, an optional `globalThis.__D1_SQL_LOG` hook in `tests/d1-fake.mjs`.

## 3. Deliberately NOT changed, and why

- Service workers (`sw.js`, every module): reviewed, strategies are sound; I did not touch them, and `hotel/` was out of scope.
- Durable Object hibernation and SyncRoom: already hibernation-based; broadcast was already a poke in database mode.
- Long max-age on app HTML, JS, CSS: none of it is fingerprinted, so a long cache would keep tills on an old release. Only icons were cached.
- KV-mode full record parse and stringify per push: only demo, trial and pre-move shops. A permanent shop moves to the DO on its first push, so optimising the KV path further buys little.
- CRM `runAutomation` and `sweepReminders`: `runAutomation` is already one conditional upsert per 60 s window (still one round trip per request); `sweepReminders` runs on `/me` only. A read-first throttle would break the tests that delete `crm_meta` rows, for one round trip; I left it.
- CRM lead list (LIMIT/OFFSET plus a separate COUNT, about 9 correlated subqueries per row): correct and bounded by the page size; a rewrite is a risk to a screen the team uses all day. Recommended only if a shop reaches tens of thousands of leads.
- Unbounded campaign and ad lists (`SELECT * FROM crm_campaigns`): tiny tables in practice.
- `stampSales` session lookups: already one KV read per distinct session per push; caching sessions across pushes would delay revocation, which is a security trade I would not make silently.
- The router double hop (wildcard router Worker to Pages): changing it needs `npm run deploy:router` and a routing redesign; see the plan below.
- No data moved between KV, D1 and DO. Recommendation: shop data stays in the DO (per-shop serial writes), the ledger in D1 (queries, constraints), KV for small, read-mostly, eventually-consistent records (licence, slug, mode, rate-limit counters). Nothing else is worth moving without a dual-read path.

## 4. Prioritised plan for bigger moves (dashboard steps, Windows, no PowerShell)

1. Apply the new migration to D1 (fence table; CRM indexes also self-create on first use). Open Command Prompt in the project folder and run `npx wrangler d1 migrations apply <your-database-name> --remote` (use the database name from `wrangler.toml`). Nothing breaks if you skip it: the server creates the same objects on first use.
2. Deploy as usual with `npm run deploy` (runs the checks and tests first). No router redeploy is needed, because nothing under `wildcard-router/` changed.
3. Smart Placement (estimated benefit: fewer long trips between the Function and D1 or the DO when the database is far from the caller; the gain depends on where your users are, so measure before and after). Cloudflare dashboard, Workers and Pages, the `mydukapos` project, Settings, Functions, Placement, choose Smart, save. Watch the Server-Timing header in the browser's Network tab (F12) for a few days; revert to Default if it is slower.
4. Cache Rules for static delivery (optional, after step 2): Cloudflare dashboard, the mydukapos.store zone, Caching, Cache Rules, Create rule. Match "URI Path starts with /icons/", action Eligible for cache, Edge TTL 1 day. Do not add a rule for `/api/`.
5. R2 lifecycle: dashboard, R2, the `mydukapos-media` bucket, Settings, Object lifecycle rules, Add rule. Add an "Abort incomplete multipart uploads after 1 day" rule. Do NOT add a delete-after-N-days rule on the shop pictures.
6. D1 read replication (largest possible read latency win, but needs code): dashboard, D1, the database, Settings, Enable read replication. It only helps once reads use the D1 Sessions API with bookmarks (so a sale is read back consistently after it is written). That is a separate piece of work with its own tests; do not enable it before it lands.
7. Later, if the shop count grows: a Cloudflare Queue for the health cron and webhook outbox (the current KV outbox works and is tested).

## 5. Verification

`npm run check` (shared source in sync) and `npm run lint` pass. `tests/zip159-efficiency.test.mjs` 33/33, `tests/sync-busy.test.mjs` 5/5 (one assertion adjusted, see the final report). Also passing after the changes: `tests/multi-device-chaos.test.mjs` 4/4, `tests/ledger-d1.test.mjs`, the `zip156-*` tests, the CRM tests (129 tests with cors-middleware), `tests/cors-middleware.test.mjs`. See the final report for the wider regression run.
