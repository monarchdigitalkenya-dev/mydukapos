# Zip 291 - Cash float & reconciliation (Shop) + inventory groundwork

## Audit (before any change)
- Shop = `index.html` (single-file PWA); shared code in `src/shared/` is copied into each app by `npm run sync`; state is localStorage-first and merged per record on the server (`functions/api/_merge.js`).
- No cash float existed in the Shop. The Hospital has `cashShifts` (one shift per cashier account), which is the model this feature deliberately does not copy; it is untouched.
- A sale's `cashAmount` is the amount applied to the sale (net of change). Returns carry no refund method and expenses carry no payment method, so cash refunds / drawer expenses are explicit, linked drawer movements and are never inferred.

## Design
- Four separate things: staff account, device (`pos_device_id`), cashier point (new), cash session (new, one open per point).
- Session id = `cs-<pointId>-<seq>` (deterministic) so offline double-opens collapse into one record on merge; earliest opening/closing count wins, the loser is kept in `conflicts[]`. `corrections[]` is append-only. Closed never reverts to open; a decided approval is never undone by a stale copy; a later correction of the same count wins.
- Money is rounded to cents with integer cent arithmetic for counts. Pure logic lives in `src/shared/functions.js` (`cash*`), screens/hooks in `src/shared/blocks/cash-drawer.html` (Shop only).

## Files
index.html, functions/api/_merge.js, src/shared/functions.js, src/shared/blocks/cash-drawer.html (new), tools/lib.mjs, tests/helpers.mjs (older tests start with the drawer off, like `pos_round_up`), tests/cash-drawer.test.mjs (new), DEPLOY.md, DEPLOY_290.md, CHANGELOG.md, docs/CASH_INVENTORY_CHECKLIST.md.

## Tests actually run
- `tests/cash-drawer.test.mjs`: 17/17 pass (denominations; shared terminal; independent tills; mixed payment; movements and retries; variance and approval; skipped counts; device assignment; checkout gate through the real UI; closed session; feature off; two devices offline through the real sync server; server merge; correction; correction merge; filters and CSV; history screen UI).
- Regression files run on the modified tree and passing: checkout-every-app, checkout-guard, checkout-minimum-price, hold-sale, multi-till, smoke, regressions, two-devices, tenant-isolation, zip156-server-merge. (Run before the last UI additions; `sync`, `check`, `lint` re-run after and pass.)
- Known: `zip168-checkout-workspace` test 1 fails identically on the untouched zip 289 in the build sandbox. NOT caused by this zip.
- NOT run: the full 381-file suite (single-CPU sandbox).

## Groundwork added in this zip (dormant)
- `src/shared/functions.js`: `serial*`, `variant*`, `import*` engine; `functions/api/_merge.js`: `serialUnits` (history union, status derived from the newest entry, double-sale flag) and `importBatches`; Shop wiring for `pos_serial_units` / `pos_import_batches`. Tests: `tests/serial-import-engine.test.mjs` 7/7. No screen uses it yet - see `docs/HANDOFF.md`.

## Added late
- `cashVoidMovement` and `cashCorrectOpening` (+ buttons in the drawer panel). `tests/cash-drawer.test.mjs` now 21/21.
