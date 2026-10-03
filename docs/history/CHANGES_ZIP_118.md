# Zip 118 — Stock-take data corruption (P0): stock ledger, exactly-once movements, replay-safe voids/checkout/payments, Aqua POS in line

## The bug, reproduced (not guessed)

Two symptoms were reported: a stock take **reverting** (after a refresh, on another device, after a sync) and stock being
**added again and again** (100 → 120 → 140 → 160).

Both were reproduced with the real app (jsdom) talking to the real `pos-sync` server code. A randomised stress run used
3 tills, one stock take 100 → 120, then random sales, refreshes, pulls, pushes and offline periods:

| run      | truth (120 − sold) | before zip 118 | zip 118 |
|----------|-------------------:|---------------:|--------:|
| seed 17  | 111 | **94**: stock take wiped, back on the old 100 | 111 |
| seed 11  | 114 | **116**: sales lost, stock too high | 114 |
| seed 13  | 113 | **117**: sales lost, stock too high | 113 |
| zip-56 code, seed 7 | 118 | 117 | — |

## Root cause

Stock quantities synced as **plain numbers, whole record, newest `updatedAt` wins**. Every till kept its own copy of each
quantity, did its own arithmetic and pushed back the result. The server picked whichever record carried the newest
timestamp. So:

* **Revert.** Till A counts 120. Till B hasn't pulled yet and sells one. Its record says 99 with a *newer* time, wins the
  merge, and the count is gone.
* **"Added again" / numbers too high.** Two tills selling from the same starting number lose one of the sales. Stock reads
  higher than the shelf.
* **Repeated addition (100 → 120 → 140 → 160).** An additive "quantity reconciliation" replayed movement deltas on top of
  numbers that already contained them. It was disabled in `_merge.js` in zip 76, but it also lived inside the **per-shop
  database** (`wildcard-router/shop-store.js`), which only ships with `npm run deploy:router`. Your deploy notes say to skip
  that step, so any shop moved to the database may still be running the pre-zip-76 code.
* **Pharmacy/Hospital batch items.** A stock take changed `qty` but not the batches. The next sale recomputes `qty` from
  the batches, which put the count back.

## The fix: the server owns stock, and every movement is applied exactly once

`functions/api/_merge.js → applyStockLedger()` is used by **both** backends: the single-record KV backend and the per-shop
database.

* For an item the server already has, the `qty` / `pieceQty` / variant `qty` a device sends is **ignored**. The server
  changes stock only by applying **stock movements it has never seen**, matched by the movement's immutable `id`. The same
  movement arriving again (retry, refresh, offline resend, second device, lost reply) is already stored and is skipped.
* **Stock take = absolute count** (`kind: 'count'`: "at time T there were N"), never a +/−. The server sets
  N + whatever it already applied that happened after T. A movement stamped at or before the item's latest count (an
  offline till's older sale arriving late) is recorded but doesn't move the stock again, because the count already
  includes it. An older count arriving after a newer one is recorded as **superseded**. So two devices counting, a stale
  device or a replay can never stack a count.
* **Audit truth** is stamped on every movement by the server: `_srv = { applied, before, after, sv, at, reason?, stale? }`.
  That gives previous authoritative qty → final qty, applied or not and why, and whether the count was typed against an
  out-of-date figure. Stored movements are **immutable**, so a re-sent copy can't overwrite that record.
* **Stock version** `_sv` per item (+1 per applied change). A count carries the `baseSv` the device saw. `_sq` / `_sp`
  echo the authoritative figures the device last received. `_ct` is the time of the latest count.
* New items are taken as sent. Batch items get their batches aligned to the authoritative qty: a shortfall comes off the
  soonest-expiring batch first, and a surplus becomes one "Stock adjustment" batch. The device does the same at stock-take
  time.
* `inventory` (Shop, Hotel, Hospital, Pharmacy, Production, Services) uses `applyStockLedger`. Aqua POS uses the same rules in
  `applyCellLedger` (see below).

### On the device (`src/shared/functions.js`, synced into every app)

* `logStockCount` / `stockTakeRecordCount`: the Stock Take tab records one count movement per changed figure, with a
  `stocktakeId`, device id, `before`, `counted` and `baseSv`.
