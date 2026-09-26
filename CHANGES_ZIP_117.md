# Zip 117 — Water/Aqua POS: X Report, Z Report & Audit tab

## Context

This closes the two items zip 116 explicitly left open for the water (Aqua POS) module:
X Report/Z Report and the Audit tab. Water now has full parity with the other six POS
modules (Shop, Hotel, Hospital, Production, Services, Pharmacy) on end-of-day reporting
and the consolidated audit timeline. Automatic Daily Report remains open for water (see
"What's still open").

## Root cause

Every other module builds X/Z Reports on top of a shared `reportBuildSales` /
`reportsGenerate` / `reportsPrint` Reports-tab system. Water has none of that — its Daily
Sales figures come from its own bespoke `buildDailySalesReportData(range)`, and it has no
unified Reports tab to hook a "Z/X" button into. Bolting on the other modules' shared X/Z
functions as-is would either throw (wrong array/DOM-id names) or, worse, silently compute
different numbers from Daily Sales — the one thing the spec is strictest about ("X/Z must
never disagree with the sales report they're drawn from"). So this needed a water-specific
X/Z implementation that calls the *same* `buildDailySalesReportData()` Daily Sales already
uses, rather than a parallel totals calculation.

The Audit tab has the same shape of problem: every module's version reads that module's
own logs (`adminActivityLog`, `stockMovementLog`, `salesLog`, per-item
`kraClassificationHistory`, and now the new `posControlReportLog`). Water's log names and
`products` catalogue array needed their own read model, wired into water's own tab/nav
system (water has no shared Reports-tab block to attach to).

## What changed

**`buildDailySalesReportData(range, methodFilterOverride)`** — added an optional second
argument so X/Z Report can pull the whole business date's real totals regardless of
whatever payment-method filter chip is currently selected on the Daily Sales screen,
while the on-screen Daily Sales table keeps respecting that filter as before.

**X Report / Z Report (`water/index.html`)**
- New "📋 X Report & Z Report" panel added to the Daily Sales tab, below Stock Remaining.
- `todaysReportRange()` — always today's business date (uses water's own string-keyed
  date convention, `todayLocalDateStr()`, matching `getDailySalesEntriesForRange`'s
  contract — not root's Date-object convention, which would have silently broken here).
- `posControlReportTotals()` — one source of truth: gross/net, per payment-method
  breakdown, VAT breakdown (via the shared `computeVatBreakdown`), voided sales
  count/amount, and outstanding credit for the day — all built from
  `buildDailySalesReportData(range, 'all')` plus `bills`, never a separate calculation.
- `reportBuildXReport()` — interim report; can be generated any number of times, never
  closes the day, never creates a Z Report record.
- `reportBuildZReport()` / `requestFinalizeZReport()` / `performFinalizeZReport()` — Z
  Report requires an explicit finalize action, gated behind the management password (or
  Manager PIN) through water's own `resolveAdminPwModalSuccess()` dispatcher (added a
  `'finalize-z-report'` case). Finalizing records who/when/totals to `zReports` and is
  blocked from running twice for the same business date. Once finalized, the screen shows
  "✅ Finalized" instead of the finalize button.
- `printPosControlReport()` — prints whichever report (X or Z) is currently on screen.
- `zReports` / `posControlReportLog` are local-only (per-device), matching every other
  module — confirmed by checking they're not part of `collectSyncPayload()`.

**Audit tab (`water/index.html`)**
- New "🔍 Audit" tab (nav button + `LOCKABLE_TABS` entry, so it can be locked per role like
  every other tab).
- `buildAuditEvents()` consolidates existing logs into one timeline — no new parallel
  logging system: `adminActivityLog`, `posControlReportLog`, `stockMovementLog`,
  `salesLog` (sale created / voided / discount applied), and every product's
  `kraClassificationHistory`.
- `renderAuditTab()` — filterable by date range, module, and free-text search; read-only
  (repeated renders never mutate the underlying logs).
- `auditCsv()` — CSV export of the currently-filtered view.

**In-app guide** — `tools/build-guides.mjs` updated (water's tab list now includes
"🔍 Audit"; the Reports chapter documents the new X/Z panel and the Audit tab), guide data
regenerated and synced into `water/index.html`.

## What was verified

- `npm run check` — clean, no shared-code drift, all 7 modules.
- Every `<script>` block in `water/index.html` parses (`new Function(...)`).
- **New test file `tests/water-xz-audit.test.mjs` — 8/8 passing**:
  1. X Report shows today's real totals and can be generated repeatedly without ever
     closing the day or creating a Z Report record.
  2. Z Report shows "Not yet finalized" until an explicit finalize action.
  3. Finalizing records who/when/totals; a second finalize for the same business date is
     blocked (no duplicate record).
  4. Once finalized, the view shows the finalized state, not the finalize button.
  5. X Report and Z Report agree with Daily Sales on the same day's numbers even when the
     Daily Sales payment-method filter chip would otherwise exclude the sale — proves the
     single-authoritative-source requirement.
  6. Finalizing requires the management-password modal — not a bare click.
  7. The Audit tab shows sale/stock/KRA-classification events together and the module
     filter narrows the view without touching the underlying logs.
  8. A voided sale appears as two distinct events (the original sale and the void).
- **Full suite: 95/95 test files run, 0 failures** (run in batches of 4 files; two files
  with unusually many per-module subtests — `hmis-integrity.test.mjs`,
  `audit-tab.test.mjs` — needed a longer `--test-timeout` in this container to finish
  without a false timeout-cancellation; not a code issue, confirmed by re-running each
  alone to completion with 78/78 and included in the 30/30 batch respectively).

## What's still open (not in this zip)

- **Automatic Daily Report for water.** Unchanged from zip 116 — every other module's
  version is a hard dependency on `reportBuildSales`/`reportsPrint`, which water doesn't
  have. Needs its own water-specific implementation built on the same
  `buildDailySalesReportData()`/X-Z functions added in this zip, as a follow-up.
- Everything else already listed as open at the end of zip 116 (systematic UI-reliability
  sweep, generalized wholesale-tier/unit-conversion engines, performance/Cloudflare-cache
  audit, and the consolidated Final Report) remains open.

## Deploy steps

```
mkdir C:\dev\zip117
tar -xf "%USERPROFILE%\Downloads\mydukapos_all-fixes_117.zip" -C C:\dev\zip117
cd /d C:\dev\mydukapos
robocopy C:\dev\zip117 C:\dev\mydukapos /MIR /XD .git node_modules /XF package-lock.json wrangler.staging.toml
npm install --no-audit --no-fund
npm run check
npm test
npm run deploy:router (skip if zips 50-116 are already live)
npm run deploy
git add -A
git commit -m "Zip 117: water X Report, Z Report and Audit tab"
git push
```
