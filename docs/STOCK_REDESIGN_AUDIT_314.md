# Stock management redesign: audit and phase plan (zip 314)

Status: **Phase 4 (import / export) done in zip 314.** Everything else below has been audited and is still to do.
Each later phase ships as its own tested zip.

## What exists today (Shop app, from the code)

| Area | Where it lives | State |
|---|---|---|
| Inventory list | `inventory-list-tab` (Stock folder in the side menu) | Works. One row per product; variants are only visible in the Inventory workspace (`inventory-pro` block). |
| Add New Items | `add-item-tab`: single, bulk, and a variants draft | Works. Variants are structured (`product.variants[]` with `id`, `code`, `attrs`, own prices, `qty`, `barcode`, `minimumPrice`, `reorderLevel`, `active`). |
| Inventory workspace | `inventory-pro` block (overlay): overview, item detail, variant generator, adjustments, serial units, import wizard | Works. It is a pop-up, not a side-menu tab. |
| Restock | `restock-tab`: suppliers list + "Restock (Add Stock by Supplier)" on the same page | Works. Every restock is one purchase record (zip 269) and logs stock movements. |
| Suppliers | Inside `restock-tab`: `{ id, name, phone }` only | **Gap.** No supplier code, terms, balance, payments, statement, returns or credits. |
| Supplier Orders | `orders-tab` (`purchaseOrders`): Pending → In Transit → Arrived, then one confirm adds stock | Partial. No partial delivery, no supplier invoice / due date, no payments against an order. |
| Stock Take | `stock-take-tab` | Works (separate tab, synced). |
| Store / Store history | `store-tab`, `store-history-tab` (server store, zip 293/301) | Works. |
| Branch stock and transfers | Business HQ (zip 310/311): stores per branch, Move, Send to branch, confirm received with damaged / missing, all on the server (`functions/api/_stock.js`, `_xfer-actions.js`, D1) | Works. It is only reachable inside Business HQ, not from a Stock Transfers side-menu item. |
| Stock movement ledger | `stockMovementLog` (zip 118 stock ledger, merged on the server) | Works for sales, restocks, adjustments and imports. Movements carry no branch / location / batch fields. |
| Batches and expiry | `product.batches[]` per **product** (used by Pharmacy) + `product.expiryDate` | Partial. There are no batches per variant, no supplier or purchase reference on a batch, and the Shop barely creates batches. |
| Units | `unit` + dual unit (`unitsPerBox`, piece prices) | Works for box ↔ piece. There is no general conversion table (carton → pack → piece). |
| Import / export | Old CSV (`downloadInventoryCsv` / `importInventoryCsv`) + the wizard engine (`importPlan`/`importApply`) | **Broken for variants. Fixed in zip 314** (below). |

## Root causes found

1. **The export dropped variants and batches.** `downloadInventoryCsv` wrote one row per product, with no variant columns and one expiry date. Fixed in zip 314.
2. **No import read what any export wrote.** The wizard needed a second "variants" file, knew 4 attributes only, and ignored barcode, wholesale selling price, minimum price, unit, VAT, location and expiry on update. Fixed in zip 314.
3. **Suppliers have no money side.** A supplier has no balance, payments or statement. The purchase record (zip 269) has a total but no paid / unpaid status. This is Phase 5.
4. **A purchase order adds all of its stock at once.** There's no partial receipt or outstanding quantity, and stock is added when the order is confirmed "Arrived", not per delivery. This is Phase 6.
5. **Movements are not location-aware.** Branch and store movements live on the server (HQ), while the till's `stockMovementLog` has no location or batch. Two ledgers need one reconciliation view. This is Phase 8.
6. **Batches are per product, not per variant, and are not FEFO-deducted for variants.** This is Phases 2C and 9.

## Phases

| # | Phase | Status / plan |
|---|---|---|
| 4 | Import / export | **Done (zip 314).** One "Products & variants" file both ways; any attributes; matching by SKU, then Variant ID, then Variant SKU, never by name; updates never move stock; `[clear]`; opening stock only on request and logged; a separate Batches file (received / opening / split-into-batches); stock-on-hand snapshot and movement export; templates and guide. 5 tests. |
| 5 | Suppliers tab | Next. A side-menu tab of its own: profile (code, terms, opening balance), purchases, payments (cash / M-Pesa / bank reference), statement with running balance, returns and credit notes. The balance is computed from posted entries only. A synced list on the existing merge rules, mirrored to the D1 ledger as the Money tab is. |
| 6 | Purchases and receiving | Purchase order → goods receipts (partial, with outstanding quantities) → supplier invoice → payments. Stock moves only on a posted receipt. Idempotent receipt ids. Reuses the zip 269 purchase record and Restock. |
| 7 | Stock Transfers tab | A side-menu entry that opens the existing HQ transfer engine directly (it already has dispatch, in transit, received, damaged / missing, compensating moves and server-side checks), with the source branch locked to the transfer, not to the branch on screen. |
| 8 | Movement ledger | Add branch, location, batch and reference fields to `stockMovementLog`; a reconciliation report (quantity on hand vs opening + movements) per item. |
| 2 / 3 | Add item and Inventory screens | Progressive form (simple item first; "has sizes / colours?" opens the generator); a product detail screen with Variants / Stock by location / Batches / Purchases / Movements sub-tabs; batches per variant. |
| 9 | Stock take, damage, expiry | Approval of variances above a limit; expired / quarantined batches out of sale; near-expiry warnings in the business time zone. |
| 10 | Reports | Valuation (cost vs retail), low / out of stock, expiry, movements, purchases, supplier balances, transfers, variances: each a focused report. |
| 11–13 | Offline, permissions, migration | Built into each phase above. These follow the existing sync rules (idempotent ids, the server keeps newer, tombstones), use the existing staff permission checks on the server, and need no destructive migration (new fields only; a reconciliation report before and after). |

## Action for the business owner (zip 314)

- Deploy with `DEPLOY_314.md`. There is no database change.
- To check: Inventory → "Export / Import products & variants" → Export products & variants. Open the file in Excel and change a price, save it as CSV, then import it with "Add new items and update existing ones". The preview shows 1 item to update, and stock is unchanged.
