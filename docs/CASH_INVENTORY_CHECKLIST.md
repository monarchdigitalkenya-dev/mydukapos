# Cash float + serialized inventory + variants + imports: audit and checklist

## Audit findings (what exists)
- Shop app = `index.html` (single-file PWA). Shared logic: `src/shared/functions.js` (synced by `npm run sync`), blocks in `src/shared/blocks/`.
  State is localStorage-first, pushed to `functions/api/pos-sync.js` (D1/KV/DO), merged per record by `functions/api/_merge.js`.
- No cash float / drawer count existed in the Shop. Hospital has `cashShifts` (one shift per cashier account = the model the brief rules out), left untouched.
- "Till" = a device number only (`tillNumber()`); no cashier-point entity. Device id = `pos_device_id`.
- Variants = `product.variants[]` embedded in each product (name, code, price, qty). No IMEI/serial tracking. No import wizard beyond bulk add.
- Sale: `checkoutCartOnce` builds `saleRecord` -> `salesLog`; `cashAmount` is the amount applied to the sale (net of change).
  Bill settlements post a normal `salesLog` entry on the payment day. Returns record no refund method; expenses record no payment method.
  => cash refunds / drawer expenses must be explicit linked movements, never inferred.

## Status
| Part | Requirement | Status | Where |
|---|---|---|---|
| 1.1 | Settings, default ON, per tenant, never deletes history, skipped/exempt recorded | DONE | `cashConfig`, block screen "Cash settings" |
| 1.2-1.4 | staff / device / cashier point / session separation; shared terminal; independent tills | DONE | `cashResolvePoint`, `cashOpenSession` |
| 1.5 | Opening count UI (denominations or total), confirm, concurrency-safe | DONE (deterministic session id + merge) | block `cash-drawer.html` |
| 1.6 | Live drawer panel + movements (idempotent) | DONE | block, `cashMakeMovement` |
| 1.7 | Expected cash from committed records only; split payments; voids | DONE | `cashSessionSummary` |
| 1.8 | Closing count, variance, reason, manager approval, no silent adjustment | DONE | `cashCloseSession`, `cashDecideApproval` |
| 1.9 | History, filters (point/status/dates/operator/differences), consolidated total, CSV export, print 58/80/A4 | DONE (print layout is basic) | block, `cashFilterSessions`, `cashSessionsCsv` |
| 1.5 | Corrections after closing (manager, reason, original kept) | DONE | `cashCorrectClosing` |
| 6.3 | Offline duplicate open/close | DONE: earliest count wins, other kept as conflict | `_merge.js` cashSessions |
| 6.4 | Audit trail | PARTIAL: the immutable session/movement records carry actor/time/device; no separate audit-log entries | |
| 2 | Serialized units (IMEI) | NOT STARTED | |
| 3 | Inventory workspace, first-class variants, ledger, transfers | NOT STARTED | |
| 4 | Import wizard | NOT STARTED | |
| 5 | Purchasing integration, ledgers | NOT STARTED (cash/inventory ledgers kept separate by design) | |

## Known limits of the cash work
- Voiding a sale that is already stamped removes its cash from expected cash (final state), as intended.
- Sales made before a session existed (bill settlements) are attributed by time window only in single-drawer shops.
- Cash Hospital/other apps unchanged (verified byte-identical).

## Tests
`tests/cash-drawer.test.mjs` (17). Regression subset run: checkout-*, hold-sale, multi-till, smoke, regressions, two-devices, tenant-isolation, zip156-server-merge.
Pre-existing failure (identical on the untouched zip): `zip168-checkout-workspace` test 1 ("pos-checkout class").
The full 381-file suite was NOT run (single-CPU sandbox, hours).


> UPDATE (zip 291): the table above is superseded by the detailed, honest status in `docs/HANDOFF.md` (serial / variant / import ENGINE now exists and is tested, but has no screens).
