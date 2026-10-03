# Zip 108 — Audit tab ported to hotel, hospital, production, services, pharmacy

Same feature delivered in root (zip 107), now applied identically to the other 5 modules that share this
Reports architecture (water still excluded — different architecture, same as every other phase so far).

Each module got the same set of changes root did:
- 🔍 Audit nav button + tab-content panel (date range, module filter, free-text search, CSV export).
- buildAuditEvents() / renderAuditTab() / auditCsv() — pulling from each module's own adminActivityLog,
  posControlReportLog, stockMovementLog, salesLog (void/discount fields), and each item's own
  kraClassificationHistory. No new logging system — a consolidated view over what already exists.
- logStockMovement() now also records `by: activeServerName()` so stock adjustments are attributable.
- Added to each module's lockable-tabs list, same permission mechanism as every other tab.

Placed outside every @shared:begin/end function region AND every @shared-block region in each file, learning
from the two sync-wipe incidents earlier this session — confirmed by a clean `npm run check` after every edit,
not just at the end.

## Verification
- tests/audit-tab.test.mjs expanded to run its 5 checks against all 6 modules (30/30 passing, up from 5/5
  root-only in zip 107).
- lint-globals, smoke, regressions: 21/21 clean across all modules.
- Full regression sweep this session: xz-reports, kra-classification, past-sale-price-tier,
  past-hire-price-tier, aqua-cogs-cost-price, money, receipts, reports-and-speed, gas, hold-sale,
  receipt-uniform, patient-billing, hmis-integrity, hmis-pipeline, purchasing, orders, staff-and-whatsapp,
  stay-signed-in, stock-take, sync, two-devices — 306 tests, zero failures.
- `npm run check` (shared function + block drift): clean across all 7 modules.

No router changes — deploy:router not needed.
