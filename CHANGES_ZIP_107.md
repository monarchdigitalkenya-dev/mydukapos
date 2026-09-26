# Zip 107 — Audit tab (spec sections 38-42), root/Shop only

## What's new
A new 🔍 Audit tab in the main nav (root/Shop only this zip — reference build first, same workflow as every
other phase). A searchable, read-only activity timeline.

**Deliberately a consolidated VIEW, not a new parallel logging system.** It pulls from the logs that already
exist, one source of truth per event type — the same principle X/Z Reports used by calling reportSales()
instead of separate math:
- Settings section access → existing `adminActivityLog`
- X/Z Report generated/finalized → existing `posControlReportLog` (added in zip 106)
- Stock added/removed → existing `stockMovementLog` (now also records `by`, the staff member who made the
  adjustment — previously untracked)
- Sale created / voided / restored, and discounts applied → read directly off `salesLog` (voidReason,
  voidedBy, voidedAt, offerApplied were already stored on each sale; just weren't surfaced anywhere central)
- KRA/eTIMS classification changed or migrated → each item's own `kraClassificationHistory` (added in the
  tax-engine phase)

**Filters:** date range, module (Sales / Inventory / Reports / Tax-eTIMS / Settings), and free-text search
across user/action/detail/reference. Download for Excel (CSV). Capped at showing 500 rows at a time with a
note to narrow the filters — the underlying data isn't limited, just the render.

**Read-only by construction** — the tab only ever reads from the existing arrays and renders a table; there's
no delete/edit affordance anywhere in it, so it can't be used to tamper with the records it's summarizing.

**Permission:** added to the same lockable-tabs list as every other tab (Reports, Inventory, etc.), so it can
be assigned to trusted staff or left Admin-only, same mechanism as the rest of the app.

## What's NOT in this zip
- Not yet ported to hotel/hospital/production/services/pharmacy (or water, which doesn't have this Reports
  architecture) — root only, per the established workflow.
- Doesn't yet cover every event type the spec lists (logins/failed logins, price/cost changes, permission
  changes, report reprints, eTIMS submission events) — those aren't logged anywhere in the app yet, so there's
  nothing for a view to pull from. Extending this means adding logging calls at those specific points, which
  is separate work from the consolidated view itself.
- Tamper-resistance is "no UI to edit/delete" — the underlying arrays aren't yet cryptographically sealed or
  otherwise hardened against direct tampering (spec's "append-only wherever practical" — this is practical
  append-only via lack of any edit/delete function, not a stronger guarantee).

## Verification
- tests/audit-tab.test.mjs (new, 5 tests): stock adjustments, sales/voids/discounts, X/Z report and KRA
  classification events all show up correctly; module + text filters narrow results correctly; repeated
  renders never change the underlying log counts (read-only confirmed).
- lint-globals, smoke, regressions, xz-reports, kra-classification, money, receipts, reports-and-speed,
  past-sale-price-tier: 130 tests, all passing.
- `npm run check` (shared function + block drift): clean.

No router changes — deploy:router not needed.