* `reconcileLocalStockChanges`: a safety net. If any screen changed a quantity without logging a movement, the difference
  from (server figure + this device's pending movements) is logged **once** as a "Stock correction (change not itemised)"
  movement with its own id.
* `stockApplyPulledLedger`: a pull takes the server's figures and lays this device's not-yet-confirmed movements on top,
  so the screen doesn't jump back.
* `stockRecSig`: selling an item no longer makes this device's whole (maybe stale) copy of it "the newest edit". That was
  also putting back other tills' price/name edits after a sale.
* Everything above is **off until the server says it applies the ledger** (`_ledger` on a pull, `ledger` on a push
  reply). A shop whose server isn't updated yet keeps the old behaviour instead of half-switching.
* After a push that carried stock movements, the device pulls the server's result. `pullState()` no longer drops a pull
  that was requested while another one was in flight.
* **Stock Take history** now comes from the synced movements, so every device sees the same list, with Was / Counted /
  Adjustment / Now and the server status (✓ applied, ⏳ waiting to sync, ⚠ superseded). Older per-device history is
  still shown underneath.
* **Stock reports** use the server-confirmed effect of each movement (`stockMoveDelta`), and the **Audit tab** shows
  counts as counts, confirmed before → after, and "NOT applied" / "waiting to sync" (`stockMoveAuditText`).

## Aqua POS brought in line (zip 118b)

Aqua keeps stock in three different ways, and each one had the same bug class:

| Aqua stock | Before | Now |
|---|---|---|
| Finished goods per site (`products[].stock[site]`) and bottle counts per site (`bottleStockBySite`) | Newest per-site timestamp wins. Two Shop tills selling from the same figure lost a sale; a stale till could put an old figure back | Ledger **cells**: each change applied once |
| Tank litres (`tanks[].currentVolumeLiters`) | Whole tank record, newest wins | Ledger cell |
| Raw materials (`rawMaterials[].stockQty`) | **The whole list** was replaced by whichever device pushed last: other devices' material edits and counts were lost | Merged per record; quantity is a ledger cell |

* `applyCellLedger` (`_merge.js`, both backends) follows the same rules as the shop apps: immutable ids, applied once, absolute
  counts with the time rule, `_srv` audit, `_ss` echo of the server's figures. Aqua never shows stock below zero, so cells stop at 0
  (the audit keeps the true before/after).
* Aqua's screens change stock in ~28 places by editing numbers directly. So on every push the app sends, per cell, **one
  movement for the net change** since the server's last confirmed figure (`aquaReconcileCells`), with its own id. A retry or
  resend is recognised by that id.
* **Safe rollout.** A till still on the old cached Aqua app sends plain numbers and no movements. Ignoring them would lose its
  sales until its app updates, so the server applies the Aqua cell ledger only to pushes from an updated app (marked `_cells`,
  sent once that app has seen the server's `_ledger` flag). Older pushes keep the previous merge rules. The shop apps don't need
  this, because their old builds already logged a movement for every sale.
* **Aqua 📋 Stock Take tab** (new): counts one site at a time — finished goods (bottle-tracked bales in bottles), tank litres and
  that site's materials. Absolute count movements, per-line or bulk apply, the same synced history as the other apps. It can be
  locked or granted to staff like any tab, and is covered in the Aqua user guide.

## Integrity check, stock-take report, security, performance (Phases 11, 13, 16, 19, 23, 24)

* **Integrity check** `ledgerIntegrity()` confirms, per item and per Aqua cell, that the applied movements chain (each starts
  where the previous ended), end at today's figure, and that no movement id appears twice. It runs after every server test
  scenario on both backends. A dedicated test proves it catches the exact corruption of this bug (120 → 140 replay, 119 → 99
  revert, broken chain).
* `GET /api/stock-integrity` (read-only, scoped to the link's shop) returns the server's check and figures. The new
  **🔍 Check stock against the server** button on every Stock Take tab sends anything unsent, then compares every figure on the
  screen with the database, and the database with its history.
* **🖨️ Print** on each stock take prints an A4 report: item, was, counted, adjustment, now (server-confirmed), status, user, device,
  date/time and stock-take id.
* **Tenant isolation tests** (`tests/tenant-isolation.test.mjs`): ids in the body (`clientId`, `c`, `tenantId`, `shopId`,
  `branchId`), `?c=` naming another shop on a shop's own subdomain, a movement or count naming another shop's item or tank, and
  unknown links. None of them can reach another shop. Finding, left as is: `X-Forwarded-Host` is trusted from any caller. It
  doesn't widen access under the link-is-the-credential model (anyone who knows a link can open it), and hardening it needs a
  shared secret between the router and Pages.
* **Performance** was measured on a 5,000-item shop with 60,000 movements and 30,000 sales (ms per sale push, 3 runs):

  | | zip 117 | zip 118 |
  |---|---|---|
  | single-record (KV) merge | 16.9–19.2 | 22.1–25.4 |
  | per-shop database push | 69–71 | 69–94 |

  The first version of the ledger made database pushes 3× slower (it re-read all 5,000 items on every push). It now keeps the
  server's figures inside the existing per-row write and runs the full ledger only for items with new movements.

## Other replay bugs found in the global audit (Phase 8) and fixed

| Mutation | Received twice before | Now |
|---|---|---|
| **Void a sale** (all apps) | No "already voided" guard. A double tap, or a second till that hadn't seen the void, gave the stock back **twice** | Guarded, and void movements get deterministic ids (`void:<saleId>:…`), so the server restocks once whichever device sends it |
| **Checkout** (Shop, Services, Hotel, Pharmacy: async checkouts) | A second tap while the first was still waiting on the network (cross-branch stock, payments) could record the same cart **twice** | One checkout at a time |
| **M-Pesa C2B / KCB confirmations** | A provider retry overwrote the payment with `matched: false`, so a payment already attached to a sale could be attached **again**, and it was listed twice | First copy wins; the index lists it once |
| **STK / Paystack / Paywave callbacks** | A late or repeated "failed" could downgrade a completed payment | A completed payment is final |
| Sales, returns, expenses, customers, bills, settings | Already keyed by id / bill-progress / per-field stamps | Unchanged (verified) |

The tenant-specific payment-credential architecture is untouched: no credentials were moved, merged or exposed.

## Tests

* `tests/stock-ledger.test.mjs`: server rules on **both** backends. Refresh × 20, retries, stale device, 5 tills selling,
  an offline sale before a count, two counts in either order, a stale-figure flag, new items, variants, loose pieces,
  batches, immutable audit.
* `tests/stock-take-sync.test.mjs`: the **mandatory stock-take tests 1–11** with the real app. These cover 20 refreshes,
  logout/login, browser/device restart, duplicate requests, offline sync and repeated offline sync, two devices, a stale
  device, simultaneous stock takes, 5 tills selling during a stock take, the safety net, and a pharmacy batch item.
* `tests/replay-idempotency.test.mjs`: payment webhooks, a double void across two tills, and a triple checkout tap.
* `tests/water-stock-ledger.test.mjs`: Aqua — two Shop tills selling, Production output, tanks, materials, offline + replay,
  Stock Take, and the check button.
* `tests/tenant-isolation.test.mjs`: see above. The integrity check also runs inside the multi-till end-to-end tests.
* Updated: `tests/shop-store.test.mjs`, `tests/two-devices.test.mjs` and the Owner Console DB self-test. They used to
  **assert the lost-sale behaviour** (10 − 1 − 1 = 9). They now expect 8.

## Deploy — the router step is NOT optional this time

`npm run deploy:router` must run. It carries the per-shop database code, which is where the old additive reconciliation
(the 120 → 140 → 160 symptom) may still be live. Until it is redeployed, database-mode shops keep their old server, and
the apps deliberately keep the old behaviour for them (they wait for the `_ledger` flag).

## Known limits (honest list)

* Tills can still sell while offline, so stock can go negative on the server when two offline tills sell the last unit.
  That is now **visible and correct arithmetic** instead of a silently lost sale.
* The "counted after the sale" rule relies on device clocks (already drift-corrected by the server on every push).
* Restoring a backup on the server, then having devices re-send movements made after that backup, re-applies those
  movements. This is the same class of behaviour as before (their records used to win the merge).
* Two browser tabs on one device running *different* app versions at the same time could double a change that wasn't
  itemised. This clears itself once the service worker updates the old tab.
* Server-verified logins stay out of scope by the owner's decision (see `SYNC_AUTH_DESIGN.md`). Tenant isolation remains
  link-based (the server derives the shop from the link, never from a body field).
