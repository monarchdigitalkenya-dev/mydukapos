# Zip 106 — X Report & Z Report (spec sections 31-34)

## What's new
Added to root/Shop + hotel, hospital, production, services, pharmacy (water excluded — different Reports
architecture, same gap noted for the KRA-classification phase; owner console N/A).

**X Report (Reports ▸ 📋 X Report)**
- Interim reading of today's business date: transactions, gross sales, discounts, net sales, cost of goods,
  gross profit, voided sales, credit outstanding on today's bills, payment-method breakdown, and a VAT-category
  tax breakdown.
- Read-only — never mutates anything, can be generated any number of times in one trading day.
- Every generation is logged (report ID, who, when, business date) to a new append-only
  `posControlReportLog`, which becomes the data source for the future Audit tab.

**Z Report (Reports ▸ 🔒 Z Report)**
- Same authoritative totals as the X Report (both call the exact same `posControlReportTotals()`, which in turn
  uses the same `reportSales`/`reportSaleTotal`/`reportSaleCost` every other report already uses — X, Z and
  Daily Sales can never quietly disagree).
- Shows "Not yet finalized" with a Confirm & Finalize button until finalized for that business date.
- Finalizing is gated behind the management password / Manager PIN (same mechanism as voiding a sale) —
  "only authorized users may finalize," per the spec.
- A second finalize attempt for the same business date is refused — no duplicate Z Reports.
- Once finalized, shows who finalized it and when instead of the button; generating the report again just
  re-shows the same finalized state.
- Finalized reports are stored in a new, append-only `zReports` array.

## Two build-breaking mistakes made and fixed in this same zip
This codebase has a shared-code sync (`npm run check` / `npm run sync`) at **two** levels — a function-body
region and separate HTML "block" regions — and both silently discard anything placed inside them that isn't
part of the recognized shared source:

1. First pass: placed the new report-building functions inside the function-sync region. `npm run sync`
   regenerated that region from `src/shared/functions.js` and deleted them. Fixed by moving the whole X/Z
   block to just after the `@shared:end` marker (with a code comment explaining why, to stop this happening
   again), and by safely updating the shared `reportsGenerate` itself (guarded with
   `typeof reportBuildXReport === 'function'` so a module without this block yet never throws).
2. Second pass: added the Reports-tab X/Z buttons directly into each module's HTML, inside the
   `reports-tab` shared **block**. The next sync silently deleted the buttons from every module, including
   root. Fixed by editing the actual canonical source, `src/shared/blocks/reports-tab.html`, once, and
   re-syncing — confirmed present in all 6 target modules afterward, absent from water as intended.

## Verification
- tests/xz-reports.test.mjs (new, 30 tests across all 6 modules): X Report never closes the day / can repeat;
  Z Report blocks until finalized; finalize records who/when; duplicate finalize is blocked; X/Z agree with the
  ordinary Sales report on the same numbers.
- Full test suite (`tools/test.mjs`'s complete 88-file set) run to completion in batches this time, specifically
  because the last zip's failure came from an incomplete check: zero failures across all 88 files.
- `npm run check` (shared function + block drift): clean across all 7 modules.

No router changes — deploy:router not needed.
