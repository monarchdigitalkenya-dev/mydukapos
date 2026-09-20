# Path to: 1M users · no crashes · no bugs · 10 years of data

Honest framing first, because it decides what to build:

* **"No bugs / no errors at all" cannot be guaranteed by anyone** — not for any software. What *can* be achieved is a
  system where bugs are caught before release, invisible failures become visible within minutes, and no failure can lose
  money or data. The targets below are measurable, not absolute.
* **1,000,000 users is a data-architecture problem, not a "faster server" problem.** Cloudflare can serve that traffic.
  The way the apps store and sync data today cannot (measured below).
* **10 years of data does not fit the current design at all.** Everything lives in ~5 MB of browser storage and one
  server blob per shop. A busy shop fills that in weeks to months (assumption: 200 sales/day × ~0.8 KB ≈ 160 KB/day).

## What the code does today (verified) → what breaks first

| # | Today | Breaks when | Status |
|---|---|---|---|
| 1 | Every push read + parsed the **global index of all clients** (`updateIndexBusinessName`) | ~10k shops: CPU limits; ~100k: KV 25 MiB cap | **Fixed (zip 8)** — only on rename |
| 2 | Each open device downloaded the **whole shop every 7 s** even when nothing changed | Any large shop; 1M shops × 2 devices ≈ 25 **billion** requests/day | **Fixed for the payload (zip 8)** — unchanged = ~40 bytes. Request count still needs push-first (see Phase 3) |
| 3 | A shop = **one KV value**, rewritten whole on every push (read-modify-write, no locking) | KV 25 MiB/value; ~1 write/s/key; two devices pushing at once can lose one update | **Mitigated (zips 24-25)**: size guard (refuses >12 MiB raw with a clear message — measured: memory, not KV's 25 MiB, is the real ceiling), lossless gzip at rest, size tracked in KV metadata, slim push reply, log records sent as deltas, and an owner-triggered *Archive old history* that shrinks a shop and is restorable. The single-blob design itself remains: a busy shop still outgrows it → Phase 3 |
| 4 | **No authentication** — a link is the only secret | First scraper / disgruntled ex-employee | Phase 2 (design ready) |
| 5 | All data in **localStorage (~5 MB)**, whole arrays re-serialised on every save | Weeks–months for a busy shop; UI freezes as logs grow | **Mitigated (zip 25)**: big values are stored compressed in slices (measured ~8x smaller; a save recompresses only the last slice). ~19 days -> ~5 months at 150 sales/day. Still bounded → Phase 3 |
| 6 | Product photos inline in the inventory record | 10–20 photos on a full-size image | **Mitigated (zip 6)**; move to object storage in Phase 3 |
| 7 | ~430 functions copy-pasted **and diverged** across apps | Every fix has to be made 8 times | **604 functions now single-sourced**; rest in `DRIFT_REPORT.md` |

## Phase 1 — Make every change safe (prerequisite for everything else)
1. **Staging environment**: second Pages project + KV/DO/D1 namespaces. Nothing risky is tested on live shops again.
2. **Automated tests as a release gate** (`npm test`): real-browser (Playwright) end-to-end suite per app — login, sale
   (cash / M-Pesa / split / credit), void, return, restock, bills, reports, staff roles, **two devices editing at once**,
   go-offline/come-back. Property tests for money maths (rounding, VAT, split payments never gain/lose a cent).
3. **Static checks in `npm run check`**: the lint pass I ran found the real undefined-variable bugs (2 fixed in zip 8);
   make it a gate so they can't return.
4. **Error telemetry** — *built (zip 12)*: every app reports uncaught errors to `/api/client-log`; the Owner Console has a
   🐞 *Errors* tab (grouped, with counts and shops affected). Still to do: alert on spikes, and add the app version to reports.
5. **Safe releases**: canary shops first (`releaseChannel` on the license), one-click rollback (Pages keeps every deploy).

## Phase 2 — Trust and abuse
~~Server-verified logins~~ — **dropped by decision: sign-in must work offline** (see `SYNC_AUTH_DESIGN.md`). Still valid and offline-safe:
rate limits on SMS/M-Pesa/sync (SMS/M-Pesa done), schema + size validation of every push (size done), **idempotent writes** (each sale
carries a unique id, so a retry can never double-count — already true for the merge-by-id logs).

## Phase 3 — Data architecture that scales and lasts (the big one; built incrementally, shop data migrated with dual-write)
* **One Durable Object (SQLite) per shop** as the single writer: strong consistency, serialised writes, per-record rows
  `(collection, id, updatedAt, deleted, json)`. Removes the KV blob, the 25 MiB cap and lost updates.
* **Delta sync**: devices send/receive only records changed since a cursor. **WebSocket push** (hibernating sockets) is the
  primary channel; polling only as a 60 s fallback → the ~25 B requests/day become a few billion at most, and idle costs ~0.
* **Client on IndexedDB** (hundreds of MB, async) instead of localStorage; only a **hot window (≈13 months)** lives on the
  device. Older years are fetched on demand.
* **Archive, don't accumulate**: each month, closed sales/stock movements are compacted into an immutable gzip archive
  (object storage) plus **monthly rollups** (per item / day / payment method) and an **opening-balance checkpoint** — so Stock
  and Profit reports stay exactly correct without loading old raw rows. Rough size (assumption: sales + stock movements ≈ 100 MB/year raw for a busy shop) →
  ~10 MB/year compressed → ~100 MB for 10 years, off the device.
* **Photos to object storage** (R2): ~30 KB thumbnails served by URL and cached; records hold only the URL.
* **Licenses/index to D1** (indexed lookups) instead of one JSON blob.

## Phase 4 — Prove it
Load test on staging (simulate 100k shops × 3 devices, bursts at opening/closing time), cost model per shop, chaos tests
(kill the socket, drop the network mid-sale, clock skew, two admins editing), a restore drill from backups every quarter.

## Targets (how you'll know it worked)
* Crash-free sessions ≥ 99.9 %; every uncaught error visible in the Owner Console within a minute.
* **Zero lost sales** — verified by nightly server-side invariant checks (stock = opening + added − sold, totals reconcile).
* p95 sale-to-synced-on-other-device < 2 s; sync payload per idle poll < 100 bytes.
* A shop with 10 years of history opens in < 3 s and stays under ~50 MB on the device.

## What I need from you
1. A **staging Cloudflare project** (Phase 1 depends on it) — or permission to write the exact steps for you to create it.
3. Agreement that Phase 3 changes how data is stored on the server; live shops keep working throughout (dual-write, then cut over).

## Status after zip 24
* Done: size guard, gzip-at-rest + Owner Console remote compress, size/alert tracking, per-shop SMS/STK rate limits,
  CORS restricted on `pos-sync`, writer IP/country trail, real SHA-256 fallback (was a 32-bit hash).
* Still open: staging project (steps in `STAGING_SETUP.md`), Phase 3 data
  architecture, and the raw-size ceiling that the 128 MB Worker memory limit really imposes — measure it on staging.
* Limits of the size work: it protects the SERVER blob. The 5 MB browser (localStorage) limit is a separate, earlier
  ceiling and needs the IndexedDB / hot-window work in Phase 3.

## Status after zip 25 — how long a shop lasts (honest numbers)
Measured per sale: ~1.7 KB of sales + stock-movement history (~1.15 KB sale record, ~0.55 KB movement, 3 items).
| Sales per day | Device (5 MB, was ~19-60 days) | Server "Large" (4 MB) / refused (12 MB) |
|---|---|---|
| 50  | ~1.5 years on the device with compression | ~7 weeks / ~5 months |
| 150 | ~5 months | ~2.5 weeks / ~7 weeks |
| 400 | ~2 months | ~1 week / ~3 weeks |
The server figure is the limit that bites first. "Archive old history" (Owner Console -> Storage) resets it: it keeps the last N
days live and moves the rest to a restorable archive. That keeps every shop syncing indefinitely, at the price that tills show only
the recent history until an archive is restored. The lasting fix is the Phase 3 data architecture (per-shop database, delta pull,
monthly rollups so old reports stay correct without loading old rows).

## Status after zip 27
Archiving is now automatic on both sides (server at 80% of its limit, device at 80% of its storage), and no storage message reaches
a cashier. What an archive costs the user: reports and lists then show only the newest history (server default 90 days). The lasting
fix that removes that trade-off (monthly rollups so old reports stay correct, delta pull) is still Phase 3.

## Status after zip 28 — Phase 3, what is built and what is not
Built (server, opt-in per shop): per-shop SQLite Durable Object (`ShopStore`) with the SAME merge rules as the single record (proved by running both
side by side in `tests/shop-store.test.mjs`), push cost proportional to the push, hot-window pulls, delta pull by cursor (`/changes`), date-range history
(`/api/history`), verified reversible migration from the Owner Console, devices merge a recent-window pull instead of forgetting older history.
NOT built: (1) devices still use the full-state pull of the window (they don't yet consume `/changes` deltas, so a change re-sends the window and the
non-log collections); (2) monthly rollups — a report over old dates on a NEW device needs `/api/history` (the app's reports don't call it yet), so on a new
device old ranges look empty until that is wired into the report screens; (3) WebSocket push is not sent for database shops (they use the 7 s poll);
(4) point-in-time restore is untested; (5) nothing has run on real Cloudflare.

## Status after zip 29
Added on top of zip 28: (1) a new device on a database shop quietly fetches older history from `/api/history` in the background (last 180 days by
default, once per install, stops when the device is more than half full, never re-uploads it), so old-date reports work there without changing any
report screen; (2) database shops now get a live "poke" over the WebSocket (no data in it) so other tills pull immediately instead of waiting for the
7 s poll; (3) `Access-Control-Allow-Origin: *` is narrowed on EVERY /api endpoint by one middleware (own domains only); (4) Aqua POS stock requests
merge per record on the server.
Still open: devices don't consume the `/changes` delta (each change re-sends the window); no monthly rollups (hydration is bounded by device space, so on a
busy shop the oldest months may not fit on a phone and are reachable only via the history endpoint); nothing has run on real Cloudflare; point-in-time
restore untested; `checkoutCart` is still 8 copies.
