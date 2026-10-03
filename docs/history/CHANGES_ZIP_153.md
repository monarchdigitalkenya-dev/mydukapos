# MyDukaPOS zip 153 — D1 transaction database, QR ordering, hotel POS, store transfers

Every item: ROOT CAUSE / FILES / FIX / ARCHITECTURE / TEST / RESULT / REMAINING RISKS.
**Nothing here was run on a real Cloudflare D1, a real phone or a real printer** (none exist in the build environment).
"Tested" = the automated suite in `tests/`, where D1 is a real SQL engine (node:sqlite behind a D1-shaped fake, `tests/d1-fake.mjs`), so constraints,
triggers and batch transactions are real SQL, and KV/Durable Objects are fakes.

## 1. D1 is the authoritative record of money
- ROOT CAUSE: sales, payments, bills and stock movements lived only in KV blobs merged by timestamp — no constraints, no history, no way to prove a total.
- FILES: `functions/api/_ledger.js`, `_ledger-schema.js`, `ledger.js`, `pos-sync.js`, `migrations/0001_ledger.sql`, `wrangler.toml` (binding `LEDGER_DB`, now active with your database id 12f9b35e-d4d9-468d-ac8c-2b3ff6b3848d).
- FIX: every push writes sales, lines, payments, bills, expenses, returns, stock movements and audit rows to D1 **before** the push is acknowledged. A D1 failure answers 503 and the till keeps the work and retries.
  Webhook payments (M-Pesa) that arrive while D1 is down are parked in a KV outbox and drained later.
- ARCHITECTURE: one D1 batch = one SQL transaction. Re-sending the same sale changes nothing (idempotent keys). Financial rows are never deleted (triggers); the audit trail is append-only (trigger). A void changes status, it does not remove.
  Cash and M-Pesa only. Card is not recorded.
- TEST: `ledger-d1` (9). The shipped migration file is asserted identical to what the code creates.
- REMAINING RISKS: schema is created on first use as well as by the migration. Real D1 latency and limits (batch size) were not measured.

## 2. Double settlement of one bill
- ROOT CAUSE: two tills could both settle the same bill and both count as revenue.
- FIX: the first COMPLETED full settlement counts; a second is stored as `DUPLICATE`, excluded from reports, and reported back to the till that sent it (warning toast). Reconcile lists `duplicateSettlements`.
- REMAINING RISKS: this is detected **after** the second till has taken the customer's money — there is no cross-till pre-lock. The cashier is told to refund/void the duplicate.

## 3. QR ordering for tables and rooms
- FILES: `functions/api/qr-order.js`, `order/` (customer page), `hotel/index.html`.
- FIX: stable QR id per table/room (rename keeps the code). Atomic claim: one conditional UPDATE, so two waiters at once → exactly one owner. Only the owner prints the bill, decides cancel/exchange requests, links. Managers may override.
  A guest's payment note is **not** a payment: the cashier confirms against a real sale in the ledger. Settling at the till marks the orders PAID and the table is released with a **new session**, so an old QR page cannot post to the next party.
  Guest cancel is free before claim and a request after; nothing after paid. Order tickets carry no prices.
- TEST: `qr-ordering`, `qr-d1-flow` (8, incl. concurrent claim, concurrent settlement, rooms vs tables).
- REMAINING RISKS: the live poke over WebSocket was replaced by an 8-second poll on the customer and waiter screens. Client outbox order (confirm → settle → release) is tested in jsdom only.

## 4. Hotel POS
Waiter-fast UI with decimal quantities; shot, **half shot**, double; posted-order actions Update Order / Print Bill / View Order; bill ids and cashier search; partial payments with states; inventory categories with Bar and Kegs inside Inventory; Bar/Kitchen classification, dish costing and profitability; facility tickets (flat or weekday/weekend, Sat/Sun in East Africa Time, per person); printer table, routing and failure fallback (a failed ticket is reported, the order stays on the bill and the Kitchen & Bar display); unified reports read D1.
- TEST: `waiter-orders`, `hospitality-*`, `bar-pours`, `hotel-zip153-misc` (half shot, day pricing, printer failure, no card).
- REMAINING RISKS: printers were never driven for real; the printer table shows the **last known** result per station, not a live link check.

