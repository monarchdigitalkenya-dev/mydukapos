# HANDOFF - myDukapos cash / serialized inventory / variants / imports (zip 291)

**Read first in a new chat:** this file, then `docs/ORIGINAL_REQUEST.md` (the owner's full brief, verbatim). Upload the zip `mydukapos_zip291_handoff.zip`. Suggested opening message:
> "Continue the myDukapos work from `docs/HANDOFF.md`. The original brief is `docs/ORIGINAL_REQUEST.md`. Do the NEXT STEPS in order; run tests in small groups; keep `docs/HANDOFF.md` and the deploy notes updated."

---------------------------------------------------------------------------------------------------------------------------------------
## 1. HONEST STATUS AGAINST THE ORIGINAL REQUEST

Legend: DONE = built AND tested. ENGINE = tested pure logic exists, but NO screen / checkout hook yet (users cannot use it). TODO = not started.

| Part | Requirement | Status |
|---|---|---|
| Phase 1 | Audit + written checklist | DONE (this file + `docs/CASH_INVENTORY_CHECKLIST.md`) |
| 1.1 | Settings, default ON, per tenant, history never deleted | DONE. Not built: count status "exempted" (only counted / skipped exist) |
| 1.2-1.4 | staff / device / cashier point / session; shared terminal; independent tills; ambiguous device | DONE. Gap: a cashier point has no branch field; the UI can only assign THIS device to a point (not another device) |
| 1.5 | Opening-count screen (denominations or total), confirm, concurrency-safe | DONE, including correcting the OPENING count (manager + reason, open session only, original kept) |
| 1.6 | Live drawer panel + movements, idempotent | DONE, including voiding a wrong movement (manager + reason, open session only, stays on record). Gap: sync status shown only as online/offline text |
| 1.7 | Expected cash maths (split payments, voids, refunds) | DONE. Cash refunds / drawer expenses are explicit movements, not auto-linked to a return / expense record |
| 1.8 | Close session, variance, reason, manager approval, corrections | DONE. Gap: no "handover" workflow |
| 1.9 | History, filters, consolidated total, CSV, 58 / 80 / A4 print | DONE (print layout basic, via `window.open`). Not in the Owner/Admin Console or the main Reports tab |
| 2.1 | Product editor option "This item has a unique identifier per item" | **TODO** (the field name is `product.serialized`; variant override `variant.serialized`) |
| 2.2 | Identifier types, dual IMEI = one unit, normalisation, bulk entry | ENGINE (`serialNorm`, `serialParseList`, `serialValidateBatch`). No settings screen for identifier types; default type is `imei` |
| 2.3-2.4 | Receiving screen "7 of 10 registered", scan / paste / file; purchase receiving; transfers | **TODO** (engine validates + creates units; no screen; Purchases tab not touched) |
| 2.5 | Lifecycle with validated transitions, counts (total vs available) | ENGINE (`serialCanTransition`, `serialTransition`, `serialCounts`, `serialQtyFor`). No unit list / actions screen |
| 2.6 | Sales Counter: must pick the real unit; concurrency | **TODO** (`serialCheckSale` exists; checkout gate + commit hook not written) |
| 2.7 | Returns, exchanges, history, identifiers on receipts / eTIMS | ENGINE (`serialReturnUnit`, `serialSearch`). No UI, no receipt lines, no exchange flow |
| 3.1 | Store becomes an Inventory workspace | **TODO** |
| 3.2-3.3 | Variants: attributes, generator, duplicate prevention, variant fields | ENGINE (`variantGenerate`, `variantLabel`, `variantComboKey`, `variantFindDuplicate`). The EXISTING embedded `product.variants[]` is kept and extended; no screens for attributes / generator |
| 3.4-3.6 | Overview dashboard, searchable table, detail workspace | **TODO** |
| 3.7 | Adjustments, write-offs, stock-take, transfers (incl. inter-branch) | **TODO**. NOTE: each branch is a SEPARATE shop with its own state (see section 3), so moving a serialized unit between branches is a cross-shop operation that needs its own design |
| 3.8 | Low-stock / reorder via existing flows | **TODO** (fields exist: `minStock`, `reorderLevel`, `reorderQty`; helper near line 24480 of `index.html`) |
| 4.1-4.3 | Import wizard (upload, type, mapping, preview, validate, confirm, run, results, rejected-rows download, templates) | **TODO as a screen.** ENGINE done: `importGuessMapping`, `importPlan`, `importApply`, `importFields` |
| 4.4 | Variants into an EXISTING parent | ENGINE, tested with the spec's Samsung A15 example (parent reused, 3 variants, re-import skips, update policy never touches stock, unmatched / ambiguous / plain-with-stock parents flagged). No wizard to use it |
| 4.5 | Quantity semantics, idempotency | ENGINE, tested (opening refuses to overwrite, add applied once via row keys, serialized stock needs identifiers) |
| 4.6 | Import report, rejected export, chunked / resumable | **TODO** (`importBatches` synced list exists and is registered; nothing writes it) |
| 5.1 | Purchases tab integration, supplier returns, corrections | **TODO** |
| 5.2 | Sales deduct only selected units | **TODO** (see 2.6) |
| 5.3 | Ledgers separate | Kept separate by design (cash lists vs `stockMovementLog`); purchase-from-drawer link not built |
| 6.1 | Data model | Cash: DONE (4 synced lists). Serial: `serialUnits` + `importBatches` registered and merge-safe, unused by any screen. No D1 tables (state is synced KV, as the app already works) |
| 6.2 | Permissions on the server | Only the existing admin / manager flags are used, enforced in the client. **Server-side per-permission enforcement not built** |
| 6.3 | Offline / multi-device | Cash: DONE + tested through the real sync server. Serial units: merge rules DONE + tested (stale copy cannot revive a sold unit; the same unit sold on two devices is flagged `conflict: double-sale`); the flag has no screen yet |
| 6.4 | Audit trail | Cash / serial records themselves are append-only and carry actor, time, device; no separate audit-log entries |
| 7.x | UX | Cash screens done; nothing else |
| 8 | Tests | See section 4 |
| 9 | Delivery report | This file + `docs/history/CHANGES_ZIP_291.md` |

**Acceptance criteria 1-5 and 15-16 are met. 6-14 and 17 are NOT: criteria 6-12 and 14 have working, tested ENGINE but no screens; 9 and 13 are not started.**

---------------------------------------------------------------------------------------------------------------------------------------
## 2. WHAT IS IN THE ZIP (files changed vs zip 289)

`index.html` (Shop), `functions/api/_merge.js`, `src/shared/functions.js`, `src/shared/blocks/cash-drawer.html` (new), `tools/lib.mjs`, `tests/helpers.mjs`, `tests/cash-drawer.test.mjs` (new), `tests/serial-import-engine.test.mjs` (new), `DEPLOY.md`, `DEPLOY_291.md` (new), `CHANGELOG.md`, `docs/CASH_INVENTORY_CHECKLIST.md`, `docs/HANDOFF.md`, `docs/ORIGINAL_REQUEST.md`, `docs/history/CHANGES_ZIP_291.md`. The other apps (hotel, pharmacy, hospital, production, services, water, owner) are byte-identical to zip 289.

Behaviour change users will see: **cash drawer is ON by default** - every Shop checkout asks for the opening count once per cash session. Nothing user-visible comes from the serial / variant / import engine yet.

---------------------------------------------------------------------------------------------------------------------------------------
## 3. ARCHITECTURE FACTS LEARNED (so you do not re-audit)

- Shop app = root `index.html` (~59k lines, single file). Shared code is written ONCE in `src/shared/functions.js` as `//@fn name` + `function name` and copied into every app's `index.html` between `/* @shared:begin names=a,b,c ... */`. **To add a shared function to the Shop only**: add the name to the `names=` list in root `index.html`, run `npm run sync`. Do NOT put a free-standing comment before the first `//@fn` of a new group: it leaks into every app (it happened once; fixed by putting the comment under the `//@fn` line).
- Shop-only UI blocks live in `src/shared/blocks/*.html`, registered in `tools/lib.mjs` (`SHARED_BLOCKS`, `only: ['index.html']`), with `<!-- @shared-block:name:begin -->` / `:end` markers placed in `index.html`. Cash drawer block = the template to copy.
- State = localStorage first (`pos_*` keys), pushed to `functions/api/pos-sync.js`, merged per record by `functions/api/_merge.js` (`MERGE_BY_ID_FIELDS`, `NESTED_MERGE`; a nested spec **must** have a `status` map, even `{}`). A new synced list needs ALL of: `let x = safeJSONParse('pos_x', [])`; `registerSyncedField('x', () => x, 'id')`; the field in the payload-collect object and an `if (Array.isArray(data.x))` in the pull-apply block (both in `index.html`, search `cashPoints`); and an entry in `_merge.js`.
- Products: `inventory[]` items `{code (key), name, qty, price, wholesalePrice (= COST), wholesaleSellingPrice, minStock, reorderLevel, reorderQty, hasVariants, variants[], type, vatCategory, ...}`. Variant: `{id, name, code, price, wholesalePrice(cost), wholesaleSellingPrice, qty, dualUnit, ...}`; product.qty = sum of variant qty when `hasVariants`. Added by this work: `variant.attrs`, `variant.active`, `variant.reorderLevel`, `variant.serialized`, `product.serialized`, `serialUnregistered` (legacy un-identified stock during conversion).
- Stock ledger = `stockMovementLog` via `logStockMovement(code, name, delta, reason, unit)` (Shop-only function, `index.html`). Save with `safeSetItem('pos_stock_movement_log', ...)`.
- Cart: `currentCart[cartKey] = {code, cartKey, variantId?, name, price, qty, ...}`; variant key `code::variant::variantId`. Checkout = `async function checkoutCartOnce()`. Gate hook already used: `if (typeof cashGate === 'function' && !(await cashGate())) return;`. Commit hook already used: `cashStampSale(saleRecord)` just before the `// "Pay Later" sales are kept OUT` comment; everything between that hook and `salesLog.push(saleRecord)` is synchronous, so attaching serial units there is atomic with the commit. Bills (pay later) go to `bills`, normal sales to `salesLog`.
- Void commit = `performVoidSale(saleId)` (sets `sale.voided`, restores stock when `shouldRestoreStock`); unvoid = `performUnvoidSale`. Returns restock via the SHARED function `restockReturnedItem(product, qty, sel, reason)` (`sel.sourceRefNumber`, `sel.variantId`). **Wrap these from the Shop-only block (`window.fn = function...`) instead of editing the shared function**, so other apps stay byte-identical.
- Receipt lines: shared `buildReceiptDoc(sale, hooks)`; `hooks.itemSubLines(line, sale)` returns extra lines under an item - use it (or `l.subs`) for IMEI lines; do NOT append identifiers to `item.name` (it feeds reports and eTIMS).
- Spreadsheet reading: `await loadSheetJs()` then `window.XLSX.read(...)` / `XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:''})` (used near lines 14365, 45140).
- Each BRANCH is a separate shop link with its own state (`action:'create'` branch API near line 29697); cross-branch selling exists (`crossBranchRatio`) but there is no shared stock table.
- Hospital's `cashShifts` = one shift per cashier (the model the brief forbids); left alone.
- Device id = `localStorage pos_device_id`; till number = `tillNumber()`. Staff: `currentServer`, `staff[]`, `isAdminServing()`, `staff.isManager`, `activeServerName()`.
- Tests: `tests/e2e-harness.mjs` (`makeServer`, `openDevice('index.html', server, storage, waitMs)`) boots the real app in jsdom against the real sync code. `tests/helpers.mjs` boot presets `pos_round_up='0'` and (new) `pos_cash_config` = drawer OFF so old tests are unaffected; pass `pos_cash_config` to turn it on.

### Sandbox limits discovered (plan around them)
1 CPU. Each test boot takes seconds; a single command is killed at 300 s; background processes are killed between calls. **Run tests one file (or 3-6 named tests via `--test-name-pattern`) at a time with `timeout 250`.** The full 381-file `npm test` was never run here. Known failure identical on the untouched zip 289: `tests/zip168-checkout-workspace.test.mjs` test 1.

---------------------------------------------------------------------------------------------------------------------------------------
## 4. TESTS (actual results)

- `tests/cash-drawer.test.mjs`: 21 / 21 pass (denominations, shared terminal, independent tills, mixed payment, movements + retries, variance + approval, skipped counts, device ambiguity, real checkout gate, closed session, feature off, two devices offline through the real sync server, server merge, correction + its merge, history filters + CSV, history screen UI, void a movement, correct the opening count, corrected-opening merge, void / correct-opening buttons through the UI).
- `tests/serial-import-engine.test.mjs`: 7 / 7 pass (identifier validation, ten identical phones with idempotent ids, sell / return / lifecycle rules, variant combos + duplicates, variants into an existing parent with the spec example, quantity semantics + serial import, serial merge conflicts).
- Regression files passing on the modified tree: checkout-every-app, checkout-guard, checkout-minimum-price, hold-sale, multi-till, smoke, regressions, two-devices, tenant-isolation, zip156-server-merge (the first group ran before the serial engine was added; smoke, two-devices, tenant-isolation, zip156-server-merge, checkout-guard were re-run after).
- `npm run check` and `npm run lint`: pass.

---------------------------------------------------------------------------------------------------------------------------------------
## 5. NEXT STEPS (in this order; each is shippable on its own)

Decisions already made - keep them:
- Serialized flag at product level with optional per-variant override (`serialIsTracked(product, variant)`).
- Quantity of a serialized product/variant = in-stock units + `serialUnregistered` (legacy stock not yet identified; counted but NOT sellable until registered). Enabling tracking on an item that has stock sets `serialUnregistered = qty` (after an explicit confirmation) - never silently.
- Sold units: mark `sold` at the commit hook for ALL sale types (a held-in-shop bill too); a void sets them back to `in_stock` (add `sold -> in_stock` to the transition table for the void path only); an unvoid marks them sold again if still in stock.
- Concurrency: online -> push + pull before showing the unit picker; offline -> accept, and the merge flags `double-sale` conflicts (build a "Conflicts" list for the owner).

1. **Block `src/shared/blocks/inventory-pro.html`** (Shop only; register in `tools/lib.mjs`, markers in `index.html`), event-delegation UI like `cash-drawer.html`:
   a. Product editor: checkbox with the EXACT label "This item has a unique identifier per item" + the supporting text from the brief, inside `#inv-variants-group` area of the Add Item form; read it by wrapping `saveInventoryItem()` (sets `product.serialized`); pre-fill on `input` of `#inv-code` / `#inv-name`. Conversion confirm when qty > 0.
   b. Serial receiving modal: product/variant picker, expected count, scan / type / paste / file, live "7 of 10 registered", row-numbered errors, supplier + reference + cost, fixed `batchId` per open (idempotent), then `serialMakeUnits` + qty + `logStockMovement`.
   c. Checkout: `serialGate(entries)` after `cashGate` (returns `{cartKey: [unitIds]}` or false) and `serialAttach(saleRecord, entries, sel)` at the stamp hook; store `sale.serialUnits`; receipt via `hooks.itemSubLines`.
   d. Wrap `performVoidSale` / `performUnvoidSale` / `restockReturnedItem` (auto-return the unit only when unambiguous, otherwise refuse and say where to register the return).
   e. Units tab: search, status filter, history, return (reason + condition), inspection outcomes, damage / write-off / repair (manager + reason), correct identifier (manager + reason, history kept), double-sale conflict list.
2. **Inventory workspace** (same block): overview cards (products vs variants vs units vs quantities, no double counting, value at COST), searchable / filterable / paginated table (include serial identifier search), item detail (variants, serial counts, movements from `stockMovementLog`), variant generator using `variantGenerate` with deselectable combos + `variantFindDuplicate`, stock adjustment with reason through `logStockMovement`, low-stock list. Keep the old Store tab working; add an "Inventory" entry / button rather than renaming routes.
3. **Import wizard** (same block): file via `loadSheetJs` / CSV parser, type + mode (`opening` / `add`) + policy (`skip` / `update_info`), mapping UI seeded by `importGuessMapping`, preview + `importPlan`, confirm, chunked apply (500 rows) calling `importApply`, write `importBatches` (`id`, file hash, type, mode, counts, `rowKeys`, by, at) - block re-importing the same file hash unless the user explicitly overrides - rejected-rows CSV, three template downloads.
4. **Purchases tab**: serialized lines require identifiers before stock increases; variant picker; supplier returns and corrections create ledger movements; drawer-paid purchase links to ONE cash movement (`ref`).
5. **Cash gaps**: "exempted" status, cashier point branch field + assigning other devices, drawer report inside Reports / Owner console.
6. **Server-side permission checks** (`functions/api/pos-sync.js`) for the new lists; audit-log entries.
7. **Inter-branch unit transfer** (needs its own design: separate shops).
8. Run the full `npm test` on a real PC; fix anything new; update `DEPLOY_*.md`, `CHANGELOG.md`, this file.

---------------------------------------------------------------------------------------------------------------------------------------
## 6. DEPLOY

`DEPLOY_291.md` = complete Windows cmd steps from unzip to production (robocopy without `/MIR`, wrangler files protected, no D1 migration, no router deploy, staging first, rollback). Deploying this zip is safe: the serial / import lists are registered but dormant, and the only visible change is the cash drawer.


---------------------------------------------------------------------------------------------------------------------------------------
## 7. STATUS AT ZIP 292

DONE: NEXT STEPS 1-3 (inventory-pro block: serial UI, workspace, variants, import wizard; tests/inventory-pro.test.mjs) and the Hotel order-management upgrade (per-item station Kitchen/Bar/None, bill-printed = off the board, waiter-own-orders via `hospTabAllowed`, five alert sounds; tests/hotel-station-bill-292.test.mjs A-I).
STILL OPEN: 4 Purchases-tab integration, 5 cash gaps, 6 server-side permission checks (the sync server has no per-staff permissions: needs a design), 7 inter-branch transfer, 8 the full suite on a real PC (`npm test`).
Hotel notes: kitchen visibility = `tab.billPrintedAt` (latest bill print; rounds sent before it are hidden); bill status = `billStatus`; payment = `hospParts` / `status`. The sound settings are per device (`pos_kds_sound_cfg`).


## 8. STATUS AT ZIP 294 (293 re-issued)
- Store: shared block `store-sales.html` (Store history tab + Sell from Store); Store tab + JS now identical in all six apps (copy of the Shop's). Server `logSale` in store.js and _store-d1.js.
- Purchases/serials, cash exemption/assignment/report and the server permission guard are in (see CHANGELOG 293).
- NOT done: inter-branch unit transfer (step 7); hotel waiter read-isolation on the server; printer-routing test for the hotel station split; sale void -> Store history; full test suite on a real PC (step 8).
