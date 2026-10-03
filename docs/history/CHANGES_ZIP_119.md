# Zip 119 — Everything left from the brief: unique receipts, tenant-only payment keys, refund limits, till/shift on every sale, safe tabs & shifts, fresh reports, sync journal, router hardening

Builds on zip 118 (stock ledger for every app including Aqua). Each item below was a gap found in the zip 118 review.

## 1. Receipt references are unique across all tills (Phase 5)
**Before:** each till counted up its own copy of one shared number and synced it later, so two tills selling at the same time
printed the **same** `ref-000001xx`.

**Now:**
* The server hands every device a **till number (1–99)**, once (`allocateTill`, both backends). Devices can't write the map.
* A reference is **(the till's own count × 100) + till number**: till 3's 7th sale is `ref-00000703`. Two tills can never produce
  the same one, online or offline. It stays all digits, so typing or scanning it in Daily Sales and Returns works as before.
* New references always start **above every reference already issued** (the old shared counter is the floor).
* A brand-new device that has never reached the server uses `ref-D<device code>-<n>` until it gets its number. That form is
  still unique.
* One shared `generateReceiptRef` replaces the seven per-app copies.

## 2. Payment credentials are the shop's own — no global fallback (Phase 9)
**Before:** every credential field fell back to a Cloudflare environment variable. A shop that had not saved its own keys
took payments **through the platform's account**, and a shop that saved only some fields had them mixed with the platform's.

**Now** (`functions/api/_gateway-config.js`):
* Keys, secrets, shortcodes, pass keys, the Paywave API key and email come **only** from what that shop saved in Settings →
  Payment Gateway.
* Each provider is taken as a **complete set**, never mixed with anything else.
* The environment set is used **only** for a shop you list by id in `GATEWAY_ENV_FALLBACK_CLIENTS` (for a shop that really
  runs on your own account), and only if that shop saved nothing for that provider.
* Non-secret defaults (sandbox/production, transaction type) may still come from the environment.
* **Action for you:** if any live shop takes M-Pesa/Paystack payments **without** having saved its own keys in Settings,
  either have it save them, or add its id to `GATEWAY_ENV_FALLBACK_CLIENTS` in the Pages settings before deploying.

## 3. A receipt can't be refunded twice (Phases 8/18)
`returnQtyGuard`: a return, exchange or pending exchange picked from a receipt is limited to what that receipt sold, minus
everything already returned against it **on any till**. This applies in all 7 apps and all three flows. A voided receipt
can't be returned at all. The restock itself was already exactly-once (zip 118 ledger).

## 4. Hotel tabs and cash shifts merge safely
`NESTED_MERGE` (both backends):
* **Hotel tabs:** orders from two tills added to the same open tab in the same sync window are **both kept** (unioned by
  id). A tab's status only moves forward (OPEN → CLOSED/VOID), so a stale till can't re-open a settled tab.
* **Cash shifts:** manager adjustments from two devices are both kept, a closed shift stays closed, and an approved/rejected
  variance is never put back to "pending" by a stale copy.

## 5. Every sale and stock movement says where it came from (Phases 5/7)
* **Sales** carry `ctx = { till, device, station, cashier, cashierId, shiftId, branch, host }`. It is captured when the
  receipt reference is issued and attached only to sales **this** device issued (never guessed for other devices' records).
  It is shown in the Audit tab.
* **Stock movements** carry `dev`, `till`, `stn` and `tries` (how many times the device sent it). Queue state is visible
  per movement: no `_srv` means waiting; `_srv` means acknowledged by the server with its before → after.

## 6. Sync journal in the Audit tab (Phase 12)
A new **"Sync"** filter shows sends (summarised at most every 30 minutes), **failed sends and why**, **retries**, and **stock
conflicts the server resolved** for this device (a count superseded by a later one, a count made against an old figure).
It is kept separate from business events, so a retry never looks like a second sale or stock change.

## 7. Reports say how fresh they are; Z Reports only from synced data (Phase 10)
* Every report (and Aqua's X/Z) shows **"✓ Up to date with the server as of …"** or a warning that this device has
  unsent changes. It then syncs in the background and **rebuilds itself** if newer data arrived.
* **Finalizing a Z Report** first sends everything and fetches the latest. If anything is still stuck on the device it
  is **refused**. With no connection at all, the manager is told plainly what it will be based on and must confirm.

## 8. Optional router hardening (Phase 16/24)
Set the same `ROUTER_SHARED_SECRET` on the **router Worker** and the **Pages project**. The shop hostname forwarded by the
router is then believed only when it comes with that secret, so a caller hitting the Pages domain directly can no longer
claim to be a shop's subdomain. Without the setting, behaviour is exactly as before.

## 9. Performance (Phase 14/23)
Measured in the real app with 5,000 items and 3,000 sales, zip 117 vs 119 (ms, two runs each):

| | 117 | 119 |
|---|---|---|
| start-up | 3236–3335 | 3230–3377 |
| product search per keystroke | 21.7–22.8 | 22.0–22.1 |
| barcode scan | 0.9–1.9 | 1.0–1.1 |
| add to cart | 25.6–27.6 | 27.1–27.2 |
| inventory table render | 50.6–64.1 | 58.6–58.8 |
| building a push | 49.0–51.3 | 52.9–53.1 |

No regressions, and nothing slow enough to need work at this size.

## Tests added
`tests/multi-till.test.mjs` (5 tills offline, unique references, sale context, sync journal, report freshness, Z-report
rule), `tests/gateway-credentials.test.mjs`, tab/shift/till tests in `tests/stock-ledger.test.mjs` (both backends), the refund
limit across two tills in `tests/replay-idempotency.test.mjs`, and the router-secret test in `tests/tenant-isolation.test.mjs`.

## What code alone cannot cover
* **Server-checked logins and station/cashier permissions** — by your earlier decision (`SYNC_AUTH_DESIGN.md`) the tills sign in
  offline, so permissions are enforced on the device. Server-side enforcement needs that decision revisited.
* **Your live Cloudflare account** (Phase 21) and **real devices, printers and browsers** (Phase 22) — see the checklist in the
  delivery message.
