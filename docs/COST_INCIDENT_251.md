# Cost incident, zip 251 - Durable Object and D1 writes

Bill reported for 10 Sep - 9 Oct 2026: about $646 (Durable Object storage writes $525, D1 writes $89, KV reads $20, Workers requests $6.60, Durable Object requests $3.90, Workers CPU $1.50).
The bill figures were confirmed from screenshots of the Cloudflare dashboard (Billing -> Billable usage, 11 Oct 2026): total $646.00, Durable Objects rows written 574.91M ($525), D1 rows written 138.41M ($89), KV reads 49.08M ($20), Workers requests 31.22M, DO requests 26.43M, Workers CPU 104.89M ms. No Cloudflare API access existed, so nothing else was read from the account.

**Timeline read from the daily cost chart:** $0 until about 21 Sep; Durable Object writes about $55-80 per day from about 22 Sep to about 30 Sep; D1 writes about $30-57 per day on about 1-3 Oct; near $0 per day from about 4 Oct. The spike was a bounded episode, not a steady rate, and it had already stopped BEFORE this fix existed. What started it on about 22 Sep and what ended it on about 3-4 Oct is not known (a deploy, a tablet coming online or being corrected, a shop moving database mode). Compare the dates with `npx wrangler pages deployment list --project-name=mydukapos` and `npx wrangler deployments list --config wildcard-router/wrangler.toml`.

## What was verified, and what was not

| | Status |
|---|---|
| A code path that rewrites every record of every whole-list collection on every push, when a till's clock is 2+ minutes behind the server | **Reproduced** on the real `ShopStore` (SQLite) and the real `recordPush` (D1 stand-in). 381 records = 383 row changes per push (2 with a correct clock). 70 bills/debts = 140 D1 row changes per push (0 with a correct clock). |
| That this is what generated the 574.9M Durable Object rows and 138.4M D1 rows in the bill | **NOT verified.** It is the only mechanism found that is large enough, matches both products, and needs only an ordinary condition (a tablet with a wrong clock). Production metrics are needed to confirm it - see "Confirm it" below. |
| That the fix lowered production usage | **NOT verified.** Only measured on a test copy. |
| KV reads (49M), Workers requests (31M), DO requests (26M), Workers CPU | **Not analysed as a leak.** Their size is in line with devices polling `/api/pos-sync` every 7 s (about 370,000 polls per device per month), plus a KV read for the licence and the shop mode on each request. Not changed. |

## The mechanism

1. Every push carries `updatedAt: Date.now()` from the till, and the WHOLE of every list that is not a log (inventory, customers, staff, bills, debts, tabs, cash shifts ...).
2. If that clock differs from the server's by 2 minutes or more, `correctClockDrift` (functions/api/_merge.js) shifts every record's `updatedAt` by the difference.
3. The shifted copy is newer than the stored one, so it was written: in the shop database one UPDATE per record (table row + `seq` index), in D1 one UPDATE of `ledger_records` plus an audit row (the separate audit database in production).
4. The till then pulls the server's copy and sends it again on the next push, shifted again - so it repeats on every push, and the stored stamp walks further into the future each time (10 minutes per push for a clock 10 minutes behind).
5. Pushes happen on every focus, tab switch, reconnect, socket open and edit, from every device of the shop.

A clock AHEAD of the server is harmless (stamps shift backwards, the stored copy is newer, nothing is written).

## What changed (server side only; no app update needed)

| File | Change |
|---|---|
| `wildcard-router/shop-store.js` | A record that differs from the stored one only in its top-level `updatedAt` is not written. Counters + a log line per drifted till. `/stats` reports them. `SYNC_STAMP_GUARD=0` restores the old behaviour. |
| `functions/api/_ledger.js` | The ledger upsert ignores `updatedAt` on both sides of its "has this record changed" test (the `version` column still carries it; what is stored is unchanged). `LEDGER_STAMP_GUARD=0` restores the old test. |
| `functions/api/_ledger.js` (zip 252) | Also: `ledger_bills` and `ledger_sale_items` write only on a real column difference; the repeat-send fingerprint ignores `updatedAt`. Test: `tests/zip252-d1-all-paths.test.mjs`. Left alone: `ledger_sales` header (rare unacknowledged re-sends), KV blob (one write per push, not billed). |
| `functions/api/owner-storage.js` | Adds the guard counters to each database shop in the Owner Console storage reply (additive). |
| `tests/zip251-clock-drift-writes.test.mjs` | 10 tests: drift writes nothing, real edits still write, tombstones are real changes, both switches work. 5 of them fail on the previous code. |

Real edits are untouched: an edit changes content (or status, amount), which is still compared and still written.

## What this does NOT fix (decide separately)

* **Time stamps already pushed into the future.** Records of shops that had a drifted till may carry `updatedAt` days, months or years ahead of now. A correct-clock edit to such a record can lose the "newest wins" comparison. The fix stops the walk; it does not rewrite stored data (no data was changed in this zip). `/stats` -> `guard.futureStamped` counts them per shop (read-only) so the size of the problem can be seen before deciding on a repair.
* **A device with a wrong clock.** Set it to automatic date and time. The router log now names it (see below).
* **A no-op push still writes 2 small bookkeeping rows** (the shop's `updatedAt` and the device list) and pokes the other devices. Left alone: changing it touches sync ordering and was not shown to be the bulk of the cost.
* **Polling volume.** 7-second polls from every open device are what the request lines measure.

## Confirm it (read-only, Cloudflare dashboard)

1. Workers & Pages -> Durable Objects -> the `ShopStore` namespace (script `mydukapos-wildcard-router`) -> Metrics: compare *rows written* per day. Expect a steady high daily figure before the deploy and a sharp fall after it.
2. D1 -> `mydukapos-ledger` (and `mydukapos-audit`) -> Metrics: *rows written* per day, same comparison.
3. Live log of the router (shows which tablet has the wrong clock; one line per till per 10 minutes):
   `npx wrangler tail mydukapos-wildcard-router --format pretty --search "device clock is off"`
4. Per shop (Owner Console storage reply, field `db.guard`): `timestampOnlySkipped` large = this was happening for that shop; `driftedDevices` lists the tills and their offsets; `futureStamped` = records with stamps more than a day ahead.

If the daily rows written do NOT fall after the deploy, this was not the (only) cause: keep `wrangler tail` open on the router and on the Pages project and look at which route and which shop dominates; do not delete anything.

## Switches (all take effect on the next request; no redeploy)

| Variable | Where | Effect |
|---|---|---|
| `SYNC_STAMP_GUARD=0` | router Worker `mydukapos-wildcard-router` -> Settings -> Variables | shop database goes back to the previous write rule |
| `LEDGER_STAMP_GUARD=0` | Pages project `mydukapos` -> Settings -> Variables | D1 ledger goes back to the previous comparison |
| `AUDIT_WRITES_DISABLED=1` (existing, zip 186) | Pages project | stops audit-trail rows only; sales and records still save |

Budget alerts only notify. There is no automatic spending cap on Workers Paid.
