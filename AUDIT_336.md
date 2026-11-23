# Audit zip 336 - stock integrity, FIFO/FEFO, packaging, cost & profit repair, HMIS counter

Scope as agreed: FIFO/FEFO batch costing in **Pharmacy and Hospital only**; everything else (Store <-> Inventory, packaging levels, cost corrections and profit adjustments, layout fixes) in **every module**. Aqua POS (water) has no Store and keeps its stock in `products` per site, so it gets the cost & profit tools and the layout fixes only.

## 1. Confirmed bugs and their root causes

| # | Bug | Root cause | Where |
|---|-----|-----------|-------|
| 1 | Store -> Inventory made a **second "Hospital gloves"** | The till matched the arriving line by code only when the Store line had a code. A Store line with its own code (typed in the Store, or a barcode) found nothing and a NEW inventory item was created. | `storeApplyWithdrawn` (a local copy in each of the 6 apps) |
| 2 | Inventory -> Store made a **second Store line** | Server rule: "same code, or - only when the line has NO code - same name". Every inventory item has a code, so its stock never found the Store's own code-less line of the same item. | `matchSql` / `addStatements` in `functions/api/_store-d1.js` |
| 3 | Only the Shop could move Inventory -> Store | The zip 318 "Move" existed in `index.html` only. | all other apps |
| 4 | **Hospital sold expired batches first** | `deductFefoBatches` sorted by expiry, so an expired batch (it "expires soonest") was taken first, and the total was reduced even when only expired stock was left. Pharmacy sold expired stock "last", but still sold it. | `hospital/index.html`, `pharmacy/index.html` `deductStockForSaleUnit` |
| 5 | Batches had **no cost**; profit used the item's current cost | A batch was `{batchNumber, expiryDate, qty}`; a restock overwrote `wholesalePrice`, and the sale line copied that one figure. | restock + checkout in both apps |
| 6 | A void / return went into "the soonest batch" | `batchesPutBack` had no record of which batch the sale used. | `src/shared/functions.js` |
| 7 | Hospital batches never added up | Restock raised `qty` directly and added a batch only when an expiry was typed; the server then invented a never-expiring "Stock adjustment" batch. | `hospital/index.html` `completeRestock` |
| 8 | "Gross Profit (after expenses)" | That figure is **net** profit; "Profit (before expenses)" is the gross profit. | Profits & Expenses tab + its print, every app |
| 9 | No safe way to fix wrong costs | Only "edit the item's cost" (changes nothing in the past) or hand-edit sales (dangerous). A sale line with no cost fell back to TODAY's cost in Reports. | `reportSaleCost` |
| 10 | No multi-level packaging | Only "Box & piece" (2 levels, two separate balances). | Add / Edit item |
| 11 | HMIS Sales Counter cramped | Queue, requests and the patient-bill box sat above the search; picture-less products were large empty boxes; on a tablet the totals bar was sticky OVER the cart lines; each cart line was 3 rows tall (dose box + 4 chips). | `hospital/index.html` + `hmis-cashier` block |
| 12 | Restock: suppliers list above the delivery; rows squeezed; Expiry horizon pushed the item list off a phone screen; one narrow summary card per row on a phone | layout only | Restock / Inventory / Profits tabs |

Automated scan (every tab of all 7 apps at 390 px and 820 px): **no sideways page overflow** anywhere before or after - the cramping was hierarchy and density, not overflow.

## 2. Data integrity risks found (existing data)
- Duplicate items / Store lines that already exist: now **listed** by the Store / Stock check, never merged automatically. Store lines can be merged by a manager (audited); inventory look-alikes are listed only (they may be different strengths).
- Batches without a cost (all batches made before zip 336): counted at the item's cost price and listed in the Cost check as "no batch cost". Nothing invented. "Record batch details" lets a manager give them a number / expiry / cost (logged).
- Stock with no batch on file in Pharmacy / Hospital: becomes one "Stock before batches" batch (no cost, no expiry) the first time the item is sold or restocked - the quantity is never lost.
- Two tills selling the same batch while both offline: the total is right (the server ledger counts every sale once); the per-batch cost of the extra units is approximate. Now reported ("Batches sold more than they held").

## 3. What was changed (files)
New: `src/shared/blocks/stock-engine.html`, `stock-pro.html`, `layout-fit.html`, `hmis-counter.html`, `functions/api/cost-control.js`, `functions/api/_stock-integrity-schema.js`, `migrations/0019_stock_integrity.sql`, `AUDIT_336.md`, `DEPLOY_336.md`, tests `zip336-*`.
Changed: `functions/api/_store-d1.js`, `store.js`, `_perm-guard.js`; `src/shared/functions.js` (`cartStockShortfall`, `restoreStockForSaleUnit`, `reportSaleCost`, `poApplyArrivedLine`); blocks `pay-confirm`, `accounts`; `pharmacy/index.html`, `hospital/index.html` (batch sale / void / restock); all apps (sale lines keep `packPer` / `lots`, profit labels, block markers); `tools/lib.mjs`, `tools/gen-migration.mjs`; every `sw.js` (zip-336).

## 4. Migration
`0019_stock_integrity.sql`: 6 new tables (store_lots, cost_corrections, profit_adjustments, cc_settings, stock_audit) with append-only triggers. No existing table or row is changed. The server also creates them by itself on first use. Repeatable (IF NOT EXISTS). Recovery: the tables are new - the previous release simply ignores them.

## 5. Tests (see DEPLOY_336.md for the results)
`tests/zip336-stock-engine.test.mjs` (FIFO, FEFO, packaging, identity, restore, corrections, offline concurrency), `tests/zip336-store-transfer.test.mjs` (real SQL), `tests/zip336-cost-control.test.mjs` (server-side manager proof, idempotency, append-only, closed books, sync guard), `tests/zip336-stock.browser.test.mjs` (real browser: transfers in 6 apps, packaging in 4, FEFO checkout in 2, the cost-correction pop-up, 3 screen sizes).