## 5. Store (warehouse) on D1 — atomic Store → Branch transfers
- ROOT CAUSE: the store was one KV blob read, changed and written back. Two withdrawals at once could both succeed; a withdrawal was not tied to the branch that got the stock; and an item taken to zero was **deleted** from the list with its history.
- FILES: `functions/api/store.js`, new `functions/api/_store-d1.js`, tables `store_items` / `store_movements` (schema v2), `takeFromStore` + new `storeApplyWithdrawn` / `storeClaimTransfer` / `storeReconcilePending` in all six app `index.html`.
- FIX: quantity has `CHECK (qty >= 0)`; a withdrawal larger than the stock aborts the **whole** batch (nothing partial, 409). A transfer records who, when, from, **destination** and stays `IN_TRANSIT` until the destination confirms (`receive`, idempotent, destination only) or it is cancelled in transit (stock returns exactly once). A retry with the same `idemKey` returns the same transfer. Zero stock stays listed; "delete" archives. Movements are never deleted (trigger).
  First use per group imports the old KV items and log once (guarded, safe to race, KV left untouched as a backup). Without a D1 binding the old KV path still runs, with the zero-stock delete fixed.
  On the till, a transfer is added to inventory exactly once (keyed by its movement id) even if the reply is lost; anything taken but not applied is picked up when the Store tab opens.
- TEST: `store-d1` (8: merge, zero kept, all-or-nothing, concurrent withdrawals, idempotent retry, receive/cancel, group check, KV import), `store-capture` (2).
- REMAINING RISKS: the store list in KV (`store:<group>`) is no longer written once D1 is bound; do not run old and new code against the same data. Branch-to-branch destination is supported by the API (`destClientId`); the UI still defaults to "this branch" — no destination picker yet. Stock movement log entries for a received transfer are not written to the hotel stock ledger.

## 6. General Shop leftovers
- **Capture List → Store**: new button on the Store tab. A photographed delivery note is reviewed in the same review screen and added to the **Store** (merge by code then name), not to this branch's inventory.
- **Bottle / shot / tot**: item editor → "🥃 Bottle / shot / tot". Built on the existing box-and-piece stock (a bottle is a box of N ml). Shot and Tot buttons appear in search results and the cart; each line is measured in **ml** at its own price, a new bottle opens itself, and it never sells more ml than exist. Stock, void and sync work as for any loose piece.
- **Sales counter stock**: every search result now shows what is in stock (sealed bottles / boxes and loose ml for bottle items).
- TEST: `shop-pours` (3: set-up validation, cash total 580 for shot+shot+tot, stock display).
- REMAINING RISKS: a shot line's quantity is shown in ml (e.g. 50 for two 25 ml shots) — correct for stock and price, but the receipt says "50 ml". Only the General Shop (`index.html`) has this; other non-hotel apps do not.

## 7. Owner Console as an Android app and a Windows installer
- FILES: `native/apps.json` (8th app, `"fixed": true`), `native/android/app/build.gradle` (flavour `owner`, `BuildConfig.FIXED`), `MainActivity.java`, `native/windows/main.js`, `build.mjs`, icons (`src/owner/res`, `build/owner.png`), both workflows (now expect 8 apps / 16 installers), `native/README.md`.
- FIX: the app opens `https://<root domain>/owner/` directly; no shop-link screen and no licence check (the console has its own login). Same signing keys as the other apps.
- TEST: syntax checks only (`node --check`). **The Android and Windows builds were NOT run here** (the build environment cannot reach the Android SDK / Windows runner) — the first GitHub run is the first real test.
- REMAINING RISKS: the Owner Console app is for the owner only; do not publish it to shops.

## Verification
`npm run check` (apps match `src/shared/`), `npm run lint` (no undeclared names), full `npm test` — see RESULT below.
RESULT: one full `npm test` run: 1433 tests, 1419 passed, 14 failed. After that run:
- 6 were tests that were out of date with the new design and were updated (Bar & Kegs now inside Inventory; card removed from the hotel; QR needs D1; Bar/Kitchen column added to the inventory table; hospitality reports drawn directly; hotel past-sale has no card).
- 2 were real bugs found by the suite and fixed: (a) bartenders/supervisors were given Bar & Kegs but not Inventory, so they could no longer reach it — they now open Inventory showing only Bar & Kegs; (b) an unreachable station printer said "did NOT print" although the ticket had printed at the till.
- 1 was a real defect in `pos-sync.js`: the "no database" marker write could raise an unhandled rejection and added a background task per push; it is now throttled and fully caught.
- 4 timing failures (hidden-sales, multi-till, 2 multi-device-chaos seeds) only occurred while the machine was running the whole suite at once; each passes when run by itself.
Then re-run together, all passing (91/91): bar-kegs, hospitality-final, hospitality-orders, kitchen, split-bill, staff-sessions, sync-busy, hotel-zip153-misc, store-d1, store-capture, shop-pours, qr-ordering, qr-d1-flow, ledger-d1. `npm run check` and `npm run lint` are clean.
I did NOT run the whole suite a second time after those fixes (it takes about two hours here). Run `npm test` on your machine before deploying.
Note: when a test file fails, its browser windows stay open and the test runner can wait on them; that is how a single failure made the first run so long.
